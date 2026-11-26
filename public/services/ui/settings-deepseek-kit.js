(function () {
/**
 * DeepSeek kit card data: the two server-side built-in tool switches (`read_url`, `safety_check`).
 *
 * `services/data/prompt-profile.ts` reads both keys when it assembles a chat body and omits the
 * payload unless at least one is `"1"`. The card used to spell that rule inline; this module is the
 * single source of the keys and the literal comparison, so the card and the request side cannot
 * drift apart.
 * @module services/ui/settings-deepseek-kit
 */

/** Storage keys; the literals are shared with prompt-profile and are the contract. */
const DEEPSEEK_KIT_KEYS                                                 = {
  readUrl: "cfw_deepseek_read_url_v1",
  safety: "cfw_deepseek_safety_v1",
};

/** Storage port; the wiring wraps localStorage so quota errors never reach this module. */
                           
                                      
                                            
 

/**
 * One rule for both switches: only the literal `"1"` is on. Byte-identical to prompt-profile's
 * `read(LS_DS_READ_URL) === "1"` and `read(LS_DS_SAFETY) === "1"`.
 */
function normalizeKitFlag(raw         )          {
  return raw === "1";
}

/** Persisted form used by both switches. */
function kitFlagValue(on         )            {
  return on ? "1" : "0";
}

                                 
                                              
                             
                                                                                               
                                        
 

/**
 * Create the card's data API.
 * @param ports - the storage port from the wiring.
 * @returns `read` / `write` bound to the two keys.
 */
function createSettingsDeepSeekKit(ports          )                 {
  function read(key        )          {
    return normalizeKitFlag(ports.getItem(key));
  }
  function write(key        , on         )       {
    ports.setItem(key, kitFlagValue(on));
  }
  return { read: read, write: write };
}

// Browser wiring for services/ui/settings-deepseek-kit.ts: localStorage as the injected port and
// the non-`__` global. The two keys and the literal "1" comparison stay in the emitted TS product.
(function (global) {
  "use strict";
  var api = createSettingsDeepSeekKit({
    getItem: function (key) {
      try { return window.localStorage.getItem(key); } catch (e) { return null; }
    },
    setItem: function (key, value) {
      try { window.localStorage.setItem(key, value); } catch (e) {}
    },
  });
  api.KEYS = DEEPSEEK_KIT_KEYS;
  global.settingsDeepSeekKit = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

globalThis.DEEPSEEK_KIT_KEYS = DEEPSEEK_KIT_KEYS;
globalThis.normalizeKitFlag = normalizeKitFlag;
globalThis.kitFlagValue = kitFlagValue;
globalThis.createSettingsDeepSeekKit = createSettingsDeepSeekKit;
})();
