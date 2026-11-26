(function () {
/**
 * Web-search settings card: the single home for the two keys shared by settings.js (write side) and
 * services/data/prompt-profile.ts (read side, into the /api/chat body).
 *
 * Both sides used to spell out the same rule independently — a strict `=== "1"` compare, with every
 * missing or dirty value reading as off. That is the drift this module removes: the normalization,
 * the storage keys and the "switch off clears deep" invariant now live here once. The DOM (checkbox
 * refs, disabled state, status text) stays in the settings card wiring.
 *
 * The read side is byte-identical to prompt-profile's `webSearchPayload()`: no `webSearch` field at
 * all when the switch is off, otherwise `{ webSearch: true, webSearchDeep: <deep> }`. `payload()`
 * exposes that shape so prompt-profile can delegate to it in a later cut.
 *
 * Zero window, zero casts: storage arrives through {@link WebSearchPorts}, and the wiring owns the
 * try/catch around localStorage. The factory also guards its port calls, mirroring prompt-profile's
 * safe read/write, so a throwing storage cannot change the effective state.
 * @module services/ui/settings-web-search
 */

/** Storage keys shared with prompt-profile.ts; changing either one changes the wire contract. */
const WEB_SEARCH_KEY = "cfw_web_search_v1";
const WEB_SEARCH_DEEP_KEY = "cfw_web_search_deep_v1";

/** Storage port; structurally identical to prompt-profile's KvStorage. The wiring wraps localStorage. */
                                 
                                      
                                            
 

/** Effective state of the card, after normalization. */
                                 
                   
                
 

                                       
                                                                                   
                         
                                                                         
                                               
                                                                                   
                                       
                                                                                   
                                 
                                                                                       
                                     
 

/** Strict "1" test — prompt-profile checks `read(key) === "1"` for both keys, no truthiness. */
function normalizeEnabled(raw               )          {
  return raw === "1";
}

/** Strict "1" test — the deep tier defaults off and treats every dirty value as off. */
function normalizeDeep(raw               )          {
  return raw === "1";
}

function createSettingsWebSearch(ports                )                       {
  /** Safe read: a throwing port reads as null, matching prompt-profile's per-call try/catch. */
  function readRaw(key        )                {
    try {
      return ports.getItem(key);
    } catch (e) {
      return null;
    }
  }

  /** Safe write: failures are swallowed, as in the old `catch (e) {}`. */
  function writeRaw(key        , value        )       {
    try {
      ports.setItem(key, value);
    } catch (e) {}
  }

  function read()                 {
    return {
      enabled: normalizeEnabled(readRaw(WEB_SEARCH_KEY)),
      deep: normalizeDeep(readRaw(WEB_SEARCH_DEEP_KEY)),
    };
  }

  function write(enabled         , deep         )       {
    writeRaw(WEB_SEARCH_KEY, enabled ? "1" : "0");
    // The invariant prompt-profile relies on: a deep flag is only meaningful with search on.
    writeRaw(WEB_SEARCH_DEEP_KEY, enabled && deep ? "1" : "0");
  }

  function writeEnabled(enabled         )       {
    if (enabled) write(true, read().deep);
    else write(false, false);
  }

  function writeDeep(deep         )       {
    const state = read();
    write(state.enabled, deep);
  }

  function payload()                          {
    const state = read();
    if (!state.enabled) return {};
    return { webSearch: true, webSearchDeep: state.deep };
  }

  return { read: read, write: write, writeEnabled: writeEnabled, writeDeep: writeDeep, payload: payload };
}

// Browser wiring for services/ui/settings-web-search.ts: localStorage as the injected port and
// the non-`__` global. The two-key normalization (strict === "1", master-off clears deep) lives
// in the emitted TS product and is shared with prompt-profile's read side via an equivalence lock.
(function () {
  window.settingsWebSearch = createSettingsWebSearch({
    getItem: function (key) {
      try { return window.localStorage.getItem(key); } catch (e) { return null; }
    },
    setItem: function (key, value) {
      try { window.localStorage.setItem(key, value); } catch (e) {}
    },
  });
})();

globalThis.WEB_SEARCH_KEY = WEB_SEARCH_KEY;
globalThis.WEB_SEARCH_DEEP_KEY = WEB_SEARCH_DEEP_KEY;
globalThis.normalizeEnabled = normalizeEnabled;
globalThis.normalizeDeep = normalizeDeep;
globalThis.createSettingsWebSearch = createSettingsWebSearch;
})();
