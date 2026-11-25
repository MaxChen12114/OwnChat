// Browser wiring (injected by l0/emit.mjs): publishes the per-turn tool-mode runtime with the
// policy modules injected from the policy products' emit bridges. An absent module degrades to a
// null dep — the runtime then behaves like full with no tool_search (the C-3 fallback lock), so a
// half-installed policy domain can never take the turn down.
(function () {
  if (window.__toolMode && window.__toolMode.v === 1) return;
  var fnOrNull = function (name) {
    try { return typeof globalThis[name] === "function" ? globalThis[name] : null; } catch (e) { return null; }
  };
  window.__toolMode = {
    v: 1,
    readToolMode: readToolMode,
    createToolModeRuntime: function (input) {
      var o = input || {};
      o.deps = {
        applyToolPolicy: fnOrNull("applyToolPolicy"),
        registryToPolicyEntries: fnOrNull("registryToPolicyEntries"),
        toolSearchSchema: fnOrNull("toolSearchSchema"),
        TOOL_SEARCH_ID: (typeof globalThis.TOOL_SEARCH_ID === "string" && globalThis.TOOL_SEARCH_ID !== "")
          ? globalThis.TOOL_SEARCH_ID : null,
        matchEntries: fnOrNull("matchEntries"),
        createDiscovered: fnOrNull("createDiscovered"),
      };
      return createToolModeRuntime(o);
    },
  };
})();
