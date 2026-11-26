// ── Browser wiring (injected by l0/emit.mjs): binds the service to the frozen contract name ──
// The implementation moved to services/agent/agent-kernel.ts; this file only republishes the four
// names as one object, which is the shape every existing caller reads. The dot-prefixed form is what
// contract scanning measures — an alias through a local variable would report the name as dead.
(function () {
  window.AgentKernel = {
    createToolRegistry: createToolRegistry,
    runAgentLoop: runAgentLoop,
    isRunning: isRunning,
    pairPendingToolCalls: pairPendingToolCalls,
  };
})();
