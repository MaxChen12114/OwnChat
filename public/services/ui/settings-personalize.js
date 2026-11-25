(function () {
/**
 * Agent-personalization instruction budget and storage for the settings card.
 *
 * The same key is written by settings.js and read by engine/app.js; both sides previously did their
 * own trimming and size checks, so the two could drift. All of that now lives here: the byte budget
 * (UTF-8 via an injected encoder), the empty-after-trim deletion rule, and the trimmed read used for
 * request injection. The textarea, count label and toasts stay in the settings wiring.
 *
 * Storage writes keep the original text (not the trimmed copy) so the editor round-trips what the
 * user typed; only the empty check and the engine read trim. The encoder is a port because Node's
 * test harness has TextEncoder but the emitted classic product must not assume any global.
 * @module services/ui/settings-personalize
 */

/** Storage key shared with engine/app.js and the byte cap for a personalization instruction. */
const PERSONALIZE_KEY = "cfw_agent_personalize_v1";
const MAX_BYTES = 100 * 1024;

/** Ports: localStorage access and a UTF-8 encoder, both wrapped by the wiring. */
                                   
                                      
                                            
                                
                                                    
 

                                 
                                                                                         
                                 
                                                                            
                               
                                                                                     
                                      
                                                                                             
                 
                                                                                                        
                    
                                                                                                          
                                                            
 

function asString(v         )         {
  return typeof v === "string" ? v : "";
}

/** UTF-8 byte count via the injected encoder; a throwing encoder degrades to code-unit length. */
function byteLen(v         , encode                                               )         {
  const text = asString(v);
  try {
    return encode(text).length;
  } catch (e) {
    return text.length;
  }
}

/** Card-local size labels: the space before the unit is part of the visible UI text. */
function fmtBytes(v         )         {
  const n = typeof v === "number" && Number.isFinite(v) ? v : parseInt(String(v || "0"), 10) || 0;
  return n < 1024 ? (n + " B") : ((n / 1024).toFixed(1) + " KB");
}

/** Over-cap check reused by the live count label and the save handler. */
function isOverLimit(v         , encode                                               )          {
  return byteLen(v, encode) > MAX_BYTES;
}

/** Trimmed storage read; mirrors the engine's read so both sides share one definition. */
function readTrimmed(raw               )         {
  return asString(raw).trim();
}

function createPersonalize(ports                  )                 {
  const encode = (text        ) => ports.encode(text);
  return {
    byteLen: (text) => byteLen(text, encode),
    fmtBytes: fmtBytes,
    isOverLimit: (text) => isOverLimit(text, encode),
    read: () => readTrimmed(ports.getItem(PERSONALIZE_KEY)),
    readRaw: () => asString(ports.getItem(PERSONALIZE_KEY)),
    save: (text) => {
      const raw = asString(text);
      if (isOverLimit(raw, encode)) return { stored: false, trimmed: raw.trim() };
      const trimmed = raw.trim();
      if (trimmed) ports.setItem(PERSONALIZE_KEY, raw);
      else ports.removeItem(PERSONALIZE_KEY);
      return { stored: true, trimmed: trimmed };
    },
  };
}

// Browser wiring for services/ui/settings-personalize.ts: localStorage, TextEncoder and the
// non-`__` global. The byte budget, trim rule and storage shape live in the emitted TS product.
(function () {
  window.settingsPersonalize = createPersonalize({
    getItem: function (key) {
      try { return window.localStorage.getItem(key); } catch (e) { return null; }
    },
    setItem: function (key, value) {
      try { window.localStorage.setItem(key, value); } catch (e) {}
    },
    removeItem: function (key) {
      try { window.localStorage.removeItem(key); } catch (e) {}
    },
    encode: function (text) {
      return new TextEncoder().encode(text);
    },
  });
})();

globalThis.PERSONALIZE_KEY = PERSONALIZE_KEY;
globalThis.MAX_BYTES = MAX_BYTES;
globalThis.byteLen = byteLen;
globalThis.fmtBytes = fmtBytes;
globalThis.isOverLimit = isOverLimit;
globalThis.readTrimmed = readTrimmed;
globalThis.createPersonalize = createPersonalize;
})();
