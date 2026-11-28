// Browser wiring, appended by tooling/l0/emit.mjs. Engine: services/platform/db.ts (the DbPort facade).
//
// Public API: window.dbSvc = { v, context, register, use, get, adapter, exec, tx, search }.
// `context` is the root runtime context that holds the `db` service — T4-A injects from it instead
// of importing an adapter. The shell probe is the only shell knowledge in this file: a hostile or
// absent `tauriSvc` must read as "no shell", and the facade then picks D1.
(function (g) {
  "use strict";
  if (g.dbSvc) return;

  function shellAvailable() {
    try {
      var t = g.tauriSvc;
      return !!(t && typeof t.available === "function" && t.available() && typeof t.invoke === "function");
    } catch (e) {
      return false;
    }
  }

  g.dbSvc = createDbFacade({ shellAvailable: shellAvailable, fallback: "d1" });
})(window);
