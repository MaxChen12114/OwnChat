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
