// Browser wiring, appended by tooling/l0/emit.mjs. Engine: services/platform/db-d1.ts.
//
// Registers, does not activate: the facade decides at first use. A missing facade is a load-order
// bug (this file must follow /services/platform/db.js), and throwing here is the only way it stays
// visible — returning quietly would leave "d1" unregistered and every later get() failing with a
// misleading "unknown adapter".
(function (g) {
  "use strict";
  if (!g.dbSvc || typeof g.dbSvc.register !== "function") {
    throw new Error("db-d1: window.dbSvc is missing (load /services/platform/db.js first)");
  }
  g.dbSvc.register("d1", function () { return createD1Port(); });
})(window);
