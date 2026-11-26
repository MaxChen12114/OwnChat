(function () {
/**
 * The single HTML escaper.
 *
 * Before 2026-11-08 there were fifteen-plus hand-rolled `esc` / `safe` helpers and they had drifted:
 * the multi-agent one did not escape double quotes, which let a role name break out of an attribute.
 * Everything now comes from here, and the set is fixed: `& < > " '`.
 *
 * Quotes are escaped for **both** text and attributes. In text they render identically after escaping,
 * so one function is enough — and having only one is the point.
 *
 * Lock: `test/escape.test.mjs`.
 * @module core/escape
 */

const ESCAPE_MAP                         = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes the five HTML-significant characters; null/undefined become "". */
function esc(value         )         {
  return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
    return ESCAPE_MAP[c];
  });
}

                            
                              
 

function createEscape()            {
  return { esc: esc };
}

// ── Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name ──
// The implementation moved to services/core/escape.ts. No ports: the escaper is pure string work.
(function (g) {
  "use strict";
  if (window.escapeSvc) return;
  window.escapeSvc = createEscape();
})(window);

globalThis.esc = esc;
globalThis.createEscape = createEscape;
})();
