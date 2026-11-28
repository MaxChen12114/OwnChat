/**
 * Tauri shell port: the only module that names the platform-injected globals.
 *
 * `__TAURI__` / `__TAURI_INTERNALS__` / `__TAURI_METADATA__` are injected by the desktop shell, not
 * by this repo: they cannot be renamed, and every direct dot-read spread across the wiring kept them
 * in the contract ledger forever. This module reads them through a parameterised window view, and
 * `tooling/l0/wiring/tauri.js` publishes one plain service global. Consumers never touch the shell names.
 *
 * Boundary: shapes only over an `unknown` window; a hostile getter returns "no shell" instead of
 * throwing during boot (the old inline probes were individually try/catch'd for the same reason).
 * Reflection instead of casts: the type ratchet counts `as`/`any` as escapes, and this boundary is
 * exactly where a cast would be tempting.
 * @module services/platform/tauri
 */

/** Platform-injected globals this port owns. Kept as strings so no consumer needs a dot-read. */
export const SHELL_GLOBAL_KEYS: readonly string[] = ["__TAURI__", "__TAURI_INTERNALS__", "__TAURI_METADATA__"];

/** Four presence bits, mirroring the probes that used to be copied into each wiring file. */
export interface ShellPresence {
  readonly tauri: boolean;
  readonly internals: boolean;
  readonly metadata: boolean;
  readonly isTauri: boolean;
}

/** Read one global without letting a hostile getter break boot. */
function readGlobal(win: unknown, key: string): unknown {
  if (win === null || typeof win !== "object") return undefined;
  try {
    return Reflect.get(win, key);
  } catch (e) {
    return undefined;
  }
}

/** The raw `__TAURI__` object, or null on the web. */
export function shellRaw(win: unknown): unknown {
  return readGlobal(win, "__TAURI__") ?? null;
}

/** Presence bits used by the app/desktop probes (`isTauri` is only true for an explicit boolean). */
export function shellPresence(win: unknown): ShellPresence {
  return {
    tauri: readGlobal(win, "__TAURI__") != null,
    internals: readGlobal(win, "__TAURI_INTERNALS__") != null,
    metadata: readGlobal(win, "__TAURI_METADATA__") != null,
    isTauri: readGlobal(win, "isTauri") === true,
  };
}

/** Bound `core.invoke`, or null when the shell is absent or shaped differently. */
export function shellInvoke(win: unknown): ((cmd: string, args?: unknown) => Promise<unknown>) | null {
  const shell = shellRaw(win);
  if (shell === null || typeof shell !== "object") return null;
  const core = Reflect.get(shell, "core");
  if (core === null || typeof core !== "object") return null;
  const invoke = Reflect.get(core, "invoke");
  if (typeof invoke !== "function") return null;
  return function (cmd: string, args?: unknown): Promise<unknown> {
    return Promise.resolve(Reflect.apply(invoke, core, [cmd, args]));
  };
}

/** Bound `event.listen`, or null when the shell has no event bridge. */
export function shellListen(win: unknown): ((event: string, cb: (payload: unknown) => void) => unknown) | null {
  const shell = shellRaw(win);
  if (shell === null || typeof shell !== "object") return null;
  const events = Reflect.get(shell, "event");
  if (events === null || typeof events !== "object") return null;
  const listen = Reflect.get(events, "listen");
  if (typeof listen !== "function") return null;
  return function (event: string, cb: (payload: unknown) => void): unknown {
    return Reflect.apply(listen, events, [event, cb]);
  };
}
