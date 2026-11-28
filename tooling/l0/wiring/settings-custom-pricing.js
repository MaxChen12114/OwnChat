// Browser wiring for services/ui/settings-custom-pricing.ts: localStorage as the injected port and
// the non-`__` global. The pricing table guard and price validation live in the emitted service and
// are shared with the cost ledger's read side via an equivalence lock. The card DOM stays in settings.js.
(function () {
  window.settingsCustomPricing = createSettingsCustomPricing({
    getItem: function (key) {
      try { return window.localStorage.getItem(key); } catch (e) { return null; }
    },
    setItem: function (key, value) {
      try { window.localStorage.setItem(key, value); } catch (e) {}
    },
  });
})();
