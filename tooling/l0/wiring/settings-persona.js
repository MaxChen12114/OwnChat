// Browser wiring for services/ui/settings-persona.ts: localStorage as the injected port and the
// non-`__` global. The missing-means-on default lives in the emitted TS product and is shared with
// engine/app.js through an equivalence lock.
(function (global) {
  "use strict";
  var api = createSettingsPersona({
    getItem: function (key) {
      try { return window.localStorage.getItem(key); } catch (e) { return null; }
    },
    setItem: function (key, value) {
      try { window.localStorage.setItem(key, value); } catch (e) {}
    },
  });
  api.KEY = USE_BUILTIN_KEY;
  global.settingsPersona = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
