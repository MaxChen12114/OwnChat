// Browser adapter, appended by l0/emit.mjs. Engine: services/ui/composer.ts (send-button shape, `@`
// query and insertion, candidate filtering and stepping, keyboard inset, popup placement).
// This file owns the textarea, the popup node, the CSS variable, the rAF throttle and the listeners.
//
// Public API (host-provided ports in parentheses):
//   __composer.create(host) → { updateSendBtnState, wireInput, setupResizeObserver,
//     setupViewportListener, setupWindowResize, syncKbVar, updateAtMenu, closeAtMenu,
//     mentionKeydown, insertMention, wireMention, _mentionDebug, _debugKb }
//   host: getInput / getComposer / getSendBtn / sendIconHtml / stopIconHtml / isAgentRunning /
//         onLayoutChange / isGroupChatActive / getSceneCards
//
// Two invariants the engine keeps:
//   · `mentionKeydown` returns true only when the popup consumed the key — the host must still send
//     on Enter otherwise. Enter/Tab insert the highlighted card, not the first one.
//   · Resetting the send icon goes through innerHTML; `textContent = "发送"` would drop the SVG and
//     only runs when the host supplied no icon at all.
(function (global) {
  "use strict";
  if (global.__composer) return;

  const AT_MENU_CSS = "position:absolute;z-index:9999;min-width:160px;max-width:280px;max-height:240px;"
    + "overflow:auto;border-radius:10px;padding:4px;display:none;box-shadow:0 8px 24px rgba(0,0,0,.35);";

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

      return { updateSendBtnState, wireInput, setupResizeObserver, setupViewportListener, setupWindowResize, syncKbVar,
        updateAtMenu, closeAtMenu, mentionKeydown: keydown, insertMention, wireMention,
        _mentionDebug: () => ({ open: _atOpen, count: _atItems.length, index: _atIndex }),
        _debugKb: () => _lastKb };
    },
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
