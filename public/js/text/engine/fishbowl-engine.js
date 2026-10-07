// public/js/text/engine/fishbowl-engine.js — 鱼缸讨论引擎（Phase 4 阶段 11）
// 独立 runtime 状态机；与 multi-agent.js（UI 层）职责分离
// 三种模式：
//   orchestrate（V1 用户手选发言者，引擎不驱动）
//   relay（无议题轮询 N 轮，纯 round-robin）
//   discuss（议题驱动 N 轮，发言者策略 round-robin / ai-pick）
// 暴露：window.__fishbowl.{ getMode, setMode, getTopic, setTopic, getMaxRounds, setMaxRounds,
//                          getStrategy, setStrategy, start, pause, resume, stop,
//                          insertUserMsg, getState, onTick, parseTags }
// 事件：window 'fishbowl:tick' detail = { state, mode, round, max, topic, strategy, speakerName }
// 依赖：window.__app.{ sendOne, abortCurrent, injectModeratorMsg } / window.__multi / window.__character
// 红线：借鉴洪都鱼缸范式但不复用洪都代码；不引入 RAG/议多/spatial 科研栈
(function () {
"use strict";
const LSMODE   = "cfw_fishbowl_mode_v1";    // "orchestrate" | "relay" | "discuss"
const LSTOPIC  = "cfw_fishbowl_topic_v1";   // 讨论议题（仅 discuss 模式）
const LSMAX    = "cfw_fishbowl_max_rounds_v1"; // 默认 8，硬上限 1000
const LSSTRAT  = "cfw_fishbowl_strategy_v1"; // "round-robin" | "ai-pick"

const MAX_PARTICIPANTS = 6;
const MAX_ROUNDS_HARD  = 1000;  // v4.9 从 30 提到 1000：实质取消轮数限制，仅防意外离开爆资金
const DEFAULT_MAX      = 8;
const MAX_RELAY_STREAK = 5;     // v4.21 智能编排:连续 AI 指名接力上限,超出强制回轮询,防两人霸场
const TICK_SLEEP_MS    = 800;
const INSERT_DEBOUNCE  = 200;

// ── 内部状态 ──
let state        = "idle"; // idle | running | paused | ended
let currentRound = 0;
let speakerIndex = 0;
let pending      = [];
let pendingTimer = null;
let abortFlag    = false;
let lastSpeaker  = null;
let lastNextHint = null;
let relayStreak  = 0;   // v4.21 连续 AI 指名接力计数(命中轮询即清零)
let listeners    = [];
// 鱼缸 V3 · 结束态保留(不再 1.5s 强制回 orchestrate)
let endStats    = null; // { totalRounds, endReason, endedAt, durationSec, topic, mode }
let endReason   = null; // "max" | "end-tag" | "error" | null(将由 finally 推断)
let startedAt   = 0;

function emit() {
  const d = {
    state, mode: getMode(), round: currentRound, max: getMaxRounds(),
    topic: getTopic(), strategy: getStrategy(), speakerName: lastSpeaker,
    endStats,
  };
  window.dispatchEvent(new CustomEvent("fishbowl:tick", { detail: d }));
  listeners.forEach(fn => { try { fn(d); } catch (e) {} });
}

// ── LS 读写 ──
function getMode() { return localStorage.getItem(LSMODE) || "orchestrate"; }
function setMode(m) {
  if (!["orchestrate", "relay", "discuss"].includes(m)) return;
  localStorage.setItem(LSMODE, m); emit();
}
function getTopic() { return (localStorage.getItem(LSTOPIC) || "").trim(); }
function setTopic(t) { localStorage.setItem(LSTOPIC, typeof t === "string" ? t : ""); emit(); }
function getMaxRounds() {
  const n = parseInt(localStorage.getItem(LSMAX) || "", 10);
  if (isNaN(n) || n < 1) return DEFAULT_MAX;
  return Math.min(MAX_ROUNDS_HARD, Math.max(1, n));
}
function setMaxRounds(n) {
  const v = Math.min(MAX_ROUNDS_HARD, Math.max(1, parseInt(n, 10) || DEFAULT_MAX));
  localStorage.setItem(LSMAX, String(v)); emit();
}
function getStrategy() { return localStorage.getItem(LSSTRAT) || "round-robin"; }
function setStrategy(s) {
  if (!["round-robin", "ai-pick"].includes(s)) return;
  localStorage.setItem(LSSTRAT, s); emit();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 4.58 拟人节奏:多智能体接力时不要机关枪秒接 —— 选定发言者后先“正在输入”停顿一个拟人时长(读 app.js 的 pacing 设置 + 随机拖动)再真正生成
function pacingOn() { return (localStorage.getItem("cfw_reply_pacing_v1") ?? "1") === "1"; }
function pacingBaseMs() { const n = parseInt(localStorage.getItem("cfw_reply_pacing_delay_v1") || "2200", 10); return isNaN(n) ? 2200 : Math.max(0, Math.min(15000, n)); }
async function reactionPause(speaker) {
  if (!pacingOn()) return;
  const base = pacingBaseMs();
  const delay = Math.max(500, Math.round(base * (0.7 + Math.random() * 0.8))); // 0.7x–1.5x 拖动,像真人不同反应快慢
  let shown = false;
  try { if (window.__app && window.__app.showTyping) { window.__app.showTyping(speaker && speaker.name); shown = true; } } catch (e) {}
  await sleep(delay);
  if (shown) { try { window.__app.hideTyping(); } catch (e) {} }
}

// 4.52: 开发者模式取消轮数硬限——跑到 AI [end] 或手动 ⏹ 才停(实验功能,反馈好转正)
function devUnlimited() { return localStorage.getItem("cfw_dev_mode_v1") === "1"; }

// ── 参与者列表（去重 + 上限 6 人）──
function getParticipants() {
  const m = window.__multi;
  if (!m || !m.getSceneCards) return [];
  return m.getSceneCards().slice(0, MAX_PARTICIPANTS);
}

// ── 名字归一化匹配（v4.21 智能编排:精确命中 → 归一化 → 包含）──
function normName(s) {
  return String(s == null ? "" : s)
    .replace(/[【】\[\]（）()「」『』"'`’‘“”\s,，.。!！?？~～·\-—_]/g, "")
    .toLowerCase();
}
function matchByName(parts, hint) {
  if (!hint || !parts.length) return null;
  const raw = String(hint).trim();
  // 1. 精确命中
  let hit = parts.find(c => c.name === raw);
  if (hit) return hit;
  // 2. 归一化命中(去装饰符/标点/空白/大小写)
  const nh = normName(raw);
  if (!nh) return null;
  hit = parts.find(c => normName(c.name) === nh);
  if (hit) return hit;
  // 3. 包含命中(双向;两侧归一化名长度≥2,避免单字误伤)
  hit = parts.find(c => {
    const cn = normName(c.name);
    if (!cn || cn.length < 2 || nh.length < 2) return false;
    return cn.includes(nh) || nh.includes(cn);
  });
  return hit || null;
}

// ── 发言者策略 ──
// discuss + ai-pick:优先按上一发言者的 [next:X] 指名接力(精确名字命中),
// 连续接力 ≤ MAX_RELAY_STREAK 轮,超出/命中失败/指向自己 → 回退纯轮询(并清零接力计数)。
// relay / round-robin:始终纯轮询,不受指名影响(保持既有行为)。
function pickNext(parts) {
  if (!parts.length) return null;
  // 2026-05-30 / 4.25 修复「叫人叫不出来」: 接龙 + 讨论 两种模式都启用 AI 指名接力,
  // 不再要求 strategy === "ai-pick"(根本没有 UI 开它,导致 [next:X] 永远被忽略)。
  if ((getMode() === "discuss" || getMode() === "relay") && lastNextHint) {
    const hint = lastNextHint;
    lastNextHint = null;
    if (relayStreak < MAX_RELAY_STREAK) {
      const hit = matchByName(parts, hint);
      // 命中且不是上一位(避免同一人连说) → 采纳接力
      if (hit && hit.name !== lastSpeaker) {
        relayStreak++;
        const hi = parts.indexOf(hit);
        if (hi >= 0) speakerIndex = hi + 1; // 同步轮询游标到接力者下家
        return hit;
      }
      // 命中失败 / 指向自己 → 落入轮询
    }
    // 超出接力上限 → 强制轮询
  }
  // 纯轮询(AI 指名链断或不适用 → 清零接力计数)
  relayStreak = 0;
  const p = parts[speakerIndex % parts.length];
  speakerIndex++;
  return p;
}

// ── 标签解析：[next:X] / [next：X] / [end] ──
// 引擎只解析不剥离展示；剥离由 chat-ux.js 负责（与好感度 [好感±N] 同一套机制）
function parseTags(text) {
  const tags = { next: null, end: false, summon: null };
  if (typeof text !== "string") return tags;
  const m = text.match(/\[next[\:：]\s*([^\]\n]+?)\s*\]/);
  if (m) tags.next = m[1].trim();
  // 4.52 在场感 part2:[召唤:角色名] 把场景外角色叫进来
  const sm = text.match(/\[召唤[\:：]\s*([^\]\n]+?)\s*\]/);
  if (sm) tags.summon = sm[1].trim();
  if (/\[end\]/i.test(text)) tags.end = true;
  return tags;
}

// ── 用户插话队列（200ms 防抖合并）──
async function flushPending() {
  if (!pending.length) return;
  const merged = pending.join("\n").trim();
  pending = [];
  if (!merged) return;
  relayStreak = 0; // v4.21 用户介入 → 重置接力计数,下一段重新允许 ≤5 轮指名接力
  if (window.__app && window.__app.injectModeratorMsg) {
    try { await window.__app.injectModeratorMsg(merged); }
    catch (e) { console.warn("[fishbowl] injectModeratorMsg failed:", e); }
  }
}

function insertUserMsg(text) {
  if (typeof text !== "string" || !text.trim()) return;
  pending.push(text.trim());
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    if (state !== "running") flushPending();
  }, INSERT_DEBOUNCE);
}

// ── 主循环（start / resume 共用）──
async function runLoop() {
  try {
    while (state === "running" && (devUnlimited() || currentRound < getMaxRounds()) && !abortFlag) {
      // 1. flush 用户插话（让下一位 AI 看见）
      await flushPending();
      // 2. 选发言者
      const speaker = pickNext(getParticipants());
      if (!speaker) break;
      lastSpeaker = speaker.name;
      // 3. UI 同步 active card
      if (window.__character && window.__character.setActiveId) {
        window.__character.setActiveId(speaker.id);
      }
      emit();
      // 4.58 拟人反应延迟:选定发言者后先“正在输入”停顿再生成,避免多智能体机关枪式秒接(太快/不像真人/容易串)
      await reactionPause(speaker);
      if (abortFlag || state !== "running") break;
      // 4. 触发 AI 回复（空 user 消息 + 鱼缸模式标记 + 吐槽姬左右交替）
      // V3:吐槽姬 mode(relay|discuss) 下发言者在场景 sceneIds 中的 index 决定 side:偶左奇右
      let side = null;
      try {
        const sceneIds = (window.__multi && window.__multi.getSceneIds && window.__multi.getSceneIds()) || [];
        const idx = sceneIds.indexOf(speaker.id);
        if (idx >= 0 && idx % 2 === 1) side = "right";
      } catch (e) {}
      let reply = "";
      try {
        reply = await window.__app.sendOne({
          allowEmptyText: true,
          fishbowlMode: getMode(),
          topic: getMode() === "discuss" ? getTopic() : "",
          asCard: speaker,         // 显式传发言卡,避免 setActiveId race
          side,                    // 吐槽姬 mode 下决定气泡左/右
          asAgentId: speaker.id,   // 兼容旧字段
        });
      } catch (e) {
        console.warn("[fishbowl] sendOne failed:", e);
        break;
      }
      // 5. 解析标签
      const tags = parseTags(reply || "");
      // 4.52 在场感 part2:[召唤:X] 把场景外角色叫进来并让 TA 接下一句(优先于 [next:X])
      if ((getMode() === "discuss" || getMode() === "relay") && tags.summon && window.__multi && window.__multi.summonByName) {
        try { const _sc = window.__multi.summonByName(tags.summon); if (_sc) lastNextHint = _sc.name; } catch (e) {}
      } else if ((getMode() === "discuss" || getMode() === "relay") && tags.next) {
        // 4.25: relay/discuss 都记录 [next:X] 指名,交给 pickNext 接力
        lastNextHint = tags.next;
      }
      if (tags.end) {
        console.log("[fishbowl] [end] tag detected, stopping early.");
        endReason = "end-tag";
        break;
      }
      currentRound++;
      emit();
      // 6. 节流（给用户喘息 + 看清当前发言）
      // 4.19 P0.5: wechat 风格下 tick 缩到 200ms,配合 sendOne 早 yield 实现 AB 气泡交错
      // 原理:wechat+fishbowl A 返回后 A 的 tail piece 2 仍在 800ms 后台推,
      // tick 调小 → B 立刻开始 streaming → B 的 typing/首条与 A 的 tail piece 重叠出现 → 插话感
      // 4.58: 拟人反应延迟已在每轮开头 reactionPause 处理(pacing 开时);这里只在 pacing 关时保留基础停顿。
      // 原 wechat 200ms 是为 AB 气泡交错(已回退),不再使用 → 避免多智能体秒接显得太快。
      if (state === "running" && (devUnlimited() || currentRound < getMaxRounds())) {
        await sleep(pacingOn() ? 0 : TICK_SLEEP_MS);
      }
    }
  } finally {
    if (state === "running") {
      // 鱼缸 V3:进 ended 状态保留卡片,不再 1.5s 强制 reset
      // (stop() 手动终止时已把 state 改 idle,这里不会进)
      state = "ended";
      endStats = {
        totalRounds: currentRound,
        endReason: endReason || (currentRound >= getMaxRounds() ? "max" : "error"),
        endedAt: Date.now(),
        durationSec: Math.max(1, Math.round((Date.now() - startedAt) / 1000)),
        topic: getTopic(),
        mode: getMode(),
      };
      endReason = null;
    }
    abortFlag = false;
    emit();
  }
}

// 鱼缸 V3:清空 ended 状态卡,回到 idle 准备下一轮(给 multi-agent 的「✨ 新一轮」/「× 关闭」按钮用)
function resetEnded() {
  if (state !== "ended") return;
  state = "idle";
  endStats = null;
  currentRound = 0;
  speakerIndex = 0;
  lastSpeaker = null;
  lastNextHint = null;
  relayStreak = 0;
  emit();
}

async function start() {
  const mode = getMode();
  if (mode === "orchestrate") return; // 编排模式不需要引擎驱动
  const parts = getParticipants();
  if (parts.length < 2) {
    alert("场上至少需要 2 个角色才能开始群聊。\n请先在 🎭 角色面板里把多张卡加到场景。");
    return;
  }
  if (mode === "discuss" && !getTopic()) {
    alert("讨论模式需要先设定议题。");
    return;
  }
  if (state === "running") return;
  // 若从 ended 重启,先清空旧结束态
  if (state === "ended") { endStats = null; }
  state = "running";
  abortFlag = false;
  currentRound = 0;
  speakerIndex = 0;
  lastNextHint = null;
  relayStreak = 0;
  startedAt = Date.now();
  emit();
  await runLoop();
}

function pause() {
  if (state !== "running") return;
  state = "paused";
  abortFlag = true;
  if (window.__app && window.__app.abortCurrent) window.__app.abortCurrent();
  emit();
}

async function resume() {
  if (state !== "paused") return;
  state = "running";
  abortFlag = false;
  emit();
  await runLoop();
}

function stop() {
  // 手动 stop:state=idle 直接清场,不留 ended 状态卡
  abortFlag = true;
  state = "idle";
  endStats = null;
  pending = [];
  if (window.__app && window.__app.abortCurrent) window.__app.abortCurrent();
  setMode("orchestrate");
  emit();
}

function getState() {
  return {
    state, mode: getMode(), round: currentRound, max: getMaxRounds(),
    topic: getTopic(), strategy: getStrategy(), speakerName: lastSpeaker,
    endStats,
  };
}

function onTick(fn) {
  if (typeof fn === "function") listeners.push(fn);
  return () => { listeners = listeners.filter(x => x !== fn); };
}

window.__fishbowl = {
  getMode, setMode,
  getTopic, setTopic,
  getMaxRounds, setMaxRounds,
  getStrategy, setStrategy,
  start, pause, resume, stop, resetEnded,
  insertUserMsg, getState, onTick, parseTags,
  MAX_PARTICIPANTS, MAX_ROUNDS_HARD,
};
})();