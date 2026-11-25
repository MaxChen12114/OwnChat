// Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name.
// Scene membership, mode and name matching live in services/scene/multi-agent.ts. What stays here is
// everything that needs the page: the topbar toggle, the console panel in the right-hand slot, the
// peer roster in the agent panel, and the two events the rest of the app listens to.
//
// The panel markup is here on purpose — it has exactly one consumer, itself, and every string in it
// is user-visible copy that would otherwise have to travel through a service boundary unchanged.
//
// Ports are resolved per call, never snapshotted: the emit artifact is a classic script that may run
// before the character facade exists, and slot mounting rewrites the panel's parent at runtime.
(function () {
  if (window.__multi) return;

  var KEY_HINT = "cfw_multi_agent_hint_seen";
  var KEY_DEV = "cfw_dev_mode_v1";

  function charFacade() {
    return window.__character || null;
  }

  var api = createScene({
    storage: {
      read: function (key) {
        return window.localStorage.getItem(key);
      },
      write: function (key, value) {
        window.localStorage.setItem(key, value);
      },
    },
    characters: {
      listAllCards: function () {
        var ch = charFacade();
        return ch && ch.listAllCards ? ch.listAllCards() : [];
      },
      archetypes: function () {
        var ch = charFacade();
        return ch && ch.archetypes ? ch.archetypes : [];
      },
      setActiveId: function (id) {
        var ch = charFacade();
        if (ch && ch.setActiveId) ch.setActiveId(id);
      },
    },
    events: {
      changed: function (detail) {
        window.dispatchEvent(new CustomEvent("multi-agent:changed", { detail: detail }));
        window.dispatchEvent(new CustomEvent("character:changed"));
      },
    },
  });

  window.__multi = api;

  // scene-strip: removed from the UI in 4.18 in favour of model-driven turn hand-off. The renderer
  // survives only as a collector for a strip left behind by an older session.
  function renderSceneStrip() {
    var oldStrip = document.getElementById("sceneStrip");
    if (oldStrip && oldStrip.parentNode) oldStrip.parentNode.removeChild(oldStrip);
    if (window.hostApi.app && window.hostApi.app.updateSpacer) window.hostApi.app.updateSpacer();
  }

  function wireTopbarToggle() {
    var btn = document.getElementById("multiAgentToggle");
    if (!btn) return;
    function refresh() {
      var on = api.isMulti();
      // Cards built from the sidebar template carry an icon span; the flat button does not.
      var iconEl = btn.querySelector(".sidebar-btn-icon");
      if (iconEl) iconEl.textContent = on ? "👥" : "🧑";
      else btn.textContent = on ? "👥" : "🧑";
      var labelEl = btn.querySelector(".sidebar-btn-label");
      if (labelEl) labelEl.textContent = on ? "多智能体" : "单智能体";
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    }
    refresh();
    btn.addEventListener("click", function () {
      var next = !api.isMulti();
      api.setMulti(next);
      refresh();
      if (next && !window.localStorage.getItem(KEY_HINT)) {
        try {
          window.localStorage.setItem(KEY_HINT, "1");
        } catch (e) {}
        setTimeout(function () {
          alert("已切换为多人场景模式。\n\n玩法：\n① 点 🎭 打开角色面板 →「我的」标签 → 点多张卡的「+场景」加成员\n② 群聊(orchestrate)模式由智能编排自动接力：AI 喊名字让对应角色发言\n③ 吐槽姬/接龙/讨论模式：点输入框上方的群聊控制台切换发言者\n④ 好感度 / 指令模块都按当前发言者处理\n⑤ 与 Agent 模式同开时：多智能体是「给 agent 开的能力」—— 私下小会 / 派子 agent / 请角色上台（设置→Agent 里有开关），时间线仍由主 agent 说话");
        }, 100);
      }
    });
    window.addEventListener("multi-agent:changed", refresh);
    window.addEventListener("character:changed", refresh);
  }

  function getFishbowl() {
    return window.__fishbowl || null;
  }

  // Inline SVG rather than emoji: the console must inherit currentColor like every other control.
  function fbSvg(d, opts) {
    opts = opts || {};
    var s = opts.size || 14;
    return '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px;flex:none;">' + d + '</svg>';
  }

  function endReasonLabel(r) {
    return ({
      max: "达到最大轮数",
      "end-tag": "AI 触发 [end] 标签",
      stop: "手动终止",
      error: "运行出错",
    })[r] || (r || "—");
  }

  // Group chat and relay share the left/right bubble split; roast alternates sides instead.
  function syncChatMode(mode) {
    var isRoast = mode === "relay" || mode === "discuss";
    document.body.setAttribute("data-chat-mode", isRoast ? "roast" : "group");
  }

  // The themed prompt when it is mounted, the native one otherwise — the console must not strand a
  // user behind a missing feedback module.
  function uiPrompt(message, opts) {
    try {
      if (window.__feedback && window.__feedback.prompt) return window.__feedback.prompt(Object.assign({ message: message }, opts || {}));
    } catch (e) {}
    var v = window.prompt(message, (opts && opts.input && opts.input.value) || "");
    return Promise.resolve(v);
  }

  async function handleFbModeChip(next) {
    var fb = getFishbowl();
    if (!fb) {
      alert("鱼缸引擎未加载(fishbowl-engine.js)");
      return;
    }
    var cur = fb.getMode();
    if (next === cur) return;
    var st = fb.getState();
    if (st.state === "running" || st.state === "paused") fb.stop();
    if (st.state === "ended" && fb.resetEnded) fb.resetEnded();
    fb.setMode(next);
    if (next === "discuss") {
      var topic = await uiPrompt("请输入议题（必填）", { title: "讨论议题", okText: "开始讨论", input: { value: fb.getTopic() || "", placeholder: "例如：今晚谁洗碗" } });
      if (!topic || !topic.trim()) {
        fb.setMode(cur);
        renderAll();
        return;
      }
      fb.setTopic(topic.trim());
    }
    if (next === "relay" || next === "discuss") {
      // Developer mode skips the round cap: the run ends on the model's [end] tag or a manual stop.
      if (window.localStorage.getItem(KEY_DEV) === "1") {
        fb.start();
      } else {
        var curRounds = fb.getMaxRounds();
        var ans = await uiPrompt("最大轮数（1-1000，默认 8。仅防意外离开爆资金；随时可手动终止）", { title: "接龙轮数", okText: "开始", input: { value: String(curRounds), type: "number" } });
        // A cancelled dialog must not start the run — only an accepted one does.
        if (ans === null) {
          fb.setMode(cur);
          renderAll();
          return;
        }
        fb.setMaxRounds(clampRounds(ans, curRounds));
        fb.start();
      }
    }
    renderAll();
  }

  async function handleFbCmd(cmd) {
    var fb = getFishbowl();
    if (!fb) return;
    if (cmd === "start") fb.start();
    else if (cmd === "pause") fb.pause();
    else if (cmd === "resume") fb.resume();
    else if (cmd === "stop") fb.stop();
    else if (cmd === "topic") {
      var t = await uiPrompt("新议题", { title: "改议题", okText: "保存", input: { value: fb.getTopic() || "" } });
      if (t && t.trim()) fb.setTopic(t.trim());
    } else if (cmd === "restart") {
      if (fb.resetEnded) fb.resetEnded();
      fb.start();
    } else if (cmd === "close") {
      if (fb.resetEnded) fb.resetEnded();
      fb.setMode("orchestrate");
    }
    setTimeout(renderAll, 50);
  }

  function renderFishbowlSidePanel() {
    // Older sessions may still carry a V2 bottom bar; V3 keeps everything in the side panel.
    ["fishbowlModeRow", "fishbowlBar"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });

    var panel = document.getElementById("fishbowlSidePanel");
    var fb = getFishbowl();
    var showPanel = !!fb && api.isMulti() && api.getSceneIds().length >= 2;

    if (!showPanel) {
      if (panel) panel.style.display = "none";
      document.body.removeAttribute("data-chat-mode");
      if (window.hostApi.app && window.hostApi.app.updateSpacer) window.hostApi.app.updateSpacer();
      return;
    }

    // Desktop docks into the right-hand slot; phones fall back to body (V3 bottom sheet).
    var slot = window.slotRegistry.pick("fishbowlSlot");
    var isDesktop = window.matchMedia("(min-width: 1024px)").matches;
    var target = isDesktop && slot ? slot : document.body;
    // The agent console shares this slot when both run at once. The console sits above the timeline
    // so a long timeline cannot push the controls out of the viewport, and DOM order is
    // roster -> group-chat console -> agent console.
    if (!panel) {
      panel = document.createElement("aside");
      panel.id = "fishbowlSidePanel";
      panel.className = "fishbowl-side-panel";
    }
    if (target === slot) {
      var anchor = slot.querySelector("#__agentConsoleRoot");
      if (anchor && anchor.parentNode === slot) {
        if (panel.parentNode !== slot || panel.nextElementSibling !== anchor) {
          slot.insertBefore(panel, anchor);
        }
      } else if (panel.parentNode !== slot) {
        if (panel.parentNode) panel.parentNode.removeChild(panel);
        slot.appendChild(panel);
      }
    } else if (panel.parentNode !== target) {
      if (panel.parentNode) panel.parentNode.removeChild(panel);
      target.appendChild(panel);
    }
    panel.classList.toggle("in-slot", target === slot);
    panel.style.display = "";

    var s = fb.getState();
    var mode = s.mode || "orchestrate";
    syncChatMode(mode);

    var safe = window.__ownEscape.esc;
    var stateLabel = ({
      idle: fbSvg('<circle cx="12" cy="12" r="7"/>') + " 待启动",
      running: fbSvg('<path d="M8 6l9 6-9 6z" fill="currentColor" stroke="none"/>') + " 进行中",
      paused: fbSvg('<rect x="7" y="5" width="3.4" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="13.6" y="5" width="3.4" height="14" rx="1" fill="currentColor" stroke="none"/>') + " 已暂停",
      ended: fbSvg('<path d="M6 21V4"/><path d="M6 5h11l-2 3 2 3H6"/>') + " 已结束",
    })[s.state] || s.state;

    var modes = [
      { id: "orchestrate", label: fbSvg('<path d="M14 5l5 5"/><path d="M4 20l1-4L16 5l3 3L8 19z"/>') + " 编排", title: "你手选下一句由谁说(群聊视觉)" },
      { id: "relay", label: fbSvg('<path d="M4 12a8 8 0 0 1 13.7-5.7L20 8"/><path d="M20 4v4h-4"/><path d="M20 12a8 8 0 0 1-13.7 5.7L4 16"/><path d="M4 20v-4h4"/>') + " 接龙", title: "AI 轮流自动接龙(吐槽姬视觉)" },
      { id: "discuss", label: fbSvg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0"/><path d="M12 17v3"/>') + " 讨论", title: "围绕议题自由讨论(吐槽姬视觉)" },
    ];
    var chipsHtml = modes.map(function (m) {
      return '<button class="chip-btn fishbowl-chip' + (m.id === mode ? " active" : "") + '" data-fbmode="' + m.id + '" title="' + safe(m.title) + '">' + m.label + '</button>';
    }).join("");

    var statusHtml = "";
    if (mode === "relay" || mode === "discuss") {
      if (s.state === "ended" && s.endStats) {
        var e = s.endStats;
        statusHtml = '<div class="fb-side-ended"><div class="fb-ended-title">' + fbSvg('<path d="M6 21V4"/><path d="M6 5h11l-2 3 2 3H6"/>') + ' 已结束</div><div class="fb-ended-line">共 <b>' + e.totalRounds + '</b> 轮，用时 <b>' + e.durationSec + '</b> 秒</div>' + (mode === "discuss" && e.topic ? '<div class="fb-ended-line">议题:' + safe(e.topic) + '</div>' : "") + '<div class="fb-ended-reason">' + endReasonLabel(e.endReason) + '</div></div>';
      } else {
        var round = window.localStorage.getItem(KEY_DEV) === "1" ? (s.round || 0) + "（不限轮，开发者）" : (s.round || 0) + "/" + fb.getMaxRounds();
        var topic = mode === "discuss" ? fb.getTopic() || "(未设置)" : "";
        var speaker = s.speakerName || "—";
        // Running cost replaces a hard round cap: the user decides when to stop.
        var costLine = "";
        try {
          if (window.hostApi.cost && window.hostApi.cost.getCostStats) {
            var cs = window.hostApi.cost.getCostStats();
            if (cs && cs.total > 0) {
              costLine = '<div class="fb-info-line" style="opacity:.85;">' + fbSvg('<path d="M12 3v18"/><path d="M16 7H9.5a2.5 2.5 0 0 0 0 5h5a2.5 2.5 0 0 1 0 5H7"/>', { size: 12 }) + ' 今日 <b>¥' + cs.today.toFixed(4) + '</b>，累计 <b>¥' + cs.total.toFixed(4) + '</b></div>';
            }
          }
        } catch (e) {}
        statusHtml = '<div class="fb-side-status"><div class="fb-state-line">' + stateLabel + '</div><div class="fb-info-line">轮次 <b>' + round + '</b></div>' + (topic ? '<div class="fb-info-line">议题:' + safe(topic) + '</div>' : "") + '<div class="fb-info-line">当前:<b>' + safe(speaker) + '</b></div>' + costLine + '</div>';
      }
    }

    var btns = [];
    if (mode === "relay" || mode === "discuss") {
      var _play = fbSvg('<path d="M8 6l9 6-9 6z" fill="currentColor" stroke="none"/>', { size: 12 });
      var _pause = fbSvg('<rect x="7" y="5" width="3.4" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="13.6" y="5" width="3.4" height="14" rx="1" fill="currentColor" stroke="none"/>', { size: 12 });
      var _stop = fbSvg('<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>', { size: 12 });
      var _edit = fbSvg('<path d="M14 5l5 5"/><path d="M4 20l1-4L16 5l3 3L8 19z"/>', { size: 12 });
      var _spark = fbSvg('<path d="M12 3l1.6 5.4L19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6z" fill="currentColor" stroke="none"/>', { size: 12 });
      var _close = fbSvg('<path d="M6 6l12 12M18 6L6 18"/>', { size: 12 });
      if (s.state === "idle") btns.push('<button class="chip-btn fb-cmd-btn fb-primary" data-fbcmd="start">' + _play + ' 启动</button>');
      if (s.state === "running") btns.push('<button class="chip-btn fb-cmd-btn" data-fbcmd="pause">' + _pause + ' 暂停</button>');
      if (s.state === "paused") btns.push('<button class="chip-btn fb-cmd-btn" data-fbcmd="resume">' + _play + ' 继续</button>');
      if (s.state === "running" || s.state === "paused") btns.push('<button class="chip-btn fb-cmd-btn" data-fbcmd="stop">' + _stop + ' 终止</button>');
      if (mode === "discuss" && s.state !== "ended") btns.push('<button class="chip-btn fb-cmd-btn" data-fbcmd="topic">' + _edit + ' 改议题</button>');
      if (s.state === "ended") {
        btns.push('<button class="chip-btn fb-cmd-btn fb-primary" data-fbcmd="restart">' + _spark + ' 新一轮</button>');
        btns.push('<button class="chip-btn fb-cmd-btn" data-fbcmd="close">' + _close + ' 关闭</button>');
      }
    }

    // Orchestrate mode is not driven by the engine, and the tap-a-character strip was removed in
    // 4.18 — without this roster nothing on screen can make a chosen character say the next line.
    var orchestrateHtml = "";
    if (mode === "orchestrate") {
      var roster = api.getSceneCards();
      var activeId = ((window.__character && window.__character.getActiveCard && window.__character.getActiveCard()) || {}).id || "";
      orchestrateHtml = '<div class="fb-side-status"><div class="fb-info-line">点角色让 TA 说下一句:</div><div class="fb-side-roster" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;">' +
        roster.map(function (c) {
          return '<button class="chip-btn fb-orch-speaker' + (c.id === activeId ? " active" : "") + '" data-fborch="' + safe(c.id) + '"><span>' + safe(c.icon || "\u{1F642}") + '</span> ' + safe(c.name) + '</button>';
        }).join("") +
        '</div></div>';
    }

    // Each character eats its own context, so the count shown here is that character's, not the
    // session's — without it a suddenly short context reads as a bug.
    var ctxHtml = "";
    try {
      var info = window.hostApi.app && window.hostApi.app.getContextInfo ? window.hostApi.app.getContextInfo() : null;
      if (info) {
        var who = info.speaker ? "「" + safe(info.speaker) + "」" : "";
        ctxHtml = '<div class="fb-side-ctx" style="font-size:11px;opacity:.72;padding:2px 2px 6px;">上下文：' + safe(info.label) + who + '，计入 ' + info.included + ' 条 / 共 ' + info.total + ' 条</div>';
      }
    } catch (e) {}

    panel.innerHTML = '<div class="fb-side-header">' + fbSvg('<path d="M4 5.5h13a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H9l-4 3v-3H4A1.5 1.5 0 0 1 2.5 14V7A1.5 1.5 0 0 1 4 5.5z"/><circle cx="7.5" cy="10.5" r="1" fill="currentColor" stroke="none"/><circle cx="10.8" cy="10.5" r="1" fill="currentColor" stroke="none"/><circle cx="14.1" cy="10.5" r="1" fill="currentColor" stroke="none"/>', { size: 15 }) + ' 群聊控制台</div>' + ctxHtml + '<div class="fb-side-modes">' + chipsHtml + '</div>' + orchestrateHtml + statusHtml + (btns.length ? '<div class="fb-side-actions">' + btns.join("") + '</div>' : "");

    panel.querySelectorAll("[data-fbmode]").forEach(function (el) {
      el.addEventListener("click", function () {
        handleFbModeChip(el.dataset.fbmode);
      });
    });
    panel.querySelectorAll("[data-fbcmd]").forEach(function (el) {
      el.addEventListener("click", function () {
        handleFbCmd(el.dataset.fbcmd);
      });
    });
    // Passing the card explicitly avoids a setActiveId race; the reply then starts its own hand-off
    // chain so the group keeps talking without further clicks.
    panel.querySelectorAll("[data-fborch]").forEach(function (el) {
      el.addEventListener("click", async function () {
        var id = el.dataset.fborch;
        var card = api.getSceneCards().find(function (c) {
          return c.id === id;
        });
        if (!card) return;
        if (window.__character && window.__character.setActiveId) window.__character.setActiveId(id);
        if (window.hostApi.app && window.hostApi.app.sendOne) {
          var reply = await window.hostApi.app.sendOne({ allowEmptyText: true, asCard: card });
          if (window.hostApi.app.continueGroupChat) {
            try {
              await window.hostApi.app.continueGroupChat(reply, card);
            } catch (e) {}
          }
        }
      });
    });

    if (window.hostApi.app && window.hostApi.app.updateSpacer) window.hostApi.app.updateSpacer();
  }

  // Peer roster in the agent panel: who is on stage (addressable for a whisper or an invitation) and
  // how many messages each of them has in its own private thread.
  function renderAgentPeers() {
    var box = document.getElementById("__agentPeers");
    if (!box) return;
    if (!api.isMulti() || api.getSceneIds().length < 2) {
      box.innerHTML = "";
      box.style.display = "none";
      return;
    }
    box.style.display = "";
    var safe = window.__ownEscape.esc;
    var cards = api.getSceneCards();
    var info = null;
    try {
      info = window.hostApi.app && window.hostApi.app.getContextInfo ? window.hostApi.app.getContextInfo() : null;
    } catch (e) {}
    var rows = cards.map(function (c) {
      var n = null;
      try {
        n = window.hostApi.app && window.hostApi.app.getRoleContextCount ? window.hostApi.app.getRoleContextCount(c) : null;
      } catch (e) {}
      return '<span class="chip-btn" title="' + safe(c.name) + (n != null ? "（自己的单聊上下文 " + n + " 条）" : "") + '">'
        + safe(c.icon || "\u{1F642}") + " " + safe(c.name) + (n != null ? " · " + n : "") + "</span>";
    }).join("");
    box.innerHTML = '<div style="font-size:11px;opacity:.72;padding:0 2px 6px;">平级名单（可被私下咨询 / 可被请上台）'
      + (info ? "，当前上下文计入 " + info.included + "/" + info.total + " 条" : "")
      + '</div><div style="display:flex;flex-wrap:wrap;gap:6px;padding:0 2px 8px;">' + rows + "</div>";
  }

  function renderAll() {
    renderSceneStrip();
    renderFishbowlSidePanel();
    renderAgentPeers();
  }

  document.addEventListener("DOMContentLoaded", function () {
    wireTopbarToggle();
    // Deferred once so app.js has laid out the floating input bar the panel measures against.
    setTimeout(renderAll, 80);
    window.addEventListener("character:changed", renderAll);
    window.addEventListener("multi-agent:changed", renderAll);
    window.addEventListener("fishbowl:tick", renderAll);
    var resizeTimer = 0;
    window.addEventListener("resize", function () {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(renderAll, 200);
    });
  });
})();
