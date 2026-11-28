(function () {
/**
 * Character avatars: one square close-up headshot per character card, cut from the image-chat base
 * image and kept as an id → URL map. Generation goes through the chat-image edit port, which is
 * also what files the result into the local gallery — this module never talks to a provider.
 *
 * The map is one JSON blob under a single storage key, not one key per character: the set is small,
 * every read wants at most one entry, and `characterSvc` reads it on each card render. A payload
 * that is not a JSON object is treated as empty, and non-string values are dropped on read, so a
 * bad write degrades to "no avatar" instead of breaking the settings card.
 * @module services/image/avatar
 */

                                   
                                                                                        
              
                                                                                                
             
 

const AVATAR_EXPRESSIONS                     = [
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
function avatarInstruction(en        )         {
  return CROP_PREFIX + en + CROP_SUFFIX;
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

/** Display text for a card field: scalars are rendered as-is, everything else falls through to the
 * caller's default — the old `(c && c.name) || fallback` did the same by string coercion. */
function textOf(v         )         {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

/** Map key for a caller-supplied id. Falsy and non-scalar ids fall through to the active card,
 * which is what `id || activeId()` did — 0 included. */
function idOf(v         )         {
  if (typeof v === "string") return v;
  if (typeof v === "number" && v !== 0 && Number.isFinite(v)) return String(v);
  return "";
}

function errText(e         )         {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e && e.message) return String(e.message);
  return String(e);
}

/**
 * The avatar bridge. All reads go back to storage — there is no in-memory cache, because the
 * character panel and this card write the same blob and a stale copy would win.
 */
function createAvatar(ports             )         {
  function loadMap()                         {
    const out                         = {};
    let raw                = null;
    try {
      raw = ports.storage.getItem(STORAGE_KEY);
    } catch (e) {
      return out;
    }
    if (!raw) return out;
    let parsed          = null;
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

  function saveMap(m                        )       {
    try {
      ports.storage.setItem(STORAGE_KEY, JSON.stringify(m));
    } catch (e) {
      /* storage is best effort: a private-mode failure must not break the button handler */
    }
  }

  /** The active card, flattened. A port that throws is treated as "no card": a broken bridge must
   * not take down a button handler. */
  function activeCard()                          {
    try {
      return recOf(ports.activeCard());
    } catch (e) {
      return {};
    }
  }

  function activeId()         {
    return idOf(activeCard().id) || AVATAR_DEFAULT_ID;
  }

  function activeName()         {
    return textOf(activeCard().name) || AVATAR_DEFAULT_NAME;
  }

  function get(id          )                {
    const url = loadMap()[idOf(id) || activeId()];
    return url || null;
  }

  function getAll()                         {
    return loadMap();
  }

  function set(id         , url         )       {
    const u = strOf(url);
    if (!u) return;
    const key = idOf(id) || activeId();
    const m = loadMap();
    m[key] = u;
    saveMap(m);
    ports.notify(key, u);
  }

  function clear(id         )       {
    const key = idOf(id) || activeId();
    const m = loadMap();
    delete m[key];
    saveMap(m);
    ports.notify(key, null);
  }

  async function generate(opts          )                         {
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

// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/image/avatar.ts; this file owns the
// frozen global name, the storage key, the avatar change event, the chat-image edit call and the
// whole settings card (that UI has no other consumer, so it ships with the adapter).
//
// The edit call is what files the result into the local gallery — this file must not post the image
// anywhere else, or one generation lands twice.
(function () {
  if (window.__avatar) return;

  var LS_AV = "cfw_char_avatar_v1";

  // 2026-11-28 card-shell batch 2: the headSlot() pick helper is gone — injectCard declares through
  // slotRegistry.declareCard, which resolves settingsImageSlot (with its #settings root fallback)
  // and owns the mount-once probe.

  function setStatus(m) {
    var el = document.getElementById("imgAvStatus");
    if (el) el.textContent = m || "";
  }

  function renderPreview() {
    var box = document.getElementById("imgAvPreview");
    if (!box) return;
    var url = avatar.get(avatar.activeId());
    box.innerHTML = "";
    if (!url) {
      box.textContent = "（当前角色还没有头像）";
      return;
    }
    var img = document.createElement("img");
    img.src = url;
    img.className = "av-img";
    img.addEventListener("click", function () { window.open(url, "_blank"); });
    box.appendChild(img);
  }

  var avatar = createAvatar({
    storage: {
      getItem: function () {
        try { return window.localStorage.getItem(LS_AV); } catch (e) { return null; }
      },
      setItem: function (k, v) {
        try { window.localStorage.setItem(k, v); } catch (e) {}
      }
    },
    hasEdit: function () {
      return !!(window.chatImageSvc && typeof window.chatImageSvc.editImage === "function");
    },
    edit: function (arg) { return window.chatImageSvc.editImage(arg); },
    activeCard: function () {
      try { return (window.characterSvc && window.characterSvc.getActiveCard) ? window.characterSvc.getActiveCard() : null; } catch (e) { return null; }
    },
    notify: function (id, url) {
      try { window.dispatchEvent(new window.CustomEvent("avatar:changed", { detail: { id: id, url: url } })); } catch (e) {}
    },
    status: setStatus,
    preview: renderPreview
  });

  window.__avatar = {
    generate: avatar.generate, get: avatar.get, getAll: avatar.getAll,
    set: avatar.set, clear: avatar.clear, list: avatar.list
  };

  function ensureStyles() {
    if (document.getElementById("avStyles")) return;
    var s = document.createElement("style");
    s.id = "avStyles";
    s.textContent = [
      "#imgAvPreview{margin-top:8px;min-height:20px;font-size:12px;opacity:.7;}",
      "#imgAvPreview .av-img{width:104px;height:104px;object-fit:cover;border-radius:12px;cursor:zoom-in;display:block;}",
      ".av-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:8px 0;}",
      ".av-row select,.av-row button{font-size:12px;padding:4px 10px;border-radius:8px;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;cursor:pointer;}"
    ].join("");
    document.head.appendChild(s);
  }

  function injectCard() {
    // 2026-11-28 card-shell batch 2: shell + declareCard (the old guard checked #settings and its
    // own id by hand; declareCard owns the mount-once probe and the root fallback). The wiring
    // below is unchanged — it reads its controls by document id.
    window.slotRegistry.declareCard({
      id: "imgAvatarCard",
      slotId: "settingsImageSlot",
      build: function (slot) {
        ensureStyles();
        var opts = avatar.list.map(function (e) { return '<option value="' + e.key + '">' + e.key + "</option>"; }).join("");
        var shell = window.cardShell.createCardShell({
          id: "imgAvatarCard",
          title: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><circle cx="12" cy="10" r="2.8"/><path d="M6.5 19.5a5.5 5.5 0 0 1 11 0"/></svg>角色头像',
          desc: '以发图基准图为底，裁一张近景头像（可选表情），保存为当前角色头像。当前角色：<b id="imgAvWho"></b>。',
          extra: '<div class="av-row"><label style="font-size:12px;opacity:.8;">表情</label><select id="imgAvExpr">' + opts + '</select><button id="imgAvGen" style="font-weight:600;">生成头像</button><button id="imgAvBase">设为基准图</button><button id="imgAvDl">下载</button><button id="imgAvClear">清除</button></div>'
            + '<div id="imgAvStatus" style="font-size:12px;opacity:.75;min-height:16px;"></div>'
            + '<div id="imgAvPreview"></div>'
        });
        var card = shell.card;
        slot.appendChild(card);
        var who = document.getElementById("imgAvWho");
        if (who) who.textContent = avatar.activeName();
        renderPreview();
        document.getElementById("imgAvGen").addEventListener("click", function () {
          var sel = document.getElementById("imgAvExpr");
          avatar.generate({ expression: sel ? sel.value : undefined });
        });
        document.getElementById("imgAvBase").addEventListener("click", function () {
          var url = avatar.get(avatar.activeId());
          if (!url) { setStatus("还没有头像"); return; }
          if (window.chatImageSvc && window.chatImageSvc.setBaseImage) {
            window.chatImageSvc.setBaseImage({ characterId: avatar.activeId(), imageUrl: url });
            setStatus("已把头像设为该角色发图基准图");
          }
        });
        document.getElementById("imgAvDl").addEventListener("click", function () {
          var url = avatar.get(avatar.activeId());
          if (!url) { setStatus("还没有头像"); return; }
          var a = document.createElement("a");
          a.href = url;
          a.download = "avatar.png";
          a.target = "_blank";
          document.body.appendChild(a);
          a.click();
          a.remove();
        });
        document.getElementById("imgAvClear").addEventListener("click", function () {
          avatar.clear(avatar.activeId());
          renderPreview();
          setStatus("已清除当前角色头像");
        });
        window.addEventListener("character:changed", function () {
          var w = document.getElementById("imgAvWho");
          if (w) w.textContent = avatar.activeName();
          renderPreview();
        });
        return card;
      }
    });
  }

  function init() { injectCard(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

globalThis.AVATAR_EXPRESSIONS = AVATAR_EXPRESSIONS;
globalThis.avatarInstruction = avatarInstruction;
globalThis.createAvatar = createAvatar;
})();
