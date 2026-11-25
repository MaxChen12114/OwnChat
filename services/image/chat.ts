/**
 * Chat photos: the image side of "send a photo" in a text conversation. Turns a scene description
 * (plus the character card) into a prompt, picks between text-to-image and edit-the-base-image,
 * and hands the result to the shared image pipeline.
 *
 * The pipeline itself is not here. Generation, editing, polling, R2 persistence and the base-image
 * store all live in the classic `__imageCommon` module, which arrives as one port; this file owns
 * only the chat-specific semantics:
 *  - the comma-tag art style is appended here, because the other two chains splice it differently;
 *  - edit parameters are pinned to 20 steps / guidance 3.5 with a 2.5s poll — the fast preset loses
 *    gender and identity, and 4 steps was the version that produced men for female characters;
 *  - the prompt names the character (name / age / identity / personality), otherwise the model
 *    drifts back to a generic stranger.
 *
 * Two scenes take different routes on purpose. A `scene` request is plain text-to-image and must
 * not contain the character at all. A selfie edits an existing base image so the face survives;
 * only when no base image exists does it fall back to a one-shot text-to-image, which is faster
 * than creating a base image first and editing it.
 * @module services/image/chat
 */

export interface BaseImageStore {
  get(characterId: string): Promise<string | null>;
  set(characterId: string, imageUrl: string): Promise<unknown>;
  clear(characterId: string): Promise<unknown>;
}

export interface EditOutcome {
  fileUrl: string;
  taskId?: string | null;
}

export interface GenImageOpts {
  prompt: string;
  n: number;
  size: string;
}

export interface GenEditOpts {
  prompt: string;
  srcUrl: string;
  steps: number;
  guidance: number;
  intervalMs: number;
  filename: string;
}

/** The shared pipeline module: primitives plus the two stores it already owns. */
export interface ImageCommonLike {
  styleSuffix(): string;
  genImage(o: GenImageOpts): Promise<string[]>;
  genEdit(o: GenEditOpts): Promise<EditOutcome>;
  baseImage: BaseImageStore;
  /** Uploads a temporary url to R2 and returns the durable one. */
  persistToR2(fileUrl: string): Promise<string>;
}

export interface CharacterLike {
  listAllCards?(): unknown[];
  getActiveCard?(): unknown;
}

export interface ChatImagePorts {
  /** Resolved once by the wiring, which also reports a missing pipeline module. */
  ic: ImageCommonLike;
  /** Read at call time: the character module may load after this one. */
  character(): CharacterLike | null;
  /** Injectable clock; only used to build task ids. */
  now?(): number;
}

export interface PhotoResult {
  imageUrl: string;
  taskId: string;
}

export interface ChatImage {
  sendPhoto(args?: unknown): Promise<PhotoResult>;
  editImage(args?: unknown): Promise<PhotoResult>;
  setBaseImage(args?: unknown): Promise<void>;
  getBaseImage(args?: unknown): Promise<string | null>;
  clearBaseImage(args?: unknown): Promise<unknown>;
}

const EDIT_STEPS = 20;
const EDIT_GUIDANCE = 3.5;
const POLL_INTERVAL = 2500;

function recOf(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** `string` id, or `{ characterId }`; anything missing falls back to the default character. */
export function readCharId(args: unknown): string {
  if (typeof args === "string") return args || "default";
  return str(recOf(args).characterId) || "default";
}

/** Append the site-wide style as comma tags — this chain's spelling of it. */
export function withStyle(prompt: string, suffix: string): string {
  return suffix ? prompt + ", " + suffix : prompt;
}

function whoToken(card: unknown): string {
  const o = recOf(card);
  const s = (str(o.gender) + " " + str(o.name)).toLowerCase();
  if (/女|girl|female|woman/.test(s)) return "1girl";
  if (/男|boy|male|man/.test(s)) return "1boy";
  return "1person";
}

/**
 * Full prompt for the first base image. Card fields are appended only when present; the name is
 * kept in because the upstream renders "character: <name>" as a weak identity anchor.
 */
export function characterPrompt(card: unknown): string {
  const o = recOf(card);
  const t = ["masterpiece", "best quality", "highly detailed", whoToken(card), "solo", "portrait",
    "looking at viewer", "detailed face", "soft natural lighting"];
  if (card) {
    if (o.name) t.push("character: " + String(o.name));
    if (o.age) t.push("age: " + String(o.age));
    if (o.identity) t.push(String(o.identity));
    if (o.personality) t.push(String(o.personality) + " vibe");
  }
  return t.filter(Boolean).join(", ");
}

/** Camera framing inferred from the scene words; the fallback is a phone selfie. */
export function pickFraming(scene: string): string {
  const t = scene.toLowerCase();
  if (/full body|full-body|head to toe|whole body|全身|站姿|全身照/.test(t))
    return "full-body shot, head to toe visible, natural standing or action pose";
  if (/wide shot|landscape|scenery|far away|street|远景|风景|环境|街道|城市|海边|广角/.test(t))
    return "wide environmental shot, subject placed within a detailed scene, cinematic framing";
  if (/close[- ]?up|特写|脸部|大头|面部/.test(t))
    return "close-up portrait, face and shoulders, shallow depth of field";
  return "natural casual phone-selfie framing, upper body";
}

/**
 * Gender lock for the edit instruction, inferred from gender, name and identity. Empty when the
 * card says nothing either way — inventing a gender here is what produced the wrong one.
 */
export function subjectClause(card: unknown): string {
  const o = recOf(card);
  const s = (str(o.gender) + " " + str(o.name) + " " + str(o.identity)).toLowerCase();
  if (/女|girl|female|woman|少女|萝莉|妹|姐|母|娘|她/.test(s))
    return "The subject is a woman; keep her female gender and feminine appearance";
  if (/男|boy|male|man|少年|大叔|哥|弟|父|他/.test(s))
    return "The subject is a man; keep his male gender and masculine appearance";
  return "";
}

/**
 * Scene → edit instruction that keeps the same person. The identity clause comes first and the
 * scene last: an upstream that truncates keeps the face, which is the part that must not drift.
 */
export function editInstruction(scenePrompt: string, card: unknown): string {
  const s = (scenePrompt || "").trim() || "taking a casual selfie";
  const who = subjectClause(card);
  return "Edit the SOURCE photo while keeping the SAME person: identical face, hairstyle, gender, body type, outfit colors and identity. "
    + (who ? who + ". " : "")
    + "Do NOT replace the person with someone else and do NOT change their gender. Place this same person in the scene: "
    + s + ". " + pickFraming(s) + ", consistent character.";
}

export function createChatImage(ports: ChatImagePorts): ChatImage {
  const ic = ports.ic;
  const now = ports.now || function () { return Date.now(); };

  function findCardById(id: string): unknown {
    const ch = ports.character();
    try {
      if (id && id !== "default" && id !== "__none__" && ch) {
        const list = (ch.listAllCards ? ch.listAllCards() : []) || [];
        for (const c of list) {
          if (recOf(c).id === id) return c;
        }
      }
      return ch && ch.getActiveCard ? ch.getActiveCard() : null;
    } catch (e) {
      return null;
    }
  }

  function genZImage(prompt: string): Promise<string> {
    return ic.genImage({ prompt: withStyle(prompt, ic.styleSuffix()), n: 1, size: "1024x1024" })
      .then(function (arr) { return arr[0]; });
  }

  function genEdit(prompt: string, srcUrl: string): Promise<EditOutcome> {
    return ic.genEdit({
      prompt: withStyle(prompt, ic.styleSuffix()),
      srcUrl: srcUrl,
      steps: EDIT_STEPS,
      guidance: EDIT_GUIDANCE,
      intervalMs: POLL_INTERVAL,
      filename: "base.png"
    });
  }

  async function getBaseImage(args?: unknown): Promise<string | null> {
    return ic.baseImage.get(readCharId(args));
  }

  async function setBaseImage(args?: unknown): Promise<void> {
    const o = recOf(args);
    const imageUrl = str(o.imageUrl);
    if (!imageUrl) return;
    await ic.baseImage.set(readCharId(o), imageUrl);
  }

  async function clearBaseImage(args?: unknown): Promise<unknown> {
    return ic.baseImage.clear(readCharId(args));
  }

  async function ensureBase(id: string, baseImageUrl: string, card: unknown): Promise<string | null> {
    if (baseImageUrl) {
      await ic.baseImage.set(id, baseImageUrl);
      return baseImageUrl;
    }
    const existing = await getBaseImage(id);
    if (existing) return existing;
    const raw = await genZImage(characterPrompt(card));
    await ic.baseImage.set(id, raw);
    return raw;
  }

  async function editImage(args?: unknown): Promise<PhotoResult> {
    const o = recOf(args);
    const id = str(o.characterId) || "default";
    const card = findCardById(id);
    const instruction = str(o.instruction) || editInstruction(str(o.scenePrompt), card);
    const base = await ensureBase(id, str(o.baseImageUrl), card);
    const res = await genEdit(instruction, base);
    const imageUrl = await ic.persistToR2(res.fileUrl);
    return { imageUrl: imageUrl, taskId: str(res.taskId) };
  }

  async function genScene(scenePrompt: string): Promise<PhotoResult> {
    const raw = await genZImage(scenePrompt || "a quiet scenery, no people");
    const imageUrl = await ic.persistToR2(raw);
    return { imageUrl: imageUrl, taskId: "scene-" + now() };
  }

  async function genSelfieNoBase(args: unknown): Promise<PhotoResult> {
    const o = recOf(args);
    const card = findCardById(str(o.characterId) || "default");
    const scene = str(o.scenePrompt).trim();
    const prompt = characterPrompt(card) + (scene ? ", " + scene : "") + ", natural casual phone selfie, upper body";
    const raw = await genZImage(prompt);
    const imageUrl = await ic.persistToR2(raw);
    return { imageUrl: imageUrl, taskId: "selfie-" + now() };
  }

  async function sendPhoto(args?: unknown): Promise<PhotoResult> {
    const o = recOf(args);
    if (str(o.kind) === "scene") return genScene(str(o.scenePrompt));
    const id = str(o.characterId) || "default";
    const base = str(o.baseImageUrl) || await getBaseImage(id);
    if (base) return editImage({ characterId: id, baseImageUrl: base, scenePrompt: str(o.scenePrompt) });
    return genSelfieNoBase({ characterId: id, scenePrompt: str(o.scenePrompt) });
  }

  return {
    sendPhoto: sendPhoto,
    editImage: editImage,
    setBaseImage: setBaseImage,
    getBaseImage: getBaseImage,
    clearBaseImage: clearBaseImage
  };
}
