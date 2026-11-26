/**
 * DeepSeek kit card data: the two server-side built-in tool switches (`read_url`, `safety_check`).
 *
 * `services/data/prompt-profile.ts` reads both keys when it assembles a chat body and omits the
 * payload unless at least one is `"1"`. The card used to spell that rule inline; this module is the
 * single source of the keys and the literal comparison, so the card and the request side cannot
 * drift apart.
 * @module services/ui/settings-deepseek-kit
 */

/** Storage keys; the literals are shared with prompt-profile and are the contract. */
export const DEEPSEEK_KIT_KEYS: Readonly<Record<"readUrl" | "safety", string>> = {
  readUrl: "cfw_deepseek_read_url_v1",
  safety: "cfw_deepseek_safety_v1",
};

/** Storage port; the wiring wraps localStorage so quota errors never reach this module. */
export interface KitPorts {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * One rule for both switches: only the literal `"1"` is on. Byte-identical to prompt-profile's
 * `read(LS_DS_READ_URL) === "1"` and `read(LS_DS_SAFETY) === "1"`.
 */
export function normalizeKitFlag(raw: unknown): boolean {
  return raw === "1";
}

/** Persisted form used by both switches. */
export function kitFlagValue(on: boolean): "1" | "0" {
  return on ? "1" : "0";
}

export interface DeepSeekKitApi {
  /** Read one switch by its canonical key. */
  read(key: string): boolean;
  /** Write one switch; an unknown key is ignored by the caller, not silently invented here. */
  write(key: string, on: boolean): void;
}

/**
 * Create the card's data API.
 * @param ports - the storage port from the wiring.
 * @returns `read` / `write` bound to the two keys.
 */
export function createSettingsDeepSeekKit(ports: KitPorts): DeepSeekKitApi {
  function read(key: string): boolean {
    return normalizeKitFlag(ports.getItem(key));
  }
  function write(key: string, on: boolean): void {
    ports.setItem(key, kitFlagValue(on));
  }
  return { read: read, write: write };
}
