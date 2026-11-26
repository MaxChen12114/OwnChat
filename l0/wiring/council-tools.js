// ── Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name ──
// The implementation moved to services/agent/council-tools.ts. Ports are storage (the address override),
// fetch, and the content panel (used to mirror a thread into the discussion view).
(function (g) {
  "use strict";
  if (window.__councilTools) return;
  var api = createCouncilTools({
    storage: { getItem: function (key) { return g.localStorage.getItem(key); } },
    fetch: function (url, init) { return g.fetch(url, init); },
    panel: function () { return window.panelSvc || null; },
  });
  window.__councilTools = { defineTools: api.defineTools, __v: 1 };
})(window);
