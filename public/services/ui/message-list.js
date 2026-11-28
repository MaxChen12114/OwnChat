(function () {
/**
 * The message-list rules, minus the DOM: spacer height math, the near-bottom threshold, the
 * tool-turn collector and the renderSession per-message decisions (empty shells, bubble
 * hide/remove, stats lines, speaker cards).
 *
 * The tool-turn collector is the part worth locking. Agent tool rounds do NOT get their own row:
 * they fold into the final assistant answer as one process panel per turn. The collector walks
 * forward from an assistant message carrying tool_calls, pairs each call with the tool results
 * that immediately follow, and merges the `_tool` metadata (name/ok/ms/denied) recorded at call
 * time over the wire-format `function.arguments`. A call whose recorded meta is missing still
 * renders (fallback name "tool", args parsed from the wire JSON, ok defaults to true).
 *
 * History rows also carry sidx (the true session index) — DOM order diverges whenever tool rounds
 * folded, and retry/delete must truncate by session index, not by row position.
 * @module services/ui/message-list
 */

/** Distance (px) from the bottom inside which a new row triggers auto-scroll. */
const ML_NEAR_BOTTOM_DIST = 120;

/** CSS-var fallbacks for the bottom spacer: composer gap and breathing room below it. */
const ML_DEFAULT_GAP = 18;
const ML_DEFAULT_EXTRA = 28;

/** Parse a CSS length custom property; missing or non-numeric yields the fallback. */
function mlParseLen(raw                           , fallback        )         {
  const v = raw != null ? parseFloat(raw) : NaN;
  return Number.isFinite(v) ? v : fallback;
}

/** Spacer height: composer height + gap + extra + keyboard inset, rounded up so fractional
 * composer heights never leave a 1px sliver of chat visible behind the composer. */
function mlSpacerHeight(
  composerHeight        ,
  gap        ,
  extra        ,
  kb        ,
)         {
  return Math.ceil(composerHeight + gap + extra + kb);
}

/** Near-bottom test: within ML_NEAR_BOTTOM_DIST of the scroll end counts as "following". */
function mlIsNearBottom(distFromBottom        )          {
  return distFromBottom < ML_NEAR_BOTTOM_DIST;
}

/** One decoded tool call as the process panel expects it. */
                             
                
                
              
               
                  
                  
                   
 

/** One folded tool round: a process panel payload plus its round number. */
                             
                
                      
                     
                     
 

/** Parse the wire-format `function.arguments` JSON; malformed or empty yields null (the panel
 * renders the call without args rather than blowing up a whole history restore). */
function mlParseCallArgs(raw         )          {
  if (typeof raw !== "string" || !raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_e) {
    return null;
  }
}

function rec(v         )                          {
  const out                          = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

/** Map one wire tool_call plus its paired tool result message onto the panel shape. The `_tool`
 * metadata recorded at call time wins over wire defaults: its args replace the parsed JSON (it
 * holds the already-validated object), its ok flag is authoritative (only an explicit false
 * means failure), and name/result fall back to the wire values. */
function mlBuildCall(tc         , toolMsg         )             {
  const call = rec(tc);
  const fn = rec(call["function"]);
  const meta = rec(rec(toolMsg)["_tool"]);
  const argsParsed = mlParseCallArgs(fn["arguments"]);
  const args =
    meta["args"] !== undefined ? meta["args"] : argsParsed;
  return {
    name: meta["name"] ? meta["name"] : fn["name"] ? fn["name"] : "tool",
    args,
    ok: meta["ok"] !== false,
    ms: meta["ms"],
    error: meta["error"],
    denied: Boolean(meta["denied"]),
    result: rec(toolMsg)["content"],
  };
}

/** Collect the tool round starting at `list[i]` (an assistant message carrying non-empty
 * tool_calls) and return it with `end`, the index of the first message after the round's tool
 * results. Returns null when the caller mis-aimed: no calls, or the entry is not an assistant
 * message with tool_calls — the caller must then render the message normally, not skip it. */
function mlCollectToolTurn(
  list           ,
  i        ,
  roundNo        ,
)                                           {
  const m = rec(list[i]);
  const rawCalls = m["tool_calls"];
  if (m["role"] !== "assistant" || !Array.isArray(rawCalls) || rawCalls.length === 0) return null;
  const toolMsgs            = [];
  let j = i + 1;
  while (j < list.length) {
    const t = rec(list[j]);
    if (t["role"] !== "tool") break;
    toolMsgs.push(list[j]);
    j++;
  }
  const calls = rawCalls.map((tc, k) => mlBuildCall(tc, toolMsgs[k] ?? {}));
  const turn             = { round: roundNo, calls };
  // Visible prose emitted alongside the call and the round's thinking both fold into the panel
  // top, keeping one continuous workflow (thinking / tools / prose) with the live path.
  if (m["agentPreamble"] !== undefined) turn.preamble = m["agentPreamble"];
  if (m["reasoning_content"] !== undefined) turn.thinking = m["reasoning_content"];
  return { turn, end: j };
}

/** An assistant message with nothing to show — no prose, no thinking, no attachments. These
 * shells only appear when navigation/system reclamation interrupts a turn mid-flight; rendering
 * them used to produce a headless avatar-only "empty message" that also split adjacent panels
 * from their answers. Skipped only when no pending tool rounds need a host row. */
function mlEmptyShell(msg         )          {
  const m = rec(msg);
  const files = Array.isArray(m["files"]) ? m["files"] : [];
  const images = Array.isArray(m["images"]) ? m["images"] : [];
  const content = m["content"];
  // String(m.content || "") semantics: non-string content still stringifies (42 → "42"),
  // null/undefined collapse to "".
  return (
    !String(content || "").trim() &&
    !m["reasoning_content"] &&
    files.length === 0 &&
    images.length === 0
  );
}

/** What to do with a synthetic host row whose bubble stayed empty: remove the whole row when the
 * panel contributed nothing visible (no text, no children), hide just the bubble when the panel
 * rendered but has no prose, and leave the row alone once the bubble has content. */
function mlBubbleAction(
  bubbleText        ,
  bubbleChildCount        ,
)                           {
  const text = typeof bubbleText === "string" ? bubbleText.trim() : "";
  if (!text && bubbleChildCount === 0) return "remove";
  if (!text) return "hide";
  return null;
}

/** Per-row stats line for user messages (estimated input + running total). */
function mlStatsLineUser(inEst        , totalIn        )         {
  return `Input(估算): ≈${inEst} | Total In(估算): ≈${totalIn}`;
}

/** Per-row stats line for assistant messages (estimated output + running total). Real usage
 * cannot be recovered on restore; the estimate convention matches the live free-mode path. */
function mlStatsLineAssistant(outEst        , totalOut        )         {
  return `Output(估算): ≈${outEst} | Total Out(估算): ≈${totalOut}`;
}

/** Speaker card handed to decorateAiRow (or used for the emoji fallback when character.js is not
 * ready yet): id may be empty, icon falls back to 🙂. Fields keep the original truthy-fallback
 * semantics — a numeric id/icon passes through as-is rather than being coerced away. */
function mlSpeakerCard(msg         )   
              
                
                
  {
  const m = rec(msg);
  const id = m["speakerId"] ? m["speakerId"] : "";
  const icon = m["speakerIcon"] ? m["speakerIcon"] : "🙂";
  return { id, name: m["speakerName"], icon };
}

// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/ui/message-list.ts; this file owns
// the DOM: the row factory, the clear whitelist, the RAF-throttled scroll and the render loop
// itself. Every decision lives in the engine — spacer math, the near-bottom threshold, the
// tool-turn collector, empty-shell detection, bubble hide/remove, stats lines, speaker cards.
//
// Frozen global name: app.js calls __messageList.create(host) at load time with four DOM handles
// (getComposer / getSpacer / getHistory / getChat) plus the render helpers; every helper soft-
// degrades so a missing one never kills a whole session restore.
(function (global) {
  "use strict";
  if (global.__messageList) return;

  global.__messageList = {
    create(host) {
      host = host || {};
      const composerEl = typeof host.getComposer === "function" ? host.getComposer() : null;
      const spacerEl = typeof host.getSpacer === "function" ? host.getSpacer() : null;
      const historyWrap = typeof host.getHistory === "function" ? host.getHistory() : null;
      const chatEl = typeof host.getChat === "function" ? host.getChat() : null;
      const doc = global.document;
      // A22b(2) history restore needs external capabilities; every one soft-degrades so a missing
      // helper cannot break the whole session render.
      const renderMarkdown = typeof host.renderMarkdown === "function" ? host.renderMarkdown : (t) => (t == null ? "" : String(t));
      const renderAttachments = typeof host.renderAttachments === "function" ? host.renderAttachments : () => {};
      const applyUserFold = typeof host.applyUserFold === "function" ? host.applyUserFold : () => {};
      const estimateTokens = typeof host.estimateTokens === "function" ? host.estimateTokens : () => 0;
      const attFileTokens = typeof host.attFileTokens === "function" ? host.attFileTokens : () => 0;
      const applyThinkDisplay = typeof host.applyThinkDisplay === "function" ? host.applyThinkDisplay : () => {};
      const resetTotals = typeof host.resetTotals === "function" ? host.resetTotals : () => {};
      const addInEstimate = typeof host.addInEstimate === "function" ? host.addInEstimate : (n) => n;
      const addOutEstimate = typeof host.addOutEstimate === "function" ? host.addOutEstimate : (n) => n;

      function updateSpacer() {
        if (!composerEl || !spacerEl) return;
        const rect = composerEl.getBoundingClientRect();
        const rootStyle = getComputedStyle(doc.documentElement);
        // 4.83: the --kb fallback path (WebViews where the layout viewport does not shrink) must
        // give up keyboard height at the bottom of the chat flow.
        const gap = mlParseLen(rootStyle.getPropertyValue("--composer-gap"), ML_DEFAULT_GAP);
        const extra = mlParseLen(rootStyle.getPropertyValue("--spacer-extra"), ML_DEFAULT_EXTRA);
        const kb = mlParseLen(rootStyle.getPropertyValue("--kb"), 0);
        const h = mlSpacerHeight(rect.height, gap, extra, kb);
        spacerEl.style.height = h + "px";
        historyWrap.style.scrollPaddingBottom = h + "px";
      }

      function isNearBottom() {
        return mlIsNearBottom(historyWrap.scrollHeight - historyWrap.scrollTop - historyWrap.clientHeight);
      }

      // 4.19 P0: RAF throttle — each delta chunk used to fire isNearBottom() + scrollTo, two
      // synchronous layout queries fighting the main thread at streaming frequency. Calls within
      // one frame collapse into a single reframe.
      let _scrollRafPending = false;
      function scrollToBottom() {
        // 2026-10-07 drag-lag fix (E-A): while a touch/wheel gesture holds the scroll position
        // (deadline maintained by chat-ux), do not yank the view back to the bottom — streaming
        // deltas used to turn a held finger into a tug-of-war.
        if (Date.now() < (global.__scrollTouchUntil || 0)) return;
        if (_scrollRafPending) return;
        _scrollRafPending = true;
        requestAnimationFrame(() => {
          _scrollRafPending = false;
          historyWrap.scrollTo({ top: historyWrap.scrollHeight, behavior: "auto" });
        });
      }

      // Fishbowl V3: opts.side === "right" adds .side-right to an AI row (moderator commentary
      // hugs the right edge via flex-direction:row-reverse); opts.moderator centers the row.
      function makeRow(role, opts) {
        const row = doc.createElement("div");
        row.className = "row " + (role === "user" ? "user" : "ai");
        if (opts && opts.side === "right" && role !== "user") row.classList.add("side-right");
        if (opts && opts.moderator) row.classList.add("moderator");
        const avatar = doc.createElement("div");
        avatar.className = "avatar " + (role === "user" ? "human" : "bot");
        avatar.textContent = role === "user" ? "U" : "B";
        const content = doc.createElement("div");
        content.className = "content";
        const meta = doc.createElement("div");
        meta.className = "meta";
        meta.textContent = role === "user" ? "User" : "Bot";
        const bubble = doc.createElement("div");
        bubble.className = "bubble " + (role === "user" ? "user" : "ai");
        const stats = doc.createElement("div");
        stats.className = "stats";
        let reasoning = null;
        if (role !== "user") {
          reasoning = doc.createElement("details");
          reasoning.className = "reasoning-block";
          reasoning.style.display = "none";
          const rsum = doc.createElement("summary");
          // 2026-06-15: linear SVG for the thinking title (matches the topbar ICONS language),
          // replacing the bare 💭 emoji.
          rsum.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px;margin-right:6px;"><path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.5.4.9 1 .9 1.7v.5h5.4v-.5c0-.7.4-1.3.9-1.7A6 6 0 0 0 12 3Z"/></svg><span>思考过程</span>';
          const rtxt = doc.createElement("div");
          rtxt.className = "reasoning-text";
          reasoning.appendChild(rsum);
          reasoning.appendChild(rtxt);
        }
        content.appendChild(meta);
        if (reasoning) content.appendChild(reasoning);
        content.appendChild(bubble);
        content.appendChild(stats);
        if (role === "user") {
          row.appendChild(content);
          row.appendChild(avatar);
        } else {
          row.appendChild(avatar);
          row.appendChild(content);
        }
        chatEl.insertBefore(row, spacerEl);
        if (isNearBottom()) scrollToBottom();
        return { rowEl: row, bubble, stats, reasoning };
      }

      // Drop a synthetic host row or hide its bubble when the process panel contributed nothing
      // visible — the engine picked remove vs hide vs keep from the bubble snapshot.
      function _settleSynthetic(r0) {
        const action = mlBubbleAction(r0.bubble ? r0.bubble.textContent || "" : "", r0.bubble ? r0.bubble.children.length : 0);
        if (action === "remove") r0.rowEl.remove();
        else if (action === "hide") r0.bubble.style.display = "none";
      }

      function clearUIRows() {
        const nodes = Array.from(chatEl.children);
        for (const n of nodes) {
          if (n === spacerEl) continue;
          // 2026-11-08 fix (review P2): the group header / summary chip are owned by renderHeader;
          // clearing rows must not delete them until the next role switch.
          if (n.id === "wechatGroupHeader" || n.id === "summaryChip") continue;
          chatEl.removeChild(n);
        }
      }

      // ── A22b(2): session messages → DOM rows (moved wholesale from engine/app.js 2026-11-12) ──
      // Only "projected array → rows"; the field whitelist lives in chat/context.js
      // (toRenderableMessages) and the canonical session reference stays with app.js (turn
      // lifecycle). Input must already be whitelisted; this loop is read-only.
      function renderSession(list) {
        if (!Array.isArray(list)) list = [];
        clearUIRows();
        // 4.83: totals are rebuilt from the session being loaded (accumulated per row below) —
        // a refresh/switch used to inherit the previous session's Total.
        resetTotals();
        let _roundNo = 0;
        // 2026-09-14: agent tool rounds do not get rows — they accumulate into ONE process panel
        // attached to the final answer that follows (aligned with ZCode: process collapses above
        // the answer, one block per turn).
        let _pendingTurns = [];
        function _flushTurnsInto(rowEl) {
          if (!rowEl || !_pendingTurns.length) return;
          const bubble = rowEl.querySelector(".bubble");
          if (!bubble) return;
          // Mark the row: the thinking fold is now inside the panel, and CSS must hide the
          // standalone thinking block or the same thinking would appear twice.
          try { rowEl.dataset.agentProcess = "1"; } catch (_) {}
          // 2026-09-14: ONE panel per turn — multiple rounds merge into it (each round used to
          // get its own panel, producing a stack of parallel panels).
          try { global.__agentSteps && global.__agentSteps.renderTurn(bubble, { rounds: _pendingTurns.slice() }); } catch (_e) {}
          _pendingTurns = [];
        }
        for (let _i = 0; _i < list.length; _i++) {
          const m = list[_i];
          if (m.role === "tool") continue;
          // Tool round: fold into a pending panel, no row. The collector pairs each call with the
          // tool results that immediately follow and merges the _tool metadata over wire JSON.
          {
            const _collected = mlCollectToolTurn(list, _i, _roundNo + 1);
            if (_collected) {
              _roundNo++;
              _pendingTurns.push(_collected.turn);
              _i = _collected.end - 1; // loop's ++_i lands on the first message after the round
              continue;
            }
          }
          // 2026-10-08 fix: the process panel may only attach to an AI row. The old version
          // flushed into every row, so a history shape of tool round followed directly by a user
          // message (common after interrupting half a turn) mounted the panel onto the USER row.
          // Now a synthetic AI row is inserted first to host the panel, preserving "process
          // belongs to the previous turn" positioning.
          let r;
          if (m.role === "user") {
            if (_pendingTurns.length) {
              try {
                const _r0 = makeRow("assistant");
                _flushTurnsInto(_r0.rowEl);
                // 2026-11-12: if the synthetic row ended up with nothing attached (no panel, no
                // prose), remove the whole row — hiding the bubble alone left avatar+name, an
                // "empty message" in history.
                _settleSynthetic(_r0);
              } catch (_pf) {}
            }
            r = makeRow("user");
          } else {
            // 2026-11-12: an empty assistant shell persisted after navigation/system reclamation
            // (no prose, no thinking, no attachments) gets no row — it used to render as a bare
            // avatar+name "empty message" and split panels from their answers.
            const _emptyShell = mlEmptyShell(m);
            if (_emptyShell && !_pendingTurns.length) continue;
            r = makeRow("assistant");
            if (!m._uiOnly) _flushTurnsInto(r.rowEl);
          }
          // 2026-10-08: stamp the real session index on the row — tool rounds fold into the
          // following answer, so DOM row order is NOT the session index. Retry/delete truncate by
          // this index or they clip the wrong span and leave dangling tool_calls on disk (the
          // "every request 400s after restart" root cause).
          try { r.rowEl.dataset.sidx = String(_i); } catch (_sx) {}
          const _visText = m.content;
          // Bug3 fix: agent replies render through Markdown (textContent would show the restored
          // <table class="md-table"> markup as literal text).
          if (m.role === "assistant") { r.bubble.innerHTML = renderMarkdown(_visText); } else { r.bubble.textContent = _visText; }
          // 2026-09-14: restore attachments (chips immediately; image cards fetch their Blob from
          // IndexedDB asynchronously).
          if ((m.role === "user" || m.role === "assistant") && ((m.files && m.files.length) || (m.images && m.images.length))) {
            renderAttachments(r.bubble, { files: m.files, images: m.images });
            if (m.role === "assistant" && !String(m.content || "").trim()) r.bubble.style.display = "none";
          }
          if (m.role === "user") applyUserFold(r.bubble); // long-message fold, attachments or not
          // 4.83: rebuild the per-row context stats — a restore used to wipe them entirely, so a
          // refresh/switch lost the whole "context stats" display. Content is in the session:
          // re-estimate precisely and continue the totals; real usage is unrecoverable, so AI
          // rows show the "Output(estimated)" convention (same format as the live free path).
          if (m.role === "user") {
            const _inEst = estimateTokens(m.content) + attFileTokens({ files: m.files });
            r.stats.textContent = mlStatsLineUser(_inEst, addInEstimate(_inEst));
          } else if (m.role === "assistant") {
            const _outEst = estimateTokens(m.content);
            r.stats.textContent = mlStatsLineAssistant(_outEst, addOutEstimate(_outEst));
          } else {
            r.stats.textContent = "";
          }
          if (m._uiOnly) r.stats.textContent = "";
          if (m.reasoning_content && r.reasoning) {
            r.reasoning.querySelector(".reasoning-text").textContent = m.reasoning_content;
            applyThinkDisplay(r.reasoning); // 4.70: restored thinking obeys the display setting too
          }
          if (m.role === "assistant" && m.speakerName) {
            // 4.60 avatar persistence: restored history goes through decorateAiRow too, so
            // characters with an image (cfw_char_avatar_v1) survive a refresh and data-char-id
            // answers avatar:changed. Without a decorator / before character.js is ready, fall
            // back to the emoji text.
            const _card = mlSpeakerCard(m);
            if (global.characterSvc && global.characterSvc.decorateAiRow) {
              global.characterSvc.decorateAiRow(r.rowEl, _card);
            } else {
              const av = r.rowEl.querySelector(".avatar.bot");
              if (av) { av.textContent = m.speakerIcon || "🙂"; av.title = m.speakerName; }
              const meta = r.rowEl.querySelector(".meta");
              if (meta) meta.textContent = m.speakerName;
            }
          }
        }
        // Leftover panels at the end of the stream (the turn was interrupted / never produced a
        // final answer): one trailing row hosts them, so "tools ran but nothing shows" can't happen.
        if (_pendingTurns.length) {
          try {
            const _r2 = makeRow("assistant");
            _flushTurnsInto(_r2.rowEl);
            _settleSynthetic(_r2);
          } catch (_pf) {}
        }
      }

      return { updateSpacer, isNearBottom, scrollToBottom, makeRow, clearUIRows, renderSession };
    },
  };
})(typeof globalThis !== "undefined" ? globalThis : this);

globalThis.ML_NEAR_BOTTOM_DIST = ML_NEAR_BOTTOM_DIST;
globalThis.ML_DEFAULT_GAP = ML_DEFAULT_GAP;
globalThis.ML_DEFAULT_EXTRA = ML_DEFAULT_EXTRA;
globalThis.mlParseLen = mlParseLen;
globalThis.mlSpacerHeight = mlSpacerHeight;
globalThis.mlIsNearBottom = mlIsNearBottom;
globalThis.mlParseCallArgs = mlParseCallArgs;
globalThis.mlBuildCall = mlBuildCall;
globalThis.mlCollectToolTurn = mlCollectToolTurn;
globalThis.mlEmptyShell = mlEmptyShell;
globalThis.mlBubbleAction = mlBubbleAction;
globalThis.mlStatsLineUser = mlStatsLineUser;
globalThis.mlStatsLineAssistant = mlStatsLineAssistant;
globalThis.mlSpeakerCard = mlSpeakerCard;
})();
