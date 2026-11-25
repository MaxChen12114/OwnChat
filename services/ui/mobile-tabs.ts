/**
 * Mobile bottom tab strip rules: which tab is lit, which panel shows, and whether the group-chat
 * body flag is on.
 *
 * The fishbowl tab is a toggle rather than a selection, and since 4.47 so is every other tab: a
 * second tap on the lit tab folds the panel away. That is why the plan always describes the
 * *whole* strip instead of the clicked button — collapsing and switching share the same "everything
 * off, then maybe one on" shape, and only the clicked button's state decides which one applies.
 *
 * The body flag is part of the plan, not the caller's business: `body.fishbowl-shown` drives panel
 * display in CSS, so any path that leaves the fishbowl switched off MUST clear it. Keeping it in
 * one return value is what stops "opened the image tab but the group chat is still painted on top".
 * @module services/ui/mobile-tabs
 */

/** Tab id that toggles instead of selecting. Also the only tab whose state lives on `body`. */
export const MT_FISHBOWL = "fishbowl";

/** The strip after one tap: per-tab lit state, per-panel shown state, and the body flag. */
export interface MtView {
  tabs: Record<string, boolean>;
  panels: Record<string, boolean>;
  fishbowlShown: boolean;
}

/**
 * Apply one tap to the strip.
 *
 * @param tabNames Every tab button's `data-tab`, in DOM order.
 * @param panelNames Every panel's `data-tab`, in DOM order. Panels are matched by id, so a tab
 * without a panel simply lights up and shows nothing.
 * @param clicked The tapped tab's `data-tab`.
 * @param wasActive Whether that tab was already lit. Ignored tabs (`disabled`) must be filtered by
 * the caller — a disabled tap never reaches this function.
 * @returns The full desired strip state. `tabs` and `panels` are exhaustive over the inputs, so a
 * caller can apply them without reading the DOM first. Tapping a non-fishbowl tab always clears
 * `fishbowlShown`, tapping a lit tab clears everything.
 */
export function mtTabPlan(
  tabNames: string[],
  panelNames: string[],
  clicked: string,
  wasActive: boolean,
): MtView {
  const view: MtView = { tabs: {}, panels: {}, fishbowlShown: false };
  for (const n of tabNames) view.tabs[n] = false;
  for (const n of panelNames) view.panels[n] = false;

  if (clicked === MT_FISHBOWL) {
    const on = !wasActive;
    if (Object.prototype.hasOwnProperty.call(view.tabs, MT_FISHBOWL)) view.tabs[MT_FISHBOWL] = on;
    view.fishbowlShown = on;
    return view;
  }

  // A lit tab folds away; an unlit one selects and takes the fishbowl flag down with it.
  if (wasActive) return view;
  if (Object.prototype.hasOwnProperty.call(view.tabs, clicked)) view.tabs[clicked] = true;
  if (Object.prototype.hasOwnProperty.call(view.panels, clicked)) view.panels[clicked] = true;
  return view;
}
