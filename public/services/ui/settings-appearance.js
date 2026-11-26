(function () {
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
const MOBILE_TABS_KEY = "cfw_mobile_bottom_tabs_v1";
const APP_FX_KEY = "cfw_app_fx_rich_v1";
const MEM_IDLE_KEY = "cfw_mem_idle_release_v1";
const UI_LANG_KEY = "cfw_ui_lang_v1";

/** The shell marker: the html class wins over the persisted flag. */
function isAndroidShell(hasClass         , shellFlag               )          {
  return hasClass || shellFlag === "1";
}

/**
 * Bottom tabs default: off in the Android shell (the composer is the primary surface), on in a
 * browser. An explicit saved value always wins.
 */
function mobileTabsOn(android         , saved               )          {
  return android ? saved === "1" : saved !== "0";
}

/** Rich shell effects are opt-in; anything other than "1" is the fast tier. */
function appFxOn(saved               )          {
  return saved === "1";
}

/** Idle memory release is opt-out: only an explicit "0" turns it off. */
function memIdleOn(saved               )          {
  return saved !== "0";
}

/** English is the only non-default UI language; any other stored value means Chinese. */
function langIsEn(saved               )          {
  return saved === "en";
}

/** Persisted boolean form used by every switch in this file. */
function flagValue(on         )            {
  return on ? "1" : "0";
}

/** Persisted language form; `zh` is written explicitly so the key never stays stale. */
function langValue(en         )              {
  return en ? "en" : "zh";
}

// Browser wiring for services/ui/settings-appearance.ts: a pure bridge, no DOM and no storage of
// its own. The settings cards read localStorage and call these decisions, so the three polarities
// cannot drift between the card and the runtime reader.
(function (global) {
  "use strict";
  if (global.settingsAppearance) return;
  global.settingsAppearance = {
    MOBILE_TABS_KEY: MOBILE_TABS_KEY,
    APP_FX_KEY: APP_FX_KEY,
    MEM_IDLE_KEY: MEM_IDLE_KEY,
    UI_LANG_KEY: UI_LANG_KEY,
    isAndroidShell: isAndroidShell,
    mobileTabsOn: mobileTabsOn,
    appFxOn: appFxOn,
    memIdleOn: memIdleOn,
    langIsEn: langIsEn,
    flagValue: flagValue,
    langValue: langValue,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);

globalThis.MOBILE_TABS_KEY = MOBILE_TABS_KEY;
globalThis.APP_FX_KEY = APP_FX_KEY;
globalThis.MEM_IDLE_KEY = MEM_IDLE_KEY;
globalThis.UI_LANG_KEY = UI_LANG_KEY;
globalThis.isAndroidShell = isAndroidShell;
globalThis.mobileTabsOn = mobileTabsOn;
globalThis.appFxOn = appFxOn;
globalThis.memIdleOn = memIdleOn;
globalThis.langIsEn = langIsEn;
globalThis.flagValue = flagValue;
globalThis.langValue = langValue;
})();
