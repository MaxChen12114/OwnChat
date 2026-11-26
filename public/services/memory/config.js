(function () {
/**
 * Character memory settings: the single table of defaults, storage keys and clamp ranges.
 *
 * `services/memory/core.ts` and `services/memory/char-memory.ts` used to spell the same numbers
 * inline (`cfw_mem_v1` / `cfw_mem_vec_v1` switches, recall k=4, reflect 40 rows, inject 3 chunks /
 * 1200 chars). The settings card needs exactly those numbers on its read *and* write side, so they
 * live here once. A default is a product decision: every one of these equals the pre-2026-11-25
 * hard-coded behaviour, and `autoWrite` stays off because turning it on adds one model call per
 * turn (the card says so).
 *
 * Polarity follows the two legacy switches: `enabled` / `vecEnabled` are on unless stored as "0";
 * `autoWrite` is off unless stored as "1". Numeric fields parse strictly, fall back to the default
 * on dirty input and clamp into their documented range.
 *
 * Zero environment access: localStorage arrives through {@link MemoryConfigStorage}. The wiring owns
 * the try/catch and attaches this API to the existing `window.__memCore` facade.
 * @module services/memory/config
 */

                                      
                                      
                                            
 

                               
                                          
                   
                                                                      
                      
                                                             
                  
                                                      
                         
                                                                      
                          
                                                               
                         
                                                                                               
                     
 

                                                                                                                                             

const MEMORY_CONFIG_KEYS                                              = {
  enabled: "cfw_mem_v1",
  vecEnabled: "cfw_mem_vec_v1",
  recallK: "cfw_mem_recall_k_v1",
  reflectMaxRows: "cfw_mem_reflect_rows_v1",
  injectMaxChunks: "cfw_mem_inject_chunks_v1",
  injectMaxChars: "cfw_mem_inject_chars_v1",
  autoWrite: "cfw_mem_auto_v1",
};

/** Defaults are the old inline values, byte for byte. */
const MEMORY_CONFIG_DEFAULTS                         = {
  enabled: true,
  vecEnabled: true,
  recallK: 4,
  reflectMaxRows: 40,
  injectMaxChunks: 3,
  injectMaxChars: 1200,
  autoWrite: false,
};

const MEMORY_CONFIG_LIMITS = {
  recallK: { min: 1, max: 20 },
  reflectMaxRows: { min: 10, max: 200 },
  injectMaxChunks: { min: 1, max: 10 },
  injectMaxChars: { min: 200, max: 6000 },
};

function clampInt(raw         , def        , min        , max        )         {
  const n = parseInt(String(raw == null ? "" : raw), 10);
  if (isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}

/** "on unless explicitly 0" — the polarity of the two legacy switches. */
function memorySwitchOn(raw               )          {
  return raw !== "0";
}

/** "off unless explicitly 1" — the polarity of the new opt-in auto writer. */
function memoryOptIn(raw               )          {
  return raw === "1";
}

/** Read one numeric field under its documented default and range. */
function normalizeMemoryNumber(field                                                                     , raw               )         {
  const spec = MEMORY_CONFIG_LIMITS[field];
  return clampInt(raw, MEMORY_CONFIG_DEFAULTS[field], spec.min, spec.max);
}

/** Read the whole table from a storage port. A throwing storage is the caller's problem; the
 *  wiring wraps localStorage, and the memory services treat a throw as "not configured". */
function readMemoryConfig(storage                     )               {
  return {
    enabled: memorySwitchOn(storage.getItem(MEMORY_CONFIG_KEYS.enabled)),
    vecEnabled: memorySwitchOn(storage.getItem(MEMORY_CONFIG_KEYS.vecEnabled)),
    recallK: normalizeMemoryNumber("recallK", storage.getItem(MEMORY_CONFIG_KEYS.recallK)),
    reflectMaxRows: normalizeMemoryNumber("reflectMaxRows", storage.getItem(MEMORY_CONFIG_KEYS.reflectMaxRows)),
    injectMaxChunks: normalizeMemoryNumber("injectMaxChunks", storage.getItem(MEMORY_CONFIG_KEYS.injectMaxChunks)),
    injectMaxChars: normalizeMemoryNumber("injectMaxChars", storage.getItem(MEMORY_CONFIG_KEYS.injectMaxChars)),
    autoWrite: memoryOptIn(storage.getItem(MEMORY_CONFIG_KEYS.autoWrite)),
  };
}

/** Persist the fields present in `patch` (values normalised first), then return the merged table. */
function writeMemoryConfig(storage                     , patch                       )               {
  const p = patch || {};
  if (typeof p.enabled === "boolean") storage.setItem(MEMORY_CONFIG_KEYS.enabled, p.enabled ? "1" : "0");
  if (typeof p.vecEnabled === "boolean") storage.setItem(MEMORY_CONFIG_KEYS.vecEnabled, p.vecEnabled ? "1" : "0");
  if (p.recallK !== undefined) storage.setItem(MEMORY_CONFIG_KEYS.recallK, String(normalizeMemoryNumber("recallK", String(p.recallK))));
  if (p.reflectMaxRows !== undefined) storage.setItem(MEMORY_CONFIG_KEYS.reflectMaxRows, String(normalizeMemoryNumber("reflectMaxRows", String(p.reflectMaxRows))));
  if (p.injectMaxChunks !== undefined) storage.setItem(MEMORY_CONFIG_KEYS.injectMaxChunks, String(normalizeMemoryNumber("injectMaxChunks", String(p.injectMaxChunks))));
  if (p.injectMaxChars !== undefined) storage.setItem(MEMORY_CONFIG_KEYS.injectMaxChars, String(normalizeMemoryNumber("injectMaxChars", String(p.injectMaxChars))));
  if (typeof p.autoWrite === "boolean") storage.setItem(MEMORY_CONFIG_KEYS.autoWrite, p.autoWrite ? "1" : "0");
  return readMemoryConfig(storage);
}

                                  
                       
                                                    
                                  
                                   
                                      
 

/** The facade both the settings card and the memory services consume. */
function createMemConfig(storage                     )                  {
  return {
    read: () => readMemoryConfig(storage),
    write: (patch) => writeMemoryConfig(storage, patch),
    keys: MEMORY_CONFIG_KEYS,
    defaults: MEMORY_CONFIG_DEFAULTS,
    limits: MEMORY_CONFIG_LIMITS,
  };
}

// Browser wiring for services/memory/config.ts: localStorage as the injected port, and the API
// mounted on the existing __memCore facade (no new window.__* contract). Must load after
// memory/core.js, which owns that facade object.
(function () {
  var api = createMemConfig({
    getItem: function (key) { try { return window.localStorage.getItem(key); } catch (e) { return null; } },
    setItem: function (key, value) { try { window.localStorage.setItem(key, value); } catch (e) {} },
  });
  if (window.__memCore) window.__memCore.config = api;
  else window.__memCore = { config: api };
})();

globalThis.MEMORY_CONFIG_KEYS = MEMORY_CONFIG_KEYS;
globalThis.MEMORY_CONFIG_DEFAULTS = MEMORY_CONFIG_DEFAULTS;
globalThis.MEMORY_CONFIG_LIMITS = MEMORY_CONFIG_LIMITS;
globalThis.memorySwitchOn = memorySwitchOn;
globalThis.memoryOptIn = memoryOptIn;
globalThis.normalizeMemoryNumber = normalizeMemoryNumber;
globalThis.readMemoryConfig = readMemoryConfig;
globalThis.writeMemoryConfig = writeMemoryConfig;
globalThis.createMemConfig = createMemConfig;
})();
