// ── Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name ──
// The implementation moved to services/core/escape.ts. No ports: the escaper is pure string work.
(function (g) {
  "use strict";
  if (window.__ownEscape) return;
  window.__ownEscape = createEscape();
})(window);
