// ── Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name ──
// Agent file workspace: the data layer lives in services/data/agent-workspace.ts, so this file owns
// only the browser-side pieces — three IndexedDB tables (files keyed convId::path, versions keyed
// scope#seq, blobs keyed convId::hash), the content hash for dedupe, the lazy bridge to text-search,
// the two "export to real disk" channels, and registering the file tools into the registry.
// Export reports failure as failure on purpose: the old version called a cancelled save ok:true, so
// the model announced a file that had landed nowhere.
(function () {
  var IDB_NAME = "cfw_agent_workspace_v1";
  var IDB_STORE = "files";
  var IDB_VERSIONS = "versions";
  var IDB_BLOBS = "blobs";
  var IDB_VERSION = 2;
  var _db = null;

  function idb() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (resolve) {
      try {
        var req = window.indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = function () {
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
    if (!os) throw new Error("工作区不可用(IndexedDB 打不开)");
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
          if (!os) return Promise.reject(new Error("工作区不可用(IndexedDB 打不开)"));
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

  var store = makeStore(IDB_STORE);
  var versionsStore = makeStore(IDB_VERSIONS);
  var blobsStore = makeStore(IDB_BLOBS);

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
    return (typeof window !== "undefined" && window.__textSearch) || null;
  }

  function activeConvId() {
    try {
      if (window.__app && window.__app.getActiveConvId) return window.__app.getActiveConvId() || "__none__";
    } catch (e) {}
    return "__none__";
  }

  // Real disk: the Tauri save dialog on desktop, an <a download> on the web.
  // Return shape is the service's ExportOutcome — a null path means the user cancelled, not success.
  function exportFile(name, content) {
    var g = (typeof globalThis !== "undefined") ? globalThis : window;
    var invoke = (g.__TAURI__ && g.__TAURI__.core && typeof g.__TAURI__.core.invoke === "function")
      ? g.__TAURI__.core.invoke.bind(g.__TAURI__.core) : null;
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
    store: store,
    versions: versionsStore,
    blobs: blobsStore,
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
  };
})();
