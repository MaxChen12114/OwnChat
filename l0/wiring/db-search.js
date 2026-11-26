// Browser wiring, appended by l0/emit.mjs. Engine: core/db-search.ts (surface + scope + q → SQL).
//
// Public API: window.dbSearchSql = { v, SEARCH_SURFACES, limits, buildSearchQuery, likePattern,
// ftsPhrase, codePointLength }. The Tauri adapter (no server to ask) and the tests read the builder
// here; the HTTP adapters only use it to normalise what they put on the query string.
(function (g) {
  "use strict";
  if (g.dbSearchSql) return;
  g.dbSearchSql = {
    v: 1,
    SEARCH_SURFACES: SEARCH_SURFACES,
    DEFAULT_SEARCH_LIMIT: DEFAULT_SEARCH_LIMIT,
    MAX_SEARCH_LIMIT: MAX_SEARCH_LIMIT,
    MAX_QUERY_CHARS: MAX_QUERY_CHARS,
    MAX_SCOPE_CHARS: MAX_SCOPE_CHARS,
    buildSearchQuery: buildSearchQuery,
    clampSearchLimit: clampSearchLimit,
    likePattern: likePattern,
    ftsPhrase: ftsPhrase,
    codePointLength: codePointLength,
  };
})(window);
