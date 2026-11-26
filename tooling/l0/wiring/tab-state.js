// Browser wiring for services/panel/tab-state.ts. The emitter's export bridge already publishes
// the `panelTabs` namespace and the five constants on globalThis, so there is nothing to mount here:
// the file exists because every service in the emit registry owns a wiring, and that is where a
// future frozen name (if one is ever needed) would live.
(function (global) {
  "use strict";
  if (global.panelTabs) return;
})(window);
