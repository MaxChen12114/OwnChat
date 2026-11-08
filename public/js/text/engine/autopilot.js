
(function () {
  'use strict';

  /* ----------------------------- LS keys ------------------------------- */
  const LS = {
    mode:    'cfw_autopilot_mode_v1',          // '' 关 | 'novel'(旧 'rp' 在 start() 里就地归一)
    auto:    'cfw_autopilot_auto_v1',          // 'half'(默认) | 'full'
    maxSeg:  'cfw_autopilot_max_segments_v1',  // 默认 12，硬顶 HARD_CAP
    gateTts: 'cfw_autopilot_gate_tts_v1',      // '1' = 读完一段再续
    address: 'cfw_address_mode_v1',            // dialogue|immersive|narration（人称唯一来源 · P）
    choices: 'cfw_choices_freq_v1',            // 'off' | 'fork'(默认) | 'every'
    pacing:  'cfw_reply_pacing_delay_v1',       // 复用鱼缸节拍，默认 2200ms
  };
  //   · arousal 弧线把「升温节奏」写成了客户端计数器,实测不如直接让模型自己推;
  //   · 主用途是写小说,rp 分支与 agent 互相抢驾驶权、徒增 bug 面。
  const HARD_CAP = 1000;        // 与鱼缸同款硬顶
  const DEFAULT_MAX_SEG = 12;

  /* ----------------------------- helpers ------------------------------- */
  const ls = (k, d = '') => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, String(v)); } catch (e) {} };
  const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = () => window.__app || null;

  /* ------------------------------ state -------------------------------- */
  const S = {
    state: 'idle',            // idle | running | paused | ended
    seg: 0,
    endReason: '',
    _abort: false,
    _resume: null,            // 半自动暂停时的 resolver
    _nextUserText: null,      // 用户点选项 / 续写时带入下一拍的文本
    _tickHandlers: [],
  };

  function emit() { S._tickHandlers.forEach((fn) => { try { fn(getState()); } catch (e) {} }); }
  function getState() {
    return {
      state: S.state, seg: S.seg, endReason: S.endReason,
      mode: ls(LS.mode), auto: ls(LS.auto, 'half'),
    };
  }

  /* ----------------------- 驱动权互斥（§10.8 · L） --------------------- */
  function whoElseDriving() {
    try {
      const fb = window.__fishbowl && window.__fishbowl.getState && window.__fishbowl.getState();
      if (fb && (fb.state === 'running' || fb.state === 'paused')) return 'fishbowl';
    } catch (e) {}
    // 2026-09-10 修复(agent 冲突的根源): 原来这两条都是 TODO —— AgentKernel 没导出 isRunning、
    // app().isSending 是闭包私有,于是两条探测永远返回 undefined,自驱就「看不见」agent 在跑、
    // 两个司机同时往同一个会话发消息。现在: 多探几个可能的标志位,都拿不到就退回 DOM 证据。
    try {
      const K = window.AgentKernel;
      if (K && ((K.isRunning && K.isRunning()) || K.running === true || K.state === 'running')) return 'agent-loop';
    } catch (e) {}
    // 拿不到 isSending 时,用「有气泡正在流式」当占线证据 —— 比原来直接放行可靠
    try { if (document.querySelector('#chat .row.ai[data-streaming="1"]')) return 'sending'; } catch (e) {}
    return null;
  }

  /* -- 2026-09-10 瘦身: arousal 弧线(loadArousal/saveArousal/arousalCap/advanceArousal/arousalPhase)
     与情绪白名单(emotionWhitelist)整块删除 —— 它们只服务已下线的 rp 分支。
     情绪标签协议本身与引擎无关（多情绪切换系统 2026-10-06 已删；标签的显示隐藏仍在 tts.js）。 -- */

  /* ------------------------ 导演提示词（追加层） ----------------------- */
  function addressContract() {
    switch (ls(LS.address, 'dialogue')) {
      case 'immersive': return '用第二人称直接对“你”说话，可含动作 / 心理 / 场景旁白，旁白用 *…* 或（…）包裹（朗读自动跳过）';
      case 'narration': return '用第三人称小说叙事推进剧情';
      default:          return '用第二人称直接对“你”说话，不写旁白、不写动作描写、不做第三人称叙述';
    }
  }
  function choicesRule() {
    const freq = ls(LS.choices, 'fork');
    if (freq === 'off') return '';
    if (freq === 'every') return '本段末尾追加 [选项] ①… ②…（2-4 条，每条一句走向）[/选项]';
    return '仅当出现 ≥2 个合理走向、需要我拍板方向时，本段末才追加 [选项]（2-4 条）[/选项]；连贯推进 / 高潮 / 动作中段不要给';
  }
  function buildDirectorPrompt(userText) {
    if (userText) return userText; // 用户点了某分支 / 半自动带入的续写文本
    const parts = [];
    // 2026-09-10 瘦身: 只剩 novel 一档 —— 写小说就是主用途,不再分 rp/novel 两套导演提示词。
    parts.push('继续推进剧情一拍，约 200-300 字，承接上文，不要收尾');
    parts.push(addressContract());
    const cr = choicesRule();
    if (cr) parts.push(cr);
    parts.push('剧情自然走到尽头时输出 [end]');
    return '（' + parts.join('；') + '）';
  }

  /* --------------------------- 单段生成 -------------------------------- */
  async function generateSegment(userText) {
    const a = app();
    if (!a || typeof a.sendOne !== 'function') throw new Error('window.__app.sendOne 不可用');
    // 程序驱动：传 text + allowEmptyText（与 sendOne / sendOneAgent 同形，已 live 确认）
    await a.sendOne({ text: buildDirectorPrompt(userText), allowEmptyText: true });
  }

  /* ----------------------- 等这段 TTS 读完 ----------------------------- */
  async function gateOnTts() {
    if (ls(LS.gateTts) !== '1') return;
    if (!window.__TAURI__) return;             // 仅 App 有本地 TTS
    const tts = window.__omniTTS;
    if (!tts) return;
    // tts.js 已暴露 whenIdle();下面的轮询仅作旧版本兜底
    if (typeof tts.whenIdle === 'function') { await tts.whenIdle(); return; }
    for (let i = 0; i < 600 && !S._abort; i++) {
      if (!tts.isPlaying || !tts.isPlaying()) break;
      await sleep(100);
    }
  }

  /* ------------------------- 读最后一条 AI 文本 ------------------------ */
  function lastAiText() {
    try {
      const els = document.querySelectorAll('#chat .row.ai .bubble.ai');
      const el = els[els.length - 1];
      return el ? (el.innerText || '') : '';
    } catch (e) { return ''; }
  }

  /* --------------- 半自动暂停：交 choices.js 渲染出口 ---------------- */
  // 对齐 choices.js 真实签名：
  //   parseChoices(text) → { clean, options:[{label] }
  //   renderChoices(options, { onPick(value,isMeta), metaActions, autoSend })
  function waitForResume() { return new Promise((resolve) => { S._resume = resolve; }); }
  function renderPauseExits() {
    let options = [];
    // 2026-09-10 修复(选项框最主要的 bug): choices.js 的 autoScan 已经把 [选项] 块从气泡里抹掉了,
    // 此处再 parseChoices(lastAiText()) 永远是空 —— 这就是半自动暂停时「只剩 继续/自己写、真选项全丢」的原因。
    // 现在优先取 choices.js 缓存的解析结果,拿不到再回落到实时解析。
    try {
      const c = window.__choices;
      options = (c && c.getLastOptions && c.getLastOptions()) || [];
      if (!options.length && c && c.parseChoices) options = (c.parseChoices(lastAiText()) || {}).options || [];
    } catch (e) {}
    if (!window.__choices || !window.__choices.renderChoices) return;
    try {
      window.__choices.renderChoices(options, {
        autoSend: false,               // 下一拍由本引擎决定，不直接走 #msg 发送
        metaActions: [
          { label: '▶ 继续', value: '__ap_continue__' },
          { label: '✍️ 自己写', value: '__compose__' }, // choices.js 内部聚焦 #msg（见底部「手动接管」）
        ],
        onPick: (value) => {
          if (value === '__ap_continue__') { resume(); return false; }
          resume({ userText: value });  // 选了某分支 → 作为下一拍导演输入带入
          return false;                 // 返回 false：阻止 choices.js 再发一遍
        },
      });
    } catch (e) {}
  }

  /* ------------------------------ 主循环 ------------------------------- */
  async function runLoop() {
    const maxSeg = clamp(num(ls(LS.maxSeg), DEFAULT_MAX_SEG), 1, HARD_CAP);
    while (!S._abort && S.state === 'running') {
      const userText = S._nextUserText; S._nextUserText = null;
      try { await generateSegment(userText); }
      catch (e) { S.endReason = 'error:' + (e && e.message ? e.message : e); break; }
      if (S._abort) break;

      await gateOnTts();
      if (S._abort) break;

      S.seg++;
      const text = lastAiText();
      if (/\[end\]/i.test(text)) { S.endReason = 'end-tag'; break; }
      if (S.seg >= maxSeg) { S.endReason = 'max-seg'; break; }
      // 2026-09-10 修复: 每拍复查驾驶权 —— 中途启动 agent / 鱼缸时自驱立刻让出方向盘,
      // 不再出现两个司机抢着往同一个会话发消息。
      const busy = whoElseDriving();
      if (busy && busy !== 'sending') { S.endReason = 'yield:' + busy; break; }

      emit();
      if (ls(LS.auto, 'half') === 'half') {
        S.state = 'paused';
        renderPauseExits();
        emit();
        await waitForResume();             // 等用户：继续 / 选项 / 打字
        if (S._abort) break;
        S.state = 'running';
        emit();
      } else {
        await sleep(num(ls(LS.pacing), 2200));   // 全自动：拟人节拍停顿
      }
    }
    if (!S.endReason && S._abort) S.endReason = 'aborted';
    S.state = 'ended';
    try { window.__choices && window.__choices.clearChoices && window.__choices.clearChoices(); } catch (e) {}
    emit();
  }

  /* ------------------------------- API --------------------------------- */
  function start(opts) {
    opts = opts || {};
    if (S.state === 'running' || S.state === 'paused') return { ok: false, reason: 'already-running' };
    if (opts.mode) lsSet(LS.mode, opts.mode);
    // 2026-09-10 瘦身: 旧 LS 里存的 'rp' 就地归一成 'novel',免得老设置把引擎卡在已不存在的模式上
    let mode = ls(LS.mode);
    if (mode === 'rp') { mode = 'novel'; lsSet(LS.mode, 'novel'); }
    if (!mode || mode === 'off') return { ok: false, reason: 'mode-off' };
    if (mode === 'work') return { ok: false, reason: 'work-uses-agent-loop' }; // 决策 Q

    const other = whoElseDriving();
    if (other) {
      if (other === 'fishbowl' && opts.autoStopOthers) { try { window.__fishbowl.stop(); } catch (e) {} }
      else return { ok: false, reason: 'busy:' + other }; // UI 据此提示「先停 X 再开自驱」
    }

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
  function takeover() { if (S.state !== 'idle' && S.state !== 'ended') stop('takeover'); } // 用户打字接管，自驱让出方向盘
  function stop(reason) {
    S._abort = true;
    S.endReason = S.endReason || reason || 'user-stop';
    if (S._resume) { const r = S._resume; S._resume = null; r(); }
    try { app() && app().abortCurrent && app().abortCurrent(true); } catch (e) {}
    try { window.__abortCurrent && window.__abortCurrent(); } catch (e) {}
    S.state = 'ended';
    try { window.__choices && window.__choices.clearChoices && window.__choices.clearChoices(); } catch (e) {}
    emit();
  }
  function setMode(mode) { lsSet(LS.mode, mode || ''); emit(); }
  function onTick(fn) { if (typeof fn === 'function') S._tickHandlers.push(fn); }

  /* ----------------------- Panic：Shift+Esc 全断 ----------------------- */
  function panic() {
    stop('panic');
    try { window.__omniTTS && window.__omniTTS.stop && window.__omniTTS.stop(); } catch (e) {}
    emit();
  }
  try {
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && e.shiftKey) { e.preventDefault(); panic(); }
    });
  } catch (e) {}

  window.__autopilot = { start, pause, resume, stop, takeover, getState, setMode, onTick, panic };
})();