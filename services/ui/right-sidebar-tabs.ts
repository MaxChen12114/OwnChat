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
export const RS_INITIAL_TAB = "fishbowl";

/** Tab that the group-chat console belongs to. */
export const RS_CHAT_TAB = "chat";

/** Tab the topbar multi-agent button reveals. */
export const RS_FISHBOWL_TAB = "fishbowl";

export interface RsTabView {
  name: string;
  active: boolean;
  ariaSelected: "true" | "false";
  /** True only for the selected tab: the unread dot is cleared by looking at it. */
  clearActivity: boolean;
}

export interface RsPanelView {
  name: string;
  active: boolean;
  hidden: boolean;
}

export interface RsView {
  tabs: RsTabView[];
  panels: RsPanelView[];
}

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
export function rsTabPlan(tabNames: string[], panelNames: string[], name: string): RsView {
  const tabs: RsTabView[] = [];
  for (const n of tabNames) {
    const on = n === name;
    tabs.push({ name: n, active: on, ariaSelected: on ? "true" : "false", clearActivity: on });
  }
  const panels: RsPanelView[] = [];
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
export function rsBootTab(actCount: number | null, chatCount: number | null): string | null {
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
export function rsSlotChange(wasEmpty: boolean, nowEmpty: boolean): "activate-chat" | "mark-activity" | "none" {
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
export function rsToggleTarget(hasConsole: boolean): string | null {
  return hasConsole ? RS_FISHBOWL_TAB : null;
}
