// Browser wiring (injected by l0/emit.mjs): window reads, the __agentTraceBoot sink and the
// DOM-ready hand-off; idempotence = the installed flag gates re-entry (old inline behaviour).
(function () {
  "use strict";
  if (window.__agentTraceBoot && window.__agentTraceBoot.installed) return;
  var api = createTraceBoot({
    getKernel: function () {
      return window.AgentKernel;
    },
    getTrace: function () {
      return window.__agentTrace;
    },
    setBootState: function (state) {
      window.__agentTraceBoot = state; // Console 自查用，不参与业务
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
