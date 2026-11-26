// Browser wiring for services/ui/settings-toggles.ts: localStorage side plus the non-`__` global.
(function () {
  window.settingsToggles = createSettingsToggles({
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
