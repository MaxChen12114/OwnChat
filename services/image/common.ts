/**
 * Shared image pipeline: the parts every image flow needs and none of them should re-implement —
 * endpoints, credential and header policy, the ComfyUI workflow graphs, response unwrapping, the
 * polling decision, and the per-character base-image table.
 *
 * Channels are data, so most functions here take one and read it defensively. Two rules matter more
 * than the rest:
 *  - A custom channel never borrows the site's legacy key. That key belongs to the built-in preset;
 *    falling back to it for a user's own endpoint would send one provider's credential to another.
 *  - A guest may not use a `site` transport channel at all — it would spend the site owner's quota.
 *
 * Everything effectful (fetch, FormData, FileReader, canvas, localStorage) stays in the wiring; this
 * module is pure so the request shapes can be asserted without a network or a DOM.
 * @module services/image/common
 */

export interface ImageEndpoints {
  generations: string;
  editsAsync: string;
  task: string;
  download: string;
}

export const ENDPOINTS: ImageEndpoints = {
  generations: "/img/v1/images/generations",
  editsAsync: "/img/v1/async/images/edits",
  task: "/img/v1/task/",
  download: "/img/dl?url="
};

/** Data URLs above this size are shrunk before they are written to the base-image table. */
export const DATA_URL_BUDGET = 300 * 1024;
export const SHRINK_EDGE = 1024;
export const SHRINK_QUALITY = 0.85;

const DEFAULT_SIZE = 1024;
const MIN_SIZE = 64;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

export function recOf(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

export function isComfy(ch: unknown): boolean {
  return recOf(ch).kind === "comfyui";
}

export function isDirectOpenAI(ch: unknown): boolean {
  const o = recOf(ch);
  return o.kind === "openai" && o.transport === "direct";
}

/** Trim trailing slashes; the callers concatenate paths onto this. */
export function baseUrlOf(ch: unknown): string {
  return str(recOf(ch).baseUrl).replace(/\/+$/, "");
}

/** `WxH` with a floor of 64; anything unparsable falls back to 1024x1024. */
export function parseSize(size: unknown): number[] {
  const m = /^(\d+)\s*x\s*(\d+)$/i.exec(String(size || ""));
  return m ? [Math.max(MIN_SIZE, Number(m[1])), Math.max(MIN_SIZE, Number(m[2]))] : [DEFAULT_SIZE, DEFAULT_SIZE];
}

/** Model for one request: explicit, then the channel's own choice, then its first model. */
export function pickModel(ch: unknown, opts: unknown): string {
  const o = recOf(opts);
  if (str(o.model)) return str(o.model);
  const c = recOf(ch);
  if (str(c.model)) return str(c.model);
  const models = Array.isArray(c.models) ? c.models : [];
  return str(models[0]);
}

/**
 * Credential for one request. The legacy single-key storage is only consulted for the built-in
 * preset or a request with no channel context; a custom channel with an empty key sends none.
 */
export function resolveKey(ch: unknown, legacy: string): string {
  const c = recOf(ch);
  const own = str(c.key);
  if (own) return own;
  const id = str(c.id);
  if (!ch || !id || id === "gitee") return legacy;
  return "";
}

/** Guests may not spend the site owner's quota: `site` transport needs a signed-in user. */
export function isGuestBlocked(ch: unknown, token: string): boolean {
  if (token) return false;
  if (!ch) return true;
  const c = recOf(ch);
  return str(c.id) === "gitee" || str(c.transport) === "site";
}

export const GUEST_BLOCK_MESSAGE =
  "访客模式不能使用本站生图预设；请先在 设置 → 发图 新增自己的图像渠道（自带 Key）。";

export interface AuthInput {
  channel: unknown;
  token: string;
  legacyKey: string;
  extra?: Record<string, string>;
}

/**
 * Headers for a request that carries the provider credential. Throws for a blocked guest, which is
 * why it is called before any upload starts rather than after.
 */
export function buildAuthHeaders(input: AuthInput): Record<string, string> {
  const h: Record<string, string> = {};
  const extra = input.extra || {};
  for (const [k, v] of Object.entries(extra)) h[k] = v;
  if (isGuestBlocked(input.channel, input.token)) throw new Error(GUEST_BLOCK_MESSAGE);
  const key = resolveKey(input.channel, input.legacyKey);
  if (key) h["Authorization"] = "Bearer " + key;
  // The app's own login token goes in its own header: Authorization is the upstream key's slot.
  if (input.token) h["X-Sync-Token"] = input.token;
  return h;
}

/** Headers for the R2/gallery endpoints, which authenticate with the app token only. */
export function buildSyncHeaders(token: string, extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = {};
  const e = extra || {};
  for (const [k, v] of Object.entries(e)) h[k] = v;
  if (token) h["Authorization"] = "Bearer " + token;
  return h;
}

export interface ComfyParams {
  steps: number;
  cfg: number;
  denoise: number;
}

/** Sampling knobs with the same clamps the channel form uses, so a hand-edited value cannot leak. */
export function comfyParams(ch: unknown): ComfyParams {
  const c = recOf(ch);
  return {
    steps: Math.max(1, Math.min(80, num(c.steps) || 9)),
    cfg: Math.max(0, num(c.cfg) || 1),
    denoise: Math.max(0.1, Math.min(1, num(c.denoise) || 0.6))
  };
}

/** Latent sizes must be a multiple of 8 or the sampler rejects the graph. */
export function latentSize(size: unknown): { w: number; h: number } {
  const wh = parseSize(size);
  return { w: Math.round(wh[0] / 8) * 8, h: Math.round(wh[1] / 8) * 8 };
}

function baseNodes(ch: unknown, prompt: string, negative: string): Record<string, unknown> {
  const c = recOf(ch);
  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: str(c.ckpt) || "z-image-turbo-fp8-aio.safetensors" } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["1", 1] } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: negative, clip: ["1", 1] } },
    "4": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 3 } }
  };
}

function samplerNode(ch: unknown, latentRef: unknown, denoise: number, seed: number): Record<string, unknown> {
  const c = recOf(ch);
  const p = comfyParams(ch);
  return {
    class_type: "KSampler",
    inputs: {
      model: ["4", 0],
      positive: ["2", 0],
      negative: ["3", 0],
      latent_image: latentRef,
      seed: seed,
      steps: p.steps,
      cfg: p.cfg,
      sampler_name: str(c.sampler) || "res_multistep",
      scheduler: str(c.scheduler) || "simple",
      denoise: denoise
    }
  };
}

function decodeNodes(): Record<string, unknown> {
  return {
    "7": { class_type: "VAEDecode", inputs: { samples: ["6", 0], vae: ["1", 2] } }
  };
}

/**
 * Text-to-image graph. `seed` is a parameter rather than a call to the clock so the graph is
 * reproducible in tests; the wiring passes the random value.
 */
export function buildComfyTextWorkflow(ch: unknown, opts: unknown, size: unknown, seed: number): Record<string, unknown> {
  const o = recOf(opts);
  const wh = latentSize(size);
  const nodes = baseNodes(ch, str(o.prompt), str(o.negative));
  nodes["5"] = { class_type: "EmptyLatentImage", inputs: { width: wh.w, height: wh.h, batch_size: 1 } };
  nodes["6"] = samplerNode(ch, ["5", 0], 1, seed);
  const dec = decodeNodes();
  for (const k of Object.keys(dec)) nodes[k] = dec[k];
  nodes["8"] = { class_type: "SaveImage", inputs: { images: ["7", 0], filename_prefix: "site_channel" } };
  return nodes;
}

/** Image-to-image graph: the uploaded reference goes through VAEEncode into the latent slot. */
export function buildComfyEditWorkflow(ch: unknown, opts: unknown, imageRef: string, seed: number): Record<string, unknown> {
  const o = recOf(opts);
  const nodes = baseNodes(ch, str(o.prompt), str(o.negative));
  nodes["10"] = { class_type: "LoadImage", inputs: { image: imageRef } };
  nodes["11"] = { class_type: "VAEEncode", inputs: { pixels: ["10", 0], vae: ["1", 2] } };
  nodes["6"] = samplerNode(ch, ["11", 0], comfyParams(ch).denoise, seed);
  const dec = decodeNodes();
  for (const k of Object.keys(dec)) nodes[k] = dec[k];
  nodes["8"] = { class_type: "SaveImage", inputs: { images: ["7", 0], filename_prefix: "comfy_edit" } };
  return nodes;
}

/** Image references from an OpenAI-shaped response; a b64 payload becomes a data URL. */
export function pickImageUrls(json: unknown): string[] {
  const data = recOf(json).data;
  const list = Array.isArray(data) ? data : [];
  const out: string[] = [];
  for (const d of list) {
    const rec = recOf(d);
    const url = str(rec.url);
    const b64 = str(rec.b64_json);
    const one = url || (b64 ? "data:image/png;base64," + b64 : "");
    if (one) out.push(one);
  }
  return out;
}

export interface PollState {
  status: string;
  fileUrl: string;
  failed: boolean;
}

/** One poll response, classified. The three shapes are what the upstream has answered over time. */
export function pollState(json: unknown): PollState {
  const j = recOf(json);
  const status = str(j.status) || str(j.state) || (j.output ? "success" : "");
  const output = recOf(j.output);
  const rawOutput = recOf(recOf(j.raw).output);
  const data = Array.isArray(j.data) ? j.data : [];
  const first = recOf(data[0]);
  const fileUrl = str(output.file_url) || str(rawOutput.file_url) || str(first.url);
  return { status: status, fileUrl: fileUrl, failed: !!status && /fail|error|cancel/i.test(status) };
}

/** ComfyUI history entry to image descriptor; the last image of any output node wins. */
export function comfyImageFrom(json: unknown, promptId: string): Record<string, unknown> | null {
  const entry = recOf(recOf(json)[promptId]);
  const outputs = recOf(entry.outputs);
  let hit: unknown = null;
  for (const nodeId of Object.keys(outputs)) {
    const images = recOf(outputs[nodeId]).images;
    if (Array.isArray(images) && images.length) hit = images[images.length - 1];
  }
  return hit ? recOf(hit) : null;
}

export function comfyFailed(json: unknown, promptId: string): boolean {
  const entry = recOf(recOf(json)[promptId]);
  const status = recOf(entry.status);
  return str(status.status_str) === "error";
}

/** Base-image key: an absent character means the shared default slot. */
export function baseId(characterId: unknown): string {
  return str(characterId) || "default";
}

export function parseBaseMap(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? recOf(v) : {};
  } catch (e) {
    return {};
  }
}

/** Returns a new map; the caller writes it back. */
export function setBaseEntry(map: Record<string, unknown>, characterId: unknown, url: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(map)) out[k] = v;
  out[baseId(characterId)] = url;
  return out;
}

export function dropBaseEntry(map: Record<string, unknown>, characterId: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const id = baseId(characterId);
  for (const [k, v] of Object.entries(map)) if (k !== id) out[k] = v;
  return out;
}

export function baseEntry(map: Record<string, unknown>, characterId: unknown): string {
  return str(map[baseId(characterId)]);
}

/**
 * Whether a URL must be shrunk before storage. Only oversized inline data is a problem: a remote
 * URL is fetched and localised by the wiring, which shrinks the result at the same budget.
 */
export function needsShrink(url: unknown): boolean {
  const u = str(url);
  return /^data:/i.test(u) && u.length > DATA_URL_BUDGET;
}

export function isInline(url: unknown): boolean {
  return /^data:/i.test(str(url));
}

/** Keep the compressed candidate only when it actually got smaller. */
export function preferSmaller(candidate: string, original: string): string {
  return candidate && candidate.length < original.length ? candidate : original;
}
