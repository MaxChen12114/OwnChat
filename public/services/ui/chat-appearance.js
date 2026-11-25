(function () {
/**
 * Chat typography: the font family and the subtle text effect, both per device.
 *
 * Scope is deliberately narrow — it writes `--chat-font-family` and `data-text-fx` on `<html>` and
 * nothing else. Bubbles are not touched and `app.js` is not involved; the settings page only fills its
 * controls from the same constants.
 *
 * The font name comes from user input, so it is sanitised down to something that can only be a CSS
 * `font-family` value: control characters and `; { } < >` are stripped and the result is capped. That
 * is an injection boundary, not tidiness — a stray `;` would let the value escape the declaration.
 *
 * Every function takes an optional `doc` so a caller (and the test) can target a specific document;
 * it falls back to the one supplied by {@link ChatAppearanceEnv}.
 *
 * Lock: `test/chat-appearance.test.mjs` (assertions unchanged).
 * @module services/ui/chat-appearance
 */

                                 
                                                                                                 
                                                   
                                       
 

                                
                                         
 

                                
            
                                        
                                              
                                  
    
                            
 

                             
                
                
 

                                    
                  
                
                             
                        
                       
                                       
                     
                   
                                              
                                                             
                                                         
                                 
                             
                                             
 

const APPEARANCE_LS_FONT = "cfw_chat_font_family_v1";
const APPEARANCE_LS_FX = "cfw_chat_text_fx_v1";
const APPEARANCE_FX                         = { off: "无", soft: "轻", strong: "强" };
const APPEARANCE_MAX_FONT_LEN = 200;

/** The same list the settings dropdown renders, so the two never drift. */
const APPEARANCE_PRESETS               = [
  { value: "", label: "系统默认（苹方/微软雅黑）" },
  { value: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif', label: "圆体（PingFang）" },
  { value: '"Noto Serif SC", "Source Han Serif SC", "SimSun", serif', label: "宋体（Noto Serif）" },
  { value: '"Kaiti SC", "STKaiti", KaiTi, serif', label: "楷体（Kaiti）" },
  { value: "FangSong, STFangsong, serif", label: "仿宋（FangSong）" },
  { value: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", label: "等宽（Monospace）" },
];

function text(value         )         {
  return value == null ? "" : typeof value === "string" ? value : String(value);
}

function createChatAppearance(env               )                    {
  /** Strips everything that could break out of a `font-family` value, then caps the length. */
  function sanitizeFont(value         )         {
    let s = text(value).trim();
    if (!s) return "";
    s = s.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[;{}<>]/g, "").slice(0, APPEARANCE_MAX_FONT_LEN).trim();
    return s;
  }

  function readFont()         {
    try {
      return sanitizeFont(env.storage.getItem(APPEARANCE_LS_FONT) || "");
    } catch (e) {
      return "";
    }
  }

  function readFx()         {
    try {
      const v = env.storage.getItem(APPEARANCE_LS_FX) || "off";
      return APPEARANCE_FX[v] ? v : "off";
    } catch (e) {
      return "off";
    }
  }

  function presetFor(font         )                    {
    const s = sanitizeFont(font);
    for (let i = 0; i < APPEARANCE_PRESETS.length; i++) {
      if (APPEARANCE_PRESETS[i].value === s) return APPEARANCE_PRESETS[i];
    }
    return null;
  }

  function root(doc                       )                        {
    const target = doc || env.doc || null;
    return target ? target.documentElement || null : null;
  }

  /** Writes (or clears) `--chat-font-family` on the root element. */
  function applyFont(font         , doc                       )       {
    const html = root(doc);
    if (!html || !html.style) return;
    const s = sanitizeFont(font);
    if (s) html.style.setProperty("--chat-font-family", s);
    else html.style.removeProperty("--chat-font-family");
  }

  /** Writes (or clears) `data-text-fx`; an unknown effect value means "off". */
  function applyFx(fx         , doc                       )       {
    const html = root(doc);
    if (!html || !html.setAttribute) return;
    const v = APPEARANCE_FX[text(fx)] ? text(fx) : "off";
    if (v === "off") {
      if (html.removeAttribute) html.removeAttribute("data-text-fx");
    } else {
      html.setAttribute("data-text-fx", v);
    }
  }

  /** @returns the sanitised value that was stored (and applied). */
  function setFont(font         )         {
    const s = sanitizeFont(font);
    try {
      if (s) env.storage.setItem(APPEARANCE_LS_FONT, s);
      else env.storage.removeItem(APPEARANCE_LS_FONT);
    } catch (e) {
      // Storage can be blocked; the value is still applied for this session.
    }
    applyFont(s);
    return s;
  }

  function setFx(fx         )         {
    const v = APPEARANCE_FX[text(fx)] ? text(fx) : "off";
    try {
      env.storage.setItem(APPEARANCE_LS_FX, v);
    } catch (e) {
      // Same as setFont.
    }
    applyFx(v);
    return v;
  }

  function applyAll(doc                       )       {
    applyFont(readFont(), doc);
    applyFx(readFx(), doc);
  }

  return {
    LS_FONT: APPEARANCE_LS_FONT,
    LS_FX: APPEARANCE_LS_FX,
    FX: APPEARANCE_FX,
    PRESETS: APPEARANCE_PRESETS,
    MAX_FONT_LEN: APPEARANCE_MAX_FONT_LEN,
    sanitizeFont: sanitizeFont,
    readFont: readFont,
    readFx: readFx,
    presetFor: presetFor,
    applyFont: applyFont,
    applyFx: applyFx,
    setFont: setFont,
    setFx: setFx,
    applyAll: applyAll,
  };
}

// ── Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name ──
// The implementation moved to services/ui/chat-appearance.ts. Ports are localStorage and the document;
// every function still takes an optional `doc` so a caller can target a specific document.
// The apply-on-load that used to run inside the module body happens here, after the object exists.
(function (g) {
  "use strict";
  if (g.__chatAppearance) return;
  g.__chatAppearance = createChatAppearance({
    storage: {
      getItem: function (key) { return g.localStorage.getItem(key); },
      setItem: function (key, value) { g.localStorage.setItem(key, value); },
      removeItem: function (key) { g.localStorage.removeItem(key); },
    },
    doc: g.document || null,
  });
  // settings.js 之后只负责控件回填与交互；首次应用在这里做一次。
  g.__chatAppearance.applyAll();
})(window);

globalThis.createChatAppearance = createChatAppearance;
})();
