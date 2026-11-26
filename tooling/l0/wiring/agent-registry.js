// ── Browser wiring (injected by tooling/l0/emit.mjs): binds the service to the frozen window contract name ──
// The implementation moved to services/agent/registry.ts; this file only binds the name and injects
// ports. Eleven optional capabilities are fetched by name (the old code did global[s.key]), hence
// shell(key); coreTools returns the tools bundle directly — when it is missing the service call throws
// a TypeError on purpose, because that dependency is hard and must not degrade silently.
(function () {
  if (window.__agentRegistry && window.__agentRegistry.v === 1) return;
  window.__agentRegistry = createAgentRegistry({
    shell: function (key) { return window[key]; },
    envContext: function () { return window.__envContext; },
    coreTools: function () { return window.OwnChatTools; },
    storage: {
      getItem: function (key) { return window.localStorage.getItem(key); },
    },
  });
})();
