// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/ui/composer.ts (send-button shape, `@`
// query and insertion, candidate filtering and stepping, keyboard inset, popup placement).
// This file owns the textarea, the popup node, the CSS variable, the rAF throttle and the listeners.
//
// Public API (host-provided ports in parentheses):
//   __composer.create(host) → { updateSendBtnState, wireInput, setupResizeObserver,
//     setupViewportListener, setupWindowResize, syncKbVar, updateAtMenu, closeAtMenu,
//     mentionKeydown, insertMention, wireMention, setupVoiceInput, _mentionDebug, _debugKb }
//   host: getInput / getComposer / getSendBtn / sendIconHtml / stopIconHtml / isAgentRunning /
//         onLayoutChange / isGroupChatActive / getSceneCards
//
// Three invariants the wiring keeps:
//   · `mentionKeydown` returns true only when the popup consumed the key — the host must still send
//     on Enter otherwise. Enter/Tab insert the highlighted card, not the first one.
//   · Resetting the send icon goes through innerHTML; `textContent = "发送"` would drop the SVG and
//     only runs when the host supplied no icon at all.
//   · The voice button is born here, not in index.html. Web Speech exists in a minority of desktop
//     browsers and is absent from every mobile WebView, so a static node would be a dead control
//     almost everywhere. `setupVoiceInput` (run once by create) mounts it only when the API and the
//     1024px desktop breakpoint both hold, and returns null otherwise — no placeholder, no stub.
//     Dictation only ever writes into the textarea; it never presses send.
(function (global) {
  "use strict";
  if (global.__composer) return;

  const AT_MENU_CSS = "position:absolute;z-index:9999;min-width:160px;max-width:280px;max-height:240px;"
    + "overflow:auto;border-radius:10px;padding:4px;display:none;box-shadow:0 8px 24px rgba(0,0,0,.35);";

  // Same 18px linear set as the attach button; styles-controls.css scales it down to 16px inside
  // the 34px box so the microphone reads at the same weight as the paperclip and sparkle.
  const VOICE_ICON_HTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" '
    + 'stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<rect x="9" y="3" width="6" height="11" rx="3"/>'
    + '<path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/>'
    + '<path d="M12 18v3M8.5 21h7"/></svg>';

  global.__composer = {
    create(host) {
      host = host || {};
      const inputEl = typeof host.getInput === "function" ? host.getInput() : null;
      const composerEl = typeof host.getComposer === "function" ? host.getComposer() : null;
      const sendBtn = typeof host.getSendBtn === "function" ? host.getSendBtn() : null;
      const sendIconHtml = host.sendIconHtml || "";
      const stopIconHtml = host.stopIconHtml || "";
      const isAgentRunning = typeof host.isAgentRunning === "function" ? host.isAgentRunning : () => false;
      const onLayoutChange = typeof host.onLayoutChange === "function" ? host.onLayoutChange : () => {};
      const isGroupChatActive = typeof host.isGroupChatActive === "function" ? host.isGroupChatActive : () => false;
      const getSceneCards = typeof host.getSceneCards === "function" ? host.getSceneCards : () => [];
      const doc = global.document;

      function updateSendBtnState() {
        if (!sendBtn) return;
        const mode = composerSendMode(!!isAgentRunning(), (inputEl && inputEl.value) || "");
        if (mode === "stop") {
          if (!sendBtn.classList.contains("is-stop")) {
            sendBtn.classList.add("is-stop");
            sendBtn.innerHTML = stopIconHtml;
          }
          sendBtn.title = "停止";
          sendBtn.setAttribute("aria-label", "停止");
          return;
        }
        if (sendBtn.classList.contains("is-stop")) {
          sendBtn.classList.remove("is-stop");
          if (sendIconHtml) sendBtn.innerHTML = sendIconHtml; else sendBtn.textContent = "发送";
        }
        sendBtn.title = "发送";
        sendBtn.setAttribute("aria-label", "发送");
      }

      // One frame per burst: every keystroke otherwise forces a scrollHeight read plus two style
      // writes, which is the measured hitch when a drag gesture runs alongside typing.
      let _inputRaf = 0;
      function wireInput() {
        if (!inputEl) return;
        inputEl.addEventListener("input", () => {
          if (_inputRaf) return;
          _inputRaf = global.requestAnimationFrame(() => {
            _inputRaf = 0;
            inputEl.style.height = "auto";
            inputEl.style.height = inputEl.scrollHeight + "px";
            updateSendBtnState();
            onLayoutChange();
          });
        });
      }

      function setupResizeObserver() {
        if (!composerEl || typeof global.ResizeObserver === "undefined") return;
        const ro = new global.ResizeObserver(() => { onLayoutChange(); });
        ro.observe(composerEl);
      }

      // Writes are skipped on an unchanged value: each write invalidates the root style and forces a
      // full recompute, and the scroll handler can fire dozens of times per gesture.
      let _lastKb = -1;
      function syncKbVar() {
        try {
          const vv = global.visualViewport;
          const kb = composerKbInset(global.innerHeight, vv.height, vv.offsetTop || 0);
          if (kb === _lastKb) return;
          _lastKb = kb;
          doc.documentElement.style.setProperty("--kb", kb + "px");
        } catch (_) {}
      }

      function setupViewportListener() {
        if (!global.visualViewport) return;
        global.visualViewport.addEventListener("resize", () => {
          syncKbVar();
          onLayoutChange();
        });
        global.visualViewport.addEventListener("scroll", syncKbVar);
        syncKbVar();
      }

      function setupWindowResize() {
        global.addEventListener("resize", () => {
          syncKbVar();
          onLayoutChange();
        });
      }

      let _atMenu = null, _atItems = [], _atIndex = -1, _atOpen = false;

      function ensureAtMenu() {
        if (_atMenu) return _atMenu;
        const menu = doc.createElement("div");
        menu.id = "atMentionMenu";
        menu.style.cssText = AT_MENU_CSS;
        doc.body.appendChild(menu);
        _atMenu = menu;
        return menu;
      }

      function isLightTheme() {
        const viaTheme = global.themeSvc && typeof global.themeSvc.is === "function"
          ? global.themeSvc.is("light")
          : null;
        if (viaTheme !== null) return !!viaTheme;
        return global.localStorage.getItem("my-theme") === "light";
      }

      function highlightAt() {
        const colors = composerMenuColors(isLightTheme());
        _atItems.forEach((it, i) => { it.el.style.background = (i === _atIndex) ? colors.highlight : "transparent"; });
      }
      function setAtIndex(i) { _atIndex = i; highlightAt(); }
      function closeAtMenu() { if (_atMenu) _atMenu.style.display = "none"; _atOpen = false; _atItems = []; _atIndex = -1; }

      function positionAtMenu() {
        if (!_atMenu) return;
        const r = inputEl.getBoundingClientRect();
        const at = composerMenuPlacement(r.top, r.bottom, r.left, _atMenu.offsetHeight, global.scrollY, global.scrollX);
        _atMenu.style.top = at.top + "px";
        _atMenu.style.left = at.left + "px";
      }

      function openAtMenu(cards) {
        const menu = ensureAtMenu();
        const colors = composerMenuColors(isLightTheme());
        menu.style.background = colors.background;
        menu.style.border = colors.border;
        menu.style.color = colors.color;
        menu.innerHTML = "";
        _atItems = [];
        cards.forEach((card, i) => {
          const it = doc.createElement("div");
          it.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:7px;cursor:pointer;font-size:14px;white-space:nowrap;";
          const ico = doc.createElement("span"); ico.textContent = card.icon || "🙂"; ico.style.flexShrink = "0";
          const nm = doc.createElement("span"); nm.textContent = card.name; nm.style.cssText = "overflow:hidden;text-overflow:ellipsis;";
          it.appendChild(ico); it.appendChild(nm);
          it.addEventListener("mousedown", (e) => { e.preventDefault(); insertMention(card); });
          it.addEventListener("mouseenter", () => setAtIndex(i));
          menu.appendChild(it);
          _atItems.push({ card, el: it });
        });
        _atIndex = 0;
        highlightAt();
        menu.style.display = "block";
        _atOpen = true;
        positionAtMenu();
      }

      function insertMention(card) {
        const q = composerAtQuery((inputEl && inputEl.value) || "", inputEl.selectionStart || 0);
        if (!q || !card) { closeAtMenu(); return; }
        const out = composerMentionInsertion(inputEl.value || "", q, card.name);
        if (!out) { closeAtMenu(); return; }
        inputEl.value = out.value;
        try { inputEl.setSelectionRange(out.caret, out.caret); } catch (e) {}
        closeAtMenu();
        inputEl.focus();
        try { inputEl.dispatchEvent(new global.Event("input")); } catch (e) {}
      }

      function updateAtMenu() {
        if (!isGroupChatActive()) { closeAtMenu(); return; }
        const q = composerAtQuery((inputEl && inputEl.value) || "", inputEl.selectionStart || 0);
        if (!q) { closeAtMenu(); return; }
        let cards = [];
        try { cards = getSceneCards() || []; } catch (e) {}
        const filtered = composerFilterCards(cards, q.query);
        if (!filtered.length) { closeAtMenu(); return; }
        openAtMenu(filtered);
      }

      function keydown(e) {
        if (!_atOpen || !_atItems.length) return false;
        if (e.key === "ArrowDown") { e.preventDefault(); _atIndex = composerStepIndex(_atIndex, _atItems.length, 1); highlightAt(); return true; }
        if (e.key === "ArrowUp") { e.preventDefault(); _atIndex = composerStepIndex(_atIndex, _atItems.length, -1); highlightAt(); return true; }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          const it = _atItems[_atIndex] || _atItems[0];
          if (it) insertMention(it.card);
          return true;
        }
        if (e.key === "Escape") { e.preventDefault(); closeAtMenu(); return true; }
        return false;
      }

      function wireMention() {
        if (!inputEl) return;
        inputEl.addEventListener("input", updateAtMenu);
        // mousedown on a row runs before blur; the delay only covers pointer routes that blur first.
        inputEl.addEventListener("blur", () => { setTimeout(closeAtMenu, 150); });
      }

      // ── Voice input (desktop-only Web Speech) ──────────────────────────────────────────────
      // Session state: `voiceBase` is the text the box held before the first word and is never
      // rewritten while listening; `voiceFinal` is the committed transcript; `voiceInterim` is the
      // live tail the browser may revise on every event. Rendering is always base + final + interim,
      // so a revision replaces the tail instead of duplicating the committed half. Nothing here
      // ever calls the host's send path: dictation fills the box, the user decides to send.
      let voiceBtn = null;
      let voiceRec = null;
      let voiceRunning = false;
      let voiceBase = "";
      let voiceFinal = "";
      let voiceInterim = "";
      let voiceLastPainted = "";
      let voiceSelfWrite = false;
      let voiceStopTimer = 0;

      // UI language, not navigator.language: the box, the labels and the dictation language must
      // agree, and the settings switch is the only source that knows which UI the user picked.
      function voiceLanguage() {
        try {
          return global.localStorage && global.localStorage.getItem("cfw_ui_lang_v1") === "en" ? "en-US" : "zh-CN";
        } catch (e) { return "zh-CN"; }
      }

      // A space between two non-empty fragments unless one side already supplies whitespace. The
      // recognizer's own transcripts have no stable leading/trailing spacing across engines.
      function voiceJoin(left, right) {
        const a = left || "", b = right || "";
        if (!a) return b;
        if (!b) return a;
        return /\s$/.test(a) || /^\s/.test(b) ? a + b : a + " " + b;
      }

      // Every write goes through the normal `input` event so the existing rAF auto-height and the
      // send-button shape run unchanged — the voice path owns no layout logic of its own.
      function voicePaint(force) {
        const next = voiceJoin(voiceBase, voiceJoin(voiceFinal, voiceInterim));
        const changed = inputEl.value !== next;
        if (changed) {
          inputEl.value = next;
          try { inputEl.setSelectionRange(next.length, next.length); } catch (e) {}
        }
        voiceLastPainted = next;
        if (!changed && !force) return;
        voiceSelfWrite = true;
        try {
          inputEl.dispatchEvent(new global.Event("input", { bubbles: true }));
        } catch (e) {
          // A host without Event (or a partial shim) still gets the text; only the height refresh
          // is lost, and the next real input event repairs it.
        } finally {
          voiceSelfWrite = false;
        }
      }

      // Idempotent on purpose: onend, onerror and a click-stop can race, and the first caller owns
      // the cleanup. Handlers are dropped before any repaint so a late event cannot re-enter.
      function voiceTeardown(repaint) {
        if (!voiceRunning && !voiceRec) return;
        const rec = voiceRec;
        voiceRec = null;
        voiceRunning = false;
        if (voiceStopTimer) {
          try { global.clearTimeout(voiceStopTimer); } catch (e) {}
          voiceStopTimer = 0;
        }
        if (rec) {
          try { rec.onresult = null; rec.onerror = null; rec.onend = null; } catch (e) {}
        }
        try { doc.removeEventListener("keydown", voiceOnKeydown, true); } catch (e) {}
        if (voiceBtn) {
          voiceBtn.classList.remove("listening");
          voiceBtn.setAttribute("aria-pressed", "false");
        }
        voiceInterim = "";
        // If the box changed underneath us (send clears it without an input event), the session no
        // longer owns the text: leave the new value alone instead of restoring the old ghost.
        if (repaint && inputEl.value === voiceLastPainted) voicePaint(true);
      }

      // User took over the box mid-dictation: abort without repainting, so neither the typed text
      // nor the live preview is overwritten.
      function voiceAbort() {
        const rec = voiceRec;
        voiceTeardown(false);
        if (rec) { try { rec.abort(); } catch (e) {} }
      }

      function voiceOnManualInput() {
        if (voiceSelfWrite || !voiceRunning) return;
        voiceAbort();
      }

      function voiceOnResult(event) {
        if (!voiceRunning || !event || !event.results) return;
        // The box is ours only while it still holds the last text we painted. A send clears it
        // without an input event, so this guard is what stops a late transcript from resurrecting
        // the message that was just sent.
        if (inputEl.value !== voiceLastPainted) { voiceAbort(); return; }
        const results = event.results;
        const from = typeof event.resultIndex === "number" && event.resultIndex > 0 ? event.resultIndex : 0;
        const finals = [], tails = [];
        for (let i = from; i < results.length; i++) {
          const result = results[i];
          if (!result) continue;
          const alt = result[0];
          const text = alt && typeof alt.transcript === "string" ? alt.transcript : "";
          if (!text) continue;
          (result.isFinal ? finals : tails).push(text);
        }
        if (finals.length) {
          finals.forEach((part) => { voiceFinal = voiceJoin(voiceFinal, part.replace(/^\s+|\s+$/g, "")); });
        }
        voiceInterim = tails.join("").replace(/^\s+|\s+$/g, "");
        voicePaint(false);
      }

      function voiceOnError() {
        // Permission denied, cloud recognizer offline, no microphone, no speech: all of them end
        // the session. Swallow the payload — the contract is "restore the button, never throw" —
        // and let teardown repaint base + committed so no interim ghost survives.
        voiceTeardown(true);
      }

      function voiceOnEnd() {
        voiceTeardown(true);
      }

      function voiceOnKeydown(event) {
        if (event && event.key === "Escape" && voiceRunning) {
          if (typeof event.preventDefault === "function") event.preventDefault();
          voiceStop();
        }
      }

      function voiceStart() {
        if (voiceRunning) return;
        const Ctor = global.SpeechRecognition || global.webkitSpeechRecognition;
        if (!Ctor || !inputEl || !voiceBtn) return;
        let rec = null;
        try { rec = new Ctor(); } catch (e) { return; }
        voiceBase = inputEl.value || "";
        voiceFinal = "";
        voiceInterim = "";
        voiceLastPainted = voiceBase;
        voiceRec = rec;
        voiceRunning = true;
        try {
          rec.continuous = true;
          rec.interimResults = true;
          rec.lang = voiceLanguage();
          rec.onresult = voiceOnResult;
          rec.onerror = voiceOnError;
          rec.onend = voiceOnEnd;
          rec.start();
        } catch (e) {
          // start() throws synchronously when the recognizer is already active or permission was
          // refused before the prompt; the click must not leave a stuck listening state.
          voiceTeardown(false);
          return;
        }
        // A synchronous onerror/onend from start() has already torn the session down.
        if (!voiceRunning) return;
        voiceBtn.classList.add("listening");
        voiceBtn.setAttribute("aria-pressed", "true");
        try { doc.addEventListener("keydown", voiceOnKeydown, true); } catch (e) {}
      }

      function voiceStop() {
        if (!voiceRunning) return;
        const rec = voiceRec;
        if (!rec) { voiceTeardown(true); return; }
        try { rec.stop(); } catch (e) { voiceTeardown(true); return; }
        // Browsers normally fire onend within a frame. The timer only covers a recognizer that
        // swallows stop() (or a WebView that loses the event), so the button cannot stay lit with
        // no way back.
        if (!voiceStopTimer && typeof global.setTimeout === "function") {
          voiceStopTimer = global.setTimeout(() => {
            voiceStopTimer = 0;
            const stuck = voiceRec;
            voiceTeardown(true);
            // A recognizer that swallowed stop() may still hold the microphone; abort is the only
            // way to release it without waiting for another event. Handlers are already detached,
            // so the abort's onend cannot repaint or re-enter.
            if (stuck) { try { stuck.abort(); } catch (e) {} }
          }, 1600);
        }
      }

      function voiceToggle() {
        if (voiceRunning) voiceStop(); else voiceStart();
      }

      // Mounts the mic between the "思考" chip and the textarea. Called once by create(); a second
      // call returns the same node. Missing Web Speech or a sub-1024px layout returns null and
      // leaves the composer untouched — no dead button on phones or unsupported desktops.
      function setupVoiceInput() {
        if (voiceBtn) return voiceBtn;
        if (!doc || !inputEl || !composerEl) return null;
        let existing = null;
        try { existing = doc.getElementById("voiceInputBtn"); } catch (e) {}
        if (existing) { voiceBtn = existing; return existing; }
        const Ctor = global.SpeechRecognition || global.webkitSpeechRecognition;
        if (!Ctor) return null;
        let desktop = false;
        try {
          desktop = !!(global.matchMedia && global.matchMedia("(min-width:1024px)").matches);
        } catch (e) { desktop = false; }
        if (!desktop) return null;
        const btn = doc.createElement("button");
        btn.id = "voiceInputBtn";
        btn.type = "button";
        btn.className = "chip-btn voice-btn";
        btn.title = "语音输入";
        btn.setAttribute("aria-label", "语音输入");
        btn.setAttribute("aria-pressed", "false");
        btn.innerHTML = VOICE_ICON_HTML;
        btn.addEventListener("click", voiceToggle);
        let think = null;
        try { think = doc.getElementById("thinkToggle"); } catch (e) {}
        const before = think && think.parentNode === composerEl && think.nextSibling
          ? think.nextSibling
          : (inputEl.parentNode === composerEl ? inputEl : null);
        try { composerEl.insertBefore(btn, before); } catch (e) { return null; }
        inputEl.addEventListener("input", voiceOnManualInput);
        voiceBtn = btn;
        return btn;
      }

      // Mounted at boot: every app shell calls create() early, and index.html stays free of a
      // control most platforms cannot honour. Failure is contained — a missing media query or a
      // hostile WebView must not take the composer down with it.
      try { setupVoiceInput(); } catch (e) {}

      return { updateSendBtnState, wireInput, setupResizeObserver, setupViewportListener, setupWindowResize, syncKbVar,
        updateAtMenu, closeAtMenu, mentionKeydown: keydown, insertMention, wireMention, setupVoiceInput,
        _mentionDebug: () => ({ open: _atOpen, count: _atItems.length, index: _atIndex }),
        _debugKb: () => _lastKb };
    },
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
