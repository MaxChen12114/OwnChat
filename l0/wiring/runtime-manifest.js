// Browser wiring for core/runtime-manifest.ts: the web provider set, the `/api/runtime` fetch,
// and the non-`__` facade `window.runtimeManifest`.
//
// Why the fetch waits for DOMContentLoaded: auth.js patches window.fetch to attach the access
// token, and it loads after this file. Fetching at parse time would ask /api/runtime without the
// token and read a guest manifest on an account host. All classic scripts have run by
// DOMContentLoaded, so that is the first moment the answer is trustworthy.
//
// Why the providers are plain objects with `apply`: they are mounted through the runtime kernel's
// `inject`, exactly like a plugin, and each one publishes its port with `ctx.provide`. The kernel
// owns the scope; this file owns the IO. T4-B's native host can register further providers through
// `runtimeManifest.registerProvider()` before boot without editing this file.
//
// Failure posture: an unreachable or 401 manifest applies the local fallback (desktop when the
// shell can invoke, otherwise guest) and records the reason in `manifest().issues`; boot never
// waits for the network. The guest fallback keeps chat on.
(function (g) {
  "use strict";
  if (g.runtimeManifest) return;

  var listeners = [];
  var kernel = null;
  var current = null;
  var booting = null;
  var started = false;

  function nowIssue(issues, text) {
    if (text) issues.push(text);
    return issues;
  }

  function dbAdapter() {
    try {
      if (g.dbSvc) {
        // Select the adapter before reading its name. `adapter()` is empty until the first get(),
        // and an empty name would turn the host key from `origin|unknown` into `origin|d1` once a
        // data-capable profile starts — a false "new host" on the very next boot.
        if (typeof g.dbSvc.get === "function") g.dbSvc.get();
        if (typeof g.dbSvc.adapter === "function") return String(g.dbSvc.adapter() || "");
      }
    } catch (e) {
      // A broken facade must read as "no adapter", not crash the manifest.
    }
    return "";
  }

  function fallbackProfile() {
    try {
      if (g.tauriSvc && typeof g.tauriSvc.available === "function" && g.tauriSvc.available()) return "desktop";
    } catch (e) {
      // No shell is a valid answer.
    }
    return "guest";
  }

  // The secrets adapter reads the same three keys core/capability.ts owns. The mapping lives here
  // because this is the IO boundary; capability.ts stays the one place that says what a token is.
  var SECRET_KEYS = {
    unlock: ["cfw_unlock_token_v1"],
    pcBridge: ["cfw_pc_bridge_token_v1", "cfw_auth_token_v1"],
    localExec: ["cfw_local_exec_token"],
  };

  function readStorage(key) {
    try {
      var value = g.localStorage.getItem(key);
      return value == null ? "" : String(value);
    } catch (e) {
      return "";
    }
  }

  function makeTransportProvider() {
    return {
      name: "transport",
      apply: function (ctx) {
        ctx.provide("transport", {
          send: function (req) {
            var r = req || {};
            var init = {
              method: typeof r.method === "string" && r.method ? r.method : "GET",
              headers: r.headers || {},
              cache: "no-store",
            };
            if (r.body != null) init.body = String(r.body);
            return g.fetch(r.url, init).then(function (res) {
              return {
                ok: !!res.ok,
                status: res.status,
                text: function () { return res.text(); },
              };
            });
          },
        });
      },
    };
  }

  function makeSecretProvider() {
    return {
      name: "secret",
      apply: function (ctx) {
        function readSecret(id) {
          var keys = SECRET_KEYS[id];
          if (!keys) return "";
          for (var i = 0; i < keys.length; i++) {
            var value = readStorage(keys[i]);
            if (value) return value;
          }
          return "";
        }
        ctx.provide("secret", {
          get: readSecret,
          has: function (id) { return !!readSecret(id); },
        });
      },
    };
  }

  function makeStorageProvider() {
    return {
      name: "storage",
      apply: function (ctx) {
        ctx.provide("storage", {
          get: function (key) {
            try { return g.localStorage.getItem(key); } catch (e) { return null; }
          },
          set: function (key, value) {
            try { g.localStorage.setItem(key, String(value)); } catch (e) { /* quota/private mode: hot window only */ }
          },
          remove: function (key) {
            try { g.localStorage.removeItem(key); } catch (e) { /* nothing to undo */ }
          },
        });
      },
    };
  }

  function makeDbProvider() {
    return {
      name: "db",
      apply: function (ctx) {
        var svc = g.dbSvc;
        if (!svc || !svc.context || typeof svc.context.get !== "function") throw new Error("dbSvc 未加载");
        // Select the concrete adapter now (first get()), but hand the stable forwarding port to
        // consumers: switching hosts later must not invalidate a captured reference.
        svc.get();
        var port = svc.context.get("db");
        if (!port) throw new Error("db 服务未提供");
        ctx.provide("db", port);
      },
    };
  }

  function providerList() {
    var list = [makeTransportProvider(), makeSecretProvider(), makeStorageProvider()];
    if (g.dbSvc) list.push(makeDbProvider());
    return list;
  }

  function withSource(manifest, source) {
    return {
      version: 1,
      profile: manifest.profile,
      capabilities: manifest.capabilities,
      limits: manifest.limits,
      source: source,
      issues: manifest.issues,
    };
  }

  function notify(detail) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](detail); } catch (e) { /* one observer must not stop the others */ }
    }
    try {
      if (typeof g.CustomEvent === "function") g.dispatchEvent(new g.CustomEvent("runtime-manifest", { detail: detail }));
    } catch (e) {
      // Older shells without CustomEvent simply do not get the broadcast.
    }
  }

  function applyParsed(manifest, source) {
    var finalManifest = withSource(manifest, source);
    var result = kernel.apply(finalManifest);
    current = { manifest: finalManifest, result: result };
    notify({ manifest: finalManifest, result: result });
    return { manifest: finalManifest, result: result };
  }

  function fetchManifest() {
    return g.fetch("/api/runtime", {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    }).then(function (res) {
      if (res.status === 401) return { error: "unauthorized", status: 401 };
      return res.text().then(function (text) {
        if (!res.ok) return { error: "http_" + res.status, status: res.status };
        try {
          return { json: JSON.parse(text) };
        } catch (e) {
          return { error: "bad_json", status: res.status };
        }
      });
    }).catch(function () {
      return { error: "network", status: 0 };
    });
  }

  function bootOnce() {
    if (booting) return booting;
    booting = fetchManifest().then(function (out) {
      if (out && out.json) {
        var parsed = parseRuntimeManifest(out.json);
        return applyParsed(parsed.manifest, "worker");
      }
      var reasons = {
        unauthorized: "manifest 401：访问码无效或未配置，按 guest 启动",
        bad_json: "/api/runtime 返回的不是 JSON，按本地 profile 启动",
        network: "/api/runtime 不可达，按本地 profile 启动",
      };
      var reason = reasons[out && out.error] || ("/api/runtime 失败（" + String(out && out.error) + "），按本地 profile 启动");
      var manifest = localRuntimeManifest(fallbackProfile(), reason);
      return applyParsed(manifest, "fallback");
    }).catch(function (e) {
      var manifest = localRuntimeManifest(fallbackProfile(), "manifest 应用失败：" + String(e && e.message || e));
      return applyParsed(manifest, "fallback");
    }).then(function (value) {
      booting = null;
      return value;
    });
    return booting;
  }

  var facade = {
    v: 1,
    ready: function () { return started === true; },
    profile: function () { return current ? current.manifest.profile : "guest"; },
    capabilities: function () { return current ? current.manifest.capabilities : {}; },
    limits: function () { return current ? current.manifest.limits : null; },
    manifest: function () { return current ? current.manifest : null; },
    status: function () { return kernel ? kernel.status() : null; },
    get: function (service) { return kernel ? kernel.get(service) : undefined; },
    has: function (service) { return kernel ? kernel.has(service) : false; },
    explain: function (id) { return kernel ? kernel.explain(id) : null; },
    checkLimit: function (surface, bytes) {
      if (kernel) return kernel.checkLimit(surface, bytes);
      return { ok: false, surface: String(surface || ""), size: Number(bytes) || 0, limit: 0, error: "manifest 尚未应用" };
    },
    apply: function (raw) {
      if (!kernel) return { manifest: null, result: null };
      var parsed = parseRuntimeManifest(raw);
      return applyParsed(parsed.manifest, "external");
    },
    refresh: function () { return started ? bootOnce() : Promise.resolve(null); },
    onChange: function (fn) {
      if (typeof fn !== "function") return function () {};
      listeners.push(fn);
      return function () {
        var i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    hostKey: function () {
      if (!g.location || !g.location.origin) return "";
      return hostKey({ origin: g.location.origin, adapter: dbAdapter() });
    },
    registerProvider: function (provider) {
      if (!provider || typeof provider.name !== "string" || typeof provider.apply !== "function") return false;
      // Registered before boot only: the kernel copies its provider list at construction.
      if (started) return false;
      pendingProviders.push(provider);
      return true;
    },
    dispose: function () {
      if (kernel) kernel.dispose();
      kernel = null;
      current = null;
      started = false;
      booting = null;
    },
  };
  var pendingProviders = [];
  g.runtimeManifest = facade;

  function start() {
    if (started) return bootOnce();
    if (!g.runtimeCore || typeof g.runtimeCore.createContext !== "function") {
      var issue = "runtime.js 未加载：capability kernel 不可用，按无 manifest 启动";
      current = { manifest: localRuntimeManifest("guest", issue), result: null };
      notify({ manifest: current.manifest, result: null });
      return Promise.resolve(current);
    }
    var root = g.dbSvc && g.dbSvc.context ? g.dbSvc.context : g.runtimeCore.createContext();
    var providers = providerList().concat(pendingProviders);
    pendingProviders = [];
    try {
      kernel = createCapabilityKernel({ context: root, providers: providers });
    } catch (e) {
      var failed = localRuntimeManifest("guest", "capability kernel 创建失败：" + String(e && e.message || e));
      current = { manifest: failed, result: null };
      notify({ manifest: failed, result: null });
      started = true;
      return Promise.resolve(current);
    }
    started = true;
    return bootOnce();
  }

  if (typeof document === "undefined") {
    // Node test realm: no boot. The exports are driven directly by the locks.
  } else if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { start(); });
  } else {
    start();
  }
})(window);
