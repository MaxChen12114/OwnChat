(function () {
/**
 * Chat-background settings: persisted shape, slider value parsing and the apply/clear rules.
 *
 * The card in settings.js owns the DOM (inputs, labels, file picker, status text and the toasts);
 * this module owns the decisions that used to be scattered through that card — reading the stored
 * bg object with defaults, parsing slider values, the centre label, the 4 MiB upload ceiling and
 * the key deletion rules. Keeping them here lets the awkward asymmetric fallback be locked without
 * a browser: `posX`/`posY` guard against non-finite values, `opacity`/`blur` deliberately do not,
 * mirroring the original which passed a bad stored value straight to the range input.
 *
 * All stored values are untrusted (localStorage may be hand-edited), so every read is narrowed to a
 * string and parsed defensively; nothing here touches the DOM or localStorage directly.
 * @module services/ui/settings-background
 */

const OVERRIDES_KEY = "cfw_ui_overrides_v1";
const ASSETS_KEY = "cfw_ui_assets_v1";
const LOCAL_MARK = "__local__";
/** Uploads are stored as base64 locally; a larger file balloons storage for little visual gain. */
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/** Slider defaults, matching the original markup: opacity 100%, blur 0px, both positions centred. */
const DEFAULT_OPACITY = 100;
const DEFAULT_BLUR = 0;
const DEFAULT_POS = 50;

                                  
                                      
                                            
                                
                                                                              
                  
 

                                   
                           
                        
                        
                        
                       
 

function recOf(v         )                          {
  const out                          = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

function readRecord(raw               )                          {
  if (typeof raw !== "string" || !raw) return {};
  try {
    const parsed          = JSON.parse(raw);
    return recOf(parsed);
  } catch (e) { return {}; }
}

/** A present, non-empty stored value is parsed; blank/missing falls back to the given default. */
function parseIntOr(raw         , fallback        )         {
  return raw !== null && raw !== undefined && raw !== "" ? parseInt(String(raw), 10) : fallback;
}

/**
 * Slider values from the stored `bg` object. The asymmetry is load-bearing: positions additionally
 * clamp a non-finite result back to the centre, while opacity/blur keep the parsed value so a bad
 * stored entry surfaces in the input instead of being silently rewritten.
 */
function parseConfig(bg         )                   {
  const o = recOf(bg);
  const src = typeof o["src"] === "string" ? o["src"] : "";
  const opacity = parseIntOr(o["opacity"], DEFAULT_OPACITY);
  const blur = parseIntOr(o["blur"], DEFAULT_BLUR);
  let posX = parseIntOr(o["posX"], DEFAULT_POS);
  let posY = parseIntOr(o["posY"], DEFAULT_POS);
  if (!isFinite(posX)) posX = DEFAULT_POS;
  if (!isFinite(posY)) posY = DEFAULT_POS;
  return { opacity, blur, posX, posY, src };
}

/** Centre reads as a word; any other position shows its percentage. */
function posLabel(v        )         {
  return v === 50 ? "居中" : (v + "%");
}

/** Base64 upload ceiling; exact equality is allowed. */
function isOverUploadLimit(bytes         )          {
  return typeof bytes === "number" && bytes > MAX_UPLOAD_BYTES;
}

/** Apply a pasted URL: blank removes `src`, a value replaces it; a bg with no src is dropped. */
function applyUrl(config         , url         )                          {
  const out = recOf(config);
  const bg = recOf(out["bg"]);
  const text = typeof url === "string" ? url.trim() : "";
  if (!text) delete bg["src"];
  else bg["src"] = text;
  if (!bg["src"]) delete out["bg"];
  else out["bg"] = bg;
  return out;
}

/** Clear removes the whole bg object; the caller clears the separate asset key via clearAssets. */
function clearBg(config         )                          {
  const out = recOf(config);
  delete out["bg"];
  return out;
}

function createBackground(ports                 ) {
  function readConfig()                          { return readRecord(ports.getItem(OVERRIDES_KEY)); }
  function readAssets()                          { return readRecord(ports.getItem(ASSETS_KEY)); }
  function writeConfig(next                         )       {
    ports.setItem(OVERRIDES_KEY, JSON.stringify(next || {}));
    ports.applyBg();
  }
  function writeAssets(next                         )       {
    ports.setItem(ASSETS_KEY, JSON.stringify(next || {}));
  }
  return {
    parseConfig: parseConfig,
    posLabel: posLabel,
    isOverUploadLimit: isOverUploadLimit,
  applyUrl: applyUrl,
  clearBg: clearBg,
  readConfig: readConfig,
  readAssets: readAssets,
  writeConfig: writeConfig,
  writeAssets: writeAssets,
  /** Set one bg field from a slider, preserving the other fields; values are stored as-is (strings). */
  setField: function (field                                      , value         )       {
    const out = readConfig();
    const bg = recOf(out["bg"]);
    bg[field] = value;
    out["bg"] = bg;
    writeConfig(out);
  },
  /** Mark the bg source as a locally uploaded image without touching the other fields. */
  setLocalSource: function ()       {
    const out = readConfig();
    const bg = recOf(out["bg"]);
    bg["src"] = LOCAL_MARK;
    out["bg"] = bg;
    writeConfig(out);
  },
};
}

// Browser wiring for services/ui/settings-background.ts: localStorage, the theme re-apply hook and
// the non-`__` global. Slider parsing, labels and key-deletion rules live in the emitted TS product.
(function () {
  window.settingsBackground = createBackground({
    getItem: function (key) {
      try { return window.localStorage.getItem(key); } catch (e) { return null; }
    },
    setItem: function (key, value) {
      try { window.localStorage.setItem(key, value); } catch (e) {}
    },
    removeItem: function (key) {
      try { window.localStorage.removeItem(key); } catch (e) {}
    },
    applyBg: function () {
      try { if (window.themeSvc && typeof window.themeSvc.applyBg === "function") window.themeSvc.applyBg(); } catch (e) {}
    },
  });
})();

globalThis.OVERRIDES_KEY = OVERRIDES_KEY;
globalThis.ASSETS_KEY = ASSETS_KEY;
globalThis.LOCAL_MARK = LOCAL_MARK;
globalThis.MAX_UPLOAD_BYTES = MAX_UPLOAD_BYTES;
globalThis.DEFAULT_OPACITY = DEFAULT_OPACITY;
globalThis.DEFAULT_BLUR = DEFAULT_BLUR;
globalThis.DEFAULT_POS = DEFAULT_POS;
globalThis.parseConfig = parseConfig;
globalThis.posLabel = posLabel;
globalThis.isOverUploadLimit = isOverUploadLimit;
globalThis.applyUrl = applyUrl;
globalThis.clearBg = clearBg;
globalThis.createBackground = createBackground;
})();
