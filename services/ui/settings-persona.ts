/**
 * Persona-card data: the `cfw_use_builtin` switch ("inject the built-in character prompt").
 *
 * `engine/app.js` caches the same flag at boot and after every external-settings broadcast with
 * `(getItem(key) ?? "1") === "1"` — a missing key means ON, anything else must be the literal
 * `"1"`. The card used to restate that formula; this module owns it so the two sides cannot drift.
 * @module services/ui/settings-persona
 */

/** Key shared with engine/app.js; the literal is the contract. */
export const USE_BUILTIN_KEY = "cfw_use_builtin";

/** Storage port; the wiring wraps localStorage so quota errors never reach this module. */
export interface PersonaPorts {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * The one normalization for the built-in prompt switch. A missing/null value reads as ON (the
 * historical default); any other value is ON only when it is the literal `"1"`.
 */
export function normalizeUseBuiltin(raw: unknown): boolean {
  return raw == null ? true : raw === "1";
}

/** Persisted form; the card writes both states explicitly so the default is never re-derived. */
export function useBuiltinValue(on: boolean): "1" | "0" {
  return on ? "1" : "0";
}

export interface PersonaApi {
  readUseBuiltin(): boolean;
  writeUseBuiltin(on: boolean): void;
}

/**
 * Create the card's data API.
 * @param ports - the storage port from the wiring.
 * @returns `readUseBuiltin` / `writeUseBuiltin`.
 */
export function createSettingsPersona(ports: PersonaPorts): PersonaApi {
  function readUseBuiltin(): boolean {
    return normalizeUseBuiltin(ports.getItem(USE_BUILTIN_KEY));
  }
  function writeUseBuiltin(on: boolean): void {
    ports.setItem(USE_BUILTIN_KEY, useBuiltinValue(on));
  }
  return { readUseBuiltin: readUseBuiltin, writeUseBuiltin: writeUseBuiltin };
}
