(function () {
/**
 * Host provider registry: which seams this page talks to, and why.
 *
 * The desktop shell loads a fixed origin (the bundled page) while the data plane lives in a Node
 * sidecar on `127.0.0.1:8787`. That makes "which host am I on" a runtime question, answered here once
 * and shared as runtime services instead of being re-derived by every module:
 *   · `transport` (core/ports) — the request exit. Business code will inject it; until T4-A rewires
 *     the hand-rolled fetch sites, `tooling/l0/wiring/host.js` also installs a URL router so the existing
 *     relative `/api/*`, `/sync*` and `/img/*` calls reach the host without touching those call sites.
 *   · `key` (core/ports) — read-only token access. The access token lives in localStorage today
 *     (`services/auth/token.ts`); this port reads through a closure so the value is never copied.
 *   · `db` — selected through the DbPort facade (`dbSvc.use`). It is provided once by the facade as a
 *     forwarding bridge, which is exactly what keeps `ctx.get("db")` valid across host switches; a
 *     second `provide("db", …)` here would throw in the kernel, so the registry drives selection
 *     instead of re-registering the service.
 *
 * `/api/runtime` (T4-C) only refines the profile label. Missing endpoint is not an error: the desktop
 * infers `desktop` from a healthy `/config.js`, and everything else falls back to D1 defaults with a
 * reason recorded — this batch must not depend on a file another batch owns.
 *
 * Boundary: no DOM types, no storage reads, no shell globals. The wiring supplies the shell probe,
 * the base, the fetch and the token reader, so every decision here runs in a Node test unchanged.
 * @module services/platform/host
 */

                                                                                                       

/** The subset of `fetch` this module needs; a real `fetch` is structurally assignable. */
                                    
                       
                          
                          
 

                                
                           
                                                      
                         
                             
 

                            
                                                                  
 

/** Parsed `/api/runtime` answer. `profile` is the only field the decision needs. */
                              
                           
                                           
                                                    
 

/** One seam as the status panel/explain() reports it. */
                           
                        
                             
                      
                          
 

/** Everything `hostSvc.status()` answers. */
                             
                          
                           
                        
                      
                             
                                             
                                                                                                   
                                      
                          
                             
 

/** The minimal DbPort facade surface the registry drives (services/platform/db.ts). */
                                 
                                                
                    
 

/** The minimal runtime-context surface (core/runtime.ts). */
                              
                                              
                             
 

                                      
                                
                              
                                                              
                          
                                                                        
                         
                                 
                                                                                    
                                
                                                                                             
                               
                              
                                              
                              
 

                               
                
                                                                                              
                                      
                       
                                                                          
                                 
                                                                                        
                                             
                                                                           
                             
                                                          
                             
                                                                 
                    
                                                                                     
                           
 

/** What the decision step returns; `reason` is user-explainable. */
                               
                           
                      
                                             
                        
                                             
                                 
                          
 

/** Inputs to the pure decision; every field is already observed, nothing is probed here. */
                                    
                          
                        
                                             
                                       
 

/** Default sidecar origin. Explicit rather than "same as the page": the page is an app protocol. */
const DEFAULT_HOST_BASE = "http://127.0.0.1:8787";
/** Token storage key; mirrors services/auth/token.ts (single read path stays there). */
const ACCESS_TOKEN_ID = "access";

/** Object view without an assertion. */
function isRecord(value         )                                   {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errText(e         )         {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Strip trailing slashes; refuse a non-absolute value so a typo cannot become a page-relative path. */
function normalizeBase(raw         )         {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) return "";
  return value.replace(/\/+$/, "");
}

/** Paths that belong to the host's data plane; everything else stays on the page origin. */
function isApiPath(pathname        )          {
  if (pathname === "/sync" || pathname.indexOf("/sync/") === 0) return true;
  return pathname.indexOf("/api/") === 0 || pathname.indexOf("/img/") === 0;
}

/**
 * Route one request URL to the host. Pure and total: anything unrecognised is returned unchanged, so
 * a wrong base can break the API but can never rewrite a CDN URL or a data: URI.
 */
function routeUrl(raw        , base        , pageOrigin         )         {
  const value = typeof raw === "string" ? raw : "";
  const root = normalizeBase(base);
  if (!value || !root) return value;
  if (/^(data|blob|javascript|mailto|tel):/i.test(value)) return value;
  const page = typeof pageOrigin === "string" ? pageOrigin.replace(/\/+$/, "") : "";

  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(value) || value.indexOf("//") === 0;
  if (!absolute) {
    // Relative path: the app only ever calls API paths this way.
    const cut = value.indexOf("?");
    const path = cut >= 0 ? value.slice(0, cut) : value;
    const rest = cut >= 0 ? value.slice(cut) : "";
    if (!isApiPath(path)) return value;
    return root + path + rest;
  }
  let parsed     ;
  try {
    parsed = new URL(value);
  } catch (e) {
    return value;
  }
  // Same-origin absolute URLs are the page's own API calls; third-party URLs keep their origin.
  if (!page || parsed.origin !== page) return value;
  if (!isApiPath(parsed.pathname)) return value;
  return root + parsed.pathname + parsed.search + parsed.hash;
}

/** Parse `/api/runtime`. Returns null for a missing or malformed body instead of guessing. */
function parseRuntime(payload         )                     {
  if (!isRecord(payload)) return null;
  const profile = typeof payload.profile === "string" ? payload.profile.trim() : "";
  if (!profile) return null;
  const capabilities           = [];
  if (Array.isArray(payload.capabilities)) {
    for (const item of payload.capabilities) if (typeof item === "string" && item) capabilities.push(item);
  }
  const limits                         = {};
  if (isRecord(payload.limits)) {
    for (const key of Object.keys(payload.limits)) {
      const v = payload.limits[key];
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") limits[key] = String(v);
    }
  }
  return { profile: profile, capabilities: capabilities, limits: limits };
}

/**
 * The host decision. Desktop: the sidecar is the host whenever `/config.js` answers; `/api/runtime`
 * only renames the profile. Web: always D1 (same origin), profile from the manifest when present.
 */
function decideHost(input                   )               {
  const base = normalizeBase(input.base);
  const profile = input.runtime !== null ? input.runtime.profile : "";
  const runtimeFound = input.runtime !== null;
  if (!input.shell) {
    return {
      profile: profile || "guest",
      db: "d1",
      transport: "same-origin",
      base: "",
      health: input.health,
      runtimeFound: runtimeFound,
      reason: runtimeFound
        ? "web: /api/runtime profile " + profile
        : "web: no /api/runtime (T4-C) — D1 defaults, profile guest",
    };
  }
  if (input.health === "ok") {
    return {
      profile: profile || "desktop",
      db: "node",
      transport: "http",
      base: base || DEFAULT_HOST_BASE,
      health: "ok",
      runtimeFound: runtimeFound,
      reason: runtimeFound
        ? "desktop: /api/runtime says " + profile + "; sidecar healthy"
        : "desktop: /api/runtime missing (T4-C) — inferred from a healthy /config.js",
    };
  }
  return {
    profile: profile || "desktop",
    db: "d1",
    transport: "http",
    base: base || DEFAULT_HOST_BASE,
    health: input.health === "down" ? "down" : "unknown",
    runtimeFound: runtimeFound,
    reason:
      "desktop: host " + (input.health === "down" ? "unreachable" : "not probed yet") +
      " — D1 fallback until it answers (first-run step explains how to start it)",
  };
}

/** Race a promise against a timeout; the host must never hang a boot path. */
function withTimeout   (work            , ms        , label        )             {
  if (ms <= 0) return work;
  return new Promise   ((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + " timed out after " + String(ms) + "ms")), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** `/config.js` answering with the OwnChat marker is the readiness contract (same as the old probe). */
async function probeHealth(fetchImpl           , base        , timeoutMs        )                         {
  const root = normalizeBase(base);
  if (!root) return "down";
  try {
    const res = await withTimeout(
      Promise.resolve(fetchImpl(root + "/config.js", { method: "GET", redirect: "manual" })),
      timeoutMs,
      "/config.js",
    );
    if (!res.ok) return "down";
    const body = await withTimeout(Promise.resolve(res.text()), timeoutMs, "/config.js body");
    return body.indexOf("APP_CTX_EXACT") >= 0 ? "ok" : "down";
  } catch (e) {
    return "down";
  }
}

/** Probe `/api/runtime`; a 404 is the expected state until T4-C lands, not a failure. */
async function probeRuntime(
  fetchImpl           ,
  base        ,
  timeoutMs        ,
)                                                        {
  const root = normalizeBase(base);
  // "" means the page origin: the web build asks its own deployment, the shell always has a base.
  const url = (root || "") + "/api/runtime";
  try {
    const res = await withTimeout(
      Promise.resolve(fetchImpl(url, { method: "GET", redirect: "manual" })),
      timeoutMs,
      "/api/runtime",
    );
    if (res.status === 404) return { info: null, reason: "endpoint missing (T4-C not merged)" };
    if (!res.ok) return { info: null, reason: "HTTP " + String(res.status) };
    const text = await withTimeout(Promise.resolve(res.text()), timeoutMs, "/api/runtime body");
    let parsed          = null;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return { info: null, reason: "malformed JSON" };
    }
    const info = parseRuntime(parsed);
    return info === null ? { info: null, reason: "missing profile field" } : { info: info, reason: "ok" };
  } catch (e) {
    // Unreachable, timed out or CORS-blocked all mean the same thing: no manifest at this origin.
    return { info: null, reason: errText(e) };
  }
}

/** Build the registry. The returned `ready` never rejects for host-side failures. */
function createHostRegistry(options                     )               {
  if (!options || !options.context || !options.db) throw new Error("host: context and db are required");
  const fetchImpl            = typeof options.fetchImpl === "function" ? options.fetchImpl : ()                             => Promise.reject(new Error("host: fetch is unavailable"));
  const token = typeof options.token === "function" ? options.token : () => "";
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : 2500;
  const pageOrigin = typeof options.pageOrigin === "string" ? options.pageOrigin : "";
  let base = normalizeBase(options.base) || (options.shell ? DEFAULT_HOST_BASE : "");
  let health                            = "unknown";
  let decision = decideHost({ shell: options.shell, base: base, health: health, runtime: null });
  let runtimeReason = "not probed yet";
  let applied = { name: "", base: "", token: "" };
  let updatedAt = now();
  let transportProvided = "";
  let keyProvided = "";

  /** The HTTP transport seam. Token read per request: a sign-in must not rebuild the port. */
  const transportPort                = {
    async send(req                  )                             {
      const url = routeUrl(req.url, base, pageOrigin);
      const headers                         = {};
      if (req.headers) for (const k of Object.keys(req.headers)) headers[k] = String(req.headers[k]);
      const authToken = token();
      if (authToken && isApiPath(new URL(url, pageOrigin || "http://localhost").pathname) && !headers["authorization"]) {
        headers["authorization"] = "Bearer " + authToken;
      }
      const res = await fetchImpl(url, { method: req.method || "GET", headers: headers, body: req.body });
      return { ok: res.ok, status: res.status, text: () => res.text() };
    },
  };

  /** Read-only secret view. Only the access token is backed today; unknown ids answer "". */
  function readSecret(id        )         {
    return id === ACCESS_TOKEN_ID ? token() : "";
  }
  const secretPort             = {
    get: readSecret,
    has: (id        ) => readSecret(id) !== "",
  };

  /** Provide each seam once (the kernel refuses duplicates), and record who provided it. */
  function provideSeams(dec              )       {
    if (dec.transport === "http" && !transportProvided) {
      if (options.context.has("transport")) {
        transportProvided = "pre-existing";
      } else {
        options.context.provide("transport", transportPort);
        transportProvided = "host(desktop)";
      }
    }
    if (dec.transport === "http" && !keyProvided) {
      if (options.context.has("key")) {
        keyProvided = "pre-existing";
      } else {
        options.context.provide("key", secretPort);
        keyProvided = "host(desktop)";
      }
    }
  }

  /** Select the DbPort adapter; re-selecting is how a base/token change takes effect. */
  function selectDb(dec              )       {
    const tokenNow = dec.db === "node" ? token() : "";
    if (applied.name === dec.db && applied.base === dec.base && applied.token === tokenNow) return;
    const adapterOptions = dec.db === "node" ? { base: dec.base, token: tokenNow } : undefined;
    try {
      options.db.use(dec.db, adapterOptions);
      applied = { name: dec.db, base: dec.base, token: tokenNow };
    } catch (e) {
      // A missing adapter is a deployment error, not a reason to keep booting silently: fall back to
      // d1 once and record why (the explain view names it).
      runtimeReason = "adapter " + dec.db + " unavailable (" + errText(e) + "); using d1";
      decision = {
        profile: dec.profile,
        db: "d1",
        transport: dec.transport,
        base: dec.base,
        health: dec.health,
        runtimeFound: dec.runtimeFound,
        reason: runtimeReason,
      };
      if (applied.name !== "d1") {
        options.db.use("d1", undefined);
        applied = { name: "d1", base: "", token: "" };
      }
    }
  }

  function status()             {
    const adapter = options.db.adapter() || decision.db;
    const seams             = [
      {
        name: "transport",
        provided: transportProvided !== "",
        by: transportProvided || "none",
        reason:
          transportProvided !== ""
            ? "requests leave through " + (decision.transport === "http" ? decision.base : "the page origin")
            : "web host: business code keeps its same-origin fetch until T4-A injects transport",
      },
      {
        name: "key",
        provided: keyProvided !== "",
        by: keyProvided || "none",
        reason:
          keyProvided !== ""
            ? "read-only view of the access token (localStorage-owned)"
            : "web host: no token seam needed (same-origin /api carries it)",
      },
      {
        name: "db",
        provided: true,
        by: "dbSvc facade",
        reason: "selected adapter: " + adapter + " (forwarding bridge keeps ctx.get('db') stable)",
      },
    ];
    return {
      shell: options.shell,
      profile: decision.profile,
      base: decision.base,
      db: adapter,
      transport: decision.transport,
      health: health,
      runtime: { found: decision.runtimeFound, profile: decision.runtimeFound ? decision.profile : "", reason: runtimeReason },
      seams: seams,
      reason: decision.reason,
      updatedAt: updatedAt,
    };
  }

  async function refresh()                      {
    const nextBase = normalizeBase(base) || (options.shell ? DEFAULT_HOST_BASE : "");
    base = nextBase;
    let runtime                     = null;
    if (options.shell) {
      const probe = await probeHealth(fetchImpl, base, timeoutMs);
      health = probe;
      if (probe === "ok") {
        const rt = await probeRuntime(fetchImpl, base, timeoutMs);
        runtime = rt.info;
        runtimeReason = rt.reason;
      } else {
        runtimeReason = "host did not answer /config.js";
      }
    } else {
      health = "unknown";
      const rt = await probeRuntime(fetchImpl, "", timeoutMs);
      runtime = rt.info;
      runtimeReason = rt.reason;
    }
    decision = decideHost({ shell: options.shell, base: base, health: health, runtime: runtime });
    provideSeams(decision);
    selectDb(decision);
    updatedAt = now();
    return status();
  }

  const ready = refresh().catch((e) => {
    // A probe bug must surface as an explainable degraded state, never as a boot rejection.
    runtimeReason = "probe failed: " + errText(e);
    decision = decideHost({ shell: options.shell, base: base, health: "down", runtime: null });
    provideSeams(decision);
    selectDb(decision);
    updatedAt = now();
    return status();
  });

  // Boot-time provisional selection, synchronously: shell → d1 relative (the router already points at
  // the sidecar, so early calls still work) until /config.js answers; web → d1 as always. Doing it here
  // rather than waiting for `ready` also keeps the facade from picking `tauri` in the meantime, so the
  // desktop's adapter is node/d1 by construction, not by race.
  provideSeams(decision);
  selectDb(decision);

  return {
    v: 1,
    ready: ready,
    status: status,
    refresh: refresh,
    setBase: (next        ) => {
      base = normalizeBase(next) || (options.shell ? DEFAULT_HOST_BASE : "");
      updatedAt = now();
      return refresh();
    },
    route: (url        ) => routeUrl(url, base, pageOrigin),
    transport: () => transportPort,
    key: () => secretPort,
    decision: () => decision,
  };
}

// Browser wiring, appended by tooling/l0/emit.mjs. Engine: services/platform/host.ts (the host provider
// registry: transport/key seams through the runtime context, the db adapter through the DbPort facade).
//
// Public API: window.hostSvc = { v, ready, status, explain, refresh, setBase, route, transport, key,
// decision, base, rawFetch, dispose }. Non-`__` name: this is a port, not a frozen contract.
//
// Why this file also installs a fetch router: the shell loads the bundled page (tauri origin) while
// the data plane is the sidecar. Until T4-A replaces every hand-rolled fetch with the transport seam,
// the router is what makes relative `/api/*`, `/sync*`, `/img/*` calls reach the host. It is installed
// HERE, before services/auth/token.js, so auth's wrapper sends the token to the rewritten URL and no
// other wrapper has to know about hosts. `rawFetch` (captured before the router) is the escape hatch
// for probes and password checks, which must not inherit a stale Authorization header.
(function (g) {
  "use strict";
  if (g.hostSvc) return;

  var ACCESS_KEY = "cfw_auth_token_v1";
  var shell = false;
  try {
    shell = !!(g.tauriSvc && typeof g.tauriSvc.available === "function" && g.tauriSvc.available());
  } catch (e) {
    shell = false;
  }

  // authSvc loads after this file; the arithmetic value is the same key it owns, so a boot-time read
  // is correct and a live read prefers the facade.
  function currentToken() {
    try {
      if (g.authSvc && typeof g.authSvc.getToken === "function") return String(g.authSvc.getToken() || "");
    } catch (e) {
      // fall through to the stored value
    }
    try {
      return String(g.localStorage.getItem(ACCESS_KEY) || "");
    } catch (e) {
      return "";
    }
  }

  var rawFetch = typeof g.fetch === "function" ? g.fetch.bind(g) : null;
  var pageOrigin = "";
  try {
    pageOrigin = String(g.location && g.location.origin ? g.location.origin : "");
  } catch (e) {
    pageOrigin = "";
  }

  if (!g.dbSvc) return; // the DbPort facade owns the root context; without it nothing to register into
  var context = g.dbSvc.context;

  var host = createHostRegistry({
    context: context,
    db: g.dbSvc,
    shell: shell,
    base: shell ? "http://127.0.0.1:8787" : "",
    fetchImpl: rawFetch,
    token: currentToken,
    pageOrigin: pageOrigin,
    timeoutMs: 2500,
  });

  // ── boot gate ──────────────────────────────────────────────────────────────
  // The shell starts the sidecar in a background thread at the same moment the window loads; the page
  // can reach its first /api call before the host listens. Failing those requests would look like an
  // empty database, so API calls wait for the host to answer /config.js once (12 × 400ms cap). After
  // the cap the gate opens anyway: a dead host must degrade, not hang.
  var hostGate = (function () {
    var settle = function () {};
    var gate = new Promise(function (resolve) {
      settle = resolve;
    });
    var attempts = 0;
    function tick() {
      if (host.status().health === "ok" || attempts >= 12) {
        settle(host.status());
        return;
      }
      attempts++;
      setTimeout(function () {
        host.refresh().then(tick, tick);
      }, 400);
    }
    host.ready.then(
      function (status) {
        if (status.health === "ok") settle(status);
        else tick();
      },
      function () {
        settle(null);
      },
    );
    return gate;
  })();
  function gated(fn) {
    if (host.status().health === "ok") return fn();
    return hostGate.then(fn, fn);
  }

  // ── fetch router ────────────────────────────────────────────────────────────
  var restoreFetch = null;
  if (shell && rawFetch) {
    var router = function (input, init) {
      try {
        if (typeof input === "string") {
          var target = host.route(input);
          if (target !== input) return gated(function () { return rawFetch(target, init); });
        } else if (typeof URL === "function" && input instanceof URL) {
          var href = host.route(input.href);
          if (href !== input.href) return gated(function () { return rawFetch(href, init); });
        } else if (input && typeof input === "object" && typeof input.url === "string") {
          var rewritten = host.route(input.url);
          if (rewritten !== input.url) {
            return gated(function () {
              if (typeof Request === "function") return rawFetch(new Request(rewritten, input), init);
              return rawFetch(rewritten, init);
            });
          }
        }
      } catch (e) {
        // A router bug must never break fetch: fall through to the untouched call.
      }
      return rawFetch(input, init);
    };
    g.fetch = router;
    restoreFetch = function () {
      restoreFetch = null;
      g.fetch = rawFetch;
    };
  }

  // ── host base: stored value first, default second ───────────────────────────
  var baseReady = Promise.resolve("");
  if (shell && g.tauriSvc && typeof g.tauriSvc.invoke === "function") {
    baseReady = g.tauriSvc.invoke("get_server_url").then(
      function (saved) {
        return typeof saved === "string" && saved.trim() ? saved.trim() : "";
      },
      function () {
        return "";
      },
    );
  }
  baseReady.then(function (saved) {
    if (saved) return host.setBase(saved);
    return host.refresh();
  }).then(
    function (status) {
      try {
        g.dispatchEvent(new CustomEvent("ownchat:host-ready", { detail: status }));
      } catch (e) {}
    },
    function () {},
  );

  // Shell events: the tray's host wizard entry and a saved base.
  var unlisten = [];
  if (shell && g.tauriSvc && typeof g.tauriSvc.listen === "function") {
    try {
      var a = g.tauriSvc.listen("ownchat:host-settings", function () {
        try {
          g.dispatchEvent(new CustomEvent("ownchat:host-settings"));
        } catch (e) {}
      });
      if (a) unlisten.push(a);
      var b = g.tauriSvc.listen("ownchat:host-changed", function (event) {
        var payload = event && event.payload ? event.payload : {};
        var url = typeof payload.url === "string" ? payload.url : "";
        host.setBase(url).then(
          function () {
            try {
              g.dispatchEvent(new CustomEvent("ownchat:host-changed"));
            } catch (e) {}
          },
          function () {},
        );
      });
      if (b) unlisten.push(b);
    } catch (e) {
      // No event bridge (older shell): the wizard still works through invoke/get_server_url.
    }
  }

  g.hostSvc = {
    v: 1,
    ready: host.ready,
    status: function () {
      return host.status();
    },
    explain: function () {
      var s = host.status();
      return {
        profile: s.profile,
        base: s.base,
        health: s.health,
        db: s.db,
        runtime: s.runtime,
        seams: s.seams.map(function (seam) {
          return seam.name + ": " + (seam.provided ? seam.by : "not provided") + " — " + seam.reason;
        }),
        reason: s.reason,
      };
    },
    refresh: function () {
      return host.refresh();
    },
    setBase: function (url) {
      return host.setBase(url);
    },
    route: function (url) {
      return host.route(url);
    },
    transport: function () {
      return host.transport();
    },
    key: function () {
      return host.key();
    },
    decision: function () {
      return host.decision();
    },
    base: function () {
      return host.status().base;
    },
    // The pre-router fetch: no Authorization is added by anyone, no URL is rewritten.
    rawFetch: function (input, init) {
      if (!rawFetch) return Promise.reject(new Error("hostSvc.rawFetch: fetch is unavailable"));
      return rawFetch(input, init);
    },
    dispose: function () {
      for (var i = 0; i < unlisten.length; i++) {
        try {
          Promise.resolve(unlisten[i]).then(function (fn) {
            if (typeof fn === "function") fn();
          }, function () {});
        } catch (e) {}
      }
      unlisten.length = 0;
      if (restoreFetch) restoreFetch();
      routed = false;
    },
  };
})(window);

globalThis.DEFAULT_HOST_BASE = DEFAULT_HOST_BASE;
globalThis.ACCESS_TOKEN_ID = ACCESS_TOKEN_ID;
globalThis.normalizeBase = normalizeBase;
globalThis.routeUrl = routeUrl;
globalThis.parseRuntime = parseRuntime;
globalThis.decideHost = decideHost;
globalThis.probeHealth = probeHealth;
globalThis.probeRuntime = probeRuntime;
globalThis.createHostRegistry = createHostRegistry;
})();
