// Browser wiring (injected by tooling/l0/emit.mjs): binds the service to the frozen window contract name.
// The implementation lives in services/agent/call-loop.ts; this file only binds the name and
// injects ports. `retry` stays a function port because it must be resolved at `create()` time —
// the old code read the sibling module there too, and the retry service may load later.
(function () {
  if (window.__callLoop && window.__callLoop.v === 1) return;
  window.__callLoop = createCallLoop({
    retry: function () { return window.__retry; },
    abortController: function () { return window.AbortController; },
  });
})();
