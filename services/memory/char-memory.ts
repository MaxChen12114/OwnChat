/**
 * Character memory, part two: the per-card scratchpad (L3) and the per-card knowledge base (L4).
 *
 * `services/memory/core.ts` owns what a character lived through (L1 episodes, L2 conclusions);
 * this module owns what the character chose to write down:
 *
 *   - Scratchpad (KV): a card-scoped key-value store behind `char_db_get` / `char_db_set` /
 *     `char_db_delete`, so a character can keep facts, progress and checklists. Keys are prefixed
 *     with the card id, so one card can never read another's.
 *   - Knowledge base (KB): card-scoped documents in IndexedDB with a trigram inverted index,
 *     ranked by BM25-lite. Hits are injected before a request (app.js takes the top-K for the
 *     current speaker and appends them to extraSystemPrompts); `kb_search` / `kb_read` dig deeper
 *     on demand.
 *
 * IndexedDB is reached through a structural interface rather than the DOM lib, because this
 * module is compiled without DOM types: the wiring layer hands over the real `indexedDB`, the
 * tests an in-memory stub. `IDBKeyRange.bound` arrives as the `keyRangeBound` port, and every
 * cross-module call (host app, active card, UI refresh, alert) is a port too. The v1 import UI
 * (file picker + FileReader) is pure browser glue and lives in the wiring layer, the same split
 * as the vector loader in core.ts.
 *
 * Design choices worth keeping:
 *   - Everything stays local: a knowledge base is not necessarily small, so localStorage (2 MB)
 *     is out, and nothing here is cloud-synced.
 *   - One posting record per token key: a query touches only the few dozen keys it needs, so
 *     memory use stays flat as the library grows.
 *   - Chinese has to match substrings, hence character trigrams (lowercased word tokens for
 *     Latin and digits) plus BM25 ranking.
 *   - The lexical leg is separable: adding a vector leg and RRF fusion later needs no data
 *     migration.
 *   - Writes only follow an explicit user action (ask-gated): v1 gives the agent no write access
 *     to the KB, only read tools.
 *   - Chunks are ~500 chars with overlap; injection is capped by count and length (INJECT_*).
 *
 * Equivalence lock: test/char-memory.test.mjs.
 * @module services/memory/char-memory
 */


/** Minimal IndexedDB request shape; a real request and the test stub both satisfy it. */
export interface IdbRequest {
  result: unknown;
  onsuccess: ((e?: unknown) => void) | null;
  onerror: ((e?: unknown) => void) | null;
  error?: unknown;
}

export interface IdbObjectStore {
  get(key: unknown): IdbRequest;
  getAll(key?: unknown): IdbRequest;
  put(value: unknown): IdbRequest;
  delete(key: unknown): IdbRequest;
  index(name: string): { getAll(key: unknown): IdbRequest };
}

export interface IdbTx {
  objectStore(name: string): IdbObjectStore;
  oncomplete: ((e?: unknown) => void) | null;
  onerror: ((e?: unknown) => void) | null;
  onabort: ((e?: unknown) => void) | null;
  error?: unknown;
}

export interface IdbConn {
  objectStoreNames: { contains(name: string): boolean };
  transaction(stores: string | string[], mode: "readonly" | "readwrite"): IdbTx;
}

/** Connection shape during the upgrade, when stores and indexes are created. */
export interface IdbUpgradeConn extends IdbConn {
  createObjectStore(name: string, opts?: { keyPath?: string }): {
    createIndex(name: string, key: string, opts?: { unique: boolean }): unknown;
  };
}

export interface IdbOpenReq {
  result: IdbUpgradeConn;
  onupgradeneeded: ((e?: unknown) => void) | null;
  onsuccess: ((e?: unknown) => void) | null;
  onerror: ((e?: unknown) => void) | null;
  error?: unknown;
}

export interface IdbFactory {
  open(name: string, version: number): IdbOpenReq;
}

export interface HostAppLike {
  oneShot?(o: { system: string; user: string; timeoutMs?: number }): Promise<unknown>;
}

export interface ActiveCardLike {
  id?: unknown;
  name?: unknown;
  [key: string]: unknown;
}

/** Environment ports: injected by the wiring layer in the browser, by stubs in tests. */
export interface CharMemoryPorts {
  idb(): IdbFactory | null;
  keyRangeBound(a: string, b: string): unknown;
  /** Host app bridge, used for the one-shot entity-extraction call. */
  hostApp(): HostAppLike | null;
  /** The card that is currently speaking (read through the character service). */
  activeCard(): ActiveCardLike | null;
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


const DB = "cfw_char_memory_v1";
const ST_KV = "kv", ST_DOCS = "docs", ST_CHUNKS = "chunks", ST_POSTINGS = "postings", ST_META = "meta";
// Entity index (the KB's lightweight graph): one record per entity, holding the chunks it was
// seen in. A local-search-only take on LightRAG: no community clustering, just entity → chunks.
const ST_ENTS = "ents";
const CHUNK_SIZE = 500, CHUNK_OVERLAP = 60;
const INJECT_MAX_CHUNKS = 3, INJECT_MAX_CHARS = 1200;


// Trigram tokenizer: CJK runs of two characters are stored whole so short queries still hit;
// Latin and digits become lowercased word tokens.
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
export function tokenize(text: unknown): Map<string, number> {
  const s = String(text || "");
  const tf = new Map<string, number>();
  const bump = function (k: string): void { tf.set(k, (tf.get(k) || 0) + 1); };
  const run: string[] = [];
  const flushRun = function (): void {
    if (run.length >= 3) { for (let i = 0; i + 3 <= run.length; i++) bump("3:" + run.slice(i, i + 3).join("")); }
    else if (run.length === 2) bump("3:" + run.join(""));
    run.length = 0;
  };
  let latin = "";
  const flushLatin = function (): void { if (latin.length >= 2) bump("w:" + latin); latin = ""; };
  for (const ch of s) {
    if (CJK.test(ch)) { flushLatin(); run.push(ch); continue; }
    flushRun();
    if (/[A-Za-z0-9_]/.test(ch)) { latin += ch.toLowerCase(); continue; }
    flushLatin();
  }
  flushRun(); flushLatin();
  return tf;
}

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


export function createCharMemory(ports: CharMemoryPorts) {
  let _dbPromise: Promise<IdbConn> | null = null; // one cached connection: opening per operation leaked handles
  function open(): Promise<IdbConn> {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise<IdbConn>(function (resolve, reject) {
      try {
        const f = ports.idb();
        if (!f) throw new Error("IndexedDB 不可用");
        const q = f.open(DB, 2);
        q.onupgradeneeded = function () {
          const d = q.result;
          if (!d.objectStoreNames.contains(ST_KV)) d.createObjectStore(ST_KV, { keyPath: "k" });
          if (!d.objectStoreNames.contains(ST_DOCS)) d.createObjectStore(ST_DOCS, { keyPath: "id" });
          if (!d.objectStoreNames.contains(ST_CHUNKS)) d.createObjectStore(ST_CHUNKS, { keyPath: "id" });
          if (!d.objectStoreNames.contains(ST_POSTINGS)) d.createObjectStore(ST_POSTINGS, { keyPath: "key" });
          if (!d.objectStoreNames.contains(ST_META)) d.createObjectStore(ST_META, { keyPath: "k" });
          if (!d.objectStoreNames.contains(ST_ENTS)) {
            const se = d.createObjectStore(ST_ENTS, { keyPath: "k" });
            se.createIndex("cid", "cid", { unique: false });
          }
        };
        q.onsuccess = function () { resolve(q.result); };
        q.onerror = function () { reject(q.error); };
      } catch (e) { reject(e); }
    }).catch(function (e) { _dbPromise = null; throw e; }); // a failed open resets the cache so the next call retries
    return _dbPromise;
  }
  const reqP = (r: IdbRequest) => new Promise<unknown>(function (resolve, reject) {
    r.onsuccess = function () { resolve(r.result); };
    r.onerror = function () { reject(r.error); };
  });
  // Reads resolve on the request itself: the read-only transaction ends on its own, so nothing
  // depends on oncomplete ordering.
  function readReq(db: IdbConn, store: string, fn: (s: IdbObjectStore) => IdbRequest): Promise<unknown> {
    return new Promise(function (resolve, reject) {
      let p: IdbRequest;
      try { p = fn(db.transaction(store, "readonly").objectStore(store)); } catch (e) { reject(e); return; }
      reqP(p).then(resolve, reject);
    });
  }
  // Writes wait for the transaction to commit; in a read-then-write flow the next transaction
  // would otherwise still see the previous value.
  function writeTx(db: IdbConn, stores: string | string[], fn: (t: IdbTx) => void): Promise<boolean> {
    return new Promise(function (resolve, reject) {
      const t = db.transaction(Array.isArray(stores) ? stores : [stores], "readwrite");
      try { fn(t); } catch (e) { reject(e); return; }
      t.oncomplete = function () { resolve(true); };
      t.onerror = function () { reject(t.error); };
      t.onabort = function () { reject(t.error || new Error("tx aborted")); };
    });
  }
  const idbKey = (cardId: unknown, key: unknown) => String(cardId || "") + "::" + String(key || "");
  const newId = (p: string) => p + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const rangeDoc = (docId: string) => ports.keyRangeBound(docId + "#", docId + "#\uffff");

  async function listDocs(cardId: unknown): Promise<Array<Record<string, unknown>>> {
    const db = await open();
    const all = arrOf(await readReq(db, ST_DOCS, (s) => s.getAll()));
    return all
      .filter(function (d) { const r = recOf(d); return d && r.cardId === String(cardId); })
      .map(recOf)
      .sort(function (a, b) { return Number(b.addedAt || 0) - Number(a.addedAt || 0); });
  }

  // Indexing an import: document + chunks + postings (one record per token, read-modify-write).
  // Entity extraction costs one model call per document: pull the names a reader might search
  // for, then attach each to the chunks where it occurs verbatim. The query side stays pure
  // string matching, so no model runs there.
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

  // Attach each entity to the chunks whose text contains it verbatim.
  async function linkEntities(db: IdbConn, cardId: string, docId: string, chunks: Array<{ id: string; text: string }>, ents: Array<{ name: string; kind: string }>): Promise<number> {
    if (!ents.length) return 0;
    let linked = 0;
    for (const e of ents) {
      const ids = chunks.filter(function (c) { return c.text.indexOf(e.name) >= 0; }).map(function (c) { return c.id; });
      if (!ids.length) continue;
      const k = String(cardId) + "::" + e.name;
      await writeTx(db, ST_ENTS, function (t) {
        const os = t.objectStore(ST_ENTS);
        const r = os.get(k);
        r.onsuccess = function () {
          const curRec = recOf(r.result);
          const cur: Record<string, unknown> = r.result ? curRec : { k: k, cid: String(cardId), name: e.name, kind: e.kind, docIds: [], chunkIds: [] };
          cur.kind = e.kind || cur.kind;
          const d0 = arrOf(cur.docIds);
          const c0 = arrOf(cur.chunkIds);
          cur.docIds = Array.from(new Set(d0.concat([docId])));
          cur.chunkIds = Array.from(new Set(c0.concat(ids)));
          os.put(cur);
        };
      });
      linked++;
    }
    return linked;
  }

  async function importText(cardId: unknown, title: unknown, text: unknown, src: unknown): Promise<{ ok: boolean; docId: string; chunks: number; chars: number; entities: number }> {
    const clean = String(text || "").replace(/\r\n?/g, "\n").trim();
    if (!cardId) throw new Error("缺少 cardId");
    if (!clean) throw new Error("正文为空");
    const db = await open();
    const docId = newId("kb");
    const doc = { id: docId, cardId: String(cardId), title: String(title || "未命名").slice(0, 120), src: String(src || "paste").slice(0, 60), addedAt: Date.now(), chars: clean.length };
    const pieces = chunkText(clean);
    const chunks = pieces.map(function (piece, ord) { return { id: docId + "#" + ord, docId: docId, cardId: doc.cardId, ord: ord, text: piece, len: piece.length }; });
    await writeTx(db, [ST_DOCS, ST_CHUNKS], function (t) {
      t.objectStore(ST_DOCS).put(doc);
      const cs = t.objectStore(ST_CHUNKS);
      for (const c of chunks) cs.put(c);
    });
    // Postings: aggregate this document's term frequencies in memory first, then one read-modify-write per key.
    const byKey = new Map<string, Array<[string, number, number]>>();
    for (const c of chunks) {
      for (const [k, n] of tokenize(c.text)) {
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push([c.id, n, c.len]);
      }
    }
    for (const [k, entries] of byKey) {
      await writeTx(db, ST_POSTINGS, function (t) {
        const os = t.objectStore(ST_POSTINGS);
        const r = os.get(k);
        r.onsuccess = function () {
          const rr = recOf(r.result);
          const cur = (r.result && Array.isArray(rr.entries)) ? rr.entries : [];
          os.put({ key: k, entries: cur.concat(entries) });
        };
      });
    }
    await writeTx(db, ST_META, function (t) {
      const m = t.objectStore(ST_META);
      const r = m.get("stats");
      r.onsuccess = function () {
        const rr = recOf(r.result);
        const st0 = (r.result && rr.v && typeof rr.v === "object" && !Array.isArray(rr.v)) ? recOf(rr.v) : { nChunks: 0, totalLen: 0 };
        const st = { nChunks: Number(st0.nChunks || 0), totalLen: Number(st0.totalLen || 0) };
        st.nChunks += chunks.length;
        for (const c of chunks) st.totalLen += (c.len || 0);
        m.put({ k: "stats", v: st });
      };
    });
    // Best effort: a failed extraction still leaves the document imported and searchable, only the extra recall is lost.
    let ents = 0;
    try {
      const list = await extractEntities(doc.title, clean);
      ents = await linkEntities(db, doc.cardId, docId, chunks, list);
    } catch (e) { ents = 0; }
    try { ports.uiRefresh(); } catch (e) {}
    return { ok: true, docId: docId, chunks: chunks.length, chars: doc.chars, entities: ents };
  }

  /** Search this card's documents: tokens → postings → BM25-lite. */
  async function search(cardId: unknown, query: unknown, topK?: unknown): Promise<KbHit[]> {
    const q = String(query || "").trim();
    const cid = String(cardId || "");
    if (!q || !cid) return [];
    const db = await open();
    const docs = await listDocs(cid);
    if (!docs.length) return [];
    const allowed = new Set(docs.map(function (d) { return String(d.id); }));
    const statsRec = recOf(await readReq(db, ST_META, function (s) { return s.get("stats"); }));
    const stats = (statsRec.v && typeof statsRec.v === "object" && !Array.isArray(statsRec.v)) ? recOf(statsRec.v) : { nChunks: 0, totalLen: 0 };
    const nChunks = Number(stats.nChunks || 1);
    const totalLen = Number(stats.totalLen || 0);
    const avgLen = Math.max(1, totalLen / Math.max(1, nChunks));
    const qtf = tokenize(q);
    if (!qtf.size) return [];
    const scores = new Map<unknown, number>();
    let used = 0;
    for (const [key, qn] of qtf) {
      if (used++ >= 24) break; // 单次查询最多取 24 个倒排键（够用且省往返）
      const pr = recOf(await readReq(db, ST_POSTINGS, function (s) { return s.get(key); }));
      if (!pr || !Array.isArray(pr.entries)) continue;
      const mine = arrOf(pr.entries).filter(function (e) {
        const ee = Array.isArray(e) ? e : [];
        return e && allowed.has(String(ee[0] || "").split("#")[0]);
      });
      if (!mine.length) continue;
      const df = Math.max(1, mine.length);
      const idf = Math.log(1 + ((nChunks || 1) - df + 0.5) / (df + 0.5));
      for (const e of mine) {
        const ee = Array.isArray(e) ? e : [];
        const chunkId = ee[0], tf = Number(ee[1]) || 1, len = Number(ee[2]) || avgLen;
        // BM25-lite (k1=1.2, b=0.75) with a mild query-side term-frequency boost: asking the same word again ranks higher.
        const denom = tf + 1.2 * (0.25 + 0.75 * (len / avgLen));
        const score = idf * ((tf * 2.2) / denom) * Math.min(3, qn);
        scores.set(chunkId, (scores.get(chunkId) || 0) + score);
      }
    }
    // Entity leg: entities of this card that appear in the query point at their chunks. Pure string
    // work, and it recovers queries that share no token with the stored text.
    let entChunkIds: unknown[] = [];
    try {
      const ents = arrOf(await readReq(db, ST_ENTS, function (s2) { return s2.index("cid").getAll(cid); }));
      const hitEnts = ents.filter(function (e) { const r = recOf(e); return e && r.name && q.indexOf(String(r.name)) >= 0; });
      const seen = new Set<unknown>();
      for (const e of hitEnts) for (const id of arrOf(recOf(e).chunkIds)) if (!seen.has(id)) { seen.add(id); entChunkIds.push(id); }
    } catch (e) { entChunkIds = []; }

    if (!scores.size && !entChunkIds.length) return [];

    // RRF fusion of the two legs: score = Σ 1/(60+rank).
    const lexRanked = Array.from(scores.entries()).sort(function (a, b) { return b[1] - a[1]; }).map(function (x) { return x[0]; });
    const merged = new Map<unknown, number>();
    lexRanked.forEach(function (id, i) { merged.set(id, (merged.get(id) || 0) + 1 / (60 + i + 1)); });
    entChunkIds.forEach(function (id, i) { merged.set(id, (merged.get(id) || 0) + 1 / (60 + i + 1)); });
    const top = Array.from(merged.entries()).sort(function (a, b) { return b[1] - a[1]; }).slice(0, Math.max(1, Math.min(10, Number(topK) || 5)));
    const byDoc = new Map<unknown, Record<string, unknown>>();
    docs.forEach(function (d) { byDoc.set(d.id, d); });
    const hits: KbHit[] = [];
    for (const [chunkId, score] of top) {
      const cRec = recOf(await readReq(db, ST_CHUNKS, function (s) { return s.get(chunkId); }));
      if (!cRec.id) continue; // lazy tombstone: the chunk went away with its document
      const d = byDoc.get(cRec.docId);
      if (!d) continue;
      hits.push({ title: d.title, docId: cRec.docId, chunkId: cRec.id, chunkOrd: cRec.ord, score: Math.round(score * 10000) / 10000, text: cRec.text, viaEntity: entChunkIds.indexOf(cRec.id) >= 0 });
    }
    return hits;
  }

  async function getDocText(docId: unknown): Promise<{ doc: Record<string, unknown>; text: string } | null> {
    const db = await open();
    const d = recOf(await readReq(db, ST_DOCS, function (s) { return s.get(String(docId || "")); }));
    if (!d.id) return null;
    let chunks: Array<Record<string, unknown>> = [];
    try { chunks = arrOf(await readReq(db, ST_CHUNKS, function (s) { return s.getAll(rangeDoc(String(d.id))); })).map(recOf); } catch (e) {}
    chunks.sort(function (a, b) { return Number(a.ord || 0) - Number(b.ord || 0); });
    return { doc: d, text: chunks.map(function (c) { return String(c.text || ""); }).join("") };
  }

  async function removeDoc(docId: unknown): Promise<{ ok: boolean; removedChunks: number }> {
    const db = await open();
    const chunks = arrOf(await readReq(db, ST_CHUNKS, function (s) { return s.getAll(rangeDoc(String(docId))); })).map(recOf);
    await writeTx(db, [ST_DOCS, ST_CHUNKS], function (t) {
      t.objectStore(ST_DOCS).delete(String(docId));
      const cs = t.objectStore(ST_CHUNKS);
      for (const c of chunks) cs.delete(c.id);
    });
    await writeTx(db, ST_META, function (t) {
      const m = t.objectStore(ST_META);
      const r = m.get("stats");
      r.onsuccess = function () {
        const rr = recOf(r.result);
        const st0 = (r.result && rr.v && typeof rr.v === "object" && !Array.isArray(rr.v)) ? recOf(rr.v) : { nChunks: 0, totalLen: 0 };
        const st = { nChunks: Number(st0.nChunks || 0), totalLen: Number(st0.totalLen || 0) };
        st.nChunks = Math.max(0, st.nChunks - chunks.length);
        for (const c of chunks) st.totalLen = Math.max(0, st.totalLen - Number(c.len || 0));
        m.put({ k: "stats", v: st });
      };
    });
    // Postings are tombstoned lazily: the entry stays and simply fails the chunk lookup in search().
    // Only the keys this document touched are rewritten, which keeps the index from growing
    // without bound; a key that is already gone is not an error.
    const keys = new Set<string>();
    for (const c of chunks) for (const k of tokenize(c.text).keys()) keys.add(k);
    for (const k of keys) {
      await writeTx(db, ST_POSTINGS, function (t) {
        const os = t.objectStore(ST_POSTINGS);
        const r = os.get(k);
        r.onsuccess = function () {
          const rr = recOf(r.result);
          const cur = (r.result && Array.isArray(rr.entries))
            ? arrOf(rr.entries).filter(function (e) { const ee = Array.isArray(e) ? e : []; return String(ee[0]).indexOf(String(docId) + "#") !== 0; })
            : [];
          if (cur.length) os.put({ key: k, entries: cur }); else os.delete(k);
        };
      });
    }
    try { ports.uiRefresh(); } catch (e) {}
    return { ok: true, removedChunks: chunks.length };
  }

  /** Compose the "knowledge base hits" block for one card's request (app.js awaits it before sending). */
  async function buildInjection(card: unknown, queryText: unknown): Promise<string> {
    const cardRec = (card && typeof card === "object") ? recOf(card) : null;
    const id = (typeof card === "string") ? card : (cardRec ? cardRec.id : null);
    if (!id) return "";
    const q = String(queryText || "").trim();
    if (q.length < 2) return "";
    let hits: KbHit[] = [];
    try { hits = await search(id, q, INJECT_MAX_CHUNKS); } catch (e) { return ""; }
    if (!hits.length) return "";
    let used = 0;
    const parts: string[] = [];
    for (const h of hits) {
      const piece = "〔" + String(h.title) + "·第" + (Number(h.chunkOrd) + 1) + "段〕" + String(h.text);
      if (used + piece.length > INJECT_MAX_CHARS) break;
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
      description: "把你（当前角色）的『小本子』里某个键写下来 —— 角色专属的本地键值库，用来记事实/进度/清单（别的角色看不到）。",
      parameters: { type: "object", properties: { key: { type: "string", description: "键名，如「项目进度」「用户偏好」" }, value: { type: "string", description: "内容（字符串；结构化数据请自己 JSON.stringify）" } }, required: ["key", "value"] },
      async run(args: unknown, ctx: unknown) {
        const cid = cardIdOf(ctx);
        if (!cid) return { ok: false, error: "没有当前角色（先挂一张角色卡）" };
        const a = recOf(args);
        const key = String(a.key || "").trim();
        if (!key) return { ok: false, error: "缺少 key" };
        const val = String(a.value == null ? "" : a.value);
        const db = await open();
        await writeTx(db, ST_KV, function (t) { t.objectStore(ST_KV).put({ k: idbKey(cid, key), cardId: cid, key: key, value: val, at: Date.now() }); });
        return { ok: true, key: key, chars: val.length, note: "已记在你的小本子上（本地 IndexedDB，不进云）" };
      },
    });
    reg.define({
      name: "char_db_get",
      description: "读你（当前角色）的『小本子』：传 key 取单条；不传则列出全部键名与长度。",
      parameters: { type: "object", properties: { key: { type: "string", description: "键名；省略 = 列出全部键" } } },
      async run(args: unknown, ctx: unknown) {
        const cid = cardIdOf(ctx);
        if (!cid) return { ok: false, error: "没有当前角色" };
        const db = await open();
        const a = (args && typeof args === "object") ? args : {};
        const key = (a as { key?: unknown }).key;
        if (key) {
          const rec = recOf(await readReq(db, ST_KV, function (s) { return s.get(idbKey(cid, key)); }));
          if (!rec.k) return { ok: false, error: "没有这个键：" + String(key) };
          return { ok: true, key: rec.key, value: rec.value, at: rec.at };
        }
        const all = arrOf(await readReq(db, ST_KV, function (s) { return s.getAll(ports.keyRangeBound(cid + "::", cid + "::\uffff")); }));
        return { ok: true, keys: all.map(function (r) { const rr = recOf(r); return { key: rr.key, chars: String(rr.value || "").length, at: rr.at }; }) };
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
        const db = await open();
        await writeTx(db, ST_KV, function (t) { t.objectStore(ST_KV).delete(idbKey(cid, key)); });
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

  /** Card-deletion cascade: drop this card's documents, chunks, postings and scratchpad keys so
   *  nothing is orphaned. Called from the character service's card cleanup. */
  async function removeCard(cardId: unknown): Promise<{ ok: boolean; docs?: number; kvKeys?: number; error?: string }> {
    const cid = String(cardId || "");
    if (!cid) return { ok: false, error: "缺少 cardId" };
    let docs: Array<Record<string, unknown>> = [];
    try { docs = await listDocs(cid); } catch (e) {}
    for (const d of docs) { try { await removeDoc(d.id); } catch (e) {} }
    const db = await open();
    const kv = arrOf(await readReq(db, ST_KV, function (s) { return s.getAll(ports.keyRangeBound(cid + "::", cid + "::\uffff")); }));
    await writeTx(db, ST_KV, function (t) { const os = t.objectStore(ST_KV); for (const r of kv) os.delete(recOf(r).k); });
    return { ok: true, docs: docs.length, kvKeys: kv.length };
  }

  async function listEntities(cardId: unknown): Promise<unknown[]> {
    const db = await open();
    return arrOf(await readReq(db, ST_ENTS, function (s2) { return s2.index("cid").getAll(String(cardId || "")); }));
  }

  return {
    defineTools, importText, listDocs, removeDoc, removeCard, search, getDocText, buildInjection,
    extractEntities, listEntities,
    _db: DB,
  };
}
