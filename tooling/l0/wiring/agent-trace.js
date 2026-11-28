// ── Browser wiring (injected by tooling/l0/emit.mjs): binds the service to the frozen window contract name ──
// The implementation moved to services/agent/trace.ts; this file only binds the name and injects the
// IndexedDB factory. The factory is looked up lazily, once, on the first open — never captured at
// load time, because a host with IndexedDB blocked must still boot and fall back to the memory map.
(function (global) {
  if (global.__agentTrace) return;
  global.__agentTrace = createAgentTrace({
    idb: function () {
      return typeof indexedDB === "undefined" ? null : indexedDB;
    },
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
