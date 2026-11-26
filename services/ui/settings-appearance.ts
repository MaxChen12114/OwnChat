/**
 * Appearance-tab switch rules: the defaults and polarities for the mobile layout, the shell effect
 * tier and the idle-memory switch, plus the language value. These are the only decisions behind
 * those three cards; localStorage reads and the DOM stay in the settings wiring.
 *
 * Polarities are deliberately different and easy to invert by accident:
 * mobile tabs default OFF inside the Android shell and ON elsewhere; rich effects default OFF;
 * idle memory release defaults ON. A single source is cheaper than three inline guesses.
 * @module services/ui/settings-appearance
 */

/** Device-local keys, kept beside their readers. */
export const MOBILE_TABS_KEY = "cfw_mobile_bottom_tabs_v1";
export const APP_FX_KEY = "cfw_app_fx_rich_v1";
export const MEM_IDLE_KEY = "cfw_mem_idle_release_v1";
export const UI_LANG_KEY = "cfw_ui_lang_v1";

/** The shell marker: the html class wins over the persisted flag. */
export function isAndroidShell(hasClass: boolean, shellFlag: string | null): boolean {
  return hasClass || shellFlag === "1";
}

/**
 * Bottom tabs default: off in the Android shell (the composer is the primary surface), on in a
 * browser. An explicit saved value always wins.
 */
export function mobileTabsOn(android: boolean, saved: string | null): boolean {
  return android ? saved === "1" : saved !== "0";
}

/** Rich shell effects are opt-in; anything other than "1" is the fast tier. */
export function appFxOn(saved: string | null): boolean {
  return saved === "1";
}

/** Idle memory release is opt-out: only an explicit "0" turns it off. */
export function memIdleOn(saved: string | null): boolean {
  return saved !== "0";
}

/** English is the only non-default UI language; any other stored value means Chinese. */
export function langIsEn(saved: string | null): boolean {
  return saved === "en";
}

/** Persisted boolean form used by every switch in this file. */
export function flagValue(on: boolean): "1" | "0" {
  return on ? "1" : "0";
}

/** Persisted language form; `zh` is written explicitly so the key never stays stale. */
export function langValue(en: boolean): "en" | "zh" {
  return en ? "en" : "zh";
}
