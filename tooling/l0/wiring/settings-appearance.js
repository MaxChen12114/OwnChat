// Browser wiring for services/ui/settings-appearance.ts: a pure bridge, no DOM and no storage of
// its own. The settings cards read localStorage and call these decisions, so the polarities cannot
// drift between the card and the runtime reader.
(function (global) {
  "use strict";
  if (global.settingsAppearance) return;
  global.settingsAppearance = {
    APP_FX_KEY: APP_FX_KEY,
    MEM_IDLE_KEY: MEM_IDLE_KEY,
    UI_LANG_KEY: UI_LANG_KEY,
    appFxOn: appFxOn,
    memIdleOn: memIdleOn,
    langIsEn: langIsEn,
    flagValue: flagValue,
    langValue: langValue,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
