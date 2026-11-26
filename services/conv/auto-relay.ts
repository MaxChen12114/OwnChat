/**
 * Auto-relay decisions: who speaks next and how long the group waits.
 *
 * The relay loop itself (sendOne, typing, cancellation) stays in app.js. What moves here are the
 * small rules that decide: the `[召唤:X]` tag name, the random barge pick that never repeats the
 * last speaker, the subset "nobody picks it up" drop, and the three delay formulas (subset random,
 * paced all-mode, fixed 600ms). Keeping them pure makes the pacing rules reviewable and stops the
 * three formulas from being edited in place one at a time.
 * @module services/conv/auto-relay
 */

const SUMMON_RE = /\[召唤[:：]\s*([^\]\n]+?)\s*\]/;

/** @returns The trimmed name inside `[召唤:X]`, or null when the reply has no tag. */
export function summonName(reply: unknown): string | null {
  if (!reply) return null;
  const m = SUMMON_RE.exec(String(reply));
  if (!m) return null;
  const name = m[1].trim();
  return name ? name : null;
}

function recOf(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value);
    for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  }
  return out;
}

/**
 * Pick a random speaker among the scene cards, never the last speaker.
 *
 * @param cards - Scene cards.
 * @param lastCardId - The last speaker's id, or null/undefined for the first turn.
 * @param random - A value in [0, 1); the caller passes `Math.random()`.
 * @returns The chosen card, or null when no other card exists.
 */
export function pickBargeCard(cards: readonly unknown[], lastCardId: unknown, random: number): unknown | null {
  const others: unknown[] = [];
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    if (!card) continue;
    if (lastCardId != null && recOf(card)["id"] === lastCardId) continue;
    others.push(card);
  }
  if (!others.length) return null;
  const idx = Math.min(others.length - 1, Math.max(0, Math.floor(random * others.length)));
  return others[idx];
}

/**
 * In subset ("real online") mode, after the second turn there is a 25% chance nobody picks the
 * conversation up and the relay ends.
 *
 * @param streak - Completed turns (already incremented for the current one).
 * @param random - A value in [0, 1).
 * @returns Whether the relay should stop.
 */
export function subsetDrops(streak: number, random: number): boolean {
  return streak >= 2 && random < 0.25;
}

/**
 * Waiting time before the next speaker starts.
 *
 * - subset: 700ms + 0..1899ms random.
 * - all-mode with pacing: 60%..130% of the base delay, at least 700ms.
 * - otherwise: fixed 600ms.
 *
 * @param input.subset - Subset mode.
 * @param input.pacing - Pacing switch (all-mode only).
 * @param input.baseDelay - Base pacing delay in ms.
 * @param input.random - A value in [0, 1).
 * @returns Delay in milliseconds.
 */
export function relayDelayMs(input: {
  subset: boolean;
  pacing: boolean;
  baseDelay: number;
  random: number;
}): number {
  if (input.subset) return 700 + Math.floor(input.random * 1900);
  if (input.pacing) return Math.max(700, Math.round(input.baseDelay * (0.6 + input.random * 0.7)));
  return 600;
}
