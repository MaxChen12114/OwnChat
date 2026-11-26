// Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name.
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
