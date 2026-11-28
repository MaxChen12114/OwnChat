// Browser wiring for services/conv/group-chat.ts: a pure bridge. app.js reads localStorage and the
// scene cards, then calls these decisions; no DOM or storage lives here.
(function (global) {
  "use strict";
  if (global.groupChatSvc) return;
  global.groupChatSvc = {
    LS_AUTO_RELAY: LS_AUTO_RELAY,
    LS_RANDOM_BARGE: LS_RANDOM_BARGE,
    MAX_AUTO_STREAK: MAX_AUTO_STREAK,
    autoRelayOn: autoRelayOn,
    randomBargeChance: randomBargeChance,
    normNameForMatch: normNameForMatch,
    matchCardByName: matchCardByName,
    parseMentions: parseMentions,
    isGroupChatActive: isGroupChatActive,
    groupChatInjection: groupChatInjection,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
