/**
 * Image signals in chat text: recognising the marker a model emits when it wants to send a photo,
 * stripping it out of what the user sees, and the settings arithmetic behind the send policy.
 *
 * Three marker generations coexist, and they are tried in this order:
 *  1. `[[img|kind=自拍|主体=…|动作=…|场景=…|nsfw=N]]` — structured, current.
 *  2. `[发图:…]` / `【发景：…】` — the original bracketed form.
 *  3. a bare `发图:` at the start of a line — for models that drop the brackets entirely.
 * A half-written marker (the stream was cut mid-frame) must also be stripped, or the bubble shows
 * raw markup until the next token arrives. That is why the strip regexes accept an unterminated tail.
 *
 * Two details are load-bearing and easy to regress:
 *  - Only the *last* complete marker counts. A model that revises itself mid-answer should send the
 *    photo it described last, not the abandoned first attempt.
 *  - A bracketed marker never matches across a newline, and the bare form only matches at line
 *    start. Loosening either turns ordinary prose ("我发图给你看看") into a photo request.
 *
 * A scene whose subject is clearly not the character (a screenshot, food, a pet) must be generated
 * text-to-image. Routing it through the base-image edit would paint the character's face onto it —
 * that bug is why `looksLikeScene` exists.
 * @module services/image/chat-text
 */

export type PhotoKind = "selfie" | "scene";

export interface Signal {
  scene: string | null;
  kind: PhotoKind | null;
  clean: string;
}

export const LS_ENABLED = "cfw_chat_image_enabled_v1";
export const LS_COOLDOWN = "cfw_chat_image_cooldown_v1";
export const LS_CAP = "cfw_chat_image_cap_v1";
export const LS_BASE = "cfw_chat_base_v1";
export const LS_LAST_AT = "cfw_chat_image_lastat_v1";
export const LS_COUNT = "cfw_chat_image_count_v1";
export const NSFW_KEY = "cfw_nsfw_mode_v1";

export const DEFAULT_COOLDOWN = 20;
export const DEFAULT_CAP = 0;

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

/** Cooldown seconds; unset or garbage falls back to 20, negative is clamped to 0. */
export function parseCooldown(raw: unknown): number {
  const n = parseInt(str(raw), 10);
  return isNaN(n) ? DEFAULT_COOLDOWN : Math.max(0, n);
}

/** Per-conversation cap; 0 means unlimited, which is the default and the reason Bug⑥ is gone. */
export function parseCap(raw: unknown): number {
  const n = parseInt(str(raw), 10);
  return isNaN(n) ? DEFAULT_CAP : Math.max(0, n);
}

/** Restriction level 0..3, used to make the signal fields more explicit. */
export function nsfwLevelOf(raw: unknown): number {
  const n = parseInt(str(raw), 10);
  return isNaN(n) ? 0 : Math.max(0, Math.min(3, n));
}

export function countOf(counts: unknown, key: string): number {
  const n = Number(recOf(counts)[key]);
  return isFinite(n) && n > 0 ? n : 0;
}

/** Immutable increment, so the caller decides when to write the map back. */
export function bumpCount(counts: unknown, key: string): Record<string, number> {
  const src = recOf(counts);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(src)) out[k] = Number(v) || 0;
  out[key] = (out[key] || 0) + 1;
  return out;
}

export function resetCount(counts: unknown, key: string): Record<string, number> {
  const src = recOf(counts);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(src)) out[k] = Number(v) || 0;
  out[key] = 0;
  return out;
}

/**
 * Whether an automatic signal may actually produce an image. A manual request always may; an
 * automatic one respects the switch, the cooldown and the cap. Rapid multi-agent contexts skip the
 * cooldown: several characters replying in a row is the point there, not a rate problem.
 */
export function shouldSend(o: {
  enabled: boolean;
  manual: boolean;
  rapidMulti: boolean;
  now: number;
  lastAt: number;
  cooldownSec: number;
  cap: number;
  count: number;
}): boolean {
  if (!o.enabled && !o.manual) return false;
  if (o.manual) return true;
  if (!o.rapidMulti && o.cooldownSec > 0 && o.now - o.lastAt < o.cooldownSec * 1000) return false;
  if (o.cap > 0 && o.count >= o.cap) return false;
  return true;
}

/** The capability paragraph appended to the system prompt; empty when the feature is off. */
export function injectionFor(nsfwLevel: number): string {
  let base =
    "\n\n【发图能力】你可以发图,但必须严格按结构化格式输出,否则系统识别不了会把指令漏给用户看(很糟糕):\n" +
    "· 发图信号必须单独成行、放在正文之后(群聊里若还要交棒,放在交棒标记 [next:对方名字] 的前面),格式:\n" +
    "  [[img|kind=自拍|主体=…|动作=…|场景=…|nsfw=N]]\n" +
    "  · kind:自拍=图里有你本人出镜(自拍/合照/展示样子/穿搭/表情);场景=图里没有你,是你眼前的东西(游戏/聊天/手机截图、风景、食物外卖、宠物、买到的物品等)。\n" +
    "  · 主体:画面主角是谁/什么;动作:姿态或正在做的事;场景:环境/光线/氛围;nsfw:当前限制级等级数字(没有就写0)。\n" +
    "  · 判断口诀:只要图的主角不是你本人(游戏截图/风景/外卖/猫猫…),kind 一律写 场景,用错会把你的脸 P 进画面。\n" +
    "· 竖线 | 和字段名一个都不能少,用半角等号 = 连接;字段值里别再用 | 或 ] 字符。信号前面正常说你的话。\n" +
    "· 【重要】当用户明确叫你发照片/自拍/看看你长什么样/发图给他时,你必须真的输出发图信号,不能只用文字「我发了一张…」搪塞。\n" +
    "· 不需要发图时完全不要输出信号。\n" +
    "· (兼容:旧的 [发图:画面描述] / [发景:画面描述] 仍能识别,但请优先用上面的结构化格式。)";
  if (nsfwLevel >= 1) {
    base +=
      "\n· 【限制级·直白出图】当前为限制级模式(等级" + nsfwLevel +
      "):若画面涉及亲密/露骨内容,主体/动作/场景 字段必须直白、具体、可视化——直接写身体部位、暴露/解开程度、姿态动作、穿着、表情,用短语标签堆叠(像给画师下 tag),严禁用「你懂的」「那种样子」「不可描述」这类含蓄词,并把 nsfw 字段写成当前等级。正文对话可以含蓄,但信号字段要让画图模型一看就懂。";
  }
  return base;
}

/** `kind=自拍|主体=…` split into lower-cased keys; the unkeyed first token is kept as `_free`. */
export function parseStructured(inner: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(inner || "").split("|")) {
    const idx = part.indexOf("=");
    if (idx < 0) {
      const free = part.trim();
      if (free && !out._free) out._free = free;
      continue;
    }
    const k = part.slice(0, idx).trim().toLowerCase();
    const v = part.slice(idx + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

/** Subject / action / setting joined in that order; the free text is the fallback. */
export function structuredToScene(f: Record<string, string>): string {
  const subj = f["主体"] || f.subject || f.who || "";
  const act = f["动作"] || f.action || f.pose || "";
  const env = f["场景"] || f.scene || f["背景"] || f.env || f.setting || "";
  const s = [subj, act, env].filter(Boolean).join("，");
  return s || f._free || "";
}

/** Explicit kind wins; otherwise the scene words decide. */
export function structuredKind(f: Record<string, string>, scene: string): PhotoKind {
  const t = (f.kind || f["类型"] || f.type || "").toLowerCase();
  if (/景|scene|环境|物|食|宠|截图|风景/.test(t)) return "scene";
  if (/自拍|selfie|人|本人|出镜|portrait|肖像/.test(t)) return "selfie";
  return detectKind(scene);
}

/**
 * Whether the described picture has no character in it. These words are the ones that betrayed the
 * old behaviour: a game screenshot edited with the base image put the character's face on it.
 */
export function looksLikeScene(scene: string): boolean {
  return /截图|屏幕|界面|游戏|对局|战绩|聊天记录|消息|网页|视频|game|screenshot|screen|外卖|美食|食物|菜|饭|奶茶|咖啡|蛋糕|甜点|food|meal|宠物|猫|狗|小猫|小狗|cat|dog|pet|物品|东西|商品|包裹|快递|礼物|手办|盲盒|桌面|书|杂志|花|植物|风景|景色|景观|场景|环境|窗外|外面|远处|天空|夜景|海边|海滩|沙滩|街道|城市|马路|山|湖|河|森林|田野|雪景|夕阳|日落|日出|星空|烟花|花海|庭院|建筑|商场|房间|装修|landscape|scenery|environment|sky|street|city|sunset|view/i.test(
    String(scene || "")
  );
}

export function detectKind(scene: string): PhotoKind {
  const s = String(scene || "");
  if (/自拍|合照|selfie|我的脸|我的样子|看看我|我穿|我的表情|我的新|我今天|肖像|portrait/i.test(s)) return "selfie";
  if (looksLikeScene(s)) return "scene";
  return "selfie";
}

function structuredRe(): RegExp {
  return /\[{1,2}\s*img\s*\|([^\[\]\n]*)\]{1,2}/gi;
}

function legacyRe(): RegExp {
  return /[\[【]{1,2}\s*(发?图|发?景|风景|发)\s*[:：]([^\]】\n]*)[\]】]{0,2}/g;
}

function bareRe(): RegExp {
  return /(?:^|\n)[ \t　]*(发图|发景)\s*[:：][ \t　]*([^\n\]】]*)/g;
}

/**
 * Pull the last photo marker out of a finished reply, and return the text with every marker
 * removed. The structured form is tried first; the legacy and bare forms only if it found nothing.
 */
export function extractSignal(text: unknown): Signal {
  if (!text || typeof text !== "string") return { scene: null, kind: null, clean: str(text) };
  let scene: string | null = null;
  let kind: PhotoKind | null = null;

  const st = structuredRe();
  let m: RegExpExecArray | null;
  while ((m = st.exec(text)) !== null) {
    const f = parseStructured(m[1]);
    const s = structuredToScene(f);
    if (s) {
      scene = s;
      kind = structuredKind(f, s);
    }
  }
  if (scene === null) {
    const lg = legacyRe();
    while ((m = lg.exec(text)) !== null) {
      scene = str(m[2]).trim();
      kind = /景/.test(str(m[1])) ? "scene" : "selfie";
    }
  }
  if (scene === null) {
    const br = bareRe();
    while ((m = br.exec(text)) !== null) {
      scene = str(m[2]).trim();
      kind = /景/.test(str(m[1])) ? "scene" : "selfie";
    }
  }
  if (scene === null) return { scene: null, kind: null, clean: text };

  const clean = text
    .replace(structuredRe(), "")
    .replace(legacyRe(), "")
    .replace(bareRe(), "")
    .replace(/[\s\r\n|]+$/, "");
  return { scene: scene, kind: kind, clean: clean };
}

/**
 * Strip markers (including a half-written tail) for display. Streaming means the text is often cut
 * mid-marker, so the trailing patterns deliberately match an unterminated sequence.
 */
export function stripSignalForDisplay(text: unknown): string {
  if (!text || typeof text !== "string") return str(text);
  let s = text.replace(structuredRe(), "");
  s = s.replace(/\[{1,2}\s*img\s*\|[^\]\n]*$/i, "");
  s = s.replace(legacyRe(), "");
  // A cut-off opener: "[发图:客厅" / "[图:" / "[图". Not the bare 发 branch — that ate prose.
  s = s.replace(/[\[【]{1,2}\s*(发?图|发?景|风景)\s*[:：]?[^\]】\n]*$/g, "");
  s = s.replace(bareRe(), "");
  return s.replace(/[\s\r\n|]+$/, "");
}

/** Selfie prompt built from the card: identity, gender and age make the face match the character. */
export function localExpand(scene: string, card: unknown, nsfwLevel: number): string {
  const c = recOf(card);
  const name = str(c.name) || "角色";
  const parts: string[] = [];
  let subj = "一张" + name + "的自拍照";
  if (c.identity) subj += "，" + str(c.identity).slice(0, 100);
  else if (c.personality) subj += "，气质:" + str(c.personality).slice(0, 60);
  if (c.gender) subj += "，" + str(c.gender);
  if (c.age) subj += "，" + String(c.age) + "岁";
  parts.push(subj);
  parts.push("画面:" + scene);
  parts.push(nsfwLevel >= 1 ? "写实风格、细节清晰可视化、真实光线" : "写实、自然光、手机自拍视角、清晰");
  return parts.join("，") + "。";
}

export function localExpandScene(scene: string): string {
  return "一张实景照片。画面:" + scene + "。聚焦环境与氛围、没有人物、自然真实的光线、清晰。";
}

/** Placeholder image used when the image module is not wired: the prompt itself, wrapped in SVG. */
export function mockImage(text: unknown): string {
  const t = String(text || "");
  const lines: string[] = [];
  let i = 0;
  while (i < t.length && lines.length < 7) {
    lines.push(t.slice(i, i + 16));
    i += 16;
  }
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const tspans = lines
    .map((ln, k) => '<tspan x="160" dy="' + (k === 0 ? 0 : 22) + '">' + esc(ln) + "</tspan>")
    .join("");
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="400">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#587a9d"/><stop offset="1" stop-color="#8fb2d4"/></linearGradient></defs>' +
    '<rect width="320" height="400" fill="url(#g)"/>' +
    '<text x="160" y="46" fill="#fff" font-size="15" text-anchor="middle" opacity="0.9">📷 模拟出图 (mock)</text>' +
    '<text x="160" y="150" fill="#fff" font-size="13" text-anchor="middle" opacity="0.95">' + tspans + "</text>" +
    "</svg>";
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

/** Generation timeout by kind: a scene is quick, an unbased selfie can wait on a first-time base. */
export function timeoutFor(kind: PhotoKind, hasBase: boolean): number {
  if (kind === "scene") return 120000;
  return hasBase ? 180000 : 300000;
}
