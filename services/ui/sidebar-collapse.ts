/**
 * Desktop left-sidebar collapse rules: stored value, viewport override, toggle result and button
 * state. The wiring owns the class toggling, animation and event listeners.
 *
 * Mobile always forces the sidebar open: the collapsed state is a desktop narrow-ridge state, and
 * restoring it on a phone leaves the drawer as a single icon column with no group headings.
 * @module services/ui/sidebar-collapse
 */

export const SBC_KEY = "cfw_left_collapsed_v1";

/** @returns whether the stored flag means collapsed. */
export function sbcStoredOn(raw: unknown): boolean {
  return raw === "1";
}

/** @returns the state for the current viewport. */
export function sbcViewportOn(isMobile: boolean, raw: unknown): boolean {
  return isMobile ? false : sbcStoredOn(raw);
}

/** @returns the state after a toggle click. */
export function sbcNextOn(current: boolean): boolean {
  return !current;
}

/** @returns the value to persist. */
export function sbcStoredValue(on: boolean): string {
  return on ? "1" : "0";
}

/** @returns the aria-expanded value and the tooltip for a state. */
export function sbcButtonState(on: boolean): { expanded: string; title: string } {
  return {
    expanded: on ? "false" : "true",
    title: on ? "展开侧栏" : "折叠侧栏（收起成一条）",
  };
}
