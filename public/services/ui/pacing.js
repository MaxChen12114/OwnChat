(function () {
/**
 * Reply pacing: the three settings behind "don't answer instantly", the debounce window that folds a
 * burst of messages into one reply, and who speaks first in a group chat.
 *
 * The debounce exists for rhythm, not for throttling: every send only lands in the session, the timer
 * restarts while the user keeps typing, and the model is called once they stop. The typing row appears
 * PACING_TYPING_LEAD_MS before the reply is due, so a message sent mid-window never leaves a stale
 * "typing" row behind.
 *
 * Delays are clamped to PACING_MAX_DELAY_MS: the setting is a free-text number, and a value in the
 * minutes reads as a hang rather than as pacing.
 *
 * Timers, the typing row and the storage reads stay in the wiring; this module only decides.
 *
 * @module services/ui/pacing
 */

const PACING_LS_ENABLED = "cfw_reply_pacing_v1";
const PACING_LS_DELAY = "cfw_reply_pacing_delay_v1";
const PACING_LS_GROUP_ONLINE = "cfw_group_online_mode_v1";

const PACING_DEFAULT_DELAY_MS = 2200;
const PACING_MAX_DELAY_MS = 15000;
/** Random spread added to the base delay, so replies do not land on a metronome. */
const PACING_JITTER_MS = 800;
/** How long the typing row is shown before the reply fires. */
const PACING_TYPING_LEAD_MS = 1200;
/** Re-check interval while the conversation is still busy answering. */
const PACING_BUSY_RETRY_MS = 700;
const PACING_TYPING_TEXT = "正在输入···";

/**
 * `all` answers as the active character; `subset` lets one random scene character open, and an empty
 * cast means nobody does.
 */
                                          

/**
 * Anything but an explicit "0" keeps pacing on, including a missing key — that is what a fresh
 * install looks like, and the feature is on by default.
 */
function pacingEnabledFrom(raw                           )          {
  const value = raw === null || raw === undefined ? "1" : raw;
  return value === "1";
}

/**
 * Non-numeric input falls back to the default instead of disabling the wait, and the result never
 * goes negative.
 */
function pacingDelayFrom(raw                           )         {
  const value = raw === null || raw === undefined ? String(PACING_DEFAULT_DELAY_MS) : raw;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return PACING_DEFAULT_DELAY_MS;
  return Math.max(0, Math.min(PACING_MAX_DELAY_MS, parsed));
}

function pacingGroupOnlineMode(raw                           )             {
  return raw === "subset" ? "subset" : "all";
}

/** A send with neither text nor attachments queues nothing — there would be nothing to answer. */
function pacingShouldQueue(text        , attCount        )          {
  return text.trim().length > 0 || attCount > 0;
}

/**
 * Repeated @-mentions of one character collapse into a single call, preserving first-mention order.
 * Id-less cards are dropped: the call path keys characters by id, so such a card cannot be answered
 * as anyone.
 */
function pacingDedupeCards                            (cards                                   )      {
  const seen = new Set        ();
  const out      = [];
  for (const card of cards) {
    if (!card) continue;
    const id = card.id;
    if (!id) continue;
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(card);
  }
  return out;
}

/**
 * Random pick from the scene cast, optionally skipping the character that already answered. Returns
 * null on an empty pool, which the caller reads as "nobody is online".
 *
 * `rand` is injected so the pick is reproducible under test; the index is clamped because a
 * non-standard generator returning 1 would otherwise read past the end.
 */
function pacingPickOnlineCard                            (
  cards                                   ,
  excludeId               ,
  rand              ,
)           {
  const pool      = [];
  for (const card of cards) {
    if (!card) continue;
    if (excludeId !== null && String(card.id ?? "") === excludeId) continue;
    pool.push(card);
  }
  if (pool.length === 0) return null;
  const index = Math.floor(rand() * pool.length);
  return pool[Math.min(index, pool.length - 1)];
}

                               
                                           
                
                                                                                          
                   
 

function pacingTiming(baseDelay        , rand              )               {
  const delay = baseDelay + Math.floor(rand() * PACING_JITTER_MS);
  return { delay, typingAt: Math.max(0, delay - PACING_TYPING_LEAD_MS) };
}

/** The typing row's text; an empty label leaves only the bare indicator. */
function pacingTypingText(label                           )         {
  const prefix = typeof label === "string" && label.length > 0 ? label + " " : "";
  return prefix + PACING_TYPING_TEXT;
}

                                     
                                                                                   
                      
                                                                                              
                    
                                                                         
                 
 

/**
 * Who answers a queued send. A group with @-mentions answers each mentioned character in turn;
 * without mentions, `subset` lets one random online character open and `all` keeps the active one
 * (and stays silent about the card, so the engine keeps its own default).
 *
 * The per-call early exits (conversation switched mid-loop, a null reply from one character) stay
 * with the caller: they depend on what each call returns, which a plan cannot know.
 */
function pacingReplyPlan                            (input   
                 
                                                    
                   
                       
                                                  
                     
 )                     {
  if (!input.group) return { cards: [null], speaker: null, relay: false };
  const targets = pacingDedupeCards(input.targets || []);
  if (targets.length > 0) {
    const last = targets[targets.length - 1];
    return { cards: targets.slice(), speaker: last, relay: true };
  }
  const first = input.mode === "subset" ? pacingPickOnlineCard(input.cards || [], null, input.rand) : null;
  return { cards: [first], speaker: first ?? input.activeCard, relay: true };
}

// Browser adapter, appended by l0/emit.mjs. Engine: services/ui/pacing.ts (settings parsing, the
// debounce timing, who answers in a group); this file owns the timers, the typing row and the host
// ports.
//
// The host object is the engine's own surface: pushUser writes UI and session without calling the
// model, afterQueue clears the input and settles the scroll, sendOne performs exactly one reply for
// one character. Nothing here reaches past those ports, which is what keeps the debounce testable.
//
// Two states a naive debounce gets wrong: a burst of sends must keep resetting one timer (not pile up
// replies), and a conversation that is still answering must retry instead of dropping the queued turn.
(function () {
  "use strict";
  if (window.__pacing) return;

  window.__pacing = {
    create(host) {
      host = host || {};
      const doc = window.document;
      const getInput = host.getInput || (() => null);
      const attCount = host.attCount || (() => 0);
      const pushUser = host.pushUser || (() => {});
      const afterQueue = host.afterQueue || (() => {});
      const isGroupChatActive = host.isGroupChatActive || (() => false);
      const parseAtMentions = host.parseAtMentions || (() => []);
      const getActiveCard = host.getActiveCard || (() => null);
      const isConvBusy = host.isConvBusy || (() => false);
      const activeConvId = host.activeConvId || (() => "");
      const sendOne = host.sendOne || (async () => null);
      const runAutoRelay = host.runAutoRelay || (() => {});
      const getChat = host.getChat || (() => null);
      const getSpacer = host.getSpacer || (() => null);
      const isNearBottom = host.isNearBottom || (() => false);
      const scrollToBottom = host.scrollToBottom || (() => {});

      function lsGet(key) {
        return window.localStorage.getItem(key);
      }
      function pacingEnabled() { return pacingEnabledFrom(lsGet(PACING_LS_ENABLED)); }
      function pacingBaseDelay() { return pacingDelayFrom(lsGet(PACING_LS_DELAY)); }
      function groupOnlineMode() { return pacingGroupOnlineMode(lsGet(PACING_LS_GROUP_ONLINE)); }

      function sceneCards() {
        try {
          const multi = window.multiSvc;
          const read = multi && multi.getSceneCards;
          return typeof read === "function" ? read() || [] : [];
        } catch (e) { return []; }
      }

      let typingEl = null;
      function showTyping(label) {
        hideTyping();
        const el = doc.createElement("div");
        el.className = "row ai pacing-typing";
        const av = doc.createElement("div");
        av.className = "avatar bot";
        av.textContent = "🙂";
        const content = doc.createElement("div");
        content.className = "content";
        const bubble = doc.createElement("div");
        bubble.className = "bubble ai wechat-typing";
        bubble.textContent = pacingTypingText(label);
        content.appendChild(bubble);
        el.appendChild(av);
        el.appendChild(content);
        getChat().insertBefore(el, getSpacer());
        typingEl = el;
        if (isNearBottom()) scrollToBottom();
      }
      function hideTyping() {
        if (typingEl && typingEl.parentNode) typingEl.parentNode.removeChild(typingEl);
        typingEl = null;
      }

      let pendingTimer = null;
      let pendingTypingTimer = null;
      let pendingTargets = null;
      function clearPendingTimers() {
        if (pendingTimer) { window.clearTimeout(pendingTimer); pendingTimer = null; }
        if (pendingTypingTimer) { window.clearTimeout(pendingTypingTimer); pendingTypingTimer = null; }
      }

      function queueSend() {
        const inputEl = getInput();
        const raw = inputEl.value.trim();
        if (!pacingShouldQueue(raw, attCount())) return;
        if (isGroupChatActive()) {
          const mentioned = parseAtMentions(raw);
          if (mentioned.length) pendingTargets = pacingDedupeCards((pendingTargets || []).concat(mentioned));
        }
        pushUser(raw);
        afterQueue();
        clearPendingTimers();
        hideTyping();
        const timing = pacingTiming(pacingBaseDelay(), () => Math.random());
        pendingTypingTimer = window.setTimeout(() => { showTyping(); }, timing.typingAt);
        pendingTimer = window.setTimeout(function fire() {
          if (isConvBusy(activeConvId())) { pendingTimer = window.setTimeout(fire, PACING_BUSY_RETRY_MS); return; }
          clearPendingTimers();
          hideTyping();
          const targets = pendingTargets;
          pendingTargets = null;
          fireReply(targets);
        }, timing.delay);
      }

      async function fireReply(targets) {
        const plan = pacingReplyPlan({
          group: isGroupChatActive(),
          targets: targets,
          mode: groupOnlineMode(),
          activeCard: getActiveCard(),
          cards: sceneCards(),
          rand: () => Math.random(),
        });
        if (!plan.relay) return sendOne({ allowEmptyText: true });
        let reply = null;
        for (let i = 0; i < plan.cards.length; i++) {
          if (i > 0 && !isGroupChatActive()) break;
          const card = plan.cards[i];
          const r = card
            ? await sendOne({ allowEmptyText: true, asCard: card })
            : await sendOne({ allowEmptyText: true });
          if (i > 0 && r == null) break;
          reply = r;
        }
        if (reply != null) runAutoRelay(reply, plan.speaker);
        return reply;
      }

      return {
        pacingEnabled, pacingBaseDelay, groupOnlineMode,
        showTyping, hideTyping,
        dedupeCards: (cards) => pacingDedupeCards(cards || []),
        pickRandomOnlineCard: (excludeCard) => pacingPickOnlineCard(
          sceneCards(),
          excludeCard && typeof excludeCard.id === "string" ? excludeCard.id : null,
          () => Math.random(),
        ),
        queueSend, fireReply, clearPendingTimers,
        _debugPending: () => ({ timer: !!pendingTimer, typingTimer: !!pendingTypingTimer, targets: pendingTargets }),
      };
    },
  };
})();

globalThis.PACING_LS_ENABLED = PACING_LS_ENABLED;
globalThis.PACING_LS_DELAY = PACING_LS_DELAY;
globalThis.PACING_LS_GROUP_ONLINE = PACING_LS_GROUP_ONLINE;
globalThis.PACING_DEFAULT_DELAY_MS = PACING_DEFAULT_DELAY_MS;
globalThis.PACING_MAX_DELAY_MS = PACING_MAX_DELAY_MS;
globalThis.PACING_JITTER_MS = PACING_JITTER_MS;
globalThis.PACING_TYPING_LEAD_MS = PACING_TYPING_LEAD_MS;
globalThis.PACING_BUSY_RETRY_MS = PACING_BUSY_RETRY_MS;
globalThis.PACING_TYPING_TEXT = PACING_TYPING_TEXT;
globalThis.pacingEnabledFrom = pacingEnabledFrom;
globalThis.pacingDelayFrom = pacingDelayFrom;
globalThis.pacingGroupOnlineMode = pacingGroupOnlineMode;
globalThis.pacingShouldQueue = pacingShouldQueue;
globalThis.pacingDedupeCards = pacingDedupeCards;
globalThis.pacingPickOnlineCard = pacingPickOnlineCard;
globalThis.pacingTiming = pacingTiming;
globalThis.pacingTypingText = pacingTypingText;
globalThis.pacingReplyPlan = pacingReplyPlan;
})();
