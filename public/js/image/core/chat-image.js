// public/js/image/core/chat-image.js — 微信发图 · 文本侧编排 (raw / 可独立测试版)
// 配合图像侧 window.__chatImage 契约 (sendPhoto/setBaseImage/getBaseImage)。
// 契约未上线时走内置 mock(SVG 占位图),整条链路可独立测。
// 红线:不碰图像侧文件;不动核心人格 prompt —— 发图指令仅走独立注入层(追加在 extraSystemPrompts 末尾)。
(function () {
  "use strict";

  // ─── LS keys(全部 cfw_ 前缀 _v1 后缀;仅本机,不进云同步)───
  var LS_ENABLED  = "cfw_chat_image_enabled_v1";   // 功能总开关(默认开)
  var LS_COOLDOWN = "cfw_chat_image_cooldown_v1";  // 软冷却秒(默认20)
  var LS_CAP      = "cfw_chat_image_cap_v1";       // 每会话上限(默认0=不限;>0 才计数封顶)
  var LS_BASE     = "cfw_chat_base_v1";            // 4.78: 与图像侧 image-chat.js 统一同一 key(消除双 key 漂移) {charId:dataURL}
  var LS_LASTAT   = "cfw_chat_image_lastat_v1";    // 上次发图时间戳
  var LS_COUNT    = "cfw_chat_image_count_v1";     // {slotKey:count} 每会话计数

  var SIGNAL_RE = /[\[【]{1,2}\s*(发?图|发?景|风景|发)\s*[:：]([^\]】\n]*)[\]】]{0,2}/g;  // [[发图:..]]/[发图:..]/[图:..]/【发图：..】 变体 + 半截信号都吃
  // 4.69 结构化信号(优先): [[img|kind=自拍/场景|主体=…|动作=…|场景=…]] —— 字段化,前端组装成画面描述,向后兼容下面的旧格式
  var STRUCTURED_RE = /\[{1,2}\s*img\s*\|([^\[\]\n]*)\]{1,2}/gi;  // 4.72 容错:左右各容忍 1~2 个方括号(模型少写一个括号时也能识别/剥离,不再漏进聊天)
  // 4.54: 模型"没按格式"忘了括号时的兜底——裸 发图:/发景: 也认(必须带冒号,避免误伤"我发图给你"这类无冒号正文)
  // 4.63 修「正文缺字漏字」: 收紧为仅在行首(可带前导空白)才认裸信号,与「单独成行」一致,不再吞掉句中正文
  var SIGNAL_RE_BARE = /(?:^|\n)[ \t　]*(发图|发景)\s*[:：][ \t　]*([^\n\]】]*)/g;

  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function isEnabled() { return lsGet(LS_ENABLED, "1") === "1"; }
  function cooldownSec() { var n = parseInt(lsGet(LS_COOLDOWN, "20"), 10); return isNaN(n) ? 20 : Math.max(0, n); }
  function capPerChat() { var n = parseInt(lsGet(LS_CAP, "0"), 10); return isNaN(n) ? 0 : Math.max(0, n); }  // 4.78: 默认 0=不限,根除"发满 N 张后永久不发"(Bug⑥)
  
  function slotKey() {
    try { var c = window.__character && window.__character.getActiveCard && window.__character.getActiveCard(); return c && c.id ? c.id : "__none__"; } catch (e) { return "__none__"; }
  }
  function getCounts() { try { var o = JSON.parse(lsGet(LS_COUNT, "{}")); return (o && typeof o === "object") ? o : {}; } catch (e) { return {}; } }
  function chatCount() { return getCounts()[slotKey()] || 0; }
  function bumpCount() { var o = getCounts(); o[slotKey()] = (o[slotKey()] || 0) + 1; lsSet(LS_COUNT, JSON.stringify(o)); }
  function resetCount() { var o = getCounts(); o[slotKey()] = 0; lsSet(LS_COUNT, JSON.stringify(o)); }

  // ─── 独立注入层:发图能力指令,追加到核心 prompt 之后(经 extraSystemPrompts)───
  function getInjection() {
    if (!isEnabled()) return "";
    var base = "\n\n【发图能力】你可以发图,但必须严格按结构化格式输出,否则系统识别不了会把指令漏给用户看(很糟糕):\n· 发图信号必须单独成行、放在正文之后(群聊里若还要交棒,放在交棒标记 [next:对方名字] 的前面),格式:\n  [[img|kind=自拍|主体=…|动作=…|场景=…]]\n  · kind:自拍=图里有你本人出镜(自拍/合照/展示样子/穿搭/表情);场景=图里没有你,是你眼前的东西(游戏/聊天/手机截图、风景、食物外卖、宠物、买到的物品等)。\n  · 主体:画面主角是谁/什么;动作:姿态或正在做的事;场景:环境/光线/氛围。\n  · 判断口诀:只要图的主角不是你本人(游戏截图/风景/外卖/猫猫…),kind 一律写 场景,用错会把你的脸 P 进画面。\n· 竖线 | 和字段名一个都不能少,用半角等号 = 连接;字段值里别再用 | 或 ] 字符。信号前面正常说你的话。\n· 【重要】当用户明确叫你发照片/自拍/看看你长什么样/发图给他时,你必须真的输出发图信号,不能只用文字「我发了一张…」搪塞。\n· 不需要发图时完全不要输出信号。\n· (兼容:旧的 [发图:画面描述] / [发景:画面描述] 仍能识别,但请优先用上面的结构化格式。)";
        return base;
  }

  // 4.69: 结构化信号字段解析 [[img|kind=…|主体=…|动作=…|场景=…]]
  function parseStructured(inner) {
    var f = {};
    String(inner || "").split("|").forEach(function (part) {
      var idx = part.indexOf("=");
      if (idx < 0) { var fv = part.trim(); if (fv && !f._free) f._free = fv; return; }
      var k = part.slice(0, idx).trim().toLowerCase();
      var v = part.slice(idx + 1).trim();
      if (k && v) f[k] = v;
    });
    return f;
  }
  function structuredToScene(f) {
    var subj = f["主体"] || f["subject"] || f["who"] || "";
    var act  = f["动作"] || f["action"] || f["pose"] || "";
    var env  = f["场景"] || f["scene"] || f["背景"] || f["env"] || f["setting"] || "";
    var parts = [subj, act, env].filter(Boolean);
    var s = parts.join("，");
    if (!s && f._free) s = f._free;
    return s;
  }
  function structuredKind(f, scene) {
    var t = (f["kind"] || f["类型"] || f["type"] || "").toLowerCase();
    if (/景|scene|环境|物|食|宠|截图|风景/.test(t)) return "scene";
    if (/自拍|selfie|人|本人|出镜|portrait|肖像/.test(t)) return "selfie";
    return detectKind(scene);
  }

  // ─── 从 AI 完整回复抠出发图信号 + 返回清理后的正文(取最后一个信号;4.69 结构化优先)───
  function extractSignal(text) {
    if (!text || typeof text !== "string") return { scene: null, kind: null, clean: text };
    STRUCTURED_RE.lastIndex = 0;
    var scene = null, kind = null, m;
    while ((m = STRUCTURED_RE.exec(text)) !== null) {
      var f = parseStructured(m[1]);
      var s = structuredToScene(f);
      if (s) { scene = s; kind = structuredKind(f, s); }
    }
    if (scene == null) {
      SIGNAL_RE.lastIndex = 0;
      while ((m = SIGNAL_RE.exec(text)) !== null) { scene = (m[2] || "").trim(); kind = /景/.test(m[1] || "") ? "scene" : "selfie"; }
    }
    if (scene == null) {
      // 4.54 兜底:模型忘了括号,认行首裸 发图:/发景:
      SIGNAL_RE_BARE.lastIndex = 0;
      while ((m = SIGNAL_RE_BARE.exec(text)) !== null) { scene = (m[2] || "").trim(); kind = /景/.test(m[1] || "") ? "scene" : "selfie"; }
    }
    if (scene == null) return { scene: null, kind: null, clean: text };
    var clean = text.replace(STRUCTURED_RE, "").replace(SIGNAL_RE, "").replace(SIGNAL_RE_BARE, "").replace(/[\s\r\n|]+$/, "");
    return { scene: scene, kind: kind, clean: clean };
  }
  // 双管齐下分流: 显式 [发景:] → scene; [发图:]/缺省 按关键词再判,明显"本人不出镜"的画面(截图/游戏/风景/物品/食物/宠物…)纠偏成 scene
  // 强场景特征:这些图里没有角色本人,必须走文生图(scene),不能拿基准图改图(否则会把脸 P 进游戏截图——用户实测 bug)
  function looksLikeScene(scene) {
    var s = String(scene || "");
    return /截图|屏幕|界面|游戏|对局|战绩|聊天记录|消息|网页|视频|game|screenshot|screen|外卖|美食|食物|菜|饭|奶茶|咖啡|蛋糕|甜点|food|meal|宠物|猫|狗|小猫|小狗|cat|dog|pet|物品|东西|商品|包裹|快递|礼物|手办|盲盒|桌面|书|杂志|花|植物|风景|景色|景观|场景|环境|窗外|外面|远处|天空|夜景|海边|海滩|沙滩|街道|城市|马路|山|湖|河|森林|田野|雪景|夕阳|日落|日出|星空|烟花|花海|庭院|建筑|商场|房间|装修|landscape|scenery|environment|sky|street|city|sunset|view/i.test(s);
  }
  function detectKind(scene) {
    var s = String(scene || "");
    if (/自拍|合照|selfie|我的脸|我的样子|看看我|我穿|我的表情|我的新|我今天|肖像|portrait/i.test(s)) return "selfie";
    if (looksLikeScene(s)) return "scene";
    return "selfie";
  }

  // ─── 流式显示用:实时剥离发图信号(含网卡截断的半截信号),像 <think> 思考块一样不让它出现在气泡里 ───
  function stripSignalForDisplay(text) {
    if (!text || typeof text !== "string") return text;
    // 4.69: 先剥结构化信号(完整 + 流式半截)
    STRUCTURED_RE.lastIndex = 0;
    var s = text.replace(STRUCTURED_RE, "");
    s = s.replace(/\[{1,2}\s*img\s*\|[^\]\n]*$/i, "");
    SIGNAL_RE.lastIndex = 0;
    s = s.replace(SIGNAL_RE, "");
    // 兜底:流式/网卡只吐出半截开头(如 "[发图:客厅" / "[图:" / "[图"),冒号可缺,一律砍到结尾
    // 4.70 去掉裸「发」分支:避免把 "[发火…" / "[发现…" 这类正文行尾误砍;半截信号仍认 图/景/风景
    s = s.replace(/[\[【]{1,2}\s*(发?图|发?景|风景)\s*[:：]?[^\]】\n]*$/g, "");
    // 4.54 兜底:无括号的 发图:/发景: 也砍掉(行首,避免误伤"发图书馆"等正文)
    s = s.replace(SIGNAL_RE_BARE, "");
    return s.replace(/[\s\r\n|]+$/, "");
  }

  // ─── 基准图存取(优先图像侧契约,缺省走本地兜底)───
  function getBaseImage(charId) {
    if (window.__chatImage && window.__chatImage.getBaseImage) {
      try { return Promise.resolve(window.__chatImage.getBaseImage({ characterId: charId })); } catch (e) {}
    }
    try { var o = JSON.parse(lsGet(LS_BASE, "{}")); return Promise.resolve((o && o[charId]) || null); } catch (e) { return Promise.resolve(null); }
  }
  function setBaseImage(charId, imageUrl) {
    if (window.__chatImage && window.__chatImage.setBaseImage) {
      try { return Promise.resolve(window.__chatImage.setBaseImage({ characterId: charId, imageUrl: imageUrl })); } catch (e) {}
    }
    try { var o = JSON.parse(lsGet(LS_BASE, "{}")); if (!o || typeof o !== "object") o = {}; o[charId] = imageUrl; lsSet(LS_BASE, JSON.stringify(o)); } catch (e) {}
    return Promise.resolve();
  }

  // ─── 扩写编排(gpt-oss-120b 免费扩写;失败或独立测试时回退本地模板)───
  function pickFreeModel() {
    // 4.72 §十.A: 优先跟随设置里的扩写器模型(LS cfw_expander_model_v1);留空则沿用自动探测 gpt-oss
    try { var pref = lsGet('cfw_expander_model_v1', ''); if (pref) return pref; } catch (e) {}
    try { var list = window.APP_MODELS_FREE || []; for (var i = 0; i < list.length; i++) { if ((list[i].id || '').indexOf('gpt-oss') >= 0) return list[i].id; } } catch (e) {}
    return 'openai/gpt-oss-120b';
  }
  var EXPAND_SYS = 'You are an image-prompt engineer for an instruction-based image-edit model that keeps the SAME person from a base selfie. Given a short Chinese scene note, output ONE single-line English description of pose, facial expression, outfit, location/background, lighting, mood, and a camera framing that fits the scene (close selfie, full-body, or wide environmental shot as appropriate). Do NOT describe face or identity (the base photo fixes those). Output ONLY the description, no quotes.';
  function localExpand(scene, card) {
    var name = (card && card.name) ? card.name : "角色";
    var parts = [];
    var subj = "一张" + name + "的自拍照";
    if (card && card.identity) subj += "，" + String(card.identity).slice(0, 100);
    else if (card && card.personality) subj += "，气质:" + String(card.personality).slice(0, 60);
    if (card && card.gender) subj += "，" + card.gender;
    if (card && card.age) subj += "，" + card.age + "岁";
    parts.push(subj);
    parts.push("画面:" + scene);
    parts.push("写实、自然光、手机自拍视角、清晰");
    return Promise.resolve(parts.join("，") + "。");
  }
  var EXPAND_SYS_SCENE = 'You are an image-prompt engineer for a natural-language text-to-image model. The Chinese note says what a character is currently looking at or showing — it may be a PET (cat/dog), food/takeout, an object/product, a game or phone screenshot, OR scenery. Output ONE single-line Chinese description that keeps the MAIN SUBJECT from the note as the clear, central focus (a cat stays a cat, food stays food, a screenshot stays a screenshot — never silently turn it into an empty room or landscape), then add its immediate setting, lighting, mood and color tone. The picture has NO people: do NOT describe any person or face. Output ONLY the description, no quotes.';
  function localExpandScene(scene) {
    return Promise.resolve("一张实景照片。画面:" + scene + "。聚焦环境与氛围、没有人物、自然真实的光线、清晰。");
  }

  // ─── 出图(优先契约,缺省 mock)───
  // expander: free gpt-oss-120b expands the Chinese 发图 signal into an English selfie-scene description; falls back to local template on failure / standalone.
  async function expandScene(scene, card, kind) {
    var isScene = kind === 'scene';
    var fallback = isScene ? localExpandScene(scene) : localExpand(scene, card);
    try {
      var note = scene;
      if (!isScene && card) { var cap = function (x) { x = String(x || ''); return x.length > 200 ? x.slice(0, 200) : x; }; var c = []; if (card.name) c.push('role:' + cap(card.name)); if (card.identity) c.push('identity:' + cap(card.identity)); if (card.personality) c.push('persona:' + cap(card.personality)); if (c.length) note = c.join(', ') + ' / scene:' + scene; }
      var res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'free', model: pickFreeModel(), promptProfile: 'assist', use_builtin_persona: false, custom_system_prompt: isScene ? EXPAND_SYS_SCENE : EXPAND_SYS, replyStyle: 'default', messages: [{ role: 'user', content: note }] }) });
      if (!res.ok) return fallback;
      var reader = res.body.getReader(), dec = new TextDecoder(), out = '';
      while (true) { var stp = await reader.read(); if (stp.done) break; var lines = dec.decode(stp.value, { stream: true }).split('\n'); for (var i = 0; i < lines.length; i++) { var ln = lines[i]; if (ln.indexOf('data: ') !== 0) continue; var ss = ln.slice(6).trim(); if (!ss || ss === '[DONE]') continue; try { var pj = JSON.parse(ss); var d = pj.choices && pj.choices[0] && pj.choices[0].delta && pj.choices[0].delta.content; if (d) out += d; } catch (e) {} } }
      out = out.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
      return out || fallback;
    } catch (e) { return fallback; }
  }
  function callSendPhoto(charId, scenePrompt, baseImageUrl, kind) {
    if (window.__chatImage && window.__chatImage.sendPhoto) {
      return Promise.resolve(window.__chatImage.sendPhoto({ characterId: charId, scenePrompt: scenePrompt, baseImageUrl: baseImageUrl, kind: kind }));
    }
    return new Promise(function (resolve) {
      setTimeout(function () { resolve({ imageUrl: mockImage(scenePrompt), taskId: "mock-" + Date.now() }); }, 1500);
    });
  }
  function mockImage(text) {
    var t = String(text || "");
    var lines = [], i = 0;
    while (i < t.length && lines.length < 7) { lines.push(t.slice(i, i + 16)); i += 16; }
    var esc = function (s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); };
    var tspans = lines.map(function (ln, k) { return '<tspan x="160" dy="' + (k === 0 ? 0 : 22) + '">' + esc(ln) + '</tspan>'; }).join("");
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="400">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#587a9d"/><stop offset="1" stop-color="#8fb2d4"/></linearGradient></defs>' +
      '<rect width="320" height="400" fill="url(#g)"/>' +
      '<text x="160" y="46" fill="#fff" font-size="15" text-anchor="middle" opacity="0.9">📷 模拟出图 (mock)</text>' +
      '<text x="160" y="150" fill="#fff" font-size="13" text-anchor="middle" opacity="0.95">' + tspans + '</text>' +
      '</svg>';
    return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
  }

  // ─── 图片气泡(占位 → 替换),挂在触发的 AI row 之后 ───
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
    try { if (window.__character && window.__character.decorateAiRow) window.__character.decorateAiRow(row, card); } catch (e) {}
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
    // 2026-10-08 内存:聊天 DOM 不虚拟化,长会话里每张图都会被解码并常驻 —— 屏外图先不加载/不解码
    // （与 fx 开关无关的成本项，见"重启壳→基线→用一阵→看任务管理器"的对照协议）。
    try { img.loading = "lazy"; img.decoding = "async"; } catch (e) {}
    img.style.cssText = "max-width:220px;max-height:300px;border-radius:10px;display:block;cursor:zoom-in;";
    img.addEventListener("click", function () { window.open(imageUrl, "_blank"); });
    bubble.appendChild(img);
    scrollChat();
  }
  // 4.78 Bug②⑤: 自拍类发图但没有基准图时,在图下方给一句显式提示(基准图零参与,样貌靠文生图即时生成,而非静默)
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
    if (msg) { var d = document.createElement("div"); d.style.cssText = "width:100%;font-size:11px;opacity:.7;word-break:break-all;"; d.textContent = String(msg); box.appendChild(d); }
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

  // ─── 多智能体连续接力场景检测(群聊 orchestrate / fishbowl 讨论・接力・斗图)───
  function inRapidMultiContext() {
    try { if (window.__fishbowl && window.__fishbowl.getMode && window.__fishbowl.getMode()) return true; } catch (e) {}
    try { if (window.__multi && window.__multi.isMulti && window.__multi.isMulti()) return true; } catch (e) {}
    return false;
  }

  // ─── 主流程:收到发图信号后编排出图。manual=true 绕过冷却/上限(用户手动叫)───
  function handleSignal(opts) {
    opts = opts || {};
    var scene = opts.scene;
    var card = opts.card || (window.__character && window.__character.getActiveCard && window.__character.getActiveCard()) || null;
    var afterRow = opts.afterRow || null;
    var manual = !!opts.manual;
    if (!scene) return;
    var kind = opts.kind === 'scene' ? 'scene' : detectKind(scene);
    if (!isEnabled() && !manual) return;
    if (!manual) {
      var rapidMulti = inRapidMultiContext();
      if (!rapidMulti) {
        var now = Date.now();
        var last = parseInt(lsGet(LS_LASTAT, "0"), 10) || 0;
        if (cooldownSec() > 0 && now - last < cooldownSec() * 1000) return;
      }
      if (capPerChat() > 0 && chatCount() >= capPerChat()) return;
    }
    var charId = card && card.id ? card.id : "__none__";
    lsSet(LS_LASTAT, String(Date.now()));
    if (!manual) bumpCount();

    var bubble = renderPhotoBubble(afterRow, card);
    var done = false, timer = null, timeoutMs = 30000, baseImg = null;

    function arm() { done = false; clearTimeout(timer); timer = setTimeout(function () { if (done) return; done = true; setBubbleError(bubble, retry, "出图超时(上游可能排队过久),点重试"); }, timeoutMs); }
    function retry() { if (bubble) bubble.innerHTML = loadingHtml(); arm(); runSend(); }
    function runSend() {
      Promise.resolve(callSendPhoto(charId, opts.scenePrompt || scene, baseImg || undefined, kind)).then(function (res) {
        if (done) return; done = true; clearTimeout(timer);
        var url = res && res.imageUrl;
        if (url) {
          setBubbleImage(bubble, url);
          // 4.78 Bug②⑤: 自拍但无基准图 → 走纯文生图,基准图零参与,显式告知用户而非静默
          if (kind !== "scene" && !baseImg) setBubbleNotice(bubble, "未设基准图:这张按角色卡即时生成,样貌可能和设定有出入。在设置「微信发图」卡上传基准图后,自拍会锁定长相。");
        } else setBubbleError(bubble, retry, "出图无返回");
      }).catch(function (err) {
        if (done) return; done = true; clearTimeout(timer); setBubbleError(bubble, retry, err);
      });
    }
    (kind === 'scene' ? Promise.resolve(null) : Promise.resolve(getBaseImage(charId)).catch(function () { return null; })).then(function (base) {
      baseImg = base; timeoutMs = (kind === 'scene') ? 120000 : (base ? 180000 : 300000);
    }).then(function () {
      arm();
      return expandScene(scene, card, kind);
    }).then(function (p) { opts.scenePrompt = p; runSend(); })
      .catch(function () { opts.scenePrompt = scene; runSend(); });
  }

  // 手动叫一张图(给 Settings 按钮用)
  function requestManual(sceneText) {
    var scene = (sceneText && String(sceneText).trim()) || "随手自拍,自然表情";
    var rows = document.querySelectorAll("#chat .row.ai");
    var last = rows.length ? rows[rows.length - 1] : null;
    handleSignal({ scene: scene, afterRow: last, manual: true });
  }

  // ─── 4.71: 自挂载发图设置卡(从 index.html 收口) ───
  // index.html 仅保留 <div id="setImageChatSlot"></div> 空槽(图像分类、#settingsImageSlot 之前)。
  // 槽不存在 / 已有 #ciEnableToggle(静态卡还在)时静默跳过,兼容尚未改 index.html 的旧页面。
  function mountCard() {
    var slot = document.getElementById("setImageChatSlot");
    if (!slot || document.getElementById("ciEnableToggle")) return;
    var card = document.createElement("div");
    card.className = "card";
    card.id = "chatImageCard";
    card.innerHTML = '<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="M4 17.5l5-5 3.2 3.2 3.2-3.8 4.1 5"/></svg>微信发图（AI 主动发照片）</h4>'
      + '<p>开启后 AI 会在合适时机往对话里"发"照片——自拍走基准图改图、场景/物品/宠物走文生图。消耗图像额度,<b>仅本设备</b>。</p>'
      + '<div class="rowline"><div class="toggle"><input type="checkbox" id="ciEnableToggle"><label for="ciEnableToggle">启用微信发图</label></div><div class="btns"><button class="smallbtn" id="ciManualBtn">手动来一张</button></div></div>'
      // 2026-10-04 排版梳理: 冷却/上限改用 .settings-grid-2 两列表单(与定价/生成参数卡同款,标签对齐字段等宽);
      // 基准图原生的「选择文件」按钮丑且与面板按钮语言不符 → 藏掉 input,换成 smallbtn「选择图片…」触发
      + '<div class="settings-grid-2"><label><span>冷却(秒)</span><input type="number" id="ciCooldown" min="0" max="600"></label><label><span>每会话上限</span><input type="number" id="ciCap" min="0" max="99"></label></div>'
      + '<div class="rowline" style="align-items:center;gap:10px;margin-top:10px;"><div style="font-size:12px;color:var(--muted);flex:1;min-width:0;">当前角色基准图</div><div class="btns"><button class="smallbtn" id="ciBasePick" type="button">选择图片…</button></div><input type="file" id="ciBaseUpload" accept="image/*" style="display:none;"></div>'
      + '<div id="ciBaseStatus" style="font-size:11px;color:var(--muted);margin-top:8px;"></div>'
      + '<div class="settings-tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg><span>每会话上限填 0 = 不限;冷却填 0 = 不限频。基准图用于"自拍"类发图把脸固定下来,场景/物品图不用基准图。</span></div>';
    slot.appendChild(card);
  }

  // ─── Settings 卡 wiring(#chatImageCard 内的控件)───
  function wireSettings() {
    var en = document.getElementById("ciEnableToggle");
    if (en) { en.checked = isEnabled(); en.addEventListener("change", function () { lsSet(LS_ENABLED, en.checked ? "1" : "0"); }); }
    var cd = document.getElementById("ciCooldown");
    if (cd) { cd.value = cooldownSec(); cd.addEventListener("change", function () { lsSet(LS_COOLDOWN, String(parseInt(cd.value, 10) || 20)); }); }
    var cap = document.getElementById("ciCap");
    if (cap) { cap.value = capPerChat(); cap.addEventListener("change", function () { lsSet(LS_CAP, String(parseInt(cap.value, 10) || 0)); }); }
    var up = document.getElementById("ciBaseUpload");
    var pick = document.getElementById("ciBasePick");
    if (pick && up) pick.addEventListener("click", function () { up.click(); });
    if (up) up.addEventListener("change", function () {
      var f = up.files && up.files[0]; if (!f) return;
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

  window.__chatImageText = {
    getInjection: getInjection,
    extractSignal: extractSignal,
    stripSignalForDisplay: stripSignalForDisplay,
    handleSignal: handleSignal,
    requestManual: requestManual,
    getBaseImage: getBaseImage,
    setBaseImage: setBaseImage,
    isEnabled: isEnabled,
    resetChatCount: resetCount,
    _mock: mockImage,
  };

  function _init() { mountCard(); wireSettings(); }
  if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", _init);
  else _init();
})();