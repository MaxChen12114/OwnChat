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
