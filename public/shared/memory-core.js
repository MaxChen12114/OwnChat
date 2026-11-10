// public/shared/memory-core.js — 角色记忆内核（2026-11-09 · Hindsight 的算法 + prompt，纯 JS）
// ─────────────────────────────────────────────────────────────────
// 为什么不起服务：Hindsight 的实质是「抽取 prompt + 条目结构 + 混合检索 + 巩固」，
// 这四样都是代码与文本，能直接搬进浏览器。它要跑服务只因为**模型权重**得靠 Python 加载。
// 这里保留英文 prompt 原文（抽取质量靠原文），检索走词法腿 + 实体一跳；
// 向量腿留了 arm 插槽（另加一路塞进 RRF 即可，接口不变）。
//
// 四层记忆：本文件负责 L1（经历）与 L2（巩固结论）；
//           L3/L4（长期事实与知识库）仍归 char-memory.js，不重复造。
//
// 关键设计——**一次抽取，分发 N 份**：
//   一句话被四个人听到，不该做四次抽取。抽取与归属分离：
//     extract(text)            → 事实数组（1 次模型调用）
//     putFacts(cid, facts)     → 写进某个角色的记忆（0 次调用）
//     remember(text, {speakerCid, listenerCids}) = 1 次抽取 + N 次写入
//   这就是"交流进入记忆"：谁说的、谁听到了，分别落各自的库。
//
// 检索：BM25（中文 bigram）→ 实体一跳扩展 → RRF 融合。
//   实体来自条目里的 entities[] 字段；查询侧只做**字面匹配**，不需要模型。
//   这解决了「问粮草、记忆里是石粮」这类字面不重合的问题（两条都带"灰港"就串上了）。
// ─────────────────────────────────────────────────────────────────
(function (global) {
  'use strict';
  if (global.__memCore && global.__memCore.v >= 2) return;

  var DB_NAME = 'cfw_char_mem_v2', DB_VER = 1, ST = 'epi';
  var LS_ON = 'cfw_mem_v1';   // 开关："1" 开，"0" 关；默认开
  var _db = null;

  function enabled() {
    try { return localStorage.getItem(LS_ON) !== '0'; } catch (e) { return true; }
  }

  function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (res, rej) {
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains(ST)) {
          var s = d.createObjectStore(ST, { keyPath: 'id' });
          s.createIndex('cid', 'cid', { unique: false });
        }
      };
      req.onsuccess = function () { _db = req.result; res(_db); };
      req.onerror = function () { rej(req.error); };
    });
  }
  function tx(mode, fn) {
    return openDB().then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction(ST, mode), st = t.objectStore(ST), out;
        try { out = fn(st); } catch (e) { rej(e); return; }
        t.oncomplete = function () { res(out && out.__req ? out.__req.result : out); };
        t.onerror = function () { rej(t.error); };
      });
    });
  }

  // ---------- 分词（中文 bigram + 拉丁词） ----------
  function tok(s) {
    var t = String(s || '').toLowerCase();
    var out = [];
    var lat = t.match(/[a-z0-9_]{2,}/g) || [];
    for (var i = 0; i < lat.length; i++) out.push(lat[i]);
    var segs = t.replace(/[^\u4e00-\u9fa5]+/g, ' ').split(/\s+/);
    for (var j = 0; j < segs.length; j++) {
      var w = segs[j];
      for (var k = 0; k < w.length - 1; k++) out.push(w.slice(k, k + 2));
      if (w.length === 1) out.push(w);
    }
    return out;
  }

  function bm25(docs, query, k1, b) {
    k1 = k1 || 1.4; b = b || 0.75;
    var N = docs.length; if (!N) return [];
    var toks = docs.map(function (d) { return tok(d.text); });
    var avg = toks.reduce(function (a, t) { return a + t.length; }, 0) / N || 1;
    var df = {}; toks.forEach(function (t) { t.forEach(function (x) { df[x] = (df[x] || 0) + 1; }); });
    var qset = {}; tok(query).forEach(function (x) { qset[x] = 1; });
    return docs.map(function (d, i) {
      var tf = {}; toks[i].forEach(function (x) { tf[x] = (tf[x] || 0) + 1; });
      var s = 0;
      for (var term in qset) {
        if (!tf[term]) continue;
        var idf = Math.log(1 + (N - df[term] + 0.5) / (df[term] + 0.5));
        s += idf * (tf[term] * (k1 + 1)) / (tf[term] + k1 * (1 - b + b * toks[i].length / avg));
      }
      return { doc: d, score: s };
    }).filter(function (x) { return x.score > 0; }).sort(function (a, b2) { return b2.score - a.score; });
  }

  // ---------- RRF（Hindsight search/fusion.py 的公式） ----------
  function rrf(arms, k) {
    k = k || 60;
    var score = {}, seen = {};
    arms.forEach(function (list) {
      (list || []).forEach(function (item, i) {
        var id = item.doc ? item.doc.id : item.id;
        if (!id) return;
        if (!seen[id]) { seen[id] = item.doc || item; score[id] = 0; }
        score[id] += 1 / (k + i + 1);
      });
    });
    return Object.keys(score).map(function (id) { return { doc: seen[id], score: score[id] }; })
      .sort(function (a, b) { return b.score - a.score; });
  }

  // ---------- 抽取 prompt（Hindsight 原文，不翻译） ----------
  var EXTRACT_SYSTEM = [
    'Extract SIGNIFICANT facts from text. Be SELECTIVE — only extract facts worth remembering long-term.',
    '',
    'LANGUAGE: Write every fact in the same language and script as the input text. Never translate. Names, identifiers, code, and quoted text stay verbatim.',
    '',
    'FACT FORMAT — BE CONCISE',
    '1. "what": core fact, 1-2 sentences max.',
    '2. "when": temporal info if mentioned, else "N/A".',
    '3. "where": location if relevant, else "N/A".',
    '4. "who": people involved with relationships, else "N/A".',
    '5. "why": context/significance only if important, else "N/A".',
    '',
    'COREFERENCE RESOLUTION: link generic references to names when both appear.',
    '  "my roommate" + "Emily" → "Emily (user\'s roommate)"',
    '',
    'CLASSIFICATION',
    'fact_kind: "event" (a specific datable occurrence) or "conversation" (ongoing state, preference, trait).',
    'fact_type: "world" (objective facts, other people\'s statements, constraints) or "assistant" (what THIS speaker itself did, learned, decided).',
    'entities: ALWAYS an array of plain strings, never objects, never null. Empty array [] only if nothing is named.',
    'search_terms: 3-6 short terms a future RETRIEVAL query might use for this fact — synonyms, hypernyms, domain words.',
    '  Facts are worded narrowly ("owes 300 shi of grain"); later questions say "supplies" or "logistics".',
    '  Put those likely query words here so a lexical index can still find it. Same language, never translate.',
    '',
    'OUTPUT: a JSON array only, no prose, no code fences. Each element:',
    '{"what":"…","when":"…","where":"…","who":"…","why":"…","fact_kind":"event|conversation","fact_type":"world|assistant","entities":["…"],"search_terms":["…"]}',
    'If nothing is worth remembering, output [].'
  ].join('\n');

  function parseJSONArray(s) {
    var t = String(s || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    var i = t.indexOf('['), j = t.lastIndexOf(']');
    if (i >= 0 && j > i) t = t.slice(i, j + 1);
    try { var a = JSON.parse(t); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }

  // ---------- 抽取（1 次模型调用） ----------
  async function extract(text, opts) {
    opts = opts || {};
    try {
      var out = await global.__app.oneShot({ system: EXTRACT_SYSTEM, user: String(text || ''), timeoutMs: opts.timeoutMs || 45000 });
      return parseJSONArray(out).slice(0, 8).filter(function (f) { return f && f.what; });
    } catch (e) { return []; }
  }

  // ---------- 向量腿（可选，默认关） ----------
  // 为什么默认关：要下 ~24MB 模型（bge-small-zh 量化版）+ onnxruntime wasm。
  // 主站是零构建零依赖的，任何要下载模型的东西都必须是"用户主动开、失败静默降级"。
  // 开了之后：写入时算向量存进条目，召回时作为第三路 arm 并进 RRF。
  var LS_VEC = 'cfw_mem_vec_v1';
  var _pipe = null, _pipeLoading = null, _vecFailed = false;

  // 2026-11-09：改为**默认常驻**（模型随仓库发布，43MB，不再需要用户手动开）。
  // 显式设 '0' 才关（省电/省内存时可关）。
  function vectorsWanted() { try { return localStorage.getItem(LS_VEC) !== '0'; } catch (e) { return true; } }
  function vectorsReady() { return !!_pipe; }
  function vectorState() { return { wanted: vectorsWanted(), ready: !!_pipe, loading: !!_pipeLoading, failed: _vecFailed }; }

  async function loadVectors() {
    if (_pipe) return _pipe;
    if (_pipeLoading) return _pipeLoading;
    if (_vecFailed) return null;
    _pipeLoading = (async function () {
      try {
        // 本网络 jsdelivr / huggingface.co 都不可达（实测 000），esm.sh 可达 —— JS 从 esm.sh 取，
        // 模型与 onnxruntime 的 wasm **全部本地化**，由本机执行服务 8801 的 /static 通道供（零外网依赖）。
        // 全部本地化：transformers.js 用自带的 webpack 包（897KB，已内置 onnxruntime-web），
        // 模型与 wasm 都在 8801 的 /static/local-models/ 下 —— 不碰任何外网 CDN，
        // 也就绕过了 esm.sh 注入 process 导致误判 Node 的问题。
        var mod = await import(new URL('/models/tf/transformers.min.js', location.origin).href);
        var env = mod.env;
        env.allowRemoteModels = true;
        // 站内相对路径：模型随仓库发布（public/models/），本地 dev 与线上都直接可用。
        // 换语言只换这一个目录：中文 bge-small-zh-v1.5；英文 bge-small-en-v1.5；
        // 多语种用 bge-m3（大得多，量化后约 500MB）。
        env.remoteHost = (location && location.origin ? location.origin : '') + '/models';
        env.remotePathTemplate = '{model}/';        // 本地是扁平目录：local-models/<模型名>/
        env.useBrowserCache = true;
        env.allowLocalModels = false;
        try {
          env.backends.onnx.wasm.wasmPaths = (location && location.origin ? location.origin : '') + '/models/tf/';
        } catch (e) {}
        _pipe = await mod.pipeline('feature-extraction', 'Xenova/bge-small-zh-v1.5', { quantized: true });
        return _pipe;
      } catch (e) {
        _vecFailed = true; _pipe = null;
        try { console.warn('[memory] 向量腿加载失败，已退回词法：', e && e.message); } catch (_) {}
        return null;
      } finally { _pipeLoading = null; }
    })();
    return _pipeLoading;
  }

  async function embed(text) {
    var p = await loadVectors();
    if (!p) return null;
    try {
      var out = await p(String(text || '').slice(0, 512), { pooling: 'mean', normalize: true });
      return Array.prototype.slice.call(out.data);
    } catch (e) { return null; }
  }

  function cosine(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    var d = 0; for (var i = 0; i < a.length; i++) d += a[i] * b[i];
    return d; // 已 normalize
  }

  // ---------- 写入（0 次模型调用） ----------
  async function putFacts(cid, facts, opts) {
    opts = opts || {};
    var c = String(cid || '');
    if (!c || !Array.isArray(facts) || !facts.length) return 0;
    var now = Date.now();
    var rows = facts.map(function (f, i) {
      return {
        id: c + ':' + now + ':' + i + ':' + Math.random().toString(36).slice(2, 6),
        cid: c,
        what: String(f.what || '').slice(0, 400),
        when: String(f.when || 'N/A').slice(0, 80),
        where: String(f.where || 'N/A').slice(0, 80),
        who: String(f.who || 'N/A').slice(0, 160),
        why: String(f.why || 'N/A').slice(0, 300),
        entities: Array.isArray(f.entities) ? f.entities.slice(0, 12).map(String) : [],
        terms: Array.isArray(f.search_terms) ? f.search_terms.slice(0, 6).map(String) : [],
        fact_kind: f.fact_kind === 'event' ? 'event' : 'conversation',
        fact_type: f.fact_type === 'assistant' ? 'assistant' : 'world',
        kind: String(opts.kind || 'observed'),
        scene: String(opts.scene || ''),
        ts: now,
        // 写时扩写：把 search_terms 并进被索引的文本，让"问法不同"也能命中
        text: String(f.what || '') + (Array.isArray(f.search_terms) && f.search_terms.length ? ' ' + f.search_terms.slice(0, 6).join(' ') : ''),
      };
    }).filter(function (r) { return r.what; });
    if (vectorsWanted() && !vectorsReady() && !_pipeLoading && !_vecFailed) loadVectors();
    if (vectorsReady()) {
      for (var vi = 0; vi < rows.length; vi++) {
        var v = await embed(rows[vi].text);
        if (v) rows[vi].vec = v;
      }
    }
    await tx('readwrite', function (st) { rows.forEach(function (r) { st.put(r); }); return null; });
    return rows.length;
  }

  // ---------- 记住一句话：抽取一次，分发给所有该记住的人 ----------
  // speakerCid：说话人自己（标记"我说"）；listenerCids：听到的人（标记"我听到"）。
  async function remember(text, opts) {
    opts = opts || {};
    var raw = String(text || '').trim();
    if (!raw || !enabled()) return { ok: false, skipped: true };
    var facts = await extract(raw, opts);
    if (!facts.length) return { ok: true, stored: 0 };
    var out = { ok: true, stored: 0, banks: [] };
    var sp = opts.speakerCid ? String(opts.speakerCid) : '';
    var ls = Array.isArray(opts.listenerCids) ? opts.listenerCids.map(String) : [];
    if (sp) { out.stored += await putFacts(sp, facts, { kind: opts.kind || 'said', scene: opts.scene }); out.banks.push(sp); }
    for (var i = 0; i < ls.length; i++) {
      if (ls[i] === sp) continue;
      out.stored += await putFacts(ls[i], facts, { kind: 'heard', scene: opts.scene });
      out.banks.push(ls[i]);
    }
    if (!sp && !ls.length && opts.cid) { out.stored += await putFacts(opts.cid, facts, { kind: opts.kind || 'observed' }); out.banks.push(opts.cid); }
    return out;
  }

  // ---------- 读取 ----------
  async function allOf(cid) {
    var rows = await tx('readonly', function (st) { return { __req: st.index('cid').getAll(String(cid)) }; });
    return (rows || []).sort(function (a, b) { return b.ts - a.ts; });
  }

  // ---------- 查询改写（只在首轮空召回时用） ----------
  // LightRAG 的 query_analyzer 干的就是这件事：把"粮草的事"拆成能命中存储的词。
  // 我们只在**首轮零命中**时才花这一次调用 —— 正常问法不产生额外成本。
  var EXPAND_SYSTEM = [
    'Extract search keywords from the query so a lexical index can find the relevant stored facts.',
    'Output a JSON array of 3-8 short terms: entities, synonyms, and domain words likely to appear in a stored fact.',
    'Same language as the query. Never translate. No prose, no code fences.'
  ].join(String.fromCharCode(10));
  async function expandQuery(q) {
    try {
      var out = await global.__app.oneShot({ system: EXPAND_SYSTEM, user: String(q || ''), timeoutMs: 20000 });
      var t = String(out || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
      var i = t.indexOf('['), j = t.lastIndexOf(']');
      if (i >= 0 && j > i) t = t.slice(i, j + 1);
      var a = JSON.parse(t);
      return Array.isArray(a) ? a.map(String).filter(Boolean).slice(0, 8) : [];
    } catch (e) { return []; }
  }

  // recall：BM25 一路 + 实体一跳 一路 → RRF 融合
  async function recall(cid, query, opts) {
    opts = opts || {};
    var k = opts.k || 5;
    // 开了向量腿但还没加载 → 后台预热（本次仍走词法+实体，不阻塞）
    if (vectorsWanted() && !vectorsReady() && !_pipeLoading && !_vecFailed) loadVectors();
    var rows = await allOf(cid);
    if (!rows.length) return { ok: true, hits: [], total: 0, arms: { lex: 0, ent: 0 } };

    var lex = bm25(rows, String(query || ''), 1.4, 0.75).slice(0, k * 3);

    // 实体扩展（查询侧零模型，纯字面）：
    //   ① 查询串里出现的已知实体名
    //   ② 词法命中条目里带的实体
    var known = {};
    rows.forEach(function (r) { (r.entities || []).forEach(function (e) { if (e) known[e] = 1; }); });
    var q = String(query || '');
    var want = {};
    Object.keys(known).forEach(function (e) { if (e.length >= 2 && q.indexOf(e) >= 0) want[e] = 1; });
    lex.forEach(function (x) { (x.doc.entities || []).forEach(function (e) { if (e) want[e] = 1; }); });
    var wantKeys = Object.keys(want);
    var entArm = [];
    if (wantKeys.length) {
      var seen = {};
      rows.forEach(function (r) {
        if (seen[r.id]) return;
        if ((r.entities || []).some(function (e) { return want[e]; })) { seen[r.id] = 1; entArm.push({ doc: r, score: 1 }); }
      });
    }

    // 首轮零命中：做一次查询改写，用同义词/领域词再检索一遍（只花这一次模型调用）
    var expanded = null;
    if (!lex.length && !entArm.length && opts.expand !== false) {
      var terms = await expandQuery(query);
      if (terms.length) {
        expanded = terms;
        var lex2 = bm25(rows, terms.join(' '), 1.4, 0.75).slice(0, k * 3);
        var want2 = {};
        terms.forEach(function (t) { Object.keys(known).forEach(function (e) { if (e && (t.indexOf(e) >= 0 || e.indexOf(t) >= 0)) want2[e] = 1; }); });
        var ent2 = [];
        if (Object.keys(want2).length) {
          rows.forEach(function (r) { if ((r.entities || []).some(function (e) { return want2[e]; })) ent2.push({ doc: r, score: 1 }); });
        }
        lex = lex2; entArm = ent2;
        Object.keys(want2).forEach(function (e) { want[e] = 1; });
        wantKeys = Object.keys(want);
      }
    }

    // 向量臂（只在开启 + 模型就绪时才算；否则整路缺席，RRF 自然退化）
    var vecArm = [];
    if (vectorsReady() && opts.vector !== false) {
      var qv = await embed(String(query || ''));
      if (qv) {
        vecArm = rows.filter(function (r) { return Array.isArray(r.vec) && r.vec.length; })
          .map(function (r) { return { doc: r, score: cosine(qv, r.vec) }; })
          .filter(function (x) { return x.score > 0.30; })
          .sort(function (a, b) { return b.score - a.score; })
          .slice(0, k * 3);
      }
    }

    var fused = rrf([lex, entArm, vecArm], 60).slice(0, k);
    return {
      ok: true, total: rows.length,
      arms: { lex: lex.length, ent: entArm.length, vec: vecArm.length, entities: wantKeys.slice(0, 8), expanded: expanded },
      hits: fused.map(function (x) {
        var d = x.doc;
        return { id: d.id, what: d.what, when: d.when, who: d.who, type: d.fact_type, kind: d.kind, entities: d.entities, score: +x.score.toFixed(4), ts: d.ts };
      })
    };
  }

  // 发言前装配
  async function buildInjection(cid, query, opts) {
    try {
      var r = await recall(cid, query, opts || { k: 4 });
      if (!r.ok || !r.hits.length) return '';
      var lines = r.hits.map(function (h) {
        // 2026-11-09：加"未必为真"——角色会把自己上一轮编的话当事实继续用（实测游隼编的
        // "栈台下货"被记忆固化，之后越说越真）。说过 ≠ 已证实，这里必须写明。
        var tag = h.kind === 'said' ? '（我说过·未必为真）' : h.kind === 'whisper' ? '（私下被告知）' : h.kind === 'heard' ? '（我听说的）' : '（我看到的）';
        return '- ' + tag + h.what;
      });
      return '\n\n【你的记忆】\n' + lines.join('\n') + '\n（这些是你自己记得的事，未必与当前局面一致；不要整段复述。）';
    } catch (e) { return ''; }
  }

  // ---------- 巩固（L1 → L2） ----------
  async function reflect(cid, question) {
    var rows = await allOf(cid);
    if (!rows.length) return { ok: false, error: '这个角色还没有记忆' };
    var digest = rows.slice(0, 40).map(function (r, i) { return (i + 1) + '. ' + r.what; }).join('\n');
    var sys = 'You compress a character\'s episodic memories into durable conclusions.\n' +
      'Write in the same language as the memories. Be concrete, keep names and numbers.\n' +
      'Output 3-6 short bullet lines, no preamble. Each bullet must be a claim the character would still hold later.';
    var out = '';
    try { out = await global.__app.oneShot({ system: sys, user: 'Question/direction: ' + String(question || '这一段的经过与结论') + '\n\nMemories:\n' + digest, timeoutMs: 60000 }); }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    var text = String(out || '').trim();
    if (!text) return { ok: false, error: '巩固没有产出' };
    await putFacts(cid, [{ what: text, why: 'consolidated', fact_type: 'assistant', fact_kind: 'conversation', entities: [] }], { kind: 'conclusion' });
    return { ok: true, conclusion: text };
  }

  async function count(cid) { return (await allOf(cid)).length; }
  async function clear(cid) {
    var rows = await allOf(cid);
    await tx('readwrite', function (st) { rows.forEach(function (r) { st.delete(r.id); }); return null; });
    return { ok: true, removed: rows.length };
  }

  global.__memCore = {
    v: 2,
    prompt: EXTRACT_SYSTEM,
    enabled: enabled,
    enableVectors: function (on) { try { localStorage.setItem(LS_VEC, on ? '1' : '0'); } catch (e) {}
      if (on) loadVectors(); return vectorState(); },
    vectorState: vectorState, loadVectors: loadVectors,
    extract: extract, putFacts: putFacts, remember: remember,
    recall: recall, buildInjection: buildInjection, reflect: reflect,
    count: count, clear: clear, list: allOf,
    _tok: tok, _bm25: bm25, _rrf: rrf,
  };
})(typeof window !== 'undefined' ? window : globalThis);
