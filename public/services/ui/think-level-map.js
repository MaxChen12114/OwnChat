(function () {
/**
 * Thinking-effort alias normalisation for the mobile toggle badge. The wiring owns the DOM
 * attributes, localStorage and the MutationObserver.
 *
 * Pattern order is significant: xhigh and max must be tested before high, otherwise "xhigh"
 * resolves to "high". Unknown values return an empty string and MUST NOT produce a badge.
 * @module services/ui/think-level-map
 */

const TLM_MAP                         = {
  minimal: "minimal", "极低": "minimal",
  low: "low", weak: "low", "低": "low", "弱": "low",
  medium: "medium", mid: "medium", auto: "medium", normal: "medium", "中": "medium", "默认": "medium",
  high: "high", strong: "high", "高": "high", "强": "high",
  xhigh: "xhigh", "更高": "xhigh",
  max: "max", "最高": "max",
};

/** Ordered fallback rules; the first match wins. */
const TLM_PATTERNS                     = [
  ["minimal|极低", "minimal"],
  ["xhigh|extra.?high|更高", "xhigh"],
  ["max|最高", "max"],
  ["low|weak|低|弱", "low"],
  ["medium|mid|auto|normal|中|默认", "medium"],
  ["high|strong|高|强", "high"],
];

/** @returns the first truthy value, or an empty string. */
function tlmFirstNonEmpty(values                               )         {
  for (const v of values) if (v) return String(v);
  return "";
}

/** @returns the canonical effort level, or "" when the value is not recognised. */
function tlmPick(v         )         {
  const s = v ? String(v).trim() : "";
  if (!s) return "";
  if (TLM_MAP[s]) return TLM_MAP[s];
  const l = s.toLowerCase();
  if (TLM_MAP[l]) return TLM_MAP[l];
  for (const [pattern, level] of TLM_PATTERNS) {
    if (new RegExp(pattern).test(l)) return level;
  }
  return "";
}

/** A badge is written only while the toggle is active and the effort is recognised. */
function tlmShouldBadge(active         , effort        )          {
  return active && !!effort;
}

// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/ui/think-level-map.ts
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

globalThis.TLM_MAP = TLM_MAP;
globalThis.TLM_PATTERNS = TLM_PATTERNS;
globalThis.tlmFirstNonEmpty = tlmFirstNonEmpty;
globalThis.tlmPick = tlmPick;
globalThis.tlmShouldBadge = tlmShouldBadge;
})();
