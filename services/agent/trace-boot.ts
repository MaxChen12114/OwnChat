/**
 * Agent trace boot: installs the kernel trace decorator once both sides are alive.
 *
 * The kernel is an ES module that lands on `window.AgentKernel` after every classic script, so
 * the boot polls instead of racing load order: up to {@link MAX_TRIES} attempts
 * {@link RETRY_MS} apart, then an `installed: false` state so Console diagnostics can tell
 * "gave up" from "not yet". Idempotence lives in the wiring (an installed flag gates re-entry).
 * @module services/agent/trace-boot
 */

/** Diagnostics snapshot written for Console self-checks; never read by business logic. */
export interface TraceBootState {
  installed: boolean;
  kernel: boolean;
  trace: boolean;
  at: number;
}

/** Ports: the two sides, the state sink, the retry scheduler, DOM-readiness and the clock. */
export interface TraceBootPorts {
  getKernel(): unknown;
  getTrace(): unknown;
  setBootState(state: TraceBootState): void;
  schedule(fn: () => void, ms: number): void;
  now(): number;
}

/** Public surface; the retired diagnostics sink is the wiring's job. */
export interface TraceBootApi {
  /** One attempt; schedules up to {@link MAX_TRIES} retries while the kernel is missing. */
  install(): void;
}

/** Upper bound of poll attempts before giving up (40 × 100ms = 4s of grace). */
export const MAX_TRIES = 40;
/** Delay between attempts. */
export const RETRY_MS = 100;

/** unknown -> plain-object view (the standard bridge, local copy). */
function viewOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  return out;
}

/** Both sides present and the trace actually exposes the installer. */
export function installReady(kernel: unknown, trace: unknown): boolean {
  if (kernel === null || kernel === undefined) return false;
  const view = viewOf(trace);
  return view !== null && typeof view["installKernelTrace"] === "function";
}

/** Create the booter. Nothing runs until {@link TraceBootApi.install}; the wiring schedules it. */
export function createTraceBoot(ports: TraceBootPorts): TraceBootApi {
  let tries = 0;
  function install(): void {
    tries++;
    const kernel = ports.getKernel();
    const trace = ports.getTrace();
    if (installReady(kernel, trace)) {
      const view = viewOf(trace);
      const installer = view === null ? null : view["installKernelTrace"];
      if (typeof installer === "function") installer.call(trace, kernel);
      ports.setBootState({ installed: true, kernel: true, trace: true, at: ports.now() });
      return;
    }
    if (tries < MAX_TRIES) {
      ports.schedule(install, RETRY_MS);
      return;
    }
    ports.setBootState({
      installed: false,
      kernel: kernel !== null && kernel !== undefined,
      trace: trace !== null && trace !== undefined,
      at: ports.now(),
    });
  }
  return { install: install };
}
