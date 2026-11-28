(function () {
/**
 * Decision rules for the single-character narrative autopilot, with no DOM, timers or host calls.
 * The wiring owns localStorage, the send loop, TTS gating and the frozen global facade.
 *
 * Driver exclusivity is decided from a snapshot of the other engines rather than live globals:
 * a streaming bubble is this engine's own output in flight, so it MUST NOT yield the wheel.
 * @module services/agent/autopilot
 */

/** Storage keys; the wiring is the only reader and writer. */
const AUTOPILOT_LS = {
  mode: "cfw_autopilot_mode_v1",
  auto: "cfw_autopilot_auto_v1",
  maxSeg: "cfw_autopilot_max_segments_v1",
  gateTts: "cfw_autopilot_gate_tts_v1",
  address: "cfw_address_mode_v1",
  choices: "cfw_choices_freq_v1",
  pacing: "cfw_reply_pacing_delay_v1",
};

/** Segment cap mirrors the fishbowl engine; any stored value is clamped into [1, 1000]. */
const AUTOPILOT_HARD_CAP = 1000;
/** Default segment count when the stored value is missing or not a number. */
const AUTOPILOT_DEFAULT_MAX_SEG = 12;

/** Parse a stored integer; @returns the fallback when parseInt yields NaN. */
function apNum(v         , d        )         {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : d;
}

/** @returns n clamped to the closed interval [lo, hi]. */
function apClamp(n        , lo        , hi        )         {
  return Math.max(lo, Math.min(hi, n));
}

/** @returns the effective segment cap for a raw stored value. */
function apMaxSegments(raw         )         {
  return apClamp(apNum(raw, AUTOPILOT_DEFAULT_MAX_SEG), 1, AUTOPILOT_HARD_CAP);
}

/** A missing value means half-auto; an explicit empty string means full-auto. */
function apAuto(raw         )         {
  return raw == null ? "half" : String(raw);
}

/** @returns whether the loop pauses for a user decision after each segment. */
function apIsHalf(raw         )          {
  return apAuto(raw) === "half";
}

/** @returns the full-auto pacing delay in ms. */
function apPacingMs(raw         )         {
  return apNum(raw, 2200);
}

/** @returns whether the segment must wait for local TTS to finish. */
function apGateTts(raw         )          {
  return raw === "1";
}

/** Legacy "rp" is normalised on read; @returns the mode the loop acts on. */
function apModeOf(raw         )         {
  const mode = raw == null ? "" : String(raw);
  return mode === "rp" ? "novel" : mode;
}

/**
 * Start gate, in the original order: mode validity, then driver exclusivity. A running fishbowl
 * may be stopped only on an explicit request; every other driver is a hard refusal.
 * @returns the plan, including the mode value the wiring must persist for the legacy alias.
 */
function apStartPlan(
  rawMode         ,
  other               ,
  autoStopOthers         ,
  alreadyRunning         ,
)                                                                                            {
  const mode = apModeOf(rawMode);
  const persistMode = rawMode === "rp" ? "novel" : "";
  if (alreadyRunning) return { ok: false, reason: "already-running", mode, persistMode, stopFishbowl: false };
  if (!mode || mode === "off") return { ok: false, reason: "mode-off", mode, persistMode, stopFishbowl: false };
  if (mode === "work") return { ok: false, reason: "work-uses-agent-loop", mode, persistMode, stopFishbowl: false };
  if (other) {
    if (other === "fishbowl" && autoStopOthers) {
      return { ok: true, reason: "", mode, persistMode, stopFishbowl: true };
    }
    return { ok: false, reason: "busy:" + other, mode, persistMode, stopFishbowl: false };
  }
  return { ok: true, reason: "", mode, persistMode, stopFishbowl: false };
}

/** @returns the selected address mode; missing means the default dialogue mode. */
function apAddressOf(raw         )         {
  return raw == null ? "dialogue" : String(raw);
}

/** @returns the selected options frequency; missing means "only at forks". */
function apChoicesOf(raw         )         {
  return raw == null ? "fork" : String(raw);
}

/** @returns the address-mode instruction appended to the director prompt. */
function apAddressContract(raw         )         {
  const addr = apAddressOf(raw);
  switch (addr) {
    case "immersive": return "用第二人称直接对“你”说话，可含动作 / 心理 / 场景旁白，旁白用 *…* 或（…）包裹（朗读自动跳过）";
    case "narration": return "用第三人称小说叙事推进剧情";
    default: return "用第二人称直接对“你”说话，不写旁白、不写动作描写、不做第三人称叙述";
  }
}

/** @returns the [options] rule, or an empty string when options are disabled. */
function apChoicesRule(raw         )         {
  const freq = apChoicesOf(raw);
  if (freq === "off") return "";
  if (freq === "every") return "本段末尾追加 [选项] ①… ②…（2-4 条，每条一句走向）[/选项]";
  return "仅当出现 ≥2 个合理走向、需要我拍板方向时，本段末才追加 [选项]（2-4 条）[/选项]；连贯推进 / 高潮 / 动作中段不要给";
}

/**
 * @returns the director prompt. A user-authored continuation bypasses every appended rule;
 * the prompt text is user-facing Chinese and is intentionally kept verbatim.
 */
function apDirectorPrompt(userText        , address         , choices         )         {
  if (userText) return userText;
  const parts = ["继续推进剧情一拍，约 200-300 字，承接上文，不要收尾", apAddressContract(address)];
  const rule = apChoicesRule(choices);
  if (rule) parts.push(rule);
  parts.push("剧情自然走到尽头时输出 [end]");
  return "（" + parts.join("；") + "）";
}

/**
 * Exclusivity snapshot: fishbowl state wins over the agent loop, which wins over a streaming
 * bubble. The caller supplies the snapshot because reading globals is the wiring's job.
 */
function apOtherDriver(fbState        , kernelActive         , streaming         )                {
  if (fbState === "running" || fbState === "paused") return "fishbowl";
  if (kernelActive) return "agent-loop";
  if (streaming) return "sending";
  return null;
}

/** A streaming bubble is our own send in flight; yielding on it would stop the loop mid-turn. */
function apShouldYield(busy               )          {
  return !!busy && busy !== "sending";
}

/** @returns whether the generated segment closes the story. */
function apEndTag(text        )          {
  return /\[end\]/i.test(text);
}

/** @returns the final end reason; an abort only fills in a missing reason. */
function apWrapReason(reason        , aborted         )         {
  return reason || (aborted ? "aborted" : "");
}

// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/agent/autopilot.ts
// (mode gate, director prompt, exclusivity snapshot, caps and pacing); this file owns
// localStorage, the send loop, TTS gating, choice chips and the frozen global facade.
//
// Invariants: exactly one driver (fishbowl / agent loop / autopilot) may send at a time;
// a streaming bubble is our own output and must not yield the wheel; half-auto resumes
// through the choice panel, which must not auto-send the picked value.
(function () {
  'use strict';

  const LS = AUTOPILOT_LS;

  const ls = (k, d = '') => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, String(v)); } catch (e) {} };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = () => window.hostApi.app || null;

  const S = {
    state: 'idle',            // idle | running | paused | ended
    seg: 0,
    endReason: '',
    _abort: false,
    _resume: null,
    _nextUserText: null,
    _tickHandlers: [],
  };

  function emit() { S._tickHandlers.forEach((fn) => { try { fn(getState()); } catch (e) {} }); }
  function getState() {
    return {
      state: S.state, seg: S.seg, endReason: S.endReason,
      mode: ls(LS.mode), auto: ls(LS.auto, 'half'),
    };
  }

  function whoElseDriving() {
    let fbState = "";
    try {
      const fb = window.fishbowlSvc && window.fishbowlSvc.getState && window.fishbowlSvc.getState();
      if (fb && typeof fb.state === "string") fbState = fb.state;
    } catch (e) {}
    let kernelActive = false;
    try {
      const K = window.AgentKernel;
      if (K) kernelActive = !!((K.isRunning && K.isRunning()) || K.running === true || K.state === "running");
    } catch (e) {}
    let streaming = false;
    try { streaming = !!document.querySelector('#chat .row.ai[data-streaming="1"]'); } catch (e) {}
    return apOtherDriver(fbState, kernelActive, streaming);
  }

  async function generateSegment(userText) {
    const a = app();
    if (!a || typeof a.sendOne !== 'function') throw new Error('window.hostApi.app.sendOne 不可用');
    await a.sendOne({ text: apDirectorPrompt(userText, ls(LS.address, 'dialogue'), ls(LS.choices, 'fork')), allowEmptyText: true });
  }

  async function gateOnTts() {
    if (!apGateTts(ls(LS.gateTts))) return;
    if (!window.tauriSvc || !window.tauriSvc.has()) return;
    const tts = window.omniTtsSvc;
    if (!tts) return;
    if (typeof tts.whenIdle === 'function') { await tts.whenIdle(); return; }
    for (let i = 0; i < 600 && !S._abort; i++) {
      if (!tts.isPlaying || !tts.isPlaying()) break;
      await sleep(100);
    }
  }

  function lastAiText() {
    try {
      const els = document.querySelectorAll('#chat .row.ai .bubble.ai');
      const el = els[els.length - 1];
      return el ? (el.innerText || '') : '';
    } catch (e) { return ''; }
  }

  //   parseChoices(text) → { clean, options:[{label] }
  //   renderChoices(options, { onPick(value,isMeta), metaActions, autoSend })
  function waitForResume() { return new Promise((resolve) => { S._resume = resolve; }); }
  function renderPauseExits() {
    let options = [];
    try {
      const c = window.choicesSvc;
      options = (c && c.getLastOptions && c.getLastOptions()) || [];
      if (!options.length && c && c.parseChoices) options = (c.parseChoices(lastAiText()) || {}).options || [];
    } catch (e) {}
    if (!window.choicesSvc || !window.choicesSvc.renderChoices) return;
    try {
      window.choicesSvc.renderChoices(options, {
        autoSend: false,
        metaActions: [
          { label: '▶ 继续', value: '__ap_continue__' },
          { label: '✍️ 自己写', value: '__compose__' },
        ],
        onPick: (value) => {
          if (value === '__ap_continue__') { resume(); return false; }
          resume({ userText: value });
          return false;
        },
      });
    } catch (e) {}
  }

  async function runLoop() {
    const maxSeg = apMaxSegments(ls(LS.maxSeg));
    while (!S._abort && S.state === 'running') {
      const userText = S._nextUserText; S._nextUserText = null;
      try { await generateSegment(userText); }
      catch (e) { S.endReason = 'error:' + (e && e.message ? e.message : e); break; }
      if (S._abort) break;

      await gateOnTts();
      if (S._abort) break;

      S.seg++;
      const text = lastAiText();
      if (apEndTag(text)) { S.endReason = 'end-tag'; break; }
      if (S.seg >= maxSeg) { S.endReason = 'max-seg'; break; }
      const busy = whoElseDriving();
      if (apShouldYield(busy)) { S.endReason = 'yield:' + busy; break; }

      emit();
      if (apIsHalf(ls(LS.auto, 'half'))) {
        S.state = 'paused';
        renderPauseExits();
        emit();
        await waitForResume();
        if (S._abort) break;
        S.state = 'running';
        emit();
      } else {
        await sleep(apPacingMs(ls(LS.pacing)));
      }
    }
    S.endReason = apWrapReason(S.endReason, S._abort);
    S.state = 'ended';
    try { window.choicesSvc && window.choicesSvc.clearChoices && window.choicesSvc.clearChoices(); } catch (e) {}
    emit();
  }

  function start(opts) {
    opts = opts || {};
    const alreadyRunning = S.state === 'running' || S.state === 'paused';
    if (alreadyRunning) return { ok: false, reason: 'already-running' };
    if (opts.mode) lsSet(LS.mode, opts.mode);
    const plan = apStartPlan(ls(LS.mode), whoElseDriving(), !!opts.autoStopOthers, false);
    if (!plan.ok) return { ok: false, reason: plan.reason };
    if (plan.persistMode) lsSet(LS.mode, plan.persistMode);
    if (plan.stopFishbowl) { try { window.fishbowlSvc.stop(); } catch (e) {} }
    S._abort = false; S.seg = 0; S.endReason = ''; S._nextUserText = null;
    S.state = 'running';
    emit();
    runLoop();
    return { ok: true };
  }
  function pause() { if (S.state === 'running') { S.state = 'paused'; renderPauseExits(); emit(); } }
  function resume(opts) {
    opts = opts || {};
    if (S.state !== 'paused') return;
    S._nextUserText = opts.userText || null;
    if (S._resume) { const r = S._resume; S._resume = null; r(); }
    else { S.state = 'running'; emit(); runLoop(); }
  }
  function takeover() { if (S.state !== 'idle' && S.state !== 'ended') stop('takeover'); }
  function stop(reason) {
    S._abort = true;
    S.endReason = S.endReason || reason || 'user-stop';
    if (S._resume) { const r = S._resume; S._resume = null; r(); }
    try { app() && app().abortCurrent && app().abortCurrent(true); } catch (e) {}
    try { window.__abortCurrent && window.__abortCurrent(); } catch (e) {}
    S.state = 'ended';
    try { window.choicesSvc && window.choicesSvc.clearChoices && window.choicesSvc.clearChoices(); } catch (e) {}
    emit();
  }
  function setMode(mode) { lsSet(LS.mode, mode || ''); emit(); }
  function onTick(fn) { if (typeof fn === 'function') S._tickHandlers.push(fn); }

  function panic() {
    stop('panic');
    try { window.omniTtsSvc && window.omniTtsSvc.stop && window.omniTtsSvc.stop(); } catch (e) {}
    emit();
  }
  try {
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && e.shiftKey) { e.preventDefault(); panic(); }
    });
  } catch (e) {}

  // Settings-card bridge (non-frozen): the six keys and every default/clamp stay in the engine,
  // so the card cannot disagree with the loop about what "unset" means.
  window.autopilotCfg = {
    LS: LS,
    modeOf: apModeOf,
    autoOf: apAuto,
    addressOf: apAddressOf,
    choicesOf: apChoicesOf,
    maxSegments: apMaxSegments,
    gateTts: apGateTts,
    needsModeMigration: function (raw) { return raw === 'rp'; },
  };
  window.autopilotSvc = { start, pause, resume, stop, takeover, getState, setMode, onTick, panic };
})();

globalThis.AUTOPILOT_LS = AUTOPILOT_LS;
globalThis.AUTOPILOT_HARD_CAP = AUTOPILOT_HARD_CAP;
globalThis.AUTOPILOT_DEFAULT_MAX_SEG = AUTOPILOT_DEFAULT_MAX_SEG;
globalThis.apNum = apNum;
globalThis.apClamp = apClamp;
globalThis.apMaxSegments = apMaxSegments;
globalThis.apAuto = apAuto;
globalThis.apIsHalf = apIsHalf;
globalThis.apPacingMs = apPacingMs;
globalThis.apGateTts = apGateTts;
globalThis.apModeOf = apModeOf;
globalThis.apStartPlan = apStartPlan;
globalThis.apAddressOf = apAddressOf;
globalThis.apChoicesOf = apChoicesOf;
globalThis.apAddressContract = apAddressContract;
globalThis.apChoicesRule = apChoicesRule;
globalThis.apDirectorPrompt = apDirectorPrompt;
globalThis.apOtherDriver = apOtherDriver;
globalThis.apShouldYield = apShouldYield;
globalThis.apEndTag = apEndTag;
globalThis.apWrapReason = apWrapReason;
})();
