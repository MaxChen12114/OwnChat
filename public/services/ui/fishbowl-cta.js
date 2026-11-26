(function () {
/**
 * Empty-state call to action for the group-chat console: is multi-agent mode on, should the build
 * button show, and which of the two guidance messages applies.
 *
 * The mode has two sources of truth read in a fixed order — a live `multi` query, then a storage
 * key. The live source wins *even when it answers false*; storage is consulted only when the live
 * bridge is absent. A throw from either source resolves to off: a hint row must never take the boot
 * sequence down during hot reload.
 *
 * Button visibility and guidance text are one decision returned as a plan, because they are two
 * halves of the same state — showing "build a group" while multi is off, or the "switch mode" hint
 * while it is on, is the bug this used to produce. The literal copy stays in the wiring: this
 * module decides *which* message, never its wording.
 * @module services/ui/fishbowl-cta
 */

/** The guidance variants. The wiring maps each to its own literal copy. */
                                         

/** What the empty-state row should look like. */
                          
                        
                   
 

/**
 * Decide the empty-state row for a mode.
 *
 * @param multiOn Whether multi-agent mode is active.
 * @returns With multi on, the build button shows and the "start a group" guidance is chosen; with
 * it off, the button hides and the "enable multi-agent" guidance is chosen.
 */
function ctaPlan(multiOn         )          {
  return multiOn
    ? { buildVisible: true, message: "start" }
    : { buildVisible: false, message: "enable" };
}

/**
 * Read multi-agent mode from injected ports, preserving the live-first / storage-fallback order.
 *
 * @param queryMulti Live query returning a boolean, or `undefined` when the bridge is absent. When
 * it returns a boolean that value is final — including `false`, which does NOT consult storage.
 * @param readKey Storage reader, may be absent.
 * @param key Storage key holding the multi-agent mode.
 * @param onValue The stored value that means multi mode is on.
 * @returns Off if either port throws, if no port is present, or if storage holds another value.
 */
function isMultiFrom(
  queryMulti                                         ,
  readKey                                            ,
  key        ,
  onValue        ,
)          {
  try {
    if (queryMulti) {
      const live = queryMulti();
      if (live !== undefined) return !!live;
    }
    if (readKey) return readKey(key) === onValue;
    return false;
  } catch (e) {
    return false;
  }
}

// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/ui/fishbowl-cta.ts; this file owns the
// DOM lookups, the two literal guidance strings, the event listeners and the timed re-sync. Nothing
// outside this file calls the engine, so it publishes no global — the row's only contract is the DOM
// it already owns. The literal copy stays here because it is UI text, not comment language.
(function () {
  "use strict";

  var START_COPY = "还没有进行中的群聊。点上方「建群聊」拉角色进群，或在群聊控制台里手动编排发言。";
  var ENABLE_COPY = "群聊在「多智能体」模式下开启：点左侧「单智能体」切到「多智能体」，再来这里建群 / 编排发言。";
  var LS_MULTI = "tavern_multi_agent_mode_v1";

  function queryMulti() {
    var m = window.multiSvc;
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

globalThis.ctaPlan = ctaPlan;
globalThis.isMultiFrom = isMultiFrom;
})();
