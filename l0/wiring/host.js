// Browser wiring, appended by l0/emit.mjs. Engine: services/platform/host.ts (the host provider
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
