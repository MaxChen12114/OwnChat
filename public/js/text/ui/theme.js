// public/js/text/ui/theme.js — 主题系统（多维度、事件驱动、未来扩展友好）
//
// 设计原则：
//   1. 多维度正交：style / scheme / accent 三个独立维度，未来还可加 font/density 等
//   2. 事件订阅：所有消费者通过 'theme:changed' 事件统一接收变更，不直接读 LS
//   3. 单一收口：set(patch) 是唯一写入路径，保证 LS / DOM / Settings UI / 订阅者同步
//   4. 可扩展：加新风格只需在 STYLES 加一项 + 写对应 [data-theme="xxx"] CSS
//
// 维度（v1 实现 + 占位）：
//   style:  "minimal" | "glass" | "candle"   — 写 [data-theme]（minimal 为默认，不写属性）
//   scheme: "dark"    | "light"   — 读写均已收口（set({scheme})，消费者读 my-theme / data-scheme）
//   accent: 字符串               — v1 占位（保留 LS）
//
// API：
//   __theme.get()                     → { style, scheme, accent }
//   __theme.set(patch)                → 增量更新（任意子集），触发 'theme:changed'
//   __theme.is("light" | "dark")      → 给散落消费者一个稳定快捷判断
//   __theme.styles()                  → ["minimal", "glass", ...] 未来扩展只改 STYLES
//   __theme.subscribe(fn)             → 返回 unsubscribe；fn(detail) 收到 { style, scheme, accent }
//   __ambient.*                       → 氛围音双轨混音器（环境 × 音乐，见文件内 API 注释块）
//
// 事件：window 'theme:changed' detail = { style, scheme, accent }
//       window 'ambient:changed' detail = { enabled, playing, amb:{id,vol}, mus:{id,vol} }
//
// LS keys：
//   cfw_theme_v1          ← style
//   my-theme              ← scheme（legacy 名称保留，避免散落消费者炸）
//   cfw_theme_accent_v1   ← accent（占位）
//   cfw_audio_enabled_v1  ← 氛围音总开关
//   cfw_ambient_amb_v1    ← 环境轨 { id, vol }（JSON）
//   cfw_ambient_mus_v1    ← 音乐轨 { id, vol }（JSON）
//
// 注意：minimal/glass 的 FOUC 防闪烁仍由 index.html <head> 内联 inline script 完成；
// 本文件加载后会幂等再应用一次。
(function () {
"use strict";

// 未来扩展只改这里：加新风格 ID + 在 styles.css 加 [data-theme="xxx"] 规则即可
const STYLES = ["minimal", "glass", "candle"];

const LS_STYLE     = "cfw_theme_v1";
const LS_SCHEME    = "my-theme";
const LS_ACCENT    = "cfw_theme_accent_v1";
const LS_AUDIO_ON  = "cfw_audio_enabled_v1";
const LS_AUDIO_VOL = "cfw_audio_volume_v1"; // legacy 单轨音量 —— 仅作 amb 轨初始值迁移来源
const LS_AMB       = "cfw_ambient_amb_v1";  // JSON { id, vol } 环境轨
const LS_MUS       = "cfw_ambient_mus_v1";  // JSON { id, vol } 音乐轨

// ═══ 氛围音轨注册表（全部 CC0，逐条来源见 /assets/ambient/CREDITS.txt）═══
// 格式: [id, 显示名, 文件名]。环境层含 2 条「轻息」气息垫 —— Agent 标签 [[voice:]] 是它们的别名。
const AMB_TRACKS = [
  ["amb-rain-1", "雨打窗 I", "amb-rain-1.mp3"],
  ["amb-rain-2", "雨打窗 II", "amb-rain-2.mp3"],
  ["amb-city-1", "城市夜 I", "amb-city-1.mp3"],
  ["amb-city-2", "城市夜 II", "amb-city-2.mp3"],
  ["amb-cafe-1", "咖啡馆 I", "amb-cafe-1.mp3"],
  ["amb-cafe-2", "咖啡馆 II", "amb-cafe-2.mp3"],
  ["amb-hearthfire", "炉火", "amb-hearthfire.mp3"],
  ["amb-wind-1", "夜风 I", "amb-wind-1.mp3"],
  ["amb-wind-2", "夜风 II", "amb-wind-2.mp3"],
  ["amb-tavern-1", "酒馆低语 I", "amb-tavern-1.mp3"],
  ["amb-tavern-2", "酒馆低语 II", "amb-tavern-2.mp3"],
  ["amb-forest-1", "森林夜 I", "amb-forest-1.mp3"],
  ["amb-forest-2", "森林夜 II", "amb-forest-2.mp3"],
  ["amb-frogs-1", "蛙鸣 I", "amb-frogs-1.mp3"],
  ["amb-frogs-2", "蛙鸣 II", "amb-frogs-2.mp3"],
  ["amb-clock-1", "挂钟 I", "amb-clock-1.mp3"],
  ["amb-clock-2", "挂钟 II", "amb-clock-2.mp3"],
  ["amb-pendulum-1", "钟摆 I", "amb-pendulum-1.mp3"],
  ["amb-pendulum-2", "钟摆 II", "amb-pendulum-2.mp3"],
  // 2026-10-06: 换回最早那个内置呼吸垫(11s 低采样率循环,原 /assets/lewd-ambient.mp3)。
  // 后找的两条「轻息」(freesound 慢呼吸)实测效果不好,已移除;呼吸轨就留这一条。
  ["voice-breath", "呼吸", "voice-breath.mp3"],
];
const MUS_TRACKS = [
  ["mus-piano-summernight", "夏夜钢琴", "mus-piano-summernight.mp3"],
  ["mus-late-piano", "深夜钢琴", "mus-late-piano.mp3"],
  ["mus-piano-cinematic", "电影感钢琴", "mus-piano-cinematic.mp3"],
  ["mus-piano-emotional1", "情绪钢琴 I", "mus-piano-emotional1.mp3"],
  ["mus-piano-emotional3", "情绪钢琴 II", "mus-piano-emotional3.mp3"],
  ["mus-piano-emotional5", "情绪钢琴 III", "mus-piano-emotional5.mp3"],
  ["mus-guitar-reverb", "混响吉他", "mus-guitar-reverb.mp3"],
  ["mus-lofi-1", "Lo-fi I", "mus-lofi-1.mp3"],
  ["mus-lofi-2", "Lo-fi II", "mus-lofi-2.mp3"],
];
const TRACKS = { amb: AMB_TRACKS, mus: MUS_TRACKS };
const VOICE_DEFAULT = "voice-breath"; // [[voice:]] 不带 id 时的默认呼吸垫
function findTrack(deck, id) {
  return (TRACKS[deck] || []).find((t) => t[0] === id) || null;
}
function trackLabel(deck, id) {
  const t = findTrack(deck, id);
  return t ? t[1] : "";
}

// ─── 聊天背景图（2026-10-06 从编辑器「UI 配置」页搬到设置·外观）───
// 读 cfw_ui_overrides_v1.bg（URL 或 __local__ 标记）+ cfw_ui_assets_v1.bgData（本机上传的 base64）。
// 位置在 #ue-bg-layer（position:fixed;z-index:-1 的负层）—— 必须同时把 html/body 底色置透明，
// 否则实色底会盖在负层之上（CSS 绘制顺序：根背景 → 负 z-index 层 → 普通流盒背景），背景图完全看不见。
// 改 cfw_ui_overrides_v1.bg 之后调一次 __theme.applyBg() 即可生效。
function bgConf() {
  let o = {};
  try { o = JSON.parse(localStorage.getItem("cfw_ui_overrides_v1") || "{}") || {}; } catch (e) { o = {}; }
  return (o && o.bg) || {};
}
function bgBaseClear(on) {
  const st = document.getElementById("ueBgBaseClear");
  if (!on) { if (st && st.parentNode) st.parentNode.removeChild(st); return; }
  if (!st) { const el = document.createElement("style"); el.id = "ueBgBaseClear"; document.head.appendChild(el); }
  document.getElementById("ueBgBaseClear").textContent = "html, body { background-color: transparent !important; }";
}
function applyBg() {
  try {
    const bg = bgConf();
    let src = "";
    if (bg.src === "__local__") {
      let as = {}; try { as = JSON.parse(localStorage.getItem("cfw_ui_assets_v1") || "{}") || {}; } catch (e) { as = {}; }
      src = as.bgData || "";
    } else if (bg.src) src = bg.src;
    let layer = document.getElementById("ue-bg-layer");
    if (!src) { if (layer && layer.parentNode) layer.parentNode.removeChild(layer); bgBaseClear(false); return; }
    if (!layer) {
      layer = document.createElement("div");
      layer.id = "ue-bg-layer";
      layer.style.cssText = "position:fixed;inset:0;z-index:-1;pointer-events:none;background-size:cover;background-position:center;background-repeat:no-repeat;";
      document.body.appendChild(layer);
    }
    layer.style.backgroundImage = 'url("' + String(src) + '")';
    const op = (bg.opacity != null && bg.opacity !== "") ? (parseInt(bg.opacity, 10) / 100) : 1;
    layer.style.opacity = String(isFinite(op) ? op : 1);
    const blur = (bg.blur != null && bg.blur !== "") ? parseInt(bg.blur, 10) : 0;
    layer.style.filter = blur ? ("blur(" + blur + "px)") : "";
    // 2026-10-06: 位置可调 —— bg.posX / bg.posY 为 0-100 百分比(缺省 50/50 居中),
    // 图片本身按 cover 铺满,挪位置即换露出的区域(上下左右都能挪)
    let px = (bg.posX != null && bg.posX !== "") ? parseInt(bg.posX, 10) : 50;
    let py = (bg.posY != null && bg.posY !== "") ? parseInt(bg.posY, 10) : 50;
    if (!isFinite(px)) px = 50;
    if (!isFinite(py)) py = 50;
    layer.style.backgroundPosition = Math.max(0, Math.min(100, px)) + "% " + Math.max(0, Math.min(100, py)) + "%";
    bgBaseClear(true);
  } catch (e) {}
}

const getStyle  = () => {
  const v = localStorage.getItem(LS_STYLE);
  return STYLES.includes(v) ? v : "minimal";
};
// 各主题的「原生」明暗:未显式选择 scheme 时跟随各自气质
const NATIVE_SCHEME = { "minimal": "dark", "glass": "light", "candle": "dark" };
// v1 已接入明暗双态的主题(逐步扩展;UI 仅对这些主题显示日/夜切换)
const SCHEME_READY = new Set(["minimal"]);
const getStoredScheme = () => {
  const v = localStorage.getItem(LS_SCHEME);
  return v === "light" || v === "dark" ? v : null;
};
// 有效 scheme = 显式选择 > 当前主题原生
const getScheme = () => getStoredScheme() || NATIVE_SCHEME[getStyle()] || "dark";
const getAccent = () => localStorage.getItem(LS_ACCENT) || "default";
const getAll    = () => ({ style: getStyle(), scheme: getScheme(), accent: getAccent() });

const getAudioEnabled = () => {
  const v = localStorage.getItem(LS_AUDIO_ON);
  return v === null ? true : v === "1";  // 默认开
};

function applyStyle(s) {
  if (s === "minimal" || !STYLES.includes(s)) {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", s);
  }
  applyScheme();
  if (document.body) document.body.dataset.audioDisabled = String(!getAudioEnabled());
}

// 明暗维度:作为 data-scheme 覆盖在 data-theme(主题气质)之上;v1 极简已支持双态
function applyScheme() {
  document.documentElement.setAttribute("data-scheme", getScheme());
}

// ═══ 氛围音双轨混音器：环境(amb) × 音乐(mus) ═══
// 两条独立轨：各自一个 <audio> + GainNode，可同时播放、音量独立、切换带淡入淡出。
// 音量收口在 GainNode（<audio>.volume 固定 1），master → analyser → destination，
// analyser 驱动 --pulse（沿用旧 Pulse 的可视化节奏；没有声音时退回 CSS 慢摆）。
const Mixer = (() => {
  const FADE = 0.7; // 秒
  let ctx = null, master = null, analyser = null;
  let audioReady = false;
  let rafId = null, fallbackTimer = null, fallbackPhase = 0;
  let pendingStart = false; // 未获手势授权前请求过播放 → 授权后补播
  const decks = {
    amb: { id: null, el: null, gain: null, vol: 0.6, epoch: 0, pauseTimer: null, switchTimer: null },
    mus: { id: null, el: null, gain: null, vol: 0.35, epoch: 0, pauseTimer: null, switchTimer: null },
  };

  function readDeck(key, defVol) {
    try {
      const o = JSON.parse(localStorage.getItem(key) || "null");
      if (o && typeof o === "object") {
        return {
          id: (typeof o.id === "string" && findTrack(key === LS_AMB ? "amb" : "mus", o.id)) ? o.id : null,
          vol: (typeof o.vol === "number" && o.vol >= 0 && o.vol <= 1) ? o.vol : defVol,
        };
      }
    } catch (e) {}
    return { id: null, vol: defVol };
  }
  function writeDeck(key, d) {
    try { localStorage.setItem(key, JSON.stringify({ id: d.id, vol: Math.round(d.vol * 100) / 100 })); } catch (e) {}
  }
  // 启动只恢复「音量」，不恢复播放选择、不自动播放：
  // 自动播放会被浏览器拦截；而"上次选了某轨但没声音"会在 UI 上留下一个假高亮，语义混乱。
  // 环境/音乐由用户点选或 Agent 标签在运行期开启。
  (function initState() {
    const legacy = parseFloat(localStorage.getItem(LS_AUDIO_VOL));
    const ambDef = (isFinite(legacy) && legacy >= 0 && legacy <= 1) ? legacy : 0.6;
    const a = readDeck(LS_AMB, ambDef);
    decks.amb.vol = a.vol;
    const m = readDeck(LS_MUS, 0.35);
    decks.mus.vol = m.vol;
  })();

  const enabled = () => getAudioEnabled();
  const anyPlaying = () => !!(decks.amb.id || decks.mus.id) && enabled();

  // 2026-10-07 拖动卡顿修复（E-C）：--pulse 写在 <html> 上 —— 每次写都让整棵样式树失效重算。
  // 旧版 20Hz 无脑写（极简主题没有任何 --pulse 消费者也照写），手机端就是持续的微卡。
  // 现在：① 值不变不写；② 只在有消费者的主题（candle/glass，或音频播放中）出力；③ 页面隐藏时跳过。
  let _lastPulse = "";
  function setPulseVar(v) {
    const s = v.toFixed(3);
    if (s === _lastPulse) return;
    _lastPulse = s;
    document.documentElement.style.setProperty("--pulse", s);
  }
  function pulseNeeded() {
    if (anyPlaying()) return true;
    const t = document.documentElement.getAttribute("data-theme");
    return t === "candle" || t === "glass";
  }
  function setPulseClass(on) {
    document.documentElement.classList.toggle("pulse-on", !!on);
  }
  // 2026-10-07 (E-C)：分析器缓冲复用 —— 旧版每帧 new Uint8Array(frequencyBinCount)（60fps 下白造垃圾）
  let _freqBuf = null;
  function tick() {
    if (!analyser) { rafId = requestAnimationFrame(tick); return; }
    if (!_freqBuf || _freqBuf.length !== analyser.frequencyBinCount) _freqBuf = new Uint8Array(analyser.frequencyBinCount);
    const buf = _freqBuf;
    analyser.getByteFrequencyData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i];
    const avg = sum / buf.length / 255;
    setPulseVar(Math.min(1, Math.max(0, avg * 1.8)));
    rafId = requestAnimationFrame(tick);
  }
  function startFallback() {
    if (fallbackTimer) return;
    fallbackTimer = setInterval(() => {
      // 无消费者（极简主题且无音频）或页面不可见：不出力（定时器保留，切回 candle/glass 即恢复）
      if (!pulseNeeded() || document.hidden) return;
      fallbackPhase += 0.05;
      setPulseVar(0.4 * (Math.sin(fallbackPhase * 1.4) * 0.5 + 0.5));
    }, 50);
  }
  function stopFallback() {
    if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
  }

  function ensureCtx() {
    if (ctx) return ctx;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 1;
    analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    master.connect(analyser);
    analyser.connect(ctx.destination);
    return ctx;
  }
  function ensureDeck(k) {
    const d = decks[k];
    if (d.el) return d;
    ensureCtx();
    d.el = new Audio();
    d.el.loop = true;
    d.el.preload = "auto";
    d.el.crossOrigin = "anonymous";
    d.el.volume = 1;
    d.gain = ctx.createGain();
    d.gain.gain.value = 0;
    ctx.createMediaElementSource(d.el).connect(d.gain);
    d.gain.connect(master);
    return d;
  }
  function ramp(k, to) {
    const d = decks[k];
    if (!d.gain || !ctx) return;
    const now = ctx.currentTime;
    try {
      d.gain.gain.cancelScheduledValues(now);
      d.gain.gain.setValueAtTime(d.gain.gain.value, now);
      d.gain.gain.linearRampToValueAtTime(to, now + FADE);
    } catch (e) { d.gain.gain.value = to; }
  }
  const targetGain = (k) => (enabled() ? decks[k].vol : 0);

  // 淡出后延时暂停：延时器挂在 deck 上，换轨/重播时会被清掉，避免"暂停刚启动的新元素"
  function pauseDeck(k) {
    const d = decks[k];
    if (d.pauseTimer) { clearTimeout(d.pauseTimer); d.pauseTimer = null; }
    if (d.el && !d.el.paused) {
      d.pauseTimer = setTimeout(() => {
        d.pauseTimer = null;
        try { d.el.pause(); } catch (e) {}
      }, FADE * 1000 + 60);
    }
  }
  // 立即静音并停（应急路径用；不等待淡出）
  function hardStop(k) {
    const d = decks[k];
    if (d.pauseTimer) { clearTimeout(d.pauseTimer); d.pauseTimer = null; }
    if (d.switchTimer) { clearTimeout(d.switchTimer); d.switchTimer = null; }
    if (d.gain && ctx) {
      try {
        d.gain.gain.cancelScheduledValues(ctx.currentTime);
        d.gain.gain.value = 0;
      } catch (e) {}
    }
    if (d.el && !d.el.paused) { try { d.el.pause(); } catch (e) {} }
  }

  function playDeck(k) {
    const d = decks[k];
    if (!d.id || !enabled()) return;
    if (d.pauseTimer) { clearTimeout(d.pauseTimer); d.pauseTimer = null; }
    ensureDeck(k);
    const t = findTrack(k, d.id);
    if (!t) return;
    const url = "/assets/ambient/" + t[2];
    if (!d.el.src || !d.el.src.endsWith(t[2])) d.el.src = url;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    // epoch 护栏：play() 是异步的，等它落地时这一轨可能已经被停掉/换掉/紧急静音 ——
    // 那种情况下绝不能再把音量拉回来（否则 panic 之后音量会"复活"）。
    const ep = ++d.epoch;
    d.el.play().then(() => {
      if (ep !== d.epoch || !d.id || !enabled()) return;
      pendingStart = false;
      ramp(k, targetGain(k));
    }).catch(() => {
      if (ep !== d.epoch) return;
      pendingStart = true; // 等首次手势授权后补
      startFallback();
    });
  }
  function silenceDeck(k, { clear } = {}) {
    const d = decks[k];
    d.epoch++;
    ramp(k, 0);
    pauseDeck(k);
    if (clear) d.id = null;
  }

  // 对外：设置某轨（id=null 停止该轨）；vol 可选（0~1）
  function set(k, id, vol) {
    const d = decks[k];
    if (!d) return get();
    if (typeof vol === "number" && vol >= 0 && vol <= 1) d.vol = vol;
    const nextId = id === null ? null : (findTrack(k, id) ? id : null);
    const changed = nextId !== d.id;
    d.id = nextId;
    writeDeck(k === "amb" ? LS_AMB : LS_MUS, d);
    if (!d.id) {
      silenceDeck(k, { clear: false });
    } else if (changed) {
      // 换轨：先淡出 → 换源 → 淡入（延时器同样挂在 deck 上，连续点选不会打架）
      if (d.switchTimer) { clearTimeout(d.switchTimer); d.switchTimer = null; }
      if (d.el && !d.el.paused) {
        ramp(k, 0);
        d.switchTimer = setTimeout(() => { d.switchTimer = null; if (decks[k].id) playDeck(k); }, FADE * 1000 + 40);
      } else {
        playDeck(k);
      }
    } else if (!d.el || d.el.paused) {
      playDeck(k);
    } else if (typeof vol === "number") {
      ramp(k, targetGain(k));
    }
    syncPulseLoop();
    return emit();
  }
  // Agent 标签入口：deck 可以是 'amb' | 'mus' | 'voice'（voice = 环境层的轻息垫）
  function tag(deck, id, vol) {
    if (deck === "voice") return set("amb", id || VOICE_DEFAULT, vol);
    if (deck === "amb" || deck === "mus") return set(deck, id || null, vol);
    return get();
  }
  // 全部停止：两轨归零并清空选择（{ fade:false } = 立即静音，紧急停止用）
  function stopAll(opts) {
    const fade = !opts || opts.fade !== false;
    ["amb", "mus"].forEach((k) => {
      const d = decks[k];
      d.id = null;
      writeDeck(k === "amb" ? LS_AMB : LS_MUS, d);
      if (fade) silenceDeck(k); else { d.epoch++; hardStop(k); }
    });
    syncPulseLoop();
    return emit();
  }
  function setEnabled(on) {
    try { localStorage.setItem(LS_AUDIO_ON, on ? "1" : "0"); } catch (e) {}
    if (document.body) document.body.dataset.audioDisabled = String(!on);
    if (on) {
      ["amb", "mus"].forEach((k) => { if (decks[k].id) playDeck(k); });
    } else {
      ["amb", "mus"].forEach((k) => { decks[k].epoch++; silenceDeck(k); });
    }
    syncPulseLoop();
    return emit();
  }
  function setVolume(k, v) {
    if (!decks[k] || !(v >= 0 && v <= 1)) return get();
    decks[k].vol = v;
    writeDeck(k === "amb" ? LS_AMB : LS_MUS, decks[k]);
    if (decks[k].gain) ramp(k, targetGain(k));
    return emit();
  }
  function get() {
    return {
      enabled: enabled(),
      playing: anyPlaying(),
      amb: { id: decks.amb.id, vol: decks.amb.vol },
      mus: { id: decks.mus.id, vol: decks.mus.vol },
    };
  }
  function emit() {
    const detail = get();
    window.dispatchEvent(new CustomEvent("ambient:changed", { detail }));
    return detail;
  }
  function syncPulseLoop() {
    if (anyPlaying() && audioReady) {
      stopFallback();
      setPulseClass(true);
      if (!rafId) tick();
    } else {
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      setPulseClass(false);
      if (audioReady) startFallback();
    }
  }
  function markAudioReady() {
    if (audioReady) return;
    audioReady = true;
    if (pendingStart || anyPlaying()) {
      ["amb", "mus"].forEach((k) => { if (decks[k].id) playDeck(k); });
    }
    syncPulseLoop();
  }
  // 初始化:没有手势前先跑 CSS 慢摆,让 --pulse 仍有节奏
  setTimeout(() => { if (!audioReady) startFallback(); }, 400);

  return {
    get, set, tag, stopAll, setEnabled, setVolume, markAudioReady,
    tracks: TRACKS, findTrack, trackLabel,
    // 仅供排查：混音器内部实时状态（AudioContext / 各轨播放位置 / 当前增益）
    _debug: () => {
      const snap = (k) => {
        const d = decks[k];
        return {
          id: d.id,
          paused: d.el ? d.el.paused : null,
          t: d.el ? Math.round(d.el.currentTime * 100) / 100 : null,
          gain: d.gain ? Math.round(d.gain.gain.value * 1000) / 1000 : null,
        };
      };
      return { ctx: ctx ? ctx.state : null, audioReady, pendingStart, amb: snap("amb"), mus: snap("mus") };
    },
  };
})();

// 兼容旧调用口：window.__theme.audio 的 get/set 收口到混音器（音量=环境轨）
const audio = {
  get: () => ({ enabled: getAudioEnabled(), volume: Mixer.get().amb.vol }),
  set: ({ enabled, volume } = {}) => {
    if (typeof enabled === "boolean") Mixer.setEnabled(enabled);
    if (typeof volume === "number" && volume >= 0 && volume <= 1) Mixer.setVolume("amb", volume);
    return Mixer.get();
  },
};

// ═══ set / panic / audio 收口 ═══
function set(patch) {
  patch = patch || {};
  if (patch.style && STYLES.includes(patch.style)) {
    try { localStorage.setItem(LS_STYLE, patch.style); } catch (e) {}
    applyStyle(patch.style);
  }
  if (patch.scheme === "light" || patch.scheme === "dark") {
    try { localStorage.setItem(LS_SCHEME, patch.scheme); } catch (e) {}
    applyScheme();
  } else if (patch.scheme === "auto" || patch.scheme === null) {
    try { localStorage.removeItem(LS_SCHEME); } catch (e) {}
    applyScheme();
  }
  if (patch.accent) {
    try { localStorage.setItem(LS_ACCENT, patch.accent); } catch (e) {}
  }
  document.querySelectorAll('input[name="cfwTheme"]').forEach(r => {
    r.checked = (r.value === getStyle());
  });
  window.dispatchEvent(new CustomEvent("theme:changed", { detail: getAll() }));
}

function panic() {
  Mixer.stopAll({ fade: false }); // 紧急停止：立即静音，不留淡出尾巴
  set({ style: "minimal" });
}

const is = (scheme) => getScheme() === scheme;
const styles = () => STYLES.slice();
function subscribe(fn) {
  const h = (e) => fn(e.detail || getAll());
  window.addEventListener("theme:changed", h);
  return () => window.removeEventListener("theme:changed", h);
}

window.__theme = { get: getAll, set, is, styles, subscribe, panic, audio, applyBg, wireAmbientCard };
// 氛围音混音器（对外主入口）：
//   __ambient.get()                      → { enabled, playing, amb:{id,vol}, mus:{id,vol} }
//   __ambient.set('amb'|'mus', id|null, vol?)  → 设置某轨（null 停该轨），返回最新状态
//   __ambient.tag('amb'|'mus'|'voice', id?, vol?) → 供 Agent 标签/工具调用（voice 是环境层轻息垫的别名）
//   __ambient.stopAll() / setEnabled(bool) / setVolume('amb'|'mus', 0~1)
//   __ambient.tracks → { amb: [[id,名,文件]...], mus: [...] }
// 事件：window 'ambient:changed' detail = get()
window.__ambient = Mixer;

// 解析时立即应用一次明暗维度,减少 data-scheme 迟到造成的闪烁
// 2026-10-06: 背景图也在启动时应用一次（原由编辑器 init 调 applyUIOverrides）
try { applyBg(); } catch (e) {}
try { applyScheme(); } catch (e) {}

// ═══ wire Settings DOM ═══
// 日/夜切换控件(运行时注入到主题选择上方;仅对已接入双态的主题显示)
function refreshSchemeToggle() {
  const row = document.getElementById("cfwSchemeRow");
  if (!row) return;
  row.style.display = SCHEME_READY.has(getStyle()) ? "" : "none";
  const stored = getStoredScheme();
  row.querySelectorAll("button[data-scheme-val]").forEach((b) => {
    const v = b.getAttribute("data-scheme-val");
    const on = (v === "auto" && !stored) || v === stored;
    b.classList.toggle("active", on);
  });
}

function ensureSchemeToggle() {
  if (document.getElementById("cfwSchemeRow")) { refreshSchemeToggle(); return; }
  const firstRadio = document.querySelector('input[name="cfwTheme"]');
  if (!firstRadio) return;
  const opt = firstRadio.closest(".theme-option") || firstRadio.parentElement;
  const list = opt ? opt.parentElement : null;
  if (!list || !list.parentElement) return;
  const row = document.createElement("div");
  row.id = "cfwSchemeRow";
  row.className = "scheme-toggle-row";
  row.innerHTML =
    '<span class="stg-label">明暗</span>' +
    '<div class="scheme-seg">' +
      '<button type="button" data-scheme-val="auto">跟随主题</button>' +
      '<button type="button" data-scheme-val="light">日间</button>' +
      '<button type="button" data-scheme-val="dark">夜间</button>' +
    '</div>';
  list.parentElement.insertBefore(row, list);
  row.querySelectorAll("button[data-scheme-val]").forEach((b) => {
    b.addEventListener("click", () => {
      set({ scheme: b.getAttribute("data-scheme-val") });
      refreshSchemeToggle();
    });
  });
  refreshSchemeToggle();
}

function wireSettings() {
  if (wireSettings._bound) return;
  wireSettings._bound = true;
  document.querySelectorAll('input[name="cfwTheme"]').forEach(r => {
    r.checked = (r.value === getStyle());
    r.addEventListener("change", () => {
      if (!r.checked) return;
      if (STYLES.includes(r.value)) set({ style: r.value });
    });
  });

  ensureSchemeToggle();
  subscribe(refreshSchemeToggle);
  wireAmbientCard();
}

// ═══ wire Settings · 氛围音卡（双轨 chips + 音量 + 总开关）═══
function refreshAmbientCard() {
  const card = document.getElementById("ambientCard");
  if (!card) return;
  const st = Mixer.get();
  const en = card.querySelector("#ambEnabled");
  if (en) en.checked = st.enabled;
  [["amb", "ambChipsAmb", "ambVolAmb", "ambVolAmbLabel"], ["mus", "ambChipsMus", "ambVolMus", "ambVolMusLabel"]].forEach(([deck, chipsId, volId, lblId]) => {
    const cur = st[deck] || {};
    const chips = card.querySelector("#" + chipsId);
    if (chips) chips.querySelectorAll(".amb-chip").forEach((b) => {
      b.classList.toggle("active", b.getAttribute("data-id") === cur.id);
    });
    const vol = card.querySelector("#" + volId);
    const lbl = card.querySelector("#" + lblId);
    const pct = Math.round((cur.vol || 0) * 100);
    if (vol && document.activeElement !== vol) vol.value = String(pct);
    if (lbl) lbl.textContent = pct + "%";
  });
}
function wireAmbientCard() {
  const card = document.getElementById("ambientCard");
  if (!card || card.dataset.wired === "1") return;
  card.dataset.wired = "1";
  [["amb", "ambChipsAmb"], ["mus", "ambChipsMus"]].forEach(([deck, chipsId]) => {
    const host = card.querySelector("#" + chipsId);
    if (!host) return;
    host.innerHTML = Mixer.tracks[deck].map((t) =>
      '<button type="button" class="amb-chip" data-deck="' + deck + '" data-id="' + t[0] + '">' + t[1] + "</button>"
    ).join("");
  });
  card.addEventListener("click", (e) => {
    const chip = e.target.closest(".amb-chip");
    if (!chip) return;
    const deck = chip.getAttribute("data-deck");
    const id = chip.getAttribute("data-id");
    if (deck !== "amb" && deck !== "mus") return;
    const cur = Mixer.get()[deck] || {};
    Mixer.set(deck, cur.id === id ? null : id); // 点已激活的 chip = 停该轨
  });
  const en = card.querySelector("#ambEnabled");
  if (en) en.addEventListener("change", () => Mixer.setEnabled(!!en.checked));
  const stopAll = card.querySelector("#ambStopAll");
  if (stopAll) stopAll.addEventListener("click", () => Mixer.stopAll());
  [["amb", "ambVolAmb", "ambVolAmbLabel"], ["mus", "ambVolMus", "ambVolMusLabel"]].forEach(([deck, volId, lblId]) => {
    const vol = card.querySelector("#" + volId);
    const lbl = card.querySelector("#" + lblId);
    if (!vol) return;
    vol.addEventListener("input", () => {
      const v = Math.max(0, Math.min(1, parseInt(vol.value, 10) / 100));
      if (lbl) lbl.textContent = Math.round(v * 100) + "%";
      Mixer.setVolume(deck, v);
    });
  });
  refreshAmbientCard();
  window.addEventListener("ambient:changed", refreshAmbientCard);
}

window.addEventListener("load", () => {
  applyStyle(getStyle());
  wireSettings();
  // 这一行是「刷新后等级被重置」的直接来源:每次 load 无条件覆写等级,用户手选的档位活不过一次刷新。

  // 首次任意交互后 AudioContext 才可用（点过页面之后氛围音才可能出声）
  const audioReadyOnce = () => {
    Mixer.markAudioReady();
    window.removeEventListener("pointerdown", audioReadyOnce);
    window.removeEventListener("keydown", audioReadyOnce);
    window.removeEventListener("touchstart", audioReadyOnce);
  };
  window.addEventListener("pointerdown", audioReadyOnce, { once: true });
  window.addEventListener("keydown",    audioReadyOnce, { once: true });
  window.addEventListener("touchstart", audioReadyOnce, { once: true });

  // Shift+Esc 全局紧急停止（氛围音全部淡出 + 主题回极简）
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && e.shiftKey) {
      e.preventDefault();
      panic();
    }
  });

  wireAmbientCard();
});
})();