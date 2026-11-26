(function () {
/**
 * The chat-area interaction rules that used to live inside DOM event handlers, extracted so the
 * arithmetic can be locked by tests and the wiring layer stays a pure DOM adapter.
 *
 * The turn-deletion plan is the part worth locking. Row order in the DOM is NOT the session index:
 * agent tool rounds fold into the assistant row that follows them, so a naive `allRows.indexOf`
 * truncates/deletes the wrong messages and leaves dangling tool_calls on disk (the root cause of
 * "every request 400s after restart"). Rows carry `data-sidx` (written by the renderer) and the
 * plan prefers it, falling back to DOM indices only for pre-sidx data. The delete spans one full
 * turn: the anchor's nearest preceding user row through just before the next user row.
 *
 * Resend restores the ORIGINAL message text from the session, not the bubble text: the bubble only
 * holds file chips, and truncating on a chip-only rebuild would permanently drop attachment
 * payloads. A textless resend is still allowed when the original message carries attachments.
 *
 * Scroll following: track to bottom when the user is within FOLLOW_DIST of it, stay out of the way
 * while they read, yield completely while a touch/wheel gesture is active (TOUCH_WINDOW_MS after
 * the last gesture event) because a per-character smooth scroll fight reads as input lag.
 * @module services/ui/chat-ux
 */

/** localStorage key the desktop welcome page writes on dismiss. Cleared on boot so dismissal lasts
 * one session only; the wiring layer also clears it one tick after a close click to override the
 * synchronous write index.html performs inline. */
const CHATUX_WELCOME_DISMISSED_KEY = "cfw_welcome_dismissed_v1";

/** Distance (px) from the bottom inside which new messages keep auto-following. */
const CHATUX_FOLLOW_DIST = 60;

/** After a touch/wheel/pointer gesture, auto-follow stays suppressed this long (ms). */
const CHATUX_TOUCH_WINDOW_MS = 500;

/** One row as the plan sees it: user vs AI, and the session index the renderer stamped on it. */
                        
                  
                      
 

/** What the wiring layer must remove and what it must tell the session to delete. */
                                 
                                                        
                   
                                       
                 
                                                                                             
                
                                                               
                
                                                                                           
                     
 

/** Parse a `data-sidx` attribute. Valid non-negative integers win; anything else yields the
 * fallback (which may itself be null, meaning "unknown"). */
function chatUxParseSidx(raw         , fallback               )                {
  const v = typeof raw === "string" ? parseInt(raw, 10) : NaN;
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** Compute the delete plan for one turn. Returns null when the anchor is out of range — the caller
 * must then do nothing at all, not "delete one row", so a stale anchor can never clip the session. */
function chatUxPlanTurnDelete(
  rows         ,
  anchorIdx        ,
  sessionLen               ,
)                        {
  if (anchorIdx < 0 || anchorIdx >= rows.length) return null;
  let startIdx = anchorIdx;
  for (let i = anchorIdx; i >= 0; i--) {
    if (rows[i].isUser) {
      startIdx = i;
      break;
    }
  }
  let endIdx = rows.length;
  for (let i = startIdx + 1; i < rows.length; i++) {
    if (rows[i].isUser) {
      endIdx = i;
      break;
    }
  }
  const startSidx = rows[startIdx].sidx;
  if (startSidx !== null && sessionLen !== null) {
    let endSidx         = sessionLen;
    for (let i = endIdx; i < rows.length; i++) {
      if (rows[i].isUser) {
        const v = rows[i].sidx;
        if (v !== null) endSidx = v;
        break;
      }
    }
    return {
      startIdx,
      endIdx,
      start: startSidx,
      count: Math.max(1, endSidx - startSidx),
      bySession: true,
    };
  }
  return {
    startIdx,
    endIdx,
    start: startIdx,
    count: Math.max(1, endIdx - startIdx),
    bySession: false,
  };
}

/** Text a resend should put back into the composer: the original session content when it is a
 * string, else the bubble text (pre-sidx rows may lack a retrievable original). */
function chatUxResendText(
  msg                                ,
  bubbleText        ,
)         {
  const content = msg ? msg["content"] : undefined;
  return typeof content === "string" ? content : bubbleText;
}

/** A textless resend gives up only when the original message carries no attachments either —
 * otherwise retrying an attachments-only message would silently do nothing. */
function chatUxResendShouldGiveUp(
  msg                                ,
  userText        ,
)          {
  if (userText) return false;
  if (!msg) return true;
  const files = Array.isArray(msg["files"]) ? msg["files"] : [];
  const images = Array.isArray(msg["images"]) ? msg["images"] : [];
  return files.length === 0 && images.length === 0;
}

/** The stop button is only visible while its row is the active stream. */
function chatUxIsStreaming(streamingAttr         )          {
  return streamingAttr === "1";
}

/** Whether new content should pull the view to the bottom: the user was already at the bottom
 * (autoScroll) and still is within FOLLOW_DIST of it. */
function chatUxShouldFollow(distFromBottom        , autoScroll         )          {
  return autoScroll && distFromBottom < CHATUX_FOLLOW_DIST;
}

/** Extend the gesture-suppression window. The window only ever moves forward, so a flood of
 * passive scroll events cannot push the deadline past TOUCH_WINDOW_MS after the latest gesture. */
function chatUxNextTouchUntil(currentUntil        , now        )         {
  const until = now + CHATUX_TOUCH_WINDOW_MS;
  return until > currentUntil ? until : currentUntil;
}

/** True while a gesture is still holding the scroll position (now strictly before the deadline). */
function chatUxIsTouchActive(touchUntil        , now        )          {
  return now < touchUntil;
}

// Browser adapter, appended by l0/emit.mjs. Engine: services/ui/chat-ux.ts; this file owns the
// DOM: row action buttons (copy / retry / delete / stop), the mutation observers and the scroll
// listeners. Every decision lives in the engine — turn spans, sidx parsing, resend give-up rules,
// follow distances and the gesture-suppression window.
//
// Interface with app.js (frozen window globals):
//   window.__abortCurrent(discardPartial?)   retry/delete pass true to drop partialStream
//   window.__sessionTruncateTo(n)            truncate session to n messages
//   window.__sessionDeleteAt(start, count)   delete a span of session messages
//   window.__resetSending()                  force-unlock isSending and the Send button
//   window.__stopCurrent()                   full stop semantics (release gate + abort + unlock)
// The AI row's .row.ai carries dataset.streaming === "1" while a stream is active.
(function () {
  "use strict";

  // ────────────────────────────────────────────────────────────
  // Desktop welcome page: closing it hides it for THIS SESSION ONLY, never permanently (runtime
  // patch, index.html untouched). index.html's ✕ handler writes LS cfw_welcome_dismissed_v1='1'
  // synchronously, which used to kill the welcome page forever. Here: ① boot clears the persisted
  // flag so every launch counts as not-yet-dismissed; ② after a close click, clear the key one
  // tick later to override the inline write — the page stays hidden for the session but returns on
  // relaunch. The web build has no html.is-desktop, so the welcome page is already display:none
  // there and this block is a no-op.
  // ────────────────────────────────────────────────────────────
  (function welcomeDismissFix() {
    const KEY = CHATUX_WELCOME_DISMISSED_KEY;
    try { localStorage.removeItem(KEY); } catch (e) {}
    try { document.documentElement.classList.remove("welcome-dismissed"); } catch (e) {}
    function wire() {
      const cb = document.getElementById("owCloseBtn");
      if (!cb || cb.__uxDismissFix) return;
      cb.__uxDismissFix = "1";
      cb.addEventListener("click", function () {
        // The inline handler in index.html writes LS='1' synchronously; clear one tick later so
        // this session keeps the page hidden but nothing persists.
        setTimeout(function () {
          try { localStorage.removeItem(KEY); } catch (e) {}
        }, 0);
      });
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
    else wire();
    setTimeout(wire, 800);
  })();

  // ────────────────────────────────────────────────────────────
  // Row action buttons
  // ────────────────────────────────────────────────────────────
  window.addEventListener("load", function () {
    const chat = document.getElementById("chat");
    const sendBtn = document.getElementById("sendBtn");
    const msgInput = document.getElementById("msg");
    if (!chat || !sendBtn || !msgInput) return;

    // Styling lives in styles.css .msg-action-btn, shared with the Phase 4 theme system
    // (minimal / glass). 2026-09-14: linear SVG icons replaced bare text glyphs (■ U+25A0 /
    // ↺ U+21BA) which rendered as emoji on some platforms. Buttons are borderless, icon-only,
    // with the label in title/aria-label; text labels were wide and noisy.
    const ICON_STOP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
    const ICON_RETRY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>';
    const ICON_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.2"/><path d="M15 6.5V5.2A2.2 2.2 0 0 0 12.8 3H5.2A2.2 2.2 0 0 0 3 5.2v7.6A2.2 2.2 0 0 0 5.2 15h1.3"/></svg>';
    const ICON_DEL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M9.5 7V5.4A1.4 1.4 0 0 1 10.9 4h2.2a1.4 1.4 0 0 1 1.4 1.4V7"/><path d="M6.5 7l.8 12a1.6 1.6 0 0 0 1.6 1.5h6.2a1.6 1.6 0 0 0 1.6-1.5L17.5 7"/><path d="M10.5 11v6M13.5 11v6"/></svg>';
    function makeBtn(label, iconSvg) {
      const btn = document.createElement("button");
      btn.className = "msg-action-btn";
      if (iconSvg) {
        btn.innerHTML = iconSvg;
        btn.classList.add("icon-only");
      } else {
        btn.textContent = label;
      }
      btn.setAttribute("title", label);
      btn.setAttribute("aria-label", label);
      return btn;
    }

    // Shared: copy a bubble's text, with a navigator.clipboard + execCommand fallback for mobile.
    function bindCopy(btn, bubbleSelector, row) {
      btn.addEventListener("click", () => {
        const bubble = row.querySelector(bubbleSelector);
        const text = bubble ? bubble.textContent.trim() : "";
        const doFallback = () => {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;font-size:16px;";
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          try {
            document.execCommand("copy");
            btn.classList.add("ok");
          } catch {
            btn.textContent = "失败";
          }
          document.body.removeChild(ta);
          setTimeout(() => btn.classList.remove("ok"), 1200);
        };
        if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard
            .writeText(text)
            .then(() => {
              btn.classList.add("ok");
              setTimeout(() => btn.classList.remove("ok"), 1200);
            })
            .catch(doFallback);
        } else {
          doFallback();
        }
      });
    }

    // Rows as the engine sees them. DOM row order is NOT the session index (agent tool rounds fold
    // into the following AI row) — data-sidx, stamped by the renderer, is authoritative; the engine
    // falls back to DOM indices only for pre-sidx data.
    function sidOf(row, fallback) {
      return chatUxParseSidx(row && row.dataset ? row.dataset.sidx : undefined, fallback);
    }
    function sessionLen() {
      try {
        const a = window.hostApi.app && window.hostApi.app.getSessionMessages ? window.hostApi.app.getSessionMessages() : null;
        return a && typeof a.length === "number" ? a.length : null;
      } catch (e) { return null; }
    }
    function collectRows() {
      return Array.from(chat.querySelectorAll(".row")).map((r) => ({
        isUser: r.classList.contains("user"),
        sidx: sidOf(r, null),
      }));
    }

    // Shared: resend from a user row — remove every row from it down, truncate the session, refill
    // the composer and trigger send.
    function resendFromUserRow(userRow) {
      if (typeof window.__abortCurrent === "function") window.__abortCurrent(true);
      const allRows = Array.from(chat.querySelectorAll(".row"));
      const userIdx = allRows.indexOf(userRow);
      if (userIdx < 0) return;
      const bubble = userRow.querySelector(".bubble.user");
      if (!bubble) return;
      // 2026-09-14 attachment rework: the bubble holds file chips only, never file payloads, and
      // truncating would drop the original message (with full attachment text) from memory and
      // disk. Restore the ORIGINAL message from the session and re-stage its attachments instead.
      // 2026-10-08: read and truncate by the real index (sidx) — DOM row order is wrong on
      // sessions with agent tool rounds, which used to resend someone else's message.
      const sidx = sidOf(userRow, userIdx);
      let msg = null;
      try { msg = window.hostApi.app && window.hostApi.app.getSessionMessageAt ? window.hostApi.app.getSessionMessageAt(sidx) : null; } catch (e) {}
      const userText = chatUxResendText(msg, bubble.textContent.trim());
      if (chatUxResendShouldGiveUp(msg, userText)) return; // empty text AND no attachments
      for (let i = allRows.length - 1; i >= 0; i--) allRows[i].remove();
      try {
        if (msg && window.attachSvc && window.attachSvc.restage) window.attachSvc.restage(msg);
      } catch (e) {}
      if (typeof window.__sessionTruncateTo === "function") {
        window.__sessionTruncateTo(sidx);
      }
      if (typeof window.__resetSending === "function") window.__resetSending();
      else {
        sendBtn.disabled = false;
        sendBtn.textContent = "Send";
      }
      msgInput.value = userText;
      msgInput.dispatchEvent(new Event("input"));
      setTimeout(() => {
        msgInput.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
        );
      }, 30);
    }

    // Shared: delete one full turn — the user row and/or its AI reply, plus any messages agent
    // tool rounds persisted. `mode` stays in the signature for caller compatibility (the
    // fromUser/fromAi distinction is subsumed by the turn boundary).
    function deleteRowPair(anchorRow, mode) {
      void mode;
      if (typeof window.__abortCurrent === "function") window.__abortCurrent(true);
      const allRows = Array.from(chat.querySelectorAll(".row"));
      const idx = allRows.indexOf(anchorRow);
      if (idx < 0) return;
      const plan = chatUxPlanTurnDelete(collectRows(), idx, sessionLen());
      if (!plan) return;
      for (let i = plan.endIdx - 1; i >= plan.startIdx; i--) allRows[i].remove();
      if (typeof window.__sessionDeleteAt === "function") {
        // bySession: delete the real session span. Pre-sidx fallback: delete by the just-removed
        // DOM row count (closer to the real turn span than the old fixed ±1). Both cases pass
        // plan.start/plan.count — the engine picked which interpretation the arguments carry.
        window.__sessionDeleteAt(plan.start, plan.count);
      }
      // __abortCurrent(true) already discarded partialStream, but its streaming row can linger in
      // the DOM — removing it here avoids a dangling AI row while the session has one message less.
      chat.querySelectorAll('.row.ai[data-streaming="1"]').forEach((r) => r.remove());
    }

    function addAiButtons(aiRow) {
      if (aiRow.dataset.btnsAttached) return;
      aiRow.dataset.btnsAttached = "1";
      const content = aiRow.querySelector(".content");
      if (!content) return;

      const wrap = document.createElement("div");
      wrap.className = "my-action-btns";
      wrap.style.cssText =
        "display:flex;justify-content:flex-start;gap:8px;padding:4px 4px 2px;flex-wrap:wrap;";

      // Stop (visible only mid-stream; full stop semantics: releases the waiting gate, aborts the
      // request, unlocks Send. The old abort-fetch-only version never unwound a loop blocked on a
      // permission wait, so isSending stayed locked until relaunch).
      const stopBtn = makeBtn("停止", ICON_STOP);
      stopBtn.classList.add("my-stop-btn");
      stopBtn.style.display = chatUxIsStreaming(aiRow.dataset.streaming) ? "" : "none";
      stopBtn.addEventListener("click", () => {
        if (typeof window.__stopCurrent === "function") window.__stopCurrent();
        else if (typeof window.__abortCurrent === "function") window.__abortCurrent();
        stopBtn.style.display = "none";
        try {
          delete aiRow.dataset.streaming;
        } catch {
          aiRow.removeAttribute("data-streaming");
        }
      });

      const copyBtn = makeBtn("复制", ICON_COPY);
      bindCopy(copyBtn, ".bubble.ai", aiRow);

      // Retry: resend from the preceding user message.
      const retryBtn = makeBtn("重试", ICON_RETRY);
      retryBtn.addEventListener("click", () => {
        const allRows = Array.from(chat.querySelectorAll(".row"));
        const aiIdx = allRows.indexOf(aiRow);
        if (aiIdx < 0) return;
        const prev = allRows[aiIdx - 1];
        if (!prev || !prev.classList.contains("user")) return;
        resendFromUserRow(prev);
      });

      // Delete: this AI row plus the user message before it, streaming leftovers cleaned up.
      const delBtn = makeBtn("删除", ICON_DEL);
      delBtn.addEventListener("click", () => deleteRowPair(aiRow, "fromAi"));

      wrap.appendChild(stopBtn);
      wrap.appendChild(retryBtn);
      wrap.appendChild(delBtn);
      wrap.appendChild(copyBtn);
      content.appendChild(wrap);
    }

    function addUserButtons(userRow) {
      if (userRow.dataset.btnsAttached) return;
      userRow.dataset.btnsAttached = "1";
      const content = userRow.querySelector(".content");
      if (!content) return;

      const wrap = document.createElement("div");
      wrap.className = "my-action-btns";
      wrap.style.cssText =
        "display:flex;justify-content:flex-end;gap:8px;padding:4px 4px 2px;flex-wrap:wrap;";

      const copyBtn = makeBtn("复制", ICON_COPY);
      bindCopy(copyBtn, ".bubble.user", userRow);

      // Retry: resend from this user message; everything after it is dropped.
      const retryBtn = makeBtn("重试", ICON_RETRY);
      retryBtn.addEventListener("click", () => resendFromUserRow(userRow));

      // Delete: this user row plus the AI reply right after it.
      const delBtn = makeBtn("删除", ICON_DEL);
      delBtn.addEventListener("click", () => deleteRowPair(userRow, "fromUser"));

      wrap.appendChild(retryBtn);
      wrap.appendChild(delBtn);
      wrap.appendChild(copyBtn);
      content.appendChild(wrap);
    }

    // Watch for newly added message rows and attach buttons (streaming replies, history restore,
    // multi-agent switching all trigger this).
    const observer = new MutationObserver(() => {
      chat.querySelectorAll(".row.ai").forEach(addAiButtons);
      chat.querySelectorAll(".row.user").forEach(addUserButtons);
    });
    observer.observe(chat, { childList: true });

    // First load: attach buttons to restored history too.
    chat.querySelectorAll(".row.ai").forEach(addAiButtons);
    chat.querySelectorAll(".row.user").forEach(addUserButtons);
  });

  // ────────────────────────────────────────────────────────────
  // Smart auto-scroll. (The old my-comfort.js light/dark switching was peeled off in Phase 4 and
  // is owned by theme.js; the legacy "my-theme" LS key has no readers left.)
  // ────────────────────────────────────────────────────────────
  window.addEventListener("load", function () {
    const chat = document.getElementById("chat");
    const history = document.getElementById("history");
    if (!chat || !history) return;

    // Follow to the latest message while the user sits at the bottom; leave them alone while they
    // scroll up to read.
    let autoScroll = true;
    history.addEventListener(
      "scroll",
      () => {
        const dist = history.scrollHeight - history.scrollTop - history.clientHeight;
        autoScroll = chatUxShouldFollow(dist, true);
      },
      { passive: true }
    );

    // 2026-10-07 drag-lag fix (E-A): while a finger is scrolling, auto-follow must yield. The old
    // implementation fired a smooth scroll per ~70ms text mutation, so holding the finger kept
    // yanking the position back — mobile read this as sluggish drag feedback. Now: ① programmatic
    // scrolls are instant (behavior:"auto"), never competing with gesture animation; ② auto-follow
    // pauses for TOUCH_WINDOW_MS after the last touch/wheel/pointer event, control fully in the
    // finger. The window value is shared with app.js's scroll path via window.__scrollTouchUntil
    // (the repo's established window-global wiring style); the deadline math lives in the engine.
    const markUserScroll = () => {
      window.__scrollTouchUntil = chatUxNextTouchUntil(window.__scrollTouchUntil || 0, Date.now());
    };
    ["touchstart", "touchmove", "wheel", "pointerdown"].forEach((ev) => {
      history.addEventListener(ev, markUserScroll, { passive: true });
    });

    const scrollObserver = new MutationObserver(() => {
      if (!autoScroll) return;
      if (chatUxIsTouchActive(window.__scrollTouchUntil || 0, Date.now())) return; // finger still scrolling — yield
      history.scrollTo({ top: history.scrollHeight, behavior: "auto" });
    });
    scrollObserver.observe(chat, { childList: true, subtree: true, characterData: true });

    // Clicking Send: force to the bottom even if the user had scrolled up into history.
    const sendBtn = document.getElementById("sendBtn");
    if (sendBtn) {
      sendBtn.addEventListener("click", () => {
        autoScroll = true;
        window.__scrollTouchUntil = 0; // an explicit send outranks the gesture suppression window
        setTimeout(() => {
          history.scrollTo({ top: history.scrollHeight, behavior: "auto" });
        }, 50);
      });
    }
  });
})();

globalThis.CHATUX_WELCOME_DISMISSED_KEY = CHATUX_WELCOME_DISMISSED_KEY;
globalThis.CHATUX_FOLLOW_DIST = CHATUX_FOLLOW_DIST;
globalThis.CHATUX_TOUCH_WINDOW_MS = CHATUX_TOUCH_WINDOW_MS;
globalThis.chatUxParseSidx = chatUxParseSidx;
globalThis.chatUxPlanTurnDelete = chatUxPlanTurnDelete;
globalThis.chatUxResendText = chatUxResendText;
globalThis.chatUxResendShouldGiveUp = chatUxResendShouldGiveUp;
globalThis.chatUxIsStreaming = chatUxIsStreaming;
globalThis.chatUxShouldFollow = chatUxShouldFollow;
globalThis.chatUxNextTouchUntil = chatUxNextTouchUntil;
globalThis.chatUxIsTouchActive = chatUxIsTouchActive;
})();
