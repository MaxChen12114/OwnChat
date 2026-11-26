(function () {
/**
 * Data layer for the base-selection cards: the custom id (`cfw_custom_id_v1`), the built-in base id
 * (`cfw_base_id_v1`), the neutral/locked id (`cfw_neutral_id_v1`) and the catalogue switch
 * (`cfw_base_registry_v1`).
 *
 * These keys are written by settings.js and read by services/data/prompt-profile.ts on every
 * request assembly. The two sides used to spell their own read/write rules, which is how a
 * settings-write vs prompt-read drift starts. This module is the single implementation of the
 * selection rules: the missing-key default, the verbatim string read, the empty-value removal rule
 * and the only literal that selects the custom catalogue.
 *
 * The two globals the card touches are UI facades, deliberately NOT ports here:
 *   - window.__baseSwitchMode: a load-time channel flag that only gates whether the custom-directory
 *     dropdown/card is rendered. It is not the stored selection — that is `cfw_base_registry_v1`
 *     (which directory) plus the id key (which entry inside it). prompt-profile snapshots it as a
 *     mode, not as custom-id data.
 *   - window.escapeSvc.esc: HTML escaping for option labels, pure rendering with no data meaning.
 * Both stay in the settings wiring; neither has a read/write of a selection key in it.
 *
 * @module services/ui/settings-base-id
 */

/** Storage keys shared with prompt-profile; the literals themselves are the contract. */
const CUSTOM_ID_KEY = "cfw_custom_id_v1";
const BASE_ID_KEY = "cfw_base_id_v1";
const NEUTRAL_ID_KEY = "cfw_neutral_id_v1";
const BASE_REGISTRY_KEY = "cfw_base_registry_v1";

/** Key-value storage port; the wiring wraps localStorage so quota errors never reach this module. */
                              
                                      
                                            
                                
 

/**
 * The one normalization for a stored custom id: a missing value reads as the empty string, and any
 * real string is returned verbatim — no trim, no coercion, no catalogue fallback. Byte-identical to
 * prompt-profile's `v === null ? "" : v` in currentCustomId(): every value a KV store can legally
 * return (string | null) produces the same result on both sides. Non-strings are treated as absent
 * so a dirty injected store degrades the same way a throwing one does.
 */
function normalizeCustomId(raw         )         {
  return typeof raw === "string" ? raw : "";
}

/**
 * One rule for every catalogue selection (base id and neutral id): a stored string is returned
 * verbatim, anything else reads as "not selected". Byte-identical to prompt-profile's
 * `v === null ? "" : v` on every value a KV store can legally return.
 */
function normalizeSelection(raw         )         {
  return typeof raw === "string" ? raw : "";
}

/**
 * The registry switch has exactly two states; only the literal `custom` leaves the built-in
 * catalogue. Any other stored value (including a dirty one) means built-in, which is what
 * prompt-profile's `read(LS_BASE_REGISTRY) === "custom"` decides.
 */
function normalizeRegistry(raw         )                {
  return raw === "custom" ? "custom" : "";
}

/**
 * Effective tier label for the custom catalogue: a selected id present in `ids` wins, otherwise the
 * first catalogue entry (or "" when empty). Mirrors prompt-profile's `registryDescribe(true)` label
 * line, so a stale id removed from the catalogue falls back exactly as the worker does.
 */
function resolveCustomLabel(cur        , ids          )         {
  return cur !== "" && ids.indexOf(cur) >= 0 ? cur : (ids.length > 0 ? ids[0] : "");
}

                            
                                                                                                   
                 
                                                                                                  
                              
                                                                
                  
                                                                              
                                     
                                                                             
                                                    
                                                                                        
                                
                                                                                 
                                      
 

/**
 * Create the card's data API. Storage errors stay in the wiring port; this layer only owns the value
 * rules shared with the request side.
 */
function createSettingsBaseId(ports             )            {
  function read()         {
    return normalizeCustomId(ports.getItem(CUSTOM_ID_KEY));
  }
  function write(value         )       {
    const v = normalizeCustomId(value);
    if (v !== "") ports.setItem(CUSTOM_ID_KEY, v);
    else ports.removeItem(CUSTOM_ID_KEY);
  }
  function keyOf()         {
    return CUSTOM_ID_KEY;
  }
  function readSelection(key        )         {
    return normalizeSelection(ports.getItem(key));
  }
  function writeSelection(key        , value         )       {
    const v = normalizeSelection(value);
    if (v !== "") ports.setItem(key, v);
    else ports.removeItem(key);
  }
  function readRegistry()                {
    return normalizeRegistry(ports.getItem(BASE_REGISTRY_KEY));
  }
  function writeRegistry(value         )       {
    if (normalizeRegistry(value) === "custom") ports.setItem(BASE_REGISTRY_KEY, "custom");
    else ports.removeItem(BASE_REGISTRY_KEY);
  }
  return {
    read: read,
    write: write,
    keyOf: keyOf,
    readSelection: readSelection,
    writeSelection: writeSelection,
    readRegistry: readRegistry,
    writeRegistry: writeRegistry,
  };
}

// Browser wiring for services/ui/settings-base-id.ts: localStorage as the injected port and the
// non-`__` global. The selection keys and their normalization live in the emitted TS product and
// are shared with prompt-profile via an equivalence lock. The two UI facades
// (__baseSwitchMode / escapeSvc) stay in settings.js — they are actions, not data.
(function () {
  var api = createSettingsBaseId({
    getItem: function (key) {
      try { return window.localStorage.getItem(key); } catch (e) { return null; }
    },
    setItem: function (key, value) {
      try { window.localStorage.setItem(key, value); } catch (e) {}
    },
    removeItem: function (key) {
      try { window.localStorage.removeItem(key); } catch (e) {}
    },
  });
  // Keys are exposed once so the cards never re-spell a literal. Explicit list: emit does not
  // forward methods automatically (the 2026-11-21 reasoning knife hit exactly this).
  api.CUSTOM_ID_KEY = CUSTOM_ID_KEY;
  api.BASE_ID_KEY = BASE_ID_KEY;
  api.NEUTRAL_ID_KEY = NEUTRAL_ID_KEY;
  api.BASE_REGISTRY_KEY = BASE_REGISTRY_KEY;
  window.settingsBaseId = api;
})();

globalThis.CUSTOM_ID_KEY = CUSTOM_ID_KEY;
globalThis.BASE_ID_KEY = BASE_ID_KEY;
globalThis.NEUTRAL_ID_KEY = NEUTRAL_ID_KEY;
globalThis.BASE_REGISTRY_KEY = BASE_REGISTRY_KEY;
globalThis.normalizeCustomId = normalizeCustomId;
globalThis.normalizeSelection = normalizeSelection;
globalThis.normalizeRegistry = normalizeRegistry;
globalThis.resolveCustomLabel = resolveCustomLabel;
globalThis.createSettingsBaseId = createSettingsBaseId;
})();
