// Browser wiring (injected by tooling/l0/emit.mjs): binds the service to the frozen window contract name.
// Every module bridge is resolved per call, never captured: the kernel, events, console and
// character memory are globals assembled earlier in boot and can still be missing here. The
// `__context` instance (which closes over the app) and the permission-card policy arrive through
// `host` instead — they are page state, not platform surface.
(function () {
  if (window.__agentTurn) return;
  var ports = {
    kernel: function () { return window.AgentKernel || null; },
    callLoop: function () { return window.__callLoop || null; },
    events: function () { return window.__agentEvents || null; },
    console: function () { return window.agentConsoleSvc || null; },
    charMemory: function () { return window.__charMemory || null; },
    // L1/L2 memory facade: the turn-end auto writer reads cfw_mem_auto_v1 and calls remember().
    memory: function () { return window.__memCore || null; },
    feedback: function () { return window.feedbackSvc || null; },
    // B2 C-3: the tool-mode runtime (policy domain). Absent product → null → full mode, no tool_search.
    toolMode: function () { try { return window.toolModeSvc || null; } catch (e) { return null; } },
    // T4-A: the scoped tool pipeline. Absent product → the kernel gets the app-built registry as-is.
    toolRuntime: function () { try { return window.toolRuntimeSvc || null; } catch (e) { return null; } },
    visionOn: function () {
      try { return !!window.__agentVisionOn; } catch (e) { return false; }
    },
  };
  window.__agentTurn = {
    create: function (o) { return createAgentTurn(ports, o); },
  };
})();
