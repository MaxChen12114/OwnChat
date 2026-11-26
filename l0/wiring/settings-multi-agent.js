// Browser wiring for services/ui/settings-multi-agent.ts: localStorage as the injected port and
// the non-`__` global. The six keys, their defaults and clamp ranges live in the emitted service and
// are shared with peer-calls' read side via an equivalence lock. The switch/cap loops stay in the
// settings card; only storage IO is injected here.
(function () {
  window.settingsMultiAgent = createSettingsMultiAgent({
    getItem: function (key) {
      try { return window.localStorage.getItem(key); } catch (e) { return null; }
    },
    setItem: function (key, value) {
      try { window.localStorage.setItem(key, value); } catch (e) {}
    },
  });
})();
