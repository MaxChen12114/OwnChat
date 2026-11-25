(function () {
/**
 * The topbar mode pill and the mode switch behind it: for each of the three channel states (guest,
 * preset, custom) it decides the word, glyph and tooltip the button shows, plus which mode a click
 * moves to and which preset a custom-channel click falls back to.
 *
 * Two shapes here are load-bearing and look like bugs if "fixed". A preset channel never prints its
 * own name on the pill: the free/fast pills are mode switches, not channel read-outs, so they stay
 * two characters wide and the channel name lives in the tooltip — printing the channel title there
 * reflows the whole topbar. Only a custom channel prints a name, truncated by code point to four
 * slots, because a half-cut emoji is worse than an ellipsis.
 *
 * Reading providers state and writing the DOM stay in the wiring; this module only answers what the
 * pill should say and what the next mode is.
 * @module services/ui/channel-mode
 */

                                     
                                              

/** What the wiring resolved from the providers module; `mode` is the channel's paired mode. */
                                
                    
               
                 
 

                           
                                                                                        
                      
               
                                                                                       
                
                
 

/** Anything but the literal `fast` reads as the free mode; a corrupt stored mode must not blank the pill. */
function cmMode(v         )         {
  return v === "fast" ? "fast" : "free";
}

function cmNextMode(v         )         {
  return cmMode(v) === "fast" ? "free" : "fast";
}

/** The preset that pairs with a mode; a custom channel is explicitly switched back to it on click. */
function cmPresetFor(v         )         {
  return "preset:" + (cmMode(v) === "fast" ? "deepseek" : "nvidia");
}

/** Only a non-empty id can be a custom channel; `custom:` is the prefix the providers module writes. */
function cmIsCustomActive(activeId         )          {
  if (!activeId) return false;
  return String(activeId).indexOf("custom:") === 0;
}

/** Four slots max: longer names keep three characters plus an ellipsis so the topbar does not reflow. */
function cmCustomLabel(name         )         {
  const chars = Array.from(String(name || "").trim());
  return chars.length > 4 ? chars.slice(0, 3).join("") + "…" : chars.join("");
}

/**
 * The pill for the current state. A guest with no channel gets the guest pill; a guest that does
 * have a custom channel still sees that channel, because it is the guest's own key.
 *
 * @returns `{ text, icon, label, title }` — `text` is non-null only for the two channel-less states,
 *   so the caller must skip the `textContent` write when it is null and let the icon painter own it.
 */
function cmPillPlan(input                                                                  )           {
  const ch = input.channel;
  if (!ch) {
    if (input.guest) {
      return {
        text: "访客",
        icon: "modeFree",
        label: "访客",
        title: "访客模式：请在 设置 → 模型 API 填自己的渠道和 Key",
      };
    }
    const fast = cmMode(input.mode) === "fast";
    return {
      text: fast ? "\u26A1 快速" : "\u{1F7E2} 免费",
      icon: fast ? "modeFast" : "modeFree",
      label: fast ? "快速" : "免费",
      title: fast
        ? "当前：快速档（按量计费）；渠道与默认模型见 设置→模型 API"
        : "当前：免费档；渠道与默认模型见 设置→模型 API",
    };
  }
  if (ch.kind === "preset") {
    // The channel's own paired mode wins over the current mode: an active preset defines the tier.
    const fast = ch.mode === "fast";
    return {
      text: null,
      icon: fast ? "modeFast" : "modeFree",
      label: fast ? "快速" : "免费",
      title:
        "当前：" + (fast ? "快速档" : "免费档") + "（渠道 " + ch.name + "）；点击切换免费/快速 · 渠道详情见 设置→模型 API",
    };
  }
  return {
    text: null,
    icon: "modeFast",
    label: cmCustomLabel(ch.name),
    title: "当前渠道：" + ch.name + "；点击切换免费/快速预设（渠道详情见 设置→模型 API）",
  };
}

/**
 * Whether a providers-changed event has to move the mode, and to what.
 *
 * @returns the target mode, or null when the event only needs a repaint. Anything outside the two
 *   known modes returns null: the pill must not adopt a value the request path cannot honour.
 */
function cmFollowPlan(current         , want         )                {
  if (want !== "fast" && want !== "free") return null;
  return want === current ? null : want;
}

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

globalThis.cmMode = cmMode;
globalThis.cmNextMode = cmNextMode;
globalThis.cmPresetFor = cmPresetFor;
globalThis.cmIsCustomActive = cmIsCustomActive;
globalThis.cmCustomLabel = cmCustomLabel;
globalThis.cmPillPlan = cmPillPlan;
globalThis.cmFollowPlan = cmFollowPlan;
})();
