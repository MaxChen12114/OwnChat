// Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name.
// The implementation lives in services/model-router/model-catalog.ts. Every window bridge is
// resolved per call (APP_* / __providers / __auth / __openSettingsCat), exactly as the old code
// read them.
// `document` and `alert` are probed with typeof and reached as bare globals: the vm test puts them
// on the context object, and in a browser the global scope is the same thing.
(function () {
  if (window.__modelCatalog) return;
  var ports = {
    storage: {
      getItem: function (key) { return window.localStorage.getItem(key); },
      setItem: function (key, value) { window.localStorage.setItem(key, value); },
    },
    providers: function () { return window.__providers || null; },
    auth: function () { return window.__auth || null; },
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
  window.__modelCatalog = {
    groupModelsForSelect: groupModelsForSelect,
    create: function (host) { return createModelCatalog(ports, host); },
  };
})();
