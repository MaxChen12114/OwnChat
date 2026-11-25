/**
 * The chat-area interaction rules that used to live inside DOM event handlers, extracted so the
 * arithmetic can be locked by tests and the wiring layer stays a pure DOM adapter.
 *
 * The turn-deletion plan is the part worth locking. Row order in the DOM is NOT the session index:
 * agent tool rounds fold into the assistant row that follows them, so a naive `allRows.indexOf`
 * truncates/deletes the wrong messages and leaves dangling tool_calls on disk (the root cause of
 * "every request 400s after restart"). Rows carry `data-sidx` (written by the renderer) and the
 * plan prefers it, falling back to DOM indices only for pre-sidx data. The delete spans one full
 * turn: the anchor's nearest preceding user row through just before the next user row.
 *
 * Resend restores the ORIGINAL message text from the session, not the bubble text: the bubble only
 * holds file chips, and truncating on a chip-only rebuild would permanently drop attachment
 * payloads. A textless resend is still allowed when the original message carries attachments.
 *
 * Scroll following: track to bottom when the user is within FOLLOW_DIST of it, stay out of the way
 * while they read, yield completely while a touch/wheel gesture is active (TOUCH_WINDOW_MS after
 * the last gesture event) because a per-character smooth scroll fight reads as input lag.
 * @module services/ui/chat-ux
 */

/** localStorage key the desktop welcome page writes on dismiss. Cleared on boot so dismissal lasts
 * one session only; the wiring layer also clears it one tick after a close click to override the
 * synchronous write index.html performs inline. */
export const CHATUX_WELCOME_DISMISSED_KEY = "cfw_welcome_dismissed_v1";

/** Distance (px) from the bottom inside which new messages keep auto-following. */
export const CHATUX_FOLLOW_DIST = 60;

/** After a touch/wheel/pointer gesture, auto-follow stays suppressed this long (ms). */
export const CHATUX_TOUCH_WINDOW_MS = 500;

/** One row as the plan sees it: user vs AI, and the session index the renderer stamped on it. */
export interface UxRow {
  isUser: boolean;
  sidx: number | null;
}

/** What the wiring layer must remove and what it must tell the session to delete. */
export interface TurnDeletePlan {
  /** Inclusive first row of the turn (the user row). */
  startIdx: number;
  /** Exclusive end row of the turn. */
  endIdx: number;
  /** First argument for session delete: a session index when bySession, else a DOM index. */
  start: number;
  /** Second argument: message count to delete, always >= 1. */
  count: number;
  /** True when both endpoints carry valid sidx values and the session length was known. */
  bySession: boolean;
}

/** Parse a `data-sidx` attribute. Valid non-negative integers win; anything else yields the
 * fallback (which may itself be null, meaning "unknown"). */
export function chatUxParseSidx(raw: unknown, fallback: number | null): number | null {
  const v = typeof raw === "string" ? parseInt(raw, 10) : NaN;
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** Compute the delete plan for one turn. Returns null when the anchor is out of range — the caller
 * must then do nothing at all, not "delete one row", so a stale anchor can never clip the session. */
export function chatUxPlanTurnDelete(
  rows: UxRow[],
  anchorIdx: number,
  sessionLen: number | null,
): TurnDeletePlan | null {
  if (anchorIdx < 0 || anchorIdx >= rows.length) return null;
  let startIdx = anchorIdx;
  for (let i = anchorIdx; i >= 0; i--) {
    if (rows[i].isUser) {
      startIdx = i;
      break;
    }
  }
  let endIdx = rows.length;
  for (let i = startIdx + 1; i < rows.length; i++) {
    if (rows[i].isUser) {
      endIdx = i;
      break;
    }
  }
  const startSidx = rows[startIdx].sidx;
  if (startSidx !== null && sessionLen !== null) {
    let endSidx: number = sessionLen;
    for (let i = endIdx; i < rows.length; i++) {
      if (rows[i].isUser) {
        const v = rows[i].sidx;
        if (v !== null) endSidx = v;
        break;
      }
    }
    return {
      startIdx,
      endIdx,
      start: startSidx,
      count: Math.max(1, endSidx - startSidx),
      bySession: true,
    };
  }
  return {
    startIdx,
    endIdx,
    start: startIdx,
    count: Math.max(1, endIdx - startIdx),
    bySession: false,
  };
}

/** Text a resend should put back into the composer: the original session content when it is a
 * string, else the bubble text (pre-sidx rows may lack a retrievable original). */
export function chatUxResendText(
  msg: Record<string, unknown> | null,
  bubbleText: string,
): string {
  const content = msg ? msg["content"] : undefined;
  return typeof content === "string" ? content : bubbleText;
}

/** A textless resend gives up only when the original message carries no attachments either —
 * otherwise retrying an attachments-only message would silently do nothing. */
export function chatUxResendShouldGiveUp(
  msg: Record<string, unknown> | null,
  userText: string,
): boolean {
  if (userText) return false;
  if (!msg) return true;
  const files = Array.isArray(msg["files"]) ? msg["files"] : [];
  const images = Array.isArray(msg["images"]) ? msg["images"] : [];
  return files.length === 0 && images.length === 0;
}

/** The stop button is only visible while its row is the active stream. */
export function chatUxIsStreaming(streamingAttr: unknown): boolean {
  return streamingAttr === "1";
}

/** Whether new content should pull the view to the bottom: the user was already at the bottom
 * (autoScroll) and still is within FOLLOW_DIST of it. */
export function chatUxShouldFollow(distFromBottom: number, autoScroll: boolean): boolean {
  return autoScroll && distFromBottom < CHATUX_FOLLOW_DIST;
}

/** Extend the gesture-suppression window. The window only ever moves forward, so a flood of
 * passive scroll events cannot push the deadline past TOUCH_WINDOW_MS after the latest gesture. */
export function chatUxNextTouchUntil(currentUntil: number, now: number): number {
  const until = now + CHATUX_TOUCH_WINDOW_MS;
  return until > currentUntil ? until : currentUntil;
}

/** True while a gesture is still holding the scroll position (now strictly before the deadline). */
export function chatUxIsTouchActive(touchUntil: number, now: number): boolean {
  return now < touchUntil;
}
