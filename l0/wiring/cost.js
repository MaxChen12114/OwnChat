// Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name.
(function () {
  if (window.__costLedger) return;
  var ports = {
    storage: {
      getItem: function (key) { return window.localStorage.getItem(key); },
      setItem: function (key, value) { window.localStorage.setItem(key, value); },
    },
    builtinPricing: function () { return window.DEEPSEEK_PRICING || {}; },
    defaultPricing: function () { return window.DEEPSEEK_PRICING_DEFAULT || null; },
    onCostAdded: function () {
      if (window.__sync && window.__sync.markCostDirty) { try { window.__sync.markCostDirty(); } catch (e) {} }
    },
  };
  window.__costLedger = {
    formatTurnStats: formatTurnStats,
    formatAgentRoundStats: formatAgentRoundStats,
    create: function (host) { return createLedger(ports, host); },
  };
})();
