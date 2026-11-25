/**
 * Chat-background settings: persisted shape, slider value parsing and the apply/clear rules.
 *
 * The card in settings.js owns the DOM (inputs, labels, file picker, status text and the toasts);
 * this module owns the decisions that used to be scattered through that card — reading the stored
 * bg object with defaults, parsing slider values, the centre label, the 4 MiB upload ceiling and
 * the key deletion rules. Keeping them here lets the awkward asymmetric fallback be locked without
 * a browser: `posX`/`posY` guard against non-finite values, `opacity`/`blur` deliberately do not,
 * mirroring the original which passed a bad stored value straight to the range input.
 *
 * All stored values are untrusted (localStorage may be hand-edited), so every read is narrowed to a
 * string and parsed defensively; nothing here touches the DOM or localStorage directly.
 * @module services/ui/settings-background
 */

export const OVERRIDES_KEY = "cfw_ui_overrides_v1";
export const ASSETS_KEY = "cfw_ui_assets_v1";
export const LOCAL_MARK = "__local__";
/** Uploads are stored as base64 locally; a larger file balloons storage for little visual gain. */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/** Slider defaults, matching the original markup: opacity 100%, blur 0px, both positions centred. */
export const DEFAULT_OPACITY = 100;
export const DEFAULT_BLUR = 0;
export const DEFAULT_POS = 50;

export interface BackgroundPorts {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  /** Re-apply the background after a config change; wrapped by the wiring. */
  applyBg(): void;
}

export interface BackgroundConfig {
  readonly opacity: number;
  readonly blur: number;
  readonly posX: number;
  readonly posY: number;
  readonly src: string;
}

function recOf(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

function readRecord(raw: string | null): Record<string, unknown> {
  if (typeof raw !== "string" || !raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return recOf(parsed);
  } catch (e) { return {}; }
}

/** A present, non-empty stored value is parsed; blank/missing falls back to the given default. */
function parseIntOr(raw: unknown, fallback: number): number {
  return raw !== null && raw !== undefined && raw !== "" ? parseInt(String(raw), 10) : fallback;
}

/**
 * Slider values from the stored `bg` object. The asymmetry is load-bearing: positions additionally
 * clamp a non-finite result back to the centre, while opacity/blur keep the parsed value so a bad
 * stored entry surfaces in the input instead of being silently rewritten.
 */
export function parseConfig(bg: unknown): BackgroundConfig {
  const o = recOf(bg);
  const src = typeof o["src"] === "string" ? o["src"] : "";
  const opacity = parseIntOr(o["opacity"], DEFAULT_OPACITY);
  const blur = parseIntOr(o["blur"], DEFAULT_BLUR);
  let posX = parseIntOr(o["posX"], DEFAULT_POS);
  let posY = parseIntOr(o["posY"], DEFAULT_POS);
  if (!isFinite(posX)) posX = DEFAULT_POS;
  if (!isFinite(posY)) posY = DEFAULT_POS;
  return { opacity, blur, posX, posY, src };
}

/** Centre reads as a word; any other position shows its percentage. */
export function posLabel(v: number): string {
  return v === 50 ? "居中" : (v + "%");
}

/** Base64 upload ceiling; exact equality is allowed. */
export function isOverUploadLimit(bytes: unknown): boolean {
  return typeof bytes === "number" && bytes > MAX_UPLOAD_BYTES;
}

/** Apply a pasted URL: blank removes `src`, a value replaces it; a bg with no src is dropped. */
export function applyUrl(config: unknown, url: unknown): Record<string, unknown> {
  const out = recOf(config);
  const bg = recOf(out["bg"]);
  const text = typeof url === "string" ? url.trim() : "";
  if (!text) delete bg["src"];
  else bg["src"] = text;
  if (!bg["src"]) delete out["bg"];
  else out["bg"] = bg;
  return out;
}

/** Clear removes the whole bg object; the caller clears the separate asset key via clearAssets. */
export function clearBg(config: unknown): Record<string, unknown> {
  const out = recOf(config);
  delete out["bg"];
  return out;
}

export function createBackground(ports: BackgroundPorts) {
  function readConfig(): Record<string, unknown> { return readRecord(ports.getItem(OVERRIDES_KEY)); }
  function readAssets(): Record<string, unknown> { return readRecord(ports.getItem(ASSETS_KEY)); }
  function writeConfig(next: Record<string, unknown>): void {
    ports.setItem(OVERRIDES_KEY, JSON.stringify(next || {}));
    ports.applyBg();
  }
  function writeAssets(next: Record<string, unknown>): void {
    ports.setItem(ASSETS_KEY, JSON.stringify(next || {}));
  }
  return {
    parseConfig: parseConfig,
    posLabel: posLabel,
    isOverUploadLimit: isOverUploadLimit,
  applyUrl: applyUrl,
  clearBg: clearBg,
  readConfig: readConfig,
  readAssets: readAssets,
  writeConfig: writeConfig,
  writeAssets: writeAssets,
  /** Set one bg field from a slider, preserving the other fields; values are stored as-is (strings). */
  setField: function (field: "opacity" | "blur" | "posX" | "posY", value: unknown): void {
    const out = readConfig();
    const bg = recOf(out["bg"]);
    bg[field] = value;
    out["bg"] = bg;
    writeConfig(out);
  },
  /** Mark the bg source as a locally uploaded image without touching the other fields. */
  setLocalSource: function (): void {
    const out = readConfig();
    const bg = recOf(out["bg"]);
    bg["src"] = LOCAL_MARK;
    out["bg"] = bg;
    writeConfig(out);
  },
};
}
