// Browser wiring for services/ui/settings-gen-params.ts: localStorage side plus the non-`__` global
// the settings card calls. Kept off the frozen `window.__*` surface on purpose.
(function () {
  window.settingsGenParams = createGenParams({
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
