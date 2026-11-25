/**
 * Agent-personalization instruction budget and storage for the settings card.
 *
 * The same key is written by settings.js and read by engine/app.js; both sides previously did their
 * own trimming and size checks, so the two could drift. All of that now lives here: the byte budget
 * (UTF-8 via an injected encoder), the empty-after-trim deletion rule, and the trimmed read used for
 * request injection. The textarea, count label and toasts stay in the settings wiring.
 *
 * Storage writes keep the original text (not the trimmed copy) so the editor round-trips what the
 * user typed; only the empty check and the engine read trim. The encoder is a port because Node's
 * test harness has TextEncoder but the emitted classic product must not assume any global.
 * @module services/ui/settings-personalize
 */

/** Storage key shared with engine/app.js and the byte cap for a personalization instruction. */
export const PERSONALIZE_KEY = "cfw_agent_personalize_v1";
export const MAX_BYTES = 100 * 1024;

/** Ports: localStorage access and a UTF-8 encoder, both wrapped by the wiring. */
export interface PersonalizePorts {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  encode(text: string): { readonly length: number };
}

export interface PersonalizeApi {
  /** Byte length of `text`, falling back to code-unit length when the encoder throws. */
  byteLen(text: unknown): number;
  /** Human size in this card's format: `N B` below 1 KiB, else `N.N KB`. */
  fmtBytes(n: unknown): string;
  /** True when `text` exceeds the cap; the save button is disabled in this state. */
  isOverLimit(text: unknown): boolean;
  /** Trimmed stored text, or an empty string; shared with the engine's request injection. */
  read(): string;
  /** Stored text verbatim (no trim); the cancel baseline in the editor must round-trip the raw text. */
  readRaw(): string;
  /** Save rule: over-cap is a no-op; empty-after-trim removes the key, otherwise the raw text is kept. */
  save(text: unknown): { stored: boolean; trimmed: string };
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** UTF-8 byte count via the injected encoder; a throwing encoder degrades to code-unit length. */
export function byteLen(v: unknown, encode: (text: string) => { readonly length: number }): number {
  const text = asString(v);
  try {
    return encode(text).length;
  } catch (e) {
    return text.length;
  }
}

/** Card-local size labels: the space before the unit is part of the visible UI text. */
export function fmtBytes(v: unknown): string {
  const n = typeof v === "number" && Number.isFinite(v) ? v : parseInt(String(v || "0"), 10) || 0;
  return n < 1024 ? (n + " B") : ((n / 1024).toFixed(1) + " KB");
}

/** Over-cap check reused by the live count label and the save handler. */
export function isOverLimit(v: unknown, encode: (text: string) => { readonly length: number }): boolean {
  return byteLen(v, encode) > MAX_BYTES;
}

/** Trimmed storage read; mirrors the engine's read so both sides share one definition. */
export function readTrimmed(raw: string | null): string {
  return asString(raw).trim();
}

export function createPersonalize(ports: PersonalizePorts): PersonalizeApi {
  const encode = (text: string) => ports.encode(text);
  return {
    byteLen: (text) => byteLen(text, encode),
    fmtBytes: fmtBytes,
    isOverLimit: (text) => isOverLimit(text, encode),
    read: () => readTrimmed(ports.getItem(PERSONALIZE_KEY)),
    readRaw: () => asString(ports.getItem(PERSONALIZE_KEY)),
    save: (text) => {
      const raw = asString(text);
      if (isOverLimit(raw, encode)) return { stored: false, trimmed: raw.trim() };
      const trimmed = raw.trim();
      if (trimmed) ports.setItem(PERSONALIZE_KEY, raw);
      else ports.removeItem(PERSONALIZE_KEY);
      return { stored: true, trimmed: trimmed };
    },
  };
}
