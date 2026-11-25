// Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name.
// The implementation lives in services/data/lorebook.ts; every window bridge is here — the
// localStorage trio, change-event dispatch, and the clock / random source for uid generation.
// The old module reached for localStorage and dispatchEvent inline; the service now takes them as
// ports, and the same semantics move to this file unchanged.
(function () {
  if (window.__lorebook) return;

  var storage = {
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
  };

  var api = createLorebook({
    storage: storage,
    // The editor's world-building tab listens for this event and repaints. A failed dispatch must not
    // fail the save that triggered it.
    notify: function () {
      try {
        window.dispatchEvent(new Event("lorebook:changed"));
      } catch (e) {}
    },
    now: function () {
      return Date.now();
    },
    random: function () {
      return Math.random();
    },
  });

  window.__lorebook = {
    getAll: api.getAll,
    getEntry: api.getEntry,
    saveEntry: api.saveEntry,
    deleteEntry: api.deleteEntry,
    getActiveEntries: api.getActiveEntries,
    exportAll: api.exportAll,
    importAll: api.importAll,
    parseSillyTavernBook: api.parseSillyTavernBook,
    LS_KEY: api.LS_KEY,
  };
})();
