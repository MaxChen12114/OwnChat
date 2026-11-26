(function () {
/**
 * D1 adapter: the web deployment's DbPort. Same-origin `/api/data/*`, nothing else — the page's own
 * fetch wrapper adds the access token for `/api/*` (`services/auth/token.ts`), so this adapter must
 * stay relative. Prefixing an origin here would silently drop the Authorization header and turn
 * every call into a 401 that looks like "the data plane is off".
 *
 * The HTTP semantics live in `services/platform/db-http.ts`; this file only declares the D1 shape so
 * the facade can register it by name.
 * @module services/platform/db-d1
 */

                                            

                                                                            

/** Build the D1 port. Options are ignored on purpose: D1 is always same-origin. */
function createD1Port()         {
  return createHttpDbPort({ base: "" });
}

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

globalThis.createD1Port = createD1Port;
})();
