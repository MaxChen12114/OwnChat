// Browser adapter, appended by l0/emit.mjs. Engine: services/ui/fishbowl-cta.ts; this file owns the
// DOM lookups, the two literal guidance strings, the event listeners and the timed re-sync. Nothing
// outside this file calls the engine, so it publishes no global — the row's only contract is the DOM
// it already owns. The literal copy stays here because it is UI text, not comment language.
(function () {
  "use strict";

  var START_COPY = "还没有进行中的群聊。点上方「建群聊」拉角色进群，或在群聊控制台里手动编排发言。";
  var ENABLE_COPY = "群聊在「多智能体」模式下开启：点左侧「单智能体」切到「多智能体」，再来这里建群 / 编排发言。";
  var LS_MULTI = "tavern_multi_agent_mode_v1";

  function queryMulti() {
    var m = window.__multi;
    if (!m || typeof m.isMulti !== "function") return undefined;
    return !!m.isMulti();
  }
  function readKey(k) {
    return localStorage.getItem(k);
  }

  function sync() {
    var btn = document.getElementById("wgConsoleBuildBtn");
    var hint = document.getElementById("fishbowlEmptyHint");
    if (!btn) return;
    var on = isMultiFrom(queryMulti, readKey, LS_MULTI, "multi");
    var plan = ctaPlan(on);
    btn.style.display = plan.buildVisible ? "" : "none";
    if (hint) hint.textContent = plan.message === "start" ? START_COPY : ENABLE_COPY;
  }

  window.addEventListener("multi-agent:changed", sync);
  document.addEventListener("DOMContentLoaded", sync);
  sync();
  setTimeout(sync, 300);
})();
