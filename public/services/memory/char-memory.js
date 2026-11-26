(function () {
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

                                                   

// Separate emit products bridged on window: `dbSearchSql` (l0/wiring/db-search.js, boot #16) owns the
// surface SQL and the limit clamp; `queryTerms` is published by services/memory/core.ts (boot #54).
// char-memory loads at boot #53, so both are resolved per call, never at load.
                                
                                       
                                                                       
  
                                                                            

                              
                                                                                      
 

                                 
               
                 
                         
 

/** The two injection limits owned by services/memory/config.ts. */
                                   
                          
                         
 

/** Environment ports: injected by the wiring layer in the browser, by stubs in tests. */
                                  
                                           
             
                                                                       
                                
                                                                                  
                                      
                                                                
                               
                                              
                    
                              
 

                        
                 
                 
                   
                    
                
                
                     
 

/** Legacy IndexedDB database the wiring migrates from; kept here for diagnostics (`_db`). */
const LEGACY_DB = "cfw_char_memory_v1";
const CHUNK_SIZE = 500, CHUNK_OVERLAP = 60;

// The kb surface columns as `src/data-api.js` selects them: chunk + its document title.
const KB_COLS = "c.id, c.doc_id, c.cid, c.chunk, c.offset, c.ord, d.title";

/** Split a document into overlapping chunks on the nearest paragraph/sentence boundary. */
function chunkText(text         )           {
  const s = String(text || "");
  const out           = [];
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
function recOf(v         )                          {
  return (v && typeof v === "object" && !Array.isArray(v)) ? (function () {
    const out                          = {};
    for (const [k, x] of Object.entries(v)) out[k] = x;
    return out;
  })() : {};
}

/** Read-side bridge: unknown → array. Anything else yields an empty array. */
function arrOf(v         )            {
  return Array.isArray(v) ? v : [];
}

function strOf(v         )         { return typeof v === "string" ? v : ""; }
function numOf(v         )         { return typeof v === "number" ? v : 0; }


function createCharMemory(ports                 ) {
  const newId = (p        ) => p + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  /** Document row → the record shape callers have always seen (`cardId`/`addedAt` are the old names). */
  function docOf(row       )                          {
    return { id: strOf(row.id), cardId: strOf(row.cid), title: strOf(row.title), chars: numOf(row.chars), addedAt: numOf(row.ts) };
  }

  async function listDocs(cardId         )                                          {
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

  async function extractEntities(title         , text         )                                                 {
    try {
      const app = ports.hostApp();
      if (!app || typeof app.oneShot !== "function") return [];
      const head = String(text || "").slice(0, 8000);
      const out = await app.oneShot({ system: ENT_SYSTEM, user: "TITLE: " + String(title || "") + String.fromCharCode(10, 10) + head, timeoutMs: 40000 });
      let t = String(out || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
      const i = t.indexOf("["), j = t.lastIndexOf("]");
      if (i >= 0 && j > i) t = t.slice(i, j + 1);
      const parsed          = JSON.parse(t);
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
  async function lexChunks(cid        , q        , limit        )                   {
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
    const params            = [cid, ...patterns, built.limit];
    const like = await ports.db.exec(sql, params);
    return like.rows;
  }

  /** Entity leg: entity names of this card that occur verbatim in the query point at their chunks. */
  async function entityChunkIds(cid        , q        )                    {
    const res = await ports.db.exec("SELECT name, ref_id FROM entities WHERE cid = ? AND kind = 'kb' ORDER BY name ASC, ref_id ASC", [cid]);
    const out           = [];
    const seen                         = {};
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
  async function chunksByIds(cid        , ids          )                   {
    const capped = ids.slice(0, 50);
    if (!capped.length) return [];
    const sql = "SELECT " + KB_COLS + " FROM kb_chunks c JOIN kb_docs d ON d.id = c.doc_id WHERE c.cid = ? AND c.id IN ("
      + capped.map(function () { return "?"; }).join(",") + ")";
    const res = await ports.db.exec(sql, [cid].concat(capped));
    return res.rows;
  }

  async function importText(cardId         , title         , text         , src         )                                                                                           {
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
    const chunks                                                                   = [];
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
    let ents                                        = [];
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
  async function search(cardId         , query         , topK          )                   {
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
    const merged = new Map                ();
    lex.forEach(function (row, i) {
      const id = strOf(row.id);
      if (id) merged.set(id, (merged.get(id) || 0) + 1 / (60 + i + 1));
    });
    entIds.forEach(function (id, i) { merged.set(id, (merged.get(id) || 0) + 1 / (60 + i + 1)); });
    const ranked = Array.from(merged.entries()).sort(function (a, b) { return b[1] - a[1]; }).slice(0, top);
    const byId = new Map               ();
    lex.forEach(function (row) { byId.set(strOf(row.id), row); });
    const missing = ranked.map(function (x) { return x[0]; }).filter(function (id) { return !byId.has(id); });
    if (missing.length) {
      for (const row of await chunksByIds(cid, missing)) byId.set(strOf(row.id), row);
    }
    const entSet = new Set(entIds);
    const hits          = [];
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

  async function getDocText(docId         )                                                                 {
    const id = String(docId || "");
    if (!id) return null;
    const doc = (await ports.db.exec("SELECT id, cid, title, chars, ts FROM kb_docs WHERE id = ?", [id])).rows[0];
    if (!doc) return null;
    const rows = (await ports.db.exec("SELECT chunk FROM kb_chunks WHERE doc_id = ? ORDER BY ord ASC", [id])).rows;
    return { doc: docOf(doc), text: rows.map(function (c) { return strOf(c.chunk); }).join("") };
  }

  async function removeDoc(docId         )                                                  {
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
  async function buildInjection(card         , queryText         )                  {
    const cardRec = (card && typeof card === "object") ? recOf(card) : null;
    const id = (typeof card === "string") ? card : (cardRec ? cardRec.id : null);
    if (!id) return "";
    const q = String(queryText || "").trim();
    if (q.length < 2) return "";
    let limits                  ;
    try {
      limits = ports.settings();
    } catch (e) {
      try { console.warn("[char-memory] 记忆配置端口不可用，本轮不注入知识库", e); } catch (_) {}
      return "";
    }
    let hits          = [];
    try { hits = await search(id, q, limits.injectMaxChunks); } catch (e) { return ""; }
    if (!hits.length) return "";
    let used = 0;
    const parts           = [];
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
  function defineTools(registry         )       {
    if (!registry || typeof (registry                        ).define !== "function") return;
    const reg = registry                                ;
    const cardIdOf = function (ctx         )         {
      const c = (ctx && typeof ctx === "object") ? recOf(ctx).characterCard : null;
      const cr = (c && typeof c === "object" && !Array.isArray(c)) ? recOf(c) : null;
      if (cr && cr.id) return String(cr.id);
      try { const a = ports.activeCard(); return (a && a.id) ? String(a.id) : ""; } catch (e) { return ""; }
    };
    reg.define({
      name: "char_db_set",
      description: "把你（当前角色）的『小本子』里某个键写下来 —— 角色专属的键值库，用来记事实/进度/清单（别的角色看不到）。",
      parameters: { type: "object", properties: { key: { type: "string", description: "键名，如「项目进度」「用户偏好」" }, value: { type: "string", description: "内容（字符串；结构化数据请自己 JSON.stringify）" } }, required: ["key", "value"] },
      async run(args         , ctx         ) {
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
      async run(args         , ctx         ) {
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
      async run(args         , ctx         ) {
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
      async run(args         , ctx         ) {
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
      async run(args         , ctx         ) {
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
  async function removeCard(cardId         )                                                                           {
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
  async function listEntities(cardId         )                     {
    const cid = String(cardId || "");
    if (!cid) return [];
    const res = await ports.db.exec("SELECT name, kind, ref_id FROM entities WHERE cid = ? ORDER BY name ASC, ref_id ASC", [cid]);
    const byName                                                                                                               = {};
    const order           = [];
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

// Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name.
//
// Engine: services/memory/char-memory.ts. What lives here:
//   1) the SQL port — the `db` service `window.dbSvc` provides (T2), resolved per call;
//   2) the one-time move of the old IndexedDB database (`cfw_char_memory_v1`: kv / docs / chunks /
//      ents) into `char_kv`, `kb_docs`, `kb_chunks` and `entities`. The postings and meta stores are
//      index/stats, not data: `kb_fts` rebuilds the first from the chunk text and the second has no
//      consumer any more — migrating them would be carrying a dead index across;
//   3) the window ports (hostApi.app / characterSvc / __charMemoryUiRefresh / alert);
//   4) the v1 import UI (file picker + FileReader — browser glue, same precedent as the vector
//      loader in the core wiring);
//   5) the member list, kept verbatim: twelve members plus `_db`.
//
// Migration discipline (same as the core wiring): every port call awaits `ready`; every insert is a
// primary-key upsert, so a crash mid-way redoes the same rows instead of duplicating them; the
// marker and the IndexedDB deletion only happen after all batches committed; a failure keeps the old
// database and retries on the next boot instead of losing data quietly.
(function () {
  var G = (typeof window !== "undefined" ? window : globalThis);
  var DB_NAME = "cfw_char_memory_v1", DB_VER = 2;
  var ST_KV = "kv", ST_DOCS = "docs", ST_CHUNKS = "chunks", ST_ENTS = "ents";
  // Only the four data stores are read. The old `postings` (inverted index) and `meta` (chunk stats)
  // are rebuildable/derivable: kb_fts re-indexes the chunk text and the new search has no stats
  // consumer, so carrying them across would be moving a dead index.
  var LEGACY_STORES = [ST_KV, ST_DOCS, ST_CHUNKS, ST_ENTS];
  var MARK = "cfw_char_mem_sql_migrated_v1";
  var BATCH = 150; // /api/data/tx refuses more than 200 statements per commit

  function lsGet(key) {
    try { return G.localStorage.getItem(key); } catch (e) { return null; }
  }
  function lsSet(key, value) {
    try { G.localStorage.setItem(key, value); } catch (e) {}
  }
  function strOf(value) {
    return value === undefined || value === null ? "" : String(value);
  }
  function numOf(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  function arrOf(value) {
    return Array.isArray(value) ? value : [];
  }
  function chunkBatches(list, run) {
    var at = 0;
    function step() {
      if (at >= list.length) return Promise.resolve();
      var slice = list.slice(at, at + BATCH);
      at += BATCH;
      return run(slice).then(step);
    }
    return step();
  }

  // The unified port. `context.get("db")` is the forwarding bridge T2 provides.
  function dbPort() {
    var svc = G.dbSvc;
    if (!svc || typeof svc.get !== "function") throw new Error("dbSvc 未接线（存储层未加载）");
    var ctx = svc.context;
    var injected = ctx && typeof ctx.get === "function" ? ctx.get("db") : null;
    return (injected && typeof injected.exec === "function") ? injected : svc.get();
  }

  function openLegacy() {
    return new Promise(function (resolve, reject) {
      var req;
      try { req = G.indexedDB.open(DB_NAME, DB_VER); } catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        try {
          // Only reached for a database that does not exist yet (or an upgrade of the first
          // release): the old schema's shape is mirrored so `getAll` has something to read, and the
          // whole database is deleted after the migration anyway.
          var d = req.result;
          if (!d.objectStoreNames.contains(ST_KV)) d.createObjectStore(ST_KV, { keyPath: "k" });
          if (!d.objectStoreNames.contains(ST_DOCS)) d.createObjectStore(ST_DOCS, { keyPath: "id" });
          if (!d.objectStoreNames.contains(ST_CHUNKS)) d.createObjectStore(ST_CHUNKS, { keyPath: "id" });
          if (!d.objectStoreNames.contains(ST_ENTS)) {
            d.createObjectStore(ST_ENTS, { keyPath: "k" }).createIndex("cid", "cid", { unique: false });
          }
        } catch (e) {}
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error("indexedDB.open(" + DB_NAME + ") 失败")); };
    });
  }

  function readStore(conn, store) {
    return new Promise(function (resolve, reject) {
      var req;
      try { req = conn.transaction(store, "readonly").objectStore(store).getAll(); } catch (e) { reject(e); return; }
      req.onsuccess = function () { resolve(arrOf(req.result)); };
      req.onerror = function () { reject(req.error || new Error("读取旧 " + store + " 失败")); };
    });
  }

  function dropLegacy() {
    return new Promise(function (resolve) {
      var req;
      try { req = G.indexedDB.deleteDatabase(DB_NAME); } catch (e) { resolve(false); return; }
      req.onsuccess = function () { resolve(true); };
      req.onerror = function () { resolve(false); };
      req.onblocked = function () { resolve(false); };
    });
  }

  async function migrate() {
    // No IndexedDB: a non-browser host, or a browser that never had the old bank. Nothing to move.
    if (!G.indexedDB) return;
    if (lsGet(MARK) === "1") return;
    var conn = null;
    try {
      conn = await openLegacy();
      var raw = {};
      for (var s = 0; s < LEGACY_STORES.length; s++) {
        var store = LEGACY_STORES[s];
        try { raw[store] = await readStore(conn, store); } catch (e) { raw[store] = []; }
      }
      try { conn.close(); } catch (e) {}
      conn = null;

      var docs = [];
      var docIds = {};
      for (var i = 0; i < raw[ST_DOCS].length; i++) {
        var d = raw[ST_DOCS][i] || {};
        if (!d.id || !d.cardId) continue;
        docIds[String(d.id)] = 1;
        docs.push(d);
      }
      var chunks = [];
      var chunkIds = {};
      for (var c = 0; c < raw[ST_CHUNKS].length; c++) {
        var ch = raw[ST_CHUNKS][c] || {};
        var docId = strOf(ch.docId);
        // A chunk whose document was removed (the old lazy tombstone) has nothing to hang off.
        if (!ch.id || !docId || !docIds[docId]) continue;
        chunkIds[String(ch.id)] = 1;
        chunks.push(ch);
      }
      var ents = [];
      for (var e = 0; e < raw[ST_ENTS].length; e++) {
        var en = raw[ST_ENTS][e] || {};
        var ecid = strOf(en.cid);
        var name = strOf(en.name);
        if (!ecid || !name) continue;
        var linked = arrOf(en.chunkIds).filter(function (id) { return !!chunkIds[String(id)]; });
        if (linked.length) ents.push({ cid: ecid, name: name, kind: strOf(en.kind) || "concept", refs: linked });
      }
      var kvs = [];
      for (var k = 0; k < raw[ST_KV].length; k++) {
        var row = raw[ST_KV][k] || {};
        var cid = strOf(row.cardId);
        var key = strOf(row.key);
        if (!cid && row.k) {
          key = key || strOf(row.k).split("::").slice(1).join("::");
          cid = strOf(row.k).split("::")[0];
        }
        if (!cid || !key) continue;
        kvs.push({ cid: cid, key: key, value: strOf(row.value), ts: numOf(row.at) || Date.now() });
      }

      await chunkBatches(docs, function (slice) {
        return dbPort().transaction(function (tx) {
          for (var j = 0; j < slice.length; j++) {
            var d2 = slice[j];
            tx.exec("INSERT INTO kb_docs (id, cid, title, size, chars, ts) VALUES (?,?,?,?,?,?)"
              + " ON CONFLICT(id) DO UPDATE SET cid=excluded.cid, title=excluded.title, size=excluded.size,"
              + " chars=excluded.chars, ts=excluded.ts",
              [String(d2.id), String(d2.cardId), strOf(d2.title), numOf(d2.chars), numOf(d2.chars), numOf(d2.addedAt) || Date.now()]);
          }
        });
      });
      await chunkBatches(chunks, function (slice) {
        return dbPort().transaction(function (tx) {
          for (var j = 0; j < slice.length; j++) {
            var c2 = slice[j];
            // `offset` was never stored by the old index, and `ord` is the ordering that matters.
            tx.exec("INSERT INTO kb_chunks (id, doc_id, cid, chunk, offset, ord) VALUES (?,?,?,?,?,?)"
              + " ON CONFLICT(id) DO UPDATE SET doc_id=excluded.doc_id, cid=excluded.cid, chunk=excluded.chunk, ord=excluded.ord",
              [String(c2.id), strOf(c2.docId), strOf(c2.cardId), strOf(c2.text), null, numOf(c2.ord)]);
          }
        });
      });
      await chunkBatches(ents, function (slice) {
        return dbPort().transaction(function (tx) {
          for (var j = 0; j < slice.length; j++) {
            var e2 = slice[j];
            for (var r = 0; r < e2.refs.length; r++) {
              tx.exec("INSERT OR IGNORE INTO entities (cid, name, kind, ref_id) VALUES (?,?,?,?)",
                [e2.cid, e2.name, "kb", String(e2.refs[r])]);
            }
          }
        });
      });
      await chunkBatches(kvs, function (slice) {
        return dbPort().transaction(function (tx) {
          for (var j = 0; j < slice.length; j++) {
            var k2 = slice[j];
            tx.exec("INSERT INTO char_kv (cid, key, value, ts) VALUES (?,?,?,?)"
              + " ON CONFLICT(cid, key) DO UPDATE SET value=excluded.value, ts=excluded.ts",
              [k2.cid, k2.key, k2.value, k2.ts]);
          }
        });
      });

      var dropped = await dropLegacy();
      lsSet(MARK, "1");
      var total = docs.length + chunks.length + ents.length + kvs.length;
      if (total) {
        console.info("[char-memory] 旧 IndexedDB 知识库已迁到 SQL：文档 " + docs.length + " / 分片 " + chunks.length
          + " / 实体 " + ents.length + " / 小本子 " + kvs.length);
      }
      if (total && !dropped) console.warn("[char-memory] 旧 IndexedDB 删除失败（数据已全部迁到 SQL，残留库可手动清理）");
    } catch (e) {
      try { if (conn) conn.close(); } catch (_) {}
      console.warn("[char-memory] 旧知识库迁移失败，IndexedDB 原件保留，下次启动重试：", e);
    }
  }

  var ready = migrate();
  var dbPortFwd = {
    exec: function (sql, params) {
      return ready.then(function () { return dbPort().exec(sql, params); });
    },
    transaction: function (fn) {
      return ready.then(function () { return dbPort().transaction(fn); });
    },
    search: function (surface, scope, q, limit) {
      return ready.then(function () { return dbPort().search(surface, scope, q, limit); });
    },
  };

  // Every global is spelled out with the `window.` prefix: the boot graph and the contract scan
  // only recognise that form, and the vm test context provides the same shape.
  var ports = {
    db: dbPortFwd,
    hostApp: function () {
      try { return (window.hostApi && window.hostApi.app) ? window.hostApi.app : null; } catch (e) { return null; }
    },
    activeCard: function () {
      try { return (window.characterSvc && window.characterSvc.getActiveCard) ? window.characterSvc.getActiveCard() : null; } catch (e) { return null; }
    },
    settings: function () {
      // The shared table lives on the memory facade (memory-config.js). Missing wiring throws on
      // purpose: buildInjection catches it, warns, and skips the block instead of guessing limits.
      var cfg = window.__memCore && window.__memCore.config;
      if (!cfg) throw new Error("memory config 未接线（memory-config.js 未加载）");
      var c = cfg.read();
      return { injectMaxChunks: c.injectMaxChunks, injectMaxChars: c.injectMaxChars };
    },
    uiRefresh: function () {
      // Must stay the full `window.`-prefixed form: check-contracts scans text, and an alias would
      // drop this name's reference count to zero — which reads as "the contract was retired".
      try { if (window.__charMemoryUiRefresh) window.__charMemoryUiRefresh(); } catch (e) {}
    },
    alertMsg: function (msg) { if (typeof alert === "function") alert(msg); },
  };
  var svc = createCharMemory(ports);
  window.__charMemory = {
    defineTools: svc.defineTools,
    importText: svc.importText,
    listDocs: svc.listDocs,
    removeDoc: svc.removeDoc,
    removeCard: svc.removeCard,
    search: svc.search,
    getDocText: svc.getDocText,
    buildInjection: svc.buildInjection,
    ui: function () {
      // The v1 import UI: pick a file, import it into the active character. The full editor-side
      // capability panel is a later batch.
      var card = ports.activeCard() || null;
      if (!card || !card.id) { ports.alertMsg("先挂一张角色卡（左栏角色面板）—— 知识库是「每个角色一套」的。"); return; }
      var input = document.createElement("input");
      input.type = "file";
      input.accept = ".txt,.md,.json,.csv,.log,text/*";
      input.style.display = "none";
      document.body.appendChild(input);
      input.addEventListener("change", function () {
        var f = input.files && input.files[0];
        if (!f) { input.remove(); return; }
        var fr = new FileReader();
        fr.onload = async function () {
          try {
            var r = await svc.importText(card.id, f.name, String(fr.result || ""), "file");
            ports.alertMsg("已导入《" + f.name + "》到「" + card.name + "」的知识库：分 " + r.chunks + " 段，共 " + r.chars + " 字。\n发消息时会按话题自动命中注入；agent 也能用 kb_search / kb_read 深挖。");
          } catch (e) { ports.alertMsg("导入失败：" + String((e && e.message) || e)); }
        };
        fr.readAsText(f);
        input.remove();
      });
      input.click();
    },
    // Entity graph (L4, the light version): `listEntities` answers which entities a character knows.
    extractEntities: svc.extractEntities,
    listEntities: svc.listEntities,
    _db: svc._db,
  };
})();

globalThis.chunkText = chunkText;
globalThis.createCharMemory = createCharMemory;
})();
