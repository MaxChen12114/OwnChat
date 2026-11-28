(function () {
/**
 * Browser-safe runtime kernel: the subset of Cordis semantics this repo actually needs.
 *
 * Three ideas, no framework:
 *   · services — provide/get by name, child scopes may shadow, same-scope duplicates fail loud;
 *   · inject — declarative dependencies; missing deps are PENDING with an explainable reason,
 *     activation happens when the graph is ready and re-runs when a provider appears;
 *   · effects — every side effect returns its inverse; dispose unwinds LIFO, scoped per fork.
 *
 * Deliberately not included: Node's loader, HMR, config patches, React slots, or a plugin
 * marketplace. `tooling/l0/scripts.json` remains the boot-order source; this kernel only gives runtime
 * objects a lifecycle once their code is loaded.
 *
 * P0 is kernel-only: nothing wires it into the app yet. That is what makes the semantics testable
 * without touching the frozen `window.__*` surface.
 * @module core/runtime
 */

/** Undo one side effect. Returning it from `effect`/`apply` is mandatory for managed effects. */
                                  

/** Lifecycle state shared by injectors and plugins. */
                                                                        

/** A plugin module in the small subset: optional name/inject plus an apply body. */
                               
                         
                                                                                     
                                      
                                                                
                                                                             
 

/** Handle for an `inject` registration. Getters stay live after activation/disposal. */
                               
                      
                                 
                                      
                          
                  
 

/** Handle for a mounted plugin; `dispose` tears down the plugin's child scope. */
                               
                      
                                 
                                      
                          
                  
 

/** What `explain()` returns; enough for a status panel without reading internals. */
                                
                      
                                 
                                      
                          
 

                        
                          
                                          
 

                        
                             
                 
 

                          
                      
                                   
                                                              
                      
                        
                             
                 
                     
                            
                    
 

                        
                      
                               
                        
                 
                            
                                  
                    
 

/** Thenable without trusting a property access: used for async service readiness. */
function isThenable(value         )                                {
  if (value === null) return false;
  if (typeof value !== "object" && typeof value !== "function") return false;
  try {
    return typeof Reflect.get(value, "then") === "function";
  } catch (e) {
    return false;
  }
}

/** Read a service's `ready` promise, if any, without casting the service object. */
function readyOf(value         )                          {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return null;
  try {
    const ready = Reflect.get(value, "ready");
    return isThenable(ready) ? Promise.resolve(ready) : null;
  } catch (e) {
    return null;
  }
}

/** The context object. One class, no prototypes tricks; every scope is an instance. */
class RuntimeContext {
                   parent                       ;
                   services                           ;
                   children                  ;
                   effects                ;
                   injectors                  ;
                   plugins                ;
                   disposeHooks            ;
          disposed         ;
          serial        ;

  constructor(parent                        = null) {
    this.parent = parent;
    this.services = new Map();
    this.children = [];
    this.effects = [];
    this.injectors = [];
    this.plugins = [];
    this.disposeHooks = [];
    this.disposed = false;
    this.serial = 0;
  }

  /** Register a service. Same-scope duplicates throw; child scopes may shadow the parent. */
  provide(name        , value         )       {
    if (this.disposed) throw new Error("runtime: cannot provide on a disposed context");
    if (this.services.has(name)) throw new Error("runtime: service already provided: " + name);
    this.services.set(name, { value: value, ready: readyOf(value) });
    this.notify(name);
  }

  /** Read a service; missing returns undefined (PENDING is the injector's business, not a throw). */
  get(name        )          {
    const entry = this.lookup(name);
    return entry === null ? undefined : entry.value;
  }

  has(name        )          {
    return this.lookup(name) !== null;
  }

          lookup(name        )                      {
    const own = this.services.get(name);
    if (own !== undefined) return own;
    return this.parent === null ? null : this.parent.lookup(name);
  }

  /** Declare a dependency gate. The callback runs when every dep is present and its `ready` settles. */
  inject(deps                   , activate                                          , id         )               {
    if (this.disposed) throw new Error("runtime: cannot inject on a disposed context");
    const record                 = {
      id: id || "inject-" + ++this.serial,
      deps: deps.slice(),
      activate: activate,
      ctx: this,
      status: "pending",
      missing: deps.slice(),
      error: null,
      generation: 0,
      disposer: null,
      disposed: false,
    };
    this.injectors.push(record);
    this.evaluate(record);
    return this.handleFor(record);
  }

  /** Register a reversible effect. The callback MUST return its inverse. */
  effect(fn                )           {
    if (this.disposed) throw new Error("runtime: cannot add an effect on a disposed context");
    const inverse = fn();
    if (typeof inverse !== "function") {
      throw new Error("runtime: effect must return a disposer");
    }
    return this.addInverse(inverse);
  }

  /** Store an already-built inverse; used by effect() and by plugin apply results. */
          addInverse(inverse          )           {
    const record               = { inverse: inverse, spent: false };
    this.effects.push(record);
    return () => this.spendEffect(record);
  }

  /** Mount a plugin in a child scope; `inject` is a hard gate, apply errors are captured. */
  plugin(mod              , config          )               {
    if (this.disposed) throw new Error("runtime: cannot mount a plugin on a disposed context");
    const id = typeof mod.name === "string" && mod.name ? mod.name : "plugin-" + ++this.serial;
    const child = this.fork();
    const record               = {
      id: id,
      ctx: child,
      status: "pending",
      error: null,
      disposer: null,
      injector: null,
      disposed: false,
    };
    this.plugins.push(record);
    const run = ()       => {
      if (record.disposed) return;
      try {
        const result = mod.apply(child, config);
        if (typeof result === "function") child.addInverse(result);
        record.status = "active";
      } catch (e) {
        record.status = "error";
        record.error = e;
      }
    };
    if (mod.inject !== undefined && mod.inject.length > 0) {
      const injector = child.inject(mod.inject, run, id + ":inject");
      record.injector = this.injectorOf(child, injector.id);
    } else {
      run();
    }
    return this.pluginHandleFor(record);
  }

  /** A child scope: inherits services, isolates provides/effects/injectors, disposed first. */
  fork()                 {
    if (this.disposed) throw new Error("runtime: cannot fork a disposed context");
    const child = new RuntimeContext(this);
    this.children.push(child);
    return child;
  }

  /** Register a disposal hook (LIFO with effects). */
  on(event           , fn          )           {
    if (event !== "dispose") throw new Error("runtime: unknown event " + String(event));
    if (this.disposed) throw new Error("runtime: cannot listen on a disposed context");
    this.disposeHooks.push(fn);
    return () => {
      const i = this.disposeHooks.indexOf(fn);
      if (i >= 0) this.disposeHooks.splice(i, 1);
    };
  }

  /** Tear down this scope: children, injectors, effects, hooks, services — LIFO and idempotent. */
  dispose()       {
    if (this.disposed) return;
    this.disposed = true;
    for (let i = this.plugins.length - 1; i >= 0; i--) {
      const record = this.plugins[i];
      if (record.disposed) continue;
      record.disposed = true;
      record.status = "disposed";
    }
    for (let i = this.children.length - 1; i >= 0; i--) this.children[i].dispose();
    for (let i = this.injectors.length - 1; i >= 0; i--) {
      const record = this.injectors[i];
      record.disposed = true;
      record.generation++;
      this.deactivate(record);
      record.status = "disposed";
    }
    for (let i = this.effects.length - 1; i >= 0; i--) this.spendEffect(this.effects[i]);
    for (let i = this.disposeHooks.length - 1; i >= 0; i--) this.runHook(this.disposeHooks[i]);
    this.injectors.length = 0;
    this.effects.length = 0;
    this.disposeHooks.length = 0;
    this.services.clear();
  }

  /** Explain one injector/plugin by id (searches this scope and descendants). */
  explain(id        )                       {
    const own = this.findRecord(id);
    if (own !== null) return own;
    for (const child of this.children) {
      const found = child.explain(id);
      if (found !== null) return found;
    }
    return null;
  }

          findRecord(id        )                       {
    for (const record of this.injectors) {
      if (record.id === id) {
        return { id: record.id, status: record.status, missing: record.missing.slice(), error: record.error };
      }
    }
    for (const record of this.plugins) {
      if (record.id !== id) continue;
      const missing = record.injector === null ? [] : record.injector.missing.slice();
      return { id: record.id, status: record.status, missing: missing, error: record.error };
    }
    return null;
  }

          injectorOf(ctx                , id        )                        {
    for (const record of ctx.injectors) if (record.id === id) return record;
    return null;
  }

          evaluate(record                )       {
    if (record.disposed || this.disposed) return;
    const missing = record.deps.filter((name) => !this.has(name));
    record.missing = missing;
    const generation = ++record.generation;
    if (missing.length > 0) {
      this.deactivate(record);
      record.status = "pending";
      return;
    }
    const entries = record.deps.map((name) => this.lookup(name));
    const waits                     = [];
    for (const entry of entries) {
      if (entry === null) return;
      if (entry.ready !== null) waits.push(entry.ready);
    }
    const run = ()       => {
      if (record.disposed || this.disposed || record.generation !== generation) return;
      try {
        const result = record.activate(record.ctx);
        record.disposer = typeof result === "function" ? result : null;
        record.status = "active";
        record.error = null;
      } catch (e) {
        record.status = "error";
        record.error = e;
      }
    };
    if (waits.length === 0) {
      this.deactivate(record);
      run();
      return;
    }
    Promise.all(waits).then(run, (e) => {
      if (record.generation !== generation || record.disposed) return;
      record.status = "error";
      record.error = e;
    });
  }

          deactivate(record                )       {
    if (record.disposer !== null) {
      const inverse = record.disposer;
      record.disposer = null;
      try { inverse(); } catch (e) { /* an inverse failure must not block the rest of teardown */ }
    }
    if (record.status === "active" || record.status === "error") record.status = "pending";
  }

          notify(name        )       {
    for (const record of this.injectors.slice()) {
      if (record.deps.includes(name)) this.evaluate(record);
    }
    for (const child of this.children.slice()) child.notify(name);
  }

          spendEffect(record              )       {
    if (record.spent) return;
    record.spent = true;
    try { record.inverse(); } catch (e) { /* every inverse gets its turn; one failure is isolated */ }
  }

          runHook(fn          )       {
    try { fn(); } catch (e) { /* dispose hooks are best-effort cleanup */ }
  }

          handleFor(record                )               {
    return {
      get id() { return record.id; },
      get status() { return record.status; },
      get missing() { return record.missing.slice(); },
      get error() { return record.error; },
      dispose: () => {
        if (record.disposed) return;
        record.disposed = true;
        record.generation++;
        this.deactivate(record);
        record.status = "disposed";
        const i = this.injectors.indexOf(record);
        if (i >= 0) this.injectors.splice(i, 1);
      },
    };
  }

          pluginHandleFor(record              )               {
    return {
      get id() { return record.id; },
      get status() { return record.status; },
      get missing() {
        const injector = record.injector;
        return injector === null ? [] : injector.missing.slice();
      },
      get error() { return record.error; },
      dispose: () => {
        if (record.disposed) return;
        record.disposed = true;
        record.ctx.dispose();
        record.status = "disposed";
        const i = this.plugins.indexOf(record);
        if (i >= 0) this.plugins.splice(i, 1);
      },
    };
  }
}

/** Create a root context. `parent` is only for internal forks; exposed for tests. */
function createContext(parent                        = null)                 {
  return new RuntimeContext(parent);
}

// Browser wiring, appended by tooling/l0/emit.mjs. Engine: core/runtime.ts (the Cordis subset: provide / get /
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

globalThis.RuntimeContext = RuntimeContext;
globalThis.createContext = createContext;
})();
