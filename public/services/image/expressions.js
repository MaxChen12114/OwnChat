(function () {
/**
 * Expression pack: re-renders the active character's base image once per expression, changing only
 * the face. Every run goes through the chat-image edit port, which is also what files the result
 * into the local gallery — this module never talks to a provider and keeps no image state.
 *
 * The presets double as the UI's button list and the generation queue, so their order is the order
 * the pack is produced in. Editing instructions are English because the edit model is prompted in
 * it; only the keys (labels) are user-facing.
 * @module services/image/expressions
 */

                                   
                                                                                                       
              
                                          
             
 

const EXPRESSION_PRESETS                     = [
  { key: "开心", en: "a happy bright cheerful smile" },
  { key: "害羞", en: "a shy bashful expression with a light blush" },
  { key: "生气", en: "an angry annoyed expression with a slight pout" },
  { key: "惊讶", en: "a surprised expression with wide open eyes" },
  { key: "难过", en: "a sad sorrowful downcast expression" },
  { key: "微笑", en: "a gentle soft warm smile" }
];

const EXPRESSION_PREFIX =
  "Keep the SAME person, identical pose, outfit, hairstyle, camera framing and background from the source image. Change ONLY the facial expression to ";
const EXPRESSION_SUFFIX = ". consistent character, natural, high quality.";

/** Edit instruction for one expression. Pose, outfit and framing are pinned in the prefix: an
 * instruction that only names the expression drifts the whole frame. */
function expressionInstruction(en        )         {
  return EXPRESSION_PREFIX + en + EXPRESSION_SUFFIX;
}

                                    
                      
                      
 

                                  
                                                                                              
                     
                                                                                       
                                                 
                                                                                  
                        
                                                                                                     
                            
                                                                      
                                           
 

                              
                                                                                                   
                                                                                                   
                                                      
                                                                                                  
                                                                                                     
                               
                                    
 

function recOf(v         )                          {
  const out                          = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

function strOf(v         )         {
  return typeof v === "string" ? v : "";
}

function errText(e         )         {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e && e.message) return String(e.message);
  return String(e);
}

/** Character id for the edit call; the gallery files results under it. */
function activeCharId(card                         )         {
  const id = card.id;
  if (typeof id === "string" && id) return id;
  if (typeof id === "number" && id !== 0 && Number.isFinite(id)) return String(id);
  return "default";
}

function createExpressions(ports                 )              {
  /** A port that throws is treated as "no card": a broken bridge must not take down the button. */
  function activeCard()                          {
    try {
      return recOf(ports.activeCard());
    } catch (e) {
      return {};
    }
  }

  function presetFor(key         )                          {
    return (
      EXPRESSION_PRESETS.filter(function (e) {
        return e.key === key;
      })[0] || null
    );
  }

  async function generate(exprKey          )                         {
    const item = presetFor(exprKey);
    if (!item) return null;
    if (!ports.hasEdit()) {
      ports.status("发图模块未就绪，无法生成");
      return null;
    }
    ports.status("正在生成「" + item.key + "」…（首次无基准图会先造一张，约 30-45s）");
    try {
      const res = recOf(
        await ports.edit({
          characterId: activeCharId(activeCard()),
          instruction: expressionInstruction(item.en)
        })
      );
      const url = strOf(res.imageUrl);
      if (url) {
        ports.onResult(item.key, url);
        ports.status("「" + item.key + "」已生成，已存入本地画廊");
        return url;
      }
      ports.status("「" + item.key + "」未返回结果");
    } catch (e) {
      ports.status("生成失败:" + errText(e));
    }
    return null;
  }

  async function generateAll()                {
    for (let i = 0; i < EXPRESSION_PRESETS.length; i++) {
      await generate(EXPRESSION_PRESETS[i].key);
    }
    ports.status("全套表情已生成完毕，去本地画廊查看/管理");
  }

  return { generate, generateAll, list: EXPRESSION_PRESETS };
}

// Browser adapter, appended by l0/emit.mjs. Engine: services/image/expressions.ts; this file owns
// the frozen global name, the chat-image edit call, the thumbnail strip and the settings card
// (that UI has no other consumer, so it ships with the adapter).
(function () {
  if (window.__expressions) return;

  function setStatus(msg) {
    var el = document.getElementById("imgExprStatus");
    if (el) el.textContent = msg || "";
  }

  function addResult(key, imageUrl) {
    var wrap = document.getElementById("imgExprResults");
    if (!wrap) return;
    var fig = document.createElement("div");
    fig.className = "expr-thumb";
    var img = document.createElement("img");
    img.src = imageUrl;
    img.alt = key;
    img.title = key;
    img.addEventListener("click", function () { window.open(imageUrl, "_blank"); });
    var cap = document.createElement("div");
    cap.className = "expr-cap";
    cap.textContent = key;
    fig.appendChild(img);
    fig.appendChild(cap);
    wrap.insertBefore(fig, wrap.firstChild);
  }

  var expressions = createExpressions({
    hasEdit: function () {
      return !!(window.__chatImage && typeof window.__chatImage.editImage === "function");
    },
    edit: function (arg) { return window.__chatImage.editImage(arg); },
    activeCard: function () {
      try { return (window.__character && window.__character.getActiveCard) ? window.__character.getActiveCard() : null; } catch (e) { return null; }
    },
    status: setStatus,
    onResult: addResult
  });

  window.__expressions = {
    generate: expressions.generate, generateAll: expressions.generateAll, list: expressions.list
  };

  function activeCharName() {
    try {
      var c = window.__character && window.__character.getActiveCard ? window.__character.getActiveCard() : null;
      return (c && c.name) || "当前角色";
    } catch (e) { return "当前角色"; }
  }

  function ensureStyles() {
    if (document.getElementById("exprStyles")) return;
    var s = document.createElement("style");
    s.id = "exprStyles";
    s.textContent = [
      ".expr-btns{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0;}",
      ".expr-btns button{font-size:12px;padding:4px 10px;border-radius:8px;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;cursor:pointer;}",
      ".expr-btns button:hover{background:rgba(127,127,127,.15);}",
      ".expr-results{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;}",
      ".expr-thumb{width:96px;}",
      ".expr-thumb img{width:96px;height:120px;object-fit:cover;border-radius:8px;display:block;cursor:zoom-in;}",
      ".expr-cap{font-size:11px;opacity:.7;text-align:center;margin-top:2px;}"
    ].join("");
    document.head.appendChild(s);
  }

  function injectCard() {
    var settings = document.getElementById("settings");
    if (!settings || document.getElementById("imgExprCard")) return;
    // Mounted into the image slot explicitly. Falling back to the settings root was only for older
    // pages whose markup lacked that slot: the card still showed, just at the bottom of the panel.
    var slot = window.slotRegistry.pick("settingsImageSlot");
    ensureStyles();
    var card = document.createElement("div");
    card.className = "card";
    card.id = "imgExprCard";
    var btns = expressions.list.map(function (e) { return '<button data-expr="' + e.key + '">' + e.key + "</button>"; }).join("");
    card.innerHTML = [
      '<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8.5 15c.8-1.2 2-2 3.5-2s2.7.8 3.5 2"/><circle cx="9" cy="9.5" r=".9"/><circle cx="15" cy="9.5" r=".9"/></svg>表情差分包</h4>',
      '<p>基于当前角色的发图基准图，只改表情、其余（姿势/穿着/背景）不变。当前角色：<b id="imgExprWho"></b>。生成的图自动存入本地画廊。</p>',
      '<div class="expr-btns">' + btns + '<button data-expr="__all__" style="font-weight:600;">生成全套</button></div>',
      '<div id="imgExprStatus" style="font-size:12px;opacity:.75;min-height:16px;"></div>',
      '<div class="expr-results" id="imgExprResults"></div>'
    ].join("");
    slot.appendChild(card);
    var who = document.getElementById("imgExprWho");
    if (who) who.textContent = activeCharName();
    card.querySelectorAll(".expr-btns button").forEach(function (b) {
      b.addEventListener("click", function () {
        var k = b.getAttribute("data-expr");
        if (k === "__all__") expressions.generateAll();
        else expressions.generate(k);
      });
    });
    window.addEventListener("character:changed", function () {
      var w = document.getElementById("imgExprWho");
      if (w) w.textContent = activeCharName();
    });
  }

  function init() { injectCard(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

globalThis.EXPRESSION_PRESETS = EXPRESSION_PRESETS;
globalThis.expressionInstruction = expressionInstruction;
globalThis.createExpressions = createExpressions;
})();
