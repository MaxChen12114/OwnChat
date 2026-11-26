/**
 * The image-channel settings card, minus the DOM: the list labels, the draft the form describes, the
 * two checks that decide whether a draft may be written, and the shape of a "test this channel" call.
 *
 * A draft is built from a snapshot of the form, not from the form itself, which is what makes the
 * save/validate rules testable without a browser. Two of those rules are the ones that used to bite:
 *  - Saving must not clear a custom channel's edit model. Only the ComfyUI branch has no such field;
 *    an OpenAI-compatible channel keeps whatever was typed, which is the difference between "supports
 *    editing" and "looks like it does".
 *  - A draft that is not yet filled in must not be written when the user simply switches channels,
 *    or a fresh "new channel" row would overwrite the one that was there.
 *
 * Support for a preset and a custom endpoint differ in wording only here: the guest filter and the
 * tag text are presentation, but they carry real policy (a guest may not pick the site preset).
 * @module services/image/channels-ui
 */

export type ChannelKind = "openai" | "comfyui";

export interface Draft {
  id: string;
  name: string;
  kind: ChannelKind;
  transport: string;
  baseUrl: string;
  key: string;
  models: string[];
  model: string;
  editModel: string;
  capabilities: string[];
  ckpt: string;
  steps: number;
}

/** Form snapshot: exactly the fields the card offers, already read off the DOM by the caller. */
export interface FormValues {
  name?: string;
  kind?: string;
  baseUrl?: string;
  key?: string;
  models?: string;
  model?: string;
  editModel?: string;
  ckpt?: string;
  steps?: number;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function recOf(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

function arrOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
}

export function isGitee(ch: unknown): boolean {
  return str(recOf(ch).id) === "gitee";
}

export function isComfy(ch: unknown): boolean {
  return str(recOf(ch).kind) === "comfyui";
}

/** Comma / full-width comma / newline separated model names, trimmed and non-empty. */
export function parseModels(v: unknown): string[] {
  return String(v || "")
    .split(/[,，\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** One-line summary under a channel name in the list. */
export function channelTag(ch: unknown): string {
  const c = recOf(ch);
  if (isGitee(c)) return "站点代理 · " + (c.key ? "Key 已配置" : "Key 未配置");
  if (isComfy(c)) return "本机 ComfyUI · " + (str(c.ckpt) || "未填 ckpt");
  return "OpenAI 兼容 · " + (str(c.model) ? "模型 " + str(c.model) : "未选模型");
}

export function groupLabel(ch: unknown): string {
  return isGitee(ch) ? "内置预设（站点代理）" : "自定义渠道（账号同步）";
}

/** A guest may not see or select the site's own preset. */
export function visibleFor(list: unknown, isGuest: boolean): unknown[] {
  const arr = Array.isArray(list) ? list.slice() : [];
  return isGuest ? arr.filter((ch) => !isGitee(ch)) : arr;
}

/** Options for the model select; the current model is inserted when the list does not carry it. */
export function modelOptions(ch: unknown): { value: string; selected: boolean }[] {
  const c = recOf(ch);
  const models = arrOf(c.models).slice();
  const cur = str(c.model);
  if (cur && models.indexOf(cur) < 0) models.unshift(cur);
  return models.map((m) => ({ value: m, selected: m === cur }));
}

/**
 * Build the channel a save would write. The preset keeps its fixed identity (name, endpoint,
 * transport); everything else comes from the form, falling back to the stored channel.
 */
export function buildDraft(id: string, old: unknown, form: FormValues): Draft {
  const prev = recOf(old);
  const gitee = id === "gitee";
  const kind: ChannelKind = gitee ? "openai" : ((str(form.kind) || str(prev.kind) || "openai") === "comfyui" ? "comfyui" : "openai");
  const models = form.models != null ? parseModels(form.models) : arrOf(prev.models).slice();
  let model = str(form.model) || models[0] || "";
  if (model && models.indexOf(model) < 0) models.unshift(model);
  const editModel = str(form.editModel).trim();
  const capabilities =
    kind === "comfyui"
      ? ["t2i", "edit"]
      : (gitee ? ["t2i", "edit"] : ["t2i"]).concat(kind === "openai" && editModel ? ["edit"] : []);
  return {
    id: id,
    name: gitee ? str(prev.name) : (str(form.name).trim() || str(prev.name) || "未命名渠道"),
    kind: kind,
    transport: kind === "comfyui" ? "direct" : (gitee ? "site" : "direct"),
    baseUrl: gitee ? (str(prev.baseUrl) || "https://ai.gitee.com/v1") : (str(form.baseUrl).trim() || str(prev.baseUrl)),
    key: str(form.key).trim() || str(prev.key),
    models: models,
    model: model,
    // An OpenAI-compatible channel keeps its edit model; the ComfyUI branch has no such field.
    editModel: kind === "openai" ? (editModel || str(prev.editModel)) : "",
    capabilities: capabilities,
    ckpt: str(form.ckpt).trim() || str(prev.ckpt),
    steps: Number(form.steps) || Number(prev.steps) || 9
  };
}

/** Why a draft may not be saved, or null when it may. */
export function validateDraft(d: Draft): string | null {
  if (!d.baseUrl) return "Base URL 不能为空";
  if (d.kind === "openai" && !d.models.length) return "至少填一个模型名";
  return null;
}

/**
 * Whether switching away may write the current draft. A half-filled new channel is left unsaved on
 * purpose: committing it would replace the channel the user was looking at.
 */
export function canCommit(d: Draft): boolean {
  if (d.kind === "openai" && !d.baseUrl) return false;
  if (d.kind === "openai" && !d.models.length) return false;
  return true;
}

export interface TestRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * The probe a "test" click performs: ComfyUI answers on /system_stats, an OpenAI-compatible endpoint
 * on /models — through the site proxy for the preset, directly for a user's own endpoint.
 */
export function testRequest(ch: unknown): TestRequest | null {
  const c = recOf(ch);
  const base = str(c.baseUrl).replace(/\/+$/, "");
  if (!base && !isGitee(c)) return null;
  if (isComfy(c)) return { url: base + "/system_stats", headers: {} };
  const headers: Record<string, string> = {};
  if (str(c.key)) headers["Authorization"] = "Bearer " + str(c.key);
  const url = c.transport === "site" ? "/img/v1/models" : base + "/models";
  return { url: url, headers: headers };
}
