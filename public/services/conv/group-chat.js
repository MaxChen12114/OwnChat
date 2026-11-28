(function () {
/**
 * Group-chat decisions: the @-mention matcher, the auto-relay switches and the orchestration gate.
 *
 * These rules sat inside app.js next to the send loop. They are pure: cards come in as data, the
 * two switches come in as raw storage values, and the gate comes in as four already-read facts.
 * Moving them here lets the tricky bits — name normalization, the two-character substring rule,
 * the 0..100 clamp and the agent-mode short circuit — be asserted without a DOM or a conversation.
 *
 * @module services/conv/group-chat
 */

/** Auto-relay switch; a missing value means ON. */
const LS_AUTO_RELAY = "cfw_group_auto_relay_v1";
/** Random-barge percentage; invalid values fall back to 35. */
const LS_RANDOM_BARGE = "cfw_group_random_barge_v1";
/** Maximum automatic relay streak before the loop yields to the user. */
const MAX_AUTO_STREAK = 5;

/** @returns Auto-relay enabled; a missing setting means ON. */
function autoRelayOn(raw         )          {
  return (raw == null ? "1" : raw) === "1";
}

/** @returns Random barge chance, parsed and clamped to 0..100; invalid input is 35. */
function randomBargeChance(raw         )         {
  const n = parseInt(String(raw ?? ""), 10);
  return isNaN(n) ? 35 : Math.max(0, Math.min(100, n));
}

/** Normalize a card/person name for matching: strip punctuation and spacing, lowercase. */
function normNameForMatch(value         )         {
  return String(value == null ? "" : value).replace(/[\s【】\[\]()（）「」·,，.。!！?？~]/g, "").toLowerCase();
}

function recOf(value         )                          {
  const out                          = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value);
    for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  }
  return out;
}

/**
 * Find a scene card by a name hint. Exact name first, then normalized equality, then a two-character
 * containment check. The original order is the contract; the containment rule requires both sides to
 * be at least two normalized characters so a one-letter hint cannot match everything.
 *
 * @param cards - Scene cards (`multiSvc.getSceneCards()`).
 * @param hint - The name fragment after `@`.
 * @returns The matching card object, or null.
 */
function matchCardByName(cards                    , hint         )                 {
  if (!hint) return null;
  if (!cards.length) return null;
  const raw = String(hint).trim();
  for (let i = 0; i < cards.length; i++) {
    if (recOf(cards[i])["name"] === raw) return cards[i];
  }
  const nh = normNameForMatch(raw);
  if (!nh) return null;
  for (let i = 0; i < cards.length; i++) {
    if (normNameForMatch(recOf(cards[i])["name"]) === nh) return cards[i];
  }
  for (let i = 0; i < cards.length; i++) {
    const cn = normNameForMatch(recOf(cards[i])["name"]);
    if (cn && cn.length >= 2 && nh.length >= 2 && (cn.indexOf(nh) >= 0 || nh.indexOf(cn) >= 0)) return cards[i];
  }
  return null;
}

/**
 * Parse `@name` mentions against the scene cards, preserving first-seen order and dropping
 * duplicates by `id` (the same card mentioned twice appears once).
 *
 * @param text - User message.
 * @param cards - Scene cards.
 * @returns Matching cards in mention order.
 */
function parseMentions(text         , cards                    )            {
  if (!text) return [];
  const found            = [];
  const re = /@([^\s@,，。!！?？:：、]+)/g;
  const s = String(text);
  let m                        ;
  while ((m = re.exec(s)) !== null) {
    const hit = matchCardByName(cards, m[1]);
    if (hit === null) continue;
    const hitId = recOf(hit)["id"];
    let dup = false;
    for (let i = 0; i < found.length; i++) {
      if (recOf(found[i])["id"] === hitId) { dup = true; break; }
    }
    if (!dup) found.push(hit);
  }
  return found;
}

/**
 * Whether the group-chat orchestration mode is active.
 *
 * Agent mode short-circuits to false: multi-agent then becomes a capability gate for meetings and
 * sub-agents, not an automatic relay. Otherwise there must be multi mode, at least two cards, and
 * the fishbowl mode must be `orchestrate` (missing fishbowl means the default).
 *
 * @param inputs - Already-read facts from app.js.
 * @returns True when automatic group chat should run.
 */
function isGroupChatActive(inputs   
                     
                 
                     
                         
 )          {
  if (inputs.agentMode) return false;
  if (!inputs.multi) return false;
  if (!(inputs.sceneCount >= 2)) return false;
  const mode = inputs.fishbowlMode == null ? "orchestrate" : String(inputs.fishbowlMode);
  return mode === "orchestrate";
}

/**
 * The system-prompt fragment that tells the model who is on stage and how to hand the turn over.
 *
 * @param names - On-stage card names (already filtered).
 * @param self - The speaker's display name, or undefined for "当前角色".
 * @returns The fragment, or an empty string when fewer than two names are present.
 */
function groupChatInjection(names                   , self         )         {
  if (names.length < 2) return "";
  const speaker = self ? String(self) : "当前角色";
  return "\n\n【群聊接力】当前是多人群聊,在场角色:" + names.join("、") + "。你只能以「" + speaker + "」的身份说话,绝不替别人代言。用户消息里若出现 @某人,主要是在对那个人说话。当你这句话明显在喊某个在场的人、或话题更适合交给在场的另一个人接时,就在整条回复的最末尾追加一个交棒标记 [next:对方名字](只能点在场的人,不能点自己);不需要交棒时就完全不要输出这个标记。该标记只放在最后,用方括号包裹。";
}

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

globalThis.LS_AUTO_RELAY = LS_AUTO_RELAY;
globalThis.LS_RANDOM_BARGE = LS_RANDOM_BARGE;
globalThis.MAX_AUTO_STREAK = MAX_AUTO_STREAK;
globalThis.autoRelayOn = autoRelayOn;
globalThis.randomBargeChance = randomBargeChance;
globalThis.normNameForMatch = normNameForMatch;
globalThis.matchCardByName = matchCardByName;
globalThis.parseMentions = parseMentions;
globalThis.isGroupChatActive = isGroupChatActive;
globalThis.groupChatInjection = groupChatInjection;
})();
