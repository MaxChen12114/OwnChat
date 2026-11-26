/**
 * Character memory, part two: the per-card scratchpad (L3) and the per-card knowledge base (L4).
 *
 * `services/memory/core.ts` owns what a character lived through (L1 episodes, L2 conclusions);
 * this module owns what the character chose to write down:
 *
 *   - Scratchpad (KV): a card-scoped key-value store behind `char_db_get` / `char_db_set` /
 *     `char_db_delete`, so a character can keep facts, progress and checklists. Rows live in
 *     `char_kv` under the card id, so one card can never read another's.
 *   - Knowledge base (KB): card-scoped documents in `kb_docs`/`kb_chunks`, ranked by the storage
 *     layer's FTS5 (`kb_fts`). Hits are injected before a request (app.js takes the top-K for the
 *     current speaker and appends them to extraSystemPrompts); `kb_search` / `kb_read` dig deeper
 *     on demand. Entity links live in `entities` (kind='kb', ref_id = chunk id).
 *
 * Storage moved from six IndexedDB stores to those five tables (T3-A). The hand-rolled trigram
 * inverted index and the local BM25-lite scorer retired with it: `kb_fts` + `bm25()` rank, and
 * `queryTerms()` (services/memory/core.ts, published as `window.queryTerms`) supplies the 3-code-point
 * windows the trigram tokenizer can answer plus the 2-character windows it cannot. The retrieval
 * strategy itself is untouched: lexical leg → entity leg → RRF at 1/(60+rank) → top-K, then the
 * injection block capped by count and length from the shared settings table.
 *
 * Ports: `db` is the unified DbPort (core/db.ts); `hostApp` is the one-shot model call used by
 * entity extraction (a best-effort enrichment, never a prerequisite for an import); `activeCard`,
 * `settings`, `uiRefresh` and `alertMsg` are the same environment reads as before. The v1 import UI
 * (file picker + FileReader) is browser glue and stays in the wiring layer.
 *
 * Design choices worth keeping:
 *   - Writes only follow an explicit user action (ask-gated): the agent may read the KB, never write.
 *   - Chunks are ~500 chars with overlap; document + chunks + entity links are one transaction, so a
 *     half-imported document (whose later chunks are unreachable) cannot exist.
 *   - document ids are `<cardId-independent>` `kb_<base36>`; chunk ids are `<docId>#<ord>`, which is
 *     also what `entities.ref_id` points at.
 *
 * Equivalence locks: test/char-memory.test.mjs (behaviour) and test/char-memory-sql.test.mjs
 * (storage base + migration).
 * @module services/memory/char-memory
 */

import type { DbPort, DbRow } from "../../core/db";

// Separate emit products bridged on window: `dbSearchSql` (tooling/l0/wiring/db-search.js, boot #16) owns the
// surface SQL and the limit clamp; `queryTerms` is published by services/memory/core.ts (boot #54).
// char-memory loads at boot #53, so both are resolved per call, never at load.
declare const dbSearchSql: Pick<
  typeof import("../../lib/db-search"),
  "buildSearchQuery" | "clampSearchLimit" | "ftsPhrase" | "likePattern"
>;
declare const queryTerms: (q: unknown) => { fts: string[]; like: string[] };

export interface HostAppLike {
  oneShot?(o: { system: string; user: string; timeoutMs?: number }): Promise<unknown>;
}

export interface ActiveCardLike {
  id?: unknown;
  name?: unknown;
  [key: string]: unknown;
}

/** The two injection limits owned by services/memory/config.ts. */
export interface CharMemoryLimits {
  injectMaxChunks: number;
  injectMaxChars: number;
}

/** Environment ports: injected by the wiring layer in the browser, by stubs in tests. */
export interface CharMemoryPorts {
  /** Unified storage port (core/db.ts). */
  db: DbPort;
  /** Host app bridge, used for the one-shot entity-extraction call. */
  hostApp(): HostAppLike | null;
  /** The card that is currently speaking (read through the character service). */
  activeCard(): ActiveCardLike | null;
  /** Injection limits from the shared memory settings table. */
  settings(): CharMemoryLimits;
  /** Refresh hook for the memory panel UI. */
  uiRefresh(): void;
  alertMsg(msg: string): void;
}

export interface KbHit {
  title: unknown;
  docId: unknown;
  chunkId: unknown;
  chunkOrd: unknown;
  score: number;
  text: unknown;
  viaEntity: boolean;
}

/** Legacy IndexedDB database the wiring migrates from; kept here for diagnostics (`_db`). */
const LEGACY_DB = "cfw_char_memory_v1";
const CHUNK_SIZE = 500, CHUNK_OVERLAP = 60;

// The kb surface columns as `src/data-api.js` selects them: chunk + its document title.
const KB_COLS = "c.id, c.doc_id, c.cid, c.chunk, c.offset, c.ord, d.title";

/** Split a document into overlapping chunks on the nearest paragraph/sentence boundary. */
export function chunkText(text: unknown): string[] {
  const s = String(text || "");
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(s.length, i + CHUNK_SIZE);
    if (end < s.length) {
      const from = i + Math.floor(CHUNK_SIZE * 0.6);
      const win = s.slice(from, end);
      for (const sep of ["\n\n", "\n", "。", "；", "！", "？", ". "]) {
        const k = win.lastIndexOf(sep);
        if (k >= 0) { end = from + k + sep.length; break; }
      }
    }
    out.push(s.slice(i, end));
    if (end >= s.length) break;
    i = Math.max(i + 1, end - CHUNK_OVERLAP);
  }
  return out;
}


/** Read-side bridge: unknown → record. Arrays and scalars yield an empty record. */
function recOf(v: unknown): Record<string, unknown> {
  return (v && typeof v === "object" && !Array.isArray(v)) ? (function () {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = x;
    return out;
  })() : {};
}

/** Read-side bridge: unknown → array. Anything else yields an empty array. */
function arrOf(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function strOf(v: unknown): string { return typeof v === "string" ? v : ""; }
function numOf(v: unknown): number { return typeof v === "number" ? v : 0; }


export function createCharMemory(ports: CharMemoryPorts) {
  const newId = (p: string) => p + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  /** Document row → the record shape callers have always seen (`cardId`/`addedAt` are the old names). */
  function docOf(row: DbRow): Record<string, unknown> {
    return { id: strOf(row.id), cardId: strOf(row.cid), title: strOf(row.title), chars: numOf(row.chars), addedAt: numOf(row.ts) };
  }

  async function listDocs(cardId: unknown): Promise<Array<Record<string, unknown>>> {
    const cid = String(cardId || "");
    if (!cid) return [];
    const res = await ports.db.exec("SELECT id, cid, title, chars, ts FROM kb_docs WHERE cid = ? ORDER BY ts DESC, id ASC", [cid]);
    return res.rows.map(docOf);
  }

  // Entity extraction costs one model call per document: pull the names a reader might search for.
  // The query side stays pure string matching (`entities` lookup), so no model runs there.
  const ENT_SYSTEM = [
    "Extract the key ENTITIES a reader might later search for in this document: people, places, organizations,",
    "named rules/policies, key objects, and important concepts.",
    'Output a JSON array only. Each item: {"name":"…","kind":"person|place|org|policy|object|concept"}',
    "Names must be VERBATIM from the document, in the document language. Never translate.",
    "Return 5-30 items. No prose, no code fences."
  ].join(String.fromCharCode(10));

  async function extractEntities(title: unknown, text: unknown): Promise<Array<{ name: string; kind: string }>> {
    try {
      const app = ports.hostApp();
      if (!app || typeof app.oneShot !== "function") return [];
      const head = String(text || "").slice(0, 8000);
      const out = await app.oneShot({ system: ENT_SYSTEM, user: "TITLE: " + String(title || "") + String.fromCharCode(10, 10) + head, timeoutMs: 40000 });
      let t = String(out || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
      const i = t.indexOf("["), j = t.lastIndexOf("]");
      if (i >= 0 && j > i) t = t.slice(i, j + 1);
      const parsed: unknown = JSON.parse(t);
      const list = arrOf(parsed);
      return list.map(function (x) {
        const r = recOf(x);
        return { name: String((r.name) || "").trim(), kind: String((r.kind) || "concept") };
      }).filter(function (x) { return x.name.length >= 2; }).slice(0, 30);
    } catch (e) { return []; }
  }

  /**
   * Lexical leg: FTS5 ranking over this card's chunks. The MATCH argument is the OR of the query's
   * 3-code-point windows (a whole-sentence phrase would need a literal substring of a chunk). When
   * the query has no window at all — fewer than three code points total — the storage layer's LIKE
   * fallback answers instead. When windows exist but the index finds nothing, one OR'd LIKE statement
   * probes the 2-character windows a trigram index cannot serve.
   */
  async function lexChunks(cid: string, q: string, limit: number): Promise<DbRow[]> {
    const terms = queryTerms(q);
    if (!terms.fts.length) return await ports.db.search("kb", { cid: cid }, q, limit);
    const built = dbSearchSql.buildSearchQuery("kb", { cid: cid }, terms.fts[0], limit);
    const expr = terms.fts.map(function (t) { return dbSearchSql.ftsPhrase(t); }).join(" OR ");
    const res = await ports.db.exec(built.sql, [expr, built.scope, built.limit]);
    if (res.rows.length || !terms.like.length) return res.rows;
    const patterns = terms.like.map(function (t) { return dbSearchSql.likePattern(t); });
    const sql = "SELECT " + KB_COLS + " FROM kb_chunks c JOIN kb_docs d ON d.id = c.doc_id WHERE c.cid = ? AND ("
      + patterns.map(function () { return "c.chunk LIKE ? ESCAPE '\\'"; }).join(" OR ")
      + ") ORDER BY c.ord DESC LIMIT ?";
    const params: unknown[] = [cid, ...patterns, built.limit];
    const like = await ports.db.exec(sql, params);
    return like.rows;
  }

  /** Entity leg: entity names of this card that occur verbatim in the query point at their chunks. */
  async function entityChunkIds(cid: string, q: string): Promise<string[]> {
    const res = await ports.db.exec("SELECT name, ref_id FROM entities WHERE cid = ? AND kind = 'kb' ORDER BY name ASC, ref_id ASC", [cid]);
    const out: string[] = [];
    const seen: Record<string, number> = {};
    for (const row of res.rows) {
      const name = strOf(row.name);
      if (name.length < 2 || q.indexOf(name) < 0) continue;
      const id = strOf(row.ref_id);
      if (!id || seen[id]) continue;
      seen[id] = 1;
      out.push(id);
    }
    return out;
  }

  /** Chunk rows for ids the lexical leg did not carry (entity-only hits), scoped to the card. */
  async function chunksByIds(cid: string, ids: string[]): Promise<DbRow[]> {
    const capped = ids.slice(0, 50);
    if (!capped.length) return [];
    const sql = "SELECT " + KB_COLS + " FROM kb_chunks c JOIN kb_docs d ON d.id = c.doc_id WHERE c.cid = ? AND c.id IN ("
      + capped.map(function () { return "?"; }).join(",") + ")";
    const res = await ports.db.exec(sql, [cid].concat(capped));
    return res.rows;
  }

  async function importText(cardId: unknown, title: unknown, text: unknown, src: unknown): Promise<{ ok: boolean; docId: string; chunks: number; chars: number; entities: number }> {
    // `src` (paste / file) stays in the signature for callers; kb_docs has no provenance column and
    // the old doc record's `src` had no reader either (nothing displayed or filtered on it).
    const clean = String(text || "").replace(/\r\n?/g, "\n").trim();
    if (!cardId) throw new Error("缺少 cardId");
    if (!clean) throw new Error("正文为空");
    const cid = String(cardId);
    const docId = newId("kb");
    const now = Date.now();
    const docTitle = String(title || "未命名").slice(0, 120);
    const pieces = chunkText(clean);
    const chunks: Array<{ id: string; text: string; ord: number; offset: number }> = [];
    let from = 0;
    for (let ord = 0; ord < pieces.length; ord++) {
      const piece = pieces[ord];
      const at = clean.indexOf(piece, from);
      const offset = at >= 0 ? at : from;
      from = offset + 1;
      chunks.push({ id: docId + "#" + ord, text: piece, ord: ord, offset: offset });
    }
    // Best effort: a failed extraction still imports the document and keeps the lexical leg; only
    // the extra entity recall is lost. It runs before the transaction because it is a model call and
    // the transaction body must stay synchronous (collect-then-commit).
    let ents: Array<{ name: string; kind: string }> = [];
    try { ents = await extractEntities(docTitle, clean); } catch (e) { ents = []; }
    let linked = 0;
    // Document + chunks + entity links in ONE transaction: chunks are what `kb_fts` indexes, so a
    // partial write would leave a document whose tail is silently unreachable.
    await ports.db.transaction(function (tx) {
      tx.exec("INSERT INTO kb_docs (id, cid, title, size, chars, ts) VALUES (?,?,?,?,?,?)",
        [docId, cid, docTitle, clean.length, clean.length, now]);
      for (const c of chunks) {
        tx.exec("INSERT INTO kb_chunks (id, doc_id, cid, chunk, offset, ord) VALUES (?,?,?,?,?,?)",
          [c.id, docId, cid, c.text, c.offset, c.ord]);
      }
      for (const e of ents) {
        const ids = chunks.filter(function (c) { return c.text.indexOf(e.name) >= 0; }).map(function (c) { return c.id; });
        if (!ids.length) continue;
        for (const id of ids) {
          tx.exec("INSERT OR IGNORE INTO entities (cid, name, kind, ref_id) VALUES (?,?,?,?)", [cid, e.name, "kb", id]);
        }
        linked++;
      }
      return null;
    });
    try { ports.uiRefresh(); } catch (e) {}
    return { ok: true, docId: docId, chunks: chunks.length, chars: clean.length, entities: linked };
  }

  /** Search this card's documents: FTS leg + entity leg → RRF → top-K. */
  async function search(cardId: unknown, query: unknown, topK?: unknown): Promise<KbHit[]> {
    const q = String(query || "").trim();
    const cid = String(cardId || "");
    if (!q || !cid) return [];
    const docs = await listDocs(cid);
    if (!docs.length) return [];
    const top = Math.max(1, Math.min(10, Number(topK) || 5));
    // 3x top: RRF needs a little more than the final cut to fuse the two legs, and never less than
    // the storage default of 8.
    const lex = await lexChunks(cid, q, dbSearchSql.clampSearchLimit(Math.max(8, top * 3)));
    const entIds = await entityChunkIds(cid, q);
    if (!lex.length && !entIds.length) return [];
    // RRF fusion of the two legs: score = Σ 1/(60+rank).
    const merged = new Map<string, number>();
    lex.forEach(function (row, i) {
      const id = strOf(row.id);
      if (id) merged.set(id, (merged.get(id) || 0) + 1 / (60 + i + 1));
    });
    entIds.forEach(function (id, i) { merged.set(id, (merged.get(id) || 0) + 1 / (60 + i + 1)); });
    const ranked = Array.from(merged.entries()).sort(function (a, b) { return b[1] - a[1]; }).slice(0, top);
    const byId = new Map<string, DbRow>();
    lex.forEach(function (row) { byId.set(strOf(row.id), row); });
    const missing = ranked.map(function (x) { return x[0]; }).filter(function (id) { return !byId.has(id); });
    if (missing.length) {
      for (const row of await chunksByIds(cid, missing)) byId.set(strOf(row.id), row);
    }
    const entSet = new Set(entIds);
    const hits: KbHit[] = [];
    for (const entry of ranked) {
      const row = byId.get(entry[0]);
      if (!row) continue; // the chunk went away between the legs; skip, never invent a hit
      hits.push({
        title: row.title,
        docId: row.doc_id,
        chunkId: row.id,
        chunkOrd: row.ord,
        score: Math.round(entry[1] * 10000) / 10000,
        text: row.chunk,
        viaEntity: entSet.has(entry[0]),
      });
    }
    return hits;
  }

  async function getDocText(docId: unknown): Promise<{ doc: Record<string, unknown>; text: string } | null> {
    const id = String(docId || "");
    if (!id) return null;
    const doc = (await ports.db.exec("SELECT id, cid, title, chars, ts FROM kb_docs WHERE id = ?", [id])).rows[0];
    if (!doc) return null;
    const rows = (await ports.db.exec("SELECT chunk FROM kb_chunks WHERE doc_id = ? ORDER BY ord ASC", [id])).rows;
    return { doc: docOf(doc), text: rows.map(function (c) { return strOf(c.chunk); }).join("") };
  }

  async function removeDoc(docId: unknown): Promise<{ ok: boolean; removedChunks: number }> {
    const id = String(docId || "");
    if (!id) return { ok: false, removedChunks: 0 };
    const rows = (await ports.db.exec("SELECT id FROM kb_chunks WHERE doc_id = ?", [id])).rows;
    const ids = rows.map(function (r) { return strOf(r.id); }).filter(Boolean);
    await ports.db.transaction(function (tx) {
      for (const chunkId of ids) tx.exec("DELETE FROM entities WHERE kind = 'kb' AND ref_id = ?", [chunkId]);
      tx.exec("DELETE FROM kb_chunks WHERE doc_id = ?", [id]);
      tx.exec("DELETE FROM kb_docs WHERE id = ?", [id]);
      return null;
    });
    try { ports.uiRefresh(); } catch (e) {}
    return { ok: true, removedChunks: ids.length };
  }

  /** Compose the "knowledge base hits" block for one card's request (app.js awaits it before sending). */
  async function buildInjection(card: unknown, queryText: unknown): Promise<string> {
    const cardRec = (card && typeof card === "object") ? recOf(card) : null;
    const id = (typeof card === "string") ? card : (cardRec ? cardRec.id : null);
    if (!id) return "";
    const q = String(queryText || "").trim();
    if (q.length < 2) return "";
    let limits: CharMemoryLimits;
    try {
      limits = ports.settings();
    } catch (e) {
      try { console.warn("[char-memory] 记忆配置端口不可用，本轮不注入知识库", e); } catch (_) {}
      return "";
    }
    let hits: KbHit[] = [];
    try { hits = await search(id, q, limits.injectMaxChunks); } catch (e) { return ""; }
    if (!hits.length) return "";
    let used = 0;
    const parts: string[] = [];
    for (const h of hits) {
      const piece = "〔" + String(h.title) + "·第" + (Number(h.chunkOrd) + 1) + "段〕" + String(h.text);
      if (used + piece.length > limits.injectMaxChars) break;
      used += piece.length;
      parts.push(piece);
    }
    if (!parts.length) return "";
    const who = (cardRec && cardRec.name) ? String(cardRec.name) : "本角色";
    return "\n\n【知识库命中·" + who + "】以下是你（该角色）知识库里与本轮话题最相关的段落，可直接引用；"
      + "需要更多时用 kb_search 检索、kb_read 读全文（不要编造未命中的内容）：\n" + parts.join("\n---\n");
  }

  /** Register the agent tools: the scratchpad acts on the card that is speaking, the KB is read-only. */
  function defineTools(registry: unknown): void {
    if (!registry || typeof (registry as { define?: unknown }).define !== "function") return;
    const reg = registry as { define(t: unknown): void };
    const cardIdOf = function (ctx: unknown): string {
      const c = (ctx && typeof ctx === "object") ? recOf(ctx).characterCard : null;
      const cr = (c && typeof c === "object" && !Array.isArray(c)) ? recOf(c) : null;
      if (cr && cr.id) return String(cr.id);
      try { const a = ports.activeCard(); return (a && a.id) ? String(a.id) : ""; } catch (e) { return ""; }
    };
    reg.define({
      name: "char_db_set",
      description: "把你（当前角色）的『小本子』里某个键写下来 —— 角色专属的键值库，用来记事实/进度/清单（别的角色看不到）。",
      parameters: { type: "object", properties: { key: { type: "string", description: "键名，如「项目进度」「用户偏好」" }, value: { type: "string", description: "内容（字符串；结构化数据请自己 JSON.stringify）" } }, required: ["key", "value"] },
      async run(args: unknown, ctx: unknown) {
        const cid = cardIdOf(ctx);
        if (!cid) return { ok: false, error: "没有当前角色（先挂一张角色卡）" };
        const a = recOf(args);
        const key = String(a.key || "").trim();
        if (!key) return { ok: false, error: "缺少 key" };
        const val = String(a.value == null ? "" : a.value);
        await ports.db.exec(
          "INSERT INTO char_kv (cid, key, value, ts) VALUES (?,?,?,?) ON CONFLICT(cid, key) DO UPDATE SET value = excluded.value, ts = excluded.ts",
          [cid, key, val, Date.now()],
        );
        return { ok: true, key: key, chars: val.length, note: "已记在你的小本子上（角色专属，别的角色看不到）" };
      },
    });
    reg.define({
      name: "char_db_get",
      description: "读你（当前角色）的『小本子』：传 key 取单条；不传则列出全部键名与长度。",
      parameters: { type: "object", properties: { key: { type: "string", description: "键名；省略 = 列出全部键" } } },
      async run(args: unknown, ctx: unknown) {
        const cid = cardIdOf(ctx);
        if (!cid) return { ok: false, error: "没有当前角色" };
        const key = recOf(args).key;
        if (key) {
          const rec = (await ports.db.exec("SELECT key, value, ts FROM char_kv WHERE cid = ? AND key = ?", [cid, String(key)])).rows[0];
          if (!rec) return { ok: false, error: "没有这个键：" + String(key) };
          return { ok: true, key: strOf(rec.key), value: strOf(rec.value), at: numOf(rec.ts) };
        }
        const res = await ports.db.exec("SELECT key, LENGTH(value) AS chars, ts FROM char_kv WHERE cid = ? ORDER BY key ASC", [cid]);
        return { ok: true, keys: res.rows.map(function (r) { return { key: strOf(r.key), chars: numOf(r.chars), at: numOf(r.ts) }; }) };
      },
    });
    reg.define({
      name: "char_db_delete",
      destructive: true,
      description: "删掉你（当前角色）小本子里的某个键。",
      parameters: { type: "object", properties: { key: { type: "string", description: "键名" } }, required: ["key"] },
      async run(args: unknown, ctx: unknown) {
        const cid = cardIdOf(ctx);
        if (!cid) return { ok: false, error: "没有当前角色" };
        const key = String(recOf(args).key || "").trim();
        await ports.db.exec("DELETE FROM char_kv WHERE cid = ? AND key = ?", [cid, key]);
        return { ok: true, deleted: key };
      },
    });
    reg.define({
      name: "kb_search",
      description: "检索你（当前角色）的知识库（本地文档库，关键词/中文子串可命中）。回答用户前若涉及你知识库里可能有的资料，先搜一下再答；不要编造。",
      parameters: { type: "object", properties: { query: { type: "string", description: "检索词（自然语言问题或关键词都行）" }, top: { type: "number", description: "返回条数，默认 5" } }, required: ["query"] },
      async run(args: unknown, ctx: unknown) {
        const cid = cardIdOf(ctx);
        if (!cid) return { ok: false, error: "没有当前角色" };
        const a = recOf(args);
        const hits = await search(cid, a.query, a.top);
        if (!hits.length) return { ok: true, hits: [], note: "知识库里没有命中（不是失败：库里可能确实没有这份资料）" };
        return { ok: true, hits: hits.map(function (h) { return { doc: h.title, docId: h.docId, seg: Number(h.chunkOrd) + 1, score: h.score, text: String(h.text || "").slice(0, 1200) }; }), note: "要全文用 kb_read（传 docId）" };
      },
    });
    reg.define({
      name: "kb_read",
      description: "按文档 id 读你（当前角色）知识库里某篇文档的全文（id 见 kb_search 结果里的 docId）。",
      parameters: { type: "object", properties: { doc_id: { type: "string", description: "文档 id" } }, required: ["doc_id"] },
      async run(args: unknown, ctx: unknown) {
        const cid = cardIdOf(ctx);
        if (!cid) return { ok: false, error: "没有当前角色" };
        const got = await getDocText(String(recOf(args).doc_id || ""));
        if (!got) return { ok: false, error: "找不到该文档" };
        if (got.doc.cardId !== cid) return { ok: false, error: "该文档不属于当前角色" };
        return { ok: true, doc: got.doc.title, chars: got.text.length, text: got.text };
      },
    });
  }

  /** Card-deletion cascade: drop this card's documents, chunks, entity links and scratchpad keys so
   *  nothing is orphaned. Called from the character service's card cleanup. */
  async function removeCard(cardId: unknown): Promise<{ ok: boolean; docs?: number; kvKeys?: number; error?: string }> {
    const cid = String(cardId || "");
    if (!cid) return { ok: false, error: "缺少 cardId" };
    const docs = await listDocs(cid);
    const kvRow = (await ports.db.exec("SELECT COUNT(*) AS n FROM char_kv WHERE cid = ?", [cid])).rows[0];
    const kvKeys = kvRow ? numOf(kvRow.n) : 0;
    await ports.db.transaction(function (tx) {
      tx.exec("DELETE FROM entities WHERE cid = ?", [cid]);
      tx.exec("DELETE FROM kb_chunks WHERE cid = ?", [cid]);
      tx.exec("DELETE FROM kb_docs WHERE cid = ?", [cid]);
      tx.exec("DELETE FROM char_kv WHERE cid = ?", [cid]);
      return null;
    });
    try { ports.uiRefresh(); } catch (e) {}
    return { ok: true, docs: docs.length, kvKeys: kvKeys };
  }

  /** Entity graph (L4, the light version): which entities a character knows, with their chunks. */
  async function listEntities(cardId: unknown): Promise<unknown[]> {
    const cid = String(cardId || "");
    if (!cid) return [];
    const res = await ports.db.exec("SELECT name, kind, ref_id FROM entities WHERE cid = ? ORDER BY name ASC, ref_id ASC", [cid]);
    const byName: Record<string, { k: string; cid: string; name: string; kind: string; docIds: string[]; chunkIds: string[] }> = {};
    const order: string[] = [];
    for (const row of res.rows) {
      const name = strOf(row.name);
      if (!name) continue;
      let rec = byName[name];
      if (!rec) {
        rec = { k: cid + "::" + name, cid: cid, name: name, kind: strOf(row.kind), docIds: [], chunkIds: [] };
        byName[name] = rec;
        order.push(name);
      }
      const chunkId = strOf(row.ref_id);
      if (chunkId && rec.chunkIds.indexOf(chunkId) < 0) {
        rec.chunkIds.push(chunkId);
        const docId = chunkId.split("#")[0];
        if (docId && rec.docIds.indexOf(docId) < 0) rec.docIds.push(docId);
      }
    }
    return order.map(function (name) { return byName[name]; });
  }

  return {
    defineTools, importText, listDocs, removeDoc, removeCard, search, getDocText, buildInjection,
    extractEntities, listEntities,
    // The legacy IndexedDB database name: the wiring's one-time migration reads it, and the value
    // stays on the facade so a diagnostics surface can tell where a pre-migration install came from.
    _db: LEGACY_DB,
  };
}
