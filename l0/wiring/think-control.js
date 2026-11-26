// Browser adapter, appended by l0/emit.mjs. Engine: services/ui/think-control.ts; this file owns the
// toggle button, the popup menu and every localStorage / provider read.
//
// The DOM contract is narrow on purpose: `#thinkToggle`, an optional `.think-label` inside it, and a
// fixed-position menu appended to <body>. app.js creates the instance once at load and forwards
// thinkRequestPayload / updateThinkToggleUI, so create() must work even when the toggle is absent
// (sandboxed hosts and tests build the instance without one).
//
// Active-channel detection stays here because it reads two optional globals (`byoProviderSvc`,
// `providersSvc`) whose shapes differ; the engine receives a plain {supports, style, model, allowed}.
(function (global) {
  "use strict";
  if (global.__thinkControl) return;

  var THEME_KEY = "my-theme";

  function lsGet(key) {
    try { return global.localStorage.getItem(key); } catch (e) { return null; }
  }
  function lsSet(key, v) {
    try { global.localStorage.setItem(key, String(v)); } catch (e) {}
  }

  /** Active channel as capability input, or null when neither registry answers. */
  function readChannel(host) {
    try {
      var byo = global.byoProviderSvc && global.byoProviderSvc.get ? global.byoProviderSvc.get() : null;
      if (byo) {
        return {
          supports: byo.supportsThinking,
          style: thinkStyleOf(byo.thinkingStyle),
          model: byo.model,
          allowed: byo.effortValues,
        };
      }
      var P = global.providersSvc;
      if (P && P.read) {
        var key = P.effectiveKey ? P.effectiveKey(host.getMode()) : null;
        var parsed = key && P.parseKey ? P.parseKey(key) : null;
        if (parsed && parsed.kind === "preset") {
          var meta = (P.presetMeta ? P.presetMeta(parsed.id) : null) || {};
          return {
            supports: meta.supportsThinking !== false,
            style: thinkStyleFromMeta(meta.thinkingStyle, parsed.id),
            model: host.getModel(),
            allowed: meta.effortValues,
          };
        }
      }
    } catch (e) {}
    return null;
  }

  global.__thinkControl = {
    create(host) {
      var h = host || {};
      var table = thinkTableFrom(global.__modelThink || null);
      var doc = global.document;
      var toggleEl = doc ? doc.getElementById("thinkToggle") : null;
      var menuEl = null;

      function getThinkLevel() {
        return thinkLevelOrDefault(lsGet(THINK_LEVEL_KEY), table);
      }

      function capsNow() {
        var channel = readChannel(h);
        if (!channel) return buildThinkCap(table, true, "deepseek", h.getModel(), null);
        return buildThinkCap(table, channel.supports, channel.style, channel.model, channel.allowed);
      }

      function updateThinkToggleUI() {
        if (!toggleEl) return;
        var view = thinkToggleView(table, capsNow(), !!h.isThinkingOn(), getThinkLevel());
        var label = toggleEl.querySelector ? toggleEl.querySelector(".think-label") : null;
        if (label) label.textContent = view.text;
        else toggleEl.textContent = view.text;
        toggleEl.setAttribute("aria-pressed", view.pressed ? "true" : "false");
        if (toggleEl.classList && toggleEl.classList.toggle) toggleEl.classList.toggle("active", view.pressed);
        toggleEl.disabled = view.disabled;
        toggleEl.style.opacity = view.opacity;
        toggleEl.title = view.title;
      }

      function closeThinkMenu() {
        if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
        menuEl = null;
        doc.removeEventListener("click", onDocClick);
      }

      function onDocClick(e) {
        var insideToggle = toggleEl && toggleEl.contains && toggleEl.contains(e.target);
        if (menuEl && !menuEl.contains(e.target) && e.target !== toggleEl && !insideToggle) closeThinkMenu();
      }

      function openThinkMenu() {
        closeThinkMenu();
        if (!toggleEl) return;
        var cap = capsNow();
        if (!cap.available) return; // Disabled button: offering dead levels would only confuse.
        var isLight = (global.themeSvc && typeof global.themeSvc.is === "function")
          ? global.themeSvc.is("light")
          : (lsGet(THEME_KEY) === "light");
        var menu = doc.createElement("div");
        menu.id = "thinkLevelMenu";
        menu.style.cssText = "position:fixed;z-index:9999;min-width:140px;border-radius:10px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,.35);";
        menu.style.background = isLight ? "#ffffff" : "#1c1c22";
        menu.style.border = "1px solid " + (isLight ? "#ddd" : "#3a3a44");
        menu.style.color = isLight ? "#222" : "#eee";

        var options = thinkMenuOptions(table, cap, !!h.isThinkingOn(), getThinkLevel());
        options.forEach(function (opt) {
          var it = doc.createElement("div");
          it.style.cssText = "padding:7px 10px;border-radius:7px;cursor:pointer;font-size:13px;white-space:nowrap;"
            + (opt.active ? ("background:" + (isLight ? "#eaeaea" : "#33333d") + ";font-weight:600;") : "");
          it.textContent = opt.label;
          it.addEventListener("mouseenter", function () { it.style.background = isLight ? "#f0f0f0" : "#2a2a32"; });
          it.addEventListener("mouseleave", function () {
            it.style.background = opt.active ? (isLight ? "#eaeaea" : "#33333d") : "transparent";
          });
          it.addEventListener("click", function (e) {
            e.stopPropagation();
            if (opt.v === "__off__") {
              if (!cap.offAllowed) return;
              h.setThinkingOn(false);
              lsSet(h.lsThinkingKey, "0");
            } else if (opt.v === "__on__") {
              h.setThinkingOn(true);
              lsSet(h.lsThinkingKey, "1");
            } else {
              h.setThinkingOn(true);
              lsSet(h.lsThinkingKey, "1");
              lsSet(THINK_LEVEL_KEY, opt.v);
            }
            updateThinkToggleUI();
            closeThinkMenu();
          });
          menu.appendChild(it);
        });

        doc.body.appendChild(menu);
        var pos = thinkMenuPosition(
          toggleEl.getBoundingClientRect(),
          { height: menu.offsetHeight, width: menu.offsetWidth },
          global.innerWidth || 0,
        );
        menu.style.top = pos.top + "px";
        menu.style.left = pos.left + "px";
        menuEl = menu;
        // The click that opened the menu is still propagating: defer the outside-click listener.
        global.setTimeout(function () { doc.addEventListener("click", onDocClick); }, 0);
      }

      function bind() {
        if (!toggleEl) return;
        toggleEl.addEventListener("click", function (e) {
          e.stopPropagation();
          if (menuEl) { closeThinkMenu(); return; }
          openThinkMenu();
        });
      }

      return {
        getThinkLevel: getThinkLevel,
        thinkLevelLabel: function (v) { return thinkLevelLabel(table, v); },
        thinkLevelsFor: function (model, style, allowed) { return thinkLevelsFor(table, model, style, allowed); },
        buildThinkCap: function (supports, style, model, allowed) {
          return buildThinkCap(table, supports, style, model, allowed);
        },
        resolveThinkLevel: function (cap) { return resolveThinkLevel(getThinkLevel(), cap); },
        getActiveThinkCaps: capsNow,
        thinkRequestPayload: function () {
          return thinkRequestPayload(capsNow(), !!h.isThinkingOn(), getThinkLevel());
        },
        updateThinkToggleUI: updateThinkToggleUI,
        openThinkMenu: openThinkMenu,
        closeThinkMenu: closeThinkMenu,
        bind: bind,
        _thinkToggle: toggleEl,
      };
    },
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
