// Browser wiring for services/agent/tool-runtime.ts: the per-turn compiled tool set and its
// pre/execute/post pipeline. The registry, the scope and the hooks all arrive from the caller
// (services/agent/turn.ts), so this file only publishes the factory and the pure selection rule.
(function () {
  if (window.toolRuntimeSvc && window.toolRuntimeSvc.v === 1) return;
  window.toolRuntimeSvc = {
    v: 1,
    create: createToolRuntime,
    compileToolSet: compileToolSet,
  };
})();
