/**
 * Reply pacing: the three settings behind "don't answer instantly", the debounce window that folds a
 * burst of messages into one reply, and who speaks first in a group chat.
 *
 * The debounce exists for rhythm, not for throttling: every send only lands in the session, the timer
 * restarts while the user keeps typing, and the model is called once they stop. The typing row appears
 * PACING_TYPING_LEAD_MS before the reply is due, so a message sent mid-window never leaves a stale
 * "typing" row behind.
 *
 * Delays are clamped to PACING_MAX_DELAY_MS: the setting is a free-text number, and a value in the
 * minutes reads as a hang rather than as pacing.
 *
 * Timers, the typing row and the storage reads stay in the wiring; this module only decides.
 *
 * @module services/ui/pacing
 */

export const PACING_LS_ENABLED = "cfw_reply_pacing_v1";
export const PACING_LS_DELAY = "cfw_reply_pacing_delay_v1";
export const PACING_LS_GROUP_ONLINE = "cfw_group_online_mode_v1";

export const PACING_DEFAULT_DELAY_MS = 2200;
export const PACING_MAX_DELAY_MS = 15000;
/** Random spread added to the base delay, so replies do not land on a metronome. */
export const PACING_JITTER_MS = 800;
/** How long the typing row is shown before the reply fires. */
export const PACING_TYPING_LEAD_MS = 1200;
/** Re-check interval while the conversation is still busy answering. */
export const PACING_BUSY_RETRY_MS = 700;
export const PACING_TYPING_TEXT = "正在输入···";

/**
 * `all` answers as the active character; `subset` lets one random scene character open, and an empty
 * cast means nobody does.
 */
export type PacingMode = "all" | "subset";

/**
 * Anything but an explicit "0" keeps pacing on, including a missing key — that is what a fresh
 * install looks like, and the feature is on by default.
 */
export function pacingEnabledFrom(raw: string | null | undefined): boolean {
  const value = raw === null || raw === undefined ? "1" : raw;
  return value === "1";
}

/**
 * Non-numeric input falls back to the default instead of disabling the wait, and the result never
 * goes negative.
 */
export function pacingDelayFrom(raw: string | null | undefined): number {
  const value = raw === null || raw === undefined ? String(PACING_DEFAULT_DELAY_MS) : raw;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return PACING_DEFAULT_DELAY_MS;
  return Math.max(0, Math.min(PACING_MAX_DELAY_MS, parsed));
}

export function pacingGroupOnlineMode(raw: string | null | undefined): PacingMode {
  return raw === "subset" ? "subset" : "all";
}

/** A send with neither text nor attachments queues nothing — there would be nothing to answer. */
export function pacingShouldQueue(text: string, attCount: number): boolean {
  return text.trim().length > 0 || attCount > 0;
}

/**
 * Repeated @-mentions of one character collapse into a single call, preserving first-mention order.
 * Id-less cards are dropped: the call path keys characters by id, so such a card cannot be answered
 * as anyone.
 */
export function pacingDedupeCards<T extends { id?: unknown }>(cards: readonly (T | null | undefined)[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const card of cards) {
    if (!card) continue;
    const id = card.id;
    if (!id) continue;
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(card);
  }
  return out;
}

/**
 * Random pick from the scene cast, optionally skipping the character that already answered. Returns
 * null on an empty pool, which the caller reads as "nobody is online".
 *
 * `rand` is injected so the pick is reproducible under test; the index is clamped because a
 * non-standard generator returning 1 would otherwise read past the end.
 */
export function pacingPickOnlineCard<T extends { id?: unknown }>(
  cards: readonly (T | null | undefined)[],
  excludeId: string | null,
  rand: () => number,
): T | null {
  const pool: T[] = [];
  for (const card of cards) {
    if (!card) continue;
    if (excludeId !== null && String(card.id ?? "") === excludeId) continue;
    pool.push(card);
  }
  if (pool.length === 0) return null;
  const index = Math.floor(rand() * pool.length);
  return pool[Math.min(index, pool.length - 1)];
}

export interface PacingTiming {
  /** When the model is actually called. */
  delay: number;
  /** When the typing row appears; clamped at 0, so a short delay shows it immediately. */
  typingAt: number;
}

export function pacingTiming(baseDelay: number, rand: () => number): PacingTiming {
  const delay = baseDelay + Math.floor(rand() * PACING_JITTER_MS);
  return { delay, typingAt: Math.max(0, delay - PACING_TYPING_LEAD_MS) };
}

/** The typing row's text; an empty label leaves only the bare indicator. */
export function pacingTypingText(label: string | null | undefined): string {
  const prefix = typeof label === "string" && label.length > 0 ? label + " " : "";
  return prefix + PACING_TYPING_TEXT;
}

export interface PacingReplyPlan<T> {
  /** One entry per call, in order; null means "answer as the active character". */
  cards: (T | null)[];
  /** Who the relay continues as after the last reply; null when the caller must not relay. */
  speaker: T | null;
  /** False for a one-to-one conversation — pacing never relays there. */
  relay: boolean;
}

/**
 * Who answers a queued send. A group with @-mentions answers each mentioned character in turn;
 * without mentions, `subset` lets one random online character open and `all` keeps the active one
 * (and stays silent about the card, so the engine keeps its own default).
 *
 * The per-call early exits (conversation switched mid-loop, a null reply from one character) stay
 * with the caller: they depend on what each call returns, which a plan cannot know.
 */
export function pacingReplyPlan<T extends { id?: unknown }>(input: {
  group: boolean;
  targets: readonly (T | null | undefined)[] | null;
  mode: PacingMode;
  activeCard: T | null;
  cards: readonly (T | null | undefined)[] | null;
  rand: () => number;
}): PacingReplyPlan<T> {
  if (!input.group) return { cards: [null], speaker: null, relay: false };
  const targets = pacingDedupeCards(input.targets || []);
  if (targets.length > 0) {
    const last = targets[targets.length - 1];
    return { cards: targets.slice(), speaker: last, relay: true };
  }
  const first = input.mode === "subset" ? pacingPickOnlineCard(input.cards || [], null, input.rand) : null;
  return { cards: [first], speaker: first ?? input.activeCard, relay: true };
}
