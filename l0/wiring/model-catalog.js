// Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name.
// The implementation lives in services/model-router/model-catalog.ts. Every window bridge is
// resolved per call (APP_* / providersSvc / authSvc / __openSettingsCat), exactly as the old code
// read them.
// `document` and `alert` are probed with typeof and reached as bare globals: the vm test puts them
// on the context object, and in a browser the global scope is the same thing.
//
// T4-A: mounted as a runtime plugin. It injects `transport` and `key` — the catalog is where the
// first real "who supplies the network / who supplies the token" question is asked, and the answer
// must come from the container instead of a second `fetch` + `authSvc` lookup. The injected ports
// are used as fallbacks behind the existing bridges, so a page without them keeps its old path.
(function () {
  "use strict";
  var HOST = (typeof window !== "undefined" && window.runtimeCore && window.runtimeCore.host) || null;

  function apply(ctx) {
    if (window.__modelCatalog) return function () {};
    var transport = ctx && typeof ctx.get === "function" ? ctx.get("transport") : null;
    var key = ctx && typeof ctx.get === "function" ? ctx.get("key") : null;
    var ports = {
      storage: {
        getItem: function (key) { return window.localStorage.getItem(key); },
        setItem: function (key, value) { window.localStorage.setItem(key, value); },
      },
      providers: function () { return window.providersSvc || null; },
      // The secret port answers the session token; authSvc stays first so a shell that mounts it
      // late still wins (its getToken reflects sign-in/out immediately).
      auth: function () {
        if (window.authSvc) return window.authSvc;
        if (!key || typeof key.get !== "function") return null;
        return { getToken: function () { return key.get("auth-token"); } };
      },
      appModelsFree: function () { return window.APP_MODELS_FREE; },
      appModelsFast: function () { return window.APP_MODELS_FAST; },
      appDefaultModelFree: function () { return window.APP_DEFAULT_MODEL_FREE; },
      appDefaultModelFast: function () { return window.APP_DEFAULT_MODEL_FAST; },
      openSettingsCat: function (cat) {
        try { if (window.__openSettingsCat) window.__openSettingsCat(cat); } catch (e) {}
      },
      doc: function () { return (typeof document !== "undefined") ? document : null; },
      alertMsg: function (msg) { if (typeof alert === "function") alert(msg); },
    };
    var api = {
      v: 1,
      groupModelsForSelect: groupModelsForSelect,
      create: function (host) { return createModelCatalog(ports, host); },
    };
    window.__modelCatalog = api;
    if (ctx && typeof ctx.provide === "function") {
      ctx.provide("modelCatalog", {
        v: 1,
        create: api.create,
        groupModelsForSelect: groupModelsForSelect,
        transport: transport,
        key: key,
      });
    }
    return function dispose() {
      if (window.__modelCatalog === api) {
        try { delete window.__modelCatalog; } catch (e) { window.__modelCatalog = undefined; }
      }
    };
  }

  var mod = { name: "model-catalog", inject: ["transport", "key"], apply: apply };
  if (HOST) {
    HOST.define("model-catalog", mod);
    HOST.start("model-catalog");
    return;
  }
  apply({ get: function () { return null; }, provide: function () {} });
})();
