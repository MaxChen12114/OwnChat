// Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name.
//
// T4-A: mounted as a runtime plugin (`ctx.plugin`) so the ledger's provider has a lifecycle. The
// plugin injects `db` — the ledger writes through localStorage today, but the cost aggregates are
// the first thing a host wants to read from the unified store, and declaring the dependency now is
// what keeps that switch a provider change instead of a call-site sweep. The frozen
// `window.__costLedger` stays a façade over the same object; `dispose` clears it unless someone
// replaced it (a remount owns the name, not this instance).
(function () {
  "use strict";
  var HOST = (typeof window !== "undefined" && window.runtimeCore && window.runtimeCore.host) || null;

  function apply(ctx) {
    if (window.__costLedger) return function () {};
    var db = ctx && typeof ctx.get === "function" ? ctx.get("db") : null;
    var ports = {
      storage: {
        getItem: function (key) { return window.localStorage.getItem(key); },
        setItem: function (key, value) { window.localStorage.setItem(key, value); },
      },
      builtinPricing: function () { return window.DEEPSEEK_PRICING || {}; },
      defaultPricing: function () { return window.DEEPSEEK_PRICING_DEFAULT || null; },
      onCostAdded: function () {
        if (window.syncSvc && window.syncSvc.markCostDirty) { try { window.syncSvc.markCostDirty(); } catch (e) {} }
      },
    };
    var api = {
      v: 1,
      formatTurnStats: formatTurnStats,
      formatAgentRoundStats: formatAgentRoundStats,
      create: function (host) { return createLedger(ports, host); },
    };
    window.__costLedger = api;
    // The service half: other plugins inject the factory, never the window name.
    if (ctx && typeof ctx.provide === "function") {
      ctx.provide("cost", {
        v: 1,
        db: db,
        create: api.create,
        formatTurnStats: formatTurnStats,
        formatAgentRoundStats: formatAgentRoundStats,
      });
    }
    return function dispose() {
      if (window.__costLedger === api) {
        try { delete window.__costLedger; } catch (e) { window.__costLedger = undefined; }
      }
    };
  }

  var mod = { name: "cost", inject: ["db"], apply: apply };
  if (HOST) {
    HOST.define("cost", mod);
    HOST.start("cost");
    return;
  }
  // No runtime host (a stripped build): mount exactly as before and keep the façade.
  apply({ get: function () { return null; }, provide: function () {} });
})();
