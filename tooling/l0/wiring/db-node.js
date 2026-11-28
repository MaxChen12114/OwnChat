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
