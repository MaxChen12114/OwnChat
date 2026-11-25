// ── Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name ──
// The implementation moved to services/agent/job-tools.ts. Ports are storage (the config, which holds
// the shared secret), fetch, the toast host, the `cfw:job` event and the content panel.
(function (g) {
  "use strict";
  var api = createJobTools({
    storage: { getItem: function (key) { return g.localStorage.getItem(key); } },
    fetch: function (url, init) { return g.fetch(url, init); },
    toast: function (msg, ms) {
      try { if (window.__feedback && typeof window.__feedback.toast === "function") window.__feedback.toast(msg, { ms: ms }); } catch (e) {}
    },
    notify: function (detail) {
      try { g.dispatchEvent(new CustomEvent("cfw:job", { detail: detail })); } catch (e) {}
    },
    panel: function () { return window.__panel || null; },
  });
  window.__jobTools = {
    defineTools: api.defineTools,
    readConfig: api.readConfig,
    configured: api.configured,
    submit: api.submit,
    test: api.test,
    pollJob: api.pollJob,
    _consumeView: api.consumeView,
    _resolveArtifactsUrl: api.resolveArtifactsUrl,
    __v: 1,
  };
})(window);
