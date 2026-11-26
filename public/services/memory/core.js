(function () {
/**
 * Character memory core: L1 episodes and L2 consolidated conclusions.
 *
 * `services/memory/char-memory.ts` owns L3 (scratchpad) and L4 (knowledge base), so the split is
 * by memory layer rather than by storage.
 *
 * One extraction, N writes: `extract()` is the only model call on the write path, `putFacts()` is
 * pure storage, and `remember()` fans the same facts out to every character who was in earshot.
 * Retrieval is the storage layer's FTS5 ranking → one-hop entity expansion → RRF, plus a vector arm
 * that plugs into an empty slot whenever the embedding model happens to be available.
 *
 * Storage is the unified `epi` table plus `memory_fts` (T3-A). Two consequences worth knowing:
 *   - the lexical arm is a database query now; the local BM25 that used to score rows in the page is
 *     gone (`dbSearchSql` owns the surface SQL, `memory_fts`/`bm25()` do the ranking);
 *   - the MATCH argument is the OR of the query's 3-code-point windows, never the whole sentence.
 *     `tokenize='trigram'` only answers a phrase that occurs literally in a stored row, and a
 *     question rarely is one. `queryTerms()` also reports the 2-character windows the index cannot
 *     serve; when the FTS arm finds nothing they go to one OR'd `LIKE` statement, which is how a
 *     two-character Chinese word still recalls a fact. Fusion, injection format and every budget are
 *     unchanged from the pre-migration implementation.
 *
 * Ports, because this module has the heaviest environment dependencies of the domain:
 *   - `settings` / `setVecEnabled` — the shared table in `services/memory/config.ts`;
 *   - `db` — the unified DbPort (`core/db.ts`): the browser hands over `window.dbSvc`'s forwarding
 *     port, the tests an in-memory `node:sqlite` port;
 *   - `app` — the host one-shot call, used by extraction, query rewriting and consolidation;
 *   - `loadVectorPipe` — the browser loader for the vector leg (dynamic import + `location`, all
 *     browser code, lives in the wiring template). The service only tracks the
 *     wanted/ready/loading/failed state machine.
 *
 * Zero `as`, zero `any`: database rows are narrowed at the port boundary by {@link toMemRow}.
 * Equivalence locks: tooling/scripts/test-memory-core.mjs (isolation properties) and test/memory-sql.test.mjs
 * (the storage base).
 * @module services/memory/core
 */

                                                   
                                             

// Separate emit product, bridged on `window.dbSearchSql` by tooling/l0/wiring/db-search.js (boot order puts
// it at #16, well before memory). Declared rather than imported because the emit channel carries
// import-free sources only; the SQL text, scope validation and limit clamps stay in that one place.
                                
                                       
                                                                       
  

/** One memory row, matching the shape `putFacts` writes. */
                         
             
              
               
               
                
              
              
                     
                  
                    
                    
               
                
             
                                                                                                 
               
                 
 

/** One raw fact as the model returned it; `putFacts` fills in the blanks. */
                                              

                         
                                                                                      
 

/** Shape of the vector leg (transformers.js feature-extraction, already pooled and normalised). */
                             
                                                                                                   
 

                              
                                                                                                  
                                                                    
                           
                                                                                   
                                   
                                           
             
                       
                                                                              
                                               
 

                              
                  
                 
                   
                  
 

                            
             
               
               
              
               
               
                     
                
             
 

                               
              
                    
                
                                                                                                    
                 
 

// One scored row: shared by the lexical, entity and vector arms.
                                               

/** Query-side terms split by what the trigram index can answer. */
                             
                                                                                            
                
                                                                                               
                 
 

// Bridge from `object` to a record, without a cast.
function toRecord(o        )                          {
  const out                          = {};
  for (const [k, v] of Object.entries(o)) out[k] = v;
  return out;
}
function numOf(v         )         { return typeof v === "number" ? v : 0; }
function strOf(v         )         { return typeof v === "string" ? v : ""; }

/** JSON column → string[]. A dirty cell is an empty list, never a crash on a read path. */
function jsonList(v         )           {
  if (typeof v !== "string" || !v) return [];
  try {
    const parsed          = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch (e) {
    return [];
  }
}

/** JSON column → number[]. Absent, empty or dirty means "this row has no vector". */
function jsonVec(v         )                       {
  if (typeof v !== "string" || !v) return undefined;
  try {
    const parsed          = JSON.parse(v);
    if (!Array.isArray(parsed)) return undefined;
    const out           = [];
    for (const item of parsed) {
      if (typeof item === "number" && Number.isFinite(item)) out.push(item);
    }
    return out.length ? out : undefined;
  } catch (e) {
    return undefined;
  }
}

// Column order used by every statement in this file; `when`/`where` need quoting (SQL keywords).
const COLS = 'id, cid, what, kind, fact_type, fact_kind, entities, terms, ts, "when", "where", who, why, scene, vec';
const INSERT_SQL = "INSERT INTO epi (" + COLS + ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)";

/** Storage row → service row. Terms are re-joined into `text` so the shape callers see is stable. */
function toMemRow(row       )         {
  const what = strOf(row.what);
  const terms = jsonList(row.terms);
  return {
    id: strOf(row.id),
    cid: strOf(row.cid),
    what: what,
    when: strOf(row.when),
    where: strOf(row.where),
    who: strOf(row.who),
    why: strOf(row.why),
    entities: jsonList(row.entities),
    terms: terms,
    fact_kind: strOf(row.fact_kind),
    fact_type: strOf(row.fact_type),
    kind: strOf(row.kind),
    scene: strOf(row.scene),
    ts: numOf(row.ts),
    text: what + (terms.length ? " " + terms.join(" ") : ""),
    vec: jsonVec(row.vec),
  };
}

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
const LATIN = /[A-Za-z0-9_]/;
const FTS_TERM_CAP = 24;
const LIKE_TERM_CAP = 6;

/** Keep head and tail of a long list instead of truncating it to its opening phrase. */
function sample(list          , cap        )           {
  if (list.length <= cap) return list;
  const step = (list.length - 1) / (cap - 1);
  const out           = [];
  for (let i = 0; i < cap; i++) out.push(list[Math.round(i * step)]);
  return out;
}

/**
 * Split a query into the terms each storage path can serve.
 *
 * Why windows and not words: Chinese is not whitespace-delimited, and the trigram index only
 * matches literal 3-character substrings, so every overlapping window of a CJK run is a term. A
 * two-character run and a two-character Latin word produce no window the index can answer; they are
 * reported under `like` so the caller can scan for them instead of silently losing the query.
 *
 * Shared with `services/memory/char-memory.ts` (published as `window.queryTerms` by the emitter);
 * one tokenizer, two memory surfaces.
 * @returns `{fts, like}`, both de-duplicated and capped (24 / 6).
 */
function queryTerms(q         )             {
  const s = String(q === undefined || q === null ? "" : q);
  const ftsAll           = [];
  const likeAll           = [];
  const seenF                         = {};
  const seenL                         = {};
  const pushF = function (t        )       {
    if (!t || seenF[t]) return;
    seenF[t] = 1;
    ftsAll.push(t);
  };
  const pushL = function (t        )       {
    if (!t || seenL[t]) return;
    seenL[t] = 1;
    likeAll.push(t);
  };
  const run           = [];
  let latin = "";
  const flushRun = function ()       {
    if (run.length >= 3) {
      for (let i = 0; i + 3 <= run.length; i++) pushF(run.slice(i, i + 3).join(""));
      for (let j = 0; j + 2 <= run.length; j++) pushL(run.slice(j, j + 2).join(""));
    } else if (run.length === 2) {
      pushL(run.join(""));
    }
    run.length = 0;
  };
  const flushLatin = function ()       {
    if (latin.length >= 3) pushF(latin);
    else if (latin.length === 2) pushL(latin);
    latin = "";
  };
  for (const ch of s) {
    if (CJK.test(ch)) { flushLatin(); run.push(ch); continue; }
    flushRun();
    if (LATIN.test(ch)) { latin += ch.toLowerCase(); continue; }
    flushLatin();
  }
  flushRun();
  flushLatin();
  return { fts: sample(ftsAll, FTS_TERM_CAP), like: sample(likeAll, LIKE_TERM_CAP) };
}

function createMemCore(ports             )               {
  // Settings live in services/memory/config.ts. A missing port is a wiring bug: report it and
  // fail closed (memory off, vectors off) instead of silently using a second copy of the defaults.
  function settings()                      {
    try {
      return ports.settings();
    } catch (e) {
      try { console.error("[memory] 记忆配置端口不可用，已按关闭处理", e); } catch (_) {}
      return null;
    }
  }

  function enabled()          {
    const cfg = settings();
    return cfg ? cfg.enabled : false;
  }

  // ---------- lexical arm: one statement per phase, ranking done by the database ----------
  //
  // Phase 1 is the FTS5 query. The SQL text, the scope value and the limit clamp come from
  // `dbSearchSql` so this file holds no second copy of the surface statement; only the MATCH
  // argument is replaced (the OR of the query windows, each still quoted as one FTS5 phrase so user
  // text can never become FTS5 syntax). Phase 2 only runs when phase 1 found nothing: the
  // two-character windows go out as one OR'd LIKE statement. Both phases are a single round trip,
  // which is what keeps a recall from turning into a burst of small queries.
  async function lexArm(cid        , query         , limit        )                    {
    const terms = queryTerms(query);
    const capped = dbSearchSql.clampSearchLimit(limit);
    const out           = [];
    const seen                         = {};
    function absorb(rows         )       {
      for (const row of rows) {
        const doc = toMemRow(row);
        if (!doc.id || seen[doc.id]) continue;
        seen[doc.id] = 1;
        // Rank order is the score: RRF consumes positions, not magnitudes.
        out.push({ doc: doc, score: 1 / (out.length + 1) });
      }
    }
    if (!terms.fts.length) {
      // The whole query sits below the trigram floor: the storage layer's own LIKE fallback answers
      // (the same branch `src/data-api.js` documents for short queries), one term at a time because
      // a single LIKE pattern cannot express "either of these two-character words".
      for (const term of terms.like) {
        absorb(await ports.db.search("memory", { cid: cid }, term, capped));
        if (out.length >= capped) break;
      }
      return out.slice(0, capped);
    }
    const built = dbSearchSql.buildSearchQuery("memory", { cid: cid }, terms.fts[0], capped);
    const expr = terms.fts.map(function (t) { return dbSearchSql.ftsPhrase(t); }).join(" OR ");
    const res = await ports.db.exec(built.sql, [expr, built.scope, built.limit]);
    absorb(res.rows);
    if (!out.length && terms.like.length) {
      const patterns = terms.like.map(function (t) { return dbSearchSql.likePattern(t); });
      // 0004: `terms` is part of the recall surface now — the old BM25 scored what+terms together,
      // and a fact whose useful word only sits in the extracted terms must survive the 2-char leg.
      const sql = "SELECT " + COLS + " FROM epi WHERE cid = ? AND ("
        + patterns.map(function () { return "(what LIKE ? ESCAPE '\\' OR terms LIKE ? ESCAPE '\\')"; }).join(" OR ")
        + ") ORDER BY ts DESC, id ASC LIMIT ?";
      const paramList            = [];
      for (const pattern of patterns) paramList.push(pattern, pattern);
      const params            = [cid, ...paramList, capped];
      const like = await ports.db.exec(sql, params);
      absorb(like.rows);
    }
    return out.slice(0, capped);
  }

  // ---------- RRF (the formula from Hindsight's search/fusion.py) ----------
  function rrf(arms            , k         )           {
    const kv = k || 60;
    const score                         = {}, seen                         = {};
    arms.forEach(function (list) {
      (list || []).forEach(function (item        , i        ) {
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

  function parseJSONArray(s         )            {
    let t = String(s || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const i = t.indexOf("["), j = t.lastIndexOf("]");
    if (i >= 0 && j > i) t = t.slice(i, j + 1);
    try { const a          = JSON.parse(t); return Array.isArray(a) ? a : []; } catch { return []; }
  }

  // ---------- extraction: the only model call on the write path ----------
  async function extract(text         , opts                         )                     {
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
  let _pipe                    = null, _pipeLoading                                    = null, _vecFailed = false;

  function vectorsWanted()          {
    const cfg = settings();
    return cfg ? cfg.vecEnabled : false;
  }
  function vectorsReady()          { return !!_pipe; }
  function vectorState()              { return { wanted: vectorsWanted(), ready: !!_pipe, loading: !!_pipeLoading, failed: _vecFailed }; }

  async function loadVectors()                             {
    if (_pipe) return _pipe;
    if (_pipeLoading) return _pipeLoading;
    if (_vecFailed) return null;
    _pipeLoading = (async function ()                             {
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

  async function embed(text        )                           {
    const p = await loadVectors();
    if (!p) return null;
    try {
      const out = await p(String(text || "").slice(0, 512), { pooling: "mean", normalize: true });
      return Array.prototype.slice.call(out.data);
    } catch { return null; }
  }

  function cosine(a                 , b                 )         {
    if (!a || !b || a.length !== b.length) return 0;
    let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i];
    return d; // already normalised
  }

  // ---------- writing (no model call) ----------
  async function putFacts(cid        , facts           , opts                                    )                  {
    const o = opts || {};
    const c = String(cid || "");
    if (!c || !Array.isArray(facts) || !facts.length) return 0;
    const now = Date.now();
    const rows           = facts.map(function (f, i)                {
      if (typeof f !== "object" || f === null) return null;
      const r = toRecord(f);
      const terms            = Array.isArray(r.search_terms) ? r.search_terms : [];
      const ents            = Array.isArray(r.entities) ? r.entities : [];
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
        // The vector leg embeds fact + search terms; the lexical index only sees `what` (schema).
        text: text,
      };
    }).filter(function (r)              { return !!r && !!r.what; });
    if (vectorsWanted() && !vectorsReady() && !_pipeLoading && !_vecFailed) loadVectors();
    if (vectorsReady()) {
      for (let vi = 0; vi < rows.length; vi++) {
        const v = await embed(rows[vi].text);
        if (v) rows[vi].vec = v;
      }
    }
    if (rows.length) {
      // Collect-then-commit (core/db.ts): the caller gets one atomic batch and no partial write.
      await ports.db.transaction(function (tx) {
        for (const r of rows) {
          tx.exec(INSERT_SQL, [
            r.id, r.cid, r.what, r.kind, r.fact_type, r.fact_kind,
            JSON.stringify(r.entities), JSON.stringify(r.terms), r.ts,
            r.when, r.where, r.who, r.why, r.scene,
            r.vec ? JSON.stringify(r.vec) : null,
          ]);
        }
        return null;
      });
    }
    return rows.length;
  }

  // ---------- remember: one extraction, fanned out to every character who should keep it ----------
  async function remember(text         , opts    
                        
                            
                 
                  
                   
                       
   )                                                                                 {
    const o = opts || {};
    const raw = String(text || "").trim();
    if (!raw || !enabled()) return { ok: false, skipped: true };
    const facts = await extract(raw, o);
    if (!facts.length) return { ok: true, stored: 0 };
    const out                                                   = { ok: true, stored: 0, banks: [] };
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
  async function allOf(cid        )                    {
    const c = String(cid || "");
    if (!c) return [];
    const res = await ports.db.exec("SELECT " + COLS + " FROM epi WHERE cid = ? ORDER BY ts DESC, id ASC", [c]);
    return res.rows.map(toMemRow);
  }

  // ---------- query rewriting, used only when the first pass recalls nothing ----------
  const EXPAND_SYSTEM = [
    "Extract search keywords from the query so a lexical index can find the relevant stored facts.",
    "Output a JSON array of 3-8 short terms: entities, synonyms, and domain words likely to appear in a stored fact.",
    "Same language as the query. Never translate. No prose, no code fences.",
  ].join(String.fromCharCode(10));
  async function expandQuery(q         )                    {
    try {
      const out = await ports.app().oneShot({ system: EXPAND_SYSTEM, user: String(q || ""), timeoutMs: 20000 });
      let t = String(out || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
      const i = t.indexOf("["), j = t.lastIndexOf("]");
      if (i >= 0 && j > i) t = t.slice(i, j + 1);
      const a          = JSON.parse(t);
      return Array.isArray(a) ? a.map(String).filter(Boolean).slice(0, 8) : [];
    } catch { return []; }
  }

  // recall: FTS arm + one-hop entity arm → RRF fusion
  async function recall(cid        , query         , opts    
               
                     
                     
                       
   )                        {
    const o = opts || {};
    const k = o.k || 5;
    // Vectors wanted but not loaded yet: warm them in the background, this call stays lexical.
    if (vectorsWanted() && !vectorsReady() && !_pipeLoading && !_vecFailed) loadVectors();
    const rows = await allOf(cid);
    if (!rows.length) return { ok: true, hits: [], total: 0, arms: { lex: 0, ent: 0 } };

    let lex = await lexArm(String(cid || ""), query, k * 3);

    // Entity expansion, query side, no model: entities of this card that appear in the query.
    const known                         = {};
    rows.forEach(function (r) { (r.entities || []).forEach(function (e) { if (e) known[e] = 1; }); });
    const q = String(query || "");
    const want                         = {};
    Object.keys(known).forEach(function (e) { if (e.length >= 2 && q.indexOf(e) >= 0) want[e] = 1; });
    lex.forEach(function (x) { (x.doc.entities || []).forEach(function (e) { if (e) want[e] = 1; }); });
    let wantKeys = Object.keys(want);
    let entArm           = [];
    if (wantKeys.length) {
      const seen                         = {};
      rows.forEach(function (r) {
        if (seen[r.id]) return;
        if ((r.entities || []).some(function (e) { return want[e]; })) { seen[r.id] = 1; entArm.push({ doc: r, score: 1 }); }
      });
    }

    // Nothing on the first pass: rewrite the query once and retry with synonyms and domain words.
    let expanded                  = null;
    if (!lex.length && !entArm.length && o.expand !== false) {
      const terms = await expandQuery(query);
      if (terms.length) {
        expanded = terms;
        const lex2 = await lexArm(String(cid || ""), terms.join(" "), k * 3);
        const want2                         = {};
        terms.forEach(function (t) { Object.keys(known).forEach(function (e) { if (e && (t.indexOf(e) >= 0 || e.indexOf(t) >= 0)) want2[e] = 1; }); });
        const ent2           = [];
        if (Object.keys(want2).length) {
          rows.forEach(function (r) { if ((r.entities || []).some(function (e) { return want2[e]; })) ent2.push({ doc: r, score: 1 }); });
        }
        lex = lex2; entArm = ent2;
        Object.keys(want2).forEach(function (e) { want[e] = 1; });
        wantKeys = Object.keys(want);
      }
    }

    // Vector arm, only when enabled and the model is ready; otherwise the arm is absent and RRF degrades on its own.
    let vecArm           = [];
    if (vectorsReady() && o.vector !== false) {
      const qv = await embed(String(query || ""));
      if (qv) {
        vecArm = rows.reduce(function (acc          , r) {
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
  async function buildInjection(cid        , query         , opts                 )                  {
    try {
      const cfg = settings();
      if (!cfg) return "";
      const r = await recall(cid, query, opts || { k: cfg.recallK });
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
  async function reflect(cid        , question          )                                                                {
    const cfg = settings();
    if (!cfg) return { ok: false, error: "记忆配置不可用" };
    const rows = await allOf(cid);
    if (!rows.length) return { ok: false, error: "这个角色还没有记忆" };
    const digest = rows.slice(0, cfg.reflectMaxRows).map(function (r, i) { return (i + 1) + ". " + r.what; }).join("\n");
    const sys = "You compress a character's episodic memories into durable conclusions.\n" +
      "Write in the same language as the memories. Be concrete, keep names and numbers.\n" +
      "Output 3-6 short bullet lines, no preamble. Each bullet must be a claim the character would still hold later.";
    let out          = "";
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

  async function count(cid        )                  {
    const c = String(cid || "");
    if (!c) return 0;
    const res = await ports.db.exec("SELECT COUNT(*) AS n FROM epi WHERE cid = ?", [c]);
    const row = res.rows[0];
    return row ? numOf(row.n) : 0;
  }

  async function clear(cid        )                                            {
    const c = String(cid || "");
    const removed = await count(c);
    if (!removed) return { ok: true, removed: 0 };
    // One statement is its own transaction; the count above only feeds the return value.
    await ports.db.exec("DELETE FROM epi WHERE cid = ?", [c]);
    return { ok: true, removed: removed };
  }

  return {
    v: 3,
    prompt: EXTRACT_SYSTEM,
    enabled: enabled,
    /** Whether the end-of-turn auto writer is on (cfw_mem_auto_v1, default off). */
    autoWriteEnabled: function ()          {
      const cfg = settings();
      return cfg ? cfg.autoWrite : false;
    },
    enableVectors: function (on         )              {
      try { ports.setVecEnabled(!!on); } catch (e) {
        try { console.warn("[memory] 向量腿开关写入失败", e); } catch (_) {}
      }
      if (on) loadVectors(); return vectorState();
    },
    vectorState: vectorState, loadVectors: loadVectors,
    extract: extract, putFacts: putFacts, remember: remember,
    recall: recall, buildInjection: buildInjection, reflect: reflect,
    count: count, clear: clear, list: allOf,
    _terms: queryTerms, _rrf: rrf,
  };
}

// Browser wiring (injected by tooling/l0/emit.mjs): binds the service to the frozen window contract name.
//
// Engine: services/memory/core.ts. Three things cannot live in a service and live here:
//   1) the SQL port — the `db` service `window.dbSvc` provides (T2), resolved per call so a host
//      switch never invalidates the port this facade captured;
//   2) the one-time move of the old IndexedDB bank (`cfw_char_mem_v2`, store `epi`) into the `epi`
//      table + `memory_fts`, and the browser-only vector loader;
//   3) the `window.__memCore` mount.
//
// T4-A: the whole block is a runtime plugin that injects `db`, so the guard is declarative instead
// of a lazy "if dbSvc exists" inside every call, and `dispose` removes the facade + the provided
// service reference. The migration keeps its own discipline:
//   · every port call awaits `ready`, so a recall that starts during the first boot sees migrated
//     rows instead of racing them;
//   · re-running is safe — the marker is written only after every batch committed, and each insert
//     is a primary-key upsert (`ON CONFLICT(id) DO UPDATE`, which also keeps `memory_fts` in step
//     through the UPDATE trigger);
//   · a failure deletes nothing: the IndexedDB database stays, the marker stays unset and the next
//     boot retries. A silent loss is worse than a duplicated write.
(function () {
  "use strict";
  var HOST = (typeof window !== "undefined" && window.runtimeCore && window.runtimeCore.host) || null;
  var G = (typeof window !== "undefined" ? window : globalThis);
  var DB_NAME = "cfw_char_mem_v2", DB_VER = 1, ST = "epi";
  var MARK = "cfw_mem_sql_migrated_v1";
  var BATCH = 150; // /api/data/tx refuses more than 200 statements per commit
  var UPSERT = "INSERT INTO epi (id, cid, what, kind, fact_type, fact_kind, entities, terms, ts, \"when\", \"where\", who, why, scene, vec)"
    + " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    + " ON CONFLICT(id) DO UPDATE SET cid=excluded.cid, what=excluded.what, kind=excluded.kind,"
    + " fact_type=excluded.fact_type, fact_kind=excluded.fact_kind, entities=excluded.entities,"
    + " terms=excluded.terms, ts=excluded.ts, \"when\"=excluded.\"when\", \"where\"=excluded.\"where\","
    + " who=excluded.who, why=excluded.why, scene=excluded.scene, vec=excluded.vec";

  function lsGet(key) {
    try { return G.localStorage.getItem(key); } catch (e) { return null; }
  }
  function lsSet(key, value) {
    try { G.localStorage.setItem(key, value); } catch (e) {}
  }
  function strOf(value) {
    return value === undefined || value === null ? null : String(value);
  }
  /** JSON column: a list of strings, or "[]" for anything else. */
  function listJson(value) {
    if (!Array.isArray(value)) return "[]";
    try { return JSON.stringify(value.map(String)); } catch (e) { return "[]"; }
  }
  /** JSON column: a numeric vector, or null (a row without a vector simply has no vector leg). */
  function vecJson(value) {
    if (!Array.isArray(value) || !value.length) return null;
    try { return JSON.stringify(value); } catch (e) { return null; }
  }

  function apply(ctx) {
    // The injected service first, then the facade fallback: a page that registered adapters the old
    // way (no runtime host) must keep working. Both answer exec/transaction/search.
    var injected = ctx && typeof ctx.get === "function" ? ctx.get("db") : null;
    function dbPort() {
      if (disposed) throw new Error("memory: 记忆插件已卸载（调用方持有的门面应立即重取）");
      if (injected && typeof injected.exec === "function") return injected;
      var svc = G.dbSvc;
      if (!svc || typeof svc.get !== "function") throw new Error("dbSvc 未接线（存储层未加载）");
      return svc.get();
    }

    function openLegacy() {
      return new Promise(function (resolve, reject) {
        var req;
        try { req = G.indexedDB.open(DB_NAME, DB_VER); } catch (e) { reject(e); return; }
        req.onupgradeneeded = function () {
          try {
            var d = req.result;
            if (!d.objectStoreNames.contains(ST)) {
              var s = d.createObjectStore(ST, { keyPath: "id" });
              s.createIndex("cid", "cid", { unique: false });
            }
          } catch (e) {}
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error || new Error("indexedDB.open(" + DB_NAME + ") 失败")); };
      });
    }

    function readLegacy(conn) {
      return new Promise(function (resolve, reject) {
        var req;
        try { req = conn.transaction(ST, "readonly").objectStore(ST).getAll(); } catch (e) { reject(e); return; }
        req.onsuccess = function () { resolve(Array.isArray(req.result) ? req.result : []); };
        req.onerror = function () { reject(req.error || new Error("读取旧 " + ST + " 失败")); };
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

    var disposed = false;

    async function migrate() {
      // No IndexedDB: a non-browser host, or a browser that never had the old bank. Nothing to move.
      if (!G.indexedDB) return;
      if (lsGet(MARK) === "1") return;
      var conn = null;
      try {
        conn = await openLegacy();
        var rows = [];
        try { rows = await readLegacy(conn); } catch (e) { rows = []; }
        try { conn.close(); } catch (e) {}
        conn = null;
        var moved = 0;
        for (var i = 0; i < rows.length; i += BATCH) {
          var slice = rows.slice(i, i + BATCH);
          await dbPort().transaction(function (tx) {
            for (var j = 0; j < slice.length; j++) {
              var r = slice[j] || {};
              if (!r.id || !r.cid) continue;
              tx.exec(UPSERT, [
                String(r.id), String(r.cid), String(r.what || ""), strOf(r.kind), strOf(r.fact_type), strOf(r.fact_kind),
                listJson(r.entities), listJson(r.terms), Number(r.ts) || 0,
                strOf(r.when), strOf(r.where), strOf(r.who), strOf(r.why), strOf(r.scene),
                vecJson(r.vec),
              ]);
              moved++;
            }
          });
        }
        var dropped = await dropLegacy();
        lsSet(MARK, "1");
        if (moved) console.info("[memory] 旧 IndexedDB 记忆已迁到 SQL：" + moved + " 条");
        if (rows.length && !dropped) console.warn("[memory] 旧 IndexedDB 删除失败（数据已全部迁到 SQL，残留库可手动清理）");
      } catch (e) {
        try { if (conn) conn.close(); } catch (_) {}
        console.warn("[memory] 旧记忆迁移失败，IndexedDB 原件保留，下次启动重试：", e);
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

    var ports = {
      // Settings are owned by services/memory/config.ts and mounted on this same facade by the next
      // wiring step (memory-config.js). Resolved per call so load order does not matter; a missing
      // table throws and the service reports it instead of guessing defaults.
      settings: function () {
        var cfg = G.__memCore && G.__memCore.config;
        if (!cfg) throw new Error("memory config 未接线（memory-config.js 未加载）");
        return cfg.read();
      },
      setVecEnabled: function (on) {
        var cfg = G.__memCore && G.__memCore.config;
        if (!cfg) throw new Error("memory config 未接线（memory-config.js 未加载）");
        cfg.write({ vecEnabled: !!on });
      },
      db: dbPortFwd,
      app: function () { return G.appSvc || null; },
      // Vector leg (browser only): transformers.js with its bundled webpack build (onnxruntime-web
      // included). Model and wasm are published with the repo under public/models/, loaded from a
      // same-origin path — no external network dependency at runtime.
      loadVectorPipe: function () {
        return (async function () {
          var mod = await import(new URL('/models/tf/transformers.min.js', location.origin).href);
          var env = mod.env;
          env.allowRemoteModels = true;
          env.remoteHost = (location && location.origin ? location.origin : '') + '/models';
          env.remotePathTemplate = '{model}/';
          env.useBrowserCache = true;
          env.allowLocalModels = false;
          try { env.backends.onnx.wasm.wasmPaths = (location && location.origin ? location.origin : '') + '/models/tf/'; } catch (e) {}
          return await mod.pipeline('feature-extraction', 'Xenova/bge-small-zh-v1.5', { quantized: true });
        })();
      },
    };

    var api = createMemCore(ports);
    G.__memCore = api;
    // Other plugins inject the memory core; the window name stays the compat surface.
    if (ctx && typeof ctx.provide === "function") {
      ctx.provide("memory", { v: 1, core: api, ready: ready });
    }
    return function dispose() {
      disposed = true;
      if (G.__memCore === api) {
        try { delete G.__memCore; } catch (e) { G.__memCore = undefined; }
      }
    };
  }

  var mod = { name: "memory", inject: ["db"], apply: apply };
  if (HOST) {
    HOST.define("memory", mod);
    HOST.start("memory");
    return;
  }
  apply({ get: function () { return null; }, provide: function () {} });
})();

globalThis.queryTerms = queryTerms;
globalThis.createMemCore = createMemCore;
})();
