// Browser wiring, appended by l0/emit.mjs. Engine: core/runtime.ts (the Cordis subset: provide / get /
// inject / effect / fork).
//
// Public API: window.runtimeCore = { v, createContext, RuntimeContext, host }. The kernel used to be
// P0-only (tests as its sole consumer); the DbPort facade is its first boot consumer, so the artifact
// is now on the boot manifest. T4-A mounts its plugins on `dbSvc.context`, which is a context from
// here — publishing the constructor too keeps that code independent of this file's wiring.
//
// The host is deliberately thin: it owns the plugin *registry* (define / start / unmount / status),
// not the plugins. Each leaf wiring declares its module and the host decides whether the dependency
// graph lets it apply. Two consequences worth knowing:
//   · PENDING is visible, never silent. A plugin whose `inject` names are missing stays pending and
//     `status()` reports the missing names; the status panel renders that list.
//   · `unmount(name, reason)` is the only teardown entry, so "why did it go away" is recorded.
//     That record is what the status panel shows as the last dispose reason.
//
// Browser defaults for `transport` and `key` live here because this file is the browser host: both
// are port shapes from core/ports.ts whose only job is to wrap the page's own fetch/token stores.
// A different host (Tauri, sidecar) replaces the providers on its own root; `ensureDefaults` never
// overwrites an existing service.
(function (g) {
  "use strict";
  if (g.runtimeCore) return;

  var records = {};
  var disposeLog = [];
  var MAX_DISPOSE_LOG = 10;
  var standalone = null;

  function now() {
    return Date.now();
  }

  function root() {
    try {
      var svc = g.dbSvc;
      return svc && svc.context ? svc.context : null;
    } catch (e) {
      return null;
    }
  }

  /** TransportPort over the page's fetch: headers/body pass through, only status+text are promised. */
  function defaultTransport() {
    return {
      v: 1,
      send: function (req) {
        var r = req || {};
        var init = { method: r.method || "GET" };
        if (r.headers) init.headers = r.headers;
        if (r.body !== undefined) init.body = r.body;
        return g.fetch(String(r.url), init).then(function (res) {
          return {
            ok: !!res.ok,
            status: res.status,
            text: function () { return res.text(); },
          };
        });
      },
    };
  }

  /**
   * SecretPort over the existing stores. Ids are the port's, not a token format: "auth-token"
   * answers the session bearer, "byo"/"byo-key" the user-configured provider key. An unknown id
   * answers "" — a secret reader must never invent a value.
   */
  function defaultKey() {
    function authToken() {
      try {
        var auth = g.authSvc;
        return auth && typeof auth.getToken === "function" ? String(auth.getToken() || "") : "";
      } catch (e) {
        return "";
      }
    }
    function byoKey() {
      try {
        var byo = g.byoProviderSvc;
        var p = byo && typeof byo.get === "function" ? byo.get() : null;
        return p && p.apiKey ? String(p.apiKey) : "";
      } catch (e) {
        return "";
      }
    }
    function read(id) {
      var key = String(id === undefined || id === null ? "" : id);
      if (key === "auth" || key === "auth-token" || key === "token") return authToken();
      if (key === "byo" || key === "byo-key" || key === "provider") return byoKey();
      return "";
    }
    return {
      v: 1,
      get: read,
      has: function (id) {
        return read(id) !== "";
      },
    };
  }

  /**
   * The context plugins mount on. Normally `dbSvc.context`; a page whose storage facade failed to
   * load gets a private root with a loud `db` stub, so the panel/settings surfaces still work and
   * the first real query reports "存储层未加载" instead of the whole UI disappearing.
   */
  function ensureRoot() {
    var ctx = root();
    if (ctx) return ctx;
    if (!standalone) standalone = createContext();
    if (!standalone.has("db")) {
      standalone.provide("db", {
        v: 0,
        exec: function () { return Promise.reject(new Error("db 服务未接线（存储层未加载）")); },
        transaction: function () { return Promise.reject(new Error("db 服务未接线（存储层未加载）")); },
        search: function () { return Promise.reject(new Error("db 服务未接线（存储层未加载）")); },
      });
    }
    return standalone;
  }

  /** Provide the browser port defaults once; an existing provider always wins. */
  function ensureDefaults(ctx) {
    var target = ctx || ensureRoot();
    try {
      if (!target.has("transport")) target.provide("transport", defaultTransport());
    } catch (e) {
      /* a duplicate from a racing caller is not an error */
    }
    try {
      if (!target.has("key")) target.provide("key", defaultKey());
    } catch (e) {
      /* same */
    }
    return target;
  }

  function define(name, mod) {
    if (!name || typeof name !== "string") throw new Error("runtime-host: 插件名不能为空");
    if (!mod || typeof mod.apply !== "function") throw new Error("runtime-host: 插件 " + name + " 缺 apply");
    records[name] = { name: name, mod: mod, handle: null, reason: "", error: null };
    return true;
  }

  function start(name, config) {
    var rec = records[name];
    if (!rec) return null;
    if (rec.handle && (rec.handle.status === "active" || rec.handle.status === "pending")) return rec.handle;
    try {
      var ctx = ensureDefaults(ensureRoot());
      rec.handle = ctx.plugin(rec.mod, config);
      rec.error = null;
    } catch (e) {
      rec.handle = null;
      rec.error = e;
      rec.reason = String((e && e.message) || e);
    }
    return rec.handle;
  }

  function unmount(name, reason) {
    var rec = records[name];
    if (!rec) return false;
    var handle = rec.handle;
    rec.handle = null;
    rec.reason = String(reason === undefined || reason === null ? "manual" : reason);
    disposeLog.unshift({ name: name, reason: rec.reason, at: now() });
    if (disposeLog.length > MAX_DISPOSE_LOG) disposeLog.length = MAX_DISPOSE_LOG;
    if (!handle) return false;
    try { handle.dispose(); } catch (e) { /* the reason record stays; teardown is best-effort */ }
    return true;
  }

  /** Explainable snapshot: every mounted plugin, the pending ones, and the last dispose reason. */
  /**
   * Explainable snapshot: every mounted plugin, the pending ones, and the last dispose reason.
   * Per-plugin state is read through `ctx.explain(name)` — the kernel's own answer — so the status
   * panel and a hand-written debug call can never disagree about why something is PENDING.
   */
  function status() {
    var plugins = [];
    var pending = [];
    var missingSet = {};
    var ctx = root() || standalone;
    var names = Object.keys(records);
    for (var i = 0; i < names.length; i++) {
      var rec = records[names[i]];
      var handle = rec.handle;
      var info = null;
      try { info = ctx && typeof ctx.explain === "function" ? ctx.explain(rec.name) : null; } catch (e) { info = null; }
      var missing = info && info.missing ? info.missing.slice() : (handle && handle.missing ? handle.missing.slice() : []);
      for (var m = 0; m < missing.length; m++) missingSet[missing[m]] = 1;
      var entry = {
        name: rec.name,
        id: handle ? handle.id : rec.name,
        status: info ? info.status : (handle ? handle.status : "unmounted"),
        missing: missing,
        error: info ? info.error : (handle ? handle.error : rec.error),
        reason: rec.reason || "",
      };
      plugins.push(entry);
      if (entry.status === "pending") pending.push(entry);
    }
    var services = [];
    if (ctx && typeof ctx.has === "function") {
      var probes = ["db", "transport", "key"];
      for (var p = 0; p < probes.length; p++) {
        try { if (ctx.has(probes[p])) services.push(probes[p]); } catch (e) { /* disposed root */ }
      }
    }
    return {
      v: 1,
      root: !!root(),
      plugins: plugins,
      pending: pending,
      missingServices: Object.keys(missingSet),
      services: services,
      lastDispose: disposeLog.length ? disposeLog[0] : null,
      disposeLog: disposeLog.slice(),
      defined: names,
    };
  }

  function handleOf(name) {
    var rec = records[name];
    return rec ? rec.handle : null;
  }

  function descriptor(name) {
    var rec = records[name];
    return rec ? rec.mod : null;
  }

  g.runtimeCore = {
    v: 1,
    createContext: createContext,
    RuntimeContext: RuntimeContext,
    host: {
      v: 1,
      define: define,
      start: start,
      unmount: unmount,
      status: status,
      handle: handleOf,
      descriptor: descriptor,
      root: root,
      ensureDefaults: ensureDefaults,
      defaults: { transport: defaultTransport, key: defaultKey },
    },
  };
})(window);
