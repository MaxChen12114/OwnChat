(function () {
/**
 * The single owner of cfw_prompt_presets_v1 — the instruction modules shared by the prompt editor
 * and the agent's manage_preset tool.
 *
 * The bug this removes: the tool used to write the key with a bare localStorage.setItem and never
 * nudged cloud sync, while the editor did markDirty + a delayed pushNow. An agent-created preset
 * could therefore stay only on the device. Both writers now go through the same `save`, whose
 * onSave port is implemented once in tooling/l0/wiring/presets.js as that touchSync nudge.
 *
 * Normalization is absorbed from services/ui/prompt-editor.ts (pePresetsFrom): a non-array is empty,
 * unnamed rows are dropped, and missing fields take the row index / empty-string / false defaults.
 * The tool used to accept raw rows instead, so a malformed row could reach the model unchanged.
 *
 * No window, no document, no localStorage here: storage and the save notification arrive through
 * {@link PresetPorts}. The factory is exported so emit bridges it to globalThis; the wiring builds
 * the one browser instance and publishes it as `window.presetStore`.
 * @module services/data/presets
 */

/** The one localStorage key this service owns. */
const PRESETS_KEY = "cfw_prompt_presets_v1";

/** Key-value storage port; the adapter wraps localStorage, tests wrap a Map. */
                            
                                      
                                            
 

                              
                     
                                                                                            
                 
 

/** One normalized instruction module (the editor's PresetEntry shape). */
                              
             
               
                  
                   
                
                
               
                      
                 
                  
               
               
                       
 

                              
                        
                                                           
                                  
                
                                                                                       
                                     
                                                                                                       
                                   
                                                         
                                                                            
 

function recOf(v         )                          {
  const out                          = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

function arrOf(v         )            {
  return Array.isArray(v) ? v : [];
}

/** Only real strings pass; numbers, booleans and null become "". Same rule as the editor engine. */
function strOf(v         )         {
  return typeof v === "string" ? v : "";
}

/** The editor's pePresetsFrom rule, verbatim: index is the raw-array index, dropped rows included. */
function normalizePresets(raw         )                {
  const out                = [];
  arrOf(raw).forEach((row, i) => {
    const r = recOf(row);
    const name = strOf(r["name"]);
    if (!name) return;
    out.push({
      id: strOf(r["id"]) || "preset-" + String(i),
      name,
      content: strOf(r["content"]),
      enabled: r["enabled"] === true,
      order: typeof r["order"] === "number" ? r["order"] : i,
      group: strOf(r["group"]),
      lang: strOf(r["lang"]),
      description: strOf(r["description"]),
      source: strOf(r["source"]),
      license: strOf(r["license"]),
      note: strOf(r["note"]),
      file: strOf(r["file"]),
      fromLibrary: r["fromLibrary"] === true,
    });
  });
  return out;
}

function createPresetStore(ports             )              {
  return {
    load() {
      try {
        return normalizePresets(JSON.parse(ports.storage.getItem(PRESETS_KEY) || "null"));
      } catch (e) {
        return [];
      }
    },
    save(list) {
      try {
        ports.storage.setItem(PRESETS_KEY, JSON.stringify(list));
      } catch (e) {}
      // Outside the try on purpose: even a failed write must announce the change, as the editor did.
      ports.onSave();
    },
    uid() {
      return "preset-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
    },
    order(list) {
      return list.reduce((m, x) => Math.max(m, x.order || 0), -1) + 1;
    },
    preview(content) {
      return (content || "").slice(0, 80);
    },
    toggle(list, id, enabled) {
      const set = typeof enabled === "boolean" ? enabled : undefined;
      return list.map((p) => (p.id === id ? { ...p, enabled: set === undefined ? !p.enabled : set } : p));
    },
  };
}

// Browser wiring for services/data/presets.ts: the only place that touches localStorage and the
// sync bridge for cfw_prompt_presets_v1. The one store is published as `window.presetStore` (a
// non-`__` name on purpose: the frozen window.__* contract surface must not grow). Both the agent
// tool and the prompt-editor adapter consume this facade instead of keeping their own load/save/uid.
//
// touchSync used to live in tooling/l0/wiring/prompt-editor.js and only ran on the editor's save path. Moving
// it here makes the agent's save take the same markDirty + 1.2s pushNow path — that is the bug fix.
(function () {
  if (window.presetStore) return;

  var storage = {
    getItem: function (key) {
      try { return window.localStorage.getItem(key); } catch (e) { return null; }
    },
    setItem: function (key, value) {
      try { window.localStorage.setItem(key, value); } catch (e) {}
    },
  };

  var presetSyncTimer = null;

  /**
   * Prompt assets live under cfw_prompt_presets_v1, which sync.js normally pushes on its own
   * debounce. In the phone shell the page can be left before that fires, so announce the change and
   * push shortly after: markDirty now, pushNow in 1.2s (the delay lets a burst of saves coalesce).
   */
  function touchSync() {
    try {
      if (!window.syncSvc) return;
      if (typeof window.syncSvc.markDirty === "function") window.syncSvc.markDirty();
      if (presetSyncTimer) clearTimeout(presetSyncTimer);
      presetSyncTimer = setTimeout(() => {
        presetSyncTimer = null;
        try {
          if (window.syncSvc && typeof window.syncSvc.pushNow === "function") window.syncSvc.pushNow();
        } catch (e) {}
      }, 1200);
    } catch (e) {}
  }

  window.presetStore = createPresetStore({ storage: storage, onSave: touchSync });
})();

globalThis.PRESETS_KEY = PRESETS_KEY;
globalThis.createPresetStore = createPresetStore;
})();
