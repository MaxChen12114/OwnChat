/**
 * Multi-agent orchestration settings: three access switches and three numeric caps shared by the
 * settings card (write side in settings.js) and the peer-call engine (read side in
 * services/agent/peer-calls.ts).
 *
 * The two sides used to spell out the same clamp independently — and disagreed on one default:
 * settings.js painted `meetingMax = 3` while peer-calls read `6`, so the number shown in the card
 * was not the number the engine ran with. All six keys, their defaults and their clamp ranges now
 * live here once; both sides consume this module. DOM refs, labels and status text stay in the card.
 *
 * Switch semantics are deliberately "absent = on": an untouched key means the gate is open, so
 * returning users never have to visit the card before the features work. Writes materialise that
 * as an explicit "1"/"0". Numeric caps clamp on both read and write; a dirty value falls back to
 * the documented default rather than leaking NaN into a billing-sensitive call count.
 *
 * Zero window, zero casts: storage arrives through {@link MultiAgentPorts}, and the wiring owns the
 * try/catch around localStorage. Every port call is guarded, matching the card's old safe reads.
 * @module services/ui/settings-multi-agent
 */

export const MA_DELEGATE_KEY = "cfw_ma_delegate_v1";
export const MA_MEETING_KEY = "cfw_ma_meeting_v1";
export const MA_INVITE_KEY = "cfw_ma_invite_v1";
export const MA_MEET_MAX_KEY = "cfw_ma_meeting_max_v1";
export const MA_MEET_ROUNDS_KEY = "cfw_ma_meeting_rounds_v1";
export const MA_CTX_MSGS_KEY = "cfw_ma_ctx_msgs_v1";

/** Storage port; structurally identical to the other settings service ports. */
export interface MultiAgentPorts {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface MultiAgentSwitch {
  id: string;
  key: string;
}

export interface MultiAgentCap {
  id: string;
  key: string;
  def: number;
  lo: number;
  hi: number;
}

/** The three access switches, in card order, for the write-side loop. */
export const SWITCHES: MultiAgentSwitch[] = [
  { id: "maDelegate", key: MA_DELEGATE_KEY },
  { id: "maMeeting", key: MA_MEETING_KEY },
  { id: "maInvite", key: MA_INVITE_KEY },
];

/** The three numeric caps. `meetingMax` defaults to 3 here and in the engine — the old drift is gone. */
export const CAPS: MultiAgentCap[] = [
  { id: "maMeetMax", key: MA_MEET_MAX_KEY, def: 3, lo: 1, hi: 6 },
  { id: "maMeetRounds", key: MA_MEET_ROUNDS_KEY, def: 1, lo: 1, hi: 2 },
  { id: "maCtxMsgs", key: MA_CTX_MSGS_KEY, def: 60, lo: 0, hi: 400 },
];

export interface MultiAgentState {
  delegate: boolean;
  meeting: boolean;
  invite: boolean;
  meetingMax: number;
  meetingRounds: number;
  ctxMsgs: number;
}

export interface MultiAgentApi {
  /** A switch is on unless its key was explicitly written as "0". */
  readSwitch(key: string): boolean;
  writeSwitch(key: string, on: boolean): void;
  /** Clamp a cap from stored text; dirty values fall back to the documented default. */
  readCap(key: string, def: number, lo: number, hi: number): number;
  writeCap(key: string, value: unknown, def: number, lo: number, hi: number): number;
  /** The engine's full config object — byte-identical to peer-calls.cfg()'s three numbers. */
  engineConfig(): { meetingMax: number; meetingRounds: number; ctxMsgs: number };
}

/** Absent switch means on; only an explicit "0" turns it off. */
export function normalizeSwitch(raw: string | null): boolean {
  return raw !== "0";
}

/** Strict cap parse: a missing or non-numeric value uses `def`, anything else clamps into [lo, hi]. */
export function normalizeCap(raw: string | null, def: number, lo: number, hi: number): number {
  const n = typeof raw === "string" ? parseInt(raw, 10) : NaN;
  return isNaN(n) ? def : Math.max(lo, Math.min(hi, n));
}

function safeGet(ports: MultiAgentPorts, key: string): string | null {
  try {
    return ports.getItem(key);
  } catch (e) {
    return null;
  }
}

function safeSet(ports: MultiAgentPorts, key: string, value: string): void {
  try {
    ports.setItem(key, value);
  } catch (e) {
  }
}

export function createSettingsMultiAgent(ports: MultiAgentPorts): MultiAgentApi {
  return {
    readSwitch: (key) => normalizeSwitch(safeGet(ports, key)),
    writeSwitch: (key, on) => safeSet(ports, key, on ? "1" : "0"),
    readCap: (key, def, lo, hi) => normalizeCap(safeGet(ports, key), def, lo, hi),
    writeCap: (key, value, def, lo, hi) => {
      const n = normalizeCap(typeof value === "string" ? value : String(value), def, lo, hi);
      safeSet(ports, key, String(n));
      return n;
    },
    engineConfig: () => ({
      meetingMax: normalizeCap(safeGet(ports, MA_MEET_MAX_KEY), 3, 1, 6),
      meetingRounds: normalizeCap(safeGet(ports, MA_MEET_ROUNDS_KEY), 1, 1, 2),
      ctxMsgs: normalizeCap(safeGet(ports, MA_CTX_MSGS_KEY), 60, 0, 400),
    }),
  };
}
