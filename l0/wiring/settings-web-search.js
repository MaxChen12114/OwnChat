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
