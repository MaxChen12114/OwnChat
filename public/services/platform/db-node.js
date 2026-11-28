(function () {
/**
 * Node-sidecar adapter: DbPort over an absolute origin, with the optional bearer token the
 * sidecar's `checkAuth` reads. Structurally identical to the D1 adapter (both are
 * `services/platform/db-http.ts`), and that is the point: the SQL, the wire format and the
 * transaction shape are one implementation, so a sidecar bug cannot hide behind "different code".
 *
 * Why a base is mandatory: the sidecar is a separate origin from the page (or the page is served by
 * it and the D1 adapter already covers that case). Defaulting to something would make a
 * misconfiguration look like a working local database — the worst possible failure mode for storage.
 * @module services/platform/db-node
 */

                                            

                                                                            

/** Options the facade's `use("node", opts)` passes through. */
                                
                                                                
                         
                                                                                      
                          
 

/** Object view without an assertion. */
function isRecord(value         )                                   {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Build the sidecar port.
 * @throws when `base` is missing or not absolute — a typo must not degrade into "same origin".
 */
function createNodePort(options          )         {
  const rec = isRecord(options) ? options : {};
  const base = typeof rec.base === "string" ? rec.base.trim() : "";
  if (!base) throw new Error('db-node: base is required (sidecar origin, e.g. "http://127.0.0.1:8787")');
  const token = typeof rec.token === "string" ? rec.token : "";
  return createHttpDbPort({ base: base, token: token });
}

// Browser wiring, appended by tooling/l0/emit.mjs. Engine: services/platform/db-node.ts.
//
// Registers the sidecar adapter. It is never boot-selected: a page cannot know whether a sidecar
// exists without probing, and a failed probe must not read as "this deployment has no storage".
// T4-B's host picker (or a test) calls dbSvc.use("node", { base, token }) explicitly.
(function (g) {
  "use strict";
  if (!g.dbSvc || typeof g.dbSvc.register !== "function") {
    throw new Error("db-node: window.dbSvc is missing (load /services/platform/db.js first)");
  }
  g.dbSvc.register("node", function (opts) { return createNodePort(opts); });
})(window);

globalThis.createNodePort = createNodePort;
})();
