// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/ui/right-sidebar-tabs.ts; this file
// owns the DOM and the three automatic switches (boot pass, console mount, topbar button). No
// global is published: the strip's contract is the DOM, and the old implicit `agentConsoleSlot`
// global was never read (its apparent consumer resolves the slot itself).
//
// The tab buttons are rendered at runtime by tooling/l0/wiring/panel-host.js from `PANEL_VIEWS` (index.html
// ships an empty `#rsTabs`), and that file parses ~170 manifest rows after this one. A parse-time
// `querySelectorAll(".rs-tab")` snapshot is therefore always empty and silently kills all three
// switches below — so the strip is read on every use (`readTabs` / `readTabNames`) and clicks are
// handled by one delegated listener that survives re-renders. The panels are static markup in
// index.html and stay cached.
//
// The boot pass waits 900 ms because the console slot is filled by scripts that run after this one;
// reading child counts immediately would always see an empty right sidebar.
(function () {
  "use strict";
  var rs = document.getElementById("rightSidebar");
  if (!rs) return;
  var panels = rs.querySelectorAll(".rs-panel");
  var slot = document.getElementById("fishbowlSlot");
  // This used to be an accidental global (assignment without var) pointing at the agent console
  // slot; nothing ever read it off `window`, so it stays local now.
  var consoleSlot = document.getElementById("agentConsoleSlot");

  var panelNames = [];
  for (var j = 0; j < panels.length; j++) panelNames.push(panels[j].getAttribute("data-rs-panel"));

  /** Current buttons, in DOM order. Never cache the result: panel-host owns the markup. */
  function readTabs() {
    return rs.querySelectorAll(".rs-tab");
  }

  /** `data-rs-tab` of the current buttons, in DOM order — the engine's tab-name list. */
  function namesOf(tabs) {
    var out = [];
    for (var i = 0; i < tabs.length; i++) out.push(tabs[i].getAttribute("data-rs-tab"));
    return out;
  }

  function readTabNames() {
    return namesOf(readTabs());
  }

  /**
   * Moves the selection.
   *
   * panel-host owns the fixed-tab state machine (persisted tab, which panel is visible, the tab
   * highlight), so when it is mounted the move is handed to `panelSvc.chooseTab` — painting our own
   * copy of the classes left the highlight and the visible panel disagreeing after the next
   * apply(). The local plan below is the fallback for a page without panel-host.
   *
   * @returns false when the strip has no buttons yet (panel-host has not rendered) — the initial
   * state then belongs to panel-host's apply(), which restores the persisted tab.
   */
  function activate(name) {
    var tabs = readTabs();
    if (!tabs.length) return false;
    var svc = window.panelSvc;
    if (svc && typeof svc.chooseTab === "function") {
      svc.chooseTab(name);
      return true;
    }
    var view = rsTabPlan(readTabNames(), panelNames, name);
    for (var t = 0; t < tabs.length; t++) {
      var tabView = view.tabs[t];
      tabs[t].classList.toggle("active", tabView.active);
      tabs[t].setAttribute("aria-selected", tabView.ariaSelected);
      if (tabView.clearActivity) tabs[t].classList.remove("has-activity");
    }
    for (var p = 0; p < panels.length; p++) {
      var panelView = view.panels[p];
      panels[p].classList.toggle("active", panelView.active);
      if (panelView.hidden) panels[p].setAttribute("hidden", "");
      else panels[p].removeAttribute("hidden");
    }
    return true;
  }

  // One listener for the whole strip. Per-button listeners would bind to nodes that panel-host
  // re-renders (and drop the ones it creates after this file parses).
  rs.addEventListener("click", function (e) {
    var tab = e.target && e.target.closest ? e.target.closest(".rs-tab") : null;
    if (!tab) return;
    activate(tab.getAttribute("data-rs-tab"));
  });

  /**
   * Runs `fn` once the strip has buttons. The boot pass below can fire before panel-host rendered
   * them (this script's timer starts at parse time, the render happens at DOMContentLoaded), and a
   * silently dropped switch is exactly what this file used to do with its parse-time snapshot.
   * `fn` runs immediately when the buttons are already there.
   */
  function whenStripReady(fn) {
    if (readTabs().length) { fn(); return; }
    var box = document.getElementById("rsTabs");
    if (!box) return;
    try {
      var mo = new MutationObserver(function () {
        if (!readTabs().length) return;
        mo.disconnect();
        fn();
      });
      mo.observe(box, { childList: true });
    } catch (e) {}
  }

  // Since 2026-11-09 the activity column holds only the agent timeline, which is empty until an
  // agent has run: landing there on load showed a blank right sidebar whenever a group chat existed.
  // The decision is taken at 900 ms (slot child counts are settled by then); the *move* waits for
  // the strip, which may still be unrendered on a cold load.
  setTimeout(function () {
    try {
      var target = rsBootTab(
        consoleSlot ? consoleSlot.childElementCount : null,
        slot ? slot.childElementCount : null,
      );
      if (target) whenStripReady(function () { activate(target); });
    } catch (e) {}
  }, 900);

  // The console mounting into its slot switches the strip to its own tab, or it stays hidden behind
  // the image panel. A re-render while already selected only lights the unread dot.
  if (slot) {
    var wasFilled = slot.childElementCount > 0;
    try {
      var mo = new MutationObserver(function () {
        var nowFilled = slot.childElementCount > 0;
        var action = rsSlotChange(wasFilled, nowFilled);
        if (action === "activate-chat") {
          activate(RS_CHAT_TAB);
        } else if (action === "mark-activity") {
          var chatTab = rs.querySelector('.rs-tab[data-rs-tab="chat"]');
          if (chatTab && !chatTab.classList.contains("active")) chatTab.classList.add("has-activity");
        }
        wasFilled = nowFilled;
      });
      mo.observe(slot, { childList: true });
    } catch (e) {}
  }

  var multiAgentBtn = document.getElementById("multiAgentToggle");
  if (multiAgentBtn) {
    multiAgentBtn.addEventListener("click", function () {
      setTimeout(function () {
        var target = rsToggleTarget(slot ? slot.childElementCount > 0 : false);
        if (target) activate(target);
      }, 80);
    });
  }

  // Force the historical first tab only when a strip already exists. With the runtime-rendered
  // strip this is a no-op by construction: panel-host's apply() has already restored `st.tab`
  // (including a persisted "status"), and overriding that here is the "I clicked activity once and
  // now every open starts on activity" class of bug.
  if (readTabs().length) activate(RS_INITIAL_TAB);
})();
