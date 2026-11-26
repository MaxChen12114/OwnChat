// Browser wiring for services/chat/system-prompts.ts: a pure bridge. app.js reads localStorage and
// the card's capability snapshot, then asks for the assembled block or the agent-mode answer.
(function (global) {
  "use strict";
  if (global.systemPromptsSvc) return;
  global.systemPromptsSvc = {
    PROMPT_PRESETS_KEY: PROMPT_PRESETS_KEY,
    AGENT_MODE_KEY: AGENT_MODE_KEY,
    buildExtra: buildExtraSystemPrompts,
    agentModeOn: agentModeOn,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
