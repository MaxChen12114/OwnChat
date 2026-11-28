(function () {
/**
 * Native KV for the hot window: a synchronous mirror over an asynchronous store.
 *
 * Why this shape: the desktop shell keeps settings in SQLite (`kv_list` / `kv_set` / `kv_delete`),
 * which is async, while ~200 existing call sites read localStorage synchronously. Rewriting them now
 * would be a second migration stacked on T3's; instead this port preloads the namespace once, serves
 * reads from memory, and queues writes with last-write-wins coalescing per key.
 *
 * Queue contract (the part a caller must be able to reason about):
 *   · `set`/`remove` are synchronous and only touch the mirror + queue; they never await.
 *   · one key carries at most one pending op — a later `set` replaces an earlier one, and a `remove`
 *     after a set the store never saw drops the pair entirely (no write-then-delete round trip).
 *   · `flush()` drains in insertion order and stops at the first failure, re-queueing that op and the
 *     rest so the next flush retries in the same order. A newer op for the same key while a flush is
 *     in flight wins over the re-queued one.
 *   · a preload never overwrites a key that has a pending write: the write happened after the load
 *     started, so it is the newer fact.
 *
 * Reads before the preload finishes THROW instead of returning null. An empty mirror that answers
 * "no value" is indistinguishable from "this key was never written", and this repo has paid for
 * silent fallbacks repeatedly; a loud error plus `status().lastError` is the honest failure.
 *
 * `createLocalStorageKv` is the web/no-shell sibling with the same interface and no queue (writes hit
 * localStorage immediately), so a call site can take one port type and run in both hosts. Neither
 * factory publishes a global: `tooling/l0/wiring/storage.js` owns the instance and the flush listeners.
 * @module services/platform/storage
 */

/** The IO a native KV needs. `load` returns already-paired entries; order is irrelevant. */
                       
                                                            
                                                   
                                     
 

/** Outcome of one drain. `remaining` counts ops still queued (a failure keeps the rest). */
                              
                       
                           
                           
                          
                             
 

/** Everything a status panel (or the first-run step) needs to explain the port. */
                           
                           
                             
                          
                             
                        
                           
                          
                           
                            
                             
 

/** The hot-window store. Sync reads/writes, async durability. */
                            
                
                             
                           
                                                                                                        
                                     
                                  
                                        
                            
                            
                   
                     
                                
                                                                                          
                  
 

/** Options shared by both factories. */
                            
                                                                                      
                              
                                                                     
                            
     
                                                                                                    
                                                                        
     
                                 
 

/** A value as a readable string; never "[object Object]". */
function errText(e         )         {
  if (e instanceof Error) return e.message;
  return String(e);
}

function requireString(value         , name        )         {
  if (typeof value !== "string") throw new Error("kv: " + name + " must be a string");
  return value;
}

/** The browser store shape `createLocalStorageKv` needs (a `Storage`, or a test double). */
                                   
                          
                                    
                                      
                                            
                                
 

/**
 * Build the native-backed port. Nothing is read until the caller awaits `ready` (the factory kicks
 * the preload immediately, so boot pays it once in the background).
 */
function createKvStorage(io      , options            )            {
  if (!io || typeof io.load !== "function" || typeof io.write !== "function" || typeof io.remove !== "function") {
    throw new Error("kv: io.load/io.write/io.remove are required");
  }
  const namespace = options && typeof options.namespace === "string" ? options.namespace : "native";
  const adapter = options && typeof options.adapter === "string" ? options.adapter : "native";
  const delay = options && typeof options.flushDelayMs === "number" ? options.flushDelayMs : 0;

  const mirror = new Map                ();
  const queue = new Map                                              ();
  /** Keys the store is known to hold (preload + successful writes), so a remove can be dropped. */
  const persisted = new Set        ();
  let loaded = false;
  let loadError = "";
  let disposed = false;
  let timer                                       = null;
  let draining                              = null;
  let writes = 0;
  let deletes = 0;
  let failures = 0;
  let lastError = "";

  let settleReady                             = () => undefined;
  let failReady                            = () => undefined;
  const ready = new Promise           ((resolve, reject) => {
    settleReady = resolve;
    failReady = reject;
  });

  const api            = {
    v: 1,
    namespace: namespace,
    adapter: adapter,
    ready: ready,

    get(key        )                {
      assertReadable(key);
      return mirror.get(key) ?? null;
    },

    set(key        , value        )       {
      requireString(key, "key");
      requireString(value, "value");
      if (disposed) throw new Error("kv: storage is disposed");
      mirror.set(key, value);
      queue.set(key, { op: "set", value: value });
      schedule();
    },

    remove(key        )       {
      requireString(key, "key");
      if (disposed) throw new Error("kv: storage is disposed");
      mirror.delete(key);
      const pending = queue.get(key);
      // A remove after a set that never reached the store is a no-op: the key does not exist there,
      // so a delete round trip would be pure latency. Before the preload nothing is known — keep it.
      if (pending !== undefined && pending.op === "set" && !persisted.has(key) && loaded) {
        queue.delete(key);
        return;
      }
      queue.set(key, { op: "del", value: "" });
      schedule();
    },

    has(key        )          {
      assertReadable(key);
      return mirror.has(key);
    },

    keys()           {
      assertReadable("");
      return Array.from(mirror.keys());
    },

    status()           {
      return {
        adapter: adapter,
        namespace: namespace,
        ready: loaded,
        disposed: disposed,
        keys: mirror.size,
        pending: queue.size,
        writes: writes,
        deletes: deletes,
        failures: failures,
        lastError: lastError,
      };
    },

    flush()                       {
      if (draining !== null) return draining;
      if (queue.size === 0) {
        return Promise.resolve({ ok: loadError === "", written: 0, deleted: 0, failed: 0, remaining: 0 });
      }
      const batch = Array.from(queue.entries());
      queue.clear();
      let written = 0;
      let deleted = 0;
      let failed = 0;
      const run = async ()                       => {
        for (let i = 0; i < batch.length; i++) {
          const [key, op] = batch[i];
          try {
            if (op.op === "del") {
              await io.remove(key);
              persisted.delete(key);
              deleted++;
            } else {
              await io.write(key, op.value);
              persisted.add(key);
              writes++;
              written++;
            }
          } catch (e) {
            failed++;
            failures++;
            lastError = "kv: " + op.op + " " + key + " failed (" + errText(e) + ")";
            // Re-queue this op and everything after it, preserving order. A newer op for the same key
            // (a set that arrived while this flush was awaiting) stays the winner.
            for (let j = i; j < batch.length; j++) {
              const rest = batch[j];
              if (!queue.has(rest[0])) queue.set(rest[0], rest[1]);
            }
            break;
          }
        }
        if (deleted > 0) deletes += deleted;
        return { ok: failed === 0, written: written, deleted: deleted, failed: failed, remaining: queue.size };
      };
      const p = run().then(
        (report) => {
          draining = null;
          // Writes that arrived during the drain need their own turn; the timer was consumed.
          if (queue.size > 0 && delay >= 0) schedule();
          return report;
        },
        (e) => {
          draining = null;
          throw e;
        },
      );
      draining = p;
      return p;
    },

    dispose()       {
      disposed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };

  /** Reads before the preload are an error, not an empty answer. */
  function assertReadable(key        )       {
    if (!loaded) {
      const why = loadError ? " (" + loadError + ")" : "";
      throw new Error("kv: " + namespace + " not loaded yet" + why + (key ? " — key " + key : ""));
    }
  }

  function schedule()       {
    if (disposed || delay < 0 || timer !== null || queue.size === 0) return;
    timer = setTimeout(() => {
      timer = null;
      void api.flush();
    }, delay);
  }

  // Preload: pending writes win over the stored value (they happened later).
  void Promise.resolve()
    .then(() => io.load())
    .then(
      (rows) => {
        const list = Array.isArray(rows) ? rows : [];
        for (const row of list) {
          if (!Array.isArray(row) || row.length < 2) continue;
          const key = String(row[0]);
          persisted.add(key);
          if (queue.has(key)) continue;
          mirror.set(key, String(row[1]));
        }
        loaded = true;
        settleReady(api);
      },
      (e) => {
        loadError = "kv: preload failed (" + errText(e) + ")";
        failures++;
        lastError = loadError;
        failReady(new Error(loadError));
      },
    );

  return api;
}

/**
 * localStorage-backed sibling: synchronous reads/writes, no queue, same interface.
 * @param store the page's `localStorage` (or a double)
 * @param options `namespace` becomes a key prefix, so two instances never collide
 */
function createLocalStorageKv(store                  , options            )            {
  if (!store || typeof store.getItem !== "function" || typeof store.setItem !== "function") {
    throw new Error("kv: localStorage-like store is required");
  }
  const namespace = options && typeof options.namespace === "string" ? options.namespace : "local";
  const adapter = options && typeof options.adapter === "string" ? options.adapter : "localStorage";
  const prefix = namespace + ":";
  let writes = 0;
  let deletes = 0;
  let disposed = false;
  let settleReady                             = () => undefined;
  const ready = new Promise           ((resolve) => {
    settleReady = resolve;
  });
  const api            = {
    v: 1,
    namespace: namespace,
    adapter: adapter,
    ready: ready,
    get(key        )                {
      return store.getItem(prefix + requireString(key, "key"));
    },
    set(key        , value        )       {
      if (disposed) throw new Error("kv: storage is disposed");
      store.setItem(prefix + requireString(key, "key"), requireString(value, "value"));
      writes++;
    },
    remove(key        )       {
      if (disposed) throw new Error("kv: storage is disposed");
      store.removeItem(prefix + requireString(key, "key"));
      deletes++;
    },
    has(key        )          {
      return store.getItem(prefix + requireString(key, "key")) !== null;
    },
    keys()           {
      const out           = [];
      for (let i = 0; i < store.length; i++) {
        const full = store.key(i);
        if (full !== null && full.indexOf(prefix) === 0) out.push(full.slice(prefix.length));
      }
      return out;
    },
    status()           {
      return {
        adapter: adapter,
        namespace: namespace,
        ready: true,
        disposed: disposed,
        keys: api.keys().length,
        pending: 0,
        writes: writes,
        deletes: deletes,
        failures: 0,
        lastError: "",
      };
    },
    flush()                       {
      return Promise.resolve({ ok: true, written: 0, deleted: 0, failed: 0, remaining: 0 });
    },
    dispose()       {
      disposed = true;
    },
  };
  settleReady(api);
  return api;
}

// Browser wiring, appended by tooling/l0/emit.mjs. Engine: services/platform/storage.ts (the hot-window KV).
//
// Public API: window.storageSvc = { v, adapter, kv, ready, status, flush, namespaces, flushAll,
// dispose }. Non-`__` name on purpose: the frozen `window.__*` surface must not grow (check-contracts),
// and this is a port consumers will migrate onto, not a contract to preserve forever.
//
// What it owns: the one native-backed namespace (`ownchat`) the shell's kv_* commands store, the
// localStorage sibling for the web, the flush listeners, and the shell's `app-flush-now` bridge (the
// tray quit path already emits it for chat sync). Read-before-ready throws by design; `status()`
// explains a failed preload instead of pretending the namespace is empty.
(function (g) {
  "use strict";
  if (g.storageSvc) return;

  var NS = "ownchat";
  var shell = null;
  try {
    if (g.tauriSvc && typeof g.tauriSvc.available === "function" && g.tauriSvc.available()) shell = g.tauriSvc;
  } catch (e) {
    // A hostile or absent shell means the localStorage sibling, never a boot-time crash.
    shell = null;
  }

  function invoke(cmd, args) {
    if (!shell) return Promise.reject(new Error("Tauri shell is not available"));
    return shell.invoke(cmd, args);
  }

  function nativeIo(namespace) {
    return {
      load: function () {
        return invoke("kv_list", { namespace: namespace }).then(function (rows) {
          if (!Array.isArray(rows)) return [];
          var out = [];
          for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            if (!r) continue;
            out.push([String(r.key), String(r.value)]);
          }
          return out;
        });
      },
      write: function (key, value) {
        return invoke("kv_set", { namespace: namespace, key: key, value: value });
      },
      remove: function (key) {
        return invoke("kv_delete", { namespace: namespace, key: key });
      },
    };
  }

  var lsStore = {
    get length() {
      try { return g.localStorage.length; } catch (e) { return 0; }
    },
    key: function (i) {
      try { return g.localStorage.key(i); } catch (e) { return null; }
    },
    getItem: function (k) {
      try { return g.localStorage.getItem(k); } catch (e) { return null; }
    },
    setItem: function (k, v) {
      g.localStorage.setItem(k, v);
    },
    removeItem: function (k) {
      g.localStorage.removeItem(k);
    },
  };

  var kv;
  if (shell) {
    kv = createKvStorage(nativeIo(NS), { namespace: NS, adapter: "native", flushDelayMs: 0 });
  } else {
    kv = createLocalStorageKv(lsStore, { namespace: NS, adapter: "localStorage" });
  }
  // An unobserved rejection is noise in the console; status() carries the reason and every real
  // consumer awaits `ready` (which still rejects for them).
  try {
    kv.ready.catch(function () {});
  } catch (e) {}

  // Extra namespaces (host settings, future domains) share the shell transport but keep their own
  // mirror and queue, so a slow namespace cannot block the hot one.
  var extra = {};
  function namespaces(name) {
    var key = String(name || "");
    if (!key) throw new Error("storageSvc.namespaces: name is required");
    if (extra[key]) return extra[key];
    if (!shell) {
      var local = createLocalStorageKv(lsStore, { namespace: key, adapter: "localStorage" });
      try { local.ready.catch(function () {}); } catch (e) {}
      extra[key] = local;
      return local;
    }
    var port = createKvStorage(nativeIo(key), { namespace: key, adapter: "native", flushDelayMs: 0 });
    try { port.ready.catch(function () {}); } catch (e) {}
    extra[key] = port;
    return port;
  }

  var listeners = [];
  function on(target, event, fn) {
    if (!target || typeof target.addEventListener !== "function") return;
    target.addEventListener(event, fn);
    listeners.push([target, event, fn]);
  }
  function flushNow() {
    // Fire-and-forget on purpose: a pagehide handler cannot await anything.
    void kv.flush();
    for (var key in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, key)) void extra[key].flush();
    }
  }
  on(g, "pagehide", flushNow);
  on(g, "beforeunload", flushNow);
  if (g.document && typeof g.document.addEventListener === "function") {
    on(g.document, "visibilitychange", function () {
      if (g.document.visibilityState === "hidden") flushNow();
    });
  }
  // Shell quit path: the tray already emits this before exit(0) so chat sync can push; flush here too,
  // otherwise the last keystrokes of host settings would miss the 0ms timer window.
  var unlisten = null;
  if (shell && typeof shell.listen === "function") {
    try {
      unlisten = shell.listen("app-flush-now", flushNow);
    } catch (e) {
      unlisten = null;
    }
  }

  g.storageSvc = {
    v: 1,
    adapter: shell ? "native" : "localStorage",
    kv: kv,
    ready: kv.ready,
    status: function () {
      var out = kv.status();
      out.namespaces = Object.keys(extra).length;
      return out;
    },
    flush: function () {
      return kv.flush();
    },
    flushAll: function () {
      var work = [kv.flush()];
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) work.push(extra[key].flush());
      }
      return Promise.all(work);
    },
    namespaces: namespaces,
    dispose: function () {
      for (var i = 0; i < listeners.length; i++) {
        var l = listeners[i];
        try { l[0].removeEventListener(l[1], l[2]); } catch (e) {}
      }
      listeners.length = 0;
      if (unlisten) {
        try {
          Promise.resolve(unlisten).then(function (fn) {
            if (typeof fn === "function") fn();
          }, function () {});
        } catch (e) {}
        unlisten = null;
      }
      kv.dispose();
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) extra[key].dispose();
      }
    },
  };
})(window);

globalThis.createKvStorage = createKvStorage;
globalThis.createLocalStorageKv = createLocalStorageKv;
})();
