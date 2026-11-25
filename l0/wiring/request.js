// Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name.
// The implementation lives in services/chat/request.ts. `replyStyle` used to read localStorage
// inline with a try/catch falling back to "default"; that read now lives here as a port, still
// resolved per call rather than captured.
(function () {
  if (window.__request && window.__request.v === 1) return;
  var ports = {
    replyStyle: function () {
      try { return window.localStorage.getItem("cfw_reply_style_v1") || "default"; }
      catch (e) { return "default"; }
    },
  };
  window.__request = {
    v: 1,
    agentBody: function (s) { return agentBody(s, ports); },
  };
})();
