// Browser wiring, appended by l0/emit.mjs. Engine: services/platform/db-tauri.ts.
//
// The invocation is resolved per call, not captured: the shell may inject `__TAURI__` after this
// script runs, and `tauriSvc.invoke` already rejects with a readable error when the shell is absent.
// Callers may also hand in their own `opts.invoke` (tests, a future native bridge) and that wins.
(function (g) {
  "use strict";
  if (!g.dbSvc || typeof g.dbSvc.register !== "function") {
    throw new Error("db-tauri: window.dbSvc is missing (load /services/platform/db.js first)");
  }
  g.dbSvc.register("tauri", function (opts) {
    var chosen = opts && typeof opts.invoke === "function" ? opts.invoke : null;
    var invoke = chosen || function (cmd, args) {
      var t = g.tauriSvc;
      if (!t || typeof t.invoke !== "function") {
        return Promise.reject(new Error("db-tauri: window.tauriSvc.invoke is unavailable"));
      }
      return t.invoke(cmd, args);
    };
    return createTauriPort({ invoke: invoke });
  });
})(window);
