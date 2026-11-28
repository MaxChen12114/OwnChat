// ── Browser wiring (injected by tooling/l0/emit.mjs): binds the service to the frozen window contract name ──
// Agent file workspace: the data layer lives in services/data/agent-workspace.ts, so this file owns
// only the storage adapters and the browser-side pieces — the unified SQLite trio reached through
// window.dbSvc (`workspace` for current files, `workspace_versions` for history, `workspace_blobs`
// for content-addressed snapshot texts), the one-time import of the legacy IndexedDB database, the
// content hash for dedupe, the lazy bridge to text-search, the two "export to real disk" channels,
// and registering the file tools into the registry.
//
// Why IndexedDB still exists below: it is the fallback for a page whose DbPort or 0003 tables are
// missing (an older desktop binary, a deployment that has not applied the migration, the vm tests)
// and the only way to read the pre-SQL data once. It is never the primary store once the tables
// answer, and the legacy rows it holds are imported on the first run that can reach them.
//
// Export reports failure as failure on purpose: the old version called a cancelled save ok:true, so
// the model announced a file that had landed nowhere.
(function () {
  var IDB_NAME = "cfw_agent_workspace_v1";
  var IDB_STORE = "files";
  var IDB_VERSIONS = "versions";
  var IDB_BLOBS = "blobs";
  var IDB_VERSION = 2;
  // Namespace of the one-time import marker in `storage_marks` (shared table; one row per domain).
  var IMPORT_MARK = "workspace_idb_v1";
  // 0003 tables. `workspace` is 0002's; the other three arrive with 0003, and all four are probed
  // together because a half-applied schema is exactly what must fall back, not fail mid-write.
  var SQL_TABLES = ["workspace", "workspace_versions", "workspace_blobs", "storage_marks"];
  // The /api/data/tx route caps a batch at 200 statements and 4 MB of JSON; stay well below both so
  // a chunk of long file texts cannot turn a migration into a 413. (A single text larger than the
  // cap still goes alone: splitting a row is not possible without a second schema.)
  var WRITE_CHUNK = 100;
  var WRITE_BYTES = 1024 * 1024;
  var _db = null;
  var _idbCreated = false;

  function warn(message, error) {
    try { console.warn("[agent-workspace] " + message, error); } catch (e) {}
  }

  // ───────── legacy IndexedDB adapter (fallback + one-time import source) ─────────
  function idb() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (resolve) {
      try {
        var req = window.indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = function (ev) {
          // oldVersion 0 means this open created the database; an upgrade of an existing database
          // (oldVersion > 0) may hold real rows and must still be read/imported.
          _idbCreated = !ev || !ev.oldVersion;
          var d = req.result;
          if (!d.objectStoreNames.contains(IDB_STORE)) {
            var os = d.createObjectStore(IDB_STORE, { keyPath: "id" });
            try { os.createIndex("conv", "convId", { unique: false }); } catch (e) {}
          }
          if (!d.objectStoreNames.contains(IDB_VERSIONS)) {
            var vs = d.createObjectStore(IDB_VERSIONS, { keyPath: "id" });
            try { vs.createIndex("conv", "convId", { unique: false }); } catch (e) {}
            try { vs.createIndex("scope", "scopeKey", { unique: false }); } catch (e) {}
          }
          if (!d.objectStoreNames.contains(IDB_BLOBS)) {
            var bs = d.createObjectStore(IDB_BLOBS, { keyPath: "id" });
            try { bs.createIndex("conv", "convId", { unique: false }); } catch (e) {}
          }
        };
        req.onsuccess = function () { _db = req.result; resolve(_db); };
        req.onerror = function () { resolve(null); };
        req.onblocked = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
  }

  function tx(storeName, mode) {
    return idb().then(function (db) { return db ? db.transaction(storeName, mode).objectStore(storeName) : null; });
  }

  function reqP(r) {
    return new Promise(function (res) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { res(null); }; });
  }

  // An unopened workspace must not read as an empty table (the model would think every file is gone):
  // throw instead, and the service turns it into ok:false.
  function need(os) {
    if (!os) throw new Error("工作区不可用(存储未就绪)");
    return os;
  }

  function makeStore(storeName) {
    return {
      all: function () {
        return tx(storeName, "readonly").then(function (os) { return os ? reqP(os.getAll()) : []; }).then(function (arr) {
          return Array.isArray(arr) ? arr : [];
        });
      },
      get: function (id) {
        return tx(storeName, "readonly").then(function (os) { return os ? reqP(os.get(id)) : null; });
      },
      put: function (row) {
        return tx(storeName, "readwrite").then(function (os) { return reqP(need(os).put(row)); });
      },
      remove: function (id) {
        return tx(storeName, "readwrite").then(function (os) { return reqP(need(os).delete(id)); });
      },
      removeWhere: function (match) {
        return tx(storeName, "readwrite").then(function (os) {
          if (!os) return Promise.reject(new Error("工作区不可用(存储未就绪)"));
          return new Promise(function (res, rej) {
            var n = 0;
            var r = os.openCursor();
            r.onsuccess = function (e) {
              var c = e.target.result;
              if (!c) return res(n);
              if (match(c.value)) { n++; c.delete(); }
              c.continue();
            };
            r.onerror = function () { rej(new Error("工作区游标读取失败")); };
          });
        });
      },
      clear: function () {
        return tx(storeName, "readwrite").then(function (os) { return reqP(need(os).clear()); });
      },
    };
  }

  var idbFiles = makeStore(IDB_STORE);
  var idbVersions = makeStore(IDB_VERSIONS);
  var idbBlobs = makeStore(IDB_BLOBS);

  // ───────── SQLite stores (the primary path; rows keep the FileStore shapes) ─────────
  function wsPort() {
    try {
      var svc = window.dbSvc;
      if (svc && typeof svc.get === "function") return svc.get();
    } catch (e) {
      warn("DbPort 不可用，本次回退 IndexedDB", e);
    }
    return null;
  }

  function wsRows(result) {
    return result && Array.isArray(result.rows) ? result.rows : [];
  }

  function wsText(value) {
    return value == null ? "" : String(value);
  }

  function wsNum(value) {
    var n = Number(value);
    return isFinite(n) ? n : 0;
  }

  function hasTables(p) {
    return p.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?,?,?,?)", SQL_TABLES)
      .then(function (res) {
        var found = {};
        wsRows(res).forEach(function (row) { found[wsText(row && row.name)] = true; });
        for (var i = 0; i < SQL_TABLES.length; i++) if (!found[SQL_TABLES[i]]) return false;
        return true;
      });
  }

  // One writer at a time. The node sidecar and the Tauri shell share one SQLite connection, and two
  // overlapping BEGIN/COMMIT batches abort each other ("cannot start a transaction within a
  // transaction"). Our domain never needs concurrent writes (they would race on the same version
  // seq anyway), so a local queue is the whole fix; reads stay parallel.
  var _writeChain = Promise.resolve();
  function serialWrite(job) {
    var run = _writeChain.then(job);
    _writeChain = run.then(function () {}, function () {});
    return run;
  }

  /** At most WRITE_CHUNK statements and roughly WRITE_BYTES of param text per request. */
  function chunkOf(statements, at) {
    var batch = [];
    var bytes = 0;
    for (var i = at; i < statements.length && batch.length < WRITE_CHUNK; i++) {
      var params = statements[i].params || [];
      var size = 0;
      for (var j = 0; j < params.length; j++) {
        var value = params[j];
        size += typeof value === "string" ? value.length + 16 : 16;
      }
      if (batch.length && bytes + size > WRITE_BYTES) break;
      batch.push(statements[i]);
      bytes += size;
    }
    return batch;
  }

  function writeChunks(p, statements) {
    var at = 0;
    function step() {
      if (at >= statements.length) return Promise.resolve();
      var batch = chunkOf(statements, at);
      at += batch.length;
      return serialWrite(function () {
        return p.transaction(function (t) {
          for (var i = 0; i < batch.length; i++) t.exec(batch[i].sql, batch[i].params);
        });
      }).then(step);
    }
    return step();
  }

  function removeMatching(p, table, keyColumn, selectSql, mapRow, match) {
    return p.exec(selectSql).then(function (res) {
      var rows = wsRows(res).map(mapRow);
      var hits = [];
      for (var i = 0; i < rows.length; i++) if (match(rows[i])) hits.push(rows[i]);
      if (!hits.length) return 0;
      var statements = [];
      for (var j = 0; j < hits.length; j++) {
        statements.push({ sql: "DELETE FROM " + table + " WHERE " + keyColumn + " = ?", params: [hits[j].id] });
      }
      return writeChunks(p, statements).then(function () { return hits.length; });
    });
  }

  // `workspace.path` holds the composite storage key (the table's PK is path alone, so the
  // conversation has to live inside it); `cid` repeats the conversation for scoped reads, and the
  // real path is recovered by stripping the `<cid>::` prefix this code wrote.
  var FILES_SELECT = "SELECT path, cid, content, lines, ts FROM workspace";

  function mapFileRow(row) {
    var r = row || {};
    var key = wsText(r["path"]);
    var cid = wsText(r["cid"]);
    var content = wsText(r["content"]);
    var prefix = cid + "::";
    return {
      id: key,
      convId: cid,
      path: cid && key.indexOf(prefix) === 0 ? key.slice(prefix.length) : key,
      content: content,
      bytes: content.length,
      lines: wsNum(r["lines"]),
      ts: wsNum(r["ts"]),
    };
  }

  function makeSqlFiles(p) {
    return {
      all: function () {
        return p.exec(FILES_SELECT).then(function (res) { return wsRows(res).map(mapFileRow); });
      },
      get: function (id) {
        return p.exec(FILES_SELECT + " WHERE path = ?", [id]).then(function (res) {
          var rows = wsRows(res);
          return rows.length ? mapFileRow(rows[0]) : null;
        });
      },
      put: function (row) {
        var r = row || {};
        var key = wsText(r["id"]) || (wsText(r["convId"]) + "::" + wsText(r["path"]));
        var content = wsText(r["content"]);
        return serialWrite(function () {
          return p.exec(
            "INSERT OR REPLACE INTO workspace (path, cid, content, lines, ts) VALUES (?,?,?,?,?)",
            [key, wsText(r["convId"]), content, wsNum(r["lines"]), wsNum(r["ts"])]
          );
        }).then(function () {});
      },
      remove: function (id) {
        return serialWrite(function () { return p.exec("DELETE FROM workspace WHERE path = ?", [id]); })
          .then(function () {});
      },
      removeWhere: function (match) {
        return removeMatching(p, "workspace", "path", FILES_SELECT, mapFileRow, match);
      },
      clear: function () {
        return serialWrite(function () { return p.exec("DELETE FROM workspace"); }).then(function () {});
      },
    };
  }

  var VERSIONS_SELECT = "SELECT id, scope_key, conv_id, path, seq, ts, kind, hash, bytes, lines, prev_hash, from_version FROM workspace_versions";

  function mapVersionRow(row) {
    var r = row || {};
    return {
      id: wsText(r["id"]),
      scopeKey: wsText(r["scope_key"]),
      convId: wsText(r["conv_id"]),
      path: wsText(r["path"]),
      seq: wsNum(r["seq"]),
      ts: wsNum(r["ts"]),
      kind: wsText(r["kind"]),
      hash: r["hash"] == null ? null : wsText(r["hash"]),
      bytes: wsNum(r["bytes"]),
      lines: wsNum(r["lines"]),
      prevHash: r["prev_hash"] == null ? null : wsText(r["prev_hash"]),
      fromVersion: r["from_version"] == null ? undefined : wsNum(r["from_version"]),
    };
  }

  function makeSqlVersions(p) {
    return {
      all: function () {
        return p.exec(VERSIONS_SELECT).then(function (res) { return wsRows(res).map(mapVersionRow); });
      },
      get: function (id) {
        return p.exec(VERSIONS_SELECT + " WHERE id = ?", [id]).then(function (res) {
          var rows = wsRows(res);
          return rows.length ? mapVersionRow(rows[0]) : null;
        });
      },
      put: function (row) {
        var r = row || {};
        return serialWrite(function () { return p.exec(
          "INSERT OR REPLACE INTO workspace_versions (id, scope_key, conv_id, path, seq, ts, kind, hash, bytes, lines, prev_hash, from_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
          [
            wsText(r["id"]),
            wsText(r["scopeKey"]),
            wsText(r["convId"]),
            wsText(r["path"]),
            wsNum(r["seq"]),
            wsNum(r["ts"]),
            wsText(r["kind"]),
            r["hash"] == null ? null : wsText(r["hash"]),
            wsNum(r["bytes"]),
            wsNum(r["lines"]),
            r["prevHash"] == null ? null : wsText(r["prevHash"]),
            r["fromVersion"] == null ? null : wsNum(r["fromVersion"]),
          ]
        ); }).then(function () {});
      },
      remove: function (id) {
        return serialWrite(function () { return p.exec("DELETE FROM workspace_versions WHERE id = ?", [id]); })
          .then(function () {});
      },
      removeWhere: function (match) {
        return removeMatching(p, "workspace_versions", "id", VERSIONS_SELECT, mapVersionRow, match);
      },
      clear: function () {
        return serialWrite(function () { return p.exec("DELETE FROM workspace_versions"); }).then(function () {});
      },
    };
  }

  var BLOBS_SELECT = "SELECT id, conv_id, hash, content, bytes FROM workspace_blobs";

  function mapBlobRow(row) {
    var r = row || {};
    return {
      id: wsText(r["id"]),
      convId: wsText(r["conv_id"]),
      hash: wsText(r["hash"]),
      content: wsText(r["content"]),
      bytes: wsNum(r["bytes"]),
    };
  }

  function makeSqlBlobs(p) {
    return {
      all: function () {
        return p.exec(BLOBS_SELECT).then(function (res) { return wsRows(res).map(mapBlobRow); });
      },
      get: function (id) {
        return p.exec(BLOBS_SELECT + " WHERE id = ?", [id]).then(function (res) {
          var rows = wsRows(res);
          return rows.length ? mapBlobRow(rows[0]) : null;
        });
      },
      put: function (row) {
        var r = row || {};
        return serialWrite(function () {
          return p.exec(
            "INSERT OR REPLACE INTO workspace_blobs (id, conv_id, hash, content, bytes) VALUES (?,?,?,?,?)",
            [wsText(r["id"]), wsText(r["convId"]), wsText(r["hash"]), wsText(r["content"]), wsNum(r["bytes"])]
          );
        }).then(function () {});
      },
      remove: function (id) {
        return serialWrite(function () { return p.exec("DELETE FROM workspace_blobs WHERE id = ?", [id]); })
          .then(function () {});
      },
      removeWhere: function (match) {
        return removeMatching(p, "workspace_blobs", "id", BLOBS_SELECT, mapBlobRow, match);
      },
      clear: function () {
        return serialWrite(function () { return p.exec("DELETE FROM workspace_blobs"); }).then(function () {});
      },
    };
  }

  // ───────── One-time import of the legacy IndexedDB database ─────────
  function isMarked(p) {
    return p.exec("SELECT name FROM storage_marks WHERE name = ?", [IMPORT_MARK]).then(function (res) {
      return wsRows(res).length > 0;
    });
  }

  function markDone(p) {
    return serialWrite(function () {
      return p.exec("INSERT OR REPLACE INTO storage_marks (name, ts) VALUES (?,?)", [IMPORT_MARK, Date.now()]);
    }).then(function () {});
  }

  /** Read all three legacy stores; null means "could not read", which must never be marked done. */
  function readLegacy() {
    // No IndexedDB in this host means no legacy data can exist; that is a definitive empty answer,
    // not a read failure (a headless boot must still be able to use the SQL store).
    if (!window.indexedDB || typeof window.indexedDB.open !== "function") {
      return Promise.resolve({ files: [], versions: [], blobs: [] });
    }
    return idb().then(function (db) {
      if (!db) return null;
      if (_idbCreated) return { files: [], versions: [], blobs: [] };
      return Promise.all([
        reqP(db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).getAll()),
        reqP(db.transaction(IDB_VERSIONS, "readonly").objectStore(IDB_VERSIONS).getAll()),
        reqP(db.transaction(IDB_BLOBS, "readonly").objectStore(IDB_BLOBS).getAll()),
      ]).then(function (all) {
        var files = Array.isArray(all[0]) ? all[0] : [];
        var versions = Array.isArray(all[1]) ? all[1] : [];
        var blobs = Array.isArray(all[2]) ? all[2] : [];
        return { files: files, versions: versions, blobs: blobs };
      });
    }).catch(function (e) {
      warn("旧工作区读取失败", e);
      return null;
    });
  }

  // REPLACE, not IGNORE: until the marker exists the legacy store is the source of truth (a session
  // that fell back to IndexedDB may have newer content), so a retry must converge on it.
  function legacyStatements(legacy) {
    var out = [];
    var i;
    var r;
    for (i = 0; i < legacy.files.length; i++) {
      r = legacy.files[i] || {};
      var fileKey = wsText(r["id"]) || (wsText(r["convId"]) + "::" + wsText(r["path"]));
      if (!fileKey) continue;
      out.push({
        sql: "INSERT OR REPLACE INTO workspace (path, cid, content, lines, ts) VALUES (?,?,?,?,?)",
        params: [fileKey, wsText(r["convId"]), wsText(r["content"]), wsNum(r["lines"]), wsNum(r["ts"])],
      });
    }
    for (i = 0; i < legacy.versions.length; i++) {
      r = legacy.versions[i] || {};
      var versionId = wsText(r["id"]) || (wsText(r["scopeKey"]) + "#" + wsNum(r["seq"]));
      if (!versionId) continue;
      out.push({
        sql: "INSERT OR REPLACE INTO workspace_versions (id, scope_key, conv_id, path, seq, ts, kind, hash, bytes, lines, prev_hash, from_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        params: [
          versionId,
          wsText(r["scopeKey"]),
          wsText(r["convId"]),
          wsText(r["path"]),
          wsNum(r["seq"]),
          wsNum(r["ts"]),
          wsText(r["kind"]),
          r["hash"] == null ? null : wsText(r["hash"]),
          wsNum(r["bytes"]),
          wsNum(r["lines"]),
          r["prevHash"] == null ? null : wsText(r["prevHash"]),
          r["fromVersion"] == null ? null : wsNum(r["fromVersion"]),
        ],
      });
    }
    for (i = 0; i < legacy.blobs.length; i++) {
      r = legacy.blobs[i] || {};
      var blobId = wsText(r["id"]) || (wsText(r["convId"]) + "::" + wsText(r["hash"]));
      if (!blobId) continue;
      out.push({
        sql: "INSERT OR REPLACE INTO workspace_blobs (id, conv_id, hash, content, bytes) VALUES (?,?,?,?,?)",
        params: [blobId, wsText(r["convId"]), wsText(r["hash"]), wsText(r["content"]), wsNum(r["bytes"])],
      });
    }
    return out;
  }

  /** Close our handle, then drop the legacy database. A blocked delete keeps the marker for retry. */
  function deleteLegacyDb() {
    return new Promise(function (resolve) {
      try {
        if (_db) { try { _db.close(); } catch (e) {} _db = null; }
        if (!window.indexedDB || typeof window.indexedDB.deleteDatabase !== "function") return resolve(false);
        var req = window.indexedDB.deleteDatabase(IDB_NAME);
        req.onsuccess = function () { _idbCreated = false; resolve(true); };
        req.onerror = function () {
          warn("旧工作区 IndexedDB 删除失败（旧数据已导入，标记保留；下次启动重试删除）");
          resolve(false);
        };
        req.onblocked = function () {
          warn("旧工作区 IndexedDB 被其他标签页占用，未删除（旧数据已导入；下次启动重试）");
          resolve(false);
        };
      } catch (e) {
        warn("旧工作区 IndexedDB 删除异常", e);
        resolve(false);
      }
    });
  }

  function migrateLegacy(p) {
    return isMarked(p).then(function (done) {
      if (done) return deleteLegacyDb();
      return readLegacy().then(function (legacy) {
        if (!legacy) throw new Error("legacy workspace IndexedDB is unreadable");
        var statements = legacyStatements(legacy);
        return writeChunks(p, statements)
          .then(function () { return markDone(p); })
          .then(deleteLegacyDb);
      });
    });
  }

  // ───────── Backend choice (lazy, once per page) ─────────
  var _backend = null;
  var _backendP = null;

  function fallbackBackend() {
    return { mode: "idb", files: idbFiles, versions: idbVersions, blobs: idbBlobs };
  }

  function resolveBackend() {
    var p = wsPort();
    if (!p) return Promise.resolve(fallbackBackend());
    return hasTables(p).then(function (ok) {
      if (!ok) {
        warn("统一存储缺少 0003 表（workspace_versions / workspace_blobs / storage_marks），本次回退 IndexedDB");
        return fallbackBackend();
      }
      var sql = { mode: "sql", files: makeSqlFiles(p), versions: makeSqlVersions(p), blobs: makeSqlBlobs(p) };
      return migrateLegacy(p).then(function () { return sql; }, function (e) {
        warn("旧 IndexedDB 工作区迁移失败，本次继续用 IndexedDB（旧数据保留，不删库）", e);
        return fallbackBackend();
      });
    }, function (e) {
      // Unreachable is not "schema missing": keep the SQL stores so writes fail loudly instead of
      // silently moving to a second local store that would have to be reconciled later.
      warn("统一存储不可达，工作区操作将报错而不改写 IndexedDB", e);
      return { mode: "sql", files: makeSqlFiles(p), versions: makeSqlVersions(p), blobs: makeSqlBlobs(p) };
    });
  }

  function backend() {
    if (_backend) return Promise.resolve(_backend);
    if (!_backendP) {
      // The `then` wrapper turns a synchronous throw (a hostile port, a missing global) into a
      // rejection: every store method assumes it gets a promise back.
      _backendP = Promise.resolve().then(resolveBackend).then(function (b) { _backend = b; return b; });
    }
    return _backendP;
  }

  /** A FileStore that resolves the chosen backend on each call, so load stays synchronous. */
  function routedStore(pick) {
    return {
      all: function () { return backend().then(function (b) { return pick(b).all(); }); },
      get: function (id) { return backend().then(function (b) { return pick(b).get(id); }); },
      put: function (row) { return backend().then(function (b) { return pick(b).put(row); }); },
      remove: function (id) { return backend().then(function (b) { return pick(b).remove(id); }); },
      removeWhere: function (match) { return backend().then(function (b) { return pick(b).removeWhere(match); }); },
      clear: function () { return backend().then(function (b) { return pick(b).clear(); }); },
    };
  }

  /** SHA-256 of UTF-8 text; history stays off when SubtleCrypto is unavailable. */
  function digest(text) {
    var c = (typeof window !== "undefined" && window.crypto) || null;
    if (!c || !c.subtle || typeof c.subtle.digest !== "function" || typeof TextEncoder === "undefined") {
      return Promise.reject(new Error("crypto.subtle/TextEncoder 不可用"));
    }
    var bytes = new TextEncoder().encode(String(text == null ? "" : text));
    return c.subtle.digest("SHA-256", bytes).then(function (buf) {
      var arr = new Uint8Array(buf), hex = "";
      for (var i = 0; i < arr.length; i++) hex += (arr[i] < 16 ? "0" : "") + arr[i].toString(16);
      return "sha256:" + hex;
    });
  }

  // Resolved per call: nothing guarantees text-search loads before this module (the old code also read
  // it at call time).
  function textPort() {
    return (typeof window !== "undefined" && window.textSearchSvc) || null;
  }

  function activeConvId() {
    try {
      if (window.appSvc && window.appSvc.getActiveConvId) return window.appSvc.getActiveConvId() || "__none__";
    } catch (e) {}
    return "__none__";
  }

  // Real disk: the Tauri save dialog on desktop, an <a download> on the web.
  // Return shape is the service's ExportOutcome — a null path means the user cancelled, not success.
  function exportFile(name, content) {
    var g = (typeof globalThis !== "undefined") ? globalThis : window;
    var invoke = g.tauriSvc ? g.tauriSvc.invokeOrNull() : null;
    var bytes = String(content == null ? "" : content).length;
    if (invoke) {
      return invoke("export_text_file", { suggestedName: name, content: content })
        .then(function (p) {
          // Android may hand back a content:// URI with no path; treat it like a cancel (nothing written).
          if (!p) return { ok: false, error: "已取消保存（未写盘）" };
          return { ok: true, mode: "tauri", path: String(p), bytes: bytes };
        })
        .catch(function (e) { return { ok: false, error: "写盘失败: " + String((e && e.message) || e) }; });
    }
    try {
      var blob = new Blob([content], { type: "text/plain;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var el = document.createElement("a");
      el.href = url;
      el.download = name;
      el.click();
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      return Promise.resolve({ ok: true, mode: "browser-download", filename: name, bytes: bytes });
    } catch (e) {
      return Promise.resolve({ ok: false, error: "下载失败: " + String((e && e.message) || e) });
    }
  }

  var workspace = createWorkspace({
    store: routedStore(function (b) { return b.files; }),
    versions: routedStore(function (b) { return b.versions; }),
    blobs: routedStore(function (b) { return b.blobs; }),
    digest: digest,
    convId: activeConvId,
    now: function () { return Date.now(); },
    text: textPort,
    exportFile: exportFile,
    onToolError: function (name, e) { console.warn("[agent-workspace] 注册工具失败:", name, e); },
  });

  window.__agentWorkspace = {
    defineTools: workspace.defineTools,
    list: workspace.list,
    read: workspace.read,
    write: workspace.write,
    remove: workspace.remove,
    removeByConv: workspace.removeByConv,
    clearAll: workspace.clearAll,
    history: workspace.history,
    readVersion: workspace.readVersion,
    restore: workspace.restore,
    normPath: normPath,
    convId: workspace.convId,
    _idb: { name: IDB_NAME, version: IDB_VERSION, store: IDB_STORE, versions: IDB_VERSIONS, blobs: IDB_BLOBS },
    // Diagnostics only: which backend the lazy probe settled on ("sql" / "idb"), for the status panel.
    _backend: function () { return backend().then(function (b) { return b.mode; }); },
  };
})();
