// public/js/text/data/char-memory.js — 角色记忆模块（2026-10-08）
// ─────────────────────────────────────────────────────────────
// 两块「角色私有、全本地」的能力：
//   ① 小本子（KV）：角色专属键值库（IndexedDB），工具 char_db_get / char_db_set / char_db_list / char_db_delete
//      —— 角色记事实、进度、清单（只在它自己的命名空间里，别的角色看不到）。
//   ② 知识库（KB）：角色专属文档库（IndexedDB + trigram 倒排 + BM25 关键词检索），
//      命中注入（app.js 按发言者取 top-K 拼进 extraSystemPrompts）+ 工具 kb_search / kb_read 按需深挖。
//
// 设计口径（对应计划，抄自 DSH 生态的词法腿）：
//   · 全本地 IndexedDB：知识库"不一定小"，localStorage 有 2MB 上限不能碰；也不进云同步。
//   · 一条 key 一条记录（postings）：查询只按 key 取用到的几十条 → 内存占用小、不怕库大。
//   · 中文要能命中子串：DSH 实测默认分词器（unicode61）匹配不了中文子串，换成**字符 trigram**
//     （拉丁/数字走小写词元），配 BM25 排序。
//   · 词法腿可分离：将来加向量腿 + RRF 融合不用动数据布局（dsh-knowledge 的混合设计）。
//   · 写入只由用户操作（DSH 的 ask-gated 姿态）：v1 不给 agent 写知识库的权限（只给读工具）。
//   · 分片 ~500 字带重叠；单条注入条数/字数有上限（见 INJECT_*）。
//
// 挂载：window.__charMemory = { defineTools, importText, listDocs, removeDoc, search, getDocText, buildInjection, ui }
(function () {
  "use strict";

  const DB = "cfw_char_memory_v1";
  const ST_KV = "kv", ST_DOCS = "docs", ST_CHUNKS = "chunks", ST_POSTINGS = "postings", ST_META = "meta";
  const CHUNK_SIZE = 500, CHUNK_OVERLAP = 60;
  const INJECT_MAX_CHUNKS = 3, INJECT_MAX_CHARS = 1200;

  let _dbPromise = null; // 2026-11-08 修(审查 P2): 缓存连接 Promise —— 旧版每次操作都新开连接且从不 close
  function open() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      try {
        const q = indexedDB.open(DB, 1);
        q.onupgradeneeded = () => {
          const d = q.result;
          if (!d.objectStoreNames.contains(ST_KV)) d.createObjectStore(ST_KV, { keyPath: "k" });
          if (!d.objectStoreNames.contains(ST_DOCS)) d.createObjectStore(ST_DOCS, { keyPath: "id" });
          if (!d.objectStoreNames.contains(ST_CHUNKS)) d.createObjectStore(ST_CHUNKS, { keyPath: "id" });
          if (!d.objectStoreNames.contains(ST_POSTINGS)) d.createObjectStore(ST_POSTINGS, { keyPath: "key" });
          if (!d.objectStoreNames.contains(ST_META)) d.createObjectStore(ST_META, { keyPath: "k" });
        };
        q.onsuccess = () => resolve(q.result);
        q.onerror = () => reject(q.error);
      } catch (e) { reject(e); }
    }).catch(function (e) { _dbPromise = null; throw e; }); // 失败允许下次重试
  }
  const reqP = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  // 读：单个请求的 promise（事务在请求完成前后自然收尾，不再依赖 oncomplete 的时序）
  function readReq(db, store, fn) {
    return new Promise((resolve, reject) => {
      let p;
      try { p = fn(db.transaction(store, "readonly").objectStore(store)); } catch (e) { reject(e); return; }
      reqP(p).then(resolve, reject);
    });
  }
  // 写：等事务真正提交（读写混合场景必须等提交，否则下一个事务可能看到旧值）
  function writeTx(db, stores, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(Array.isArray(stores) ? stores : [stores], "readwrite");
      try { fn(t); } catch (e) { reject(e); return; }
      t.oncomplete = () => resolve(true);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error("tx aborted"));
    });
  }
  const idbKey = (cardId, key) => String(cardId || "") + "::" + String(key || "");
  const newId = (p) => p + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const rangeDoc = (docId) => IDBKeyRange.bound(docId + "#", docId + "#\uffff");

  // ── 词元化：CJK 字符 trigram（两字词按整体存，短查询也能命中）+ 拉丁/数字小写词元 ──
  const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
  function tokenize(text) {
    const s = String(text || "");
    const tf = new Map();
    const bump = (k) => tf.set(k, (tf.get(k) || 0) + 1);
    const run = [];
    const flushRun = () => {
      if (run.length >= 3) { for (let i = 0; i + 3 <= run.length; i++) bump("3:" + run.slice(i, i + 3).join("")); }
      else if (run.length === 2) bump("3:" + run.join(""));
      run.length = 0;
    };
    let latin = "";
    const flushLatin = () => { if (latin.length >= 2) bump("w:" + latin); latin = ""; };
    for (const ch of s) {
      if (CJK.test(ch)) { flushLatin(); run.push(ch); continue; }
      flushRun();
      if (/[A-Za-z0-9_]/.test(ch)) { latin += ch.toLowerCase(); continue; }
      flushLatin();
    }
    flushRun(); flushLatin();
    return tf;
  }

  function chunkText(text) {
    const s = String(text || "");
    const out = [];
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

  async function listDocs(cardId) {
    const db = await open();
    const all = (await readReq(db, ST_DOCS, (s) => s.getAll())) || [];
    return all.filter((d) => d && d.cardId === String(cardId)).sort((a, b) => b.addedAt - a.addedAt);
  }

  // ── 导入（建索引）：文档 + 分片 + postings（一条 key 一条记录，读改写合并）──
  async function importText(cardId, title, text, src) {
    const clean = String(text || "").replace(/\r\n?/g, "\n").trim();
    if (!cardId) throw new Error("缺少 cardId");
    if (!clean) throw new Error("正文为空");
    const db = await open();
    const docId = newId("kb");
    const doc = { id: docId, cardId: String(cardId), title: String(title || "未命名").slice(0, 120), src: String(src || "paste").slice(0, 60), addedAt: Date.now(), chars: clean.length };
    const pieces = chunkText(clean);
    const chunks = pieces.map((piece, ord) => ({ id: docId + "#" + ord, docId, cardId: doc.cardId, ord, text: piece, len: piece.length }));
    await writeTx(db, [ST_DOCS, ST_CHUNKS], (t) => {
      t.objectStore(ST_DOCS).put(doc);
      const cs = t.objectStore(ST_CHUNKS);
      for (const c of chunks) cs.put(c);
    });
    // postings：先在内存聚合本文件各 key 的 tf，再按 key 读改写（避免同 key 反复往返）
    const byKey = new Map();
    for (const c of chunks) {
      for (const [k, n] of tokenize(c.text)) {
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push([c.id, n, c.len]);
      }
    }
    for (const [k, entries] of byKey) {
      await writeTx(db, ST_POSTINGS, (t) => {
        const os = t.objectStore(ST_POSTINGS);
        const r = os.get(k);
        r.onsuccess = () => {
          const cur = (r.result && Array.isArray(r.result.entries)) ? r.result.entries : [];
          os.put({ key: k, entries: cur.concat(entries) });
        };
      });
    }
    await writeTx(db, ST_META, (t) => {
      const m = t.objectStore(ST_META);
      const r = m.get("stats");
      r.onsuccess = () => {
        const st = (r.result && r.result.v) ? r.result.v : { nChunks: 0, totalLen: 0 };
        st.nChunks += chunks.length;
        for (const c of chunks) st.totalLen += (c.len || 0);
        m.put({ k: "stats", v: st });
      };
    });
    try { if (window.__charMemoryUiRefresh) window.__charMemoryUiRefresh(); } catch (e) {}
    return { ok: true, docId, chunks: chunks.length, chars: doc.chars };
  }

  // ── 检索：trigram/词元 → postings → BM25-lite 排序（只在该角色的文档里排）──
  async function search(cardId, query, topK) {
    const q = String(query || "").trim();
    const cid = String(cardId || "");
    if (!q || !cid) return [];
    const db = await open();
    const docs = await listDocs(cid);
    if (!docs.length) return [];
    const allowed = new Set(docs.map((d) => d.id));
    const statsRec = await readReq(db, ST_META, (s) => s.get("stats"));
    const stats = (statsRec && statsRec.v) ? statsRec.v : { nChunks: 0, totalLen: 0 };
    const avgLen = Math.max(1, stats.totalLen / Math.max(1, stats.nChunks || 1));
    const qtf = tokenize(q);
    if (!qtf.size) return [];
    const scores = new Map();
    let used = 0;
    for (const [key, qn] of qtf) {
      if (used++ >= 24) break; // 单次查询最多取 24 个倒排键（够用且省往返）
      const pr = await readReq(db, ST_POSTINGS, (s) => s.get(key));
      if (!pr || !Array.isArray(pr.entries)) continue;
      const mine = pr.entries.filter((e) => e && allowed.has(String(e[0] || "").split("#")[0]));
      if (!mine.length) continue;
      const df = Math.max(1, mine.length);
      const idf = Math.log(1 + ((stats.nChunks || 1) - df + 0.5) / (df + 0.5));
      for (const e of mine) {
        const chunkId = e[0], tf = e[1] || 1, len = e[2] || avgLen;
        // BM25-lite：k1=1.2, b=0.75 + 查询侧词频小幅加权（同一词重复问 = 更相关）
        const denom = tf + 1.2 * (0.25 + 0.75 * (len / avgLen));
        const score = idf * ((tf * 2.2) / denom) * Math.min(3, qn);
        scores.set(chunkId, (scores.get(chunkId) || 0) + score);
      }
    }
    if (!scores.size) return [];
    const top = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, Math.max(1, Math.min(10, topK || 5)));
    const byDoc = new Map(docs.map((d) => [d.id, d]));
    const hits = [];
    for (const [chunkId, score] of top) {
      const c = await readReq(db, ST_CHUNKS, (s) => s.get(chunkId));
      if (!c) continue; // 惰性墓碑：分片已删（文档删除）→ 自然跳过
      const d = byDoc.get(c.docId);
      if (!d) continue;
      hits.push({ title: d.title, docId: c.docId, chunkId: c.id, chunkOrd: c.ord, score: Math.round(score * 100) / 100, text: c.text });
    }
    return hits;
  }

  async function getDocText(docId) {
    const db = await open();
    const d = await readReq(db, ST_DOCS, (s) => s.get(String(docId || "")));
    if (!d) return null;
    let chunks = [];
    try { chunks = (await readReq(db, ST_CHUNKS, (s) => s.getAll(rangeDoc(d.id)))) || []; } catch (e) {}
    chunks.sort((a, b) => a.ord - b.ord);
    return { doc: d, text: chunks.map((c) => c.text).join("") };
  }

  async function removeDoc(docId) {
    const db = await open();
    const chunks = (await readReq(db, ST_CHUNKS, (s) => s.getAll(rangeDoc(String(docId))))) || [];
    await writeTx(db, [ST_DOCS, ST_CHUNKS], (t) => {
      t.objectStore(ST_DOCS).delete(String(docId));
      const cs = t.objectStore(ST_CHUNKS);
      for (const c of chunks) cs.delete(c.id);
    });
    await writeTx(db, ST_META, (t) => {
      const m = t.objectStore(ST_META);
      const r = m.get("stats");
      r.onsuccess = () => {
        const st = (r.result && r.result.v) ? r.result.v : { nChunks: 0, totalLen: 0 };
        st.nChunks = Math.max(0, st.nChunks - chunks.length);
        for (const c of chunks) st.totalLen = Math.max(0, st.totalLen - (c.len || 0));
        m.put({ k: "stats", v: st });
      };
    });
    // postings 用"惰性墓碑"：条目留着，检索时按分片是否还在自然失效（见 search 的 c 判空）。
    // 这里只清本次涉及文档的键，避免库无限增长（找不到就不管，不是错误）。
    const keys = new Set();
    for (const c of chunks) for (const k of tokenize(c.text).keys()) keys.add(k);
    for (const k of keys) {
      await writeTx(db, ST_POSTINGS, (t) => {
        const os = t.objectStore(ST_POSTINGS);
        const r = os.get(k);
        r.onsuccess = () => {
          const cur = (r.result && Array.isArray(r.result.entries)) ? r.result.entries.filter((e) => String(e[0]).indexOf(String(docId) + "#") !== 0) : [];
          if (cur.length) os.put({ key: k, entries: cur }); else os.delete(k);
        };
      });
    }
    try { if (window.__charMemoryUiRefresh) window.__charMemoryUiRefresh(); } catch (e) {}
    return { ok: true, removedChunks: chunks.length };
  }

  // ── 命中注入：给某个角色的请求拼一段「知识库命中」（app.js 在发请求前 await 它）──
  async function buildInjection(card, queryText) {
    const id = (typeof card === "string") ? card : (card && card.id);
    if (!id) return "";
    const q = String(queryText || "").trim();
    if (q.length < 2) return "";
    let hits = [];
    try { hits = await search(id, q, INJECT_MAX_CHUNKS); } catch (e) { return ""; }
    if (!hits.length) return "";
    let used = 0;
    const parts = [];
    for (const h of hits) {
      const piece = "〔" + h.title + "·第" + (h.chunkOrd + 1) + "段〕" + h.text;
      if (used + piece.length > INJECT_MAX_CHARS) break;
      used += piece.length;
      parts.push(piece);
    }
    if (!parts.length) return "";
    const who = (typeof card === "object" && card && card.name) ? card.name : "本角色";
    return "\n\n【知识库命中·" + who + "】以下是你（该角色）知识库里与本轮话题最相关的段落，可直接引用；"
      + "需要更多时用 kb_search 检索、kb_read 读全文（不要编造未命中的内容）：\n" + parts.join("\n---\n");
  }

  // ── 工具（注册给 agent）：小本子读写作用于"当前发言的角色"；知识库只读 ──
  function defineTools(registry) {
    if (!registry || typeof registry.define !== "function") return;
    const cardIdOf = (ctx) => {
      const c = ctx && ctx.characterCard;
      if (c && c.id) return c.id;
      try { const a = window.__character && window.__character.getActiveCard && window.__character.getActiveCard(); return (a && a.id) ? a.id : ""; } catch (e) { return ""; }
    };
    registry.define({
      name: "char_db_set",
      description: "把你（当前角色）的『小本子』里某个键写下来 —— 角色专属的本地键值库，用来记事实/进度/清单（别的角色看不到）。",
      parameters: { type: "object", properties: { key: { type: "string", description: "键名，如「项目进度」「用户偏好」" }, value: { type: "string", description: "内容（字符串；结构化数据请自己 JSON.stringify）" } }, required: ["key", "value"] },
      async run(args, ctx) {
        const cid = cardIdOf(ctx);
        if (!cid) return { ok: false, error: "没有当前角色（先挂一张角色卡）" };
        const key = String((args && args.key) || "").trim();
        if (!key) return { ok: false, error: "缺少 key" };
        const val = String((args && args.value) == null ? "" : args.value);
        const db = await open();
        await writeTx(db, ST_KV, (t) => { t.objectStore(ST_KV).put({ k: idbKey(cid, key), cardId: cid, key, value: val, at: Date.now() }); });
        return { ok: true, key, chars: val.length, note: "已记在你的小本子上（本地 IndexedDB，不进云）" };
      },
    });
    registry.define({
      name: "char_db_get",
      description: "读你（当前角色）的『小本子』：传 key 取单条；不传则列出全部键名与长度。",
      parameters: { type: "object", properties: { key: { type: "string", description: "键名；省略 = 列出全部键" } } },
      async run(args, ctx) {
        const cid = cardIdOf(ctx);
        if (!cid) return { ok: false, error: "没有当前角色" };
        const db = await open();
        if (args && args.key) {
          const rec = await readReq(db, ST_KV, (s) => s.get(idbKey(cid, args.key)));
          if (!rec) return { ok: false, error: "没有这个键：" + String(args.key) };
          return { ok: true, key: rec.key, value: rec.value, at: rec.at };
        }
        const all = (await readReq(db, ST_KV, (s) => s.getAll(IDBKeyRange.bound(cid + "::", cid + "::\uffff")))) || [];
        return { ok: true, keys: all.map((r) => ({ key: r.key, chars: String(r.value || "").length, at: r.at })) };
      },
    });
    registry.define({
      name: "char_db_delete",
      destructive: true,
      description: "删掉你（当前角色）小本子里的某个键。",
      parameters: { type: "object", properties: { key: { type: "string", description: "键名" } }, required: ["key"] },
      async run(args, ctx) {
        const cid = cardIdOf(ctx);
        if (!cid) return { ok: false, error: "没有当前角色" };
        const key = String((args && args.key) || "").trim();
        const db = await open();
        await writeTx(db, ST_KV, (t) => { t.objectStore(ST_KV).delete(idbKey(cid, key)); });
        return { ok: true, deleted: key };
      },
    });
    registry.define({
      name: "kb_search",
      description: "检索你（当前角色）的知识库（本地文档库，关键词/中文子串可命中）。回答用户前若涉及你知识库里可能有的资料，先搜一下再答；不要编造。",
      parameters: { type: "object", properties: { query: { type: "string", description: "检索词（自然语言问题或关键词都行）" }, top: { type: "number", description: "返回条数，默认 5" } }, required: ["query"] },
      async run(args, ctx) {
        const cid = cardIdOf(ctx);
        if (!cid) return { ok: false, error: "没有当前角色" };
        const hits = await search(cid, args && args.query, args && args.top);
        if (!hits.length) return { ok: true, hits: [], note: "知识库里没有命中（不是失败：库里可能确实没有这份资料）" };
        return { ok: true, hits: hits.map((h) => ({ doc: h.title, docId: h.docId, seg: h.chunkOrd + 1, score: h.score, text: String(h.text || "").slice(0, 1200) })), note: "要全文用 kb_read（传 docId）" };
      },
    });
    registry.define({
      name: "kb_read",
      description: "按文档 id 读你（当前角色）知识库里某篇文档的全文（id 见 kb_search 结果里的 docId）。",
      parameters: { type: "object", properties: { doc_id: { type: "string", description: "文档 id" } }, required: ["doc_id"] },
      async run(args, ctx) {
        const cid = cardIdOf(ctx);
        if (!cid) return { ok: false, error: "没有当前角色" };
        const got = await getDocText(String((args && args.doc_id) || ""));
        if (!got) return { ok: false, error: "找不到该文档" };
        if (got.doc.cardId !== cid) return { ok: false, error: "该文档不属于当前角色" };
        return { ok: true, doc: got.doc.title, chars: got.text.length, text: got.text };
      },
    });
  }

  // ── 删卡级联：清掉该角色的全部记忆（知识库文档/分片/倒排条目 + 小本子键），不留孤儿数据。
  //    由 character.js 的 cascadeCleanupCard 调用（与能力档清理同一处）。──
  async function removeCard(cardId) {
    const cid = String(cardId || "");
    if (!cid) return { ok: false, error: "缺少 cardId" };
    let docs = [];
    try { docs = await listDocs(cid); } catch (e) {}
    for (const d of docs) { try { await removeDoc(d.id); } catch (e) {} }
    const db = await open();
    const kv = (await readReq(db, ST_KV, (s) => s.getAll(IDBKeyRange.bound(cid + "::", cid + "::\uffff")))) || [];
    await writeTx(db, ST_KV, (t) => { const os = t.objectStore(ST_KV); for (const r of kv) os.delete(r.k); });
    return { ok: true, docs: docs.length, kvKeys: kv.length };
  }

  // ── v1 最简导入 UI（文件选择导入到当前角色）。正式的「编辑器·角色页能力区」留待后续批次 ──
  function ui() {
    const card = (window.__character && window.__character.getActiveCard && window.__character.getActiveCard()) || null;
    if (!card || !card.id) { alert("先挂一张角色卡（左栏角色面板）—— 知识库是「每个角色一套」的。"); return; }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".txt,.md,.json,.csv,.log,text/*";
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener("change", () => {
      const f = input.files && input.files[0];
      if (!f) { input.remove(); return; }
      const fr = new FileReader();
      fr.onload = async () => {
        try {
          const r = await importText(card.id, f.name, String(fr.result || ""), "file");
          alert("已导入《" + f.name + "》到「" + card.name + "」的知识库：分 " + r.chunks + " 段，共 " + r.chars + " 字。\n发消息时会按话题自动命中注入；agent 也能用 kb_search / kb_read 深挖。");
        } catch (e) { alert("导入失败：" + String((e && e.message) || e)); }
      };
      fr.readAsText(f);
      input.remove();
    });
    input.click();
  }

  window.__charMemory = { defineTools, importText, listDocs, removeDoc, removeCard, search, getDocText, buildInjection, ui, _db: DB };
})();
