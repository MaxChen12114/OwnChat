// Browser adapter, appended by l0/emit.mjs. Engine: services/data/sync.ts; this file owns the
// frozen global name, the platform surface (localStorage, fetch, timers, IndexedDB, the DOM event
// bus, page reload, file save) and the seven sibling modules the engine calls back into.
//
// Two things here are not obvious and must stay here rather than in the engine:
//  - The same-tab storage monkey-patch. A storage event only crosses tabs, so a write made by this
//    tab is invisible to the engine otherwise. Every write is forwarded to the engine, which alone
//    knows which channel a key belongs to.
//  - The desktop-shell flush hook. The Rust side emits it and then waits ~1.2s before quitting;
//    the wiring is the only place that knows the event name.
(function () {
  var storage = {
    get length() {
      try {
        return window.localStorage.length;
      } catch (e) {
        return 0;
      }
    },
    key: function (i) {
      try {
        return window.localStorage.key(i);
      } catch (e) {
        return null;
      }
    },
    getItem: function (k) {
      try {
        return window.localStorage.getItem(k);
      } catch (e) {
        return null;
      }
    },
    setItem: function (k, v) {
      try {
        window.localStorage.setItem(k, String(v));
      } catch (e) {
        /* quota or private mode: the next write retries */
      }
    },
    removeItem: function (k) {
      try {
        window.localStorage.removeItem(k);
      } catch (e) {
        /* nothing to recover */
      }
    },
  };

  // Opening a database can block on an upgrade (another tab holds an older version). The engine
  // must never wait forever, so a blocked or upgrading open resolves to null and the caller skips
  // that database this round.
  function openDB(name) {
    return new Promise(function (resolve) {
      var upgrading = false;
      var req = window.indexedDB.open(name);
      req.onsuccess = function () {
        resolve(upgrading ? null : req.result);
      };
      req.onerror = function () {
        resolve(null);
      };
      req.onupgradeneeded = function (e) {
        upgrading = true;
        try {
          e.target.transaction.abort();
        } catch (err) {
          /* already aborted */
        }
      };
      req.onblocked = function () {
        resolve(null);
      };
    });
  }

  function storeNames(db) {
    var out = [];
    var names = db.objectStoreNames;
    for (var i = 0; i < names.length; i++) out.push(names[i]);
    return out;
  }

  var idb = {
    dump: function (name) {
      return openDB(name).then(function (db) {
        if (!db) return null;
        var names = storeNames(db);
        var out = {};
        var chain = Promise.resolve();
        names.forEach(function (storeName) {
          chain = chain.then(function () {
            return new Promise(function (resolve) {
              var tx = db.transaction(storeName, "readonly");
              var req = tx.objectStore(storeName).getAll();
              req.onsuccess = function () {
                resolve(req.result || []);
              };
              req.onerror = function () {
                resolve([]);
              };
            }).then(function (items) {
              out[storeName] = items;
            });
          });
        });
        return chain.then(function () {
          try {
            db.close();
          } catch (e) {
            /* already closed */
          }
          return out;
        });
      });
    },
    restore: function (name, data) {
      return openDB(name).then(function (db) {
        if (!db) return undefined;
        var names = storeNames(db);
        var chain = Promise.resolve();
        names.forEach(function (storeName) {
          var items = data && data[storeName];
          if (!Array.isArray(items)) return;
          chain = chain.then(function () {
            return new Promise(function (resolve) {
              var tx = db.transaction(storeName, "readwrite");
              var store = tx.objectStore(storeName);
              store.clear();
              for (var i = 0; i < items.length; i++) {
                try {
                  store.put(items[i]);
                } catch (e) {
                  /* one bad record must not abort the whole store */
                }
              }
              tx.oncomplete = function () {
                resolve();
              };
              tx.onerror = function () {
                resolve();
              };
              tx.onabort = function () {
                resolve();
              };
            });
          });
        });
        return chain.then(function () {
          try {
            db.close();
          } catch (e) {
            /* already closed */
          }
        });
      });
    },
    readByIds: function (name, ids) {
      if (!ids || !ids.length) return Promise.resolve([]);
      return openDB(name).then(function (db) {
        if (!db) return [];
        var names = storeNames(db);
        var out = [];
        var chain = Promise.resolve();
        names.forEach(function (storeName) {
          chain = chain.then(function () {
            return new Promise(function (resolve) {
              var tx = db.transaction(storeName, "readonly");
              var req = tx.objectStore(storeName).getAll();
              req.onsuccess = function () {
                resolve(req.result || []);
              };
              req.onerror = function () {
                resolve([]);
              };
            }).then(function (items) {
              for (var i = 0; i < items.length; i++) {
                var it = items[i];
                if (!it) continue;
                // The cards store is keyed by id, the affections store by cardId; both are matched
                // against the same role id.
                if (ids.indexOf(it.id) >= 0 || ids.indexOf(it.cardId) >= 0) out.push({ store: storeName, item: it });
              }
            });
          });
        });
        return chain.then(function () {
          try {
            db.close();
          } catch (e) {
            /* already closed */
          }
          return out;
        });
      });
    },
    putItems: function (name, entries) {
      if (!entries || !entries.length) return Promise.resolve();
      return openDB(name).then(function (db) {
        if (!db) return undefined;
        var byStore = {};
        for (var i = 0; i < entries.length; i++) {
          var e = entries[i];
          if (!byStore[e.store]) byStore[e.store] = [];
          byStore[e.store].push(e.item);
        }
        var chain = Promise.resolve();
        Object.keys(byStore).forEach(function (storeName) {
          chain = chain.then(function () {
            if (!db.objectStoreNames.contains(storeName)) return undefined;
            return new Promise(function (resolve) {
              var tx = db.transaction(storeName, "readwrite");
              var store = tx.objectStore(storeName);
              for (var j = 0; j < byStore[storeName].length; j++) {
                try {
                  store.put(byStore[storeName][j]);
                } catch (e) {
                  /* one bad record must not abort the store */
                }
              }
              tx.oncomplete = function () {
                resolve();
              };
              tx.onerror = function () {
                resolve();
              };
              tx.onabort = function () {
                resolve();
              };
            });
          });
        });
        return chain.then(function () {
          try {
            db.close();
          } catch (e) {
            /* already closed */
          }
        });
      });
    },
  };

  var sync = createSync({
    storage: storage,
    http: function (url, init) {
      return window.fetch(url, init || {});
    },
    timers: {
      set: function (fn, ms) {
        return window.setTimeout(fn, ms);
      },
      clear: function (handle) {
        if (handle != null) window.clearTimeout(handle);
      },
    },
    now: function () {
      return Date.now();
    },
    random: function () {
      return Math.random();
    },
    token: function () {
      var auth = window.__auth;
      return (auth && auth.getToken && auth.getToken()) || "";
    },
    idb: idb,
    dispatch: function (name, detail) {
      try {
        window.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
      } catch (e) {
        /* no listener, no harm */
      }
    },
    reloadPage: function () {
      try {
        window.location.reload();
      } catch (e) {
        /* nothing else to try */
      }
    },
    saveText: function (text, name) {
      var shell = window.__saveFile;
      // The desktop/mobile shell writes the file itself: an Android WebView ignores <a download>,
      // so the browser path silently did nothing there.
      if (shell && typeof shell.saveTextFile === "function") {
        return shell.saveTextFile(text, name).then(
          function (r) {
            return r || { ok: false };
          },
          function (e) {
            return { ok: false, error: String((e && e.message) || e) };
          }
        );
      }
      try {
        var file = new Blob([text], { type: "application/json" });
        var url = URL.createObjectURL(file);
        var a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.click();
        window.setTimeout(function () {
          URL.revokeObjectURL(url);
        }, 1000);
        return Promise.resolve({ ok: true, mode: "browser", filename: name });
      } catch (e) {
        return Promise.resolve({ ok: false, error: String((e && e.message) || e) });
      }
    },
    toast: function (message) {
      try {
        var feedback = window.__feedback;
        if (feedback && feedback.toast) feedback.toast(message, 2600);
      } catch (e) {
        /* feedback is a nicety */
      }
    },
    providerMerge: function () {
      return window.__providerMerge || null;
    },
    providers: function () {
      return window.__providers || null;
    },
    costUi: function () {
      var api = window.hostApi;
      return (api && api.cost) || null;
    },
    realtime: function () {
      return window.__chatRealtime || null;
    },
    charMerge: function () {
      return window.__charSyncMerge || null;
    },
    character: function () {
      return window.__character || null;
    },
  });

  // Local file import needs a FileReader, which the engine deliberately cannot reach.
  function importFile(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        sync.importJSONText(String(reader.result)).then(resolve, reject);
      };
      reader.onerror = function () {
        reject(reader.error);
      };
      reader.readAsText(file);
    });
  }

  window.__sync = {
    markDirty: sync.markDirty,
    pushNow: sync.pushNow,
    pullFromKV: sync.pullFromKV,
    pullOnStartup: sync.pullOnStartup,
    markCostDirty: sync.markCostDirty,
    pushCostNow: sync.pushCostNow,
    pullCostOnStartup: sync.pullCostOnStartup,
    wipeCloud: sync.wipeCloud,
    deleteMainFromKV: sync.deleteMainFromKV,
    deleteCostFromKV: sync.deleteCostFromKV,
    deleteChatFromKV: sync.deleteChatFromKV,
    deleteCharsFromKV: sync.deleteCharsFromKV,
    deleteExcludeFromKV: sync.deleteExcludeFromKV,
    deleteChatEventsFromKV: sync.deleteChatEventsFromKV,
    wipeCloudEntity: sync.wipeCloudEntity,
    restoreCloudEntity: sync.restoreCloudEntity,
    getExcluded: sync.getExcluded,
    addExclusion: sync.addExclusion,
    removeExclusion: sync.removeExclusion,
    pullExcludeOnStartup: sync.pullExcludeOnStartup,
    pushExcludeNow: sync.pushExcludeNow,
    getRegistry: sync.getRegistry,
    markChatDirty: sync.markChatDirty,
    pushChatNow: sync.pushChatNow,
    pullChatOnStartup: sync.pullChatOnStartup,
    pullChatNow: sync.pullChatNow,
    mergeChatSessions: sync.mergeChatSessions,
    getChatConflicts: sync.getChatConflicts,
    resolveChatConflict: sync.resolveChatConflict,
    withRemoteApply: sync.withRemoteApply,
    isExcludedSession: sync.isExcludedSession,
    setChatConflict: sync.setChatConflict,
    getChatSlotMeta: sync.getChatSlotMeta,
    getChatTomb: sync.getChatTomb,
    getConvMetaMap: sync.getConvMetaMap,
    getChatSynced: sync.getChatSynced,
    getDeviceId: sync.getDeviceId,
    authHeaders: sync.authHeaders,
    hashChat: sync.hashChat,
    markCharsDirty: sync.markCharsDirty,
    pushCharsNow: sync.pushCharsNow,
    pullCharsOnStartup: sync.pullCharsOnStartup,
    bumpCharMeta: sync.bumpCharMeta,
    tombChar: sync.tombChar,
    exportJSON: sync.exportJSON,
    importJSON: importFile,
    syncEnabled: sync.syncEnabled,
    setSyncEnabled: sync.setSyncEnabled,
    includeChat: sync.includeChat,
    setIncludeChat: sync.setIncludeChat,
    isPaused: sync.isPaused,
    pause: sync.pause,
    resume: sync.resume,
    dumpAll: sync.dumpAll,
    restoreAll: sync.restoreAll,
    onStatus: sync.onStatus,
    getStatus: sync.getStatus,
  };

  // Same-tab writes: the storage event only crosses tabs, so monkey-patch the two mutators. This is
  // what lets cards, presets, history and cost sync without touching any other file.
  try {
    var realSetItem = Storage.prototype.setItem;
    var realRemoveItem = Storage.prototype.removeItem;
    Storage.prototype.setItem = function (k, v) {
      realSetItem.call(this, k, v);
      if (this === window.localStorage) sync.noteStorageWrite(String(k));
    };
    Storage.prototype.removeItem = function (k) {
      realRemoveItem.call(this, k);
      if (this === window.localStorage) sync.noteStorageRemove(String(k));
    };
  } catch (e) {
    /* a frozen Storage prototype leaves the cross-tab path working; same-tab auto-sync degrades */
  }

  window.addEventListener("storage", function (e) {
    sync.noteStorageEvent(e ? e.key : null);
  });

  // The desktop shell emits this from the tray "quit" and window-close paths, then waits ~1.2s.
  try {
    var tauri = window.__TAURI__;
    var events = tauri && tauri.event;
    if (events && typeof events.listen === "function") {
      events.listen("app-flush-now", function () {
        sync.flushAll();
      });
    }
  } catch (e) {
    /* plain web: the event never fires */
  }

  sync.bootstrap();
})();
