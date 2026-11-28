// ── Browser wiring (injected by tooling/l0/emit.mjs): binds the checkpoint store to `window.__checkpoints` ──
// Generic checkpoint storage in its own IndexedDB (`cfw_checkpoints_v1`: checkpoints + blobs), the
// SHA-256 digest, and the live roleplay host. `work` and `sandbox` adapters land separately; they
// share the same store and blob table, not their domain tables.
(function () {
  "use strict";
  if (window.__checkpoints) return;

  var IDB_NAME = "cfw_checkpoints_v1";
  var IDB_STORE = "checkpoints";
  var IDB_BLOBS = "blobs";
  var _db = null;

  function idb() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (resolve) {
      try {
        var req = window.indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = function () {
          var d = req.result;
          if (!d.objectStoreNames.contains(IDB_STORE)) {
            var os = d.createObjectStore(IDB_STORE, { keyPath: "id" });
            try { os.createIndex("scope", "scope", { unique: false }); } catch (e) {}
            try { os.createIndex("scopeId", "scopeId", { unique: false }); } catch (e) {}
          }
          if (!d.objectStoreNames.contains(IDB_BLOBS)) {
            var bs = d.createObjectStore(IDB_BLOBS, { keyPath: "id" });
            try { bs.createIndex("scope", "scope", { unique: false }); } catch (e) {}
            try { bs.createIndex("scopeId", "scopeId", { unique: false }); } catch (e) {}
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

  function need(os) {
    if (!os) throw new Error("checkpoint 存储不可用(IndexedDB 打不开)");
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
          if (!os) return Promise.reject(new Error("checkpoint 存储不可用(IndexedDB 打不开)"));
          return new Promise(function (res, rej) {
            var n = 0;
            var r = os.openCursor();
            r.onsuccess = function (e) {
              var c = e.target.result;
              if (!c) return res(n);
              if (match(c.value)) { n++; c.delete(); }
              c.continue();
            };
            r.onerror = function () { rej(new Error("checkpoint 游标读取失败")); };
          });
        });
      },
      clear: function () {
        return tx(storeName, "readwrite").then(function (os) { return reqP(need(os).clear()); });
      },
    };
  }

  var store = makeStore(IDB_STORE);
  var blobs = makeStore(IDB_BLOBS);

  /** SHA-256 of UTF-8 text; the same contract as agent-workspace's digest. */
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

  var checkpoints = createCheckpointStore({
    store: store,
    blobs: blobs,
    digest: digest,
    now: function () { return Date.now(); },
  });

  /**
   * The live roleplay host. The three setters are the host hooks added for rollback:
   * `appSvc.setSessionMessages`, `multiSvc.setSceneIds`, `appSvc.setPriorSummary`.
   * Capture is read-only; apply refuses while a turn is live (setSessionMessages returns false).
   */
  function roleplayHost() {
    var app = (typeof window !== "undefined" && window.appSvc) || null;
    var ch = (typeof window !== "undefined" && window.characterSvc) || null;
    var multi = (typeof window !== "undefined" && window.multiSvc) || null;
    return {
      getMessages: function () {
        try { return (app && app.getSessionMessages) ? app.getSessionMessages() : []; } catch (e) { return []; }
      },
      setMessages: function (messages) {
        try { return (app && app.setSessionMessages) ? app.setSessionMessages(messages) : false; } catch (e) { return false; }
      },
      getActiveCharId: function () {
        try {
          var card = ch && ch.getActiveCard ? ch.getActiveCard() : null;
          return card && card.id ? String(card.id) : "";
        } catch (e) { return ""; }
      },
      setActiveCharId: function (id) {
        try {
          if (ch && ch.setActiveId) ch.setActiveId(String(id || ""));
          // setActiveId refreshes in the background; wait for the new card before affection.
          if (ch && typeof ch.refresh === "function") return ch.refresh();
        } catch (e) {}
        return Promise.resolve();
      },
      getRelation: function () {
        try { return (ch && ch.getActiveRelation) ? String(ch.getActiveRelation() || "") : ""; } catch (e) { return ""; }
      },
      setRelation: function (value) {
        try { if (ch && ch.setActiveRelation) ch.setActiveRelation(String(value || "")); } catch (e) {}
      },
      getEmotion: function () {
        try { return (ch && ch.getActiveEmotion) ? String(ch.getActiveEmotion() || "") : ""; } catch (e) { return ""; }
      },
      setEmotion: function (value) {
        try { if (ch && ch.setActiveEmotion) ch.setActiveEmotion(String(value || "")); } catch (e) {}
      },
      getAffection: function () {
        try {
          var v = ch && ch.getActiveAffection ? ch.getActiveAffection() : null;
          return typeof v === "number" && Number.isFinite(v) ? v : null;
        } catch (e) { return null; }
      },
      setAffection: function (value) {
        try {
          if (ch && ch.setActiveAffection) return ch.setActiveAffection(value);
        } catch (e) {}
        return Promise.resolve();
      },
      getSceneIds: function () {
        try { return (multi && multi.getSceneIds) ? multi.getSceneIds() : []; } catch (e) { return []; }
      },
      setSceneIds: function (ids) {
        try { if (multi && multi.setSceneIds) multi.setSceneIds(ids); } catch (e) {}
      },
      getPriorSummary: function () {
        // Summaries are per conversation now (services/conv/summary.ts); capture the current one.
        try {
          var id = (app && app.getActiveConvId) ? app.getActiveConvId() : "";
          return (window.convSummarySvc && id) ? window.convSummarySvc.load(id) : "";
        } catch (e) { return ""; }
      },
      setPriorSummary: function (text) {
        try { if (app && app.setPriorSummary) app.setPriorSummary(String(text || "")); } catch (e) {}
      },
    };
  }

  window.__checkpoints = {
    put: checkpoints.put,
    list: checkpoints.list,
    get: checkpoints.get,
    remove: checkpoints.remove,
    removeScope: checkpoints.removeScope,
    clear: checkpoints.clear,
    captureRoleplay: captureRoleplay,
    applyRoleplay: applyRoleplay,
    roleplayHost: roleplayHost,
    scopes: CHECKPOINT_SCOPES,
    _idb: { name: IDB_NAME, store: IDB_STORE, blobs: IDB_BLOBS },
  };
})();
