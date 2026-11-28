(function () {
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

                                              

const LS_MODE = "cfw_quick_llm_mode_v1";
const LS_IMG                            = {
  character: "cfw_image_char_v1",
  scene: "cfw_image_scene_v1"
};

const DEFAULT_FREE_MODEL = "openai/gpt-oss-120b";
const DEFAULT_FAST_MODEL = "deepseek-ai/deepseek-v4-pro";

const SYS                         = {
  character:
    "You are an expert prompt engineer for a natural-language text-to-image model (z-image / Qwen, distilled). It understands flowing descriptive sentences, NOT booru tag soup, and does NOT support negative prompts. Given a Chinese roleplay character profile, output ONE cohesive Chinese descriptive sentence of the character appearance: 半身构图、性别与气质、发型发色、眼睛、服饰、表情与姿态，并附一句简短的环境与柔和打光。全部用正向自然语言描述，不要用逗号堆砸标签，不要出现 masterpiece / best quality / 1girl 这类 tag。只输出这句提示词本身，不要解释。",
  scene:
    "You are an expert prompt engineer for a natural-language text-to-image model (z-image / Qwen). Given recent Chinese roleplay context, output ONE cohesive Chinese descriptive sentence depicting the current SCENE/environment: 地点、时间与光线、天气氛围、关键陈设与整体色调。聚焦环境而非人物面孔，必要时可写画面中没有人物。用正向自然语言描述，不要标签堆砸，不要出现 masterpiece / scenery 这类 tag。只输出这句提示词本身，不要解释。",
  edit:
    "You translate a casual Chinese edit request for an existing image into ONE concise explicit editing instruction for an instruction-based image-edit model. 用自然语言说清楚要改什么、并保持其他部分不变。只输出这条指令本身，不要解释。"
};

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

/** Gender words arrive in both English and Chinese; only the two obvious buckets are separated. */
function genderWord(v         )         {
  const g = str(v);
  if (g === "male" || /男/.test(g)) return "男";
  if (g === "female" || /女/.test(g)) return "女";
  return g;
}

/** The card as the text model sees it: labelled lines, empty fields omitted. */
function cardToText(card         )         {
  if (!card) return "一个角色";
  const c = recOf(card);
  const parts           = [];
  if (c.name) parts.push("姓名:" + String(c.name));
  if (c.gender) parts.push("性别:" + genderWord(c.gender));
  if (c.identity) parts.push("身份:" + String(c.identity));
  if (c.personality) parts.push("性格:" + String(c.personality));
  if (c.speakingStyle) parts.push("说话风格:" + String(c.speakingStyle));
  if (c.openingLine) parts.push("开场白:" + String(c.openingLine));
  return parts.join("\n");
}

/** Local fallback for the character prompt; used verbatim when the text side fails. */
function tplCharacter(card         )         {
  const c = recOf(card);
  let subject = "一位角色";
  const g = str(c.gender);
  if (g === "female" || /女/.test(g)) subject = "一位女性角色";
  else if (g === "male" || /男/.test(g)) subject = "一位男性角色";
  const parts           = ["半身肖像，" + subject + "，单人，正面面向镜头"];
  if (c.age) parts.push("角色年龄：" + String(c.age).trim());
  if (c.identity) parts.push("身份与背景：" + String(c.identity));
  if (c.personality) parts.push("气质性格：" + String(c.personality));
  parts.push("柔和自然的打光，干净简洁的背景，精致的五官与有神的眼睛，构图均衡");
  parts.push("整体高品质、细节丰富、清晰锐利");
  return parts.filter(Boolean).join("，") + "。";
}

/** Local fallback for the scene prompt; the context is collapsed and capped before it is embedded. */
function tplScene(sceneText         )         {
  const s = String(sceneText || "一个安静的室内场景").replace(/\s+/g, " ").slice(0, 200);
  return "一幅场景画面，描绘当前剧情发生的环境：" + s + "。画面聚焦环境与氛围，没有人物特写，柔和自然的光线，统一的色调，细节丰富、清晰锐利。";
}

/**
 * Art style as a leading sentence. The trailing punctuation of the content is dropped first so the
 * joined prompt does not end up with "……。。".
 */
function withStyle(prompt         , styleTags        )         {
  const p = str(prompt);
  const st = str(styleTags);
  if (!st) return p;
  const base = p.replace(/[。.\s]+$/, "");
  return "画风（务必严格遵循）：" + st + "。画面内容：" + base + "。";
}

/** Free-mode model: first `gpt-oss` entry in the injected list, else the built-in default. */
function pickFreeModel(models         )         {
  const list = Array.isArray(models) ? models : [];
  for (const item of list) {
    const id = str(recOf(item).id);
    if (id.indexOf("gpt-oss") >= 0) return id;
  }
  return DEFAULT_FREE_MODEL;
}

/** Paid fast mode has one configured default; the caller passes whatever the config injected. */
function pickFastModel(configured         )         {
  return str(configured) || DEFAULT_FAST_MODEL;
}

/**
 * Request body for the prompt engine. `use_builtin_persona: false` matters: the built-in persona
 * would rewrite the answer in character, and this needs the raw prompt sentence.
 */
function buildChatBody(kind        , userText        , mode        , model        )                          {
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
function appendSse(text        , chunk        )         {
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
function cleanPrompt(out         )         {
  return str(out).trim().replace(/^["'`]+|["'`]+$/g, "").trim();
}

                               
                                      
                                            
                                
 

                                
                        
     
                                                                                                 
                                                                               
     
                                                      
                                                                         
                      
                                                                                          
                         
                        
 

                           
                 
                           
                                     
                                                   
                                        
                                                                                   
                                                        
                                 
 

function createQuickgen(ports               )           {
  function mode()         {
    try {
      return ports.storage.getItem(LS_MODE) || "free";
    } catch (e) {
      return "free";
    }
  }

  function setMode(m        )       {
    try {
      ports.storage.setItem(LS_MODE, m);
    } catch (e) {}
  }

  function lastImage(kind           )         {
    try {
      return ports.storage.getItem(LS_IMG[kind]) || "";
    } catch (e) {
      return "";
    }
  }

  function setLastImage(kind           , url        )       {
    try {
      ports.storage.setItem(LS_IMG[kind], url);
    } catch (e) {}
  }

  function clearLastImage(kind           )       {
    try {
      ports.storage.removeItem(LS_IMG[kind]);
    } catch (e) {}
  }

  function styled(prompt        )         {
    return withStyle(prompt, ports.styleTags());
  }

  /** Ask, and fall back to the template on any failure — including an empty answer. */
  async function resolve(kind        , userText        , fallback        )                  {
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

  async function buildPrompt(kind           , card         , sceneText         )                  {
    if (kind === "character") return resolve("character", cardToText(card), tplCharacter(card));
    const scene = String(sceneText || "");
    return resolve("scene", scene, tplScene(scene));
  }

  async function editInstruction(instruction        )                  {
    const text = String(instruction || "").trim();
    return resolve("edit", text, text);
  }

  return { mode, setMode, lastImage, setLastImage, clearLastImage, buildPrompt, editInstruction, styled };
}

// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/image/quickgen.ts; this file owns the
// panels, the styles, the buttons, the streamed request and the alerts.
//
// The panel markup is duplicated into two hosts on purpose: the desktop right sidebar and the mobile
// tab render the same controls, and the binders are idempotent so a late re-injection is harmless.
(function () {
  var IC = window.imageCommonSvc;
  if (!IC) { console.error("[image-quickgen] 缺少 image-common.js，请确认其在本文件之前加载"); return; }

  function activeCard() {
    try { return (window.characterSvc && window.characterSvc.getActiveCard) ? window.characterSvc.getActiveCard() : null; }
    catch (e) { return null; }
  }

  // The recent conversation, as text, for the scene prompt. The last eight bubbles are enough;
  // anything longer is capped because the prompt engine only needs the current situation.
  function gatherScene() {
    var rows = document.querySelectorAll("#chat .row");
    var arr = [];
    rows.forEach(function (r) {
      var b = r.querySelector(".bubble");
      if (!b || b.classList.contains("wechat-typing")) return;
      var who = r.classList.contains("user") ? "用户" : (r.querySelector(".meta") ? r.querySelector(".meta").textContent : "角色");
      var tx = (b.textContent || "").trim();
      if (tx) arr.push(who + ":" + tx);
    });
    var txt = arr.slice(-8).join("\n");
    var sum = "";
    try {
      var app = window.appSvc;
      var id = (app && app.getActiveConvId) ? app.getActiveConvId() : "";
      sum = (window.convSummarySvc && id) ? window.convSummarySvc.load(id) : "";
    } catch (e) {}
    if (sum) txt = "[剧情摘要]" + sum + "\n" + txt;
    txt = txt.slice(-2000);
    return txt || "一个安静的室内场景";
  }

  // Streamed chat completion: the frame parsing lives in the service, this only reads bytes.
  async function askEngine(body) {
    var res = await window.fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error("llm " + res.status);
    var reader = res.body.getReader();
    var dec = new TextDecoder();
    var out = "";
    while (true) {
      var step = await reader.read();
      if (step.done) break;
      out = appendSse(out, dec.decode(step.value, { stream: true }));
    }
    if (!out.trim()) throw new Error("empty");
    return out;
  }

  var quick = createQuickgen({
    storage: {
      getItem: function (k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
      setItem: function (k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} },
      removeItem: function (k) { try { window.localStorage.removeItem(k); } catch (e) {} }
    },
    ask: askEngine,
    styleTags: function () { return IC.styleSuffix(); },
    freeModels: function () { return window.APP_MODELS_FREE || []; },
    fastModel: function () { return window.APP_DEFAULT_MODEL_FAST || ""; }
  });

  function llmMode() { return quick.mode(); }
  function setLlmMode(m) { quick.setMode(m); updateModeUI(); }
  function updateModeUI() {
    var m = llmMode();
    document.querySelectorAll("[data-qg-mode]").forEach(function (b) {
      var on = b.getAttribute("data-qg-mode") === m;
      b.style.fontWeight = on ? "700" : "400";
      b.style.opacity = on ? "1" : ".5";
    });
  }

  async function genZImage(prompt, n) {
    return IC.genImage({ prompt: quick.styled(prompt), n: n || 1, size: "1024x1024" });
  }

  async function genEdit(prompt, srcUrl, onTick) {
    // This chain edits fast and loose: steps=4 / guidance=1.0, polled every 6s.
    var res = await IC.genEdit({
      prompt: quick.styled(prompt), srcUrl: srcUrl, steps: 4, guidance: 1.0, intervalMs: 6000,
      filename: "src.png", onTick: function (st) { if (onTick) onTick(st); }
    });
    return res.fileUrl;
  }

  // 4.62: emoji replaced with line icons, primary action on its own row, secondary in a 2-up grid.
  function svgIcon(paths) {
    return '<svg class="qg-ic" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + "</svg>";
  }
  var QG_IC = {
    person: '<circle cx="12" cy="8" r="3.2"/><path d="M5.5 19a6.5 6.5 0 0 1 13 0"/>',
    scene: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="M5 17l4.5-4 3 2.5L16 11l3 3.5"/>',
    star: '<path d="M12 4.5l2.2 4.6 5 .7-3.6 3.5.9 5L12 15.9 7.6 18.3l.9-5L4.9 9.8l5-.7z"/>',
    pencil: '<path d="M4 20h4L19 9a2 2 0 0 0-3-3L5 17z"/><path d="M14 7l3 3"/>',
    pin: '<path d="M12 16.5v5"/><path d="M7.5 4h9l-1.4 6 2.4 2.3V14H6.5v-1.7L8.9 10z"/>',
    trash: '<path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6.5 7l1 13h9l1-13"/>'
  };

  function panelInner(kind, label) {
    var holderId = kind === "character" ? "qgCharImg" : "qgSceneImg";
    var secondary =
      '<button data-qg="edit-' + kind + '" class="qg-btn">' + svgIcon(QG_IC.pencil) + "<span>改这张</span></button>" +
      '<button data-qg="fav-' + kind + '" class="qg-btn">' + svgIcon(QG_IC.star) + "<span>收藏</span></button>" +
      (kind === "character" ? '<button data-qg="setbase-character" class="qg-btn qg-btn-full">' + svgIcon(QG_IC.pin) + "<span>设为发图基准图</span></button>" : "") +
      '<button data-qg="clear-' + kind + '" class="qg-btn qg-btn-full">' + svgIcon(QG_IC.trash) + "<span>清空</span></button>";
    return '<div style="display:flex;flex-direction:column;gap:8px;">' +
      '<button data-qg="gen-' + kind + '" class="qg-btn qg-btn-primary">' + svgIcon(kind === "character" ? QG_IC.person : QG_IC.scene) + "<span>" + (kind === "character" ? "一键生角色图" : "一键生场景图") + "</span></button>" +
      '<div class="qg-actions">' + secondary + "</div>" +
      '<div id="' + holderId + '" class="qg-holder"><span class="qg-hint">尚未生成' + label + "</span></div>" +
      '<div data-qg="status-' + kind + '" class="qg-status"></div>' +
      "</div>";
  }

  function ensureStyles() {
    if (document.getElementById("qgStyles")) return;
    var s = document.createElement("style");
    s.id = "qgStyles";
    s.textContent = [
      ".qg-actions{display:grid;grid-template-columns:1fr 1fr;gap:6px;}",
      ".qg-modebar{display:flex;flex-direction:column;gap:6px;margin-bottom:10px;}",
      ".qg-mode-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;}",
      ".qg-modebar-label{font-size:11px;opacity:.55;letter-spacing:.02em;}",
      ".qg-mode-btn{font-size:11px;padding:6px 8px;}",
      ".qg-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;font-size:12px;padding:7px 10px;border:1px solid rgba(127,127,127,.22);border-radius:9px;background:transparent;color:inherit;cursor:pointer;opacity:.78;white-space:nowrap;transition:background .15s,border-color .15s,opacity .15s,transform .05s;}",
      ".qg-btn:hover{opacity:1;background:rgba(127,127,127,.10);border-color:rgba(127,127,127,.42);}",
      ".qg-btn:active{transform:translateY(1px);}",
      ".qg-btn .qg-ic{flex:0 0 auto;opacity:.85;}",
      ".qg-btn-full{grid-column:1 / -1;}",
      ".qg-btn-primary{width:100%;font-weight:600;padding:9px 10px;opacity:1;background:rgba(127,127,127,.12);border-color:rgba(127,127,127,.4);}",
      ".qg-btn-primary:hover{background:rgba(127,127,127,.2);border-color:currentColor;}",
      ".qg-holder{min-height:96px;border:1px solid rgba(127,127,127,.22);background:rgba(127,127,127,.05);border-radius:12px;display:flex;align-items:center;justify-content:center;padding:8px;overflow:hidden;}",
      ".qg-holder img{max-width:100%;border-radius:9px;cursor:zoom-in;box-shadow:0 2px 10px rgba(0,0,0,.18);transition:transform .15s;}",
      ".qg-holder img:hover{transform:scale(1.02);}",
      ".qg-hint{font-size:11px;opacity:.5;}",
      ".qg-status{font-size:11px;opacity:.7;min-height:14px;}",
      ".qg-sec{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:600;opacity:.85;margin-bottom:8px;letter-spacing:.02em;}",
      ".qg-sec .qg-ic{opacity:.8;}"
    ].join("\n");
    document.head.appendChild(s);
  }

  function setStatus(kind, txt) {
    document.querySelectorAll('[data-qg="status-' + kind + '"]').forEach(function (e) { e.textContent = txt || ""; });
  }

  function placeIntoPanel(kind, url) {
    quick.setLastImage(kind, url);
    var holderId = kind === "character" ? "qgCharImg" : "qgSceneImg";
    document.querySelectorAll("#" + holderId).forEach(function (h) {
      h.innerHTML = "";
      var im = document.createElement("img");
      im.src = url;
      im.title = "点击在大图工坊查看";
      im.onclick = function () { openInStudio(url); };
      h.appendChild(im);
    });
    var out = document.getElementById("imgOutput");
    if (out) {
      var im2 = document.createElement("img");
      im2.src = url;
      im2.style.maxWidth = "100%";
      out.innerHTML = "";
      out.appendChild(im2);
    }
  }

  function clearPanel(kind) {
    quick.clearLastImage(kind);
    var holderId = kind === "character" ? "qgCharImg" : "qgSceneImg";
    document.querySelectorAll("#" + holderId).forEach(function (h) {
      h.innerHTML = '<span class="qg-hint">尚未生成' + (kind === "character" ? "角色图" : "场景图") + "</span>";
    });
    setStatus(kind, "");
  }

  function openInStudio(url) {
    try {
      if (window.imageStudioSvc && window.imageStudioSvc.open) window.imageStudioSvc.open();
      var out = document.getElementById("imgOutput");
      if (out) {
        var im = document.createElement("img");
        im.src = url; im.style.maxWidth = "100%";
        out.innerHTML = ""; out.appendChild(im);
      }
    } catch (e) {}
  }

  async function quickGenerate(kind) {
    var card = activeCard();
    if (kind === "character" && !card) { alert("请先在「角色卡」里选择一个角色"); return; }
    setStatus(kind, "正在构建提示词…");
    var prompt = await quick.buildPrompt(kind, card, kind === "scene" ? gatherScene() : "");
    lastPrompt[kind] = prompt;
    setStatus(kind, "正在出图… (" + prompt.slice(0, 40) + "…)");
    try {
      var urls = await genZImage(prompt, 1);
      placeIntoPanel(kind, urls[0]);
      setStatus(kind, "完成");
    } catch (e) {
      setStatus(kind, e.message);
    }
  }

  async function quickEdit(kind) {
    var src = quick.lastImage(kind);
    if (!src) { alert("请先生成" + (kind === "character" ? "角色图" : "场景图") + "再改"); return; }
    var instr = prompt("想怎么改?(用大白话说,例如:换成和服 / 改成夜晚 / 加点雪)");
    if (!instr || !instr.trim()) return;
    setStatus(kind, "正在理解指令…");
    var editPrompt = await quick.editInstruction(instr.trim());
    lastPrompt[kind] = editPrompt;
    setStatus(kind, "正在改图…");
    try {
      var url = await genEdit(editPrompt, src, function (st) { setStatus(kind, "改图中… " + st); });
      placeIntoPanel(kind, url);
      setStatus(kind, "改图完成");
    } catch (e) {
      setStatus(kind, e.message);
    }
  }

  async function setAsBaseImg(kind) {
    var src = quick.lastImage(kind);
    if (!src) { alert("请先生成角色图再设为基准图"); return; }
    var card = activeCard();
    var id = (card && card.id) || "default";
    if (!(window.chatImageSvc && window.chatImageSvc.setBaseImage)) { alert("发图模块未就绪(image-chat.js)"); return; }
    setStatus(kind, "正在设为基准图…");
    try {
      await window.chatImageSvc.setBaseImage({ characterId: id, imageUrl: src });
      setStatus(kind, "已设为「" + ((card && card.name) || "当前角色") + "」的发图基准图,以后发图都以这张保持同一人");
    } catch (e) { setStatus(kind, ((e && e.message) || e)); }
  }

  function modeBar() {
    return '<div class="qg-modebar">' +
      '<span class="qg-modebar-label">提示词引擎</span>' +
      '<div class="qg-mode-grid">' +
      '<button data-qg-mode="free" class="qg-btn qg-mode-btn" title="免费档：默认 NVIDIA gpt-oss，连接最稳、零费用（渠道可在「设置→模型 API」改）">免费档</button>' +
      '<button data-qg-mode="fast" class="qg-btn qg-mode-btn" title="快速档：默认 DeepSeek 官方，稳定但计费（渠道可在「设置→模型 API」改）">快速档</button>' +
      "</div>" +
      "</div>";
  }

  function bindMode(root) {
    root.querySelectorAll("[data-qg-mode]").forEach(function (b) {
      if (b.__qgMb) return;
      b.__qgMb = true;
      b.addEventListener("click", function () { setLlmMode(b.getAttribute("data-qg-mode")); });
    });
  }

  var lastPrompt = {};

  function favCurrent(kind) {
    var src = quick.lastImage(kind);
    if (!src) { alert("请先生成" + (kind === "character" ? "角色图" : "场景图")); return; }
    if (window.__gallery && window.__gallery.favorite) window.__gallery.favorite(src, { kind: kind, prompt: lastPrompt[kind] || "" });
    else alert("画廊模块未加载");
  }

  function bindButtons(root) {
    root.querySelectorAll("[data-qg]").forEach(function (btn) {
      var act = btn.getAttribute("data-qg");
      if (!/^(gen|edit|fav|setbase|clear)-/.test(act) || btn.__qgBound) return;
      btn.__qgBound = true;
      btn.addEventListener("click", function () {
        var parts = act.split("-");
        if (parts[0] === "gen") quickGenerate(parts[1]);
        else if (parts[0] === "edit") quickEdit(parts[1]);
        else if (parts[0] === "setbase") setAsBaseImg(parts[1]);
        else if (parts[0] === "clear") clearPanel(parts[1]);
        else favCurrent(parts[1]);
      });
    });
  }

  function injectDesktop() {
    var ph = document.querySelector("#rightSidebar .sidebar-slot-placeholder");
    if (!ph || ph.__qgDone) return;
    ph.__qgDone = true;
    ph.innerHTML = modeBar() + '<div class="qg-sec">' + svgIcon(QG_IC.person) + "<span>角色形象</span></div>" +
      panelInner("character", "角色图") +
      '<div style="height:14px;"></div>' +
      '<div class="qg-sec">' + svgIcon(QG_IC.scene) + "<span>场景图</span></div>" +
      panelInner("scene", "场景图");
    bindButtons(ph);
    bindMode(ph);
    updateModeUI();
  }

  function restoreLast() {
    ["character", "scene"].forEach(function (k) {
      var u = quick.lastImage(k);
      if (u) placeIntoPanel(k, u);
    });
  }

  function init() {
    ensureStyles();
    injectDesktop();
    restoreLast();
    updateModeUI();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

globalThis.LS_MODE = LS_MODE;
globalThis.LS_IMG = LS_IMG;
globalThis.DEFAULT_FREE_MODEL = DEFAULT_FREE_MODEL;
globalThis.DEFAULT_FAST_MODEL = DEFAULT_FAST_MODEL;
globalThis.SYS = SYS;
globalThis.cardToText = cardToText;
globalThis.tplCharacter = tplCharacter;
globalThis.tplScene = tplScene;
globalThis.withStyle = withStyle;
globalThis.pickFreeModel = pickFreeModel;
globalThis.pickFastModel = pickFastModel;
globalThis.buildChatBody = buildChatBody;
globalThis.appendSse = appendSse;
globalThis.cleanPrompt = cleanPrompt;
globalThis.createQuickgen = createQuickgen;
})();
