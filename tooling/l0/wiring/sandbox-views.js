// Browser wiring for services/sandbox/views.ts: the only IO is the configured
// sandbox root URL (localStorage) and the page origin. Every URL rule, parameter
// check and warning string lives in the emitted service; this file only mounts
// the non-`__` global for later panel wiring.
(function (global) {
  "use strict";
  var views = createSandboxViews({
    getBaseUrl: function () {
      try {
        return window.localStorage.getItem(SANDBOX_BASE_KEY);
      } catch (e) {
        return null;   // storage blocked: degrade to "not configured", never throw at boot
      }
    },
    origin: typeof location !== "undefined" && location.origin ? location.origin : "",
  });
  global.sandboxViews = views;
})(typeof globalThis !== "undefined" ? globalThis : this);
