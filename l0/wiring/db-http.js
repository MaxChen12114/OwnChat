// Browser wiring, appended by l0/emit.mjs. Engine: services/platform/db-http.ts (the one HTTP port
// implementation D1 and the Node sidecar both build on).
//
// Public API: window.dbHttp = { v, createHttpDbPort }. The two adapters normally consume the factory
// through the emitter's bare-name bridge; publishing it here as well keeps a page that only wants an
// ad-hoc HTTP port (a diagnostics panel, a test harness) from depending on load order.
(function (g) {
  "use strict";
  if (g.dbHttp) return;
  g.dbHttp = { v: 1, createHttpDbPort: createHttpDbPort };
})(window);
