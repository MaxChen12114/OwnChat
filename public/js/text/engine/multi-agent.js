// public/multi-agent.js — 多智能体场景模块
// 拆自 character.js（场景成员+模式开关）+ app.js（scene-strip 渲染）+ topbar-controls.js（顶栏按钮）
// 单一职责：管「谁在场景里 / 当前是不是多人模式 / scene-strip UI / 顶栏切换按钮」
// 依赖：window.__character.listAllCards() 拿全部卡
// 事件：
//   window 'multi-agent:changed' detail = { isMulti, sceneIds }
//   同时向后兼容派发 'character:changed' 让 character.js UI 自动 rerender
(function () {
"use strict";
const LSMM = "tavern_multi_agent_mode_v1"; // "single" | "multi"，默认 single
const LSAS = "tavern_active_scene_v1";     // 场景成员 cardId 数组
const LSHINT = "cfw_multi_agent_hint_seen";
const LSA = "tavern_active_char_id";

function emit() {
  const detail = { isMulti: isMulti(), sceneIds: getSceneIds() };
  window.dispatchEvent(new CustomEvent("multi-agent:changed", { detail }));
  // 向后兼容：character.js UI 仍在监听 character:changed
  window.dispatchEvent(new CustomEvent("character:changed"));
}

// ── 模式开关 ──
function isMulti() { return localStorage.getItem(LSMM) === "multi"; }
function setMulti(b) {
  localStorage.setItem(LSMM, b ? "multi" : "single");
  emit();
}

// ── 场景成员管理 ──
function getSceneIds() {
  try {
    const r = JSON.parse(localStorage.getItem(LSAS) || "[]");
    return Array.isArray(r) ? r.filter(x => typeof x === "string" && x) : [];
  } catch { return []; }
}
function setSceneIds(ids) {
  localStorage.setItem(LSAS, JSON.stringify(Array.isArray(ids) ? ids : []));
  emit();
}
function isInScene(id) { return getSceneIds().includes(id); }
function addToScene(id) {
  if (!id) return;
  const a = getSceneIds();
  if (!a.includes(id)) { a.push(id); setSceneIds(a); }
}
function removeFromScene(id) {
  if (!id) return;
  const a = getSceneIds().filter(x => x !== id);
  setSceneIds(a);
  const cur = localStorage.getItem(LSA) || "";
  if (cur === id && window.__character && window.__character.setActiveId) {
    window.__character.setActiveId(a[0] || "");
  }
}
function getSceneCards() {
  const ids = getSceneIds();
  if (!ids.length) return [];
  const ch = window.__character;
  const all = (ch && ch.listAllCards) ? ch.listAllCards() : [];
  const archs = (ch && ch.archetypes) ? ch.archetypes : [];
  const map = new Map(all.map(c => [c.id, c]));
  return ids.map(id => map.get(id) || archs.find(x => x.id === id)).filter(Boolean);
}
function getSceneOtherNames() {
  if (!isMulti()) return [];
  const ids = getSceneIds();
  if (ids.length < 2) return [];
  const cur = localStorage.getItem(LSA) || "";
  const cards = getSceneCards();
  const map = new Map(cards.map(c => [c.id, c]));
  return ids.filter(id => id !== cur).map(id => (map.get(id) || {}).name || "").filter(Boolean);
}

// 4.52 在场感 part2:AI 召唤场景外角色入场
const _summonNorm = (s) => String(s == null ? "" : s).replace(/[\s【】\[\]()（）「」·,，.。!！?？~]/g, "").toLowerCase();
function findAnyCardByName(name) {
  if (!name) return null;
  const ch = window.__character;
  const all = (ch && ch.listAllCards) ? ch.listAllCards() : [];
  const archs = (ch && ch.archetypes) ? ch.archetypes : [];
  const pool = all.concat(Array.isArray(archs) ? archs : []);
  if (!pool.length) return null;
  const raw = String(name).trim();
  let hit = pool.find(c => c && c.name === raw);
  if (hit) return hit;
  const nh = _summonNorm(raw);
  if (!nh) return null;
  hit = pool.find(c => c && _summonNorm(c.name) === nh);
  if (hit) return hit;
  hit = pool.find(c => { const cn = _summonNorm(c && c.name); return cn && cn.length >= 2 && nh.length >= 2 && (cn.includes(nh) || nh.includes(cn)); });
  return hit || null;
}
// 当前不在场、可被 AI 叫进来的角色名(仅用户已保存的卡,排除在场成员与当前发言者)
function getSummonableNames(excludeId) {
  const ch = window.__character;
  const all = (ch && ch.listAllCards) ? ch.listAllCards() : [];
  const sceneIds = new Set(getSceneIds());
  return all.filter(c => c && c.id && c.name && !sceneIds.has(c.id) && c.id !== excludeId).map(c => c.name);
}
// 把一个场景外角色叫到场:多人模式自动开启 + 加入场景成员;返回命中的卡(未命中返回 null)
function summonByName(name) {
  const card = findAnyCardByName(name);
  if (!card) return null;
  if (!isMulti()) setMulti(true);
  if (!isInScene(card.id)) addToScene(card.id);
  return card;
}

window.__multi = {
  isMulti, setMulti,
  getSceneIds, isInScene, addToScene, removeFromScene,
  getSceneCards, getSceneOtherNames,
  getSummonableNames, summonByName,
};

// ── scene-strip 渲染（输入框上方的「下一句由谁说」选择条）──
// 4.18 (v5): 用户要求删除——改用智能编排(AI 喊名字自动接力发言),strip 多余
// 函数保留为兜底:若 DOM 里已存在 strip(老 session 残留)就清理,后续永远不再渲染
function renderSceneStrip() {
  const oldStrip = document.getElementById("sceneStrip");
  if (oldStrip && oldStrip.parentNode) oldStrip.parentNode.removeChild(oldStrip);
  if (window.__app && window.__app.updateSpacer) window.__app.updateSpacer();
  return;
}

// ── 顶栏 #multiAgentToggle 按钮 ──
function wireTopbarToggle() {
  const btn = document.getElementById("multiAgentToggle");
  if (!btn) return;
  function refresh() {
    const on = isMulti();
    // 4.3:兼容 sidebar-btn 结构(优先更新 .sidebar-btn-icon span,否则退回 textContent)
    const iconEl = btn.querySelector(".sidebar-btn-icon");
    if (iconEl) iconEl.textContent = on ? "👥" : "🧑";
    else btn.textContent = on ? "👥" : "🧑";
    // 4.18 (v5): label 同步切换——未启用时显示「单智能体」更直觉
    const labelEl = btn.querySelector(".sidebar-btn-label");
    if (labelEl) labelEl.textContent = on ? "多智能体" : "单智能体";
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }
  refresh();
  btn.addEventListener("click", () => {
    const next = !isMulti();
    setMulti(next);
    refresh();
    if (next && !localStorage.getItem(LSHINT)) {
      try { localStorage.setItem(LSHINT, "1"); } catch (e) {}
      setTimeout(() => {
        alert("已切换为多人场景模式。\n\n玩法：\n① 点 🎭 打开角色面板 →「我的」标签 → 点多张卡的「+场景」加成员\n② 群聊(orchestrate)模式由智能编排自动接力：AI 喊名字让对应角色发言\n③ 吐槽姬/接龙/讨论模式：点输入框上方的群聊控制台切换发言者\n④ 好感度 / 指令模块都按当前发言者处理\n⑤ 与 Agent 模式同开时：多智能体是「给 agent 开的能力」—— 私下小会 / 派子 agent / 请角色上台（设置→Agent 里有开关），时间线仍由主 agent 说话");
      }, 100);
    }
  });
  window.addEventListener("multi-agent:changed", refresh);
  window.addEventListener("character:changed", refresh);
}

// ─── 鱼缸 V3:右侧悬浮控制台 + body[data-chat-mode] 二分视觉 + ended 态保留 ───
// 群聊 mode(orchestrate)→ data-chat-mode="group",AI 全左/用户右
// 吐槽姬 mode(relay|discuss)→ data-chat-mode="roast",AI 偶左奇右交替,用户位隐藏
// 结束后 ended 状态卡保留至用户点「✨ 新一轮」/「× 关闭」
function getFishbowl() { return window.__fishbowl || null; }

// 4.59 线性图标:群聊控制台改用与全站一致的 currentColor 线性 SVG(替换 emoji 🎭✏️🔁🎙️▶⏸⏹📝✨💰🏁)
function fbSvg(d, opts){ opts = opts || {}; var s = opts.size || 14; return '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px;flex:none;">' + d + '</svg>'; }

function endReasonLabel(r) {
  return ({
    max: "达到最大轮数",
    "end-tag": "AI 触发 [end] 标签",
    stop: "手动终止",
    error: "运行出错",
  })[r] || (r || "—");
}

function syncChatMode(mode) {
  const isRoast = (mode === "relay" || mode === "discuss");
  document.body.setAttribute("data-chat-mode", isRoast ? "roast" : "group");
  const inputEl = document.getElementById("msg");
  if (inputEl) {
    // 4.82: roast 模式的插话输入实际走普通发送路径（fishbowl 插话队列已于 2026-11-08 摘除,从未接线）——
    // placeholder 如实描述,不承诺「主持人介入」
    inputEl.placeholder = isRoast
      ? "Message...(发言由群聊控制台指定)"
      : "Message...";
  }
}

function handleFbModeChip(next) {
  const fb = getFishbowl();
  if (!fb) { alert("鱼缸引擎未加载(fishbowl-engine.js)"); return; }
  const cur = fb.getMode();
  if (next === cur) return;
  const st = fb.getState();
  if (st.state === "running" || st.state === "paused") fb.stop();
  if (st.state === "ended" && fb.resetEnded) fb.resetEnded();
  fb.setMode(next);
  if (next === "discuss") {
    const topic = prompt("请输入议题(必填):", fb.getTopic() || "");
    if (!topic || !topic.trim()) { fb.setMode(cur); renderAll(); return; }
    fb.setTopic(topic.trim());
  }
  if (next === "relay" || next === "discuss") {
    // 4.52: 开发者模式下取消轮数限制——不弹轮数框,直接开跑,靠 AI [end] 或手动 ⏹ 停止(实验,反馈好转正)
    if (localStorage.getItem("cfw_dev_mode_v1") === "1") {
      fb.start();
    } else {
      const curRounds = fb.getMaxRounds();
      const ans = prompt("最大轮数(1-1000，默认 8。实质取消限制，仅防意外离开爆资金；随时点 ⏹ 手动终止):", String(curRounds));
      // 4.35 修复:点「取消」(prompt 返回 null) 时不应自动开跑——回退到原模式并 return,
      // 只有点「确定」才 setMaxRounds + start。修复"接龙不管确定还是取消都会开始"。
      if (ans === null) { fb.setMode(cur); renderAll(); return; }
      const n = Math.max(1, Math.min(1000, parseInt(ans || curRounds, 10) || curRounds));
      fb.setMaxRounds(n);
      fb.start();
    }
  }
  renderAll();
}

function handleFbCmd(cmd) {
  const fb = getFishbowl();
  if (!fb) return;
  if (cmd === "start") fb.start();
  else if (cmd === "pause") fb.pause();
  else if (cmd === "resume") fb.resume();
  else if (cmd === "stop") fb.stop();
  else if (cmd === "topic") {
    const t = prompt("新议题:", fb.getTopic() || "");
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
  // 清理旧版底部条形(鱼缸 V2)元素,V3 统一用 .fishbowl-side-panel
  ["fishbowlModeRow", "fishbowlBar"].forEach(id => {
    const el = document.getElementById(id);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  });

  let panel = document.getElementById("fishbowlSidePanel");
  const fb = getFishbowl();
  const showPanel = !!fb && isMulti() && getSceneIds().length >= 2;

  if (!showPanel) {
    if (panel) panel.style.display = "none";
    document.body.removeAttribute("data-chat-mode");
    const inputEl = document.getElementById("msg");
    if (inputEl) inputEl.placeholder = "Message...";
    if (window.__app && window.__app.updateSpacer) window.__app.updateSpacer();
    return;
  }

  // 4.3:桌面端挂到 #fishbowlSlot(右侧栏);手机端退回 document.body(底部条形 V3)
  const slot = document.getElementById("fishbowlSlot");
  const isDesktop = window.matchMedia("(min-width: 1024px)").matches;
  const target = (isDesktop && slot) ? slot : document.body;
  // 2026-11-08(所有者拍板): 双开时鱼缸面板与 Agent 控制台堆叠共存 —— 本函数被
  // mount/unmount 派发的 multi-agent:changed 触发重跑,把面板追加/移回槽位即可。
  // 2026-11-09(所有者要求): 群聊控制台固定在 Agent 时间线**上方** —— 时间线一路增长时
  // 不能把编排/接龙/讨论按钮顶出视口。目标位置 = 槽内 #__agentConsoleRoot 之前;
  // 没有 Agent 控制台时追加到末尾。DOM 顺序 = 平级名单 → 群聊控制台 → Agent 控制台。
  if (!panel) {
    panel = document.createElement("aside");
    panel.id = "fishbowlSidePanel";
    panel.className = "fishbowl-side-panel";
  }
  if (target === slot) {
    const anchor = slot.querySelector("#__agentConsoleRoot");
    // 已在锚点前就跳过；否则(未挂载/被清槽/位置在后)插到锚点前
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
  // in-slot class:桌面时取消 fixed 定位(与 CSS .fishbowl-side-panel.in-slot 配合)
  panel.classList.toggle("in-slot", target === slot);
  panel.style.display = "";

  const s = fb.getState();
  const mode = s.mode || "orchestrate";
  syncChatMode(mode);

  const safe = window.__ownEscape.esc;
  const stateLabel = ({
    idle: fbSvg('<circle cx="12" cy="12" r="7"/>') + " 待启动",
    running: fbSvg('<path d="M8 6l9 6-9 6z" fill="currentColor" stroke="none"/>') + " 进行中",
    paused: fbSvg('<rect x="7" y="5" width="3.4" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="13.6" y="5" width="3.4" height="14" rx="1" fill="currentColor" stroke="none"/>') + " 已暂停",
    ended: fbSvg('<path d="M6 21V4"/><path d="M6 5h11l-2 3 2 3H6"/>') + " 已结束",
  })[s.state] || s.state;

  const modes = [
    { id: "orchestrate", label: fbSvg('<path d="M14 5l5 5"/><path d="M4 20l1-4L16 5l3 3L8 19z"/>') + " 编排", title: "你手选下一句由谁说(群聊视觉)" },
    { id: "relay", label: fbSvg('<path d="M4 12a8 8 0 0 1 13.7-5.7L20 8"/><path d="M20 4v4h-4"/><path d="M20 12a8 8 0 0 1-13.7 5.7L4 16"/><path d="M4 20v-4h4"/>') + " 接龙", title: "AI 轮流自动接龙(吐槽姬视觉)" },
    { id: "discuss", label: fbSvg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0"/><path d="M12 17v3"/>') + " 讨论", title: "围绕议题自由讨论(吐槽姬视觉)" },
  ];
  const chipsHtml = modes.map(m =>
    `<button class="chip-btn fishbowl-chip${m.id === mode ? " active" : ""}" data-fbmode="${m.id}" title="${safe(m.title)}">${m.label}</button>`
  ).join("");

  let statusHtml = "";
  if (mode === "relay" || mode === "discuss") {
    if (s.state === "ended" && s.endStats) {
      const e = s.endStats;
      statusHtml = `<div class="fb-side-ended"><div class="fb-ended-title">${fbSvg('<path d="M6 21V4"/><path d="M6 5h11l-2 3 2 3H6"/>')} 已结束</div><div class="fb-ended-line">共 <b>${e.totalRounds}</b> 轮，用时 <b>${e.durationSec}</b> 秒</div>${mode === "discuss" && e.topic ? `<div class="fb-ended-line">议题:${safe(e.topic)}</div>` : ""}<div class="fb-ended-reason">${endReasonLabel(e.endReason)}</div></div>`;
    } else {
      const round = (localStorage.getItem("cfw_dev_mode_v1") === "1") ? `${s.round || 0}（不限轮，开发者）` : `${s.round || 0}/${fb.getMaxRounds()}`;
      const topic = mode === "discuss" ? (fb.getTopic() || "(未设置)") : "";
      const speaker = s.speakerName || "—";
      // v4.9 累计花费提示(替代轮数硬限，让用户自行决定何时 stop)
      let costLine = "";
      try {
        if (window.__cost && window.__cost.getCostStats) {
          const cs = window.__cost.getCostStats();
          if (cs && cs.total > 0) {
            costLine = `<div class="fb-info-line" style="opacity:.85;">${fbSvg('<path d="M12 3v18"/><path d="M16 7H9.5a2.5 2.5 0 0 0 0 5h5a2.5 2.5 0 0 1 0 5H7"/>', {size:12})} 今日 <b>¥${cs.today.toFixed(4)}</b>，累计 <b>¥${cs.total.toFixed(4)}</b></div>`;
          }
        }
      } catch (e) {}
      statusHtml = `<div class="fb-side-status"><div class="fb-state-line">${stateLabel}</div><div class="fb-info-line">轮次 <b>${round}</b></div>${topic ? `<div class="fb-info-line">议题:${safe(topic)}</div>` : ""}<div class="fb-info-line">当前:<b>${safe(speaker)}</b></div>${costLine}</div>`;
    }
  }

  const btns = [];
  if (mode === "relay" || mode === "discuss") {
    const _play = fbSvg('<path d="M8 6l9 6-9 6z" fill="currentColor" stroke="none"/>', {size:12});
    const _pause = fbSvg('<rect x="7" y="5" width="3.4" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="13.6" y="5" width="3.4" height="14" rx="1" fill="currentColor" stroke="none"/>', {size:12});
    const _stop = fbSvg('<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>', {size:12});
    const _edit = fbSvg('<path d="M14 5l5 5"/><path d="M4 20l1-4L16 5l3 3L8 19z"/>', {size:12});
    const _spark = fbSvg('<path d="M12 3l1.6 5.4L19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6z" fill="currentColor" stroke="none"/>', {size:12});
    const _close = fbSvg('<path d="M6 6l12 12M18 6L6 18"/>', {size:12});
    if (s.state === "idle") btns.push(`<button class="chip-btn fb-cmd-btn fb-primary" data-fbcmd="start">${_play} 启动</button>`);
    if (s.state === "running") btns.push(`<button class="chip-btn fb-cmd-btn" data-fbcmd="pause">${_pause} 暂停</button>`);
    if (s.state === "paused") btns.push(`<button class="chip-btn fb-cmd-btn" data-fbcmd="resume">${_play} 继续</button>`);
    if (s.state === "running" || s.state === "paused") btns.push(`<button class="chip-btn fb-cmd-btn" data-fbcmd="stop">${_stop} 终止</button>`);
    if (mode === "discuss" && s.state !== "ended") btns.push(`<button class="chip-btn fb-cmd-btn" data-fbcmd="topic">${_edit} 改议题</button>`);
    if (s.state === "ended") {
      btns.push(`<button class="chip-btn fb-cmd-btn fb-primary" data-fbcmd="restart">${_spark} 新一轮</button>`);
      btns.push(`<button class="chip-btn fb-cmd-btn" data-fbcmd="close">${_close} 关闭</button>`);
    }
  }

  // 4.42-fix (#6 编排模式叫人叫不出来): 编排(orchestrate)模式引擎不驱动,
  // 原靠输入框上方 scene-strip 点角色 chip 触发发言,但 strip 已在 4.18 删成 dead code,
  // 角色面板 roster 点击只 setActive 不发言 → 没有任何 UI 能让选中角色"说下一句"。
  // 在群聊控制台补一排"点谁谁说下一句"的发言者按钮(仅 orchestrate 模式)。
  let orchestrateHtml = "";
  if (mode === "orchestrate") {
    const roster = getSceneCards();
    const activeId = ((window.__character && window.__character.getActiveCard && window.__character.getActiveCard()) || {}).id || "";
    orchestrateHtml = `<div class="fb-side-status"><div class="fb-info-line">点角色让 TA 说下一句:</div><div class="fb-side-roster" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;">` +
      roster.map(c => `<button class="chip-btn fb-orch-speaker${c.id === activeId ? " active" : ""}" data-fborch="${safe(c.id)}"><span>${safe(c.icon || "\u{1F642}")}</span> ${safe(c.name)}</button>`).join("") +
      `</div></div>`;
  }

  // 2026-10-08 多智能体独立上下文：把"当前口径 + 计入条数"显示出来 —— 每个角色吃自己的
  // 上下文（旧消息不算场景键），不显示的话"上下文变短"看起来像 bug。
  let ctxHtml = "";
  try {
    const info = (window.__app && window.__app.getContextInfo) ? window.__app.getContextInfo() : null;
    if (info) {
      const who = info.speaker ? ("「" + safe(info.speaker) + "」") : "";
      ctxHtml = `<div class="fb-side-ctx" style="font-size:11px;opacity:.72;padding:2px 2px 6px;">上下文：${safe(info.label)}${who}，计入 ${info.included} 条 / 共 ${info.total} 条</div>`;
    }
  } catch (e) {}

  panel.innerHTML = `<div class="fb-side-header">${fbSvg('<path d="M4 5.5h13a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H9l-4 3v-3H4A1.5 1.5 0 0 1 2.5 14V7A1.5 1.5 0 0 1 4 5.5z"/><circle cx="7.5" cy="10.5" r="1" fill="currentColor" stroke="none"/><circle cx="10.8" cy="10.5" r="1" fill="currentColor" stroke="none"/><circle cx="14.1" cy="10.5" r="1" fill="currentColor" stroke="none"/>', {size:15})} 群聊控制台</div>${ctxHtml}<div class="fb-side-modes">${chipsHtml}</div>${orchestrateHtml}${statusHtml}${btns.length ? `<div class="fb-side-actions">${btns.join("")}</div>` : ""}`;

  panel.querySelectorAll("[data-fbmode]").forEach(el => {
    el.addEventListener("click", () => handleFbModeChip(el.dataset.fbmode));
  });
  panel.querySelectorAll("[data-fbcmd]").forEach(el => {
    el.addEventListener("click", () => handleFbCmd(el.dataset.fbcmd));
  });
  // 编排模式发言者按钮:切到该角色并让 TA 立即说下一句(显式 asCard,避免 setActiveId race)
  // 4.43: 点完后触发一次自发接力链(交棒/随机插嘴),让群聊自己延续下去。
  panel.querySelectorAll("[data-fborch]").forEach(el => {
    el.addEventListener("click", async () => {
      const id = el.dataset.fborch;
      const card = getSceneCards().find(c => c.id === id);
      if (!card) return;
      if (window.__character && window.__character.setActiveId) window.__character.setActiveId(id);
      if (window.__app && window.__app.sendOne) {
        const reply = await window.__app.sendOne({ allowEmptyText: true, asCard: card });
        if (window.__app.continueGroupChat) { try { await window.__app.continueGroupChat(reply, card); } catch (e) {} }
      }
    });
  });

  if (window.__app && window.__app.updateSpacer) window.__app.updateSpacer();
}

// 2026-10-08（分层按钮 + 多智能体编排）：Agent 模式下的「平级名单」—— 多智能体模式开着时，
// 列出场景角色（可被私下咨询 / 可被请上台）与各自的单聊上下文条数，让"独立上下文"可见。
// 容器由 index.html 的 mountAgentPanel 在活动面板顶部预留（#__agentPeers）。
function renderAgentPeers() {
  const box = document.getElementById("__agentPeers");
  if (!box) return;
  if (!isMulti() || getSceneIds().length < 2) { box.innerHTML = ""; box.style.display = "none"; return; }
  box.style.display = "";
  const safe = window.__ownEscape.esc;
  const cards = getSceneCards();
  let info = null;
  try { info = (window.__app && window.__app.getContextInfo) ? window.__app.getContextInfo() : null; } catch (e) {}
  const rows = cards.map((c) => {
    let n = null;
    try { n = (window.__app && window.__app.getRoleContextCount) ? window.__app.getRoleContextCount(c) : null; } catch (e) {}
    return '<span class="chip-btn" title="' + safe(c.name) + (n != null ? ("（自己的单聊上下文 " + n + " 条）") : "") + '">'
      + safe(c.icon || "\u{1F642}") + " " + safe(c.name) + (n != null ? (" · " + n) : "") + "</span>";
  }).join("");
  box.innerHTML = '<div style="font-size:11px;opacity:.72;padding:0 2px 6px;">平级名单（可被私下咨询 / 可被请上台）'
    + (info ? ('，当前上下文计入 ' + info.included + "/" + info.total + " 条") : "")
    + '</div><div style="display:flex;flex-wrap:wrap;gap:6px;padding:0 2px 8px;">' + rows + "</div>";
}

function renderAll() {
  renderSceneStrip();
  renderFishbowlSidePanel();
  renderAgentPeers();
}

document.addEventListener("DOMContentLoaded", () => {
  wireTopbarToggle();
  // scene-strip + 鱼缸 UI 首次渲染延迟一点,等 app.js init() 把 .input-floating 准备好
  setTimeout(renderAll, 80);
  window.addEventListener("character:changed", renderAll);
  window.addEventListener("multi-agent:changed", renderAll);
  // 鱼缸引擎驱动事件:每条 AI 回复完 + 状态切换都刷新 UI
  // (4.82: 删掉 fishbowl:state 监听 —— fishbowl-engine 只派发 fishbowl:tick,该事件全项目无派发者)
  window.addEventListener("fishbowl:tick", renderAll);
  // 4.3:窗口尺寸变化重新挂载 fishbowl(桌面 slot ↔ 手机 body)
  let _resizeT = 0;
  window.addEventListener("resize", () => {
    if (_resizeT) clearTimeout(_resizeT);
    _resizeT = setTimeout(renderAll, 200);
  });
});
})();