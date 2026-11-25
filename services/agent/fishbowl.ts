/**
 * The fishbowl discussion engine's rules, minus the loop: tag parsing, name matching, speaker
 * selection (round-robin with AI-named relay), round limits and the humanized reaction delay.
 *
 * The selection rule is where the history lives. AI-named relay (`[next:X]`) works in both discuss
 * and relay modes — it used to be ai-pick-only, but that strategy has no UI and `[next:X]` was being
 * ignored, which is what "叫人叫不出来" was. Relay adoption is capped: more than MAX_RELAY_STREAK
 * consecutive named hand-offs falls back to round-robin, so two participants cannot hog the floor.
 * A hint is consumed once, and pointing at yourself counts as a miss.
 *
 * Name matching goes exact → normalized (decorations, punctuation, whitespace, case) → bidirectional
 * containment, and both sides must be at least two normalized characters — a single character would
 * match half the cast.
 * @module services/agent/fishbowl
 */

export const FISHBOWL_LS_MODE = "cfw_fishbowl_mode_v1";
export const FISHBOWL_LS_TOPIC = "cfw_fishbowl_topic_v1";
export const FISHBOWL_LS_MAX = "cfw_fishbowl_max_rounds_v1";
export const FISHBOWL_LS_STRATEGY = "cfw_fishbowl_strategy_v1";

export const FISHBOWL_MAX_PARTICIPANTS = 6;
/** 1000 instead of 30: effectively no cap, only a guard against a runaway loop burning money. */
export const FISHBOWL_MAX_ROUNDS_HARD = 1000;
export const FISHBOWL_DEFAULT_MAX_ROUNDS = 8;
export const FISHBOWL_MAX_RELAY_STREAK = 5;
export const FISHBOWL_TICK_SLEEP_MS = 800;

export const FISHBOWL_MODES = ["orchestrate", "relay", "discuss"];
export const FISHBOWL_STRATEGIES = ["round-robin", "ai-pick"];

export interface FishbowlTags {
  next: string | null;
  end: boolean;
  summon: string | null;
}

/**
 * `[next:X]` hands the floor to X, `[召唤:X]` summons an off-scene character (and wins over next),
 * `[end]` stops early. The engine parses but does not strip for display — chat-ux owns stripping,
 * same mechanism as the affinity tags.
 */
export function parseTags(text: unknown): FishbowlTags {
  const tags: FishbowlTags = { next: null, end: false, summon: null };
  if (typeof text !== "string") return tags;
  const m = text.match(/\[next[\:：]\s*([^\]\n]+?)\s*\]/);
  if (m) tags.next = m[1].trim();
  const sm = text.match(/\[召唤[\:：]\s*([^\]\n]+?)\s*\]/);
  if (sm) tags.summon = sm[1].trim();
  if (/\[end\]/i.test(text)) tags.end = true;
  return tags;
}

/** Strip decorations, brackets, punctuation, whitespace and case from a display name. */
export function normName(s: unknown): string {
  return String(s == null ? "" : s)
    .replace(/[【】\[\]（）()「」『』"'`’‘“”\s,，.。!！?？~～·\-—_]/g, "")
    .toLowerCase();
}

export function matchByName(parts: unknown, hint: unknown): unknown | null {
  const list = Array.isArray(parts) ? parts : [];
  const raw = String(hint == null ? "" : hint).trim();
  if (!raw || !list.length) return null;
  let hit = list.filter((c) => nameOf(c) === raw)[0];
  if (hit) return hit;
  const nh = normName(raw);
  if (!nh) return null;
  hit = list.filter((c) => normName(nameOf(c)) === nh)[0];
  if (hit) return hit;
  hit = list.filter((c) => {
    const cn = normName(nameOf(c));
    if (!cn || cn.length < 2 || nh.length < 2) return false;
    return cn.indexOf(nh) >= 0 || nh.indexOf(cn) >= 0;
  })[0];
  return hit || null;
}

function nameOf(c: unknown): string {
  const r = c && typeof c === "object" ? (c as Record<string, unknown>) : {};
  return String(r.name || "");
}

export interface RelayState {
  speakerIndex: number;
  relayStreak: number;
}

export interface PickResult {
  speaker: unknown | null;
  /** Next round-robin cursor; synced to just after a relayed speaker. */
  speakerIndex: number;
  relayStreak: number;
  /** Whether the `[next:X]` hint was consumed this round. */
  hintUsed: boolean;
}

/**
 * Pick who speaks next. The hint is consumed exactly once per call, whether or not it leads to a
 * relay — a stale hint must not haunt later rounds.
 */
export function pickSpeaker(
  mode: string,
  parts: unknown,
  hint: unknown,
  lastSpeaker: string | null,
  st: RelayState
): PickResult {
  const list = Array.isArray(parts) ? parts : [];
  let index = st.speakerIndex;
  let streak = st.relayStreak;
  let hintUsed = false;

  if ((mode === "discuss" || mode === "relay") && hint) {
    hintUsed = true;
    if (streak < FISHBOWL_MAX_RELAY_STREAK) {
      const hit = matchByName(list, hint);
      if (hit && nameOf(hit) !== lastSpeaker) {
        streak += 1;
        const hi = list.indexOf(hit);
        if (hi >= 0) index = hi + 1;
        return { speaker: hit, speakerIndex: index, relayStreak: streak, hintUsed: hintUsed };
      }
      // Miss, or the hint points at the previous speaker: fall into round-robin.
    }
    // Relay streak exhausted: forced round-robin.
  }
  streak = 0;
  const p = list[index % list.length] || null;
  index += 1;
  return { speaker: p, speakerIndex: index, relayStreak: streak, hintUsed: hintUsed };
}

/** Default 8; hard cap exists only to stop a runaway loop from burning money. */
export function clampMaxRounds(n: unknown): number {
  const v = Math.min(FISHBOWL_MAX_ROUNDS_HARD, Math.max(1, parseInt(String(n), 10) || FISHBOWL_DEFAULT_MAX_ROUNDS));
  return v;
}

export function storedMaxRounds(raw: unknown): number {
  const n = parseInt(String(raw == null ? "" : raw), 10);
  if (isNaN(n) || n < 1) return FISHBOWL_DEFAULT_MAX_ROUNDS;
  return Math.min(FISHBOWL_MAX_ROUNDS_HARD, Math.max(1, n));
}

export function validMode(m: unknown): boolean {
  return FISHBOWL_MODES.indexOf(String(m)) >= 0;
}

export function validStrategy(s: unknown): boolean {
  return FISHBOWL_STRATEGIES.indexOf(String(s)) >= 0;
}

/**
 * The humanized reaction delay: 0.7x–1.5x of the base with a 500ms floor. `rand` is injected so the
 * range is testable; the wiring passes Math.random().
 */
export function reactionDelayMs(baseMs: number, rand: number): number {
  const base = Math.max(0, Math.min(15000, isFinite(baseMs) ? baseMs : 0));
  return Math.max(500, Math.round(base * (0.7 + rand * 0.8)));
}

/** Which side of the wechat split a speaker sits on: odd index in the scene = right. */
export function sideFor(sceneIds: unknown, id: unknown): string | null {
  const ids = Array.isArray(sceneIds) ? sceneIds : [];
  const idx = ids.indexOf(id);
  return idx >= 0 && idx % 2 === 1 ? "right" : null;
}
