// Browser wiring (injected by tooling/l0/emit.mjs): binds the conversation lifecycle engine to its frozen
// global name. Feature checks for cross-module calls (chat realtime, chat events, character cards,
// agent workspace, agent steps) live here; conversation semantics live in the engine.
(function () {
  if (window.__convLifecycle) return;
  window.__convLifecycle = {
    create: function (ports) { return createLifecycle(ports || {}); },
  };
})();
