/**
 * Character avatars: one square close-up headshot per character card, cut from the image-chat base
 * image and kept as an id → URL map. Generation goes through the chat-image edit port, which is
 * also what files the result into the local gallery — this module never talks to a provider.
 *
 * The map is one JSON blob under a single storage key, not one key per character: the set is small,
 * every read wants at most one entry, and `__character` reads it on each card render. A payload
 * that is not a JSON object is treated as empty, and non-string values are dropped on read, so a
 * bad write degrades to "no avatar" instead of breaking the settings card.
 * @module services/image/avatar
 */

export interface AvatarExpression {
  /** Label shown in the picker; also the exact string callers pass back to generate. */
  key: string;
  /** Appended to the crop instruction. English on purpose: the edit model is prompted in it. */
  en: string;
}

export const AVATAR_EXPRESSIONS: AvatarExpression[] = [
  { key: "默认", en: "a natural calm expression" },
  { key: "微笑", en: "a gentle warm smile" },
  { key: "开心", en: "a happy bright smile" },
  { key: "害羞", en: "a shy bashful blush" },
  { key: "认真", en: "a serious focused expression" }
];

const STORAGE_KEY = "cfw_char_avatar_v1";
const AVATAR_DEFAULT_ID = "default";
const AVATAR_DEFAULT_NAME = "当前角色";
const CROP_PREFIX =
  "Crop to a close-up headshot portrait of the SAME person from the source image, face and shoulders centered, ";
const CROP_SUFFIX =
  ", clean soft solid-color background, square composition, sharp focus on the face, high-quality profile avatar. Keep the same identity, hairstyle and outfit. Do NOT change the face.";

/** Crop instruction for one expression. The identity clause is part of every prompt, not a suffix
 * the caller may drop — without it the edit model redraws the face. */
export function avatarInstruction(en: string): string {
  return CROP_PREFIX + en + CROP_SUFFIX;
}

export interface AvatarStorage {
  /** The raw blob, or null when the key is unset. Parsing stays on this side of the port. */
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface AvatarEditArg {
  characterId: string;
  instruction: string;
}

export interface AvatarPorts {
  storage: AvatarStorage;
  /** False when the chat-image edit module is not loaded. Reported verbatim instead of starting a
   * run that cannot finish. */
  hasEdit(): boolean;
  /** One edited image. Resolves to the provider payload; `imageUrl` is read off it. */
  edit(arg: AvatarEditArg): Promise<unknown>;
  /** The active card, or null. Dynamic JSON — every field is read defensively. */
  activeCard(): unknown;
  /** After every write or clear, with the stored URL or null. The wiring dispatches the event. */
  notify(id: string, url: string | null): void;
  /** Progress text for the settings card. Wording is decided here, rendering is the wiring's job. */
  status(msg: string): void;
  /** Called after a successful generation, once the new URL is already stored. */
  preview(): void;
}

export interface Avatar {
  /** Resolves to the stored URL, or null when the edit module is absent, nothing came back, or the
   * call rejected. Failures are reported through {@link AvatarPorts.status}, never thrown. */
  generate(opts?: unknown): Promise<string | null>;
  /** URL for an explicit id, or for the active card when the id is missing. */
  get(id?: unknown): string | null;
  getAll(): Record<string, string>;
  /** No-op when the URL is empty. Resolves the id like {@link Avatar.get} does. */
  set(id: unknown, url: unknown): void;
  clear(id: unknown): void;
  activeId(): string;
  activeName(): string;
  readonly list: AvatarExpression[];
}

function recOf(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

function strOf(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Display text for a card field: scalars are rendered as-is, everything else falls through to the
 * caller's default — the old `(c && c.name) || fallback` did the same by string coercion. */
function textOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

/** Map key for a caller-supplied id. Falsy and non-scalar ids fall through to the active card,
 * which is what `id || activeId()` did — 0 included. */
function idOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" && v !== 0 && Number.isFinite(v)) return String(v);
  return "";
}

function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e && e.message) return String(e.message);
  return String(e);
}

/**
 * The avatar bridge. All reads go back to storage — there is no in-memory cache, because the
 * character panel and this card write the same blob and a stale copy would win.
 */
export function createAvatar(ports: AvatarPorts): Avatar {
  function loadMap(): Record<string, string> {
    const out: Record<string, string> = {};
    let raw: string | null = null;
    try {
      raw = ports.storage.getItem(STORAGE_KEY);
    } catch (e) {
      return out;
    }
    if (!raw) return out;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return out;
    }
    for (const [k, v] of Object.entries(recOf(parsed))) {
      if (typeof v === "string" && v) out[k] = v;
    }
    return out;
  }

  function saveMap(m: Record<string, string>): void {
    try {
      ports.storage.setItem(STORAGE_KEY, JSON.stringify(m));
    } catch (e) {
      /* storage is best effort: a private-mode failure must not break the button handler */
    }
  }

  /** The active card, flattened. A port that throws is treated as "no card": a broken bridge must
   * not take down a button handler. */
  function activeCard(): Record<string, unknown> {
    try {
      return recOf(ports.activeCard());
    } catch (e) {
      return {};
    }
  }

  function activeId(): string {
    return idOf(activeCard().id) || AVATAR_DEFAULT_ID;
  }

  function activeName(): string {
    return textOf(activeCard().name) || AVATAR_DEFAULT_NAME;
  }

  function get(id?: unknown): string | null {
    const url = loadMap()[idOf(id) || activeId()];
    return url || null;
  }

  function getAll(): Record<string, string> {
    return loadMap();
  }

  function set(id: unknown, url: unknown): void {
    const u = strOf(url);
    if (!u) return;
    const key = idOf(id) || activeId();
    const m = loadMap();
    m[key] = u;
    saveMap(m);
    ports.notify(key, u);
  }

  function clear(id: unknown): void {
    const key = idOf(id) || activeId();
    const m = loadMap();
    delete m[key];
    saveMap(m);
    ports.notify(key, null);
  }

  async function generate(opts?: unknown): Promise<string | null> {
    const o = recOf(opts);
    if (!ports.hasEdit()) {
      ports.status("发图模块未就绪");
      return null;
    }
    const item = AVATAR_EXPRESSIONS.filter(function (e) {
      return e.key === o.expression;
    })[0] || AVATAR_EXPRESSIONS[0];
    const id = activeId();
    ports.status("正在生成头像（" + item.key + "）…首次无基准图会先造一张，约 30-45s");
    try {
      const res = recOf(await ports.edit({ characterId: id, instruction: avatarInstruction(item.en) }));
      const url = strOf(res.imageUrl);
      if (url) {
        set(id, url);
        ports.preview();
        ports.status("头像已生成并保存，也存入了本地画廊");
        return url;
      }
      ports.status("未返回结果");
    } catch (e) {
      ports.status("生成失败:" + errText(e));
    }
    return null;
  }

  return {
    generate,
    get,
    getAll,
    set,
    clear,
    activeId,
    activeName,
    list: AVATAR_EXPRESSIONS
  };
}
