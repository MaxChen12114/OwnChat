/**
 * Welcome-screen rules: desktop detection, the time-of-day greeting and the empty-chat count.
 * The wiring owns the DOM classes, the MutationObserver and the click handlers.
 *
 * The chat container always holds structural spacer/welcome nodes; counting every child would
 * keep the empty state hidden forever. Mobile desktop flags are caller-supplied so the same
 * predicate can be asserted without a Tauri runtime.
 * @module services/ui/welcome-greeting
 */

export const WGR_DISMISS_KEY = "cfw_welcome_dismissed_v1";

/** @returns the greeting for a local hour in [0, 23]. */
export function wgrGreeting(hour: number): string {
  if (hour < 5) return "夜深了";
  if (hour < 11) return "上午好";
  if (hour < 13) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

/** @returns whether the page runs inside a desktop shell. */
export function wgrIsDesktop(
  flags: { tauri: boolean; internals: boolean; isTauri: boolean; metadata: boolean },
  ua: string,
  protocol: string,
  hostname: string,
): boolean {
  return !!(
    flags.tauri || flags.internals || flags.isTauri || flags.metadata
    || /Tauri/i.test(ua) || protocol === "tauri:" || hostname === "tauri.localhost"
  );
}

/** @returns the number of real message rows, ignoring the two structural children. */
export function wgrChatCount(ids: (string | null | undefined)[]): number {
  let n = 0;
  for (const id of ids) if (id !== "bottom-spacer" && id !== "ownchatWelcome") n++;
  return n;
}

/** @returns whether the welcome screen should be shown. */
export function wgrIsEmpty(count: number): boolean {
  return count === 0;
}
