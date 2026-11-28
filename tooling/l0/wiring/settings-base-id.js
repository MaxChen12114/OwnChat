// Browser wiring for services/ui/settings-base-id.ts: localStorage as the injected port and the
// non-`__` global. The selection keys and their normalization live in the emitted TS product and
// are shared with prompt-profile via an equivalence lock. The two UI facades
// (__baseSwitchMode / escapeSvc) stay in settings.js — they are actions, not data.
(function () {
  var api = createSettingsBaseId({
    getItem: function (key) {
      try { return window.localStorage.getItem(key); } catch (e) { return null; }
    },
    setItem: function (key, value) {
      try { window.localStorage.setItem(key, value); } catch (e) {}
    },
    removeItem: function (key) {
      try { window.localStorage.removeItem(key); } catch (e) {}
    },
  });
  // Keys are exposed once so the cards never re-spell a literal. Explicit list: emit does not
  // forward methods automatically (the 2026-11-21 reasoning knife hit exactly this).
  api.CUSTOM_ID_KEY = CUSTOM_ID_KEY;
  api.BASE_ID_KEY = BASE_ID_KEY;
  api.NEUTRAL_ID_KEY = NEUTRAL_ID_KEY;
  api.BASE_REGISTRY_KEY = BASE_REGISTRY_KEY;
  window.settingsBaseId = api;
})();
