/**
 * Retry policy for a failed single agent call: classify, budget, back off, and word the final error.
 *
 * The purest module in the chat domain — no window, no localStorage, no timers — so it needs no
 * ports at all: it exports plain functions and l0/wiring/retry.js binds the frozen `__retry` name
 * straight to them. The old IIFE's re-entry guard (`__retry.v===1` means skip) lives in the wiring
 * layer. Sending the request and driving the watchdogs still happen in app.js.
 *
 * Behaviour is 1:1 with the old file, function by function: the constant table, tag masking,
 * classify levels, the total-time gate on budget, exponential backoff with jitter, whyText and the
 * finalError wording. scripts/test-retry-policy.mjs and test/call-loop.test.mjs prove it.
 *
 * Sources kept from the migration notes:
 *   - DSH @deepseek-ai/dsh-llm retry-policy.js: maxRetries=5, backoff 500ms doubling to 10s, ±10%
 *     jitter, retryable codes limited to EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT.
 *   - ZCode readNextWithStreamIdleTimeout: the idle window grows 30s with each retry.
 * @module services/chat/retry
 */

/** Routable error carrier: machine codes ride on the error object, the message is never parsed. */
export interface RetryError {
  message?: unknown;
  name?: string;
  __httpStatus?: number;
  __retryCode?: string;
}

/** Input for classify/finalError: a real error object or a string, since callers may throw strings. */
export type RetryInput = RetryError | string | null | undefined;

/** Watchdog flags: whether this failure was cut by the idle or the total watchdog (highest precedence). */
export interface WatchdogFlags {
  idle?: boolean;
  total?: boolean;
}

/** Input bundle for finalError: code, retries already spent, the original error, timeout details. */
export interface FinalErrorInput {
  code?: string;
  attempt?: number;
  err?: RetryInput;
  idleTimedOut?: boolean;
  idleMs?: number;
  totalTimedOut?: boolean;
  capMs?: number;
}

export const cfg = {
  IDLE_MS: 90 * 1000,        // silence window for a single "wait for the next event"
  TOTAL_MS: 180 * 1000,      // hard ceiling per turn; idle alone cannot catch a stream that never closes
  RETRY_MAX: 4,              // 4 retries beyond the first attempt, i.e. DSH maxRetries 5
  BASE_MS: 800,              // backoff base
  CAP_MS: 10 * 1000,         // backoff ceiling
  IDLE_STEP_MS: 30 * 1000,   // each retry widens the idle window by 30s (ZCode rule)
  EMPTY_STREAK_MAX: 120,     // ceiling on consecutive empty-delta events ("events but no content" false liveness)
};

/** Only these are worth retrying: DSH retryableCodes plus ZCode's nqa/rqa. */
const RETRYABLE: Record<string, number> = {
  TIMEOUT: 1,
  TRANSPORT: 1,
  EMPTY_RESPONSE: 1,
  SERVER: 1,
  RATE_LIMIT: 1,
};

/** Attach a machine-routable code to an error. Routing is by code; the message is never parsed. */
export function tag(e: RetryInput, code: string): RetryInput {
  try {
    if (e && typeof e === "object" && !e.__retryCode) e.__retryCode = code;
  } catch (_e) {}
  return e;
}

/**
 * Classify a failure. `flags` says whether a watchdog cut this attempt; the watchdog wins because an
 * abort-shaped error looks like AbortError and the message alone cannot tell them apart.
 * @param e - the thrown value, object or string.
 * @param flags - watchdog flags for this attempt.
 * @returns One of TIMEOUT / RATE_LIMIT / SERVER / INVALID_REQUEST / TRANSPORT / UNKNOWN.
 */
export function classify(e: RetryInput, flags?: WatchdogFlags): string {
  if (flags && (flags.idle || flags.total)) return "TIMEOUT";
  const t = e && typeof e === "object" ? e.__retryCode : undefined;
  if (t) return t;
  const st = (e && typeof e === "object" && e.__httpStatus) || 0;
  if (st === 429) return "RATE_LIMIT";
  if (st >= 500) return "SERVER";
  if (st >= 400) return "INVALID_REQUEST"; // 4xx is not retried: the request itself is wrong, resending just pays twice
  const m = String((e && typeof e === "object" && e.message) || e);
  // undici reports a broken stream as TypeError: network error / fetch failed
  if ((e && typeof e === "object" && e.name === "TypeError") || /\bnetwork\b|fetch failed|ECONNRESET|EPIPE|ETIMEDOUT|socket hang up/i.test(m)) return "TRANSPORT";
  return "UNKNOWN";
}

export function isRetryable(code: string | null | undefined): boolean {
  return !!(code && RETRYABLE[code]);
}

/**
 * How many retries this attempt may still spend. The total-time gate means the whole turn failed to
 * finish within three minutes, so resending as-is will most likely hit the same ceiling and pay
 * twice; it gets exactly one chance.
 * @param attempt - retries already spent.
 * @param totalTimedOut - whether the total watchdog fired.
 * @returns The remaining retry allowance for this attempt.
 */
export function budget(attempt: number, totalTimedOut?: boolean): number {
  return (!totalTimedOut || attempt < 1) ? cfg.RETRY_MAX : 0;
}

/**
 * Backoff: exponential growth with ±10% jitter, capped at 10s (the same formula as DSH's localDelay).
 * @param attempt - retries already spent; the exponent.
 * @param rand - injectable random source for tests.
 * @returns Milliseconds to wait before the next attempt.
 */
export function delay(attempt: number, rand?: () => number): number {
  const r = typeof rand === "function" ? rand() : Math.random();
  const base = Math.min(cfg.BASE_MS * Math.pow(2, attempt), cfg.CAP_MS);
  return Math.min(base * (0.9 + r * 0.2), cfg.CAP_MS);
}

/** The short phrase shown in the toast: upstream timed out / returned nothing / was cut. */
export function whyText(code: string): string {
  return code === "TIMEOUT" ? "超时" : code === "EMPTY_RESPONSE" ? "空响应" : "中断";
}

/**
 * What to throw once retries are exhausted.
 * @param o - code, retries spent, the original error and timeout details.
 * @returns A tagged error describing the failure, or the original value when attempt is 0 and this
 * was not a timeout, so the caller handles the original error as-is.
 */
export function finalError(o: FinalErrorInput): RetryInput {
  o = o || {};
  const code = o.code;
  const attempt = o.attempt || 0;
  const e = o.err;
  if (code === "TIMEOUT" && o.idleTimedOut) {
    return tag(new Error("上游 " + Math.round((o.idleMs || 0) / 1000) + " 秒无响应（静默卡死），重试 " + attempt + " 次仍失败"), code);
  }
  if (code === "TIMEOUT" && o.totalTimedOut) {
    return tag(new Error("本轮调用超过 " + Math.round((o.capMs || 0) / 60000) + " 分钟（流未关闭），重试 " + attempt + " 次仍失败"), code);
  }
  if (attempt > 0) {
    return tag(new Error(String((e && typeof e === "object" && e.message) || e) + "（已重试 " + attempt + " 次）"), code);
  }
  return e;
}
