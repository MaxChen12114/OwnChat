(function () {
/**
 * Agent-mode orchestration rules: persisted mode flag, button state, console-health predicate,
 * target-container choice, external-settings key filtering and startup/remount decisions. The
 * wiring owns DOM lookup, mounting, events and the frozen console global.
 *
 * A console root is healthy only while it is still connected AND lives in the container the
 * orchestrator mounts into. The mobile shell moves that same right-side container into its console,
 * so both breakpoints share one host and a stale root MUST be rebuilt.
 * @module services/ui/agent-mode-orchestrator
 */

const AM_LS_AGENT = "cfw_agent_mode_v1";
const AM_LS_MULTI = "tavern_multi_agent_mode_v1";

/** @returns whether the stored mode flag means the agent mode is on. */
function amIsAgentOn(raw         )          {
  return raw === "1";
}

/** @returns the value to persist for an on/off transition. */
function amAgentOnValue(on         )         {
  return on ? "1" : "0";
}

/** @returns the visual state of the topbar toggle; the titles are user-facing copy. */
function amButtonState(on         )                                                          {
  return {
    active: on,
    ariaPressed: on ? "true" : "false",
    title: on ? "Agent 模式：开启（点击关闭）" : "Agent 模式（点击开启）",
  };
}

/** @returns the container the console must live in (same slot on desktop and inside the mobile shell). */
function amTargetBox(consoleSlot         , fishbowlSlot         )          {
  return consoleSlot || fishbowlSlot;
}

/** @returns whether an existing console root can be reused. */
function amConsoleHealthy(rootConnected         , boxContainsRoot         )          {
  return rootConnected && boxContainsRoot;
}

/** @returns whether a resize or tab click must remount the console. */
function amNeedsRemount(isOn         , healthy         )          {
  return isOn && !healthy;
}

/**
 * External changes come from cloud sync, another tab or a dev tool. A null key means the whole
 * store was cleared; every namespaced key is relevant because the settings are spread across them.
 */
function amIsExternalSettingsKey(key         )          {
  if (key === null) return true;
  const k = String(key);
  return k === AM_LS_AGENT || k === AM_LS_MULTI || /^(cfw_|tavern_)/.test(k);
}

/** @returns the startup plan: a restored session must mount lazily without activating the tab. */
function amStartupPlan(isOn         )                                                {
  return { syncClass: isOn, delayedMount: isOn };
}

// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/ui/agent-mode-orchestrator.ts
// (mode flag, button state, console health, target container, external settings and startup
// decisions); this file owns DOM lookup, mounting, events and the console global.
//
// Invariants: the console root must be connected and in the slot the shell moves into its console;
// a restored session mounts lazily. There is no separate mobile panel any more.

(function(){
  const LS_AGENT = AM_LS_AGENT;
  const LS_MULTI = AM_LS_MULTI;
  var btn = null, multiBtn = null, fishbowlSlot = null, emptyHint = null, agentConsoleSlot = null;

  function isAgentOn(){ return amIsAgentOn(localStorage.getItem(LS_AGENT)); }

  function updateBtnUI(){
    if (!btn) return;
    const st = amButtonState(isAgentOn());
    btn.classList.toggle('active', st.active);
    btn.setAttribute('aria-pressed', st.ariaPressed);
    btn.title = st.title;
  }

  function agentConsoleHealthy(){
    var api = window.agentConsoleSvc;
    var connected = !!(api && api.root && api.root.isConnected);
    var box = amTargetBox(agentConsoleSlot, fishbowlSlot);
    var inside = connected && !!(box && box.contains(api.root));
    return amConsoleHealthy(connected, inside);
  }

  function mountAgentPanel(){
    if (agentConsoleHealthy()) return;
    window.agentConsoleSvc = null;
    if (!fishbowlSlot) return;
    if (emptyHint) emptyHint.style.display = 'none';
    var wrapper = document.createElement('div');
    wrapper.id = '__agentConsoleRoot';
    wrapper.style.cssText = 'display:flex;flex-direction:column;flex:1 1 auto;min-height:0;';
    fishbowlSlot.innerHTML = '';
    fishbowlSlot.removeAttribute('style');
    fishbowlSlot.className = 'sidebar-slot';
    var peers = document.createElement('div');
    peers.id = '__agentPeers';
    peers.style.cssText = 'flex:none;';
    fishbowlSlot.appendChild(peers);
    fishbowlSlot.appendChild(wrapper);
    if (window.mountAgentConsole && typeof window.mountAgentConsole === 'function') {
      var r = window.mountAgentConsole(wrapper, { autoApprove: false });
      window.agentConsoleSvc = r;
    } else {
      wrapper.innerHTML = '<div style="padding:16px;font-size:12px;color:#888;line-height:1.7;display:flex;align-items:flex-start;gap:8px;"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" style="flex:none;margin-top:1px"><rect x="1" y="5" width="12" height="8" rx="1.5"/><path d="M4 5V3a3 3 0 0 1 6 0v2"/><circle cx="7" cy="9" r="1"/></svg><span>Agent 控制台加载中，或刷新重试</span></div>';
    }
    try { window.dispatchEvent(new CustomEvent("multi-agent:changed")); } catch (e) {}
  }

  function unmountAgentPanel(){
    if (emptyHint) emptyHint.style.display = '';
    if (fishbowlSlot) {
      fishbowlSlot.innerHTML = '';
      fishbowlSlot.removeAttribute('style');
      fishbowlSlot.className = 'sidebar-slot';
      fishbowlSlot.style.display = 'flex';
      fishbowlSlot.style.flexDirection = 'column';
      fishbowlSlot.style.overflowY = 'auto';
    }
    window.agentConsoleSvc = null;
    try { window.dispatchEvent(new CustomEvent("multi-agent:changed")); } catch (e) {}
  }

  function syncAgentClass(on){
    try { document.documentElement.classList.toggle('agent-mode', !!on); } catch(e) {}
  }
  function applyAgentMode(on){
    localStorage.setItem(LS_AGENT, amAgentOnValue(on));
    syncAgentClass(on);
    if (on) {
      mountAgentPanel();
    } else {
      unmountAgentPanel();
    }
    updateBtnUI();
  }

  function init(){
    btn = document.getElementById('agentModeBtn');
    multiBtn = document.getElementById('multiAgentToggle');
    fishbowlSlot = document.getElementById('agentConsoleSlot') || document.getElementById('fishbowlSlot');
    agentConsoleSlot = document.getElementById('agentConsoleSlot');
    emptyHint = document.getElementById('agentEmptyHint') || document.getElementById('fishbowlEmptyHint');

    if (btn) btn.addEventListener('click', function(){ applyAgentMode(!isAgentOn()); });
    var _agentResizeT = 0;
    window.addEventListener('resize', function(){
      clearTimeout(_agentResizeT);
      _agentResizeT = setTimeout(function(){
        try { if (amNeedsRemount(isAgentOn(), agentConsoleHealthy())) mountAgentPanel(); } catch (e) {}
      }, 250);
    });

    function refreshModeButtons(){
      try { syncAgentClass(isAgentOn()); } catch (e) {}
      try { updateBtnUI(); } catch (e) {}
      try { window.dispatchEvent(new CustomEvent('multi-agent:changed')); } catch (e) {}
    }
    function applyExternalSettings(){
      refreshModeButtons();
      try { if (window.themeSvc && typeof window.themeSvc.applyFromLS === 'function') window.themeSvc.applyFromLS(); } catch (e) {}
      try { window.dispatchEvent(new CustomEvent('cfw:external-settings')); } catch (e) {}
    }
    try {
      window.addEventListener('storage', function (e) {
        if (!e) return;
        if (amIsExternalSettingsKey(e.key)) applyExternalSettings();
      });
      document.addEventListener('visibilitychange', function () { if (!document.hidden) applyExternalSettings(); });
      (function wireSyncModeRefresh(){
        var tries = 0;
        (function go(){
          if (window.syncSvc && typeof window.syncSvc.onStatus === 'function') {
            window.syncSvc.onStatus(function () { applyExternalSettings(); });
            return;
          }
          if (tries++ < 40) setTimeout(go, 500);
        })();
      })();
    } catch (e) {}

    if (multiBtn) {
      multiBtn.addEventListener('click', function(){
        setTimeout(function(){
          updateBtnUI();
          window.dispatchEvent(new CustomEvent('multi-agent:changed'));
        }, 80);
      });
    }
    updateBtnUI();
    var startup = amStartupPlan(isAgentOn());
    if (startup.syncClass) syncAgentClass(true);
    if (startup.delayedMount) setTimeout(function(){ mountAgentPanel(); }, 600);
  }

  var _agentInited = false;
  function safeInit(){ if (_agentInited) return; _agentInited = true; init(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', safeInit); else safeInit();
  setTimeout(safeInit, 400);
})();

globalThis.AM_LS_AGENT = AM_LS_AGENT;
globalThis.AM_LS_MULTI = AM_LS_MULTI;
globalThis.amIsAgentOn = amIsAgentOn;
globalThis.amAgentOnValue = amAgentOnValue;
globalThis.amButtonState = amButtonState;
globalThis.amTargetBox = amTargetBox;
globalThis.amConsoleHealthy = amConsoleHealthy;
globalThis.amNeedsRemount = amNeedsRemount;
globalThis.amIsExternalSettingsKey = amIsExternalSettingsKey;
globalThis.amStartupPlan = amStartupPlan;
})();
