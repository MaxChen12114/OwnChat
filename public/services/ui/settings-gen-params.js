(function () {
/**
 * Generation-parameter overrides: temperature / max_tokens as an optional overlay on the model's
 * own defaults. "Blank means do not interfere" is the whole contract — an untouched field must not
 * be sent at all, so the writer deletes keys instead of storing zeros.
 *
 * Only the arithmetic and the storage shape live here; the card's inputs and presets stay in the
 * settings wiring, which reads and writes through the ports. app.js keeps its own reader for the
 * request payload (same storage key), so both sides must keep the key in step.
 * @module services/ui/settings-gen-params
 */

/** Storage key shared with the request path (`LS_GEN_PARAMS` in app.js). */
const LS_GEN_PARAMS = "cfw_gen_params_v1";

/** The overlay. Missing members mean "do not send this field". */
                            
                       
                     
 

/** Storage port; the wiring wraps localStorage so quota errors stay outside this module. */
                                 
                                      
                                            
 

/** Quick presets offered by the card. `reset` is not here: it writes an empty overlay. */
const GEN_PRESETS                            = {
  rp: { temperature: 1.2 },
  write: { temperature: 1.4, maxTokens: 8192 },
  code: { temperature: 0.3 },
};

/** unknown -> plain-object copy; arrays, null and scalars all become null. */
function recOf(value         )                                 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const out                          = {};
  const entries = Object.entries(value);
  for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  return out;
}

/**
 * Parse a stored overlay. Broken JSON and non-objects read as an empty overlay: a corrupt entry
 * must not stop the settings panel from opening, and it is indistinguishable from "never set".
 */
function parseGenParams(raw               )            {
  if (raw === null || raw === "") return {};
  let parsed         ;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {};
  }
  const rec = recOf(parsed);
  if (rec === null) return {};
  const out            = {};
  const t = rec["temperature"];
  if (typeof t === "number" && isFinite(t)) out.temperature = t;
  const m = rec["maxTokens"];
  if (typeof m === "number" && isFinite(m)) out.maxTokens = m;
  return out;
}

/**
 * Apply two raw input strings on top of the current overlay, with the card's semantics:
 * blank / unparsable deletes the key (back to "do not interfere"), a number is clamped
 * (temperature 0..2, maxTokens >= 1 floored).
 * @param current - the stored overlay.
 * @param tempRaw - the temperature input value as typed.
 * @param maxRaw - the max-tokens input value as typed.
 * @returns A new overlay; `current` is not mutated.
 */
function mergeGenInputs(current           , tempRaw        , maxRaw        )            {
  const next            = {};
  if (typeof current.temperature === "number") next.temperature = current.temperature;
  if (typeof current.maxTokens === "number") next.maxTokens = current.maxTokens;
  const t = tempRaw.trim() === "" ? NaN : Number(tempRaw);
  if (isNaN(t)) delete next.temperature;
  else next.temperature = Math.max(0, Math.min(2, t));
  const m = maxRaw.trim() === "" ? NaN : parseInt(maxRaw, 10);
  if (isNaN(m)) delete next.maxTokens;
  else next.maxTokens = Math.max(1, Math.floor(m));
  return next;
}

/** Public surface; the wiring assigns it to a non-`__` global (no frozen-contract growth). */
                               
                    
                                 
                                                                                   
                                                          
                                                                     
                                      
                                                                     
                     
 

/**
 * Create the API. A failed storage write is swallowed by the wiring, so this layer may assume the
 * port reports success.
 * @param ports - storage access from the wiring.
 */
function createGenParams(ports                )               {
  function read()            {
    return parseGenParams(ports.getItem(LS_GEN_PARAMS));
  }
  function write(params           )       {
    ports.setItem(LS_GEN_PARAMS, JSON.stringify(params));
  }
  function applyInputs(tempRaw        , maxRaw        )            {
    const next = mergeGenInputs(read(), tempRaw, maxRaw);
    write(next);
    return next;
  }
  function applyPreset(key        )            {
    const preset = GEN_PRESETS[key];
    const next            = preset === undefined ? read() : { temperature: preset.temperature, maxTokens: preset.maxTokens };
    if (preset !== undefined) write(next);
    return next;
  }
  function reset()            {
    write({});
    return {};
  }
  return { read: read, write: write, applyInputs: applyInputs, applyPreset: applyPreset, reset: reset };
}

// Browser wiring for services/ui/settings-gen-params.ts: localStorage side plus the non-`__` global
// the settings card calls. Kept off the frozen `window.__*` surface on purpose.
(function () {
  window.settingsGenParams = createGenParams({
    getItem: function (key) {
      try {
        return window.localStorage.getItem(key);
      } catch (e) {
        return null;
      }
    },
    setItem: function (key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch (e) {}
    },
  });
})();

globalThis.LS_GEN_PARAMS = LS_GEN_PARAMS;
globalThis.GEN_PRESETS = GEN_PRESETS;
globalThis.parseGenParams = parseGenParams;
globalThis.mergeGenInputs = mergeGenInputs;
globalThis.createGenParams = createGenParams;
})();
