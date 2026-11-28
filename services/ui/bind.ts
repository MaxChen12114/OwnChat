/**
 * Declarative control-binding micro-primitives for settings cards. One call per control replaces
 * the hand-written five-step chain (find the element, reflect the stored value, attach the change
 * listener, write through the service, fall back to raw storage when the service is absent) that
 * every card used to spell out — including its per-control `if (svc) … else …` double paths.
 *
 * Two rules keep this testable despite touching controls: every DOM reach goes through the
 * injected {@link BindPorts} (the wiring passes the real document, tests pass a stub), and the
 * binders never throw on a missing control — they return `null`, because a stale selector must not
 * abort the whole card mount. Port calls are NOT wrapped here: the port is the boundary, and a
 * throwing port is a broken port (same posture as settings-gen-params, whose wiring owns the
 * try/catch around localStorage).
 *
 * Service-vs-fallback is encoded by the caller as the presence of `read`/`write`: the card
 * resolves its service once (`var svc = window.x || null`) and passes `svc ? fn : null`; the
 * binder picks the fallback pair when either service function is missing, skips the initial
 * reflection when the active getter is missing and skips the write when the active setter is
 * missing — degradation never throws.
 *
 * Echo contract: after a change the control is repainted with the effective value, so clamped
 * input visibly snaps back exactly as the hand-written loops did. The number binder echoes its own
 * normalized result on the fallback path and the service `write` return on the service path (the
 * service owns clamping there and must return the effective number).
 * @module services/ui/bind
 */

/** Structural surface of one control; a real input / select / textarea satisfies it. */
export interface BindEl {
  value: string;
  checked: boolean;
}

/** DOM port: the only surface the binders touch; the wiring injects the real document wrapper. */
export interface BindPorts {
  /** Find a control inside `root`; `null` when the root is unusable or the selector misses. */
  querySelector(root: unknown, selector: string): BindEl | null;
  /** Attach a change listener; the port owns the event name so tests can fire it directly. */
  listen(el: BindEl, fn: () => void): void;
}

/** Handle for a bound control; `refresh()` is the old `sync()` shape for external repaints. */
export interface BindHandle {
  el: BindEl;
  /** Re-read through the active path and repaint the control. */
  refresh(): void;
}

/** Options of {@link BindApi.bindToggle}: a boolean switch with a service path and a fallback. */
export interface ToggleBindOpts {
  /** Storage key the binding stands for; carried for diagnostics and onChange handlers. */
  key: string;
  /** Service path; `null` (either member) selects the fallback pair instead. */
  read: (() => boolean) | null;
  write: ((on: boolean) => void) | null;
  /** Fallback path, used when the service path is absent; polarity lives in the caller. */
  fallbackGet: (() => boolean) | null;
  fallbackSet: ((on: boolean) => void) | null;
  /** Called with the new value after every write, on both paths. */
  onChange: ((on: boolean) => void) | null;
}

/** Options of {@link BindApi.bindNumber}: blank/NaN falls back to `default`, then clamps. */
export interface NumberBindOpts {
  key: string;
  min: number;
  max: number;
  /** Default for blank, unparsable and missing stored values. */
  default: number;
  /** Raw-text parser; defaults to base-10 parseInt. */
  parse: ((raw: string) => number) | null;
  /** Service path: `read` returns the effective value, `write(raw)` returns the post-write value. */
  read: (() => number) | null;
  write: ((raw: string) => number) | null;
  /** Fallback path: raw stored text in, the binder owns parse + clamp + the stored text out. */
  fallbackGet: (() => string | null) | null;
  fallbackSet: ((text: string) => void) | null;
  onChange: ((v: number) => void) | null;
}

/** Options of {@link BindApi.bindText}: the string generalisation for text inputs and selects. */
export interface TextBindOpts {
  key: string;
  /** Service path; `write(raw)` returns the effective text, echoed into the control. */
  read: (() => string) | null;
  write: ((raw: string) => string) | null;
  /** Fallback path: the raw typed value is echoed back as-is (normalisation lives in the caller). */
  fallbackGet: (() => string) | null;
  fallbackSet: ((raw: string) => void) | null;
  onChange: ((v: string) => void) | null;
}

/** The three binders, bound to one port set. Published as a non-`__` global by the wiring. */
export interface BindApi {
  bindToggle(root: unknown, selector: string, opts: ToggleBindOpts): BindHandle | null;
  bindNumber(root: unknown, selector: string, opts: NumberBindOpts): BindHandle | null;
  bindText(root: unknown, selector: string, opts: TextBindOpts): BindHandle | null;
}

function parseInt10(raw: string): number {
  return parseInt(raw, 10);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Stored text to effective number: parse, `def` on NaN, then clamp into `[lo, hi]`. `null`/missing
 * parses as NaN, so an absent key lands on the default — the exact arithmetic the settings cards'
 * hand-written fallback loops spelled inline.
 */
export function normalizeNumber(
  raw: string | null | undefined,
  def: number,
  lo: number,
  hi: number,
  parse: ((raw: string) => number) | null,
): number {
  const p = typeof parse === "function" ? parse : parseInt10;
  const n = p(raw === null || raw === undefined ? "" : raw);
  return isNaN(n) ? def : clamp(n, lo, hi);
}

/** True only when both halves of the service path arrived; either one missing selects fallback. */
function hasServicePath(
  read: unknown,
  write: unknown,
): boolean {
  return typeof read === "function" && typeof write === "function";
}

/**
 * Create the binder set. The port set is the only IO surface; storage never appears here, because
 * both paths read and write through caller-supplied closures.
 * @param ports - DOM access from the wiring.
 */
export function createBind(ports: BindPorts): BindApi {
  function bindToggle(root: unknown, selector: string, opts: ToggleBindOpts): BindHandle | null {
    const el = ports.querySelector(root, selector);
    if (el === null || el === undefined) return null;
    const service = hasServicePath(opts.read, opts.write);
    const get = service ? opts.read : opts.fallbackGet;
    const set = service ? opts.write : opts.fallbackSet;
    function refresh(): void {
      // The contract says `read`/`fallbackGet` return a boolean; anything else reads as off.
      if (typeof get === "function") el.checked = get() === true;
    }
    refresh();
    ports.listen(el, function () {
      const on = el.checked === true;
      if (typeof set === "function") set(on);
      if (typeof opts.onChange === "function") opts.onChange(on);
    });
    return { el: el, refresh: refresh };
  }

  function bindNumber(root: unknown, selector: string, opts: NumberBindOpts): BindHandle | null {
    const el = ports.querySelector(root, selector);
    if (el === null || el === undefined) return null;
    const service = hasServicePath(opts.read, opts.write);
    function fallbackWrite(raw: string): number {
      const n = normalizeNumber(raw, opts.default, opts.min, opts.max, opts.parse);
      if (typeof opts.fallbackSet === "function") opts.fallbackSet(String(n));
      return n;
    }
    function writeRaw(raw: string): number {
      // Service path passes the raw input through: the service's write owns the clamping and
      // returns the effective number, which is what gets echoed.
      if (service) return typeof opts.write === "function" ? opts.write(raw) : NaN;
      return fallbackWrite(raw);
    }
    function refresh(): void {
      el.value = String(service && typeof opts.read === "function" ? opts.read() : normalizeNumber(
        typeof opts.fallbackGet === "function" ? opts.fallbackGet() : null,
        opts.default, opts.min, opts.max, opts.parse,
      ));
    }
    refresh();
    ports.listen(el, function () {
      const n = writeRaw(el.value);
      el.value = String(n);
      if (typeof opts.onChange === "function") opts.onChange(n);
    });
    return { el: el, refresh: refresh };
  }

  function bindText(root: unknown, selector: string, opts: TextBindOpts): BindHandle | null {
    const el = ports.querySelector(root, selector);
    if (el === null || el === undefined) return null;
    const service = hasServicePath(opts.read, opts.write);
    function writeRaw(raw: string): string {
      if (service) return typeof opts.write === "function" ? opts.write(raw) : raw;
      if (typeof opts.fallbackSet === "function") opts.fallbackSet(raw);
      return raw;
    }
    function refresh(): void {
      el.value = service && typeof opts.read === "function" ? opts.read()
        : (typeof opts.fallbackGet === "function" ? opts.fallbackGet() : "");
    }
    refresh();
    ports.listen(el, function () {
      const v = writeRaw(el.value);
      el.value = String(v);
      if (typeof opts.onChange === "function") opts.onChange(v);
    });
    return { el: el, refresh: refresh };
  }

  return { bindToggle: bindToggle, bindNumber: bindNumber, bindText: bindText };
}
