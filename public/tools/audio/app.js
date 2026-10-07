// public/audio/app.js
// 音频工作台 (/audio/) · window.__omniReader
// 选本地文本文件 → 切句 → 逐句 GPT-SoVITS 合成 → 顺序播放。复用 window.__omniTTS(tts.js)。
// 仅桌面 App 内可真正发声(依赖 __TAURI__ + 本地 9880);网页版降级为只读提示。
(function () {
  'use strict';
  if (window.__omniReader) return;

  var TTS = window.__omniTTS || null;
  var inApp = !!(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke);

  // 与 tts.js 共用的 LS key(同源 → 主站设置即此处设置)
  var LS = { ref: 'cfw_tts_ref_audio_v1', prompt: 'cfw_tts_prompt_text_v1', speed: 'cfw_tts_speed_v1', port: 'cfw_tts_port_v1' };
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function $(id) { return document.getElementById(id); }

  var state = { sentences: [], idx: 0, playing: false, paused: false, fileName: '', runId: 0 };

  // ───── toast ─────
  // 2026-09-14 UI第一轮:统一反馈组件代理 —— __feedback 在则转发,缺失回退 #toast 原实现
  var _toastT = null;
  function toast(msg) {
    if (window.__feedback && window.__feedback.toast) return window.__feedback.toast(msg, { ms: 2600 });
    var el = $('toast'); if (!el) return;
    el.textContent = msg; el.classList.add('show');
    clearTimeout(_toastT); _toastT = setTimeout(function () { el.classList.remove('show'); }, 2600);
  }
  function shortPath(p) { p = String(p || ''); var n = p.split(/[\\/]/).pop(); return n || p; }

  // ───── 文件读取 ─────
  async function pickAndRead() {
    if (!inApp) { toast('选择文件需要在桌面 App 内使用'); return; }
    var inv = window.__TAURI__.core.invoke;
    var name = '', content = null;
    // 首选:一步弹框 + 读取
    try {
      var r = await inv('import_text_file');
      if (r === null || r === undefined) return; // 用户取消
      if (typeof r === 'object') { name = r.name || ''; content = r.content != null ? String(r.content) : ''; }
    } catch (e) {
      // 回退:tts_pick_file 选路径 + read_text_file 读内容(旧版 .exe 未含 import_text_file 时)
      try {
        var p = await inv('tts_pick_file');
        if (!p) return;
        content = String(await inv('read_text_file', { path: p }) || '');
        name = shortPath(p);
      } catch (e2) {
        toast('读取文件失败(可能是旧版 .exe 未含 import_text_file / read_text_file 命令)');
        return;
      }
    }
    if (content == null) { toast('没有读到文件内容'); return; }
    loadText(content, name);
    if (!state.sentences.length) toast('文件里没有可朗读的文字');
  }

  // 文本 → 句数组(复用 tts.js 的清洗 + 切句;回退本地简易切句)
  function loadText(text, name) {
    var clean = (TTS && TTS.cleanForSpeech) ? TTS.cleanForSpeech(text) : String(text || '');
    var parts = (TTS && TTS.splitSentences) ? TTS.splitSentences(clean)
      : String(clean).replace(/\s*\|+\s*/g, '\n').split(/(?<=[。！？!?…\n])/);
    parts = parts.map(function (s) { return (s || '').trim(); }).filter(function (s) { return s && /[\u4e00-\u9fa5A-Za-z0-9]/.test(s); });
    stopAll();
    state.sentences = parts; state.idx = 0; state.fileName = name || '';
    var ti = $('textInput'); if (ti && text != null) ti.value = String(text);
    renderFile(); renderSentences(); renderProgress(); syncControls();
    if (parts.length) showSentences(); else showEditor();
  }

  // 编辑(可直接粘贴/输入) / 朗读(逐句列表) 两态切换
  function showEditor() {
    var ti = $('textInput'), sl = $('sentenceList');
    if (ti) ti.hidden = false;
    if (sl) sl.hidden = true;
    syncControls();
    if (ti) { try { ti.focus(); } catch (e) {} }
  }
  function showSentences() {
    var ti = $('textInput'), sl = $('sentenceList');
    if (ti) ti.hidden = true;
    if (sl) sl.hidden = false;
    syncControls();
  }
  // 一键清空:停播 + 清空输入框与句列表 → 回到空白编辑态
  function clearAll() {
    stopAll();
    state.sentences = []; state.idx = 0; state.fileName = '';
    var ti = $('textInput'); if (ti) ti.value = '';
    renderFile(); renderSentences(); renderProgress(); showEditor(); syncControls();
    toast('已清空');
  }

  // ───── 合成 + 播放 ─────
  function synthOne(i) {
    if (!TTS || !TTS.synthWith) return Promise.resolve(null);
    return TTS.synthWith({ text: state.sentences[i] }); // 不传 ref/prompt/speed → 回退 cfg() 默认单音色 + 语速
  }

  async function playFrom(i) {
    if (!inApp) { toast('朗读需要在桌面 App 内 + 已启动本地语音服务'); return; }
    if (!state.sentences.length) return;
    if (!lsGet(LS.ref, '')) { toast('请先设置参考音频(点「参考音频」选一段 .wav)'); return; }
    var myRun = ++state.runId;
    state.playing = true; state.paused = false; syncControls();
    for (state.idx = i; state.idx < state.sentences.length; state.idx++) {
      if (myRun !== state.runId) return;                 // 被新的播放/停止/跳转打断
      highlight(state.idx); renderProgress();
      var blob = null;
      try { blob = await synthOne(state.idx); } catch (e) { toast('合成失败:' + ((e && e.message) || e)); }
      if (myRun !== state.runId) return;
      if (blob) { try { await TTS.enqueuePlay(blob); } catch (e) {} }  // 空间音效由 enqueuePlay → playBlob 自动继承
      else { toast('该句合成为空,已跳过'); }
      if (myRun !== state.runId) return;
    }
    // 读完
    state.playing = false;
    state.idx = state.sentences.length ? state.sentences.length - 1 : 0;
    syncControls(); renderProgress();
  }

  function pause() {
    if (!state.playing) return;
    state.paused = true; state.playing = false; state.runId++; // 打断循环
    if (TTS && TTS.stop) TTS.stop();
    syncControls();
  }
  function stopAll() {
    state.playing = false; state.paused = false; state.runId++;
    if (TTS && TTS.stop) TTS.stop();
    state.idx = 0; highlight(-1); syncControls(); renderProgress();
  }
  function seekTo(i) {
    if (!state.sentences.length) return;
    i = Math.max(0, Math.min(state.sentences.length - 1, i));
    var wasPlaying = state.playing;
    state.runId++; if (TTS && TTS.stop) TTS.stop();
    state.idx = i; highlight(i); renderProgress();
    if (wasPlaying) playFrom(i); else { state.playing = false; syncControls(); }
  }
  function prev() { seekTo(state.idx - 1); }
  function next() { seekTo(state.idx + 1); }

  // ───── 渲染 ─────
  function renderFile() { var el = $('fileName'); if (el) el.textContent = state.fileName || '未选择文件'; }
  function renderSentences() {
    var box = $('sentenceList'); if (!box) return;
    if (!state.sentences.length) { box.innerHTML = ''; return; }
    var frag = document.createDocumentFragment();
    for (var i = 0; i < state.sentences.length; i++) {
      var row = document.createElement('div');
      row.className = 'sent'; row.setAttribute('data-i', i);
      var no = document.createElement('span'); no.className = 'sent-no'; no.textContent = (i + 1);
      var tx = document.createElement('span'); tx.className = 'sent-tx'; tx.textContent = state.sentences[i]; // textContent 防注入
      row.appendChild(no); row.appendChild(tx); frag.appendChild(row);
    }
    box.innerHTML = ''; box.appendChild(frag);
  }
  function highlight(i) {
    var box = $('sentenceList'); if (!box) return;
    var cur = box.querySelector('.sent.active'); if (cur) cur.classList.remove('active');
    if (i < 0) return;
    var t = box.querySelector('.sent[data-i="' + i + '"]');
    if (t) { t.classList.add('active'); try { t.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) {} }
  }
  function renderProgress() {
    var el = $('progressText'); if (!el) return;
    el.textContent = state.sentences.length ? ('第 ' + (state.idx + 1) + ' / ' + state.sentences.length + ' 句') : '—';
  }
  function setEnabled(el, on) { if (el) el.disabled = !on; }
  function syncControls() {
    var has = state.sentences.length > 0;
    var ti = $('textInput'); var editing = !!(ti && !ti.hidden);   // 编辑态:有输入区时也允许点 ▶(先切句再播)
    setEnabled($('playBtn'), (has || editing) && !state.playing);
    setEnabled($('exportAudioBtn'), (has || editing)); // 4.83: 导出音频与播放同门控
    setEnabled($('pauseBtn'), has && state.playing);
    setEnabled($('stopBtn'), has && (state.playing || state.paused || state.idx > 0));
    setEnabled($('prevBtn'), has);
    setEnabled($('nextBtn'), has);
    var pb = $('playBtn'); if (pb) pb.classList.toggle('is-on', state.playing);
  }

  // ───── ASR 语音转文字(4.83) ─────
  // 走 GPT-SoVITS api_v2 的 /asr 端点:需要音频在【本机磁盘】上的路径,
  // 因此用 Tauri tts_pick_file 拿路径 → GET /asr?audio_path=… → 文字填入编辑区。
  // 网页版/麦克风录音无法把字节交给该端点(缺二进制落盘命令),暂不支持。
  async function asrPick() {
    if (!inApp) { toast('音频转文字需要在桌面 App 内使用(依赖本机语音服务)'); return; }
    var inv = window.__TAURI__.core.invoke;
    var p = '';
    try { p = await inv('tts_pick_file'); } catch (e) { toast('打开文件选择器失败'); return; }
    if (!p) return;
    var port = lsGet(LS.port, '9880');
    toast('转写中…(时长取决于音频长度)');
    var text = '';
    try {
      // 先 GET(api_v2 标准形态),失败再试 POST JSON
      var r = await fetch('http://127.0.0.1:' + port + '/asr?audio_path=' + encodeURIComponent(p));
      if (!r.ok) {
        r = await fetch('http://127.0.0.1:' + port + '/asr', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audio_path: p })
        });
      }
      if (!r.ok) { toast('ASR 接口返回 ' + r.status + '(需要 GPT-SoVITS api_v2;旧版 api 没有 /asr 端点)'); return; }
      var j = await r.json().catch(function () { return null; });
      text = (j && (j.text || j.Text)) || (j && j.data && (j.data[0] || j.data.text)) || '';
      text = String(text || '').trim();
    } catch (e) { toast('转写失败:' + ((e && e.message) || e)); return; }
    if (!text) { toast('转写结果为空(该音频里可能没有可识别的人声)'); return; }
    var ti = $('textInput');
    if (ti && !ti.hidden) {
      ti.value = ti.value ? (ti.value + '\n' + text) : text;
      toast('已把转写文字填入编辑区(' + text.length + ' 字)');
    } else {
      loadText(text, '转写结果');
      toast('已载入转写文字(' + text.length + ' 字)');
    }
  }

  // ───── 导出(4.83):音频 .wav / 文本 .txt ─────
  function downloadBlob(blob, name) {
    var u = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = u; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(u); a.remove(); }, 150);
  }
  // 编辑态 = 合成整段文本(api_v2 会按 text_split_method 自动切);朗读态 = 导出当前句
  async function exportAudio() {
    if (!inApp) { toast('合成音频需要在桌面 App 内 + 已启动本地语音服务'); return; }
    if (!TTS || !TTS.synthWith) { toast('语音模块未就绪'); return; }
    var ti = $('textInput');
    var editing = ti && !ti.hidden;
    var text = editing ? (ti.value || '') : (state.sentences[state.idx] || state.sentences[0] || '');
    if (!text.trim()) { toast('没有可导出的文字'); return; }
    if (!lsGet(LS.ref, '')) { toast('请先设置参考音频(主站「语音」设置)'); return; }
    toast((editing ? '合成整篇导出中' : '合成当前句导出中') + '…(长文较慢)');
    try {
      var blob = await TTS.synthWith({ text: text });
      if (!blob) { toast('合成结果为空'); return; }
      downloadBlob(blob, '朗读导出-' + new Date().toISOString().slice(0, 10) + '.wav');
      toast('已导出 wav(' + Math.round(blob.size / 1024) + ' KB)');
    } catch (e) { toast('导出失败:' + ((e && e.message) || e)); }
  }
  function exportText() {
    var ti = $('textInput');
    var text = (ti && !ti.hidden) ? (ti.value || '')
      : state.sentences.map(function (s, i) { return (i + 1) + '. ' + s; }).join('\n');
    if (!text.trim()) { toast('没有可导出的文本'); return; }
    downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), (state.fileName || '朗读文本') + '.txt');
    toast('已导出 txt');
  }

  // ───── 语音设置 ─────
  async function refreshVoiceStatus() {
    var el = $('voiceStatus'); if (!el) return;
    var ref = lsGet(LS.ref, ''); var port = lsGet(LS.port, '9880');
    var bits = [];
    bits.push(ref ? ('音色 ✓ 主站设置 · ' + shortPath(ref)) : '未设音色(去主站「语音」设置选参考音频)');
    var bad = !ref;
    if (inApp && TTS && TTS.probeService) {
      var ok = false; try { ok = await TTS.probeService(); } catch (e) {}
      bits.push(ok ? ('服务在跑 · 端口 ' + port) : ('服务未启动 · 端口 ' + port));
      if (!ok) bad = true;
    } else if (!inApp) {
      bits.push('网页版 · 不发声');
    }
    el.textContent = bits.join(' · ');
    el.classList.toggle('warn', bad);
  }
  // ───── 初始化 ─────
  function bind() {
    var pick = $('pickBtn'); if (pick) pick.addEventListener('click', pickAndRead);
    var cb = $('clearBtn'); if (cb) cb.addEventListener('click', clearAll);
    var pb = $('playBtn'); if (pb) pb.addEventListener('click', function () {
      var ti = $('textInput');
      if (ti && !ti.hidden) {                         // 编辑态:先把输入框文字切句载入，再播
        var t = ti.value || '';
        if (!t.trim()) { toast('请先粘贴或输入要朗读的文字'); return; }
        loadText(t, '粘贴的文字');
        if (!state.sentences.length) { toast('没有可朗读的文字'); return; }
      }
      if (!state.playing) playFrom(state.idx || 0);
    });
    var pa = $('pauseBtn'); if (pa) pa.addEventListener('click', pause);
    var st = $('stopBtn'); if (st) st.addEventListener('click', stopAll);
    var pv = $('prevBtn'); if (pv) pv.addEventListener('click', prev);
    var nx = $('nextBtn'); if (nx) nx.addEventListener('click', next);
    var list = $('sentenceList');
    if (list) list.addEventListener('click', function (e) {
      var s = e.target.closest && e.target.closest('.sent');
      if (s) seekTo(parseInt(s.getAttribute('data-i'), 10) || 0);
    });
    var sp = $('speed'), spv = $('speedVal');
    if (sp) {
      var cur = parseFloat(lsGet(LS.speed, '1')); if (!(cur >= 0.5 && cur <= 2)) cur = 1;
      sp.value = cur; if (spv) spv.textContent = cur.toFixed(2).replace(/0$/, '') + '×';
      sp.addEventListener('input', function () {
        var v = parseFloat(sp.value) || 1; lsSet(LS.speed, String(v));
        if (spv) spv.textContent = v.toFixed(2).replace(/0$/, '') + '×';
      });
    }
    // 4.83: ASR / 导出
    var ab = $('asrBtn'); if (ab) ab.addEventListener('click', asrPick);
    var ea = $('exportAudioBtn'); if (ea) ea.addEventListener('click', exportAudio);
    var et = $('exportTextBtn'); if (et) et.addEventListener('click', exportText);
  }
  function boot() {
    if (!inApp) { var n = $('notice'); if (n) n.style.display = 'flex'; }
    bind(); renderFile(); renderSentences(); renderProgress(); syncControls(); refreshVoiceStatus(); showEditor();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.__omniReader = {
    loadText: loadText,
    play: function () { if (!state.playing) playFrom(state.idx || 0); },
    pause: pause, stop: stopAll, prev: prev, next: next, seekTo: seekTo,
    state: state
  };
})();