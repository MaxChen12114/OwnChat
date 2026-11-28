// Browser wiring for services/session/events.ts (T3-D): the event truth + projection service.
//
// Public API: window.sessionEventsSvc (non-`__` on purpose; contracts.json tracks `__*` only).
// The db getter is late-bound: this script loads before the app, but the facade is already loaded
// and answers on first use. Every method surfaces its own `{ok:false,error}` instead of throwing
// into a sync caller, except the read projections (derive/replay catch their own failures).
(function (g) {
  "use strict";
  if (g.sessionEventsSvc) return;

  function db() {
    var svc = g.dbSvc;
    if (!svc || typeof svc.get !== "function") throw new Error("session-events: dbSvc 未加载");
    return svc.get();
  }

  g.sessionEventsSvc = createSessionEvents({
    db: db,
    now: function () { return Date.now(); },
  });
})(typeof window !== "undefined" ? window : globalThis);
