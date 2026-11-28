(function () {
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

                                           

                         
                       
                         
                
 

const LS_ENABLED = "cfw_chat_image_enabled_v1";
const LS_COOLDOWN = "cfw_chat_image_cooldown_v1";
const LS_CAP = "cfw_chat_image_cap_v1";
const LS_BASE = "cfw_chat_base_v1";
const LS_LAST_AT = "cfw_chat_image_lastat_v1";
const LS_COUNT = "cfw_chat_image_count_v1";
const NSFW_KEY = "cfw_nsfw_mode_v1";

const DEFAULT_COOLDOWN = 20;
const DEFAULT_CAP = 0;

function str(v         )         {
  return typeof v === "string" ? v : "";
}

function recOf(v         )                          {
  const out                          = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

/** Cooldown seconds; unset or garbage falls back to 20, negative is clamped to 0. */
function parseCooldown(raw         )         {
  const n = parseInt(str(raw), 10);
  return isNaN(n) ? DEFAULT_COOLDOWN : Math.max(0, n);
}

/** Per-conversation cap; 0 means unlimited, which is the default and the reason Bug⑥ is gone. */
function parseCap(raw         )         {
  const n = parseInt(str(raw), 10);
  return isNaN(n) ? DEFAULT_CAP : Math.max(0, n);
}

/** Restriction level 0..3, used to make the signal fields more explicit. */
function nsfwLevelOf(raw         )         {
  const n = parseInt(str(raw), 10);
  return isNaN(n) ? 0 : Math.max(0, Math.min(3, n));
}

function countOf(counts         , key        )         {
  const n = Number(recOf(counts)[key]);
  return isFinite(n) && n > 0 ? n : 0;
}

/** Immutable increment, so the caller decides when to write the map back. */
function bumpCount(counts         , key        )                         {
  const src = recOf(counts);
  const out                         = {};
  for (const [k, v] of Object.entries(src)) out[k] = Number(v) || 0;
  out[key] = (out[key] || 0) + 1;
  return out;
}

function resetCount(counts         , key        )                         {
  const src = recOf(counts);
  const out                         = {};
  for (const [k, v] of Object.entries(src)) out[k] = Number(v) || 0;
  out[key] = 0;
  return out;
}

/**
 * Whether an automatic signal may actually produce an image. A manual request always may; an
 * automatic one respects the switch, the cooldown and the cap. Rapid multi-agent contexts skip the
 * cooldown: several characters replying in a row is the point there, not a rate problem.
 */
function shouldSend(o   
                   
                  
                      
              
                 
                      
              
                
 )          {
  if (!o.enabled && !o.manual) return false;
  if (o.manual) return true;
  if (!o.rapidMulti && o.cooldownSec > 0 && o.now - o.lastAt < o.cooldownSec * 1000) return false;
  if (o.cap > 0 && o.count >= o.cap) return false;
  return true;
}

/** The capability paragraph appended to the system prompt; empty when the feature is off. */
function injectionFor(nsfwLevel        )         {
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
function parseStructured(inner        )                         {
  const out                         = {};
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
function structuredToScene(f                        )         {
  const subj = f["主体"] || f.subject || f.who || "";
  const act = f["动作"] || f.action || f.pose || "";
  const env = f["场景"] || f.scene || f["背景"] || f.env || f.setting || "";
  const s = [subj, act, env].filter(Boolean).join("，");
  return s || f._free || "";
}

/** Explicit kind wins; otherwise the scene words decide. */
function structuredKind(f                        , scene        )            {
  const t = (f.kind || f["类型"] || f.type || "").toLowerCase();
  if (/景|scene|环境|物|食|宠|截图|风景/.test(t)) return "scene";
  if (/自拍|selfie|人|本人|出镜|portrait|肖像/.test(t)) return "selfie";
  return detectKind(scene);
}

/**
 * Whether the described picture has no character in it. These words are the ones that betrayed the
 * old behaviour: a game screenshot edited with the base image put the character's face on it.
 */
function looksLikeScene(scene        )          {
  return /截图|屏幕|界面|游戏|对局|战绩|聊天记录|消息|网页|视频|game|screenshot|screen|外卖|美食|食物|菜|饭|奶茶|咖啡|蛋糕|甜点|food|meal|宠物|猫|狗|小猫|小狗|cat|dog|pet|物品|东西|商品|包裹|快递|礼物|手办|盲盒|桌面|书|杂志|花|植物|风景|景色|景观|场景|环境|窗外|外面|远处|天空|夜景|海边|海滩|沙滩|街道|城市|马路|山|湖|河|森林|田野|雪景|夕阳|日落|日出|星空|烟花|花海|庭院|建筑|商场|房间|装修|landscape|scenery|environment|sky|street|city|sunset|view/i.test(
    String(scene || "")
  );
}

function detectKind(scene        )            {
  const s = String(scene || "");
  if (/自拍|合照|selfie|我的脸|我的样子|看看我|我穿|我的表情|我的新|我今天|肖像|portrait/i.test(s)) return "selfie";
  if (looksLikeScene(s)) return "scene";
  return "selfie";
}

function structuredRe()         {
  return /\[{1,2}\s*img\s*\|([^\[\]\n]*)\]{1,2}/gi;
}

function legacyRe()         {
  return /[\[【]{1,2}\s*(发?图|发?景|风景|发)\s*[:：]([^\]】\n]*)[\]】]{0,2}/g;
}

function bareRe()         {
  return /(?:^|\n)[ \t　]*(发图|发景)\s*[:：][ \t　]*([^\n\]】]*)/g;
}

/**
 * Pull the last photo marker out of a finished reply, and return the text with every marker
 * removed. The structured form is tried first; the legacy and bare forms only if it found nothing.
 */
function extractSignal(text         )         {
  if (!text || typeof text !== "string") return { scene: null, kind: null, clean: str(text) };
  let scene                = null;
  let kind                   = null;

  const st = structuredRe();
  let m                        ;
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
function stripSignalForDisplay(text         )         {
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
function localExpand(scene        , card         , nsfwLevel        )         {
  const c = recOf(card);
  const name = str(c.name) || "角色";
  const parts           = [];
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

function localExpandScene(scene        )         {
  return "一张实景照片。画面:" + scene + "。聚焦环境与氛围、没有人物、自然真实的光线、清晰。";
}

/** Placeholder image used when the image module is not wired: the prompt itself, wrapped in SVG. */
function mockImage(text         )         {
  const t = String(text || "");
  const lines           = [];
  let i = 0;
  while (i < t.length && lines.length < 7) {
    lines.push(t.slice(i, i + 16));
    i += 16;
  }
  const esc = (s        ) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
function timeoutFor(kind           , hasBase         )         {
  if (kind === "scene") return 120000;
  return hasBase ? 180000 : 300000;
}

// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/image/chat-text.ts; this file owns the
// settings storage, the photo bubble, the settings card and the call into the image module.
//
// The red line from the original stands: this never touches the image side's own files, and it
// never edits the core persona prompt — the capability text is appended as a separate segment.
(function () {
  "use strict";

  function lsGet(k, d) { try { var v = window.localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} }
  function lsGetNum(k, d) { return parseInt(lsGet(k, d), 10); }

  function isEnabled() { return lsGet(LS_ENABLED, "1") === "1"; }
  function cooldownSec() { return parseCooldown(lsGet(LS_COOLDOWN, String(DEFAULT_COOLDOWN))); }
  function capPerChat() { return parseCap(lsGet(LS_CAP, String(DEFAULT_CAP))); }
  function nsfwLevel() { return nsfwLevelOf(lsGet(NSFW_KEY, "0")); }

  function slotKey() {
    try {
      var c = window.characterSvc && window.characterSvc.getActiveCard && window.characterSvc.getActiveCard();
      return c && c.id ? c.id : "__none__";
    } catch (e) { return "__none__"; }
  }
  function getCounts() {
    try {
      var o = JSON.parse(lsGet(LS_COUNT, "{}"));
      return (o && typeof o === "object") ? o : {};
    } catch (e) { return {}; }
  }
  function chatCount() { return countOf(getCounts(), slotKey()); }
  // The service exports bumpCount/resetCount as pure transforms; these two are the write actions,
  // so they carry a different name instead of shadowing them.
  function bumpChatCount() { lsSet(LS_COUNT, JSON.stringify(bumpCount(getCounts(), slotKey()))); }
  function resetChatCount() { lsSet(LS_COUNT, JSON.stringify(resetCount(getCounts(), slotKey()))); }

  // The capability paragraph is appended to the system prompt as its own segment.
  function getInjection() {
    if (!isEnabled()) return "";
    return injectionFor(nsfwLevel());
  }

  // Base image: the image module wins; the local map is the fallback for a page without it.
  function getBaseImage(charId) {
    if (window.chatImageSvc && window.chatImageSvc.getBaseImage) {
      try { return Promise.resolve(window.chatImageSvc.getBaseImage({ characterId: charId })); } catch (e) {}
    }
    try {
      var o = JSON.parse(lsGet(LS_BASE, "{}"));
      return Promise.resolve((o && o[charId]) || null);
    } catch (e) { return Promise.resolve(null); }
  }
  function setBaseImage(charId, imageUrl) {
    if (window.chatImageSvc && window.chatImageSvc.setBaseImage) {
      try { return Promise.resolve(window.chatImageSvc.setBaseImage({ characterId: charId, imageUrl: imageUrl })); } catch (e) {}
    }
    try {
      var o = JSON.parse(lsGet(LS_BASE, "{}"));
      if (!o || typeof o !== "object") o = {};
      o[charId] = imageUrl;
      lsSet(LS_BASE, JSON.stringify(o));
    } catch (e) {}
    return Promise.resolve();
  }

  async function expandScene(scene, card, kind) {
    return kind === "scene" ? localExpandScene(scene) : localExpand(scene, card, nsfwLevel());
  }

  function callSendPhoto(charId, scenePrompt, baseImageUrl, kind) {
    if (window.chatImageSvc && window.chatImageSvc.sendPhoto) {
      return Promise.resolve(window.chatImageSvc.sendPhoto({ characterId: charId, scenePrompt: scenePrompt, baseImageUrl: baseImageUrl, kind: kind }));
    }
    return new Promise(function (resolve) {
      setTimeout(function () { resolve({ imageUrl: mockImage(scenePrompt), taskId: "mock-" + Date.now() }); }, 1500);
    });
  }

  function loadingHtml() {
    return '<div style="display:flex;align-items:center;gap:8px;opacity:.75;font-size:13px;"><span style="width:14px;height:14px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;display:inline-block;animation:ci-spin .8s linear infinite;"></span><span>正在发送图片…</span></div>';
  }

  function renderPhotoBubble(afterRow, card) {
    var chat = document.getElementById("chat");
    var spacer = document.getElementById("bottom-spacer");
    if (!chat) return null;
    ensureSpinCss();
    var row = document.createElement("div");
    row.className = "row ai chat-image-row";
    var avatar = document.createElement("div");
    avatar.className = "avatar bot";
    avatar.textContent = (card && card.icon) ? card.icon : "🙂";
    if (card && card.name) avatar.title = card.name;
    var content = document.createElement("div");
    content.className = "content";
    var meta = document.createElement("div");
    meta.className = "meta";
    if (card && card.name) meta.textContent = card.name;
    content.appendChild(meta);
    var bubble = document.createElement("div");
    bubble.className = "bubble ai chat-image-bubble";
    bubble.style.minWidth = "140px";
    bubble.innerHTML = loadingHtml();
    content.appendChild(bubble);
    row.appendChild(avatar);
    row.appendChild(content);
    try { if (window.characterSvc && window.characterSvc.decorateAiRow) window.characterSvc.decorateAiRow(row, card); } catch (e) {}
    if (afterRow && afterRow.parentNode === chat && afterRow.nextSibling) chat.insertBefore(row, afterRow.nextSibling);
    else if (spacer) chat.insertBefore(row, spacer);
    else chat.appendChild(row);
    scrollChat();
    return bubble;
  }

  function setBubbleImage(bubble, imageUrl) {
    if (!bubble) return;
    bubble.innerHTML = "";
    var img = document.createElement("img");
    img.src = imageUrl;
    img.alt = "AI 发来的照片";
    // A long conversation keeps every image decoded and resident; lazy/deferred keeps offscreen
    // photos cheap without changing what is on screen.
    try { img.loading = "lazy"; img.decoding = "async"; } catch (e) {}
    img.style.cssText = "max-width:220px;max-height:300px;border-radius:10px;display:block;cursor:zoom-in;";
    img.addEventListener("click", function () { window.open(imageUrl, "_blank"); });
    bubble.appendChild(img);
    scrollChat();
  }

  // A selfie with no base image is generated from the card alone, so say so instead of pretending.
  function setBubbleNotice(bubble, text) {
    if (!bubble) return;
    var n = document.createElement("div");
    n.className = "chat-image-notice";
    n.style.cssText = "margin-top:6px;font-size:11px;line-height:1.5;color:#b8860b;opacity:.9;max-width:220px;word-break:break-word;";
    n.textContent = "ⓘ " + text;
    bubble.appendChild(n);
    scrollChat();
  }

  function setBubbleError(bubble, retryFn, errMsg) {
    if (!bubble) return;
    bubble.innerHTML = "";
    var box = document.createElement("div");
    box.style.cssText = "display:flex;align-items:center;gap:8px;font-size:13px;color:#c66;flex-wrap:wrap;";
    var txt = document.createElement("span"); txt.textContent = "发送失败";
    var btn = document.createElement("button"); btn.textContent = "点重试"; btn.className = "smallbtn"; btn.style.cssText = "font-size:12px;padding:2px 8px;";
    btn.addEventListener("click", function () { if (retryFn) retryFn(); });
    box.appendChild(txt); box.appendChild(btn);
    var msg = errMsg && (errMsg.message || errMsg);
    if (msg) {
      var d = document.createElement("div");
      d.style.cssText = "width:100%;font-size:11px;opacity:.7;word-break:break-all;";
      d.textContent = String(msg);
      box.appendChild(d);
    }
    bubble.appendChild(box);
  }

  function ensureSpinCss() {
    if (document.getElementById("ci-spin-css")) return;
    var s = document.createElement("style"); s.id = "ci-spin-css";
    s.textContent = "@keyframes ci-spin{to{transform:rotate(360deg)}}";
    document.head.appendChild(s);
  }

  function scrollChat() {
    var hw = document.getElementById("history");
    if (hw) { try { hw.scrollTo({ top: hw.scrollHeight, behavior: "auto" }); } catch (e) { hw.scrollTop = hw.scrollHeight; } }
  }

  // Group orchestration and the fishbowl debate both run several characters in a row; the cooldown
  // would otherwise silence every one of them after the first.
  function inRapidMultiContext() {
    try { if (window.fishbowlSvc && window.fishbowlSvc.getMode && window.fishbowlSvc.getMode()) return true; } catch (e) {}
    try { if (window.multiSvc && window.multiSvc.isMulti && window.multiSvc.isMulti()) return true; } catch (e) {}
    return false;
  }

  // The main flow: a signal arrived, so produce the image. `manual` bypasses cooldown and cap.
  function handleSignal(opts) {
    var o = opts || {};
    var scene = o.scene;
    var card = o.card || (window.characterSvc && window.characterSvc.getActiveCard && window.characterSvc.getActiveCard()) || null;
    var afterRow = o.afterRow || null;
    var manual = !!o.manual;
    if (!scene) return;
    var kind = o.kind === "scene" ? "scene" : detectKind(scene);
    var now = Date.now();
    var allowed = shouldSend({
      enabled: isEnabled(),
      manual: manual,
      rapidMulti: inRapidMultiContext(),
      now: now,
      lastAt: parseInt(lsGet(LS_LAST_AT, "0"), 10) || 0,
      cooldownSec: cooldownSec(),
      cap: capPerChat(),
      count: chatCount()
    });
    if (!allowed) return;

    var charId = card && card.id ? card.id : "__none__";
    lsSet(LS_LAST_AT, String(Date.now()));
    if (!manual) bumpChatCount();

    var bubble = renderPhotoBubble(afterRow, card);
    var done = false, timer = null, timeoutMs = 30000, baseImg = null;

    function arm() {
      done = false;
      clearTimeout(timer);
      timer = setTimeout(function () {
        if (done) return;
        done = true;
        setBubbleError(bubble, retry, "出图超时(上游可能排队过久),点重试");
      }, timeoutMs);
    }
    function retry() { if (bubble) bubble.innerHTML = loadingHtml(); arm(); runSend(); }
    function runSend() {
      Promise.resolve(callSendPhoto(charId, o.scenePrompt || scene, baseImg || undefined, kind)).then(function (res) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        var url = res && res.imageUrl;
        if (url) {
          setBubbleImage(bubble, url);
          if (kind !== "scene" && !baseImg) {
            setBubbleNotice(bubble, "未设基准图:这张按角色卡即时生成,样貌可能和设定有出入。在设置「微信发图」卡上传基准图后,自拍会锁定长相。");
          }
        } else setBubbleError(bubble, retry, "出图无返回");
      }).catch(function (err) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        setBubbleError(bubble, retry, err);
      });
    }

    (kind === "scene" ? Promise.resolve(null) : Promise.resolve(getBaseImage(charId)).catch(function () { return null; }))
      .then(function (base) {
        baseImg = base;
        timeoutMs = timeoutFor(kind, !!base);
      })
      .then(function () { arm(); return expandScene(scene, card, kind); })
      .then(function (p) { o.scenePrompt = p; runSend(); })
      .catch(function () { o.scenePrompt = scene; runSend(); });
  }

  // One photo on demand, for the settings button.
  function requestManual(sceneText) {
    var scene = (sceneText && String(sceneText).trim()) || "随手自拍,自然表情";
    var rows = document.querySelectorAll("#chat .row.ai");
    var last = rows.length ? rows[rows.length - 1] : null;
    handleSignal({ scene: scene, afterRow: last, manual: true });
  }

  function mountCard() {
    // 2026-11-28 card-shell batch 2: shell + declareCard. The old mount probe sat on the inner
    // ciEnableToggle while the card element already carried id chatImageCard — declaring under the
    // card id moves the probe onto the card; the toggle/inputs keep their ids for wireSettings().
    window.slotRegistry.declareCard({
      id: "chatImageCard",
      slotId: "setImageChatSlot",
      build: function (slot) {
        var shell = window.cardShell.createCardShell({
          id: "chatImageCard",
          title: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="M4 17.5l5-5 3.2 3.2 3.2-3.8 4.1 5"/></svg>微信发图',
          desc: '开启后 AI 会在合适时机往对话里"发"照片——自拍走基准图改图、场景/物品/宠物走文生图。消耗图像额度,<b>仅本设备</b>。',
          extra: '<div class="rowline"><div class="toggle"><input type="checkbox" id="ciEnableToggle"><label for="ciEnableToggle">启用微信发图</label></div><div class="btns"><button class="smallbtn" id="ciManualBtn">手动来一张</button></div></div>'
            + '<div class="settings-grid-2"><label><span>冷却(秒)</span><input type="number" id="ciCooldown" min="0" max="600"></label><label><span>每会话上限</span><input type="number" id="ciCap" min="0" max="99"></label></div>'
            + '<div class="rowline" style="align-items:center;gap:10px;margin-top:10px;"><div style="font-size:12px;color:var(--muted);flex:1;min-width:0;">当前角色基准图</div><div class="btns"><button class="smallbtn" id="ciBasePick" type="button">选择图片…</button></div><input type="file" id="ciBaseUpload" accept="image/*" style="display:none;"></div>'
            + '<div id="ciBaseStatus" style="font-size:11px;color:var(--muted);margin-top:8px;"></div>',
          tip: '每会话上限填 0 = 不限;冷却填 0 = 不限频。基准图用于"自拍"类发图把脸固定下来,场景/物品图不用基准图。'
        });
        slot.appendChild(shell.card);
        wireSettings();
        return shell.card;
      }
    });
  }

  function wireSettings() {
    var en = document.getElementById("ciEnableToggle");
    if (en) { en.checked = isEnabled(); en.addEventListener("change", function () { lsSet(LS_ENABLED, en.checked ? "1" : "0"); }); }
    var cd = document.getElementById("ciCooldown");
    if (cd) { cd.value = cooldownSec(); cd.addEventListener("change", function () { lsSet(LS_COOLDOWN, String(parseInt(cd.value, 10) || DEFAULT_COOLDOWN)); }); }
    var cap = document.getElementById("ciCap");
    if (cap) { cap.value = capPerChat(); cap.addEventListener("change", function () { lsSet(LS_CAP, String(parseInt(cap.value, 10) || 0)); }); }
    var up = document.getElementById("ciBaseUpload");
    var pick = document.getElementById("ciBasePick");
    if (pick && up) pick.addEventListener("click", function () { up.click(); });
    if (up) up.addEventListener("change", function () {
      var f = up.files && up.files[0];
      if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        var charId = slotKey();
        setBaseImage(charId, rd.result);
        var st = document.getElementById("ciBaseStatus");
        if (st) st.textContent = "✓ 已为当前角色(" + charId + ")设置基准图";
      };
      rd.readAsDataURL(f);
      up.value = "";
    });
    var mq = document.getElementById("ciManualBtn");
    if (mq) mq.addEventListener("click", function () { requestManual(""); });
  }

  window.chatImageTextSvc = {
    getInjection: getInjection,
    extractSignal: extractSignal,
    stripSignalForDisplay: stripSignalForDisplay,
    handleSignal: handleSignal,
    requestManual: requestManual,
    getBaseImage: getBaseImage,
    setBaseImage: setBaseImage,
    isEnabled: isEnabled,
    resetChatCount: resetChatCount,
    _mock: mockImage
  };

  function _init() { mountCard(); }
  if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", _init);
  else _init();
})();

globalThis.LS_ENABLED = LS_ENABLED;
globalThis.LS_COOLDOWN = LS_COOLDOWN;
globalThis.LS_CAP = LS_CAP;
globalThis.LS_BASE = LS_BASE;
globalThis.LS_LAST_AT = LS_LAST_AT;
globalThis.LS_COUNT = LS_COUNT;
globalThis.NSFW_KEY = NSFW_KEY;
globalThis.DEFAULT_COOLDOWN = DEFAULT_COOLDOWN;
globalThis.DEFAULT_CAP = DEFAULT_CAP;
globalThis.parseCooldown = parseCooldown;
globalThis.parseCap = parseCap;
globalThis.nsfwLevelOf = nsfwLevelOf;
globalThis.countOf = countOf;
globalThis.bumpCount = bumpCount;
globalThis.resetCount = resetCount;
globalThis.shouldSend = shouldSend;
globalThis.injectionFor = injectionFor;
globalThis.parseStructured = parseStructured;
globalThis.structuredToScene = structuredToScene;
globalThis.structuredKind = structuredKind;
globalThis.looksLikeScene = looksLikeScene;
globalThis.detectKind = detectKind;
globalThis.extractSignal = extractSignal;
globalThis.stripSignalForDisplay = stripSignalForDisplay;
globalThis.localExpand = localExpand;
globalThis.localExpandScene = localExpandScene;
globalThis.mockImage = mockImage;
globalThis.timeoutFor = timeoutFor;
})();
