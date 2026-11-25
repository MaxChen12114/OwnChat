/**
 * One-click image generation: turn a character card or the recent conversation into a prompt, then
 * hand it to the shared pipeline. Three things live here and nowhere else —
 *
 *  - The prompt-engine request: which system prompt, which model, and what the body looks like. The
 *    text model is asked in free mode so the prompt costs nothing; the prompt is one flowing
 *    Chinese sentence, never a tag soup, because the image models are distilled on prose.
 *  - The local template fallback. When the text side is down the button must still work, so every
 *    kind has a template that produces a usable prompt from the card or the scene text alone.
 *  - The style prefix. The art style is joined as a leading sentence with a full stop, not as
 *    trailing comma tags, which is how these models expect emphasis.
 *
 * The SSE parsing is here too: streaming a chat completion is text bookkeeping, and keeping it out
 * of the wiring is what makes it testable without a server.
 * @module services/image/quickgen
 */

export type QuickKind = "character" | "scene";

export const LS_MODE = "cfw_quick_llm_mode_v1";
export const LS_IMG: Record<QuickKind, string> = {
  character: "cfw_image_char_v1",
  scene: "cfw_image_scene_v1"
};

export const DEFAULT_FREE_MODEL = "openai/gpt-oss-120b";
export const DEFAULT_FAST_MODEL = "deepseek-ai/deepseek-v4-pro";

export const SYS: Record<string, string> = {
  character:
    "You are an expert prompt engineer for a natural-language text-to-image model (z-image / Qwen, distilled). It understands flowing descriptive sentences, NOT booru tag soup, and does NOT support negative prompts. Given a Chinese roleplay character profile, output ONE cohesive Chinese descriptive sentence of the character appearance: 半身构图、性别与气质、发型发色、眼睛、服饰、表情与姿态，并附一句简短的环境与柔和打光。全部用正向自然语言描述，不要用逗号堆砸标签，不要出现 masterpiece / best quality / 1girl 这类 tag。只输出这句提示词本身，不要解释。",
  scene:
    "You are an expert prompt engineer for a natural-language text-to-image model (z-image / Qwen). Given recent Chinese roleplay context, output ONE cohesive Chinese descriptive sentence depicting the current SCENE/environment: 地点、时间与光线、天气氛围、关键陈设与整体色调。聚焦环境而非人物面孔，必要时可写画面中没有人物。用正向自然语言描述，不要标签堆砸，不要出现 masterpiece / scenery 这类 tag。只输出这句提示词本身，不要解释。",
  edit:
    "You translate a casual Chinese edit request for an existing image into ONE concise explicit editing instruction for an instruction-based image-edit model. 用自然语言说清楚要改什么、并保持其他部分不变。只输出这条指令本身，不要解释。"
};

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

/** Gender words arrive in both English and Chinese; only the two obvious buckets are separated. */
function genderWord(v: unknown): string {
  const g = str(v);
  if (g === "male" || /男/.test(g)) return "男";
  if (g === "female" || /女/.test(g)) return "女";
  return g;
}

/** The card as the text model sees it: labelled lines, empty fields omitted. */
export function cardToText(card: unknown): string {
  if (!card) return "一个角色";
  const c = recOf(card);
  const parts: string[] = [];
  if (c.name) parts.push("姓名:" + String(c.name));
  if (c.gender) parts.push("性别:" + genderWord(c.gender));
  if (c.identity) parts.push("身份:" + String(c.identity));
  if (c.personality) parts.push("性格:" + String(c.personality));
  if (c.speakingStyle) parts.push("说话风格:" + String(c.speakingStyle));
  if (c.openingLine) parts.push("开场白:" + String(c.openingLine));
  return parts.join("\n");
}

/** Local fallback for the character prompt; used verbatim when the text side fails. */
export function tplCharacter(card: unknown): string {
  const c = recOf(card);
  let subject = "一位角色";
  const g = str(c.gender);
  if (g === "female" || /女/.test(g)) subject = "一位女性角色";
  else if (g === "male" || /男/.test(g)) subject = "一位男性角色";
  const parts: string[] = ["半身肖像，" + subject + "，单人，正面面向镜头"];
  if (c.age) parts.push("角色年龄：" + String(c.age).trim());
  if (c.identity) parts.push("身份与背景：" + String(c.identity));
  if (c.personality) parts.push("气质性格：" + String(c.personality));
  parts.push("柔和自然的打光，干净简洁的背景，精致的五官与有神的眼睛，构图均衡");
  parts.push("整体高品质、细节丰富、清晰锐利");
  return parts.filter(Boolean).join("，") + "。";
}

/** Local fallback for the scene prompt; the context is collapsed and capped before it is embedded. */
export function tplScene(sceneText: unknown): string {
  const s = String(sceneText || "一个安静的室内场景").replace(/\s+/g, " ").slice(0, 200);
  return "一幅场景画面，描绘当前剧情发生的环境：" + s + "。画面聚焦环境与氛围，没有人物特写，柔和自然的光线，统一的色调，细节丰富、清晰锐利。";
}

/**
 * Art style as a leading sentence. The trailing punctuation of the content is dropped first so the
 * joined prompt does not end up with "……。。".
 */
export function withStyle(prompt: unknown, styleTags: string): string {
  const p = str(prompt);
  const st = str(styleTags);
  if (!st) return p;
  const base = p.replace(/[。.\s]+$/, "");
  return "画风（务必严格遵循）：" + st + "。画面内容：" + base + "。";
}

/** Free-mode model: first `gpt-oss` entry in the injected list, else the built-in default. */
export function pickFreeModel(models: unknown): string {
  const list = Array.isArray(models) ? models : [];
  for (const item of list) {
    const id = str(recOf(item).id);
    if (id.indexOf("gpt-oss") >= 0) return id;
  }
  return DEFAULT_FREE_MODEL;
}

/** Paid fast mode has one configured default; the caller passes whatever the config injected. */
export function pickFastModel(configured: unknown): string {
  return str(configured) || DEFAULT_FAST_MODEL;
}

/**
 * Request body for the prompt engine. `use_builtin_persona: false` matters: the built-in persona
 * would rewrite the answer in character, and this needs the raw prompt sentence.
 */
export function buildChatBody(kind: string, userText: string, mode: string, model: string): Record<string, unknown> {
  return {
    mode: mode,
    model: model,
    promptProfile: "assist",
    use_builtin_persona: false,
    custom_system_prompt: SYS[kind] || SYS.character,
    replyStyle: "default",
    messages: [{ role: "user", content: userText }]
  };
}

/**
 * Consume one streamed chunk, appending whatever `delta.content` it carries. Returns the new text;
 * the caller keeps the accumulator. Lines that are not `data:` frames, are `[DONE]`, or are torn
 * JSON (a chunk boundary can split a frame) are skipped — the next chunk completes them.
 */
export function appendSse(text: string, chunk: string): string {
  let out = text;
  for (const line of String(chunk).split("\n")) {
    if (line.indexOf("data: ") !== 0) continue;
    const s = line.slice(6).trim();
    if (!s || s === "[DONE]") continue;
    try {
      const parsed = JSON.parse(s);
      const choices = recOf(parsed).choices;
      const first = Array.isArray(choices) ? recOf(choices[0]) : {};
      const delta = recOf(first.delta);
      const content = str(delta.content);
      if (content) out += content;
    } catch (e) {
      /* torn frame: the remainder arrives with the next chunk */
    }
  }
  return out;
}

/** Models like to wrap a prompt in quotes or a fence; strip that before using it. */
export function cleanPrompt(out: unknown): string {
  return str(out).trim().replace(/^["'`]+|["'`]+$/g, "").trim();
}

export interface QuickStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface QuickgenPorts {
  storage: QuickStorage;
  /**
   * Ask the prompt engine for one prompt. Rejects when the text side is unavailable; the service
   * then falls back to the local template, so a caller never sees the failure.
   */
  ask(body: Record<string, unknown>): Promise<string>;
  /** Style tags from the portrait module; empty when no style is set. */
  styleTags(): string;
  /** Injected model lists from `/config.js`; absent means "use the built-in defaults". */
  freeModels?(): unknown;
  fastModel?(): unknown;
}

export interface Quickgen {
  mode(): string;
  setMode(m: string): void;
  lastImage(kind: QuickKind): string;
  setLastImage(kind: QuickKind, url: string): void;
  clearLastImage(kind: QuickKind): void;
  buildPrompt(kind: QuickKind, card: unknown, sceneText: unknown): Promise<string>;
  editInstruction(instruction: string): Promise<string>;
  styled(prompt: string): string;
}

export function createQuickgen(ports: QuickgenPorts): Quickgen {
  function mode(): string {
    try {
      return ports.storage.getItem(LS_MODE) || "free";
    } catch (e) {
      return "free";
    }
  }

  function setMode(m: string): void {
    try {
      ports.storage.setItem(LS_MODE, m);
    } catch (e) {}
  }

  function lastImage(kind: QuickKind): string {
    try {
      return ports.storage.getItem(LS_IMG[kind]) || "";
    } catch (e) {
      return "";
    }
  }

  function setLastImage(kind: QuickKind, url: string): void {
    try {
      ports.storage.setItem(LS_IMG[kind], url);
    } catch (e) {}
  }

  function clearLastImage(kind: QuickKind): void {
    try {
      ports.storage.removeItem(LS_IMG[kind]);
    } catch (e) {}
  }

  function styled(prompt: string): string {
    return withStyle(prompt, ports.styleTags());
  }

  /** Ask, and fall back to the template on any failure — including an empty answer. */
  async function resolve(kind: string, userText: string, fallback: string): Promise<string> {
    const m = mode();
    const model = m === "fast" ? pickFastModel(ports.fastModel ? ports.fastModel() : "") : pickFreeModel(ports.freeModels ? ports.freeModels() : []);
    try {
      const body = buildChatBody(kind, userText, m, model);
      const out = cleanPrompt(await ports.ask(body));
      return out || fallback;
    } catch (e) {
      return fallback;
    }
  }

  async function buildPrompt(kind: QuickKind, card: unknown, sceneText: unknown): Promise<string> {
    if (kind === "character") return resolve("character", cardToText(card), tplCharacter(card));
    const scene = String(sceneText || "");
    return resolve("scene", scene, tplScene(scene));
  }

  async function editInstruction(instruction: string): Promise<string> {
    const text = String(instruction || "").trim();
    return resolve("edit", text, text);
  }

  return { mode, setMode, lastImage, setLastImage, clearLastImage, buildPrompt, editInstruction, styled };
}
