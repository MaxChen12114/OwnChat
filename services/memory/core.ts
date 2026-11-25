/**
 * Character memory core: L1 episodes and L2 consolidated conclusions.
 *
 * `services/memory/char-memory.ts` owns L3 (scratchpad) and L4 (knowledge base), so the split is
 * by memory layer rather than by storage.
 *
 * One extraction, N writes: `extract()` is the only model call on the write path, `putFacts()` is
 * pure storage, and `remember()` fans the same facts out to every character who was in earshot.
 * Retrieval is BM25 (Chinese bigrams) → one-hop entity expansion → RRF, plus a vector arm that
 * plugs into an empty slot whenever the embedding model happens to be available.
 *
 * Ports, because this module has the heaviest environment dependencies of the domain:
 *   - `storage` — the two feature switches;
 *   - `db` — IndexedDB (one `epi` store with a `cid` index); the browser hands over the real
 *     implementation, the tests an in-memory stub;
 *   - `app` — the host one-shot call, used by extraction, query rewriting and consolidation;
 *   - `loadVectorPipe` — the browser loader for the vector leg (dynamic import + `location`, all
 *     browser code, lives in the wiring template). The service only tracks the
 *     wanted/ready/loading/failed state machine.
 *
 * Zero `as`, zero `any`: IndexedDB rows are narrowed at the port boundary by {@link MemRow}.
 * Equivalence lock: scripts/test-memory-core.mjs.
 * @module services/memory/core
 */

export interface KvStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** One memory row, matching the shape `putFacts` writes. */
export interface MemRow {
  id: string;
  cid: string;
  what: string;
  when: string;
  where: string;
  who: string;
  why: string;
  entities: string[];
  terms: string[];
  fact_kind: string;
  fact_type: string;
  kind: string;
  scene: string;
  ts: number;
  text: string;
  vec?: number[];
}

/** One raw fact as the model returned it; `putFacts` fills in the blanks. */
export type RawFact = Record<string, unknown>;

/** Minimal IndexedDB request shape, satisfied by the stub and by the real thing. */
export interface MemRequest<T> { result: T }
export interface MemIndex { getAll(cid: string): MemRequest<MemRow[]> }
export interface MemStore {
  index(name: string): MemIndex;
  put(row: MemRow): void;
  delete(id: string): void;
}
/**
 * IndexedDB port. When `fn` returns `{__req}`, the implementation resolves with `req.result`
 * once the transaction completes; a plain return value resolves directly.
 */
export interface MemDb {
  tx<T>(mode: "readonly" | "readwrite", fn: (st: MemStore) => T | { __req: MemRequest<unknown> }): Promise<T>;
}

export interface MemApp {
  oneShot?(o: { system: string; user: string; timeoutMs?: number }): Promise<unknown>;
}

/** Shape of the vector leg (transformers.js feature-extraction, already pooled and normalised). */
export interface VectorPipe {
  (text: string, o: { pooling: string; normalize: boolean }): Promise<{ data: ArrayLike<number> }>;
}

export interface MemoryPorts {
  storage: KvStorage;
  db: MemDb;
  app(): MemApp | null;
  /** Vector-leg loader: dynamic import in the browser, `null` in the stub. */
  loadVectorPipe(): Promise<VectorPipe | null>;
}

export interface MemoryState {
  wanted: boolean;
  ready: boolean;
  loading: boolean;
  failed: boolean;
}

export interface RecallHit {
  id: string;
  what: string;
  when: string;
  who: string;
  type: string;
  kind: string;
  entities: string[];
  score: number;
  ts: number;
}

export interface RecallResult {
  ok: boolean;
  hits: RecallHit[];
  total: number;
  arms: { lex: number; ent: number; vec?: number; entities?: string[]; expanded?: string[] | null };
  error?: string;
}

// One scored row: shared by the BM25, RRF and vector arms.
interface Scored { doc: MemRow; score: number }

// Bridge from `object` to a record, without a cast.
function toRecord(o: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) out[k] = v;
  return out;
}
function numOf(v: unknown): number { return typeof v === "number" ? v : 0; }

export function createMemCore(ports: MemoryPorts): MemoryFacade {
  const storage = ports.storage;
  const DB_NAME = "cfw_char_mem_v2", DB_VER = 1, ST = "epi";
  const LS_ON = "cfw_mem_v1";   // "1" on, "0" off, on by default

  function enabled(): boolean {
    try { return storage.getItem(LS_ON) !== "0"; } catch { return true; }
  }

  function tx<T>(mode: "readonly" | "readwrite", fn: (st: MemStore) => T | { __req: MemRequest<unknown> }): Promise<T> {
    return ports.db.tx<T>(mode, fn);
  }

  // ---------- tokenizer: Chinese bigrams + Latin words ----------
  function tok(s: unknown): string[] {
    const t = String(s || "").toLowerCase();
    const out: string[] = [];
    const lat = t.match(/[a-z0-9_]{2,}/g) || [];
    for (let i = 0; i < lat.length; i++) out.push(lat[i]);
    const segs = t.replace(/[^\u4e00-\u9fa5]+/g, " ").split(/\s+/);
    for (let j = 0; j < segs.length; j++) {
      const w = segs[j];
      for (let k = 0; k < w.length - 1; k++) out.push(w.slice(k, k + 2));
      if (w.length === 1) out.push(w);
    }
    return out;
  }

  function bm25(docs: MemRow[], query: unknown, k1?: number, b?: number): Scored[] {
    const k1v = k1 || 1.4; const bv = b || 0.75;
    const N = docs.length; if (!N) return [];
    const toks = docs.map(function (d) { return tok(d.text); });
    const avg = toks.reduce(function (a, t) { return a + t.length; }, 0) / N || 1;
    const df: Record<string, number> = {}; toks.forEach(function (t) { t.forEach(function (x) { df[x] = (df[x] || 0) + 1; }); });
    const qset: Record<string, number> = {}; tok(query).forEach(function (x) { qset[x] = 1; });
    return docs.map(function (d, i) {
      const tf: Record<string, number> = {}; toks[i].forEach(function (x) { tf[x] = (tf[x] || 0) + 1; });
      let s = 0;
      for (const term in qset) {
        if (!tf[term]) continue;
        const idf = Math.log(1 + (N - df[term] + 0.5) / (df[term] + 0.5));
        s += idf * (tf[term] * (k1v + 1)) / (tf[term] + k1v * (1 - bv + bv * toks[i].length / avg));
      }
      return { doc: d, score: s };
    }).filter(function (x) { return x.score > 0; }).sort(function (a, b2) { return b2.score - a.score; });
  }

  // ---------- RRF (the formula from Hindsight's search/fusion.py) ----------
  function rrf(arms: Scored[][], k?: number): Scored[] {
    const kv = k || 60;
    const score: Record<string, number> = {}, seen: Record<string, MemRow> = {};
    arms.forEach(function (list) {
      (list || []).forEach(function (item: Scored, i: number) {
        const id = item.doc ? item.doc.id : "";
        if (!id) return;
        if (!seen[id]) { seen[id] = item.doc; score[id] = 0; }
        score[id] += 1 / (kv + i + 1);
      });
    });
    return Object.keys(score).map(function (id) { return { doc: seen[id], score: score[id] }; })
      .sort(function (a, b) { return b.score - a.score; });
  }

  // ---------- extraction prompt (verbatim from Hindsight; do not translate) ----------
  const EXTRACT_SYSTEM = [
    "Extract SIGNIFICANT facts from text. Be SELECTIVE — only extract facts worth remembering long-term.",
    "",
    "LANGUAGE: Write every fact in the same language and script as the input text. Never translate. Names, identifiers, code, and quoted text stay verbatim.",
    "",
    "FACT FORMAT — BE CONCISE",
    "1. \"what\": core fact, 1-2 sentences max.",
    "2. \"when\": temporal info if mentioned, else \"N/A\".",
    "3. \"where\": location if relevant, else \"N/A\".",
    "4. \"who\": people involved with relationships, else \"N/A\".",
    "5. \"why\": context/significance only if important, else \"N/A\".",
    "",
    "COREFERENCE RESOLUTION: link generic references to names when both appear.",
    "  \"my roommate\" + \"Emily\" → \"Emily (user's roommate)\"",
    "",
    "CLASSIFICATION",
    "fact_kind: \"event\" (a specific datable occurrence) or \"conversation\" (ongoing state, preference, trait).",
    "fact_type: \"world\" (objective facts, other people's statements, constraints) or \"assistant\" (what THIS speaker itself did, learned, decided).",
    "entities: ALWAYS an array of plain strings, never objects, never null. Empty array [] only if nothing is named.",
    "search_terms: 3-6 short terms a future RETRIEVAL query might use for this fact — synonyms, hypernyms, domain words.",
    "  Facts are worded narrowly (\"owes 300 shi of grain\"); later questions say \"supplies\" or \"logistics\".",
    "  Put those likely query words here so a lexical index can still find it. Same language, never translate.",
    "",
    "OUTPUT: a JSON array only, no prose, no code fences. Each element:",
    "{\"what\":\"…\",\"when\":\"…\",\"where\":\"…\",\"who\":\"…\",\"why\":\"…\",\"fact_kind\":\"event|conversation\",\"fact_type\":\"world|assistant\",\"entities\":[\"…\"],\"search_terms\":[\"…\"]}",
    "If nothing is worth remembering, output [].",
  ].join("\n");

  function parseJSONArray(s: unknown): RawFact[] {
    let t = String(s || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const i = t.indexOf("["), j = t.lastIndexOf("]");
    if (i >= 0 && j > i) t = t.slice(i, j + 1);
    try { const a: unknown = JSON.parse(t); return Array.isArray(a) ? a : []; } catch { return []; }
  }

  // ---------- extraction: the only model call on the write path ----------
  async function extract(text: unknown, opts?: { timeoutMs?: number }): Promise<RawFact[]> {
    const o = opts || {};
    try {
      // Mirrors the original: a missing host bridge throws here, and the catch below yields [].
      const out = await ports.app().oneShot({ system: EXTRACT_SYSTEM, user: String(text || ""), timeoutMs: o.timeoutMs || 45000 });
      return parseJSONArray(out).slice(0, 8).filter(function (f) {
        return typeof f === "object" && f !== null && "what" in f && f.what;
      });
    } catch { return []; }
  }

  // ---------- vector leg: the state machine lives here, the loader in the wiring ----------
  const LS_VEC = "cfw_mem_vec_v1";
  let _pipe: VectorPipe | null = null, _pipeLoading: Promise<VectorPipe | null> | null = null, _vecFailed = false;

  function vectorsWanted(): boolean { try { return storage.getItem(LS_VEC) !== "0"; } catch { return true; } }
  function vectorsReady(): boolean { return !!_pipe; }
  function vectorState(): MemoryState { return { wanted: vectorsWanted(), ready: !!_pipe, loading: !!_pipeLoading, failed: _vecFailed }; }

  async function loadVectors(): Promise<VectorPipe | null> {
    if (_pipe) return _pipe;
    if (_pipeLoading) return _pipeLoading;
    if (_vecFailed) return null;
    _pipeLoading = (async function (): Promise<VectorPipe | null> {
      try {
        const p = await ports.loadVectorPipe();
        if (p) { _pipe = p; return _pipe; }
        _vecFailed = true; _pipe = null;
        return null;
      } catch (e) {
        _vecFailed = true; _pipe = null;
        try {
          const msg = (typeof e === "object" && e !== null && "message" in e) ? e.message : e;
          console.warn("[memory] 向量腿加载失败，已退回词法：", msg);
        } catch {}
        return null;
      } finally { _pipeLoading = null; }
    })();
    return _pipeLoading;
  }

  async function embed(text: string): Promise<number[] | null> {
    const p = await loadVectors();
    if (!p) return null;
    try {
      const out = await p(String(text || "").slice(0, 512), { pooling: "mean", normalize: true });
      return Array.prototype.slice.call(out.data);
    } catch { return null; }
  }

  function cosine(a: number[] | null, b: number[] | null): number {
    if (!a || !b || a.length !== b.length) return 0;
    let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i];
    return d; // already normalised
  }

  // ---------- writing (no model call) ----------
  async function putFacts(cid: string, facts: unknown[], opts?: { kind?: string; scene?: string }): Promise<number> {
    const o = opts || {};
    const c = String(cid || "");
    if (!c || !Array.isArray(facts) || !facts.length) return 0;
    const now = Date.now();
    const rows: MemRow[] = facts.map(function (f, i): MemRow | null {
      if (typeof f !== "object" || f === null) return null;
      const r = toRecord(f);
      const terms: unknown[] = Array.isArray(r.search_terms) ? r.search_terms : [];
      const ents: unknown[] = Array.isArray(r.entities) ? r.entities : [];
      const text = String(r.what || "") + (terms.length ? " " + terms.slice(0, 6).map(String).join(" ") : "");
      return {
        id: c + ":" + now + ":" + i + ":" + Math.random().toString(36).slice(2, 6),
        cid: c,
        what: String(r.what || "").slice(0, 400),
        when: String(r.when === undefined ? "N/A" : r.when).slice(0, 80),
        where: String(r.where === undefined ? "N/A" : r.where).slice(0, 80),
        who: String(r.who === undefined ? "N/A" : r.who).slice(0, 160),
        why: String(r.why === undefined ? "N/A" : r.why).slice(0, 300),
        entities: ents.slice(0, 12).map(String),
        terms: terms.slice(0, 6).map(String),
        fact_kind: r.fact_kind === "event" ? "event" : "conversation",
        fact_type: r.fact_type === "assistant" ? "assistant" : "world",
        kind: String(o.kind || "observed"),
        scene: String(o.scene || ""),
        ts: now,
        // Widen at write time: fold search_terms into the indexed text, so a differently
        // worded question can still hit.
        text: text,
      };
    }).filter(function (r): r is MemRow { return !!r && !!r.what; });
    if (vectorsWanted() && !vectorsReady() && !_pipeLoading && !_vecFailed) loadVectors();
    if (vectorsReady()) {
      for (let vi = 0; vi < rows.length; vi++) {
        const v = await embed(rows[vi].text);
        if (v) rows[vi].vec = v;
      }
    }
    await tx("readwrite", function (st) { rows.forEach(function (r) { st.put(r); }); return null; });
    return rows.length;
  }

  // ---------- remember: one extraction, fanned out to every character who should keep it ----------
  async function remember(text: unknown, opts?: {
    speakerCid?: string;
    listenerCids?: string[];
    cid?: string;
    kind?: string;
    scene?: string;
    timeoutMs?: number;
  }): Promise<{ ok: boolean; skipped?: boolean; stored?: number; banks?: string[] }> {
    const o = opts || {};
    const raw = String(text || "").trim();
    if (!raw || !enabled()) return { ok: false, skipped: true };
    const facts = await extract(raw, o);
    if (!facts.length) return { ok: true, stored: 0 };
    const out: { ok: boolean; stored: number; banks: string[] } = { ok: true, stored: 0, banks: [] };
    const sp = o.speakerCid ? String(o.speakerCid) : "";
    const ls = Array.isArray(o.listenerCids) ? o.listenerCids.map(String) : [];
    if (sp) { out.stored += await putFacts(sp, facts, { kind: o.kind || "said", scene: o.scene }); out.banks.push(sp); }
    for (let i = 0; i < ls.length; i++) {
      if (ls[i] === sp) continue;
      out.stored += await putFacts(ls[i], facts, { kind: "heard", scene: o.scene });
      out.banks.push(ls[i]);
    }
    if (!sp && !ls.length && o.cid) { out.stored += await putFacts(o.cid, facts, { kind: o.kind || "observed" }); out.banks.push(o.cid); }
    return out;
  }

  // ---------- reading ----------
  async function allOf(cid: string): Promise<MemRow[]> {
    const rows = await tx<MemRow[]>("readonly", function (st) { return { __req: st.index("cid").getAll(String(cid)) }; });
    return (rows || []).sort(function (a, b) { return numOf(b.ts) - numOf(a.ts); });
  }

  // ---------- query rewriting, used only when the first pass recalls nothing ----------
  const EXPAND_SYSTEM = [
    "Extract search keywords from the query so a lexical index can find the relevant stored facts.",
    "Output a JSON array of 3-8 short terms: entities, synonyms, and domain words likely to appear in a stored fact.",
    "Same language as the query. Never translate. No prose, no code fences.",
  ].join(String.fromCharCode(10));
  async function expandQuery(q: unknown): Promise<string[]> {
    try {
      const out = await ports.app().oneShot({ system: EXPAND_SYSTEM, user: String(q || ""), timeoutMs: 20000 });
      let t = String(out || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
      const i = t.indexOf("["), j = t.lastIndexOf("]");
      if (i >= 0 && j > i) t = t.slice(i, j + 1);
      const a: unknown = JSON.parse(t);
      return Array.isArray(a) ? a.map(String).filter(Boolean).slice(0, 8) : [];
    } catch { return []; }
  }

  // recall: BM25 arm + one-hop entity arm → RRF fusion
  async function recall(cid: string, query: unknown, opts?: {
    k?: number;
    expand?: boolean;
    vector?: boolean;
    timeoutMs?: number;
  }): Promise<RecallResult> {
    const o = opts || {};
    const k = o.k || 5;
    // Vectors wanted but not loaded yet: warm them in the background, this call stays lexical.
    if (vectorsWanted() && !vectorsReady() && !_pipeLoading && !_vecFailed) loadVectors();
    const rows = await allOf(cid);
    if (!rows.length) return { ok: true, hits: [], total: 0, arms: { lex: 0, ent: 0 } };

    let lex = bm25(rows, String(query || ""), 1.4, 0.75).slice(0, k * 3);

    // Entity expansion, query side, no model: entities of this card that appear in the query.
    const known: Record<string, number> = {};
    rows.forEach(function (r) { (r.entities || []).forEach(function (e) { if (e) known[e] = 1; }); });
    const q = String(query || "");
    const want: Record<string, number> = {};
    Object.keys(known).forEach(function (e) { if (e.length >= 2 && q.indexOf(e) >= 0) want[e] = 1; });
    lex.forEach(function (x) { (x.doc.entities || []).forEach(function (e) { if (e) want[e] = 1; }); });
    let wantKeys = Object.keys(want);
    let entArm: Scored[] = [];
    if (wantKeys.length) {
      const seen: Record<string, number> = {};
      rows.forEach(function (r) {
        if (seen[r.id]) return;
        if ((r.entities || []).some(function (e) { return want[e]; })) { seen[r.id] = 1; entArm.push({ doc: r, score: 1 }); }
      });
    }

    // Nothing on the first pass: rewrite the query once and retry with synonyms and domain words.
    let expanded: string[] | null = null;
    if (!lex.length && !entArm.length && o.expand !== false) {
      const terms = await expandQuery(query);
      if (terms.length) {
        expanded = terms;
        const lex2 = bm25(rows, terms.join(" "), 1.4, 0.75).slice(0, k * 3);
        const want2: Record<string, number> = {};
        terms.forEach(function (t) { Object.keys(known).forEach(function (e) { if (e && (t.indexOf(e) >= 0 || e.indexOf(t) >= 0)) want2[e] = 1; }); });
        const ent2: Scored[] = [];
        if (Object.keys(want2).length) {
          rows.forEach(function (r) { if ((r.entities || []).some(function (e) { return want2[e]; })) ent2.push({ doc: r, score: 1 }); });
        }
        lex = lex2; entArm = ent2;
        Object.keys(want2).forEach(function (e) { want[e] = 1; });
        wantKeys = Object.keys(want);
      }
    }

    // Vector arm, only when enabled and the model is ready; otherwise the arm is absent and RRF degrades on its own.
    let vecArm: Scored[] = [];
    if (vectorsReady() && o.vector !== false) {
      const qv = await embed(String(query || ""));
      if (qv) {
        vecArm = rows.reduce(function (acc: Scored[], r) {
          if (Array.isArray(r.vec) && r.vec.length) {
            const score = cosine(qv, r.vec);
            if (score > 0.30) acc.push({ doc: r, score: score });
          }
          return acc;
        }, []).sort(function (a, b) { return b.score - a.score; }).slice(0, k * 3);
      }
    }

    const fused = rrf([lex, entArm, vecArm], 60).slice(0, k);
    return {
      ok: true, total: rows.length,
      arms: { lex: lex.length, ent: entArm.length, vec: vecArm.length, entities: wantKeys.slice(0, 8), expanded: expanded },
      hits: fused.map(function (x) {
        const d = x.doc;
        return { id: d.id, what: d.what, when: d.when, who: d.who, type: d.fact_type, kind: d.kind, entities: d.entities, score: +x.score.toFixed(4), ts: d.ts };
      }),
    };
  }

  // Pre-request assembly
  async function buildInjection(cid: string, query: unknown, opts?: { k?: number }): Promise<string> {
    try {
      const r = await recall(cid, query, opts || { k: 4 });
      if (!r.ok || !r.hits.length) return "";
      const lines = r.hits.map(function (h) {
        // "May be untrue": a character reuses its own previous fabrication as fact (observed).
        const tag = h.kind === "said" ? "（我说过·未必为真）" : h.kind === "whisper" ? "（私下被告知）" : h.kind === "heard" ? "（我听说的）" : "（我看到的）";
        return "- " + tag + h.what;
      });
      return "\n\n【你的记忆】\n" + lines.join("\n") + "\n（这些是你自己记得的事，未必与当前局面一致；不要整段复述。）";
    } catch { return ""; }
  }

  // ---------- consolidation (L1 → L2) ----------
  async function reflect(cid: string, question?: unknown): Promise<{ ok: boolean; conclusion?: string; error?: string }> {
    const rows = await allOf(cid);
    if (!rows.length) return { ok: false, error: "这个角色还没有记忆" };
    const digest = rows.slice(0, 40).map(function (r, i) { return (i + 1) + ". " + r.what; }).join("\n");
    const sys = "You compress a character's episodic memories into durable conclusions.\n" +
      "Write in the same language as the memories. Be concrete, keep names and numbers.\n" +
      "Output 3-6 short bullet lines, no preamble. Each bullet must be a claim the character would still hold later.";
    let out: unknown = "";
    try {
      // Mirrors the original: reads the host one-shot directly, so a missing bridge lands in the same catch.
      const app = ports.app();
      const shot = app.oneShot;
      out = await shot({ system: sys, user: "Question/direction: " + String(question || "这一段的经过与结论") + "\n\nMemories:\n" + digest, timeoutMs: 60000 });
    } catch (e) {
      const msg = (typeof e === "object" && e !== null && "message" in e) ? e.message : e;
      return { ok: false, error: String(msg) };
    }
    const text = String(out || "").trim();
    if (!text) return { ok: false, error: "巩固没有产出" };
    await putFacts(cid, [{ what: text, why: "consolidated", fact_type: "assistant", fact_kind: "conversation", entities: [] }], { kind: "conclusion" });
    return { ok: true, conclusion: text };
  }

  async function count(cid: string): Promise<number> { return (await allOf(cid)).length; }
  async function clear(cid: string): Promise<{ ok: boolean; removed: number }> {
    const rows = await allOf(cid);
    await tx("readwrite", function (st) { rows.forEach(function (r) { st.delete(r.id); }); return null; });
    return { ok: true, removed: rows.length };
  }

  return {
    v: 2,
    prompt: EXTRACT_SYSTEM,
    enabled: enabled,
    enableVectors: function (on: boolean): MemoryState {
      try { storage.setItem(LS_VEC, on ? "1" : "0"); } catch {}
      if (on) loadVectors(); return vectorState();
    },
    vectorState: vectorState, loadVectors: loadVectors,
    extract: extract, putFacts: putFacts, remember: remember,
    recall: recall, buildInjection: buildInjection, reflect: reflect,
    count: count, clear: clear, list: allOf,
    _tok: tok, _bm25: bm25, _rrf: rrf,
  };
}

export interface MemoryFacade {
  v: number;
  prompt: string;
  enabled(): boolean;
  enableVectors(on: boolean): MemoryState;
  vectorState(): MemoryState;
  loadVectors(): Promise<VectorPipe | null>;
  extract(text: unknown, opts?: { timeoutMs?: number }): Promise<RawFact[]>;
  putFacts(cid: string, facts: unknown[], opts?: { kind?: string; scene?: string }): Promise<number>;
  remember(text: unknown, opts?: {
    speakerCid?: string; listenerCids?: string[]; cid?: string; kind?: string; scene?: string; timeoutMs?: number;
  }): Promise<{ ok: boolean; skipped?: boolean; stored?: number; banks?: string[] }>;
  recall(cid: string, query: unknown, opts?: { k?: number; expand?: boolean; vector?: boolean; timeoutMs?: number }): Promise<RecallResult>;
  buildInjection(cid: string, query: unknown, opts?: { k?: number }): Promise<string>;
  reflect(cid: string, question?: unknown): Promise<{ ok: boolean; conclusion?: string; error?: string }>;
  count(cid: string): Promise<number>;
  clear(cid: string): Promise<{ ok: boolean; removed: number }>;
  list(cid: string): Promise<MemRow[]>;
  _tok(s: unknown): string[];
  _bm25(docs: MemRow[], query: unknown, k1?: number, b?: number): Scored[];
  _rrf(arms: Scored[][], k?: number): Scored[];
}
