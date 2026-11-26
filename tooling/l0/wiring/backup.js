// Browser wiring, appended by tooling/l0/emit.mjs. Engine: services/data/backup.ts (ZIP export/import over
// the unified SQLite store). This file owns the two platform exits, the settings card and the
// frozen facade.
//
// Public API (non-`__` on purpose; contracts.json tracks `__*` only):
//   window.backupSvc = { v, exportAll, importAll, snapshot }
//   window.backupCard = { mount }
//
// exportAll() exports, then *saves* the archive (Tauri `export_binary_file`, or a Blob download in
// the browser) and resolves with a receipt — a programmatic caller such as T4-C's first-connect
// backup gets a file on disk, not bytes it has to know how to persist. The service itself stays
// DOM-free; the bytes come back on `archive`.
//
// ZIP cores are loaded on demand (`/shared/lib/zip-read.js` / `zip-write.js`), same posture as the
// skill-pack importer: a user who never opens the backup card pays nothing at boot.
(function (g) {
  "use strict";
  if (g.backupSvc) return;

  // Catalog access (see tooling/l0/wiring/i18n.js). Card copy and statuses are addressed by key; the text
  // lives in public/locales/<lang>.json so this file carries no translatable prose.
  function T(key, params) {
    try { return g.__i18n.t(key, params); } catch (e) { return key; }
  }
  function copyReady(fn) {
    try {
      if (g.__i18n && typeof g.__i18n.whenReady === "function") { g.__i18n.whenReady(fn); return; }
    } catch (e) { /* paint with whatever the engine has */ }
    fn();
  }

  var loaders = {};
  function loadScriptOnce(src) {
    if (loaders[src]) return loaders[src];
    loaders[src] = new Promise(function (resolve, reject) {
      if (typeof g.document === "undefined") {
        reject(new Error("无法加载 " + src + "：当前环境没有 document"));
        return;
      }
      var el = g.document.createElement("script");
      el.src = src;
      el.onload = function () { resolve(); };
      el.onerror = function () { delete loaders[src]; reject(new Error("加载失败：" + src)); };
      g.document.head.appendChild(el);
    });
    return loaders[src];
  }

  function ensure(name, src) {
    if (g[name]) return Promise.resolve(g[name]);
    return loadScriptOnce(src).then(function () {
      if (!g[name]) throw new Error(src + " 已加载但没有暴露 " + name);
      return g[name];
    });
  }

  function db() {
    var svc = g.dbSvc;
    if (!svc || typeof svc.get !== "function") throw new Error("backup: dbSvc 未加载");
    return svc.get();
  }

  function zipRead() {
    return ensure("ZipRead", "/shared/lib/zip-read.js").then(function (reader) {
      if (!reader || typeof reader.readZip !== "function") throw new Error("ZIP 读取器未就绪");
      return reader;
    });
  }

  function zipWrite() {
    return ensure("ZipWrite", "/shared/lib/zip-write.js").then(function (writer) {
      if (!writer || typeof writer.writeZip !== "function") throw new Error("ZIP 写入器未就绪");
      return writer;
    });
  }

  function sessionEvents() {
    return g.sessionEventsSvc || null;
  }

  function toast(message, type) {
    try {
      if (g.feedbackSvc && typeof g.feedbackSvc.toast === "function") {
        g.feedbackSvc.toast(String(message), { type: type || "info", ms: 6000 });
      }
    } catch (e) { /* a missing toast must not break the operation */ }
  }

  var service = createBackupService({
    db: db,
    zipRead: zipRead,
    zipWrite: zipWrite,
    sessionEvents: sessionEvents,
    alert: function (message, level) { toast(message, level === "error" ? "err" : "warn"); },
    now: function () { return Date.now(); },
  });

  /* ── binary exit: Tauri writes through its own command, the browser clicks an anchor ───────── */

  function bytesToBase64(bytes) {
    try {
      if (g.dbWire && typeof g.dbWire.bytesToBase64 === "function") return g.dbWire.bytesToBase64(bytes);
    } catch (e) { /* fall through to the local copy */ }
    var out = "";
    var CHUNK = 0x8000;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return g.btoa(out);
  }

  function saveBinary(name, bytes) {
    var invoke = null;
    try {
      if (g.tauriSvc && typeof g.tauriSvc.invokeOrNull === "function") invoke = g.tauriSvc.invokeOrNull();
    } catch (e) { invoke = null; }
    if (invoke) {
      return Promise.resolve(invoke("export_binary_file", {
        suggestedName: name,
        base64Data: bytesToBase64(bytes),
      })).then(function (path) {
        if (path) return { mode: "tauri", path: String(path), cancelled: false };
        return { mode: "tauri", path: "", cancelled: true };
      });
    }
    return new Promise(function (resolve, reject) {
      try {
        var blob = new g.Blob([bytes], { type: "application/zip" });
        var url = g.URL.createObjectURL(blob);
        var a = g.document.createElement("a");
        a.href = url;
        a.download = name;
        a.rel = "noopener";
        a.style.position = "fixed";
        a.style.left = "-9999px";
        a.style.top = "-9999px";
        g.document.body.appendChild(a);
        a.dispatchEvent(new g.MouseEvent("click", { bubbles: true, cancelable: true, view: g }));
        // The anchor and the object URL must outlive the click on a slow machine (save-file.js uses
        // the same 4 s schedule and learned this the hard way).
        g.setTimeout(function () {
          try { if (a.parentNode) a.parentNode.removeChild(a); } catch (e) {}
          try { g.URL.revokeObjectURL(url); } catch (e) {}
        }, 4000);
        resolve({ mode: "browser", path: name, cancelled: false });
      } catch (e) {
        reject(e);
      }
    });
  }

  function errText(e) {
    if (e && e.message) return String(e.message);
    return String(e);
  }

  /* ── facade ──────────────────────────────────────────────────────────────────────────────── */

  function exportAll(options) {
    return Promise.resolve(service.exportAll(options)).then(function (result) {
      if (!result || result.ok !== true) return result;
      return saveBinary(result.filename, result.archive).then(function (saved) {
        if (saved.cancelled) {
          return { ok: false, code: "SAVE_CANCELLED", error: T("settings.backup.status.saveCancelled"), cancelled: true };
        }
        return {
          ok: true,
          filename: result.filename,
          path: saved.path,
          mode: saved.mode,
          size: result.size,
          createdAt: result.createdAt,
          tables: result.tables,
          rows: result.rows,
          nativeKv: result.nativeKv,
          warnings: result.warnings,
        };
      }, function (error) {
        return { ok: false, code: "SAVE_FAILED", error: T("settings.backup.status.saveFailed", { error: errText(error) }) };
      });
    }, function (error) {
      return { ok: false, code: "EXPORT_FAILED", error: errText(error) };
    });
  }

  function importAll(options) {
    return Promise.resolve(service.importAll(options)).then(function (result) {
      // A successful import made the database equal the archive; the old hot window in localStorage
      // is now a stale overlay (hydrate() merges hot over cold by id). Drop it before the card
      // reloads, or the first page load after a restore would show pre-import tails and could
      // re-archive them as fresh events. Settings/conversation-list keys stay.
      if (result && result.ok === true) clearLocalChatCache();
      return result;
    }, function (error) {
      return { ok: false, code: "IMPORT_FAILED", error: errText(error), rolledBack: false };
    });
  }

  /** Hot-window keys only (services/session/store.ts owns their names). Never settings or keys. */
  var LS_CHAT_CACHE_KEYS = [
    "cfw_chat_session_v1",
    "cfw_chat_slot_meta_v1",
    "cfw_chat_tomb_v1",
    "cfw_chat_cold_pending_v1",
    "cfw_chat_archived_v1",
  ];

  function clearLocalChatCache() {
    for (var i = 0; i < LS_CHAT_CACHE_KEYS.length; i++) {
      try { g.localStorage.removeItem(LS_CHAT_CACHE_KEYS[i]); } catch (e) { /* private mode */ }
    }
  }

  function snapshot() {
    return Promise.resolve(service.snapshot());
  }

  g.backupSvc = {
    v: 1,
    exportAll: exportAll,
    importAll: importAll,
    snapshot: snapshot,
  };

  /* ── settings card (「数据」分类：账号 · 数据 · 同步) ──────────────────────────────────────── */

  var busy = false;

  function setText(id, text) {
    var el = g.document.getElementById(id);
    if (el) el.textContent = text;
  }

  function setBusy(value) {
    busy = value;
    var exportBtn = g.document.getElementById("backupExportBtn");
    var importBtn = g.document.getElementById("backupImportBtn");
    if (exportBtn) exportBtn.disabled = value;
    if (importBtn) importBtn.disabled = value;
  }

  function progressText(p) {
    if (!p) return "";
    var table = p.table ? " " + p.table : "";
    var count = p.done == null ? "" : T("settings.backup.progress.counter", { done: p.done, total: p.total == null ? "" : p.total });
    switch (p.phase) {
      case "count": return T("settings.backup.progress.count", { table: table, count: count });
      case "dump": return T("settings.backup.progress.dump", { table: table, count: count });
      case "write": return T("settings.backup.progress.write");
      case "read": return T("settings.backup.progress.read");
      case "validate": return T("settings.backup.progress.validate", { table: table, count: count });
      case "snapshot": return T("settings.backup.progress.snapshot", { table: table, count: count });
      case "clear": return T("settings.backup.progress.clear");
      case "insert": return T("settings.backup.progress.insert", { table: table, count: count });
      case "rebuild": return T("settings.backup.progress.rebuild", { count: count });
      case "rollback": return T("settings.backup.progress.rollback", { table: table, count: count });
      default: return T("settings.backup.progress.done");
    }
  }

  function onProgress(p) {
    setText("backupProgress", progressText(p));
  }

  function refreshSummary() {
    return snapshot().then(function (s) {
      if (!s || s.ok !== true) {
        setText("backupStatus", T("settings.backup.status.summaryFailed", { error: s && s.error ? s.error : T("common.unknownError") }));
        return;
      }
      var tables = 0;
      for (var k in s.tables) { if (Object.prototype.hasOwnProperty.call(s.tables, k)) tables++; }
      setText("backupStatus", T("settings.backup.status.summary", { tables: tables, rows: s.rows }));
    }, function (error) {
      setText("backupStatus", T("settings.backup.status.summaryFailed", { error: errText(error) }));
    });
  }

  function confirmImport() {
    var message = T("settings.backup.confirm.message");
    try {
      if (g.feedbackSvc && typeof g.feedbackSvc.confirm === "function") {
        return g.feedbackSvc.confirm({
          title: T("settings.backup.confirm.title"),
          message: message,
          okText: T("settings.backup.confirm.ok"),
          cancelText: T("settings.backup.confirm.cancel"),
          danger: true,
        });
      }
    } catch (e) { /* fall through to the native confirm */ }
    try {
      return Promise.resolve(!!(g.confirm && g.confirm(message)));
    } catch (e) {
      return Promise.resolve(false);
    }
  }

  function alertDialog(message) {
    try {
      if (g.feedbackSvc && typeof g.feedbackSvc.alert === "function") {
        return g.feedbackSvc.alert({ title: T("settings.backup.dialogTitle"), message: message });
      }
    } catch (e) { /* fall through */ }
    try { if (g.alert) g.alert(message); } catch (e) {}
    return Promise.resolve();
  }

  function doExport() {
    if (busy) return;
    setBusy(true);
    setText("backupProgress", "");
    var nativeToggle = g.document.getElementById("backupNativeKv");
    var includeNativeKv = !!(nativeToggle && nativeToggle.checked);
    exportAll({ includeNativeKv: includeNativeKv, reason: "manual", onProgress: onProgress }).then(function (result) {
      setBusy(false);
      setText("backupProgress", "");
      if (!result || result.ok !== true) {
        setText("backupStatus", T("settings.backup.status.exportFailed", { error: result && result.error ? result.error : T("common.unknownError") }));
        return;
      }
      var tableCount = 0;
      for (var k in result.tables) { if (Object.prototype.hasOwnProperty.call(result.tables, k)) tableCount++; }
      var mb = (result.size / (1024 * 1024)).toFixed(2);
      setText("backupStatus", T("settings.backup.status.exported", {
        tables: tableCount,
        rows: result.rows,
        size: mb,
        target: result.mode === "tauri" ? result.path : result.filename,
      }));
      if (result.warnings && result.warnings.length) {
        setText("backupStatus", T("settings.backup.status.exportedWarnings", {
          count: result.warnings.length,
          warnings: result.warnings.join("；"),
        }));
      }
      refreshSummary();
    }, function (error) {
      setBusy(false);
      setText("backupStatus", T("settings.backup.status.exportFailed", { error: errText(error) }));
    });
  }

  function doImport(bytes, filename) {
    confirmImport().then(function (ok) {
      if (!ok) return;
      if (busy) return;
      setBusy(true);
      setText("backupStatus", T("settings.backup.status.importing", { file: filename }));
      importAll({ bytes: bytes, onProgress: onProgress }).then(function (result) {
        if (!result || result.ok !== true) {
          setBusy(false);
          var message = (result && result.error) ? result.error : T("common.unknownError");
          if (result && result.rolledBack === false && result.code === "ROLLBACK_FAILED") {
            message += "\n\n" + T("settings.backup.status.importIncomplete");
          }
          setText("backupStatus", T("settings.backup.status.importFailed", { error: message }));
          alertDialog(T("settings.backup.status.importFailed", { error: message }));
          return;
        }
        setText("backupStatus", T("settings.backup.status.imported", {
          rows: result.rows,
          conversations: result.rebuilt.conversations,
          messages: result.rebuilt.messages,
        }));
        toast(T("settings.backup.status.importDone"), "ok");
        g.setTimeout(function () {
          try { g.location.reload(); } catch (e) {}
        }, 900);
      }, function (error) {
        setBusy(false);
        setText("backupStatus", T("settings.backup.status.importFailed", { error: errText(error) }));
        alertDialog(T("settings.backup.status.importFailed", { error: errText(error) }));
      });
    });
  }

  function mountCard() {
    copyReady(mountCardNow);
  }

  function mountCardNow() {
    var slot = null;
    try {
      slot = g.slotRegistry && typeof g.slotRegistry.pick === "function" ? g.slotRegistry.pick("setAccountSlot") : null;
    } catch (e) { slot = null; }
    if (slot && g.slotRegistry && typeof g.slotRegistry.claim === "function") {
      try { g.slotRegistry.claim({ cardId: "dataBackupCard", slotId: "setAccountSlot" }); } catch (e) {}
    }
    if (!slot || g.document.getElementById("dataBackupCard")) return;

    var card = g.document.createElement("div");
    card.className = "card";
    card.id = "dataBackupCard";
    card.innerHTML = '<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 7.5h15v12h-15z"/><path d="M8 7.5V5.5h8v2"/><path d="M12 10.5v5.5"/><path d="M9.5 13.5l2.5 2.5 2.5-2.5"/></svg>' + T('settings.backup.card.title') + '</h4>'
      + '<p>' + T('settings.backup.card.intro') + '</p>'
      + '<div class="rowline"><div class="toggle"><input type="checkbox" id="backupNativeKv"><label for="backupNativeKv">' + T('settings.backup.card.includeKv') + '</label></div></div>'
      + '<div class="btns"><button class="smallbtn" id="backupExportBtn" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15.5V5"/><path d="M8 8.5L12 4.5l4 4"/><path d="M5 14.5v3.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5v-3.5"/></svg>' + T('settings.backup.card.export') + '</button>'
      + '<button class="smallbtn danger" id="backupImportBtn" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4.5V15"/><path d="M8 11l4 4 4-4"/><path d="M5 14.5v3.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5v-3.5"/></svg>' + T('settings.backup.card.import') + '</button>'
      + '<input type="file" id="backupImportFile" accept=".zip,application/zip" style="display:none"></div>'
      + '<div id="backupStatus" style="font-size:11px;color:var(--muted);margin-top:8px;">' + T('settings.backup.card.reading') + '</div>'
      + '<div id="backupProgress" style="font-size:11px;color:var(--muted);margin-top:4px;"></div>'
      + '<div class="settings-tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg><span>' + T('settings.backup.card.tip') + '</span></div>';
    slot.appendChild(card);

    var exportBtn = g.document.getElementById("backupExportBtn");
    var importBtn = g.document.getElementById("backupImportBtn");
    var importFile = g.document.getElementById("backupImportFile");

    if (exportBtn) exportBtn.addEventListener("click", doExport);
    if (importBtn && importFile) {
      importBtn.addEventListener("click", function () {
        if (!busy) importFile.click();
      });
      importFile.addEventListener("change", function () {
        var file = importFile.files && importFile.files[0];
        importFile.value = "";
        if (!file) return;
        var reader = new g.FileReader();
        reader.onload = function () {
          var buffer = reader.result;
          if (!buffer) {
            setText("backupStatus", T("settings.backup.status.fileEmpty"));
            return;
          }
          doImport(new Uint8Array(buffer), file.name || "backup.zip");
        };
        reader.onerror = function () {
          setText("backupStatus", T("settings.backup.status.fileFailed", { error: errText(reader.error) }));
        };
        reader.readAsArrayBuffer(file);
      });
    }
    refreshSummary();
  }

  g.backupCard = { mount: mountCard };
})(typeof window !== "undefined" ? window : globalThis);
