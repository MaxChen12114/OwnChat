/**
 * The single owner of cfw_prompt_presets_v1 — the instruction modules shared by the prompt editor
 * and the agent's manage_preset tool.
 *
 * The bug this removes: the tool used to write the key with a bare localStorage.setItem and never
 * nudged cloud sync, while the editor did markDirty + a delayed pushNow. An agent-created preset
 * could therefore stay only on the device. Both writers now go through the same `save`, whose
 * onSave port is implemented once in tooling/l0/wiring/presets.js as that touchSync nudge.
 *
 * Normalization is absorbed from services/ui/prompt-editor.ts (pePresetsFrom): a non-array is empty,
 * unnamed rows are dropped, and missing fields take the row index / empty-string / false defaults.
 * The tool used to accept raw rows instead, so a malformed row could reach the model unchanged.
 *
 * No window, no document, no localStorage here: storage and the save notification arrive through
 * {@link PresetPorts}. The factory is exported so emit bridges it to globalThis; the wiring builds
 * the one browser instance and publishes it as `window.presetStore`.
 * @module services/data/presets
 */

/** The one localStorage key this service owns. */
export const PRESETS_KEY = "cfw_prompt_presets_v1";

/** Key-value storage port; the adapter wraps localStorage, tests wrap a Map. */
export interface KvStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface PresetPorts {
  storage: KvStorage;
  /** Fired after every successful or failed write; the wiring implements touchSync here. */
  onSave(): void;
}

/** One normalized instruction module (the editor's PresetEntry shape). */
export interface PresetEntry {
  id: string;
  name: string;
  content: string;
  enabled: boolean;
  order: number;
  group: string;
  lang: string;
  description: string;
  source: string;
  license: string;
  note: string;
  file: string;
  fromLibrary: boolean;
}

export interface PresetStore {
  load(): PresetEntry[];
  /** Write, then notify through the port. Never throws. */
  save(list: PresetEntry[]): void;
  uid(): string;
  /** Next free injection order: the reduce starts at -1, so an empty list yields 0. */
  order(list: PresetEntry[]): number;
  /** The tool-list preview: a plain 80-character slice (the UI's pePresetPreview adds an ellipsis). */
  preview(content: string): string;
  /** A boolean sets the flag; anything else flips it. */
  toggle(list: PresetEntry[], id: string, enabled?: unknown): PresetEntry[];
}

function recOf(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

function arrOf(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Only real strings pass; numbers, booleans and null become "". Same rule as the editor engine. */
function strOf(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** The editor's pePresetsFrom rule, verbatim: index is the raw-array index, dropped rows included. */
function normalizePresets(raw: unknown): PresetEntry[] {
  const out: PresetEntry[] = [];
  arrOf(raw).forEach((row, i) => {
    const r = recOf(row);
    const name = strOf(r["name"]);
    if (!name) return;
    out.push({
      id: strOf(r["id"]) || "preset-" + String(i),
      name,
      content: strOf(r["content"]),
      enabled: r["enabled"] === true,
      order: typeof r["order"] === "number" ? r["order"] : i,
      group: strOf(r["group"]),
      lang: strOf(r["lang"]),
      description: strOf(r["description"]),
      source: strOf(r["source"]),
      license: strOf(r["license"]),
      note: strOf(r["note"]),
      file: strOf(r["file"]),
      fromLibrary: r["fromLibrary"] === true,
    });
  });
  return out;
}

export function createPresetStore(ports: PresetPorts): PresetStore {
  return {
    load() {
      try {
        return normalizePresets(JSON.parse(ports.storage.getItem(PRESETS_KEY) || "null"));
      } catch (e) {
        return [];
      }
    },
    save(list) {
      try {
        ports.storage.setItem(PRESETS_KEY, JSON.stringify(list));
      } catch (e) {}
      // Outside the try on purpose: even a failed write must announce the change, as the editor did.
      ports.onSave();
    },
    uid() {
      return "preset-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
    },
    order(list) {
      return list.reduce((m, x) => Math.max(m, x.order || 0), -1) + 1;
    },
    preview(content) {
      return (content || "").slice(0, 80);
    },
    toggle(list, id, enabled) {
      const set = typeof enabled === "boolean" ? enabled : undefined;
      return list.map((p) => (p.id === id ? { ...p, enabled: set === undefined ? !p.enabled : set } : p));
    },
  };
}
