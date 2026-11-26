/**
 * Host-shell decisions for the chat engine: restoring a session array, normalizing the prior
 * summary and the background-flush debounce.
 *
 * These are the three rules inside app.js that are not DOM and not transport: a restore must refuse
 * while a turn is live, the summary is always a string (null/undefined become ""), and the
 * visibility/pagehide flush is coalesced to one call per two seconds. The shell keeps the session
 * variable, the renderer, localStorage and the sync push. Prior-summary storage (per-conversation
 * table plus the legacy key) belongs to `services/conv/summary.ts`; this module only normalizes the
 * in-memory mirror.
 * @module services/chat/app
 */

/** @returns The summary as a string; null/undefined mean "no summary". */
export function normalizePriorSummary(text: unknown): string {
  return text == null ? "" : String(text);
}

/** The restore decision: a live turn or a non-array input means "refuse". */
export type RestoreSessionPlan =
  | { readonly ok: false }
  | { readonly ok: true; readonly messages: unknown[] };

/**
 * Decide whether a checkpoint's message array may replace the live session.
 *
 * @param messages - Candidate array from the checkpoint.
 * @param activeTurn - Whether the active conversation has a turn in flight.
 * @param renderable - The context module's `toRenderableMessages`, applied to a copy.
 * @returns The refusal, or the renderable copy to install.
 */
export function restoreSessionPlan(
  messages: unknown,
  activeTurn: boolean,
  renderable: (messages: unknown[]) => unknown[],
): RestoreSessionPlan {
  if (!Array.isArray(messages)) return { ok: false };
  if (activeTurn) return { ok: false };
  return { ok: true, messages: renderable(messages.slice()) };
}

/**
 * @param last - Timestamp of the previous flush (0 when never).
 * @param now - Current timestamp.
 * @param windowMs - Coalescing window; defaults to the 2s used by the pagehide flush.
 * @returns Whether this flush should run.
 */
export function flushDue(last: number, now: number, windowMs: number = 2000): boolean {
  return now - last >= windowMs;
}
