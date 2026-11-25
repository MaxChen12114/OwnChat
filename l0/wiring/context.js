// Browser wiring (injected by l0/emit.mjs): binds the service to the existing window contract.
// The bridges are getters rather than snapshotted fields, so a module that loads after this one is
// still reachable — the old file read them at call time for the same reason. Every bridge name is
// spelled out in full with the `window.` prefix: an alias makes the contract scan count drop to
// zero and look like the name was retired.
(function () {
  if (window.__context) return;

  var env = {};
  Object.defineProperties(env, {
    multi: { get: function () { return window.__multi; }, enumerable: true },
    character: { get: function () { return window.__character; }, enumerable: true },
    agentKernel: { get: function () { return window.AgentKernel; }, enumerable: true },
    ctxExact: { get: function () { return window.APP_CTX_EXACT; }, enumerable: true },
    ctxHints: { get: function () { return window.APP_CTX_HINTS; }, enumerable: true },
  });
  env.storage = {
    getItem: function (key) { return window.localStorage.getItem(key); },
  };
  // The `#modelSel` / `cfw_model` lookup for the compaction limit lives here; a throw becomes the
  // empty string and the service falls back to the 128K default.
  env.modelId = function () {
    try {
      return (document.getElementById("modelSel") || {}).value || window.localStorage.getItem("cfw_model") || "";
    } catch (e) { return ""; }
  };

  var factory = createContextFactory(env);
  window.__context = { create: factory.create };
})();
