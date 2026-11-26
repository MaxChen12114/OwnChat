/**
 * Theme state rules, minus the DOM and the audio: which styles exist, which are private, how the
 * effective style and light/dark scheme are derived, what the ambient decks persist, and the track
 * tables.
 *
 * Two derivation rules carry the history:
 *  - A private style (candle) only applies while the private mode is unlocked. Stale LS values fall
 *    back to minimal — the same reading the FOUC inline script uses, or the page would flash the
 *    private theme before the gate loads.
 *  - The effective scheme is an explicit choice first, the style's native light/dark second. Only
 *    styles that actually ship both variants appear in `SCHEME_READY`; the settings row shows the
 *    toggle for those and only those.
 *
 * The mixer deck persisted value is validated on read: an unknown track id or an out-of-range volume
 * falls back to the deck default, never plays a track the table does not know.
 * @module services/ui/theme
 */

/** Styles in radio order; adding one means adding the [data-theme] CSS, nothing else. */
export const THEME_STYLES = ["minimal", "glass", "candle"];
/** Styles that belong to the private mode; gated on the unlock flag. */
export const PRIVATE_STYLES = ["candle"];
function recOf(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

export const THEME_DEFAULT_STYLE = "minimal";

export const THEME_LS_STYLE = "cfw_theme_v1";
export const THEME_LS_SCHEME = "my-theme"; // legacy name kept: scattered consumers read it
export const THEME_LS_ACCENT = "cfw_theme_accent_v1";
export const AUDIO_LS_ENABLED = "cfw_audio_enabled_v1";
export const AUDIO_LS_LEGACY_VOL = "cfw_audio_volume_v1"; // single-track volume, migrated into amb
export const AUDIO_LS_AMB = "cfw_ambient_amb_v1";
export const AUDIO_LS_MUS = "cfw_ambient_mus_v1";

/** Each style's native light/dark, used when the user has not chosen a scheme. */
export const NATIVE_SCHEME: Record<string, string> = { minimal: "dark", glass: "light", candle: "dark" };
/** Styles that actually ship both schemes; the UI only shows the toggle for these. */
export const SCHEME_READY = ["minimal"];

/** Ambient tracks, all CC0 (credits in /assets/ambient/CREDITS.txt): [id, label, file]. */
export const AMB_TRACKS = [
  ["amb-rain-1", "雨打窗 I", "amb-rain-1.mp3"],
  ["amb-rain-2", "雨打窗 II", "amb-rain-2.mp3"],
  ["amb-city-1", "城市夜 I", "amb-city-1.mp3"],
  ["amb-city-2", "城市夜 II", "amb-city-2.mp3"],
  ["amb-cafe-1", "咖啡馆 I", "amb-cafe-1.mp3"],
  ["amb-cafe-2", "咖啡馆 II", "amb-cafe-2.mp3"],
  ["amb-hearthfire", "炉火", "amb-hearthfire.mp3"],
  ["amb-wind-1", "夜风 I", "amb-wind-1.mp3"],
  ["amb-wind-2", "夜风 II", "amb-wind-2.mp3"],
  ["amb-tavern-1", "酒馆低语 I", "amb-tavern-1.mp3"],
  ["amb-tavern-2", "酒馆低语 II", "amb-tavern-2.mp3"],
  ["amb-forest-1", "森林夜 I", "amb-forest-1.mp3"],
  ["amb-forest-2", "森林夜 II", "amb-forest-2.mp3"],
  ["amb-frogs-1", "蛙鸣 I", "amb-frogs-1.mp3"],
  ["amb-frogs-2", "蛙鸣 II", "amb-frogs-2.mp3"],
  ["amb-clock-1", "挂钟 I", "amb-clock-1.mp3"],
  ["amb-clock-2", "挂钟 II", "amb-clock-2.mp3"],
  ["amb-pendulum-1", "钟摆 I", "amb-pendulum-1.mp3"],
  ["amb-pendulum-2", "钟摆 II", "amb-pendulum-2.mp3"],
  ["voice-breath", "呼吸", "voice-breath.mp3"],
];
export const MUS_TRACKS = [
  ["mus-piano-summernight", "夏夜钢琴", "mus-piano-summernight.mp3"],
  ["mus-late-piano", "深夜钢琴", "mus-late-piano.mp3"],
  ["mus-piano-cinematic", "电影感钢琴", "mus-piano-cinematic.mp3"],
  ["mus-piano-emotional1", "情绪钢琴 I", "mus-piano-emotional1.mp3"],
  ["mus-piano-emotional3", "情绪钢琴 II", "mus-piano-emotional3.mp3"],
  ["mus-piano-emotional5", "情绪钢琴 III", "mus-piano-emotional5.mp3"],
  ["mus-guitar-reverb", "混响吉他", "mus-guitar-reverb.mp3"],
  ["mus-lofi-1", "Lo-fi I", "mus-lofi-1.mp3"],
  ["mus-lofi-2", "Lo-fi II", "mus-lofi-2.mp3"],
];
export const THEME_TRACKS: Record<string, string[][]> = { amb: AMB_TRACKS, mus: MUS_TRACKS };

/** The [[voice:]] agent tag's default breath pad, aliased onto the amb deck. */
export const VOICE_DEFAULT = "voice-breath";

export function trackFile(deck: string, id: string): string | null {
  const t = findTrack(deck, id);
  return t ? t[2] : null;
}

export function findTrack(deck: string, id: unknown): string[] | null {
  const list = THEME_TRACKS[deck] || [];
  for (const t of list) if (t[0] === id) return t;
  return null;
}

export function trackLabel(deck: string, id: unknown): string {
  const t = findTrack(deck, id);
  return t ? t[1] : "";
}

/**
 * The style that should actually apply. Locked-state stale values fall back to minimal — the FOUC
 * inline script reads the same way, so the two never disagree on first paint.
 */
export function resolveStyle(stored: unknown, unlocked: boolean): string {
  const v = String(stored || "");
  if (THEME_STYLES.indexOf(v) < 0) return THEME_DEFAULT_STYLE;
  if (PRIVATE_STYLES.indexOf(v) >= 0 && !unlocked) return THEME_DEFAULT_STYLE;
  return v;
}

/** Explicit choice wins over the style's native scheme; an unknown stored value means "not chosen". */
export function resolveScheme(stored: unknown, style: string): string {
  if (stored === "light" || stored === "dark") return stored;
  return NATIVE_SCHEME[style] || "dark";
}

export interface DeckState {
  id: string | null;
  vol: number;
}

export const AMB_DEFAULT_VOL = 0.6;
export const MUS_DEFAULT_VOL = 0.35;

/** Legacy single-track volume, only used to seed the amb deck's default. */
export function initialAmbVolume(legacyRaw: unknown): number {
  const v = parseFloat(String(legacyRaw));
  return isFinite(v) && v >= 0 && v <= 1 ? v : AMB_DEFAULT_VOL;
}

/**
 * Parse a persisted deck. Unknown ids are dropped (the track table may have changed) and volumes
 * outside 0..1 fall back to the deck default — never restore something the mixer cannot play.
 */
export function readDeckState(raw: unknown, deck: string, defVol: number): DeckState {
  let o: unknown = null;
  try {
    o = JSON.parse(String(raw == null ? "null" : raw));
  } catch (e) {
    o = null;
  }
  const r = recOf(o);
  if (Object.keys(r).length === 0) return { id: null, vol: defVol };
  const id = typeof r.id === "string" && findTrack(deck, r.id) ? r.id : null;
  const vol = typeof r.vol === "number" && r.vol >= 0 && r.vol <= 1 ? r.vol : defVol;
  return { id: id, vol: vol };
}

/** The exact persisted shape: two decimals, nothing else — keeps the LS diff stable. */
export function deckJson(d: DeckState): string {
  return JSON.stringify({ id: d.id, vol: Math.round(d.vol * 100) / 100 });
}

export function audioEnabledFrom(raw: unknown): boolean {
  return raw === null ? true : raw === "1";
}

export function clampVolume(v: unknown): number | null {
  const n = typeof v === "number" ? v : NaN;
  return n >= 0 && n <= 1 ? n : null;
}
