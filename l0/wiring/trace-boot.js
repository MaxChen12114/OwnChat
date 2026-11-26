// Browser wiring (injected by l0/emit.mjs): window reads and the DOM-ready hand-off.
// Idempotence used to ride on a diagnostics global; the boot now relies on its own retry budget.
(function () {
  "use strict";
  var api = createTraceBoot({
    getKernel: function () {
      return window.AgentKernel;
    },
    getTrace: function () {
      return window.__agentTrace;
    },
    setBootState: function (state) {
      // Diagnostics sink retired with the frozen global; the port stays for factory equivalence.
      void state;
    },
    schedule: function (fn, ms) {
      setTimeout(fn, ms);
    },
    onReady: function (cb) {
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", cb);
      else cb();
    },
    now: function () {
      return Date.now();
    },
  });
  // DOM 就绪后再开始轮询（与旧内联一致）
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { api.install(); });
  else api.install();
})();
