// Browser wiring for services/memory/config.ts: localStorage as the injected port, and the API
// mounted on the existing __memCore facade (no new window.__* contract). Must load after
// memory/core.js, which owns that facade object.
(function () {
  var api = createMemConfig({
    getItem: function (key) { try { return window.localStorage.getItem(key); } catch (e) { return null; } },
    setItem: function (key, value) { try { window.localStorage.setItem(key, value); } catch (e) {} },
  });
  if (window.__memCore) window.__memCore.config = api;
  else window.__memCore = { config: api };
})();
