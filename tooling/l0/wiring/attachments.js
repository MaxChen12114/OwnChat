// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/ui/attachments.ts owns the pending
// state machine, metadata shaping, token estimation and the request-assembly expansion; this file
// owns the attachment storage adapters (the unified SQLite `attachments` table reached through
// window.dbSvc, with the legacy IndexedDB database as the one-time import source and fallback), the
// DOM (text chips, image cards, lightbox with pinch/pan gestures), the pending strip above the
// composer, and the frozen attach facade assembly.
//
// Storage split: text attachments live in the `text` column (fileFullText reads them back without a
// Blob round trip), image bytes live in `body` and travel the DbPort's `{__b64}` wire shape. A row
// may legally have only one of the two, which is also what makes old rows readable.
//
// Frozen global name: the attach facade is written by chat-extras (add side) and read by app.js
// and chat-ux (retry/restore side); every method key below is load-bearing for those callers.
// The lightbox also publishes a debug snapshot global (scale/pan/pointer counts) — same key as
// before, consumers expect it.
(function (global) {
  "use strict";
  if (global.attachSvc) return;

  const esc = global.escapeSvc.esc; // shared escaper, loaded earlier in the boot list

  function warn(message, error) {
    try { console.warn("[attachments] " + message, error); } catch (e) {}
  }

  // ───────── Storage constants ─────────
  // The IndexedDB database exists on purpose: reusing cfw_image_gallery needs a version bump
  // (conflicts with existing v1 openers, old users read null) and cfw_image_album has a "clear
  // gallery" button that would wipe chat blobs. A separate DB is conflict-free. It is now the
  // fallback/legacy source, not the primary store.
  var IDB_NAME = "cfw_chat_images";
  var IDB_STORE = "blobs";
  var IMPORT_MARK = "attachments_idb_v1";
  // `attachments` is 0002's table; `storage_marks` arrives with 0003. Both are probed together:
  // without the ledger the legacy import cannot be recorded, so a half schema must fall back.
  var SQL_TABLES = ["attachments", "storage_marks"];
  // Small batches: a stray photo can be megabytes and D1's /tx route accepts 4 MB of JSON per
  // request. The legacy import writes one row per transaction; this batch size drives the orphan
  // sweep only.
  var WRITE_CHUNK = 10;
  var _db = null;
  var _idbCreated = false;

  // ───────── legacy IndexedDB adapter (fallback + one-time import source) ─────────
  function idb() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (resolve) {
      try {
        var req = global.indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = function (ev) {
          // oldVersion 0 means this open created the database; an upgrade of an existing database
          // (oldVersion > 0) may hold real blobs and must still be read/imported.
          _idbCreated = !ev || !ev.oldVersion;
          try { req.result.createObjectStore(IDB_STORE); } catch (e) {}
        };
        req.onsuccess = function () { _db = req.result; resolve(_db); };
        req.onerror = function () { resolve(null); };
        req.onblocked = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
  }
  function idbPut(id, blob) {
    return idb().then(function (db) {
      if (!db || !blob) return false;
      return new Promise(function (res) {
        try {
          var tx = db.transaction(IDB_STORE, "readwrite");
          tx.objectStore(IDB_STORE).put(blob, id);
          tx.oncomplete = function () { res(true); };
          tx.onerror = function () { res(false); };
          tx.onabort = function () { res(false); };
        } catch (e) { res(false); }
      });
    }).catch(function () { return false; });
  }
  function idbGet(id) {
    return idb().then(function (db) {
      if (!db) return null;
      return new Promise(function (res) {
        try {
          var r = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(id);
          r.onsuccess = function () { res(r.result || null); };
          r.onerror = function () { res(null); };
        } catch (e) { res(null); }
      });
    }).catch(function () { return null; });
  }
  function idbDelete(id) {
    return idb().then(function (db) {
      if (!db) return;
      try { db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE).delete(id); } catch (e) {}
    }).catch(function () {});
  }

  // ───────── SQLite attachment store (attachments.text / attachments.body) ─────────
  function sqlPort() {
    try {
      var svc = global.dbSvc;
      if (svc && typeof svc.get === "function") return svc.get();
    } catch (e) {
      warn("DbPort 不可用，本次回退 IndexedDB", e);
    }
    return null;
  }
  function rowsOf(result) {
    return result && Array.isArray(result.rows) ? result.rows : [];
  }
  function hasTables(p) {
    return p.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?,?)", SQL_TABLES)
      .then(function (res) {
        var found = {};
        rowsOf(res).forEach(function (row) { found[String(row && row.name)] = true; });
        for (var i = 0; i < SQL_TABLES.length; i++) if (!found[SQL_TABLES[i]]) return false;
        return true;
      });
  }
  // One writer at a time: the node sidecar and the Tauri shell share one SQLite connection, and two
  // overlapping BEGIN/COMMIT batches abort each other. Reads stay parallel.
  var _writeChain = Promise.resolve();
  function serialWrite(job) {
    var run = _writeChain.then(job);
    _writeChain = run.then(function () {}, function () {});
    return run;
  }

  function writeChunks(p, statements) {
    var at = 0;
    function step() {
      if (at >= statements.length) return Promise.resolve();
      var batch = statements.slice(at, at + WRITE_CHUNK);
      at += WRITE_CHUNK;
      return serialWrite(function () {
        return p.transaction(function (t) {
          for (var i = 0; i < batch.length; i++) t.exec(batch[i].sql, batch[i].params);
        });
      }).then(step);
    }
    return step();
  }
  function isMarked(p) {
    return p.exec("SELECT name FROM storage_marks WHERE name = ?", [IMPORT_MARK]).then(function (res) {
      return rowsOf(res).length > 0;
    });
  }
  function markDone(p) {
    return serialWrite(function () {
      return p.exec("INSERT OR REPLACE INTO storage_marks (name, ts) VALUES (?,?)", [IMPORT_MARK, Date.now()]);
    }).then(function () {});
  }

  /** One row shape for both writes and the legacy import: text goes to `text`, bytes to `body`. */
  function statFor(id, name, mime, size, body, text) {
    return {
      sql: "INSERT OR REPLACE INTO attachments (id, name, mime, size, body, text, ts) VALUES (?,?,?,?,?,?,?)",
      params: [id, name, mime || null, size, body, text, Date.now()],
    };
  }

  /** Blob → statement. Text blobs keep their text so fileFullText never reconstructs a Blob. */
  function statementFromBlob(id, name, blob) {
    var mime = String(blob.type || "");
    var label = name ? String(name) : id;
    var isText = /^text\//i.test(mime);
    var read = isText ? blob.text() : blob.arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
    return read.then(function (value) {
      var text = isText ? String(value) : null;
      var body = isText ? null : value;
      var size = typeof blob.size === "number" ? blob.size : (isText ? text.length : body.length);
      return statFor(id, label, mime, size, body, text);
    });
  }

  function sqlPut(p, id, blob, name) {
    return statementFromBlob(id, name, blob).then(function (statement) {
      // A single statement still goes through `transaction`: D1's /exec route caps the JSON body
      // at 1 MB while /tx caps it at 4 MB, and an attachment is the only binary payload here.
      return serialWrite(function () {
        return p.transaction(function (t) { t.exec(statement.sql, statement.params); });
      }).then(function () { return true; });
    });
  }

  function bytesOf(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return null;
  }

  function sqlGet(p, id) {
    return p.exec("SELECT body, text, mime FROM attachments WHERE id = ?", [id]).then(function (res) {
      var row = rowsOf(res)[0];
      if (!row) return null;
      var mime = row.mime == null ? "" : String(row.mime);
      var bytes = bytesOf(row.body);
      if (bytes) return new Blob([bytes], { type: mime });
      if (row.body != null) return null; // malformed body is "not on this device", never a fake blob
      if (row.text != null) return new Blob([String(row.text)], { type: mime || "text/plain" });
      return null;
    });
  }

  function sqlGetText(p, id) {
    return p.exec("SELECT text FROM attachments WHERE id = ?", [id]).then(function (res) {
      var row = rowsOf(res)[0];
      return row && row.text != null ? String(row.text) : null;
    });
  }

  function sqlDelete(p, id) {
    return serialWrite(function () { return p.exec("DELETE FROM attachments WHERE id = ?", [id]); })
      .then(function () {});
  }

  // ───────── Backend choice (lazy, once per page) ─────────
  var _backend = null;
  var _backendP = null;

  function fallbackBackend() {
    return { mode: "idb" };
  }

  /** Read every [key, Blob] pair from the legacy store; null means unreadable (never mark done). */
  function readLegacy() {
    // No IndexedDB in this host means no legacy data can exist; that is a definitive empty answer,
    // not a read failure (a headless boot must still be able to use the SQL store).
    if (!global.indexedDB || typeof global.indexedDB.open !== "function") return Promise.resolve([]);
    return idb().then(function (db) {
      if (!db) return null;
      if (_idbCreated) return [];
      return new Promise(function (resolve) {
        try {
          var entries = [];
          var cursor = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).openCursor();
          cursor.onsuccess = function (e) {
            var c = e.target.result;
            if (!c) return resolve(entries);
            entries.push([c.key, c.value]);
            c.continue();
          };
          cursor.onerror = function () { resolve(null); };
        } catch (e) { resolve(null); }
      });
    }).catch(function (e) {
      warn("旧附件读取失败", e);
      return null;
    });
  }

  /** Close our handle, then drop the legacy database. A blocked delete keeps the marker for retry. */
  function deleteLegacyDb() {
    return new Promise(function (resolve) {
      try {
        if (_db) { try { _db.close(); } catch (e) {} _db = null; }
        if (!global.indexedDB || typeof global.indexedDB.deleteDatabase !== "function") return resolve(false);
        var req = global.indexedDB.deleteDatabase(IDB_NAME);
        req.onsuccess = function () { _idbCreated = false; resolve(true); };
        req.onerror = function () {
          warn("旧附件 IndexedDB 删除失败（旧数据已导入，标记保留；下次启动重试删除）");
          resolve(false);
        };
        req.onblocked = function () {
          warn("旧附件 IndexedDB 被其他标签页占用，未删除（旧数据已导入；下次启动重试）");
          resolve(false);
        };
      } catch (e) {
        warn("旧附件 IndexedDB 删除异常", e);
        resolve(false);
      }
    });
  }

  // REPLACE, not IGNORE: until the marker exists the legacy store is the source of truth (a session
  // that fell back to IndexedDB may have newer blobs), so a retry must converge on it. One row per
  // transaction: a photo can be megabytes, and converting every blob before writing would hold the
  // whole legacy database in memory.
  function migrateLegacy(p) {
    return isMarked(p).then(function (done) {
      if (done) return deleteLegacyDb();
      return readLegacy().then(function (entries) {
        if (!entries) throw new Error("legacy attachment IndexedDB is unreadable");
        var at = 0;
        function step() {
          if (at >= entries.length) return Promise.resolve();
          var entry = entries[at++];
          var id = String(entry[0]);
          var blob = entry[1];
          if (!id || !blob || typeof blob.arrayBuffer !== "function") return step();
          return statementFromBlob(id, id, blob).then(function (statement) {
            return serialWrite(function () {
              return p.transaction(function (t) { t.exec(statement.sql, statement.params); });
            });
          }).then(step);
        }
        return step()
          .then(function () { return markDone(p); })
          .then(deleteLegacyDb);
      });
    });
  }

  function resolveBackend() {
    var p = sqlPort();
    if (!p) return Promise.resolve(fallbackBackend());
    return hasTables(p).then(function (ok) {
      if (!ok) {
        warn("统一存储缺少 attachments/storage_marks 表，本次回退 IndexedDB");
        return fallbackBackend();
      }
      return migrateLegacy(p).then(function () { return { mode: "sql", port: p }; }, function (e) {
        warn("旧附件 IndexedDB 迁移失败，本次继续用 IndexedDB（旧数据保留，不删库）", e);
        return fallbackBackend();
      });
    }, function (e) {
      // Unreachable is not "schema missing": keep the SQL backend so writes fail loudly instead of
      // silently moving to a second local store that would have to be reconciled later.
      warn("统一存储不可达，附件操作将报错而不改写 IndexedDB", e);
      return { mode: "sql", port: p };
    });
  }

  function backend() {
    if (_backend) return Promise.resolve(_backend);
    if (!_backendP) {
      // The `then` wrapper turns a synchronous throw (a hostile port, a missing global) into a
      // rejection: every caller assumes it gets a promise back.
      _backendP = Promise.resolve().then(resolveBackend).then(function (b) { _backend = b; return b; });
    }
    return _backendP;
  }

  // ───────── Ports (the same three the service always had, plus the text fast path) ─────────
  function putBlob(id, blob, name) {
    if (!blob) return Promise.resolve(false);
    return backend().then(function (b) {
      // Fallback mode means the SQL path was never tried; if the local write also fails, the caller
      // gets false and the in-page memo still covers this send.
      return b.mode === "sql" ? sqlPut(b.port, id, blob, name) : idbPut(id, blob);
    }).catch(function (e) {
      warn("写入附件失败", e);
      return false;
    });
  }
  function getBlob(id) {
    return backend().then(function (b) {
      return b.mode === "sql" ? sqlGet(b.port, id) : idbGet(id);
    }).catch(function (e) {
      warn("读取附件失败", e);
      return null;
    });
  }
  /** Text fast path: null means "no text row"; the service then falls back to getBlob(). */
  function getText(id) {
    return backend().then(function (b) {
      return b.mode === "sql" ? sqlGetText(b.port, id) : null;
    }).catch(function () { return null; });
  }
  function delBlob(id) {
    return backend().then(function (b) {
      return b.mode === "sql" ? sqlDelete(b.port, id) : idbDelete(id);
    }).catch(function (e) { warn("删除附件失败", e); });
  }

  // One orphan sweep 4s after boot (blobs left behind by deleted messages): the keep set cannot be
  // the current session alone — the sweep runs once at startup, and collecting only the live
  // session's ids would delete every other conversation's blobs (symptom: switching back shows
  // unusable images / empty documents). Walk every slot of the session store, then union the
  // in-memory session and the not-yet-sent attachments (when history is off the live session never
  // lands in storage and the pending list is the safety net). It waits for the backend probe so a
  // migration in flight is never half-swept.
  if (global.indexedDB && global.indexedDB.databases) {
    setTimeout(function () { gcOrphanBlobs(); }, 4000);
  }
  function collectKeepIds() {
    var keep = {};
    var keepMsg = function (m) {
      (m && m.images ? m.images : []).forEach(function (im) { if (im && im.id) keep[im.id] = 1; });
      // Document full texts also live in storage (message files carry an id) — leaving them out
      // would GC them as orphans (symptom: texts vanish after refresh / empty docs on send).
      (m && m.files ? m.files : []).forEach(function (f) { if (f && f.id) keep[f.id] = 1; });
    };
    try {
      // T3-D: localStorage only carries the hot window now; the full arrays (hot + cold projection)
      // come from the session store mirror, so archived messages keep their blobs. Fall back to the
      // legacy blob when the mirror is not up yet (early boot).
      var all = null;
      try {
        if (global.appSvc && typeof global.appSvc.getAllSessionMessages === "function") {
          all = global.appSvc.getAllSessionMessages();
        }
      } catch (e4) {}
      if (!all || typeof all !== "object") {
        all = JSON.parse(global.localStorage.getItem("cfw_chat_session_v1") || "{}") || {};
      }
      if (Array.isArray(all)) all = { "__none__": all };
      Object.keys(all).forEach(function (slot) {
        (all[slot] || []).forEach(keepMsg);
      });
    } catch (e3) {}
    var arr = (global.appSvc && global.appSvc.getSessionMessages) ? global.appSvc.getSessionMessages() : [];
    (arr || []).forEach(keepMsg);
    // Not-yet-sent attachments must survive too.
    try {
      core.list().forEach(function (p) {
        if (p && p.id) keep[p.id] = 1;
      });
    } catch (e2) {}
    return keep;
  }
  function gcOrphanBlobs() {
    try {
      var keep = collectKeepIds();
      backend().then(function (b) {
        if (b.mode === "sql") {
          return b.port.exec("SELECT id FROM attachments").then(function (res) {
            var statements = [];
            rowsOf(res).forEach(function (row) {
              var id = String(row && row.id);
              if (id && !keep[id]) statements.push({ sql: "DELETE FROM attachments WHERE id = ?", params: [id] });
            });
            return writeChunks(b.port, statements);
          });
        }
        return idb().then(function (db) {
          if (!db) return;
          try {
            var os = db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE);
            os.openCursor().onsuccess = function (e) {
              var c = e.target.result;
              if (!c) return;
              if (!keep[c.key]) { try { c.delete(); } catch (e2) {} }
              c.continue();
            };
          } catch (e) {}
        });
      }).catch(function (e) { warn("附件孤儿清理失败", e); });
    } catch (e) {}
  }

  // ───────── Core instantiation: storage ports + strip re-render hook ─────────
  const core = createAttachmentsCore({
    putBlob: putBlob,
    getBlob: getBlob,
    getText: getText,
    onPendingChange: function () { renderPendingBar(); }
  });

  const DOC_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';

  // ───────── CSS (self-injected, colors via theme tokens) ─────────
  const STYLE_ID = "attachStyles";
  const CSS_TEXT = `
.att-strip{pointer-events:auto;width:100%;max-width:var(--content-max);margin:0 auto 8px;display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start;}
.att-strip:empty{display:none;}
.att-chip{position:relative;display:inline-flex;align-items:center;gap:8px;max-width:min(250px,72vw);padding:8px 14px;border-radius:999px;background:var(--bubble-ai,rgba(127,127,127,.10));border:1px solid var(--border,rgba(127,127,127,.24));box-shadow:0 1px 6px rgba(0,0,0,.10);font-size:12.5px;line-height:1.2;color:inherit;}
.att-chip-ico{flex:none;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;}
.att-chip-ico svg{width:18px;height:18px;display:block;}
.att-chip-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;}
.att-chip-trunc{flex:none;font-size:10px;font-weight:700;line-height:1;padding:3px 6px;border-radius:999px;color:#ffb648;border:1px solid rgba(255,182,72,.45);background:rgba(255,182,72,.12);}
.att-x{flex:none;width:19px;height:19px;border:none;border-radius:999px;background:rgba(127,127,127,.18);color:inherit;cursor:pointer;font-size:13px;line-height:1;padding:0;display:inline-flex;align-items:center;justify-content:center;opacity:.65;transition:opacity .15s,background .15s;}
.att-x:hover{opacity:1;background:rgba(232,96,125,.28);}
.att-wrap{display:flex;flex-direction:column;gap:6px;max-width:100%;margin:0 0 6px;}
.att-wrap:empty{display:none;}
.att-chips{display:flex;flex-wrap:wrap;gap:6px;}
.att-cards{display:flex;flex-wrap:wrap;gap:6px;}
.att-cards:empty{display:none;}
.att-card{position:relative;flex:none;height:96px;border-radius:10px;overflow:hidden;border:1px solid var(--border,rgba(127,127,127,.28));cursor:zoom-in;background:rgba(127,127,127,.12);transition:transform .15s ease,box-shadow .15s ease;}
.att-card:hover{transform:translateY(-1px);box-shadow:0 6px 18px rgba(0,0,0,.28);}
.att-card img{display:block;height:100%;width:auto;max-width:min(320px,60vw);object-fit:cover;}
.att-card.att-missing{display:flex;align-items:center;justify-content:center;width:120px;cursor:default;color:var(--muted,#9a9a9a);font-size:10.5px;text-align:center;padding:0 8px;line-height:1.4;}
.att-card .att-x{position:absolute;right:4px;top:4px;background:rgba(20,20,20,.72);color:#fff;}
#attLightbox{position:fixed;inset:0;background:rgba(0,0,0,.86);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;z-index:9990;padding:24px;box-sizing:border-box;animation:attFade .16s ease;}
#attLightbox img{max-width:92vw;max-height:86vh;object-fit:contain;border-radius:10px;box-shadow:0 30px 80px rgba(0,0,0,.6);touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;will-change:transform;}
#attLightbox img.zoom-anim{transition:transform .18s ease;}
#attLightbox .att-lb-hint{position:absolute;bottom:16px;left:50%;transform:translateX(-50%);color:rgba(255,255,255,.6);font-size:11px;letter-spacing:.02em;pointer-events:none;white-space:nowrap;text-shadow:0 1px 4px rgba(0,0,0,.6);}
#attLightbox .att-lb-nav{position:absolute;top:50%;transform:translateY(-50%);width:40px;height:40px;border-radius:50%;border:1px solid rgba(255,255,255,.22);background:rgba(30,30,30,.7);color:#fff;font-size:18px;line-height:1;cursor:pointer;display:none;align-items:center;justify-content:center;font-family:inherit;}
#attLightbox .att-lb-nav.show{display:flex;}
#attLightbox .att-lb-nav:hover{background:rgba(60,60,60,.85);}
#attLightbox .att-lb-nav.prev{left:12px;}
#attLightbox .att-lb-nav.next{right:12px;}
#attLightbox .att-lb-count{position:absolute;bottom:17px;left:16px;color:rgba(255,255,255,.7);font-size:12px;font-variant-numeric:tabular-nums;}
@media (max-width:640px){#attLightbox .att-lb-nav{top:auto;bottom:40px;transform:none;}}
.att-lb-bar{position:absolute;top:14px;right:16px;display:flex;gap:8px;}
.att-lb-bar a,.att-lb-bar button{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border-radius:9px;border:1px solid rgba(255,255,255,.22);background:rgba(30,30,30,.7);color:#fff;font-size:12px;text-decoration:none;cursor:pointer;font-family:inherit;}
.att-lb-bar a:hover,.att-lb-bar button:hover{background:rgba(60,60,60,.85);}
@keyframes attFade{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){.att-card{transition:none;}#attLightbox{animation:none;}}
@media (max-width:640px){.att-card{height:76px;}#attLightbox{padding:12px;}}
`;
  function ensureCss() {
    const doc = global.document;
    if (doc.getElementById(STYLE_ID)) return;
    const s = doc.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS_TEXT;
    (doc.head || doc.documentElement).appendChild(s);
  }

  // ───────── Lightbox (double-tap zoom / pinch / pan when zoomed / wheel zoom / swipe nav) ─────────
  let lbEl = null;
  function closeLightbox() {
    if (!lbEl) return;
    if (lbEl.parentNode) lbEl.parentNode.removeChild(lbEl);
    lbEl = null;
    global.document.removeEventListener("keydown", lbKey, true);
  }
  function lbKey(e) {
    if (e.key === "Escape") { e.stopPropagation(); closeLightbox(); return; }
    // Multi-image keyboard navigation (desktop)
    if (lbEl && typeof lbEl.__nav === "function") {
      if (e.key === "ArrowRight") { e.stopPropagation(); lbEl.__nav(1); }
      else if (e.key === "ArrowLeft") { e.stopPropagation(); lbEl.__nav(-1); }
    }
  }
  function openLightbox(src, name, list, index) {
    const doc = global.document;
    ensureCss();
    closeLightbox();
    lbEl = doc.createElement("div");
    lbEl.id = "attLightbox";
    const items = (Array.isArray(list) && list.length) ? list : [{ src: src, name: name }];
    let cur = Math.max(0, Math.min(items.length - 1, index || 0));
    const img = doc.createElement("img");
    img.src = src;
    img.alt = name || "附件图片";
    img.draggable = false;
    const hint = doc.createElement("div");
    hint.className = "att-lb-hint";
    hint.textContent = "双击放大 · 捏合缩放 · 放大后可拖动";
    const count = doc.createElement("div");
    count.className = "att-lb-count";
    const bar = doc.createElement("div");
    bar.className = "att-lb-bar";
    const dl = doc.createElement("a");
    dl.href = src; dl.download = name || "image"; dl.textContent = "下载";
    // The mobile shell does not support <a download> — route through the shell's
    // export_binary_file (writes into the Android/media visible dir); the web build keeps the
    // native download untouched.
    dl.addEventListener("click", function (e) {
      const sf = global.saveFileSvc;
      if (!sf || !sf.isTauri || !sf.isTauri() || !sf.saveBinaryFile) return;
      e.preventDefault(); e.stopPropagation();
      const it = items[cur] || {};
      sf.saveBinaryFile(it.src || img.src, it.name || "image.png").then(function (r) {
        const msg = (r && r.ok) ? ("已保存：" + (r.path || r.filename || "文件")) : ("保存失败：" + ((r && r.error) || "未知错误"));
        try { if (global.feedbackSvc && global.feedbackSvc.toast) global.feedbackSvc.toast(msg, 3200); } catch (e3) {}
      });
    });
    const op = doc.createElement("button");
    op.type = "button"; op.textContent = "新标签打开";
    op.addEventListener("click", function (e) { e.stopPropagation(); try { global.open(img.src, "_blank"); } catch (e2) {} });
    const cl = doc.createElement("button");
    cl.type = "button"; cl.textContent = "关闭";
    bar.appendChild(dl); bar.appendChild(op); bar.appendChild(cl);
    const prev = doc.createElement("button");
    prev.type = "button"; prev.className = "att-lb-nav prev"; prev.textContent = "‹"; prev.setAttribute("aria-label", "上一张");
    const next = doc.createElement("button");
    next.type = "button"; next.className = "att-lb-nav next"; next.textContent = "›"; next.setAttribute("aria-label", "下一张");
    lbEl.appendChild(img); lbEl.appendChild(bar); lbEl.appendChild(hint); lbEl.appendChild(count); lbEl.appendChild(prev); lbEl.appendChild(next);
    lbEl.addEventListener("click", function (e) { if (e.target === lbEl || e.target === cl) closeLightbox(); });
    doc.body.appendChild(lbEl);
    doc.addEventListener("keydown", lbKey, true);

    function show(i) {
      cur = Math.max(0, Math.min(items.length - 1, i));
      const it = items[cur];
      reset();
      img.src = it.src;
      img.alt = it.name || "附件图片";
      dl.href = it.src; dl.download = it.name || "image";
      const many = items.length > 1;
      prev.classList.toggle("show", many);
      next.classList.toggle("show", many);
      count.textContent = many ? ((cur + 1) + "/" + items.length) : "";
    }
    function nav(delta) { if (items.length > 1) show(cur + delta); }
    lbEl.__nav = nav;
    prev.addEventListener("click", function (e) { e.stopPropagation(); nav(-1); });
    next.addEventListener("click", function (e) { e.stopPropagation(); nav(1); });

    // ── Zoom / pan gestures (Pointer Events: one path for touch and mouse) ──
    let scale = 1, tx = 0, ty = 0;
    const pointers = new Map();
    let pinchBase = null;      // { dist, midX, midY, scale0, tx0, ty0 }
    let panBase = null;        // { x, y, tx0, ty0 }
    let lastTap = { t: 0, x: 0, y: 0 };
    let swipeStart = null; // horizontal swipe switches image at 1x
    const MAX_SCALE = 8, MIN_SCALE = 1;
    show(cur);

    function apply(anim) {
      if (anim) img.classList.add("zoom-anim"); else img.classList.remove("zoom-anim");
      img.style.transform = "translate(" + tx + "px," + ty + "px) scale(" + scale + ")";
    }
    function clampPan() {
      const maxX = Math.max(0, (img.clientWidth * scale - lbEl.clientWidth) / 2 + 24);
      const maxY = Math.max(0, (img.clientHeight * scale - lbEl.clientHeight) / 2 + 24);
      tx = Math.max(-maxX, Math.min(maxX, tx));
      ty = Math.max(-maxY, Math.min(maxY, ty));
      if (scale <= MIN_SCALE + 0.001) { tx = 0; ty = 0; }
    }
    function zoomAt(factor, cx, cy) { // cx/cy = client focus point; zoom around it (translate outer, scale inner)
      const s0 = scale;
      const s1 = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * factor));
      if (s1 === s0) return;
      const rect = img.getBoundingClientRect();
      const cx0 = rect.left + rect.width / 2, cy0 = rect.top + rect.height / 2;
      scale = s1;
      tx = tx + (cx - cx0) * (1 - scale / s0);
      ty = ty + (cy - cy0) * (1 - scale / s0);
      clampPan();
      apply(false);
    }
    function reset() { scale = 1; tx = 0; ty = 0; apply(true); }

    img.addEventListener("pointerdown", function (e) {
      e.preventDefault(); // swallow the synthetic click so pinch/pan never closes on backdrop
      try { img.setPointerCapture(e.pointerId); } catch (e2) {}
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const pts = [];
        pointers.forEach(function (p) { pts.push(p); });
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
        pinchBase = {
          dist: dist,
          midX: (pts[0].x + pts[1].x) / 2, midY: (pts[0].y + pts[1].y) / 2,
          scale0: scale, tx0: tx, ty0: ty
        };
        panBase = null;
      } else if (pointers.size === 1 && scale > MIN_SCALE + 0.001) {
        panBase = { x: e.clientX, y: e.clientY, tx0: tx, ty0: ty };
        swipeStart = null;
      } else if (pointers.size === 1) {
        swipeStart = { x: e.clientX, y: e.clientY };
      }
    });
    img.addEventListener("pointermove", function (e) {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size >= 2 && pinchBase) {
        const pts = [];
        pointers.forEach(function (p) { pts.push(p); });
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
        const midX = (pts[0].x + pts[1].x) / 2, midY = (pts[0].y + pts[1].y) / 2;
        const s0 = pinchBase.scale0;
        const s1 = Math.max(MIN_SCALE, Math.min(MAX_SCALE, s0 * (dist / pinchBase.dist)));
        // Baseline geometry: zoom from the pinch start, keeping the two-finger midpoint fixed
        const rect = img.getBoundingClientRect();
        const cx0 = rect.left + rect.width / 2 - tx, cy0 = rect.top + rect.height / 2 - ty; // untransformed center
        const baseMidDX = pinchBase.midX - (cx0 + pinchBase.tx0);
        const baseMidDY = pinchBase.midY - (cy0 + pinchBase.ty0);
        scale = s1;
        tx = midX - cx0 - baseMidDX * (scale / s0);
        ty = midY - cy0 - baseMidDY * (scale / s0);
        clampPan();
        apply(false);
      } else if (pointers.size === 1 && panBase) {
        tx = panBase.tx0 + (e.clientX - panBase.x);
        ty = panBase.ty0 + (e.clientY - panBase.y);
        clampPan();
        apply(false);
      }
    });
    function onUp(e) {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchBase = null;
      if (pointers.size === 1) {
        let rest = null;
        pointers.forEach(function (p) { rest = p; });
        panBase = (scale > MIN_SCALE + 0.001) ? { x: rest.x, y: rest.y, tx0: tx, ty0: ty } : null;
      } else {
        panBase = null;
        if (scale <= MIN_SCALE + 0.001) reset();
      }
      // 1x horizontal swipe -> previous/next image (multi-image only)
      if (swipeStart && scale <= MIN_SCALE + 0.001) {
        const sdx = e.clientX - swipeStart.x, sdy = e.clientY - swipeStart.y;
        if (Math.abs(sdx) > 60 && Math.abs(sdx) > 2 * Math.abs(sdy)) {
          swipeStart = null;
          nav(sdx < 0 ? 1 : -1);
          return;
        }
      }
      swipeStart = null;
      // Double-tap detection (two quick pointerups near the same spot)
      const now = Date.now();
      if (now - lastTap.t < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 28) {
        lastTap = { t: 0, x: 0, y: 0 };
        if (scale > MIN_SCALE + 0.05) reset();
        else zoomAt(2.5, e.clientX, e.clientY);
        return;
      }
      lastTap = { t: now, x: e.clientX, y: e.clientY };
    }
    img.addEventListener("pointerup", onUp);
    img.addEventListener("pointercancel", function (e) {
      pointers.delete(e.pointerId);
      pinchBase = null; panBase = null;
      if (scale <= MIN_SCALE + 0.001) reset();
    });
    img.addEventListener("wheel", function (e) {
      e.preventDefault();
      zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY);
    }, { passive: false });
  }

  // ───────── Rendering: text chip ─────────
  // Pill + colored doc icon + truncated filename; a visible "truncated" badge replaces the
  // hover-only title (mobile has no hover at all).
  function makeChipEl(f, onRemove) {
    const doc = global.document;
    const el = doc.createElement("span");
    el.className = "att-chip";
    el.title = f.name + " · " + core.fmtChars(f.chars) + (f.truncated ? "(已截断)" : "");
    const ico = doc.createElement("span");
    ico.className = "att-chip-ico";
    ico.style.color = typeColor(f.name);
    ico.innerHTML = DOC_SVG;
    const nm = doc.createElement("span");
    nm.className = "att-chip-name";
    nm.textContent = f.name;
    el.appendChild(ico);
    el.appendChild(nm);
    if (f.truncated) {
      const tg = doc.createElement("span");
      tg.className = "att-chip-trunc";
      tg.textContent = "已截断";
      tg.title = "原文 " + core.fmtChars(f.chars) + ",超过 " + core.ATT_MAX_CHARS + " 字上限,仅前 " + core.ATT_MAX_CHARS + " 字会发送";
      el.appendChild(tg);
    }
    if (onRemove) {
      const x = doc.createElement("button");
      x.type = "button"; x.className = "att-x"; x.textContent = "×"; x.title = "移除";
      x.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); onRemove(); });
      el.appendChild(x);
    }
    return el;
  }

  // ───────── Rendering: image card (+ lightbox) ─────────
  // srcOf: use the in-memory dataUrl when present; on history restore fetch the blob by id
  // from IDB and convert to an objectURL (cached, bounded eviction).
  const _urlCache = new Map();
  const URL_CACHE_MAX = 40;
  function cachedUrl(id, blob) {
    if (_urlCache.has(id)) return _urlCache.get(id);
    const u = URL.createObjectURL(blob);
    _urlCache.set(id, u);
    if (_urlCache.size > URL_CACHE_MAX) {
      const firstKey = _urlCache.keys().next().value;
      try { URL.revokeObjectURL(_urlCache.get(firstKey)); } catch (e) {}
      _urlCache.delete(firstKey);
    }
    return u;
  }
  function makeCardEl(meta, src, onRemove) {
    const doc = global.document;
    if (!src) {
      const ph = doc.createElement("div");
      ph.className = "att-card att-missing";
      ph.textContent = "图片不可用(未同步到本设备)";
      ph.title = meta && meta.name ? meta.name : "";
      if (onRemove) {
        const x0 = doc.createElement("button");
        x0.type = "button"; x0.className = "att-x"; x0.textContent = "×";
        x0.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); onRemove(); });
        ph.appendChild(x0);
      }
      return ph;
    }
    const card = doc.createElement("div");
    card.className = "att-card";
    const img = doc.createElement("img");
    img.src = src;
    img.alt = (meta && meta.name) || "附件图片";
    // Memory: a full history restore decodes every attachment image of the conversation —
    // keep offscreen ones unloaded / undecoded.
    try { img.loading = "lazy"; img.decoding = "async"; } catch (e) {}
    card.appendChild(img);
    card.addEventListener("click", function () {
      // Collect the loaded images of this group for the lightbox -> multi-image nav (placeholder
      // cards have no img and are skipped automatically)
      let group = [], idx = 0;
      try {
        const imgs = card.parentNode ? card.parentNode.querySelectorAll(".att-card img") : [];
        for (let i = 0; i < imgs.length; i++) {
          if (imgs[i].src) group.push({ src: imgs[i].src, name: imgs[i].alt || "" });
          if (imgs[i] === img) idx = group.length - 1;
        }
      } catch (e) {}
      openLightbox(src, (meta && meta.name) || "", group.length > 1 ? group : null, idx);
    });
    if (onRemove) {
      const x = doc.createElement("button");
      x.type = "button"; x.className = "att-x"; x.textContent = "×"; x.title = "移除";
      x.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); onRemove(); });
      card.appendChild(x);
    }
    return card;
  }
  // The one "append an image card" entry: dataUrl is used directly; with only an id, place the
  // placeholder first and swap in the real image once IDB yields the blob.
  function appendImageCard(container, meta, onRemove) {
    const inner = makeCardEl(meta, (meta && meta.dataUrl) || "", onRemove);
    container.appendChild(inner);
    if (meta && !meta.dataUrl && meta.id) {
      getBlob(meta.id).then(function (blob) {
        if (!blob) return; // not on this device / already cleaned -> keep the placeholder
        const real = makeCardEl(meta, cachedUrl(meta.id, blob), onRemove);
        if (inner.parentNode === container) container.replaceChild(real, inner);
      });
    }
    return inner;
  }
  // Render one {files, images, _memImages} bundle into a container.
  // opts.before: insert the attachment block BEFORE that element (in chat = above the bubble,
  // its own block like ZCode); omit to append at the end (pending strip use).
  function renderInto(container, att, opts) {
    if (!container || !att) return container;
    ensureCss();
    opts = opts || {};
    const doc = global.document;
    const host = (opts.before && opts.before.parentNode) ? opts.before.parentNode : container;
    let wrap = host.querySelector(":scope > .att-wrap");
    if (!wrap) {
      wrap = doc.createElement("div");
      wrap.className = "att-wrap";
      if (opts.before && opts.before.parentNode === host) host.insertBefore(wrap, opts.before);
      else host.appendChild(wrap);
    }
    // ZCode order: image thumbnails on top, file chips on the next row, bubble at the bottom
    const imgs = (att._memImages && att._memImages.length) ? att._memImages : (att.images || []);
    if (imgs.length) {
      const cards = doc.createElement("div");
      cards.className = "att-cards";
      wrap.appendChild(cards);
      imgs.forEach(function (m) {
        appendImageCard(cards, m, opts.onRemoveImage ? function () { opts.onRemoveImage(m); } : null);
      });
    }
    if (att.files && att.files.length) {
      const row = doc.createElement("div");
      row.className = "att-chips";
      att.files.forEach(function (f) {
        row.appendChild(makeChipEl(f, opts.onRemoveFile ? function () { opts.onRemoveFile(f); } : null));
      });
      wrap.appendChild(row);
    }
    return container;
  }

  // ───────── Pending strip (above the composer) ─────────
  let stripEl = null;
  function mountStrip() {
    const doc = global.document;
    ensureCss();
    if (stripEl && stripEl.parentNode) return stripEl;
    const anchor = doc.getElementById("composer");
    const floating = doc.querySelector(".input-floating");
    if (!anchor && !floating) return null;
    stripEl = doc.createElement("div");
    stripEl.id = "attachStrip";
    stripEl.className = "att-strip";
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(stripEl, anchor);
    else floating.insertBefore(stripEl, floating.firstChild);
    return stripEl;
  }
  function renderPendingBar() {
    const el = mountStrip();
    if (!el) return;
    el.textContent = "";
    const all = core.list();
    if (!all.length) { el.style.display = "none"; return; }
    el.style.display = "";
    // Same order as in chat: images on top, file chips below (each removable)
    const imgs = all.filter(function (p) { return p.kind === "image"; });
    const files = all.filter(function (p) { return p.kind === "text"; });
    if (imgs.length) {
      const cards = global.document.createElement("div");
      cards.className = "att-cards";
      imgs.forEach(function (p) { appendImageCard(cards, p, function () { core.remove(p.id); }); });
      el.appendChild(cards);
    }
    if (files.length) {
      const row = global.document.createElement("div");
      row.className = "att-chips";
      files.forEach(function (p) { row.appendChild(makeChipEl(p, function () { core.remove(p.id); })); });
      el.appendChild(row);
    }
  }
  // Put a sent message's attachments back into the pending list (retry path): the legacy
  // implementation rebuilt the message from bubble text and the attachments were gone for
  // good — that was the root cause of "retry after switching model loses the attachment".
  function restage(msg) {
    return core.restage(msg);
  }

  // ───────── History-restore rendering + long-message fold ─────────
  // Render a restored message's attachments ABOVE the bubble (chips + image cards, ZCode look)
  function renderAttachmentsInto(bubble, att) {
    if (!bubble || !att) return;
    if (!core.attHasAny(att) && !(att._memImages && att._memImages.length)) return;
    try {
      renderInto(bubble.parentNode || bubble, att, { before: bubble });
    } catch (_) {}
  }
  const USER_FOLD_CHARS = 420;
  const USER_FOLD_LINES = 12;
  // Long user-message fold (2026-09-14): pasted long texts collapse the bubble (bottom fade +
  // expand arrow) instead of flooding the screen. Presentation only: the session keeps the
  // full content (retry/resend read the session, not the bubble text), so nothing is lost.
  function applyUserFold(bubble) {
    const doc = global.document;
    if (!bubble || bubble.querySelector(":scope > .uc-wrap")) return;
    const raw = bubble.textContent || "";
    if (raw.length <= USER_FOLD_CHARS && raw.split(String.fromCharCode(10)).length <= USER_FOLD_LINES) return;
    const inner = doc.createElement("div");
    inner.className = "uc-inner";
    // Move text nodes only; the attachment block (att-wrap) stays outside the fold
    Array.prototype.slice.call(bubble.childNodes).forEach(function (n) {
      if (n.nodeType === 1 && n.classList && n.classList.contains("att-wrap")) return;
      inner.appendChild(n);
    });
    if (!inner.childNodes.length) return;
    const wrap = doc.createElement("div");
    wrap.className = "uc-wrap folded";
    wrap.appendChild(inner);
    bubble.appendChild(wrap);
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "uc-toggle";
    btn.title = "展开全文";
    btn.setAttribute("aria-label", "展开全文");
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      const folded = wrap.classList.toggle("folded");
      btn.title = folded ? "展开全文" : "收起";
      btn.setAttribute("aria-label", btn.title);
    });
    bubble.appendChild(btn);
  }

  // ───────── Frozen facade: key set is the contract, do not rename ─────────
  global.attachSvc = {
    list: core.list, count: core.count, countImages: core.countImages, clear: core.clear, remove: core.remove,
    addText: core.addText, addImage: core.addImage,
    takePending: core.takePending, restage: restage,
    renderInto: renderInto,
    renderPendingBar: renderPendingBar,
    openLightbox: openLightbox,
    putBlob: putBlob, getBlob: getBlob, delBlob: delBlob,
    imageDataUrl: core.imageDataUrl,
    fileFullText: core.fileFullText,
    fmtChars: core.fmtChars, fmtBytes: core.fmtBytes, esc: esc,
    attHasAny: core.attHasAny, attMeta: core.attMeta, attMaxChars: core.attMaxChars,
    attFileTokens: core.attFileTokens,
    renderAttachmentsInto: renderAttachmentsInto,
    applyUserFold: applyUserFold,
    expandAttachmentMessages: core.expandAttachmentMessages,
    ATT_MAX_CHARS: ATT_MAX_CHARS
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
