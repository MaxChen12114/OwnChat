// ── Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name ──
// The implementation moved to services/agent/events.ts. That module has no environment of its own (all
// nine capabilities come in through create(host)), so here we only bind the frozen name and guard
// against a double install — no ports to inject.
(function () {
  if (window.__agentEvents && window.__agentEvents.v === 1) return;
  window.__agentEvents = createAgentEvents();
})();
