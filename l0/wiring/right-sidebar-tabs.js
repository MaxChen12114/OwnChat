// Browser adapter, appended by l0/emit.mjs. Engine: services/ui/right-sidebar-tabs.ts; this file
// owns the DOM and the three automatic switches (boot pass, console mount, topbar button). No
// global is published: the strip's contract is the DOM, and the old implicit `agentConsoleSlot`
// global was never read (its apparent consumer resolves the slot itself).
//
// The boot pass waits 900 ms because the console slot is filled by scripts that run after this one;
// reading child counts immediately would always see an empty right sidebar.
(function () {
  "use strict";
  var rs = document.getElementById("rightSidebar");
  if (!rs) return;
  var tabs = rs.querySelectorAll(".rs-tab");
  var panels = rs.querySelectorAll(".rs-panel");
  var slot = document.getElementById("fishbowlSlot");
  // This used to be an accidental global (assignment without var) pointing at the agent console
  // slot; nothing ever read it off `window`, so it stays local now.
  var consoleSlot = document.getElementById("agentConsoleSlot");

  var tabNames = [];
  var panelNames = [];
  for (var i = 0; i < tabs.length; i++) tabNames.push(tabs[i].getAttribute("data-rs-tab"));
  for (var j = 0; j < panels.length; j++) panelNames.push(panels[j].getAttribute("data-rs-panel"));

  function activate(name) {
    var view = rsTabPlan(tabNames, panelNames, name);
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
  }

  function bindTab(tab) {
    tab.addEventListener("click", function () {
      activate(tab.getAttribute("data-rs-tab"));
    });
  }
  for (var k = 0; k < tabs.length; k++) bindTab(tabs[k]);

  // Since 2026-11-09 the activity column holds only the agent timeline, which is empty until an
  // agent has run: landing there on load showed a blank right sidebar whenever a group chat existed.
  setTimeout(function () {
    try {
      var target = rsBootTab(
        consoleSlot ? consoleSlot.childElementCount : null,
        slot ? slot.childElementCount : null,
      );
      if (target) activate(target);
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

  activate(RS_INITIAL_TAB);
})();
