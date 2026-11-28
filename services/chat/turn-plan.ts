/**
 * Turn plan: the pure decisions `sendOne` / `sendOneAgent` used to take inline.
 *
 * What lives here is *which* turn runs, what its request needs and when compaction is attempted —
 * never the request itself. The send paths keep the DOM, the bubbles and the streaming; they ask
 * this module first and then execute the returned plan. That split is what makes the old behaviour
 * testable without a page: every input below is a snapshot the caller already has.
 *
 * Deliberate non-decisions:
 *  - Model usability is *echoed*, not gated. The old flow built the user bubble first and refused
 *    after, so a plan that refused up front would change the transcript.
 *  - The compaction watermark (token ratio) is not re-computed; `attempt` only says the cheap gates
 *    passed. The runner owns the watermark and the pairing-safe cutoff.
 *  - Retry budgets are copied from the caller's policy; services/chat/retry.ts remains their home.
 *
 * @module services/chat/turn-plan
 */

/** Why a send was refused before any turn was created. */
export type SendRefusal = "" | "conv-busy" | "empty-input";

/** Why compaction is or is not attempted for this turn. */
export type CompactReason = "ok" | "disabled" | "history-off" | "too-short" | "tool-exchange";

/** The retry budget the caller's call-loop uses; echoed so the plan is self-describing. */
export interface RetryPolicy {
  max: number;
  idleMs: number;
  emptyStreakMax: number;
}

/** What the caller knows about the compaction gate at send time. */
export interface CompactGate {
  enabled: boolean;
  historyEnabled: boolean;
  sessionLength: number;
  /** A last message that is a tool call or a tool result: never compact underneath a live exchange. */
  endsInToolExchange: boolean;
}

export interface SendInput {
  kind: "chat" | "agent";
  /** `opts.text != null` — an engine-driven send owns the input box. */
  isAuto: boolean;
  text: string;
  hasAttachments: boolean;
  allowEmptyText: boolean;
  /** `isConvSending(activeConvId())`. */
  convBusy: boolean;
  /** `isAgentModeOn()`; consulted for `kind:"chat"` only. */
  agentMode: boolean;
  /** `ensureUsableModelBeforeSend` result; echoed, the caller refuses at the old point. */
  modelUsable: boolean;
  compact: CompactGate;
  agentMaxRounds: number;
  /** `cfw_tool_mode_v1` resolved to its two states (the runner still owns the catalog). */
  toolMode: "full" | "directory";
  visionOn: boolean;
  retry: RetryPolicy;
}

export interface SendPlan {
  ok: boolean;
  reason: SendRefusal;
  kind: "chat" | "agent";
  /** `kind:"chat"` with agent mode on: the caller hands off to the agent send path. */
  delegate: boolean;
  text: string;
  isAuto: boolean;
  /** A user bubble and a session push happen when text or attachments exist. */
  buildUserRow: boolean;
  /** False for engine-driven sends (the input box is not ours to clear). */
  clearInput: boolean;
  compact: { attempt: boolean; reason: CompactReason };
  model: { usable: boolean };
  agent: { maxRounds: number; toolMode: "full" | "directory"; vision: boolean };
  retry: RetryPolicy;
}

export interface CancelInput {
  /** `abortCurrent(true)` — retry / delete / fishbowl stop: the partial is explicitly discarded. */
  discardPartial: boolean;
}

export interface CancelPlan {
  abort: boolean;
  discard: boolean;
  /** The half-stream stays visible and is written back as a complete reply (stop button). */
  keepPartial: boolean;
  clearPartialStream: boolean;
  clearPartialText: boolean;
  /** Set `_discardPartialFlag` so the abort fallback does not resurrect a truncated reply. */
  markDiscardFlag: boolean;
}

export interface RetryInput {
  policy: RetryPolicy;
  /** 0-based attempt that just failed. */
  attempt: number;
  retryable: boolean;
}

export interface RetryDecision {
  retry: boolean;
  nextAttempt: number;
  max: number;
}

function numOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function strOf(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

/** The cheap compaction gates; the watermark and the tool-pair boundary stay in the runner. */
export function compactGateOf(gate: CompactGate): { attempt: boolean; reason: CompactReason } {
  if (!gate || gate.enabled !== true) return { attempt: false, reason: "disabled" };
  if (gate.historyEnabled !== true) return { attempt: false, reason: "history-off" };
  if (numOr(gate.sessionLength, 0) <= 4) return { attempt: false, reason: "too-short" };
  if (gate.endsInToolExchange === true) return { attempt: false, reason: "tool-exchange" };
  return { attempt: true, reason: "ok" };
}

/**
 * The turn plan. `ok:false` means "no turn is created"; the caller returns its old falsy value.
 * A `delegate` plan keeps `ok:true` and the caller forwards to the agent path, which plans again —
 * that is intentional: the agent path has its own refusal reasons (mid-turn model switch).
 */
export function planSend(input: SendInput): SendPlan {
  const kind: "chat" | "agent" = input && input.kind === "agent" ? "agent" : "chat";
  const text = strOf(input && input.text).trim();
  const isAuto = !!(input && input.isAuto);
  const hasAttachments = !!(input && input.hasAttachments);
  const gateInput: CompactGate = (input && input.compact) || { enabled: false, historyEnabled: false, sessionLength: 0, endsInToolExchange: false };
  const compact = compactGateOf(gateInput);
  const policy = (input && input.retry) || { max: 0, idleMs: 0, emptyStreakMax: 0 };
  const retry: RetryPolicy = {
    max: numOr(policy.max, 0),
    idleMs: numOr(policy.idleMs, 0),
    emptyStreakMax: numOr(policy.emptyStreakMax, 0),
  };
  const agent: SendPlan["agent"] = {
    maxRounds: numOr(input && input.agentMaxRounds, 8),
    toolMode: input && input.toolMode === "directory" ? "directory" : "full",
    vision: !!(input && input.visionOn),
  };
  const base: SendPlan = {
    ok: false,
    reason: "",
    kind: kind,
    delegate: false,
    text: text,
    isAuto: isAuto,
    buildUserRow: false,
    clearInput: false,
    compact: compact,
    model: { usable: !!(input && input.modelUsable) },
    agent: agent,
    retry: retry,
  };
  if (input && input.convBusy === true) return Object.assign(base, { reason: "conv-busy" });
  if (kind === "chat" && input && input.agentMode === true) {
    // The agent path re-plans; only its own gates can refuse it.
    return Object.assign(base, { ok: true, delegate: true, buildUserRow: true, clearInput: !isAuto });
  }
  if (!text && !(input && input.allowEmptyText === true) && !hasAttachments) {
    return Object.assign(base, { reason: "empty-input" });
  }
  return Object.assign(base, {
    ok: true,
    buildUserRow: !!(text || hasAttachments),
    clearInput: !isAuto,
  });
}

/** The cancellation policy. Retry/delete discard the partial; stop keeps it as a full reply. */
export function planCancel(input: CancelInput): CancelPlan {
  const discard = !!(input && input.discardPartial);
  return {
    abort: true,
    discard: discard,
    keepPartial: !discard,
    clearPartialStream: discard,
    clearPartialText: discard,
    markDiscardFlag: discard,
  };
}

/** The retry decision the call-loop makes after a failed attempt. */
export function planRetry(input: RetryInput): RetryDecision {
  const policy: RetryPolicy = (input && input.policy) || { max: 0, idleMs: 0, emptyStreakMax: 0 };
  const attempt = Math.max(0, Math.floor(numOr(input && input.attempt, 0)));
  const max = Math.max(0, Math.floor(numOr(policy.max, 0)));
  const retry = !!(input && input.retryable === true) && attempt + 1 < max;
  return { retry: retry, nextAttempt: attempt + 1, max: max };
}
