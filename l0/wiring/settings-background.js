// Browser wiring for services/ui/settings-background.ts: localStorage, the theme re-apply hook and
// the non-`__` global. Slider parsing, labels and key-deletion rules live in the emitted TS product.
(function () {
  window.settingsBackground = createBackground({
    getItem: function (key) {
      try { return window.localStorage.getItem(key); } catch (e) { return null; }
    },
    setItem: function (key, value) {
      try { window.localStorage.setItem(key, value); } catch (e) {}
    },
    removeItem: function (key) {
      try { window.localStorage.removeItem(key); } catch (e) {}
    },
    applyBg: function () {
      try { if (window.__theme && typeof window.__theme.applyBg === "function") window.__theme.applyBg(); } catch (e) {}
    },
  });
})();
