// ── Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name ──
// The implementation moved to services/agent/source-tools.ts. Ports are storage, the page hostname (for
// the loopback default) and fetch. The frozen surface keeps the four members plus `_keys` that the
// settings card reads.
(function (g) {
  "use strict";
  if (window.__sourceTools) return;
  var api = createSourceTools({
    storage: { getItem: function (key) { return g.localStorage.getItem(key); } },
    hostname: function () { try { return g.location.hostname; } catch (e) { return ""; } },
    fetch: function (url, init) { return g.fetch(url, init); },
  });
  window.__sourceTools = {
    defineTools: api.defineTools,
    enabled: api.enabled,
    base: api.base,
    artBase: api.artBase,
    _keys: api._keys,
  };
})(window);
