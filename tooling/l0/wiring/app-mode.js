// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/conv/app-mode.ts; this file only carries
// the frozen global surface (create plus the two pure helpers the tests and callers import).
(function (global) {
  "use strict";
  if (global.__appMode) return;

  global.__appMode = {
    create: function (host) { return createAppMode(host || {}); },
    decidePayload: decidePayload,
    norm: normMode,
    WORK: MODE_WORK,
    RP: MODE_RP,
    LS_MODE: APP_MODE_LS_KEY,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
