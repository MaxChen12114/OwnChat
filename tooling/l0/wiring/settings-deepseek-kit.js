// Browser wiring for services/ui/settings-deepseek-kit.ts: localStorage as the injected port and
// the non-`__` global. The two keys and the literal "1" comparison stay in the emitted TS product.
(function (global) {
  "use strict";
  var api = createSettingsDeepSeekKit({
    getItem: function (key) {
      try { return window.localStorage.getItem(key); } catch (e) { return null; }
    },
    setItem: function (key, value) {
      try { window.localStorage.setItem(key, value); } catch (e) {}
    },
  });
  api.KEYS = DEEPSEEK_KIT_KEYS;
  global.settingsDeepSeekKit = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
