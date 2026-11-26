(function () {
/**
 * Right sidebar tab strip rules: which tab is selected, which panel is revealed, and the three
 * automatic switches the strip performs on its own.
 *
 * Everything here is a decision about *when the selection moves*, not how the buttons look. Three
 * paths move it without a tap: the 900 ms boot pass (the activity column is empty until an agent has
 * run, so an empty activity column with a populated group-chat column lands on "chat" instead of
 * showing a blank right sidebar), the group-chat console mounting into its slot, and the topbar
 * multi-agent button. The middle one also has a non-moving case — the console re-rendering while
 * its tab is already selected just marks activity instead of stealing focus, otherwise a busy group
 * chat would yank the user out of the panel they are reading.
 * @module services/ui/right-sidebar-tabs
 */

/** Tab selected on load: the group chat panel, with its empty-state hint. */
const RS_INITIAL_TAB = "fishbowl";

/** Tab that the group-chat console belongs to. */
const RS_CHAT_TAB = "chat";

/** Tab the topbar multi-agent button reveals. */
const RS_FISHBOWL_TAB = "fishbowl";

                            
               
                  
                                 
                                                                                    
                         
 

                              
               
                  
                  
 

                         
                    
                        
 

/**
 * Selection state for every tab and panel after selecting `name`.
 *
 * @param tabNames Every tab's `data-rs-tab`, in DOM order.
 * @param panelNames Every panel's `data-rs-panel`, in DOM order.
 * @param name The tab to select. An unknown name is not rejected — it selects nothing and hides
 * every panel, which is the same state the strip is in before the first `activate`.
 * @returns Per-element desired state; `hidden` is attribute presence, so `false` means the
 * attribute must be removed rather than set to `"false"`.
 */
function rsTabPlan(tabNames          , panelNames          , name        )         {
  const tabs              = [];
  for (const n of tabNames) {
    const on = n === name;
    tabs.push({ name: n, active: on, ariaSelected: on ? "true" : "false", clearActivity: on });
  }
  const panels                = [];
  for (const n of panelNames) {
    const on = n === name;
    panels.push({ name: n, active: on, hidden: !on });
  }
  return { tabs, panels };
}

/**
 * Tab the boot pass should switch to, if any.
 *
 * @param actCount Child count of the agent console slot; `null` when the slot is absent.
 * @param chatCount Child count of the group-chat slot; `null` when the slot is absent.
 * @returns `"chat"` when the activity column is empty and the group chat has content, otherwise
 * `null` — meaning leave the initial selection alone rather than forcing a switch.
 */
function rsBootTab(actCount               , chatCount               )                {
  const actEmpty = actCount === null || actCount === 0;
  const chatHas = chatCount !== null && chatCount > 0;
  return actEmpty && chatHas ? RS_CHAT_TAB : null;
}

/**
 * What a change in the group-chat slot's child count means for the selection.
 *
 * @param wasEmpty Slot child count before the mutation.
 * @param nowEmpty Slot child count after it.
 * @returns `"activate-chat"` on the empty→filled edge (the console just mounted, so show it or the
 * image panel keeps covering it); `"mark-activity"` when it changed while already filled (keep the
 * user's panel, light the unread dot instead); `"none"` when it emptied or did not change.
 */
function rsSlotChange(wasEmpty         , nowEmpty         )                                             {
  if (nowEmpty && !wasEmpty) return "activate-chat";
  if (nowEmpty && wasEmpty) return "mark-activity";
  return "none";
}

/**
 * Tab the topbar multi-agent button should reveal.
 *
 * @param hasConsole Whether the console slot currently holds children.
 * @returns The group-chat tab when the console is mounted, otherwise `null` — toggling multi-agent
 * with nothing mounted must not move the selection.
 */
function rsToggleTarget(hasConsole         )                {
  return hasConsole ? RS_FISHBOWL_TAB : null;
}

// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/ui/right-sidebar-tabs.ts; this file
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

globalThis.RS_INITIAL_TAB = RS_INITIAL_TAB;
globalThis.RS_CHAT_TAB = RS_CHAT_TAB;
globalThis.RS_FISHBOWL_TAB = RS_FISHBOWL_TAB;
globalThis.rsTabPlan = rsTabPlan;
globalThis.rsBootTab = rsBootTab;
globalThis.rsSlotChange = rsSlotChange;
globalThis.rsToggleTarget = rsToggleTarget;
})();
