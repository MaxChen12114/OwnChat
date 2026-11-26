// ── Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name ──
// agent domain, eighth brick (2026-11-15): the orchestration moved to services/agent/peer-actions.ts.
// `app.js` still owns the page — rows, session, persistence, memory core — and hands all of it in as
// ports, so this file only binds the frozen name and guards a double install. Nothing to resolve
// here: unlike `peer-calls`, no port needs a window global of its own.
(function () {
  if (window.__peerActions && window.__peerActions.v === 1) return;

  window.__peerActions = {
    v: 1,
    create: function (host) {
      return createPeerActions(host || {});
    },
  };
})();
