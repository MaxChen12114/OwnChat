(function () {
/**
 * The client half of the search contract: surface + scope + query → one SQL string, its bindings
 * and the mode that picked it.
 *
 * Why this exists at all: `src/data-api.js` owns the same decision on the server (HTTP adapters send
 * surface/scope/q and the server builds the SQL), but the Tauri adapter has no server to ask — it
 * must hand rusqlite exactly the SQL the server would have run. Keeping one table here and one
 * there would be two authorities for "what does 西墙 mean"; instead the SQL text is copied verbatim
 * from `src/data-api.js` and `test/db-port.test.mjs` runs both against the same SQLite database,
 * comparing set, order and mode. A change on either side of that pair turns the lock red.
 *
 * Rules (identical to the server, deliberately):
 *   · `tokenize='trigram'` cannot match fewer than three code points, so a short query falls back to
 *     a scope-filtered `LIKE '%q%'` with `ESCAPE '\'` — SQLite's own substring idiom, not a second
 *     index. Two-character Chinese words are the common case, so the fallback is not exotic;
 *   · user text is always one quoted FTS5 phrase (internal quotes doubled), so it can never become
 *     FTS5 syntax;
 *   · `limit` is clamped to 1..50 with a default of 8.
 *
 * Validation mirrors the server's 4xx answers as thrown errors: this module builds queries the
 * server would accept, and refuses locally what the server would refuse remotely.
 *
 * Layer: `lib/` — pure string building over two type names. The types themselves stay in `core/db.ts`
 * because they are the wire/port contract; a value-free `import type` across the boundary is the only
 * dependency this file has, and it disappears at emit.
 * @module lib/db-search
 */

                                                             

/** Server caps, repeated here so a local build fails before the request is sent. */
const MAX_QUERY_CHARS = 200;
const MAX_SCOPE_CHARS = 120;
const MAX_SEARCH_LIMIT = 50;
const DEFAULT_SEARCH_LIMIT = 8;

/** Per-surface SQL and the query-string name its scope travels under. */
                                    
                                      
                       
                        
                                                                                         
                               
 

/**
 * The three surfaces. SQL text is byte-identical to `src/data-api.js`'s SEARCH_SURFACES — that is
 * what makes the Tauri path agree with the HTTP path; do not reformat these strings.
 */
const SEARCH_SURFACES                                                     = {
  messages: {
    scopeParam: "conv",
    fts: "SELECT m.* FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid WHERE messages_fts MATCH ? AND m.conv_id = ? ORDER BY bm25(messages_fts) LIMIT ?",
    like: "SELECT m.* FROM messages m WHERE m.conv_id = ? AND m.content LIKE ? ESCAPE '\\' ORDER BY m.seq DESC LIMIT ?",
  },
  memory: {
    scopeParam: "cid",
    fts: "SELECT e.* FROM memory_fts JOIN epi e ON e.rowid = memory_fts.rowid WHERE memory_fts MATCH ? AND e.cid = ? ORDER BY bm25(memory_fts) LIMIT ?",
    like: "SELECT e.* FROM epi e WHERE e.cid = ? AND (e.what LIKE ? ESCAPE '\\' OR e.terms LIKE ? ESCAPE '\\') ORDER BY e.ts DESC LIMIT ?",
    likeRepeats: 2,
  },
  kb: {
    scopeParam: "cid",
    fts: "SELECT c.id, c.doc_id, c.cid, c.chunk, c.offset, c.ord, d.title FROM kb_fts JOIN kb_chunks c ON c.rowid = kb_fts.rowid JOIN kb_docs d ON d.id = c.doc_id WHERE kb_fts MATCH ? AND c.cid = ? ORDER BY bm25(kb_fts) LIMIT ?",
    like: "SELECT c.id, c.doc_id, c.cid, c.chunk, c.offset, c.ord, d.title FROM kb_chunks c JOIN kb_docs d ON d.id = c.doc_id WHERE c.cid = ? AND c.chunk LIKE ? ESCAPE '\\' ORDER BY c.ord DESC LIMIT ?",
  },
};

/** What a caller (the Tauri adapter, the tests, an explain panel) gets back. */
                                   
                       
                             
                                
                                  
                                      
                                                                                                
                         
                                                         
                     
                         
 

/** Escape LIKE wildcards so a literal `%` or `_` stays literal. Paired with `ESCAPE '\'`. */
function likePattern(q        )         {
  return "%" + String(q).replace(/[\\%_]/g, (c) => "\\" + c) + "%";
}

/** FTS5 phrase quoting: the whole query is one quoted token, internal quotes doubled. */
function ftsPhrase(q        )         {
  return '"' + String(q).replace(/"/g, '""') + '"';
}

/** Number of Unicode code points; FTS5 trigram needs at least three. */
function codePointLength(q        )         {
  return Array.from(String(q)).length;
}

/** `limit` clamp: blank/invalid → default, otherwise floor and clamp to 1..50. */
function clampSearchLimit(limit                         )         {
  if (limit === undefined || limit === null || String(limit).trim() === "") return DEFAULT_SEARCH_LIMIT;
  const n = Number(limit);
  if (!Number.isFinite(n)) return DEFAULT_SEARCH_LIMIT;
  return Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(n)));
}

/** Look up a surface spec, refusing unknown names the way the server answers 400. */
function specOf(surface               )                    {
  if (!Object.prototype.hasOwnProperty.call(SEARCH_SURFACES, String(surface))) {
    throw new Error("db-search: surface must be messages|memory|kb");
  }
  return SEARCH_SURFACES[surface];
}

/** Scope value for one surface, out of the `{conv, cid}` pair. Empty/oversized is an error. */
function scopeOf(spec                   , scope                         )         {
  const raw = scope === undefined || scope === null ? undefined : spec.scopeParam === "conv" ? scope.conv : scope.cid;
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) throw new Error("db-search: " + spec.scopeParam + " is required");
  if (value.length > MAX_SCOPE_CHARS) throw new Error("db-search: " + spec.scopeParam + " is too long");
  return value;
}

/**
 * Build the statement for one search.
 * @throws when the surface is unknown, the query or scope is empty, or the query is too long —
 *         the cases `src/data-api.js` answers with 400/413.
 */
function buildSearchQuery(
  surface               ,
  scope             ,
  q        ,
  limit                         ,
)                   {
  const spec = specOf(surface);
  const query = typeof q === "string" ? q.trim() : "";
  if (!query) throw new Error("db-search: q is required");
  if (query.length > MAX_QUERY_CHARS) throw new Error("db-search: q too long");
  const scopeValue = scopeOf(spec, scope);
  const clamped = clampSearchLimit(limit);
  const useFts = codePointLength(query) >= 3;
  const pattern = likePattern(query);
  const likeParams = spec.likeRepeats === 2 ? [scopeValue, pattern, pattern, clamped] : [scopeValue, pattern, clamped];
  return {
    sql: useFts ? spec.fts : spec.like,
    params: useFts ? [ftsPhrase(query), scopeValue, clamped] : likeParams,
    mode: useFts ? "fts" : "like",
    surface: surface,
    scopeParam: spec.scopeParam,
    scope: scopeValue,
    q: query,
    limit: clamped,
  };
}

// Browser wiring, appended by l0/emit.mjs. Engine: lib/db-search.ts (surface + scope + q → SQL; pure
// string building, moved out of core/ in the 2026-11-28 boundary split).
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

globalThis.MAX_QUERY_CHARS = MAX_QUERY_CHARS;
globalThis.MAX_SCOPE_CHARS = MAX_SCOPE_CHARS;
globalThis.MAX_SEARCH_LIMIT = MAX_SEARCH_LIMIT;
globalThis.DEFAULT_SEARCH_LIMIT = DEFAULT_SEARCH_LIMIT;
globalThis.SEARCH_SURFACES = SEARCH_SURFACES;
globalThis.likePattern = likePattern;
globalThis.ftsPhrase = ftsPhrase;
globalThis.codePointLength = codePointLength;
globalThis.clampSearchLimit = clampSearchLimit;
globalThis.buildSearchQuery = buildSearchQuery;
})();
