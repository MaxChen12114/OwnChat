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
 * Layer: `lib/` — pure string work; no DOM, no IO, no domain meaning. It is the shared floor every
 * renderer calls, which is exactly the `lib/` contract (as opposed to `core/`, which holds contracts
 * and the runtime).
 *
 * Lock: `test/markdown.test.mjs` and `test/chat-migration-equiv.test.mjs`, both byte-read the emitted
 * `public/shared/lib/escape.js`.
 * @module lib/escape
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
// The implementation lives in lib/escape.ts (pure string work; moved out of core/ in the 2026-11-28
// boundary split). No ports: the escaper is pure string work.
(function (g) {
  "use strict";
  if (window.escapeSvc) return;
  window.escapeSvc = createEscape();
})(window);

globalThis.esc = esc;
globalThis.createEscape = createEscape;
})();
