// Browser adapter, appended by l0/emit.mjs. Engine: services/local/local-exec-tools.ts; this file
// owns localStorage, fetch, the desktop probe and the published tool-group object. The desktop
// build registers the same four tool names through the invoke-based module, so registration is
// skipped whenever that bridge is present — never both.
(function () {
  "use strict";
  if (window.__localExecTools) return;

  var ports = {
    storage: { getItem: function (k) { return localStorage.getItem(k); } },
    fetchImpl: function (url, init) { return fetch(url, init); },
    desktop: function () { return !!window.__TAURI__; },
  };

  window.__localExecTools = {
    defineTools: function (registry) { lexDefineTools(ports, registry); },
    ready: function () { return lexReady(lexConfig(ports.storage)); },
    __v: 1,
  };
})();
