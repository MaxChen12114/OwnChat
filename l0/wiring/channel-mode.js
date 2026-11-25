// Browser adapter, appended by l0/emit.mjs. Engine: services/ui/channel-mode.ts; this file keeps the
// frozen global surface plus every side effect — providers/auth reads, localStorage, DOM writes and
// the deferred follow after a channel switch.
//
// Must load before app.js: that module calls `create(host)` at init and paints the pill from it.
(function () {
  "use strict";
  if (window.__channelMode) return;

  function isGuest() {
    try {
      return !!(window.__auth && window.__auth.getToken && !window.__auth.getToken());
    } catch (e) {
      return false;
    }
  }

  window.__channelMode = {
    create(host) {
      host = host || {};
      const getMode = typeof host.getMode === "function" ? host.getMode : () => "free";
      const setMode = typeof host.setMode === "function" ? host.setMode : () => {};
      const setIcon = typeof host.setIcon === "function" ? host.setIcon : function () {};
      const refreshModels = typeof host.refreshModels === "function" ? host.refreshModels : () => {};
      const refreshCost = typeof host.refreshCost === "function" ? host.refreshCost : () => {};
      const refreshThink = typeof host.refreshThink === "function" ? host.refreshThink : () => {};
      // A channel switch fires `cfw:providers-changed` from inside setActive. Applying the mode on
      // that stack re-enters initModels and locks the topbar, so the follow is deferred one tick.
      const defer = typeof host.defer === "function" ? host.defer : function (fn) { setTimeout(fn, 0); };
      const modeToggle = document.getElementById("modeToggle");

      function activeChannelInfo() {
        try {
          const P = window.__providers;
          if (!P || !P.read) return null;
          const st = P.read();
          const key = st && st.activeId;
          if (!key) return null;
          const k = P.parseKey ? P.parseKey(key) : null;
          if (!k) return null;
          if (k.kind === "preset") {
            // A guest must not see a preset channel: free/fast both run on the site owner's key.
            if (isGuest()) return null;
            const m = P.presetMeta ? P.presetMeta(k.id) : null;
            return { name: (m && (m.title || m.label)) || k.id, kind: "preset", mode: P.modeForActive ? P.modeForActive() : null };
          }
          if (k.kind === "custom") {
            let name = k.id;
            try {
              const list = P.channels ? P.channels() : [];
              for (const c of list) if (c && c.key === key) { name = c.name || c.id || name; break; }
            } catch (e) {}
            return { name: name, kind: "custom" };
          }
        } catch (e) {}
        return null;
      }

      function paintModeToggle() {
        if (!modeToggle) return;
        const plan = cmPillPlan({ mode: getMode(), guest: isGuest(), channel: activeChannelInfo() });
        if (plan.text !== null) modeToggle.textContent = plan.text;
        setIcon(modeToggle, plan.icon, plan.label);
        modeToggle.title = plan.title;
      }

      function applyMode(mode) {
        setMode(mode);
        localStorage.setItem(host.lsModeKey, mode);
        paintModeToggle();
        refreshModels();
        refreshCost();
        refreshThink();
      }

      function toggleMode() {
        if (isGuest()) {
          alert("访客模式：请先在 设置 → 模型 API 新增自己的渠道并填写 Key。");
          return;
        }
        const next = cmNextMode(getMode());
        // The pill doubles as a shortcut to the paired preset: a custom channel is switched back to
        // it, while "already following the pill" stays a follow (active id cleared).
        try {
          if (window.__providers && window.__providers.setActive) {
            const st = window.__providers.read();
            const cur = st && st.activeId;
            if (cmIsCustomActive(cur)) window.__providers.setActive(cmPresetFor(next));
            else window.__providers.setActive(null);
          }
        } catch (e) {}
        applyMode(next);
      }

      function followActiveChannel() {
        try {
          const want = window.__providers && window.__providers.modeForActive && window.__providers.modeForActive();
          const target = cmFollowPlan(getMode(), want);
          if (target) {
            // The click that triggered this event applies the same mode itself, so re-check before
            // switching — otherwise the deferred callback flips the mode back.
            defer(function () { if (target !== getMode()) applyMode(target); });
            return;
          }
          paintModeToggle();
          refreshModels();
          refreshThink();
        } catch (e) {}
      }

      function bind() {
        if (modeToggle) modeToggle.addEventListener("click", toggleMode);
        try {
          window.addEventListener("cfw:providers-changed", followActiveChannel);
        } catch (e) {}
      }

      return { activeChannelInfo, paintModeToggle, applyMode, toggleMode, followActiveChannel, bind };
    },
  };
})();
