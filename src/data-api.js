/**
 * src/data-api.js — the three data-plane endpoints shared by the Cloudflare Worker and the Node
 * sidecar: exec / tx / search.
 *
 * Why one module: both runtimes hand in a D1-shaped database object (`prepare().bind().all()`,
 * `batch()`), and the Worker already routes `server/local.mjs` through `worker.fetch`, so the
 * routes only need to exist once. The Node shim (`server/local.mjs`) supplies the same shape over
 * `node:sqlite`.
 *
 * Contract (frozen for the T2 adapters):
 *   POST /api/data/exec   {sql, params?}                → {rows:[...]}
 *   POST /api/data/tx     {statements:[{sql,params?}]}  → {ok:true, changes:n}
 *   GET  /api/data/search ?surface=messages|memory|kb &conv= | cid= &q= &limit=
 *                                                        → {rows:[...]}
 *
 * Transactions: D1 has no interactive transactions, only `batch()`. `tx` therefore collects the
 * statements and commits them once, atomically. Reads inside a transaction are deliberately not
 * supported — scope any read before the call. This is the portable shape for all three runtimes.
 *
 * Search: FTS5 with `tokenize='trigram'`. The trigram tokenizer cannot match strings shorter than
 * three characters (SQLite's documented behaviour), so a query with fewer than three Unicode code
 * points falls back to a scope-filtered `LIKE '%q%'` with `ESCAPE '\'`. That is the SQLite-native
 * pattern for substring search, not a hand-rolled index. MATCH queries are always wrapped as a
 * quoted phrase so user text can never become FTS5 syntax.
 *
 * Binary values use one wire shape: `{__b64:"<base64>"}` in params and in result rows. The Worker
 * decodes to Uint8Array before binding (D1 accepts it); the Node shim passes Uint8Array straight
 * to `node:sqlite`. T3-C's attachments table depends on this.
 *
 * Errors return `{error}` with a 4xx/5xx status; SQL text is echoed (self-hosted single-tenant),
 * stack traces are not.
 * @module src/data-api
 */

const MAX_SQL_CHARS = 100000;
const MAX_TX_STATEMENTS = 200;
const MAX_SEARCH_LIMIT = 50;
const DEFAULT_SEARCH_LIMIT = 8;
const MAX_QUERY_CHARS = 200;
const MAX_SCOPE_CHARS = 120;
const B64_KEY = "__b64";

const SEARCH_SURFACES = {
  messages: {
    scopeParam: "conv",
    fts: "SELECT m.* FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid WHERE messages_fts MATCH ? AND m.conv_id = ? ORDER BY bm25(messages_fts) LIMIT ?",
    like: "SELECT m.* FROM messages m WHERE m.conv_id = ? AND m.content LIKE ? ESCAPE '\\' ORDER BY m.seq DESC LIMIT ?",
  },
  memory: {
    scopeParam: "cid",
    fts: "SELECT e.* FROM memory_fts JOIN epi e ON e.rowid = memory_fts.rowid WHERE memory_fts MATCH ? AND e.cid = ? ORDER BY bm25(memory_fts) LIMIT ?",
    // 2026-11-28（0004）：`terms` 也进 LIKE 回退 —— 旧 BM25 是 what+terms 一起算分，只有 what 的
    // 2 字回退会把「关键词只写在 terms 里」的事实漏掉。占位符因此是两份 pattern。
    like: "SELECT e.* FROM epi e WHERE e.cid = ? AND (e.what LIKE ? ESCAPE '\\' OR e.terms LIKE ? ESCAPE '\\') ORDER BY e.ts DESC LIMIT ?",
    likeRepeats: 2,
  },
  kb: {
    scopeParam: "cid",
    fts: "SELECT c.id, c.doc_id, c.cid, c.chunk, c.offset, c.ord, d.title FROM kb_fts JOIN kb_chunks c ON c.rowid = kb_fts.rowid JOIN kb_docs d ON d.id = c.doc_id WHERE kb_fts MATCH ? AND c.cid = ? ORDER BY bm25(kb_fts) LIMIT ?",
    like: "SELECT c.id, c.doc_id, c.cid, c.chunk, c.offset, c.ord, d.title FROM kb_chunks c JOIN kb_docs d ON d.id = c.doc_id WHERE c.cid = ? AND c.chunk LIKE ? ESCAPE '\\' ORDER BY c.ord DESC LIMIT ?",
  },
};

/** A 4xx/5xx answer as a plain object; the caller turns it into a Response. */
function fail(status, error) {
  return { status, json: { error: String(error || "bad request") } };
}

function ok(status, json) {
  return { status, json };
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function bytesToBase64(bytes) {
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

function base64ToBytes(text) {
  const bin = atob(String(text));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Decode a wire value into what the driver binds: `{__b64}` → Uint8Array. Unknown shapes pass through. */
export function decodeWireValue(value) {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return value;
  if (isPlainObject(value) && typeof value[B64_KEY] === "string") return base64ToBytes(value[B64_KEY]);
  if (Array.isArray(value)) return value.map(decodeWireValue);
  return value;
}

/** Encode one driver value for the wire: bytes → `{__b64}`. Everything else passes through. */
export function encodeWireValue(value) {
  if (value instanceof Uint8Array) return { [B64_KEY]: bytesToBase64(value) };
  if (value instanceof ArrayBuffer) return { [B64_KEY]: bytesToBase64(new Uint8Array(value)) };
  return value;
}

/** Encode a whole row without trusting its shape (D1 may hand over null-prototype objects). */
export function encodeRow(row) {
  if (!isPlainObject(row)) return {};
  const out = {};
  for (const key of Object.keys(row)) out[key] = encodeWireValue(row[key]);
  return out;
}

function validScope(value) {
  if (typeof value !== "string") return "";
  const v = value.trim();
  if (!v || v.length > MAX_SCOPE_CHARS) return "";
  return v;
}

function clampLimit(value) {
  if (value === null || value === undefined || String(value).trim() === "") return DEFAULT_SEARCH_LIMIT;
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_SEARCH_LIMIT;
  return Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(n)));
}

/** Escape LIKE wildcards so a literal `%` or `_` stays literal. Paired with `ESCAPE '\'`. */
export function likePattern(q) {
  return "%" + String(q).replace(/[\\%_]/g, (c) => "\\" + c) + "%";
}

/** FTS5 phrase quoting: the whole query is one quoted token, internal quotes doubled. */
export function ftsPhrase(q) {
  return '"' + String(q).replace(/"/g, '""') + '"';
}

/** Number of Unicode code points; FTS5 trigram needs at least three. */
export function codePointLength(q) {
  return Array.from(String(q)).length;
}

async function allRows(stmt) {
  const r = await stmt.all();
  return Array.isArray(r && r.results) ? r.results : [];
}

/** POST /api/data/exec — one statement, rows out. */
export async function dataExec(db, body) {
  if (!db || typeof db.prepare !== "function") return fail(503, "database is not bound");
  if (!isPlainObject(body)) return fail(400, "body must be an object");
  const sql = typeof body.sql === "string" ? body.sql : "";
  if (!sql.trim()) return fail(400, "sql is required");
  if (sql.length > MAX_SQL_CHARS) return fail(413, "sql too large");
  const params = body.params === undefined ? [] : body.params;
  if (!Array.isArray(params)) return fail(400, "params must be an array");
  if (params.length > 256) return fail(400, "too many params");
  try {
    let stmt = db.prepare(sql);
    if (params.length) stmt = stmt.bind(...params.map(decodeWireValue));
    const rows = await allRows(stmt);
    return ok(200, { rows: rows.map(encodeRow) });
  } catch (e) {
    return fail(400, (e && e.message) || "exec failed");
  }
}

/** POST /api/data/tx — collect-then-commit; the portable transaction shape. */
export async function dataTx(db, body) {
  if (!db || typeof db.prepare !== "function") return fail(503, "database is not bound");
  if (!isPlainObject(body)) return fail(400, "body must be an object");
  const statements = body.statements;
  if (!Array.isArray(statements) || !statements.length) return fail(400, "statements is required");
  if (statements.length > MAX_TX_STATEMENTS) return fail(400, "too many statements");
  const prepared = [];
  for (const item of statements) {
    if (!isPlainObject(item)) return fail(400, "statement must be an object");
    const sql = typeof item.sql === "string" ? item.sql : "";
    if (!sql.trim()) return fail(400, "statement.sql is required");
    if (sql.length > MAX_SQL_CHARS) return fail(413, "statement.sql too large");
    const params = item.params === undefined ? [] : item.params;
    if (!Array.isArray(params)) return fail(400, "statement.params must be an array");
    if (params.length > 256) return fail(400, "too many params");
    try {
      prepared.push(params.length ? db.prepare(sql).bind(...params.map(decodeWireValue)) : db.prepare(sql));
    } catch (e) {
      return fail(400, (e && e.message) || "statement failed to prepare");
    }
  }
  try {
    let changes = 0;
    if (typeof db.batch === "function") {
      const results = await db.batch(prepared);
      for (const r of results || []) {
        const c = r && r.meta && Number(r.meta.changes);
        if (Number.isFinite(c)) changes += c;
      }
    } else {
      for (const stmt of prepared) {
        const r = await stmt.run();
        const c = r && r.meta && Number(r.meta.changes);
        if (Number.isFinite(c)) changes += c;
      }
    }
    return ok(200, { ok: true, changes });
  } catch (e) {
    return fail(400, (e && e.message) || "transaction failed");
  }
}

/** GET /api/data/search — FTS5 phrase, or scope-filtered LIKE for <3 code points. */
export async function dataSearch(db, params) {
  if (!db || typeof db.prepare !== "function") return fail(503, "database is not bound");
  const p = params instanceof URLSearchParams ? params : new URLSearchParams(params || "");
  const surface = String(p.get("surface") || "").trim();
  const spec = SEARCH_SURFACES[surface];
  if (!spec) return fail(400, "surface must be messages|memory|kb");
  const q = String(p.get("q") || "").trim();
  if (!q) return fail(400, "q is required");
  if (q.length > MAX_QUERY_CHARS) return fail(413, "q too long");
  const scope = validScope(p.get(spec.scopeParam));
  if (!scope) return fail(400, spec.scopeParam + " is required");
  const limit = clampLimit(p.get("limit"));
  const useFts = codePointLength(q) >= 3;
  const sql = useFts ? spec.fts : spec.like;
  const pattern = likePattern(q);
  const likeBindings = spec.likeRepeats === 2 ? [scope, pattern, pattern, limit] : [scope, pattern, limit];
  const bindings = useFts ? [ftsPhrase(q), scope, limit] : likeBindings;
  try {
    const rows = await allRows(db.prepare(sql).bind(...bindings));
    return ok(200, { rows: rows.map(encodeRow), surface, mode: useFts ? "fts" : "like", limit });
  } catch (e) {
    return fail(400, (e && e.message) || "search failed");
  }
}
