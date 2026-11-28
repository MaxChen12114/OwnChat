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