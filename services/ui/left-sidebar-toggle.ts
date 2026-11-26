/**
 * Left-sidebar toggle: the mobile drawer open/close for the left navigation.
 *
 * The engine answers two decisions only — whether a sidebar tap should auto-close the drawer and
 * whether Escape closes it — plus the open/close class flips; every DOM lookup, listener and the
 * 60ms close delay arrive through {@link TogglePorts}, so the plan asserts in a vm without a
 * document. The close button is handled separately by its own listener and never double-fires.
 * @module services/ui/left-sidebar-toggle
 */

/** Ports: body class flips, media query, delegated closest lookup and the close scheduler. */
export interface TogglePorts {
  /** `body.classList.add("drawer-open")`. */
  drawerAdd(): void;
  /** `body.classList.remove("drawer-open")`. */
  drawerRemove(): void;
  /** `body.classList.contains("drawer-open")`. */
  drawerHas(): boolean;
  /** `window.matchMedia("(max-width: 1023px)").matches`. */
  matchesMobile(): boolean;
  /** `target.closest(selector)`; `null` when the tap missed every eligible button. */
  closest(target: unknown, selector: string): Record<string, unknown> | null;
  /** Delayed scheduler; the auto-close runs 60ms after the tap so the action lands first. */
  schedule(fn: () => void, ms: number): void;
}

/** Public surface; no frozen contract — the wiring binds everything at boot. */
export interface ToggleApi {
  open(): void;
  close(): void;
  /** Sidebar delegated click: auto-close on mobile taps of usable buttons, except the close button. */
  onSidebarClick(target: unknown): void;
  /** Escape closes an open drawer; anything else is ignored. */
  onKeydown(key: string): void;
  /** Bind nothing here — the wiring owns listeners; this only exposes the handlers. */
}

/** The selector the wiring feeds into {@link autoCloseDecision}; kept here so test and product agree. */
export const AUTO_CLOSE_SELECTOR = ".sidebar-btn:not([disabled]),.sidebar-close";

/**
 * Decide whether a sidebar tap auto-closes the drawer. Mobile-only; a tap that missed every
 * eligible button does nothing, and the dedicated close button is excluded (it closes itself).
 * @param matches - whether the mobile media query matches.
 * @param hit - the `closest` hit for {@link AUTO_CLOSE_SELECTOR}, `null` on a miss.
 * @returns `true` when the drawer should close after a 60ms delay.
 */
export function autoCloseDecision(matches: boolean, hit: Record<string, unknown> | null): boolean {
  if (!matches) return false;
  if (hit === null) return false;
  if (hit["id"] === "sidebarCloseBtn") return false;
  return true;
}

/** Create the handlers. Nothing is bound here; the wiring owns every listener. */
export function createLeftSidebarToggle(ports: TogglePorts): ToggleApi {
  function open(): void {
    ports.drawerAdd();
  }
  function close(): void {
    ports.drawerRemove();
  }
  function onSidebarClick(target: unknown): void {
    const hit = ports.closest(target, AUTO_CLOSE_SELECTOR);
    if (!autoCloseDecision(ports.matchesMobile(), hit)) return;
    ports.schedule(close, 60);
  }
  function onKeydown(key: string): void {
    if (key === "Escape" && ports.drawerHas()) close();
  }
  return { open: open, close: close, onSidebarClick: onSidebarClick, onKeydown: onKeydown };
}
