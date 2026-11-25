// Browser adapter, appended by l0/emit.mjs. Engine: services/ui/think-level-map.ts
// (effort alias table, ordered fallbacks and the badge predicate); this file owns
// the toggle attributes, localStorage and the MutationObserver.
(function(){
  function syncThinkEffort(){
    var b = document.getElementById("thinkToggle");
    if (!b) return;
    var src = tlmFirstNonEmpty([b.getAttribute("data-effort"), b.getAttribute("data-thinking-effort"), b.dataset.effort, b.dataset.thinkingEffort]);
    if (!src) {
      try { src = tlmFirstNonEmpty([localStorage.getItem("cfw_thinking_effort_v1"), localStorage.getItem("cfw_think_effort_v1")]); } catch(e) {}
    }
    if (!src) src = (b.getAttribute("title") || "") + " " + (b.getAttribute("aria-label") || "");
    var v = tlmPick(src);
    if (tlmShouldBadge(b.classList.contains("active"), v)) b.setAttribute("data-mobile-effort", v);
    else b.removeAttribute("data-mobile-effort");
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", syncThinkEffort); else syncThinkEffort();
  (function(){
    var _tt = document.getElementById("thinkToggle");
    if (_tt) new MutationObserver(syncThinkEffort).observe(_tt, { attributes: true, attributeFilter: ["title", "aria-label", "data-effort", "data-thinking-effort", "class"] });
  })();
})();
