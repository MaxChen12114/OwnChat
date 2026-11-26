// Browser wiring for services/ui/settings-personalize.ts: localStorage, TextEncoder and the
// non-`__` global. The byte budget, trim rule and storage shape live in the emitted TS product.
(function () {
  window.settingsPersonalize = createPersonalize({
    getItem: function (key) {
      try { return window.localStorage.getItem(key); } catch (e) { return null; }
    },
    setItem: function (key, value) {
      try { window.localStorage.setItem(key, value); } catch (e) {}
    },
    removeItem: function (key) {
      try { window.localStorage.removeItem(key); } catch (e) {}
    },
    encode: function (text) {
      return new TextEncoder().encode(text);
    },
  });
})();
