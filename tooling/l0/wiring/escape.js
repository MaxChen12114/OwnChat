// ── Browser wiring (injected by tooling/l0/emit.mjs): binds the service to the frozen window contract name ──
// The implementation lives in lib/escape.ts (pure string work; moved out of core/ in the 2026-11-28
// boundary split). No ports: the escaper is pure string work.
(function (g) {
  "use strict";
  if (window.escapeSvc) return;
  window.escapeSvc = createEscape();
})(window);
