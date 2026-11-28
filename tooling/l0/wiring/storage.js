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
