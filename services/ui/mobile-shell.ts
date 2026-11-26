/**
 * The mobile shell's decisions, minus the DOM: when a scroll gesture should hide or reveal the top
 * and bottom bars, where the topbar overflow menu opens, and whether a click outside it closes it.
 *
 * These rules only look trivial. The "not scrollable" branch exists because `#topbar` is
 * `position: sticky` and hiding it with `translateY(-110%)` does not give back the height it holds in
 * the flex flow, so a short conversation — or a session restored by `scrollToBottom()`, which looks
 * like a downward gesture — leaves an empty slot sitting on top of the text. Content that cannot
 * scroll therefore always shows the bar, and a programmatic jump resets the baseline instead of being
 * read as a scroll.
 *
 * The wiring owns the scroll listener, the rAF throttle, `matchMedia` and the real node moves; it
 * calls in here for every decision.
 * @module services/ui/mobile-shell
 */

/** Movement (px) below which a scroll event is treated as jitter and ignored. */
export const MS_SCROLL_THRESHOLD = 8;

/** Content shorter than the viewport by less than this counts as "not scrollable". */
export const MS_SCROLLABLE_SLACK = 80;

/** Within this distance from the top the bars always stay visible. */
export const MS_TOP_EDGE = 40;

/** The overflow menu never hugs the viewport edge closer than this. */
export const MS_MENU_MIN_LEFT = 8;

/** Fallback menu width when it has not been laid out yet (`offsetWidth` is 0 before first paint). */
export const MS_MENU_DEFAULT_WIDTH = 160;

/** Vertical gap between the "more" button and its menu. */
export const MS_MENU_GAP = 6;

/** What a scroll event means for the bars. `none` = below the jitter threshold, leave `lastY` alone. */
export type ScrollAction = "show" | "hide" | "none";

/** A viewport rectangle, as `getBoundingClientRect()` reports it. */
export interface MsRect {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}

/** True while the container has enough content to scroll (by more than the slack). */
export function msIsScrollable(scrollHeight: number, clientHeight: number, slack: number = MS_SCROLLABLE_SLACK): boolean {
  return scrollHeight - clientHeight >= slack;
}

/**
 * Decide what one scroll position means. Order matters: an unscrollable container wins over
 * everything (that is the empty-slot fix), jitter changes nothing, the top edge always shows, and
 * only a genuine downward move hides.
 */
export function msScrollAction(y: number, lastY: number, scrollable: boolean): ScrollAction {
  if (!scrollable) return "show";
  if (Math.abs(y - lastY) < MS_SCROLL_THRESHOLD) return "none";
  if (y < MS_TOP_EDGE) return "show";
  return y > lastY ? "hide" : "show";
}

/** Where the overflow menu goes: under the button, right-aligned, never past the left edge. */
export function msMenuPosition(rect: MsRect, menuWidth: number, scrollX: number, scrollY: number): { top: number; left: number } {
  const bottom = typeof rect.bottom === "number" ? rect.bottom : 0;
  const right = typeof rect.right === "number" ? rect.right : 0;
  const width = menuWidth || MS_MENU_DEFAULT_WIDTH;
  return {
    top: bottom + scrollY + MS_MENU_GAP,
    left: Math.max(MS_MENU_MIN_LEFT, right - width) + scrollX,
  };
}

/** An open menu closes on any click that is neither inside it nor on its button. */
export function msMenuShouldClose(open: boolean, insideMenu: boolean, onButton: boolean): boolean {
  return open && !insideMenu && !onButton;
}

/** Which topbar layout applies at the current width. */
export function msLayout(narrow: boolean): "menu" | "inline" {
  return narrow ? "menu" : "inline";
}
