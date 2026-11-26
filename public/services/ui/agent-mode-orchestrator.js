(function () {
/**
 * Agent-mode orchestration rules: persisted mode flag, button state, console-health predicate,
 * target-container choice, external-settings key filtering and startup/remount decisions. The
 * wiring owns DOM lookup, mounting, events and the frozen console global.
 *
 * A console root is healthy only while it is still connected AND lives in the container that
 * matches the current breakpoint; a stale root in the hidden mobile panel MUST be rebuilt, or the
 * desktop right column stays empty forever.
 * @module services/ui/agent-mode-orchestrator
 */

const AM_LS_AGENT = "cfw_agent_mode_v1";
const AM_LS_MULTI = "tavern_multi_agent_mode_v1";
/** Breakpoint shared with the mobile layout; the wiring feeds it to matchMedia. */
const AM_MOBILE_QUERY = "(max-width: 1023px)";

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

/** @returns the container the console must live in for the current breakpoint. */
function amTargetBox(
  isMobile         ,
  mobilePanel         ,
  consoleSlot         ,
  fishbowlSlot         ,
)          {
  return isMobile ? mobilePanel : (consoleSlot || fishbowlSlot);
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

// Browser adapter, appended by l0/emit.mjs. Engine: services/ui/agent-mode-orchestrator.ts
// (mode flag, button state, console health, target container, external settings and startup
// decisions); this file owns DOM lookup, mounting, events and the console global.
//
// Invariants: the console root must be connected and in the breakpoint-matched container;
// a restored session mounts lazily without activating the full-screen mobile tab.

(function(){
  const LS_AGENT = AM_LS_AGENT;
  const LS_MULTI = AM_LS_MULTI;
  var btn = null, multiBtn = null, fishbowlTab = null, fishbowlSlot = null, emptyHint = null, agentConsoleSlot = null;
  var mobileAgentTabEl = null, mobileAgentPanel = null;

  function isAgentOn(){ return amIsAgentOn(localStorage.getItem(LS_AGENT)); }
  function isMobile(){ return window.matchMedia(AM_MOBILE_QUERY).matches; }

  function updateBtnUI(){
    if (!btn) return;
    const st = amButtonState(isAgentOn());
    btn.classList.toggle('active', st.active);
    btn.setAttribute('aria-pressed', st.ariaPressed);
    btn.title = st.title;
  }

  function createConsoleIn(container, consoleKey){
    var ph = document.getElementById('__mobileAgentPlaceholder');
    if (ph) ph.style.display = 'none';
    container.innerHTML = '';
    var wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;flex-direction:column;height:100%;min-height:0;';
    container.appendChild(wrapper);
    if (window.mountAgentConsole && typeof window.mountAgentConsole === 'function') {
      var r = window.mountAgentConsole(wrapper, { autoApprove: false });
      window[consoleKey] = r;
    } else {
      wrapper.innerHTML = '<div style="padding:16px;font-size:12px;color:#888;line-height:1.7;display:flex;align-items:flex-start;gap:8px;"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" style="flex:none;margin-top:1px"><rect x="1" y="5" width="12" height="8" rx="1.5"/><path d="M4 5V3a3 3 0 0 1 6 0v2"/><circle cx="7" cy="9" r="1"/></svg><span>Agent 控制台加载中，请稍候或刷新重试。</span></div>';
      window[consoleKey] = null;
    }
  }

  function agentConsoleHealthy(){
    var api = window.agentConsoleSvc;
    var connected = !!(api && api.root && api.root.isConnected);
    var box = amTargetBox(isMobile(), mobileAgentPanel, agentConsoleSlot, fishbowlSlot);
    var inside = connected && !!(box && box.contains(api.root));
    return amConsoleHealthy(connected, inside);
  }

  function mountAgentPanel(suppressTabActivation){
    if (agentConsoleHealthy()) return;
    window.agentConsoleSvc = null;

    if (isMobile()) {
      if (!mobileAgentPanel) return;
      createConsoleIn(mobileAgentPanel, 'agentConsoleSvc');
      var peers = document.createElement('div');
      peers.id = '__agentPeers';
      peers.style.cssText = 'flex:none;';
      mobileAgentPanel.insertBefore(peers, mobileAgentPanel.firstChild);
      if (!suppressTabActivation && mobileAgentTabEl) {
        mobileAgentTabEl.classList.remove('active');
      }
    } else {
      if (!fishbowlSlot) return;
      if (fishbowlTab) { var sp = fishbowlTab.querySelector('span:not(.rs-dot)'); if (sp) sp.textContent = '活动'; }
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
    }
    try { window.dispatchEvent(new CustomEvent("multi-agent:changed")); } catch (e) {}
  }

  function unmountAgentPanel(){
    if (fishbowlTab) { var sp = fishbowlTab.querySelector('span:not(.rs-dot)'); if (sp) sp.textContent = '活动'; }
    if (emptyHint) emptyHint.style.display = '';
    if (fishbowlSlot) {
      fishbowlSlot.innerHTML = '';
      fishbowlSlot.removeAttribute('style');
      fishbowlSlot.className = 'sidebar-slot';
      fishbowlSlot.style.display = 'flex';
      fishbowlSlot.style.flexDirection = 'column';
      fishbowlSlot.style.overflowY = 'auto';
    }
    if (mobileAgentPanel) {
      mobileAgentPanel.innerHTML = '';
      var ph = document.createElement('div');
      ph.id = '__mobileAgentPlaceholder';
      ph.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:10px;color:var(--muted,#888);font-size:13px;line-height:1.6;text-align:center;padding:0 24px;';
      ph.innerHTML = '<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:.4"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M9 11V7a3 3 0 0 1 6 0v4"/><circle cx="12" cy="16" r="1.2"/></svg><span style="opacity:.55">点左侧「Agent 模式」开启<br>或在左侧栏点「Agent 模式」按钮</span>';
      mobileAgentPanel.appendChild(ph);
    }
    if (mobileAgentTabEl) mobileAgentTabEl.classList.remove('active');
    var panels = document.querySelectorAll('.mobile-tab-panel');
    panels.forEach(function(p){ if (p.getAttribute('data-tab') === 'agent') p.classList.remove('active'); });
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
    fishbowlTab = document.querySelector('.rs-tab[data-rs-tab="fishbowl"]');
    fishbowlSlot = document.getElementById('agentConsoleSlot') || document.getElementById('fishbowlSlot');
    agentConsoleSlot = document.getElementById('agentConsoleSlot');
    emptyHint = document.getElementById('agentEmptyHint') || document.getElementById('fishbowlEmptyHint');
    mobileAgentTabEl = document.getElementById('mobileAgentTab');
    mobileAgentPanel = document.getElementById('mobileTabPanel-agent');

    if (btn) btn.addEventListener('click', function(){ applyAgentMode(!isAgentOn()); });
    var _agentResizeT = 0;
    window.addEventListener('resize', function(){
      clearTimeout(_agentResizeT);
      _agentResizeT = setTimeout(function(){
        try { if (amNeedsRemount(isAgentOn(), agentConsoleHealthy())) mountAgentPanel(true); } catch (e) {}
      }, 250);
    });
    if (mobileAgentTabEl) mobileAgentTabEl.addEventListener('click', function(){
      try { if (amNeedsRemount(isAgentOn(), agentConsoleHealthy())) mountAgentPanel(true); } catch (e) {}
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

    if (mobileAgentTabEl) {
      mobileAgentTabEl.addEventListener('click', function(){
        if (!isAgentOn()) {
          setTimeout(function(){
            localStorage.setItem(LS_AGENT, amAgentOnValue(true));
            if (!agentConsoleHealthy()) mountAgentPanel(true);
            mobileAgentTabEl.classList.add('active');
            var p = document.getElementById('mobileTabPanel-agent');
            if (p) p.classList.add('active');
            updateBtnUI();
          }, 20);
        }
      });
    }

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
    if (startup.delayedMount) setTimeout(function(){ mountAgentPanel(true); }, 600);
  }

  var _agentInited = false;
  function safeInit(){ if (_agentInited) return; _agentInited = true; init(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', safeInit); else safeInit();
  setTimeout(safeInit, 400);
})();

globalThis.AM_LS_AGENT = AM_LS_AGENT;
globalThis.AM_LS_MULTI = AM_LS_MULTI;
globalThis.AM_MOBILE_QUERY = AM_MOBILE_QUERY;
globalThis.amIsAgentOn = amIsAgentOn;
globalThis.amAgentOnValue = amAgentOnValue;
globalThis.amButtonState = amButtonState;
globalThis.amTargetBox = amTargetBox;
globalThis.amConsoleHealthy = amConsoleHealthy;
globalThis.amNeedsRemount = amNeedsRemount;
globalThis.amIsExternalSettingsKey = amIsExternalSettingsKey;
globalThis.amStartupPlan = amStartupPlan;
})();
