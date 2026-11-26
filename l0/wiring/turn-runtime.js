// Browser adapter, appended by l0/emit.mjs. Engine: services/agent/turn-runtime.ts; this file is
// the frozen global name and nothing else.
//
// The name and the `v === 1` guard are load-bearing: app.js calls create() at the top of its file, and
// host-api.compat exposes this same name to the sandboxed kernel.
(function (global) {
  "use strict";
  if (global.turnRuntimeSvc && global.turnRuntimeSvc.v === 1) return;

  global.turnRuntimeSvc = {
    v: 1,
    create(host) {
      return createTurnRuntime(host || {});
    },
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
