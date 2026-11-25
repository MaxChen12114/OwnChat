// Browser adapter, appended by l0/emit.mjs. Engine: services/agent/fishbowl.ts (tag parsing, name
// matching, speaker selection, round limits, reaction delay); this file owns the run loop, the LS
// accessors, the tick event and the hostApi calls.
//
// A standalone runtime state machine, deliberately separate from multi-agent.js (the UI layer). Three
// modes: orchestrate (the user picks speakers, the engine does not drive), relay (round-robin with no
// topic), discuss (topic-driven, N rounds).
//
// Public API: window.__fishbowl = { getMode, setMode, getTopic, setTopic, getMaxRounds,
// setMaxRounds, getStrategy, setStrategy, start, pause, resume, stop, resetEnded, getState, onTick,
// parseTags, MAX_PARTICIPANTS, MAX_ROUNDS_HARD } -- multi-agent.js is the main consumer.
// Event: window `fishbowl:tick`, detail = { state, mode, round, max, topic, strategy, speakerName,
// endStats }.
//
// Red line: modelled on the pond-discussion format without reusing its code; no RAG / spatial stacks.
(function () {
"use strict";
const LSMODE   = FISHBOWL_LS_MODE;    // "orchestrate" | "relay" | "discuss"
const LSTOPIC  = FISHBOWL_LS_TOPIC;   // topic (discuss only)
const LSMAX    = FISHBOWL_LS_MAX;     // default 8, hard cap 1000
const LSSTRAT  = FISHBOWL_LS_STRATEGY; // "round-robin" | "ai-pick"

const MAX_PARTICIPANTS = FISHBOWL_MAX_PARTICIPANTS;
const MAX_ROUNDS_HARD  = FISHBOWL_MAX_ROUNDS_HARD;
const DEFAULT_MAX      = FISHBOWL_DEFAULT_MAX_ROUNDS;
const MAX_RELAY_STREAK = FISHBOWL_MAX_RELAY_STREAK;
const TICK_SLEEP_MS    = FISHBOWL_TICK_SLEEP_MS;

// ── internal state ──
let state        = "idle"; // idle | running | paused | ended
let currentRound = 0;
let speakerIndex = 0;
let abortFlag    = false;
let lastSpeaker  = null;
let lastNextHint = null;
let relayStreak  = 0;   // consecutive AI-named relays; reset whenever round-robin fires
let listeners    = [];
// v3 keeps the ended card on screen (no more forced reset to orchestrate).
let endStats    = null; // { totalRounds, endReason, endedAt, durationSec, topic, mode }
let endReason   = null; // "max" | "end-tag" | "error" | null (inferred in the finally)
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

// ── LS accessors ──
// Default is relay: a group chat should talk by itself; orchestrate waits to be named.
function getMode() { return localStorage.getItem(LSMODE) || "relay"; }
function setMode(m) {
  if (!validMode(m)) return;
  localStorage.setItem(LSMODE, m); emit();
}
function getTopic() { return (localStorage.getItem(LSTOPIC) || "").trim(); }
function setTopic(t) { localStorage.setItem(LSTOPIC, typeof t === "string" ? t : ""); emit(); }
function getMaxRounds() { return storedMaxRounds(localStorage.getItem(LSMAX)); }
function setMaxRounds(n) {
  localStorage.setItem(LSMAX, String(clampMaxRounds(n))); emit();
}
function getStrategy() { return localStorage.getItem(LSSTRAT) || "round-robin"; }
function setStrategy(s) {
  if (!validStrategy(s)) return;
  localStorage.setItem(LSSTRAT, s); emit();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Humanized rhythm: after picking a speaker, hold a "typing" pause for a humanized duration (the
// app's pacing setting plus jitter) before generating — no machine-gun hand-offs.
function pacingOn() { return (localStorage.getItem("cfw_reply_pacing_v1") ?? "1") === "1"; }
function pacingBaseMs() { const n = parseInt(localStorage.getItem("cfw_reply_pacing_delay_v1") || "2200", 10); return isNaN(n) ? 2200 : Math.max(0, Math.min(15000, n)); }
async function reactionPause(speaker) {
  if (!pacingOn()) return;
  const delay = reactionDelayMs(pacingBaseMs(), Math.random()); // 0.7x-1.5x, like people differing
  let shown = false;
  try { if (window.hostApi.app && window.hostApi.app.showTyping) { window.hostApi.app.showTyping(speaker && speaker.name); shown = true; } } catch (e) {}
  await sleep(delay);
  if (shown) { try { window.hostApi.app.hideTyping(); } catch (e) {} }
}

 // Dev mode removes the round cap: run until [end] or a manual stop (experimental).
function devNoRoundCap() { return localStorage.getItem("cfw_dev_mode_v1") === "1"; }

// ── participants (cap 6) ──
function getParticipants() {
  const m = window.__multi;
  if (!m || !m.getSceneCards) return [];
  return m.getSceneCards().slice(0, MAX_PARTICIPANTS);
}

// ── speaker strategy ──
// AI-named relay works in both discuss and relay modes: requiring strategy === "ai-pick" was the
// "calling someone never worked" bug — that strategy has no UI, so [next:X] was always ignored.
function pickNext(parts) {
  if (!parts.length) return null;
  const r = pickSpeaker(getMode(), parts, lastNextHint, lastSpeaker, { speakerIndex: speakerIndex, relayStreak: relayStreak });
  if (r.hintUsed) lastNextHint = null; // a hint is consumed exactly once, hit or miss
  speakerIndex = r.speakerIndex;
  relayStreak = r.relayStreak;
  return r.speaker;
}




// ── the main loop, shared by start / resume ──
async function runLoop() {
  try {
    while (state === "running" && (devNoRoundCap() || currentRound < getMaxRounds()) && !abortFlag) {
      // The user interjection queue was removed (its producer was never wired, the queue stayed
      // empty); restore a flush call here if roast input ever lands.
      // 2. pick a speaker
      const speaker = pickNext(getParticipants());
      if (!speaker) break;
      lastSpeaker = speaker.name;
      // 3. sync the UI active card
      if (window.__character && window.__character.setActiveId) {
        window.__character.setActiveId(speaker.id);
      }
      emit();
      // 4.58: hold the typing pause before generating — machine-gun hand-offs read as fake and tangle.
      await reactionPause(speaker);
      if (abortFlag || state !== "running") break;
      // 4. trigger the AI reply (empty user message + fishbowl marker + the roaster's left/right split:
      // odd scene index sits right).
      let side = null;
      try {
        const sceneIds = (window.__multi && window.__multi.getSceneIds && window.__multi.getSceneIds()) || [];
        const idx = sceneIds.indexOf(speaker.id);
        if (idx >= 0 && idx % 2 === 1) side = "right";
      } catch (e) {}
      let reply = "";
      try {
        reply = await window.hostApi.app.sendOne({
          allowEmptyText: true,
          fishbowlMode: getMode(),
          topic: getMode() === "discuss" ? getTopic() : "",
          asCard: speaker,         // pass the card explicitly; setActiveId races otherwise
          side: side,
          asAgentId: speaker.id,
        });
      } catch (e) {
        console.warn("[fishbowl] sendOne failed:", e);
        break;
      }
      // 5. parse tags. The summon tag brings an off-scene character in and hands them the floor; it
      // wins over the next tag.
      const tags = parseTags(reply || "");
      if ((getMode() === "discuss" || getMode() === "relay") && tags.summon && window.__multi && window.__multi.summonByName) {
        try { const _sc = window.__multi.summonByName(tags.summon); if (_sc) lastNextHint = _sc.name; } catch (e) {}
      } else if ((getMode() === "discuss" || getMode() === "relay") && tags.next) {
        // relay/discuss both record [next:X] and hand it to pickNext.
        lastNextHint = tags.next;
      }
      if (tags.end) {
        console.log("[fishbowl] [end] tag detected, stopping early.");
        endReason = "end-tag";
        break;
      }
      currentRound++;
      emit();
      // 6. throttle: a breather so the user can follow who is speaking. The reaction pause already
      // handled pacing at the top of the round; this base pause only applies when pacing is off
      // (the wechat 200ms interleave experiment was reverted).
      if (state === "running" && (devNoRoundCap() || currentRound < getMaxRounds())) {
        await sleep(pacingOn() ? 0 : TICK_SLEEP_MS);
      }
    }
  } finally {
    if (state === "running") {
      // v3 keeps the ended card (no forced reset); stop() already set idle, so this branch is
      // natural-end only.
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

 // Clear the ended card and return to idle (the "new round" / close buttons in multi-agent).
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
  if (mode === "orchestrate") return; // orchestrate needs no engine driver
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
  // Restarting from ended: drop the old end card.
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
  if (window.hostApi.app && window.hostApi.app.abortCurrent) window.hostApi.app.abortCurrent();
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
  // Manual stop goes straight to idle, no ended card.
  abortFlag = true;
  state = "idle";
  endStats = null;
  if (window.hostApi.app && window.hostApi.app.abortCurrent) window.hostApi.app.abortCurrent();
  setMode("relay");
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
  getState, onTick, parseTags,
  MAX_PARTICIPANTS, MAX_ROUNDS_HARD,
};
})();