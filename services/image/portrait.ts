/**
 * Character portrait: turns the active character card into a half-body illustration prompt, gets
 * one image back, and can promote that image to the messaging flow's base image. The same module
 * owns the site-wide art-style preference every auto-generation path appends to.
 *
 * Two things are deliberately kept apart here. Prompt composition is pure and lives below; the
 * image call and the base-image hand-off are ports, because both need modules that are classic
 * scripts (`imageStudioSvc` / `chatImageSvc`) and neither can be reached from a realm-neutral service.
 * The style preference is a port too, so the storage key stays with the wiring that owns
 * localStorage and the change event.
 *
 * The style tag is prepended *and* re-stated per prompt: non-photographic styles must also
 * declare what they are not, otherwise the upstream model drifts back to photorealism.
 * @module services/image/portrait
 */

export interface StyleSpec {
  label: string;
  tags: string;
}

export const PORTRAIT_STYLES: Record<string, StyleSpec> = {
  none: { label: "默认（不指定）", tags: "" },
  real: { label: "写实", tags: "写实风格 / photorealistic" },
  anime: { label: "动漫（现代日系）", tags: "现代日系动漫 / anime 插画风格" },
  soft: { label: "日系厚涂", tags: "日系厚涂 / Japanese semi-realistic painterly" },
  webtoon: { label: "韩漫（网漫）", tags: "韩漫 / Korean webtoon manhwa" },
  uscomic: { label: "美漫（美式）", tags: "美漫 / American comic" },
  gufeng: { label: "中式（国风）", tags: "中式国风插画 / Chinese gufeng ink painting" },
  fantasy: { label: "欧美奇幻厚涂", tags: "欧美奇幻厚涂 / Western fantasy concept art" },
  oil: { label: "古典油画", tags: "古典油画 / classical oil painting" },
  water: { label: "水彩", tags: "水彩插画 / watercolor painting" },
  render3d: { label: "3D（皮克斯渲染）", tags: "3D 渲染 / Pixar Disney 3D render" },
  chibi: { label: "Q版（萌系）", tags: "Q 版萝系 / chibi" },
  inkmanga: { label: "黑白漫画", tags: "日式默白漫画 / black-and-white manga" },
  cyber: { label: "赛博朋克", tags: "赛博朋克插画 / cyberpunk" }
};

/** One picker row; `key` is the stored value, `label` is the user-facing text. */
export interface StyleOption {
  readonly key: string;
  readonly label: string;
}

/** The picker rows in table order. The settings cards render this, never a local copy. */
export function styleOptions(): StyleOption[] {
  const out: StyleOption[] = [];
  const keys = Object.keys(PORTRAIT_STYLES);
  for (let i = 0; i < keys.length; i++) out.push({ key: keys[i], label: PORTRAIT_STYLES[keys[i]].label });
  return out;
}

const DEFAULT_STYLE = "none";
const ILLUSTRATION_WARNING = "这是一幅二维插画/手绘作品（绝对不是真人照片）。";
const NON_PHOTO_CLOSING = "整幅作品务必是上述画风的插画,绝不画成真人写实照片";
const STYLE_OPENER = "画风务必严格遵循：";

export interface PortraitStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface PortraitImage {
  url: string;
  characterId: string;
  name: string;
}

export interface BaseImageArg {
  characterId: string;
  imageUrl: string;
}

export interface PortraitPorts {
  storage: PortraitStorage;
  /** Fires after every style change; the wiring dispatches the change event. */
  notify(style: string): void;
  /** The active card, or null. Shape is dynamic JSON — every field is read defensively. */
  activeCard(): unknown;
  /** One image for the prompt. Resolves to a URL (or `data:` URL), null when nothing came back. */
  generate(prompt: string): Promise<string | null>;
  /** Resolves false when the image module is not loaded; the service turns that into an error. */
  setBaseImage(arg: BaseImageArg): Promise<boolean>;
}

export interface Portrait {
  generateForActive(): Promise<PortraitImage>;
  setAsBase(imageUrl?: unknown, characterId?: unknown): Promise<string>;
  buildPrompt(card?: unknown): string;
  getStyle(): string;
  setStyle(s: unknown): void;
  getStyleTags(): string;
  getLastImage(): PortraitImage | null;
  /** The picker rows, so both settings cards and any future UI share one style table. */
  styles(): StyleOption[];
}

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

/**
 * Style tags for one style key, or "" for `none`. Photographic styles stand alone; everything
 * else gets the "this is an illustration" warning first, because a bare style tag is regularly
 * beaten by the subject description in the same prompt.
 */
export function styleTagsFor(key: string): string {
  const s = PORTRAIT_STYLES[key];
  if (!s || !s.tags) return "";
  if (key === "real") return s.tags;
  return ILLUSTRATION_WARNING + s.tags;
}

/** Gender is inferred from the card's own words; anything unrecognised stays neutral. */
export function subjectPhrase(card: unknown): string {
  const o = recOf(card);
  const s = (str(o.gender) + " " + str(o.name)).toLowerCase();
  if (/女|girl|female|woman|少女|萝莉/.test(s)) return "一位女性角色";
  if (/男|boy|male|man|少年/.test(s)) return "一位男性角色";
  return "一位角色";
}

/**
 * Full prompt for one card. Card fields are appended only when present, so a half-filled card
 * still produces a usable prompt instead of a sentence with dangling labels.
 */
export function buildPromptFor(card: unknown, styleKey: string): string {
  const st = styleTagsFor(styleKey);
  const o = recOf(card);
  const parts: string[] = [];
  if (st && styleKey !== "real") parts.push(STYLE_OPENER + st);
  parts.push("画面内容：半身肖像，" + subjectPhrase(card) + "，单人，正面面向镜头");
  if (card) {
    if (o.age) parts.push("角色年龄：" + String(o.age).trim());
    if (o.identity) parts.push("身份与背景：" + String(o.identity));
    if (o.personality) parts.push("气质性格：" + String(o.personality));
  }
  parts.push("柔和自然的打光，干净简洁的背景，构图均衡，细节丰富、构图完整、杰作级完成度");
  if (st && styleKey === "real") parts.push(STYLE_OPENER + st);
  else if (st) parts.push(NON_PHOTO_CLOSING);
  return parts.filter(Boolean).join("，") + "。";
}

/**
 * The portrait bridge. `lastImage` is per-session state: it is what `setAsBase()` falls back to
 * when the caller passes neither a URL nor a character id.
 */
export function createPortrait(ports: PortraitPorts): Portrait {
  let lastImage: PortraitImage | null = null;

  function getStyle(): string {
    try {
      return ports.storage.getItem("cfw_image_style_v1") || DEFAULT_STYLE;
    } catch (e) {
      return DEFAULT_STYLE;
    }
  }

  function setStyle(s: unknown): void {
    try {
      ports.storage.setItem("cfw_image_style_v1", str(s) || DEFAULT_STYLE);
    } catch (e) {
      /* storage is best effort: a private-mode failure must not stop the picker */
    }
    ports.notify(getStyle());
  }

  function buildPrompt(card?: unknown): string {
    return buildPromptFor(card, getStyle());
  }

  async function generateForActive(): Promise<PortraitImage> {
    const card = ports.activeCard();
    if (!card) throw new Error("请先在「角色卡」里选择一个角色");
    const img = await ports.generate(buildPrompt(card));
    if (!img) throw new Error("未取到图片");
    const o = recOf(card);
    lastImage = { url: img, characterId: str(o.id) || "default", name: str(o.name) };
    return lastImage;
  }

  async function setAsBase(imageUrl?: unknown, characterId?: unknown): Promise<string> {
    const card = recOf(ports.activeCard());
    const id =
      str(characterId) ||
      (lastImage ? lastImage.characterId : "") ||
      str(card.id) ||
      "default";
    const url = str(imageUrl) || (lastImage ? lastImage.url : "");
    if (!url) throw new Error("还没有可用的立绘");
    const ok = await ports.setBaseImage({ characterId: id, imageUrl: url });
    if (!ok) throw new Error("发图模块未就绪");
    return id;
  }

  return {
    generateForActive,
    setAsBase,
    buildPrompt,
    getStyle,
    setStyle,
    getStyleTags: function () {
      return styleTagsFor(getStyle());
    },
    getLastImage: function () {
      return lastImage;
    },
    styles: styleOptions
  };
}
