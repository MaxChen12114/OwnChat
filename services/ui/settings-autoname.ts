/**
 * Conversation auto-naming switches: a master toggle gates the AI-refine sub-toggle.
 *
 * The pair has deliberately mixed polarities — master stores "off" (`'1'` = off) because it
 * defaults on, the sub-toggle stores "on" (`'0'` = off, same default-on rule) — and the sub-toggle
 * is only usable while the master is on. The storage shape and the gating rule live here; the two
 * checkboxes stay in the settings wiring. `services/conv/autoname.ts` reads the same keys, so the
 * literals are a cross-module contract (pinned by the lock, like LS_SHELL).
 * @module services/ui/settings-autoname
 */

/** Master switch: `'1'` = auto-naming off (it defaults on). */
export const AUTONAME_OFF_KEY = "cfw_autoname_off_v1";
/** AI refine sub-switch: `'0'` = AI refine off (also defaults on). */
export const AUTONAME_AI_KEY = "cfw_autoname_ai_v1";

/** Storage port; the wiring wraps localStorage. */
export interface AutonamePorts {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Public surface; the wiring assigns it to a non-`__` global. */
export interface AutonameApi {
  /** Read both switches: `{ on, aiOn }`, with `aiOn` forced false while the master is off. */
  read(): { on: boolean; aiOn: boolean };
  /** Write the master; returns the pair after gating (`aiOn` reads false while off). */
  writeMaster(on: boolean): { on: boolean; aiOn: boolean };
  /** Write the AI sub-switch; a no-op while the master is off (the checkbox is disabled then). */
  writeAi(aiOn: boolean): void;
}

/** Read the pair from storage under the two polarities. */
export function readPair(offRaw: string | null, aiRaw: string | null): { on: boolean; aiOn: boolean } {
  const on = offRaw !== "1";
  const aiOn = on && aiRaw !== "0";
  return { on: on, aiOn: aiOn };
}

/** Create the API. Unknown storage reads as "both on" — the documented defaults. */
export function createAutoname(ports: AutonamePorts): AutonameApi {
  function read(): { on: boolean; aiOn: boolean } {
    return readPair(ports.getItem(AUTONAME_OFF_KEY), ports.getItem(AUTONAME_AI_KEY));
  }
  function writeMaster(on: boolean): { on: boolean; aiOn: boolean } {
    ports.setItem(AUTONAME_OFF_KEY, on ? "0" : "1");
    const next = read();
    if (!next.on) ports.setItem(AUTONAME_AI_KEY, "0");
    return read();
  }
  function writeAi(aiOn: boolean): void {
    const cur = read();
    if (!cur.on) return;
    ports.setItem(AUTONAME_AI_KEY, aiOn ? "1" : "0");
  }
  return { read: read, writeMaster: writeMaster, writeAi: writeAi };
}
