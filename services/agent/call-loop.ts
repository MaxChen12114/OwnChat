/**
 * Retry loop for one model call: classify the failure, decide whether to send again, wait, and —
 * while the call is in flight — run two watchdogs.
 *
 * The idle watchdog aborts an attempt that produced no data for N seconds (a retryable timeout).
 * The total watchdog aborts a turn that has run past M minutes and allows only one retry, because
 * a second attempt is likely to hit the same wall.
 *
 * Telling a user stop apart from an unresponsive upstream is the whole reason for the
 * `idleTimedOut` / `totalTimedOut` flags: both surface as an AbortError, but the first must be
 * rethrown untouched and never retried, while the second must be retried.
 *
 * Only the call itself is here. The retry policy facade is resolved once at create time — a
 * missing one is a programming error that throws at the same point the classic script did — and
 * the AbortController constructor is a port so tests can inject a fake one. setTimeout and
 * clearTimeout are platform globals and are not ported.
 *
 * `create(host)` keeps its historical shape: `signal` (the user's stop), `callOnce(messages,
 * schemas, ctx)` where ctx carries the per-attempt signal, `armIdle()` to re-arm the idle window
 * on real data, `idleMs` and `attempt`; `onRetry` / `onResetLive` for UI notification; and `sleep`
 * so the tests do not wait out a real backoff.
 * @module services/agent/call-loop
 */

export interface RetryFlags {
  idle: boolean;
  total: boolean;
}

export interface FinalErrorArgs {
  code: string;
  attempt: number;
  idleMs: number;
  capMs: number;
  idleTimedOut: boolean;
  totalTimedOut: boolean;
  err: unknown;
}

/** Only the six members this module actually calls; the full policy lives in the retry service. */
export interface RetryFacade {
  cfg: { IDLE_MS: number; IDLE_STEP_MS: number; TOTAL_MS: number };
  classify(e: unknown, flags: RetryFlags): string;
  isRetryable(code: string): boolean;
  budget(attempt: number, totalTimedOut: boolean): number;
  delay(attempt: number): number;
  finalError(o: FinalErrorArgs): unknown;
}

export type AbortControllerCtor = new () => { signal: AbortSignal; abort(): void };

export interface CallLoopEnv {
  /** Retry policy facade, resolved once at create time. */
  retry(): RetryFacade;
  /** AbortController constructor, used when the host does not override it. */
  abortController(): AbortControllerCtor;
}

export interface CallCtx {
  signal: AbortSignal;
  armIdle(ms?: number): void;
  idleMs: number;
  attempt: number;
}

export interface CallLoopHost {
  signal?: AbortSignal | null;
  /** Required on purpose: without it the call is undefined and JS throws "callOnce is not a
   *  function" by itself — same error, same moment as before, with no extra runtime guard. */
  callOnce(messages: unknown, schemas: unknown, ctx: CallCtx): Promise<unknown>;
  onRetry?(attempt: number, code: string): void;
  onResetLive?(): void;
  sleep?(ms: number): Promise<void>;
  AbortController?: AbortControllerCtor;
}

export interface CallLoopApi {
  call(messages: unknown, schemas: unknown): Promise<unknown>;
}

export interface CallLoopFactory {
  v: 1;
  create(host?: CallLoopHost): CallLoopApi;
}

/** Placeholder for "no host at all": it throws the sentence the native failure would. A host
 *  that is passed but lacks callOnce still fails natively, without going through this stub. */
function missingCallOnce(): Promise<unknown> {
  throw new TypeError("callOnce is not a function");
}

export function createCallLoop(env: CallLoopEnv): CallLoopFactory {
  function create(host?: CallLoopHost): CallLoopApi {
    const h: CallLoopHost = host || { callOnce: missingCallOnce };
    const R = env.retry();
    const signal = h.signal || null;
    const callOnce = h.callOnce;
    const onRetry = typeof h.onRetry === "function" ? h.onRetry : function () {};
    const onResetLive = typeof h.onResetLive === "function" ? h.onResetLive : function () {};
    const sleep = typeof h.sleep === "function" ? h.sleep
      : function (ms: number) { return new Promise<void>(function (r) { setTimeout(r, ms); }); };
    const NewCtrl: AbortControllerCtor = h.AbortController || env.abortController();

    async function call(messages: unknown, schemas: unknown): Promise<unknown> {
      for (let attempt = 0; ; attempt++) {
        const ctrl = new NewCtrl();
        let idleTimedOut = false;
        let totalTimedOut = false;
        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        let totalTimer: ReturnType<typeof setTimeout> | null = null;

        // A host abort must stay distinguishable from a watchdog abort: only the latter retries.
        const onHostAbort = function () { try { ctrl.abort(); } catch (e) {} };
        if (signal) {
          if (signal.aborted) onHostAbort();
          else { try { signal.addEventListener("abort", onHostAbort, { once: true }); } catch (e) {} }
        }

        const idleMs = R.cfg.IDLE_MS + attempt * R.cfg.IDLE_STEP_MS; // each retry widens the window by 30s
        const capMs = R.cfg.TOTAL_MS + attempt * R.cfg.IDLE_STEP_MS;
        const armIdle = function (ms?: number) {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(function () {
            idleTimedOut = true;
            try { ctrl.abort(); } catch (e) {}
          }, ms || R.cfg.IDLE_MS);
        };
        const disarmIdle = function () { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };
        const disarmTotal = function () { if (totalTimer) { clearTimeout(totalTimer); totalTimer = null; } };

        armIdle(idleMs);
        totalTimer = setTimeout(function () {
          totalTimedOut = true;
          try { ctrl.abort(); } catch (e) {}
        }, capMs);

        try {
          return await callOnce(messages, schemas, {
            signal: ctrl.signal, armIdle: armIdle, idleMs: idleMs, attempt: attempt,
          });
        } catch (e) {
          disarmIdle();
          disarmTotal();
          // The user pressed stop: no retry.
          if (signal && signal.aborted && !idleTimedOut && !totalTimedOut) throw e;
          const code = R.classify(e, { idle: idleTimedOut, total: totalTimedOut });
          const budget = R.budget(attempt, totalTimedOut);
          if (!R.isRetryable(code) || attempt >= budget) {
            // Budget exhausted: throw the human-readable reason so the kernel can close gracefully.
            throw R.finalError({
              code: code, attempt: attempt, idleMs: idleMs, capMs: capMs,
              idleTimedOut: idleTimedOut, totalTimedOut: totalTimedOut, err: e,
            });
          }
          const delay = R.delay(attempt);
          onResetLive();
          try { onRetry(attempt, code); } catch (_nt) {}
          // The backoff wait honours stop too (the old version ignored it for up to ten seconds).
          // With a host signal it uses a cancellable timer, so an abort settles immediately and
          // leaves nothing pending; without one (unit tests) it uses the injectable sleep.
          if (signal) {
            await new Promise<void>(function (r) {
              const t = setTimeout(done, delay);
              function done() {
                try { clearTimeout(t); } catch (_e) {}
                try { signal.removeEventListener("abort", done); } catch (_e) {}
                r();
              }
              try { signal.addEventListener("abort", done, { once: true }); } catch (_e) {}
            });
            if (signal.aborted) throw e;
          } else {
            await sleep(delay);
          }
        } finally {
          disarmIdle();
          disarmTotal();
          if (signal) { try { signal.removeEventListener("abort", onHostAbort); } catch (e2) {} }
        }
      }
    }

    return { call: call };
  }

  return { v: 1, create: create };
}
