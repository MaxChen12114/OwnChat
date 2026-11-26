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

const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes the five HTML-significant characters; null/undefined become "". */
export function esc(value: unknown): string {
  return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
    return ESCAPE_MAP[c];
  });
}

export interface EscapeApi {
  esc(value: unknown): string;
}

export function createEscape(): EscapeApi {
  return { esc: esc };
}
