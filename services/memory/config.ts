/**
 * Character memory settings: the single table of defaults, storage keys and clamp ranges.
 *
 * `services/memory/core.ts` and `services/memory/char-memory.ts` used to spell the same numbers
 * inline (`cfw_mem_v1` / `cfw_mem_vec_v1` switches, recall k=4, reflect 40 rows, inject 3 chunks /
 * 1200 chars). The settings card needs exactly those numbers on its read *and* write side, so they
 * live here once. A default is a product decision: every one of these equals the pre-2026-11-25
 * hard-coded behaviour, and `autoWrite` stays off because turning it on adds one model call per
 * turn (the card says so).
 *
 * Polarity follows the two legacy switches: `enabled` / `vecEnabled` are on unless stored as "0";
 * `autoWrite` is off unless stored as "1". Numeric fields parse strictly, fall back to the default
 * on dirty input and clamp into their documented range.
 *
 * Zero environment access: localStorage arrives through {@link MemoryConfigStorage}. The wiring owns
 * the try/catch and attaches this API to the existing `window.__memCore` facade.
 * @module services/memory/config
 */

export interface MemoryConfigStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface MemoryConfig {
  /** Master switch for L1/L2 memories. */
  enabled: boolean;
  /** Vector leg of recall; off keeps the lexical/entity arms only. */
  vecEnabled: boolean;
  /** Records injected before a request by buildInjection. */
  recallK: number;
  /** Rows fed to the L1 → L2 consolidation prompt. */
  reflectMaxRows: number;
  /** Knowledge-base chunks injected by char-memory.buildInjection. */
  injectMaxChunks: number;
  /** Character budget of the injected knowledge-base block. */
  injectMaxChars: number;
  /** Extract and store memories at the end of every main-agent turn (one extra model call). */
  autoWrite: boolean;
}

export type MemoryConfigField = "enabled" | "vecEnabled" | "recallK" | "reflectMaxRows" | "injectMaxChunks" | "injectMaxChars" | "autoWrite";

export const MEMORY_CONFIG_KEYS: Readonly<Record<MemoryConfigField, string>> = {
  enabled: "cfw_mem_v1",
  vecEnabled: "cfw_mem_vec_v1",
  recallK: "cfw_mem_recall_k_v1",
  reflectMaxRows: "cfw_mem_reflect_rows_v1",
  injectMaxChunks: "cfw_mem_inject_chunks_v1",
  injectMaxChars: "cfw_mem_inject_chars_v1",
  autoWrite: "cfw_mem_auto_v1",
};

/** Defaults are the old inline values, byte for byte. */
export const MEMORY_CONFIG_DEFAULTS: Readonly<MemoryConfig> = {
  enabled: true,
  vecEnabled: true,
  recallK: 4,
  reflectMaxRows: 40,
  injectMaxChunks: 3,
  injectMaxChars: 1200,
  autoWrite: false,
};

export const MEMORY_CONFIG_LIMITS = {
  recallK: { min: 1, max: 20 },
  reflectMaxRows: { min: 10, max: 200 },
  injectMaxChunks: { min: 1, max: 10 },
  injectMaxChars: { min: 200, max: 6000 },
};

function clampInt(raw: unknown, def: number, min: number, max: number): number {
  const n = parseInt(String(raw == null ? "" : raw), 10);
  if (isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}

/** "on unless explicitly 0" — the polarity of the two legacy switches. */
export function memorySwitchOn(raw: string | null): boolean {
  return raw !== "0";
}

/** "off unless explicitly 1" — the polarity of the new opt-in auto writer. */
export function memoryOptIn(raw: string | null): boolean {
  return raw === "1";
}

/** Read one numeric field under its documented default and range. */
export function normalizeMemoryNumber(field: "recallK" | "reflectMaxRows" | "injectMaxChunks" | "injectMaxChars", raw: string | null): number {
  const spec = MEMORY_CONFIG_LIMITS[field];
  return clampInt(raw, MEMORY_CONFIG_DEFAULTS[field], spec.min, spec.max);
}

/** Read the whole table from a storage port. A throwing storage is the caller's problem; the
 *  wiring wraps localStorage, and the memory services treat a throw as "not configured". */
export function readMemoryConfig(storage: MemoryConfigStorage): MemoryConfig {
  return {
    enabled: memorySwitchOn(storage.getItem(MEMORY_CONFIG_KEYS.enabled)),
    vecEnabled: memorySwitchOn(storage.getItem(MEMORY_CONFIG_KEYS.vecEnabled)),
    recallK: normalizeMemoryNumber("recallK", storage.getItem(MEMORY_CONFIG_KEYS.recallK)),
    reflectMaxRows: normalizeMemoryNumber("reflectMaxRows", storage.getItem(MEMORY_CONFIG_KEYS.reflectMaxRows)),
    injectMaxChunks: normalizeMemoryNumber("injectMaxChunks", storage.getItem(MEMORY_CONFIG_KEYS.injectMaxChunks)),
    injectMaxChars: normalizeMemoryNumber("injectMaxChars", storage.getItem(MEMORY_CONFIG_KEYS.injectMaxChars)),
    autoWrite: memoryOptIn(storage.getItem(MEMORY_CONFIG_KEYS.autoWrite)),
  };
}

/** Persist the fields present in `patch` (values normalised first), then return the merged table. */
export function writeMemoryConfig(storage: MemoryConfigStorage, patch: Partial<MemoryConfig>): MemoryConfig {
  const p = patch || {};
  if (typeof p.enabled === "boolean") storage.setItem(MEMORY_CONFIG_KEYS.enabled, p.enabled ? "1" : "0");
  if (typeof p.vecEnabled === "boolean") storage.setItem(MEMORY_CONFIG_KEYS.vecEnabled, p.vecEnabled ? "1" : "0");
  if (p.recallK !== undefined) storage.setItem(MEMORY_CONFIG_KEYS.recallK, String(normalizeMemoryNumber("recallK", String(p.recallK))));
  if (p.reflectMaxRows !== undefined) storage.setItem(MEMORY_CONFIG_KEYS.reflectMaxRows, String(normalizeMemoryNumber("reflectMaxRows", String(p.reflectMaxRows))));
  if (p.injectMaxChunks !== undefined) storage.setItem(MEMORY_CONFIG_KEYS.injectMaxChunks, String(normalizeMemoryNumber("injectMaxChunks", String(p.injectMaxChunks))));
  if (p.injectMaxChars !== undefined) storage.setItem(MEMORY_CONFIG_KEYS.injectMaxChars, String(normalizeMemoryNumber("injectMaxChars", String(p.injectMaxChars))));
  if (typeof p.autoWrite === "boolean") storage.setItem(MEMORY_CONFIG_KEYS.autoWrite, p.autoWrite ? "1" : "0");
  return readMemoryConfig(storage);
}

export interface MemoryConfigApi {
  read(): MemoryConfig;
  write(patch: Partial<MemoryConfig>): MemoryConfig;
  keys: typeof MEMORY_CONFIG_KEYS;
  defaults: Readonly<MemoryConfig>;
  limits: typeof MEMORY_CONFIG_LIMITS;
}

/** The facade both the settings card and the memory services consume. */
export function createMemConfig(storage: MemoryConfigStorage): MemoryConfigApi {
  return {
    read: () => readMemoryConfig(storage),
    write: (patch) => writeMemoryConfig(storage, patch),
    keys: MEMORY_CONFIG_KEYS,
    defaults: MEMORY_CONFIG_DEFAULTS,
    limits: MEMORY_CONFIG_LIMITS,
  };
}
