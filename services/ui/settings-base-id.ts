/**
 * Data layer for the base-selection cards: the custom id (`cfw_custom_id_v1`), the built-in base id
 * (`cfw_base_id_v1`), the neutral/locked id (`cfw_neutral_id_v1`) and the catalogue switch
 * (`cfw_base_registry_v1`).
 *
 * These keys are written by settings.js and read by services/data/prompt-profile.ts on every
 * request assembly. The two sides used to spell their own read/write rules, which is how a
 * settings-write vs prompt-read drift starts. This module is the single implementation of the
 * selection rules: the missing-key default, the verbatim string read, the empty-value removal rule
 * and the only literal that selects the custom catalogue.
 *
 * The two globals the card touches are UI facades, deliberately NOT ports here:
 *   - window.__baseSwitchMode: a load-time channel flag that only gates whether the custom-directory
 *     dropdown/card is rendered. It is not the stored selection — that is `cfw_base_registry_v1`
 *     (which directory) plus the id key (which entry inside it). prompt-profile snapshots it as a
 *     mode, not as custom-id data.
 *   - window.escapeSvc.esc: HTML escaping for option labels, pure rendering with no data meaning.
 * Both stay in the settings wiring; neither has a read/write of a selection key in it.
 *
 * @module services/ui/settings-base-id
 */

/** Storage keys shared with prompt-profile; the literals themselves are the contract. */
export const CUSTOM_ID_KEY = "cfw_custom_id_v1";
export const BASE_ID_KEY = "cfw_base_id_v1";
export const NEUTRAL_ID_KEY = "cfw_neutral_id_v1";
export const BASE_REGISTRY_KEY = "cfw_base_registry_v1";

/** Key-value storage port; the wiring wraps localStorage so quota errors never reach this module. */
export interface BaseIdPorts {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * The one normalization for a stored custom id: a missing value reads as the empty string, and any
 * real string is returned verbatim — no trim, no coercion, no catalogue fallback. Byte-identical to
 * prompt-profile's `v === null ? "" : v` in currentCustomId(): every value a KV store can legally
 * return (string | null) produces the same result on both sides. Non-strings are treated as absent
 * so a dirty injected store degrades the same way a throwing one does.
 */
export function normalizeCustomId(raw: unknown): string {
  return typeof raw === "string" ? raw : "";
}

/**
 * One rule for every catalogue selection (base id and neutral id): a stored string is returned
 * verbatim, anything else reads as "not selected". Byte-identical to prompt-profile's
 * `v === null ? "" : v` on every value a KV store can legally return.
 */
export function normalizeSelection(raw: unknown): string {
  return typeof raw === "string" ? raw : "";
}

/**
 * The registry switch has exactly two states; only the literal `custom` leaves the built-in
 * catalogue. Any other stored value (including a dirty one) means built-in, which is what
 * prompt-profile's `read(LS_BASE_REGISTRY) === "custom"` decides.
 */
export function normalizeRegistry(raw: unknown): "custom" | "" {
  return raw === "custom" ? "custom" : "";
}

/**
 * Effective tier label for the custom catalogue: a selected id present in `ids` wins, otherwise the
 * first catalogue entry (or "" when empty). Mirrors prompt-profile's `registryDescribe(true)` label
 * line, so a stale id removed from the catalogue falls back exactly as the worker does.
 */
export function resolveCustomLabel(cur: string, ids: string[]): string {
  return cur !== "" && ids.indexOf(cur) >= 0 ? cur : (ids.length > 0 ? ids[0] : "");
}

export interface BaseIdApi {
  /** Stored custom id, or "" when absent — same value prompt-profile.currentCustomId() returns. */
  read(): string;
  /** Non-empty value is stored verbatim; an empty/dirty value removes the key so read() is "". */
  write(value: unknown): void;
  /** The storage key, so callers never re-spell the literal. */
  keyOf(): string;
  /** Read any selection key with the shared default (missing/dirty -> ""). */
  readSelection(key: string): string;
  /** Write any selection key: non-empty verbatim, empty/dirty removes it. */
  writeSelection(key: string, value: unknown): void;
  /** Which catalogue is selected; only the literal `custom` leaves the built-in one. */
  readRegistry(): "custom" | "";
  /** Write the registry switch; anything other than `custom` removes the key. */
  writeRegistry(value: unknown): void;
}

/**
 * Create the card's data API. Storage errors stay in the wiring port; this layer only owns the value
 * rules shared with the request side.
 */
export function createSettingsBaseId(ports: BaseIdPorts): BaseIdApi {
  function read(): string {
    return normalizeCustomId(ports.getItem(CUSTOM_ID_KEY));
  }
  function write(value: unknown): void {
    const v = normalizeCustomId(value);
    if (v !== "") ports.setItem(CUSTOM_ID_KEY, v);
    else ports.removeItem(CUSTOM_ID_KEY);
  }
  function keyOf(): string {
    return CUSTOM_ID_KEY;
  }
  function readSelection(key: string): string {
    return normalizeSelection(ports.getItem(key));
  }
  function writeSelection(key: string, value: unknown): void {
    const v = normalizeSelection(value);
    if (v !== "") ports.setItem(key, v);
    else ports.removeItem(key);
  }
  function readRegistry(): "custom" | "" {
    return normalizeRegistry(ports.getItem(BASE_REGISTRY_KEY));
  }
  function writeRegistry(value: unknown): void {
    if (normalizeRegistry(value) === "custom") ports.setItem(BASE_REGISTRY_KEY, "custom");
    else ports.removeItem(BASE_REGISTRY_KEY);
  }
  return {
    read: read,
    write: write,
    keyOf: keyOf,
    readSelection: readSelection,
    writeSelection: writeSelection,
    readRegistry: readRegistry,
    writeRegistry: writeRegistry,
  };
}
