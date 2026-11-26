(function () {
/**
 * Conversation auto-naming switches: a master toggle gates the AI-refine sub-toggle.
 *
 * The pair has deliberately mixed polarities — master stores "off" (`'1'` = off) because it
 * defaults on, the sub-toggle stores "on" (`'0'` = off, same default-on rule) — and the sub-toggle
 * is only usable while the master is on. The storage shape and the gating rule live here; the two
 * checkboxes stay in the settings wiring. `services/conv/autoname.ts` reads the same keys, so the
 * literals are a cross-module contract (pinned by the lock, like LS_SHELL).
 * @module services/ui/settings-autoname
 */

/** Master switch: `'1'` = auto-naming off (it defaults on). */
const AUTONAME_OFF_KEY = "cfw_autoname_off_v1";
/** AI refine sub-switch: `'0'` = AI refine off (also defaults on). */
const AUTONAME_AI_KEY = "cfw_autoname_ai_v1";

/** Storage port; the wiring wraps localStorage. */
                                
                                      
                                            
 

/** Public surface; the wiring assigns it to a non-`__` global. */
                              
                                                                                              
                                         
                                                                                        
                                                           
                                                                                                  
                               
 

/** Read the pair from storage under the two polarities. */
function readPair(offRaw               , aiRaw               )                                 {
  const on = offRaw !== "1";
  const aiOn = on && aiRaw !== "0";
  return { on: on, aiOn: aiOn };
}

/** Create the API. Unknown storage reads as "both on" — the documented defaults. */
function createAutoname(ports               )              {
  function read()                                 {
    return readPair(ports.getItem(AUTONAME_OFF_KEY), ports.getItem(AUTONAME_AI_KEY));
  }
  function writeMaster(on         )                                 {
    ports.setItem(AUTONAME_OFF_KEY, on ? "0" : "1");
    const next = read();
    if (!next.on) ports.setItem(AUTONAME_AI_KEY, "0");
    return read();
  }
  function writeAi(aiOn         )       {
    const cur = read();
    if (!cur.on) return;
    ports.setItem(AUTONAME_AI_KEY, aiOn ? "1" : "0");
  }
  return { read: read, writeMaster: writeMaster, writeAi: writeAi };
}

// Browser wiring for services/ui/settings-autoname.ts: localStorage side plus the non-`__` global.
(function () {
  window.settingsAutoname = createAutoname({
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

globalThis.AUTONAME_OFF_KEY = AUTONAME_OFF_KEY;
globalThis.AUTONAME_AI_KEY = AUTONAME_AI_KEY;
globalThis.readPair = readPair;
globalThis.createAutoname = createAutoname;
})();
