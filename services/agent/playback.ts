/**
 * Time-ordered playback for an agent run's lines.
 *
 * Adapted from Ephemeral-AI-Lab/dsh-layerfs (MIT):
 *   packages/client/src/client/playback.ts
 *
 * The original plays LayerFS SDK trace lines in step with a live run: each line
 * shows LAG_MS after the call ended, so on-screen gaps are the run's own gaps;
 * lines whose time has passed apply at once, so a tab opened late catches up
 * instead of replaying an old run in slow motion. This module keeps that
 * contract for OwnChat's `TraceLine` shape and owns no clock or timer: `now`,
 * `setTimer` and `clearTimer` are ports, which is what lets tests drive it
 * with a fake clock.
 *
 * A line is `{ id, start, ms }`, with `start` on the same clock as `now` and
 * `ms` the call's duration. Feed end lines only; start lines are the running
 * set's input, not playback's.
 * @module services/agent/playback
 */

/** Matches dsh-layerfs: longer than the Host poll, so a call is usually here before its time. */
export const LAG_MS = 2000;

export interface PlaybackLine {
  id?: string | number;
  start?: number;
  ms?: number;
  [key: string]: unknown;
}

export interface PlaybackPorts {
  /** Epoch ms on the same clock as each line's `start`. */
  now?: () => number;
  /** Schedule `fn` after `ms`; returns whatever `clearTimer` accepts. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Milliseconds a line waits after the call ended (default LAG_MS). */
  lagMs?: number;
  /** The one draw hook: called once per line, in due order. */
  onStep?: (line: PlaybackLine, playback: PlaybackApi) => void | Promise<void>;
}

export interface QueuedStep {
  line: PlaybackLine;
  due: number;
}

export interface PlaybackApi {
  readonly waiting: number;
  readonly played: number;
  readonly seen: Set<string>;
  readonly done: Set<string>;
  readonly queue: QueuedStep[];
  unplayed(lines: PlaybackLine[]): PlaybackLine[];
  feed(lines: PlaybackLine[]): Promise<void>;
  stop(): void;
  reset(): void;
  play(): Promise<void>;
}

/** When a line shows: LAG_MS after the call ended, by the same clock as `start`. */
export function dueOf(line: PlaybackLine, lagMs?: number): number {
  const lag = typeof lagMs === "number" && Number.isFinite(lagMs) ? lagMs : LAG_MS;
  return Number(line.start || 0) + Number(line.ms || 0) + lag;
}

/**
 * Build a playback over the ports. The returned object exposes the queue and
 * the two sets for a view's note line and running markers; `feed` is the only
 * way lines enter.
 */
export function createPlayback(ports: PlaybackPorts = {}): PlaybackApi {
  const now = typeof ports.now === "function" ? ports.now : function (): number { return Date.now(); };
  const setTimer = typeof ports.setTimer === "function"
    ? ports.setTimer
    : function (fn: () => void, ms: number): unknown { return setTimeout(fn, ms); };
  const clearTimer = typeof ports.clearTimer === "function"
    ? ports.clearTimer
    : function (handle: unknown): void {
        // Browser setTimeout returns a number; a non-number handle belongs to a
        // host that supplied setTimer, and only that host knows how to clear it.
        if (typeof handle === "number") clearTimeout(handle);
      };
  const lagMs = typeof ports.lagMs === "number" && Number.isFinite(ports.lagMs) ? ports.lagMs : LAG_MS;
  const onStep = typeof ports.onStep === "function" ? ports.onStep : function (): void {};

  const seen = new Set<string>();
  const done = new Set<string>();
  const queue: QueuedStep[] = [];
  let running = false;
  let stopped = false;
  let timer: unknown = null;
  let wake: (() => void) | null = null;
  let played = 0;

  function wakeUp(): void {
    if (wake) wake();
  }

  function until(due: number): Promise<void> {
    const left = due - now();
    if (left <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timer != null) {
          clearTimer(timer);
          timer = null;
        }
        wake = null;
        resolve();
      };
      timer = setTimer(finish, left);
      wake = finish;
    });
  }

  async function play(): Promise<void> {
    if (running) return;
    running = true;
    try {
      while (queue.length && !stopped) {
        await until(queue[0].due);
        if (stopped) return;
        const at = now();
        while (queue.length && queue[0].due <= at && !stopped) {
          const step = queue.shift();
          if (!step) break;
          const key = String(step.line.id);
          done.add(key);
          played++;
          await onStep(step.line, api);
        }
      }
    } finally {
      running = false;
    }
  }

  const api: PlaybackApi = {
    get waiting(): number {
      return queue.length;
    },
    get played(): number {
      return played;
    },
    seen,
    done,
    queue,
    unplayed(lines: PlaybackLine[]): PlaybackLine[] {
      return (Array.isArray(lines) ? lines : []).filter((line) => line && line.id != null && !done.has(String(line.id)));
    },
    feed(lines: PlaybackLine[]): Promise<void> {
      const ordered = (Array.isArray(lines) ? lines : []).slice();
      ordered.sort((a, b) => dueOf(a, lagMs) - dueOf(b, lagMs));
      for (const line of ordered) {
        if (!line || line.id == null) continue;
        const key = String(line.id);
        if (seen.has(key)) continue;
        seen.add(key);
        const due = Math.max(
          dueOf(line, lagMs),
          queue.length ? queue[queue.length - 1].due : 0,
        );
        queue.push({ line, due });
      }
      wakeUp();
      return play();
    },
    stop(): void {
      stopped = true;
      queue.length = 0;
      wakeUp();
    },
    reset(): void {
      stopped = false;
      seen.clear();
      done.clear();
      queue.length = 0;
      played = 0;
    },
    play,
  };
  return api;
}
