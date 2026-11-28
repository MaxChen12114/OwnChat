(function () {
/**
 * Theme state rules, minus the DOM and the audio: which styles exist, which are private, how the
 * effective style and light/dark scheme are derived, what the ambient decks persist, and the track
 * tables.
 *
 * Two derivation rules carry the history:
 *  - A private style (candle) only applies while the private mode is unlocked. Stale LS values fall
 *    back to minimal — the same reading the FOUC inline script uses, or the page would flash the
 *    private theme before the gate loads.
 *  - The effective scheme is an explicit choice first, the style's native light/dark second. Only
 *    styles that actually ship both variants appear in `SCHEME_READY`; the settings row shows the
 *    toggle for those and only those.
 *
 * The mixer deck persisted value is validated on read: an unknown track id or an out-of-range volume
 * falls back to the deck default, never plays a track the table does not know.
 * @module services/ui/theme
 */

/** Styles in radio order; adding one means adding the [data-theme] CSS, nothing else. */
const THEME_STYLES = ["minimal", "glass", "lumen", "candle"];
/** Styles that belong to the private mode; gated on the unlock flag. */
const PRIVATE_STYLES = ["candle"];
function recOf(v         )                          {
  const out                          = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

const THEME_DEFAULT_STYLE = "minimal";

const THEME_LS_STYLE = "cfw_theme_v1";
const THEME_LS_SCHEME = "my-theme"; // legacy name kept: scattered consumers read it
const THEME_LS_ACCENT = "cfw_theme_accent_v1";
const AUDIO_LS_ENABLED = "cfw_audio_enabled_v1";
const AUDIO_LS_LEGACY_VOL = "cfw_audio_volume_v1"; // single-track volume, migrated into amb
const AUDIO_LS_AMB = "cfw_ambient_amb_v1";
const AUDIO_LS_MUS = "cfw_ambient_mus_v1";

/** Each style's native light/dark, used when the user has not chosen a scheme. */
const NATIVE_SCHEME                         = { minimal: "dark", glass: "light", lumen: "light", candle: "dark" };
/** Styles that actually ship both schemes; the UI only shows the toggle for these. */
const SCHEME_READY = ["minimal", "lumen"];

/**
 * Chat presentation is a fourth, orthogonal axis: which bubbles the transcript uses is not the
 * same decision as which palette the app wears. `auto` follows the style's native form; the
 * settings card exposes auto / bubble / doc explicitly.
 */
const THEME_LS_CHAT = "cfw_chat_present_v1";
const CHAT_PRESENTS = ["auto", "bubble", "doc"];
const CHAT_PRESENT_DEFAULT = "auto";
/** Each style's native transcript. Lumen is the document-first theme; the rest are bubbles. */
const NATIVE_CHAT                         = {
  minimal: "bubble",
  glass: "bubble",
  lumen: "doc",
  candle: "bubble",
};

/**
 * The transcript form that should actually apply. Explicit bubble/doc wins over the style's
 * native form; an unknown or missing stored value means "follow the theme".
 */
function resolveChatPresent(stored         , style        )                   {
  const v = String(stored || "");
  if (v === "bubble" || v === "doc") return v;
  return NATIVE_CHAT[style] === "doc" ? "doc" : "bubble";
}

/** Ambient tracks, all CC0 (credits in /assets/ambient/CREDITS.txt): [id, label, file]. */
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
const THEME_TRACKS                             = { amb: AMB_TRACKS, mus: MUS_TRACKS };

/** The [[voice:]] agent tag's default breath pad, aliased onto the amb deck. */
const VOICE_DEFAULT = "voice-breath";

function trackFile(deck        , id        )                {
  const t = findTrack(deck, id);
  return t ? t[2] : null;
}

function findTrack(deck        , id         )                  {
  const list = THEME_TRACKS[deck] || [];
  for (const t of list) if (t[0] === id) return t;
  return null;
}

function trackLabel(deck        , id         )         {
  const t = findTrack(deck, id);
  return t ? t[1] : "";
}

/**
 * The style that should actually apply. Locked-state stale values fall back to minimal — the FOUC
 * inline script reads the same way, so the two never disagree on first paint.
 */
function resolveStyle(stored         , unlocked         )         {
  const v = String(stored || "");
  if (THEME_STYLES.indexOf(v) < 0) return THEME_DEFAULT_STYLE;
  if (PRIVATE_STYLES.indexOf(v) >= 0 && !unlocked) return THEME_DEFAULT_STYLE;
  return v;
}

/** Explicit choice wins over the style's native scheme; an unknown stored value means "not chosen". */
function resolveScheme(stored         , style        )         {
  if (stored === "light" || stored === "dark") return stored;
  return NATIVE_SCHEME[style] || "dark";
}

                            
                    
              
 

const AMB_DEFAULT_VOL = 0.6;
const MUS_DEFAULT_VOL = 0.35;

/** Legacy single-track volume, only used to seed the amb deck's default. */
function initialAmbVolume(legacyRaw         )         {
  const v = parseFloat(String(legacyRaw));
  return isFinite(v) && v >= 0 && v <= 1 ? v : AMB_DEFAULT_VOL;
}

/**
 * Parse a persisted deck. Unknown ids are dropped (the track table may have changed) and volumes
 * outside 0..1 fall back to the deck default — never restore something the mixer cannot play.
 */
function readDeckState(raw         , deck        , defVol        )            {
  let o          = null;
  try {
    o = JSON.parse(String(raw == null ? "null" : raw));
  } catch (e) {
    o = null;
  }
  const r = recOf(o);
  if (Object.keys(r).length === 0) return { id: null, vol: defVol };
  const id = typeof r.id === "string" && findTrack(deck, r.id) ? r.id : null;
  const vol = typeof r.vol === "number" && r.vol >= 0 && r.vol <= 1 ? r.vol : defVol;
  return { id: id, vol: vol };
}

/** The exact persisted shape: two decimals, nothing else — keeps the LS diff stable. */
function deckJson(d           )         {
  return JSON.stringify({ id: d.id, vol: Math.round(d.vol * 100) / 100 });
}

function audioEnabledFrom(raw         )          {
  return raw === null ? true : raw === "1";
}

function clampVolume(v         )                {
  const n = typeof v === "number" ? v : NaN;
  return n >= 0 && n <= 1 ? n : null;
}

// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/ui/theme.ts (style/scheme derivation,
// track tables, deck persistence); this file owns the DOM apply, the ambient mixer (Web Audio), the
// background layer and the settings wiring.
//
// Principles: three orthogonal dimensions (style / scheme / accent); consumers subscribe to the
// `theme:changed` event instead of reading LS; `set(patch)` is the only write path, so LS, DOM,
// settings UI and subscribers cannot drift; adding a style means one table entry plus CSS.
//
// Public API:
//   themeSvc.get() / set(patch) / is("light"|"dark") / styles() / subscribe(fn) / panic() /
//   audio { get, set } / applyBg() / applyFromLS() / wireAmbientCard()
//   __ambient.get() / set(deck, id|null, vol?) / tag(deck, id?, vol?) / stopAll() /
//   setEnabled(bool) / setVolume(deck, 0..1) / unlock() / tracks / findTrack / trackLabel
//
// Events: window `theme:changed` detail = { style, scheme, accent };
//         window `ambient:changed` detail = { enabled, playing, amb:{id,vol}, mus:{id,vol} }.
//
// LS keys: cfw_theme_v1 (style) · my-theme (scheme, legacy name kept for scattered readers) ·
// cfw_theme_accent_v1 · cfw_audio_enabled_v1 · cfw_ambient_amb_v1 / cfw_ambient_mus_v1 (deck JSON).
//
// The FOUC guard for minimal/glass still lives in index.html's inline head script; this file
// re-applies idempotently after load.
(function () {
"use strict";

// v3: multi-dimension + private styles + the dual-deck ambient mixer (ambience x music).
const STYLES = THEME_STYLES;
const LS_STYLE = THEME_LS_STYLE;
const LS_SCHEME = THEME_LS_SCHEME;
const LS_ACCENT = THEME_LS_ACCENT;
const LS_CHAT = THEME_LS_CHAT;
const LS_AUDIO_ON = AUDIO_LS_ENABLED;
const LS_AUDIO_VOL = AUDIO_LS_LEGACY_VOL;
const LS_AMB = AUDIO_LS_AMB;
const LS_MUS = AUDIO_LS_MUS;

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
    if (!src) { if (layer && layer.parentNode) layer.parentNode.removeChild(layer); bgBaseClear(false); document.documentElement.classList.remove("has-bg"); return; }
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
    // Position is adjustable: posX/posY are 0-100 percentages (default 50/50). The image itself is
    // cover-fitted, so moving it changes which part of the picture shows.
    let px = (bg.posX != null && bg.posX !== "") ? parseInt(bg.posX, 10) : 50;
    let py = (bg.posY != null && bg.posY !== "") ? parseInt(bg.posY, 10) : 50;
    if (!isFinite(px)) px = 50;
    if (!isFinite(py)) py = 50;
    layer.style.backgroundPosition = Math.max(0, Math.min(100, px)) + "% " + Math.max(0, Math.min(100, py)) + "%";
    bgBaseClear(true);
    // With a background image the html/body base is transparent, so translucent surfaces (input,
    // bubbles) show the photo straight through — in the shell's low-fx tier (no blur) that reads as
    // "the input is transparent". This class lets that tier make its base solid only in this case.
    document.documentElement.classList.add("has-bg");
  } catch (e) {}
}

const isUnlocked = () => {
  try { return localStorage.getItem("cfw_unlocked_v1") === "1"; } catch (e) { return false; }
};
// The second argument is what the public build neutralizes: the private style gate is the only
// unlock-coupled rule here, so the patch flips this one call instead of cutting the function apart.
const getStyle = () => resolveStyle(localStorage.getItem(LS_STYLE), isUnlocked());
const SCHEME_READY_SET = new Set(SCHEME_READY);
const getStoredScheme = () => {
  const v = localStorage.getItem(LS_SCHEME);
  return v === "light" || v === "dark" ? v : null;
};
// Effective scheme = explicit choice > the style's native light/dark.
const getScheme = () => resolveScheme(getStoredScheme(), getStyle());
const getStoredChatPresent = () => {
  const v = localStorage.getItem(LS_CHAT);
  return v === "bubble" || v === "doc" ? v : null;
};
// Effective transcript = explicit choice > the style's native form (lumen = doc).
const getChatPresent = () => resolveChatPresent(getStoredChatPresent(), getStyle());
const getAccent = () => localStorage.getItem(LS_ACCENT) || "default";
const getAll    = () => ({ style: getStyle(), scheme: getScheme(), chat: getChatPresent(), accent: getAccent() });

const getAudioEnabled = () => audioEnabledFrom(localStorage.getItem(LS_AUDIO_ON));

function applyStyle(s) {
  if (s === "minimal" || !STYLES.includes(s)) {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", s);
  }
  applyScheme();
  applyChatPresent();
  if (document.body) document.body.dataset.audioDisabled = String(!getAudioEnabled());
}

// The scheme rides on top of data-theme as data-scheme; minimal is the first dual-mode style.
function applyScheme() {
  document.documentElement.setAttribute("data-scheme", getScheme());
}

// data-chat-present is orthogonal to data-theme: it selects bubble vs document transcript.
function applyChatPresent() {
  document.documentElement.setAttribute("data-chat-present", getChatPresent());
}

// Dual-deck ambient mixer: ambience (amb) x music (mus). One <audio> + GainNode per deck — both can
// play at once, volumes independent, switches fade. Volume lives in the GainNode (<audio>.volume is
// pinned at 1); master -> analyser -> destination, and the analyser drives --pulse (with a CSS sway
// fallback when silent). Gate: cfw_audio_enabled_v1 only, no theme/unlock coupling.
const Mixer = (() => {
  const FADE = 0.7; // seconds
  let ctx = null, master = null, analyser = null;
  let unlocked = false;
  let rafId = null, fallbackTimer = null, fallbackPhase = 0;
  let pendingStart = false; // playback was requested before the gesture unlock; retry after
  const decks = {
    amb: { id: null, el: null, gain: null, vol: 0.6, epoch: 0, pauseTimer: null, switchTimer: null },
    mus: { id: null, el: null, gain: null, vol: 0.35, epoch: 0, pauseTimer: null, switchTimer: null },
  };

  function readDeck(key, defVol) {
    return readDeckState(localStorage.getItem(key), key === LS_AMB ? "amb" : "mus", defVol);
  }
  function writeDeck(key, d) {
    try { localStorage.setItem(key, deckJson(d)); } catch (e) {}
  }
  // Startup restores volumes only — never the track choice, never autoplay. Autoplay gets blocked by
  // the browser, and "a track is selected but silent" leaves a fake highlight in the UI. Tracks start
  // from a user click or an agent tag at runtime.
  (function initState() {
    const a = readDeck(LS_AMB, initialAmbVolume(localStorage.getItem(LS_AUDIO_VOL)));
    decks.amb.vol = a.vol;
    const m = readDeck(LS_MUS, 0.35);
    decks.mus.vol = m.vol;
  })();

  const enabled = () => getAudioEnabled();
  const anyPlaying = () => !!(decks.amb.id || decks.mus.id) && enabled();

  // --pulse lives on <html>, so every write invalidates the whole style tree. Writing it at 20Hz
  // regardless of consumers was constant jank on mobile. Now: skip when the value is unchanged, only
  // drive it for themes that consume it (candle/glass, or audio playing), and skip when hidden.
  let _lastPulse = "";
  function setPulseVar(v) {
    const s = v.toFixed(3);
    if (s === _lastPulse) return;
    _lastPulse = s;
    document.documentElement.style.setProperty("--pulse", s);
  }
  // The shell's low-fx tier stops --pulse driving entirely: its consumers (bubble shadows, input,
  // send button, body gradient) are off or fine static, and 20-60Hz writes were the largest
  // grows-with-session render cost anywhere. The fx-rich tier keeps the pulse on purpose.
  function fxRich() {
    try {
      const el = document.documentElement;
      return !el.classList.contains("android-app") || el.classList.contains("fx-rich");
    } catch (e) { return true; }
  }
  function pulseNeeded() {
    if (!fxRich()) return false;
    if (anyPlaying()) return true;
    const t = document.documentElement.getAttribute("data-theme");
    return t === "candle" || t === "glass";
  }
  function setPulseClass(on) {
    document.documentElement.classList.toggle("pulse-on", !!on);
  }
  // Reuse the analyser buffer: allocating per frame was pure garbage at 60fps.
  let _freqBuf = null;
  function tick() {
    // Dropping back to low-fx stops the rAF and pins a static value; otherwise an active track keeps
    // writing the variable at 20-60Hz with nothing left to animate.
    if (!fxRich()) { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } setPulseVar(0.35); return; }
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
      // No consumer (minimal theme, silent) or hidden page: skip work, keep the timer alive.
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

  // Pause is deferred past the fade; the timer lives on the deck so a switch or replay cancels it
  // instead of pausing the freshly started element.
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
  // Immediate mute and stop — the panic path, no fade tail.
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
    // The epoch guard: play() is async, and by the time it lands this deck may have been stopped,
    // switched or panic-muted. In those cases the volume must not come back, or panic would not stick.
    const ep = ++d.epoch;
    d.el.play().then(() => {
      if (ep !== d.epoch || !d.id || !enabled()) return;
      pendingStart = false;
      ramp(k, targetGain(k));
    }).catch(() => {
      if (ep !== d.epoch) return;
      pendingStart = true; // retry after the first gesture
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

  // Set a deck (id=null stops it); vol optional 0..1.
  function set(k, id, vol) {
    const d = decks[k];
    if (!d) return get();
    const volNum = clampVolume(vol);
    if (volNum !== null) d.vol = volNum;
    const nextId = id === null ? null : (findTrack(k, id) ? id : null);
    const changed = nextId !== d.id;
    d.id = nextId;
    writeDeck(k === "amb" ? LS_AMB : LS_MUS, d);
    if (!d.id) {
      silenceDeck(k, { clear: false });
    } else if (changed) {
      // Switch: fade out, swap source, fade in. The timer lives on the deck so rapid clicks queue
      // cleanly instead of fighting.
      if (d.switchTimer) { clearTimeout(d.switchTimer); d.switchTimer = null; }
      if (d.el && !d.el.paused) {
        ramp(k, 0);
        d.switchTimer = setTimeout(() => { d.switchTimer = null; if (decks[k].id) playDeck(k); }, FADE * 1000 + 40);
      } else {
        playDeck(k);
      }
    } else if (!d.el || d.el.paused) {
      playDeck(k);
    } else if (volNum !== null) {
      ramp(k, targetGain(k));
    }
    syncPulseLoop();
    return emit();
  }
  // Agent-tag entry: deck may be 'amb' | 'mus' | 'voice' (voice aliases the breath pad on amb).
  function tag(deck, id, vol) {
    if (deck === "voice") return set("amb", id || VOICE_DEFAULT, vol);
    if (deck === "amb" || deck === "mus") return set(deck, id || null, vol);
    return get();
  }
  // Stop both decks and clear their selection ({ fade:false } = immediate, for panic).
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
    const vol = clampVolume(v);
    if (!decks[k] || vol === null) return get();
    decks[k].vol = vol;
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
    if (anyPlaying() && unlocked && fxRich()) {
      stopFallback();
      setPulseClass(true);
      if (!rafId) tick();
    } else {
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      setPulseClass(false);
      if (!fxRich()) setPulseVar(0); // pin a static value; the style tree must not jitter
      else if (unlocked) startFallback();
    }
  }
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    if (pendingStart || anyPlaying()) {
      ["amb", "mus"].forEach((k) => { if (decks[k].id) playDeck(k); });
    }
    syncPulseLoop();
  }
  // Before the first gesture, keep the CSS sway going so --pulse still has a rhythm.
  setTimeout(() => { if (!unlocked) startFallback(); }, 400);
  // Low-fx tier pins a static --pulse once at startup. An unwritten variable invalidates every
  // calc() that uses it (the glow disappears); one fixed write is deterministic and free after.
  try { if (!fxRich()) setPulseVar(0.35); } catch (e) {}

  return {
    get, set, tag, stopAll, setEnabled, setVolume, unlock,
    tracks: THEME_TRACKS, findTrack, trackLabel,
    // Debug-only: live mixer state (context, per-deck position and gain).
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
      return { ctx: ctx ? ctx.state : null, unlocked, pendingStart, amb: snap("amb"), mus: snap("mus") };
    },
  };
})();

 // Legacy entry: themeSvc.audio get/set routed to the mixer (volume = amb deck).
const audio = {
  get: () => ({ enabled: getAudioEnabled(), volume: Mixer.get().amb.vol }),
  set: ({ enabled, volume } = {}) => {
    if (typeof enabled === "boolean") Mixer.setEnabled(enabled);
    const vol = clampVolume(volume);
    if (vol !== null) Mixer.setVolume("amb", vol);
    return Mixer.get();
  },
};

// set / panic / audio
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
  if (patch.chatPresent === "bubble" || patch.chatPresent === "doc") {
    try { localStorage.setItem(LS_CHAT, patch.chatPresent); } catch (e) {}
    applyChatPresent();
  } else if (patch.chatPresent === "auto" || patch.chatPresent === null) {
    try { localStorage.removeItem(LS_CHAT); } catch (e) {}
    applyChatPresent();
  }
  if (patch.accent) {
    try { localStorage.setItem(LS_ACCENT, patch.accent); } catch (e) {}
  }
  document.querySelectorAll('input[name="cfwTheme"]').forEach(r => {
    r.checked = (r.value === getStyle());
  });
  // Theme and audio are fully decoupled, and the old theme-to-nsfwLevel coupling is gone on purpose:
  // set() used to overwrite cfw_nsfw_mode_v1 on every call, which reset whatever the user had picked.
  // That key is a lock-state derived value now, written only by the unlock gate.
  window.dispatchEvent(new CustomEvent("theme:changed", { detail: getAll() }));
}

function panic() {
  Mixer.stopAll({ fade: false }); // panic: immediate mute, no fade tail
  set({ style: "minimal" });
}

const is = (scheme) => getScheme() === scheme;
const styles = () => THEME_STYLES.slice();
function subscribe(fn) {
  const h = (e) => fn(e.detail || getAll());
  window.addEventListener("theme:changed", h);
  return () => window.removeEventListener("theme:changed", h);
}

 // Re-apply without writing back: cloud sync feeds cfw_theme_v1 / cfw_theme_accent_v1 /
 // cfw_ui_overrides_v1 from another device, and set() would write LS again and race the sync.
function applyFromLS() {
  try { applyStyle(getStyle()); applyScheme(); } catch (e) {}
  try { applyBg(); } catch (e) {}
  try { window.dispatchEvent(new CustomEvent("theme:changed", { detail: getAll() })); } catch (e) {}
}

window.themeSvc = { get: getAll, set, is, styles, subscribe, panic, audio, applyBg, applyFromLS, wireAmbientCard };
 // Ambient mixer, the primary entry:
//   __ambient.set('amb'|'mus', id|null, vol?) sets a deck (null stops it) and returns state.
 //   __ambient.tag(deck, id?, vol?) is the agent-tag entry (voice aliases the breath pad).
//   __ambient.stopAll() / setEnabled(bool) / setVolume('amb'|'mus', 0~1)
//   __ambient.tracks -> { amb: [[id, label, file]...], mus: [...] }.
 // Event: window `ambient:changed`, detail = get().
window.__ambient = Mixer;

 // Apply the scheme immediately to reduce data-scheme flicker; the background too (it used to wait
 // for the editor's init).
try { applyBg(); } catch (e) {}
try { applyScheme(); } catch (e) {}
try { applyChatPresent(); } catch (e) {}

// ═══ wire Settings DOM ═══
 // The light/dark toggle, injected above the style list; shown only for dual-mode styles.
function refreshSchemeToggle() {
  const row = document.getElementById("cfwSchemeRow");
  if (!row) return;
  row.style.display = SCHEME_READY_SET.has(getStyle()) ? "" : "none";
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

// Transcript form: another orthogonal choice, shown for every style (doc mode works on all
// palettes through the --dg-* compatibility aliases in styles.css).
function refreshChatPresentToggle() {
  const row = document.getElementById("cfwChatPresentRow");
  if (!row) return;
  const stored = getStoredChatPresent();
  row.querySelectorAll("button[data-chat-present-val]").forEach((b) => {
    const v = b.getAttribute("data-chat-present-val");
    const on = (v === "auto" && !stored) || v === stored;
    b.classList.toggle("active", on);
  });
}

function ensureChatPresentToggle() {
  if (document.getElementById("cfwChatPresentRow")) { refreshChatPresentToggle(); return; }
  const firstRadio = document.querySelector('input[name="cfwTheme"]');
  if (!firstRadio) return;
  const opt = firstRadio.closest(".theme-option") || firstRadio.parentElement;
  const list = opt ? opt.parentElement : null;
  if (!list || !list.parentElement) return;
  const row = document.createElement("div");
  row.id = "cfwChatPresentRow";
  row.className = "scheme-toggle-row";
  row.innerHTML =
    '<span class="stg-label">聊天呈现</span>' +
    '<div class="scheme-seg">' +
      '<button type="button" data-chat-present-val="auto">跟随主题</button>' +
      '<button type="button" data-chat-present-val="bubble">气泡</button>' +
      '<button type="button" data-chat-present-val="doc">文档</button>' +
    '</div>';
  const schemeRow = document.getElementById("cfwSchemeRow");
  const host = list.parentElement;
  if (schemeRow && schemeRow.parentElement === host) host.insertBefore(row, schemeRow.nextSibling);
  else host.insertBefore(row, list);
  row.querySelectorAll("button[data-chat-present-val]").forEach((b) => {
    b.addEventListener("click", () => {
      set({ chatPresent: b.getAttribute("data-chat-present-val") });
      refreshChatPresentToggle();
    });
  });
  refreshChatPresentToggle();
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
  ensureChatPresentToggle();
  subscribe(refreshSchemeToggle);
  subscribe(refreshChatPresentToggle);
  wireAmbientCard();
}

 // Settings: the ambient card (dual-deck chips, volumes, master switch).
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
    Mixer.set(deck, cur.id === id ? null : id); // clicking the active chip stops that deck
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
  // The startup theme-to-level sync is gone on purpose: overwriting the level on every load is what
  // made user picks die on refresh (see the set() note).

  // The first interaction unlocks the AudioContext; ambient sound only works after a click.
  const unlockOnce = () => {
    Mixer.unlock();
    window.removeEventListener("pointerdown", unlockOnce);
    window.removeEventListener("keydown", unlockOnce);
    window.removeEventListener("touchstart", unlockOnce);
  };
  window.addEventListener("pointerdown", unlockOnce, { once: true });
  window.addEventListener("keydown",    unlockOnce, { once: true });
  window.addEventListener("touchstart", unlockOnce, { once: true });

 // Shift+Esc is the global panic: fade all audio and return to minimal.
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && e.shiftKey) {
      e.preventDefault();
      panic();
    }
  });

  wireAmbientCard();
});
})();

globalThis.THEME_STYLES = THEME_STYLES;
globalThis.PRIVATE_STYLES = PRIVATE_STYLES;
globalThis.THEME_DEFAULT_STYLE = THEME_DEFAULT_STYLE;
globalThis.THEME_LS_STYLE = THEME_LS_STYLE;
globalThis.THEME_LS_SCHEME = THEME_LS_SCHEME;
globalThis.THEME_LS_ACCENT = THEME_LS_ACCENT;
globalThis.AUDIO_LS_ENABLED = AUDIO_LS_ENABLED;
globalThis.AUDIO_LS_LEGACY_VOL = AUDIO_LS_LEGACY_VOL;
globalThis.AUDIO_LS_AMB = AUDIO_LS_AMB;
globalThis.AUDIO_LS_MUS = AUDIO_LS_MUS;
globalThis.NATIVE_SCHEME = NATIVE_SCHEME;
globalThis.SCHEME_READY = SCHEME_READY;
globalThis.THEME_LS_CHAT = THEME_LS_CHAT;
globalThis.CHAT_PRESENTS = CHAT_PRESENTS;
globalThis.CHAT_PRESENT_DEFAULT = CHAT_PRESENT_DEFAULT;
globalThis.NATIVE_CHAT = NATIVE_CHAT;
globalThis.resolveChatPresent = resolveChatPresent;
globalThis.AMB_TRACKS = AMB_TRACKS;
globalThis.MUS_TRACKS = MUS_TRACKS;
globalThis.THEME_TRACKS = THEME_TRACKS;
globalThis.VOICE_DEFAULT = VOICE_DEFAULT;
globalThis.trackFile = trackFile;
globalThis.findTrack = findTrack;
globalThis.trackLabel = trackLabel;
globalThis.resolveStyle = resolveStyle;
globalThis.resolveScheme = resolveScheme;
globalThis.AMB_DEFAULT_VOL = AMB_DEFAULT_VOL;
globalThis.MUS_DEFAULT_VOL = MUS_DEFAULT_VOL;
globalThis.initialAmbVolume = initialAmbVolume;
globalThis.readDeckState = readDeckState;
globalThis.deckJson = deckJson;
globalThis.audioEnabledFrom = audioEnabledFrom;
globalThis.clampVolume = clampVolume;
})();
