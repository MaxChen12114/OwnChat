// ── Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name ──
// The implementation moved to services/agent/agent-local-tools.ts. The only port is the Tauri invoke,
// resolved per call: the shell may inject `__TAURI__` after this script, and registration happens when
// the agent registry is built rather than at load time.
(function (g) {
  "use strict";
  var api = createAgentLocalTools({
    invoke: function () {
      return window.tauriSvc ? window.tauriSvc.invokeOrNull() : null;
    },
  });
  window.AgentLocalTools = { defineTools: api.defineTools, isDesktop: api.isDesktop };
})(window);
