(function () {
/**
 * Persona-card data: the `cfw_use_builtin` switch ("inject the built-in character prompt").
 *
 * `engine/app.js` caches the same flag at boot and after every external-settings broadcast with
 * `(getItem(key) ?? "1") === "1"` — a missing key means ON, anything else must be the literal
 * `"1"`. The card used to restate that formula; this module owns it so the two sides cannot drift.
 * @module services/ui/settings-persona
 */

/** Key shared with engine/app.js; the literal is the contract. */
const USE_BUILTIN_KEY = "cfw_use_builtin";

/** Storage port; the wiring wraps localStorage so quota errors never reach this module. */
                               
                                      
                                            
 

/**
 * The one normalization for the built-in prompt switch. A missing/null value reads as ON (the
 * historical default); any other value is ON only when it is the literal `"1"`.
 */
function normalizeUseBuiltin(raw         )          {
  return raw == null ? true : raw === "1";
}

/** Persisted form; the card writes both states explicitly so the default is never re-derived. */
function useBuiltinValue(on         )            {
  return on ? "1" : "0";
}

                             
                            
                                     
 

/**
 * Create the card's data API.
 * @param ports - the storage port from the wiring.
 * @returns `readUseBuiltin` / `writeUseBuiltin`.
 */
function createSettingsPersona(ports              )             {
  function readUseBuiltin()          {
    return normalizeUseBuiltin(ports.getItem(USE_BUILTIN_KEY));
  }
  function writeUseBuiltin(on         )       {
    ports.setItem(USE_BUILTIN_KEY, useBuiltinValue(on));
  }
  return { readUseBuiltin: readUseBuiltin, writeUseBuiltin: writeUseBuiltin };
}

// Browser wiring for services/ui/settings-persona.ts: localStorage as the injected port and the
// non-`__` global. The missing-means-on default lives in the emitted TS product and is shared with
// engine/app.js through an equivalence lock.
(function (global) {
  "use strict";
  var api = createSettingsPersona({
    getItem: function (key) {
      try { return window.localStorage.getItem(key); } catch (e) { return null; }
    },
    setItem: function (key, value) {
      try { window.localStorage.setItem(key, value); } catch (e) {}
    },
  });
  api.KEY = USE_BUILTIN_KEY;
  global.settingsPersona = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

globalThis.USE_BUILTIN_KEY = USE_BUILTIN_KEY;
globalThis.normalizeUseBuiltin = normalizeUseBuiltin;
globalThis.useBuiltinValue = useBuiltinValue;
globalThis.createSettingsPersona = createSettingsPersona;
})();
