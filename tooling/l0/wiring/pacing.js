// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/ui/pacing.ts (settings parsing, the
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
