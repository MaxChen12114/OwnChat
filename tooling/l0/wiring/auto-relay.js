// Browser wiring for services/conv/auto-relay.ts: a pure bridge. app.js owns the loop, typing and
// sendOne; the tag parse, the barge pick, the subset drop and the three delays come from here.
(function (global) {
  "use strict";
  if (global.autoRelaySvc) return;
  global.autoRelaySvc = {
    summonName: summonName,
    pickBargeCard: pickBargeCard,
    subsetDrops: subsetDrops,
    relayDelayMs: relayDelayMs,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
