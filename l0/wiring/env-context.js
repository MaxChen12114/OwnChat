// ── Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name ──
// The implementation moved to services/agent/env-context.ts. Ports are the global reader plus the four
// platform probes it inspects (navigator / screen / location / fetch) and Storage.prototype.setItem,
// which the sync module is expected to have wrapped.
(function (g) {
  "use strict";
  var api = createEnvContext({
    read: function (key) { return g[key]; },
    appVersion: function () {
      try { return document.documentElement.dataset.appVersion || ""; } catch (e) { return ""; }
    },
    fetch: function () { return g.fetch; },
    storageSetItem: function () { try { return g.Storage.prototype.setItem; } catch (e) { return null; } },
    navigator: function () { try { return g.navigator || null; } catch (e) { return null; } },
    screen: function () { try { return g.screen || null; } catch (e) { return null; } },
    location: function () { try { return g.location || null; } catch (e) { return null; } },
  });
  window.__envContext = {
    build: api.build,
    loadOrderCheck: api.loadOrderCheck,
    snapshotText: api.snapshotText,
    defineTools: api.defineTools,
  };
})(window);
