// ── Browser wiring (injected by tooling/l0/emit.mjs): binds the service to the frozen window contract name ──
// Content-canvas tools: the five tool texts and every result wording live in
// services/ui/stage-tools.ts, so this file owns only the facade lookup. The panel is probed on
// every call rather than snapshotted at load, because it mounts after boot on desktop and never on
// mobile — a cached "absent" would keep the group unregistered for the whole session. Registration
// itself is a no-op without a canvas, the same rule the sibling tool groups follow.
(function () {
  if (window.__stageTools) return;

  function panel() {
    return (window.panelSvc && window.panelSvc.v === 1) ? window.panelSvc : null;
  }

  var svc = createStageTools({ panel: panel });

  window.__stageTools = { defineTools: svc.defineTools, __v: 1 };
})();
