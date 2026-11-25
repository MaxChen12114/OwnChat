// ── Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract names ──
// The implementation moved to services/agent/ambient-tools.ts. The only port is the mixer handle, and
// it is a function because theme.js may mount after this script. Two globals are bound here, exactly as
// before: `__ambientTags` (the tag protocol used by the two reply paths) and `AmbientTools` (the tool
// registrar and the director prompt).
(function (g) {
  "use strict";
  var api = createAmbientTools({
    mixer: function () { return window.__ambient || null; },
  });
  window.__ambientTags = {
    extract: api.extract,
    apply: api.apply,
    directorPrompt: api.directorPrompt,
    resolveId: api.resolveId,
  };
  g.AmbientTools = {
    defineTools: api.defineTools,
    directorPrompt: api.directorPrompt,
    extract: api.extract,
    apply: api.apply,
  };
})(window);
