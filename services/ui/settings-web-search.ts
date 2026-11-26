/**
 * Web-search settings card: the single home for the two keys shared by settings.js (write side) and
 * services/data/prompt-profile.ts (read side, into the /api/chat body).
 *
 * Both sides used to spell out the same rule independently — a strict `=== "1"` compare, with every
 * missing or dirty value reading as off. That is the drift this module removes: the normalization,
 * the storage keys and the "switch off clears deep" invariant now live here once. The DOM (checkbox
 * refs, disabled state, status text) stays in the settings card wiring.
 *
 * The read side is byte-identical to prompt-profile's `webSearchPayload()`: no `webSearch` field at
 * all when the switch is off, otherwise `{ webSearch: true, webSearchDeep: <deep> }`. `payload()`
 * exposes that shape so prompt-profile can delegate to it in a later cut.
 *
 * Zero window, zero casts: storage arrives through {@link WebSearchPorts}, and the wiring owns the
 * try/catch around localStorage. The factory also guards its port calls, mirroring prompt-profile's
 * safe read/write, so a throwing storage cannot change the effective state.
 * @module services/ui/settings-web-search
 */

/** Storage keys shared with prompt-profile.ts; changing either one changes the wire contract. */
export const WEB_SEARCH_KEY = "cfw_web_search_v1";
export const WEB_SEARCH_DEEP_KEY = "cfw_web_search_deep_v1";

/** Storage port; structurally identical to prompt-profile's KvStorage. The wiring wraps localStorage. */
export interface WebSearchPorts {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Effective state of the card, after normalization. */
export interface WebSearchState {
  enabled: boolean;
  deep: boolean;
}

export interface SettingsWebSearchApi {
  /** Both switches normalized, matching the old `=== "1"` reads in settings.js. */
  read(): WebSearchState;
  /** Write both keys; deep is forced off whenever `enabled` is false. */
  write(enabled: boolean, deep: boolean): void;
  /** Main-toggle handler: off clears deep, on preserves the current deep value. */
  writeEnabled(enabled: boolean): void;
  /** Deep-toggle handler: a deep value cannot survive with the main switch off. */
  writeDeep(deep: boolean): void;
  /** The /api/chat fragment, byte-identical to prompt-profile's webSearchPayload(). */
  payload(): Record<string, unknown>;
}

/** Strict "1" test — prompt-profile checks `read(key) === "1"` for both keys, no truthiness. */
export function normalizeEnabled(raw: string | null): boolean {
  return raw === "1";
}

/** Strict "1" test — the deep tier defaults off and treats every dirty value as off. */
export function normalizeDeep(raw: string | null): boolean {
  return raw === "1";
}

export function createSettingsWebSearch(ports: WebSearchPorts): SettingsWebSearchApi {
  /** Safe read: a throwing port reads as null, matching prompt-profile's per-call try/catch. */
  function readRaw(key: string): string | null {
    try {
      return ports.getItem(key);
    } catch (e) {
      return null;
    }
  }

  /** Safe write: failures are swallowed, as in the old `catch (e) {}`. */
  function writeRaw(key: string, value: string): void {
    try {
      ports.setItem(key, value);
    } catch (e) {}
  }

  function read(): WebSearchState {
    return {
      enabled: normalizeEnabled(readRaw(WEB_SEARCH_KEY)),
      deep: normalizeDeep(readRaw(WEB_SEARCH_DEEP_KEY)),
    };
  }

  function write(enabled: boolean, deep: boolean): void {
    writeRaw(WEB_SEARCH_KEY, enabled ? "1" : "0");
    // The invariant prompt-profile relies on: a deep flag is only meaningful with search on.
    writeRaw(WEB_SEARCH_DEEP_KEY, enabled && deep ? "1" : "0");
  }

  function writeEnabled(enabled: boolean): void {
    if (enabled) write(true, read().deep);
    else write(false, false);
  }

  function writeDeep(deep: boolean): void {
    const state = read();
    write(state.enabled, deep);
  }

  function payload(): Record<string, unknown> {
    const state = read();
    if (!state.enabled) return {};
    return { webSearch: true, webSearchDeep: state.deep };
  }

  return { read: read, write: write, writeEnabled: writeEnabled, writeDeep: writeDeep, payload: payload };
}
