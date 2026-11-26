(function () {
/**
 * How a reply becomes something worth reading aloud.
 *
 * Three steps, in this order, and the order is the whole point:
 *   1. `stripVoiceTags` removes `[情绪:开心]`-shaped tags. The `speak` tool used to read them out loud.
 *   2. `cleanForSpeech` removes parentheticals and emphasis markers — stage directions, not speech.
 *   3. `splitSentences` cuts at sentence ends so each sentence can be synthesised separately.
 *
 * `||` counts as a sentence break. WeChat's "split into several bubbles" mode uses it as a separator;
 * after switching back to normal output the model sometimes still emits it, and treating it as a break
 * both avoids reading a vertical bar aloud and avoids reading the whole reply as one run-on sentence.
 *
 * A block that is only punctuation is dropped: the synthesiser would otherwise produce a click or an
 * empty clip per stray comma.
 *
 * No ports: this is pure string work, and it is deliberately separate from the service calls so the
 * splitting rules can be exercised without a TTS backend.
 *
 * Lock: `test/tts-text.test.mjs` (written with the migration).
 * @module services/media/tts-text
 */

/**
 * `[name:value]` with a short name and a short value — the voice-tag shape. The character class
 * excludes `:`/`：` from the name and digits/commas from it, so a timestamp or a list is not eaten.
 */
const VOICE_TAG_RE = /\[\s*[^\[\]:：\d,，\n]{1,8}\s*[:：]\s*[^\[\]\n]{0,12}\s*\]/g;

function text(value         )         {
  return value == null ? "" : typeof value === "string" ? value : String(value);
}

/** True when the string contains at least one voice tag. */
function hasVoiceTag(value         )          {
  VOICE_TAG_RE.lastIndex = 0;
  return VOICE_TAG_RE.test(text(value));
}

/** Removes voice tags and collapses the gaps they leave. */
function stripVoiceTags(value         )         {
  return text(value).replace(VOICE_TAG_RE, "").replace(/[ \t]{2,}/g, " ").trim();
}

/** Strips tags, then parentheticals (`（）`, `()`, `【】`) and `*emphasis*`, then collapses whitespace. */
function cleanForSpeech(value         )         {
  const withoutTags = stripVoiceTags(value);
  return withoutTags
    .replace(/（[^（）]*）/g, " ")
    .replace(/\([^()]*\)/g, " ")
    .replace(/【[^【】]*】/g, " ")
    .replace(/\*+([^*]+)\*+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Splits into sentences at `。！？!?…` and newlines, treating `||` as a break too.
 * @returns trimmed, non-empty pieces that contain at least one CJK character, letter or digit —
 * punctuation-only fragments are dropped rather than sent to the synthesiser.
 */
function splitSentences(value         )           {
  return text(value)
    .replace(/\s*\|+\s*/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .split(/(?<=[。！？!?…\n])/)
    .map(function (s) {
      return s.trim();
    })
    .filter(function (s) {
      return !!s && /[\u4e00-\u9fa5A-Za-z0-9]/.test(s);
    });
}

                             
                                       
                                         
                                         
                                           
 

function createTtsText()             {
  return {
    hasVoiceTag: hasVoiceTag,
    stripVoiceTags: stripVoiceTags,
    cleanForSpeech: cleanForSpeech,
    splitSentences: splitSentences,
  };
}

// ── Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name ──
// Text preparation before speaking (voice tags, parentheticals, emphasis, sentence splitting) lives
// in services/media/tts-text.ts; what stays here is config, probing, synthesis and playback.
// OwnChat local speech — GPT-SoVITS through the desktop shell's http_request proxy.
// Desktop only: the web has neither a local port 9880 nor the proxy, so this whole file no-ops.
// UI injected: a speak button at the bottom-left of every AI bubble. The "local speech" settings
// card moved to settings.js, so this file no longer injects it.
// Requires the tray's "speech - start service" (127.0.0.1:9880) and the http_request command (4.68.0+).
(function () {
  if (window.omniTtsSvc) return;

  var LS = {
    ref: "cfw_tts_ref_audio_v1",
    prompt: "cfw_tts_prompt_text_v1",
    auto: "cfw_tts_autoplay_v1",
    port: "cfw_tts_port_v1",
    enabled: "cfw_tts_enabled_v1",
    auxRefs: "cfw_tts_aux_refs_v1",
    weightsCur: "cfw_tts_weights_current_v1",
    speed: "cfw_tts_speed_v1",
  };
  // Text preparation (voice tags, parentheticals, emphasis, sentence splitting) is in
  // services/media/tts-text.ts; config, probing, synthesis and playback stay here.
  var svc = createTtsText();
  function hasVoiceTag(t) { return svc.hasVoiceTag(t); }
  function stripVoiceTags(t) { return svc.stripVoiceTags(t); }
  function cleanForSpeech(t) { return svc.cleanForSpeech(t); }
  function splitSentences(t) { return svc.splitSentences(t); }

  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  // Auxiliary reference audio paths for voice stability: a JSON array in LS, this device only.
  // synthWith feeds them next to the main reference as api_v2's aux_ref_audio_paths.
  function getAuxRefs() {
    try { var a = JSON.parse(lsGet(LS.auxRefs, "[]")); return Array.isArray(a) ? a.filter(function (x) { return x && typeof x === "string"; }) : []; }
    catch (e) { return []; }
  }
  function setAuxRefs(arr) { lsSet(LS.auxRefs, JSON.stringify(Array.isArray(arr) ? arr.filter(function (x) { return x && typeof x === "string"; }) : [])); }

  // The base weights chosen by "scan and hot-swap": paths relative to tts_dir, {sovits, gpt}.
  // Stored in LS, this device only. Two uses: re-select the dropdown after reopening settings or
  // restarting the app, and hot-swap once before the first synthesis (ensureSavedWeights) — without
  // it the choice looks forgotten, because api_v2 falls back to tts_infer.yaml defaults on restart.
  function getCurrentWeights() {
    try { var o = JSON.parse(lsGet(LS.weightsCur, "{}")); return (o && typeof o === "object") ? { sovits: o.sovits || "", gpt: o.gpt || "" } : { sovits: "", gpt: "" }; }
    catch (e) { return { sovits: "", gpt: "" }; }
  }
  function setCurrentWeights(w) { try { lsSet(LS.weightsCur, JSON.stringify({ sovits: (w && w.sovits) || "", gpt: (w && w.gpt) || "" })); } catch (e) {} }

  var inApp = !!(window.tauriSvc && window.tauriSvc.available());

  // Native speech config cache: pulled once from Rust's tts_get_config at startup (and before
  // opening settings or a preview) as the single source of truth. Rust keeps it in the local SQLite
  // settings namespace (tts_dir / tts_port / tts_autostart); only port and running matter here. On
  // the web there is no Tauri, so nativeCfg stays null and the local cache is used as before.
  var nativeCfg = null;
  async function refreshNativeCfg() {
    if (!inApp) return null;
    try {
      nativeCfg = await window.tauriSvc.invoke("tts_get_config");
    } catch (e) {
      nativeCfg = null;
      console.warn("[TTS] 读取原生配置失败,暂回退本地缓存", e);
    }
    return nativeCfg;
  }

  function cfg() {
    // Port comes from Rust (tts_get_config) as the single source of truth when available; the web,
    // or a config not fetched yet, falls back to the cached default of 9880.
    var nativePort = nativeCfg ? parseInt(nativeCfg.port, 10) : 0;
    return {
      port: nativePort || parseInt(lsGet(LS.port, "9880"), 10) || 9880,
      refAudioPath: lsGet(LS.ref, ""),
      promptText: lsGet(LS.prompt, ""),
      promptLang: "zh",
      textLang: "zh",
      autoplay: lsGet(LS.auto, "0") === "1",
      enabled: lsGet(LS.enabled, "1") === "1",
      auxRefs: getAuxRefs(),
      // Speed factor: 1.0 is the model's own pace, below 1 slower, above 1 faster. Anything out of
      // range or malformed returns 1.
      speed: (function(){ var v = parseFloat(lsGet(LS.speed, "1")); return (v >= 0.5 && v <= 2) ? v : 1; })(),
      // The next two are native-only; on the web they are null/empty and the UI says so.
      serviceRunning: nativeCfg ? !!nativeCfg.running : null,
      ttsDir: nativeCfg ? (nativeCfg.dir || "") : "",
    };
  }

  // Service probe: one HTTP request to the api_v2 port. Any response, even a 404, means it is
  // running; a refused connection or a timeout means it is not. Deliberately not based on "is this
  // the child process we spawned": a user starting 9880 from their own .bat leaves
  // tts_get_config.running false while the port is listening, and this corrects for that.
  async function probeService() {
    if (!inApp) return false;
    try {
      await window.tauriSvc.invoke("http_request", {
        method: "GET",
        url: "http://127.0.0.1:" + cfg().port + "/",
        headers: {},
      });
      return true;
    } catch (e) { return false; }
  }

  // Clean-up before speaking: drop narration and action markers, keep only what is spoken.
  // Filtered: full-width and ASCII parentheses, square brackets, *action* and **emphasis**.
  // One sentence through /tts, returning a playable Blob (null on failure). opts.refAudioPath and
  // opts.promptText fall back to the settings card's default single voice (cfg); per-sentence voice
  // switching just passes a different refAudioPath through this same entry.
  async function synthWith(opts) {
    opts = opts || {};
    var c = cfg();
    var text = opts.text == null ? "" : String(opts.text);
    if (!text) return null;
    var refAudioPath = opts.refAudioPath || c.refAudioPath;
    if (!refAudioPath) return null;
    await ensureSavedWeights(); // 重启后首次合成自动热切回上次选的底模(只尝试一次,失败下次再试)
    if (!_warmedUp) { if (await warmup()) _warmedUp = true; } // 本会话首句前先预热一发(没切过权重也兜底),吃掉半精度冷启动哑音
    var payload = {
      text: text,
      text_lang: c.textLang,
      ref_audio_path: refAudioPath,
      prompt_lang: c.promptLang,
      text_split_method: "cut0",
      media_type: "wav",
      streaming_mode: false,
      speed_factor: (opts.speed != null ? opts.speed : c.speed), // 语速:设置面板滑杆控制,情绪库等可逐句覆盖
    };
    var promptText = opts.promptText != null ? opts.promptText : c.promptText;
    if (promptText) payload.prompt_text = promptText;
    // Multi-reference stability: the main ref_audio_path plus any aux_ref_audio_paths; api_v2 blends
    // them, and the result drifts less than a single reference. opts.auxRefs falls back to
    // cfg.auxRefs, and an entry duplicating the main reference is dropped so it is not fed twice.
    var auxRefs = (opts.auxRefs != null ? opts.auxRefs : c.auxRefs) || [];
    if (Array.isArray(auxRefs) && auxRefs.length) {
      var aux = auxRefs.filter(function (p) { return p && p !== refAudioPath; });
      if (aux.length) payload.aux_ref_audio_paths = aux;
    }
    var res = await window.tauriSvc.invoke("http_request", {
      method: "POST",
      url: "http://127.0.0.1:" + c.port + "/tts",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.status !== 200 || ("" + (res.content_type || "")).indexOf("audio") < 0) {
      var _detail = "";
      try { _detail = atob(res.body_base64); } catch (e) {}
      try { console.warn("[TTS] 合成失败", res.status, _detail); } catch (e) {}
      // Running but refused: usually the chosen base weights do not match the GPT-SoVITS core.
      // Rethrow with api_v2's own message so callers such as the preview can show it honestly;
      // speak() catches it and does not break the turn.
      var _err = new Error("api_v2 /tts 返回 " + res.status + (_detail ? (": " + _detail) : ""));
      _err.status = res.status; _err.detail = _detail;
      throw _err;
    }
    var bin = atob(res.body_base64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: res.content_type || "audio/wav" });
  }
  // Default single-voice synthesis: the reference audio from the settings card, i.e. synthWith with
  // no override.
  function synth(sentence) { return synthWith({ text: sentence }); }

  // Hot-swapping base weights (GPT-SoVITS). No tts_infer.yaml edit and no restart: call api_v2's
  // /set_sovits_weights (.pth, version first) then /set_gpt_weights (.ckpt) through the same
  // http_request channel /tts uses. "Scan installed" lists them; switchWeights swaps on click.

  // Scan installed weights the way the WebUI does: call native tts_list_models, which walks
  // GPT_weights*/SoVITS_weights* under the GPT-SoVITS directory and returns paths relative to
  // tts_dir. Desktop only.
  async function listInstalledModels() {
    if (!inApp) return { gpt: [], sovits: [] };
    try { return await window.tauriSvc.invoke("tts_list_models"); }
    catch (e) { return { gpt: [], sovits: [], error: String((e && e.message) || e) }; }
  }
  // Hot-swap to the given weight paths directly (no model-list write, no "current" bookkeeping),
  // for the scan dropdown's click-to-swap.
  async function switchWeights(opts) {
    opts = opts || {};
    if (!inApp) return { ok: false, reason: "仅桌面版可切换底模" };
    var sovits = opts.sovits || "", gpt = opts.gpt || "";
    if (!sovits && !gpt) return { ok: false, reason: "未提供任何权重路径" };
    var base = "http://127.0.0.1:" + cfg().port;
    async function hit(path, wp) {
      var res = await window.tauriSvc.invoke("http_request", {
        method: "GET",
        url: base + path + "?weights_path=" + encodeURIComponent(wp),
        headers: {},
      });
      if (!res || res.status !== 200) {
        try { console.warn("[TTS] 切权重失败", path, res && res.status, atob(res.body_base64)); } catch (e) {}
        return false;
      }
      return true;
    }
    try {
      if (sovits && !(await hit("/set_sovits_weights", sovits))) return { ok: false, reason: "SoVITS(.pth) 切换失败 — 检查路径/服务是否在跑" };
      if (gpt && !(await hit("/set_gpt_weights", gpt))) return { ok: false, reason: "GPT(.ckpt) 切换失败 — 检查路径" };
      setCurrentWeights({ sovits: sovits, gpt: gpt }); // 记住选择:重开面板回显 + 重启后自动切回这套
      _savedWeightsApplied = true;                     // 本会话已应用,ensureSavedWeights 不再覆盖
      _warmedUp = false;                               // 换了底模 → 旧热度作废,立刻按新底模重新预热
      if (await warmup()) _warmedUp = true;            // 冷启动预热:吃掉切完权重的第一发哑音,试听/朗读首句即有声
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
  }

  // After an app or service restart api_v2 falls back to tts_infer.yaml defaults, so the previously
  // chosen weights would be lost. Before the first synthesis this silently swaps them back, so the
  // user does not have to pick again.
  // Cold-start warm-up, which cures the silent first utterance of half-precision bases such as
  // v2ProPlus: an is_half:true base often produces silence (or NaN/empty from the first CUDA kernel
  // run) right after a weight swap or a fresh start. One very short synthesis is fired and discarded,
  // so the silent shot is spent here and the first real sentence has sound.
  // Main reference only, minimal text, never queued for playback, errors swallowed — pure warm-up,
  // invisible to the user. Any response, even silence or a non-200, counts as warm (returns true).
  var _warmedUp = false;
  async function warmup() {
    if (!inApp) return false;
    var c = cfg();
    if (!c.refAudioPath) return false; // 没设主参考没法合成,等填了再切权重/合成时预热
    try {
      var payload = {
        text: "嗯",
        text_lang: c.textLang,
        ref_audio_path: c.refAudioPath,
        prompt_lang: c.promptLang,
        text_split_method: "cut0",
        media_type: "wav",
        streaming_mode: false,
      };
      if (c.promptText) payload.prompt_text = c.promptText;
      var res = await window.tauriSvc.invoke("http_request", {
        method: "POST",
        url: "http://127.0.0.1:" + c.port + "/tts",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return !!res;
    } catch (e) { return false; }
  }

  // One attempt only: if the service is not up yet the swap fails and stays unapplied, retried on
  // the next synthesis. A manual "apply selected" already set the flag, and this never overrides it.
  var _savedWeightsApplied = false;
  async function ensureSavedWeights() {
    if (!inApp || _savedWeightsApplied) return;
    var w = getCurrentWeights();
    if (!w || (!w.sovits && !w.gpt)) { _savedWeightsApplied = true; return; }
    try {
      var r = await switchWeights(w); // 成功会自行置 _savedWeightsApplied=true 并持久化
      if (!(r && r.ok)) { /* 服务未就绪,下次合成再试 */ }
    } catch (e) {}
  }

  // Native "choose a file" dialog for reference audio (.wav), returning an absolute path (null on
  // cancel or failure). Desktop only: the web has no tts_pick_file command, and an older .exe that
  // does not register it is rejected by the ACL — caught and returned as null, and the caller tells
  // the user to update.
  async function pickFile() {
    if (!inApp) return null;
    try { return await window.tauriSvc.invoke("tts_pick_file"); }
    catch (e) { console.warn("[TTS] 选择文件失败(可能是旧版 .exe 未含 tts_pick_file 命令)", e); return null; }
  }

  // Native "choose files" dialog, multi-select .wav, returning an array of paths (empty on failure).
  // Prefers the multi-select command tts_pick_files and falls back to single-select tts_pick_file
  // wrapped in a one-element array, so multi-reference voice selection works on an older .exe too —
  // new versions pick several at once, old ones degrade to one per click.
  async function pickFiles() {
    if (!inApp) return [];
    try {
      var arr = await window.tauriSvc.invoke("tts_pick_files");
      return Array.isArray(arr) ? arr.filter(function (p) { return p && typeof p === "string"; }) : [];
    } catch (e) {
      try { var p = await window.tauriSvc.invoke("tts_pick_file"); return p ? [p] : []; }
      catch (e2) { console.warn("[TTS] 多选文件失败(旧版 .exe 无 tts_pick_files/tts_pick_file)", e2); return []; }
    }
  }

  // Sequential playback queue, so sentences never overlap.
  var queue = Promise.resolve();
  var curAudio = null;
  var curWebSrc = null;
  var _audioCtx = null;
  function getAudioCtx() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      if (!_audioCtx) _audioCtx = new Ctx();
      if (_audioCtx.state === "suspended") { try { _audioCtx.resume(); } catch (e) {} }
      return _audioCtx;
    } catch (e) { return null; }
  }
  // Spatial audio (tts-spatial*.js) was removed together with the multi-emotion system; this is a
  // direct connection now.
  function connectWithSpace(ctx, src) {
    try { src.connect(ctx.destination); } catch (e2) {}
  }
  // Web Audio playback: decode PCM, then play (stereo reverb when spatial audio was on; that path
  // is gone). A decode failure rejects.
  // The reason this path exists at all: some WebViews report play() success on <audio>+blob: while
  // producing no sound, so decoding is also the fallback that actually plays.
  function playViaWebAudio(blob) {
    return new Promise(function (resolve, reject) {
      var ctx = getAudioCtx();
      if (!ctx) { reject(new Error('AudioContext 不可用')); return; }
      blob.arrayBuffer().then(function (buf) {
        ctx.decodeAudioData(buf.slice(0), function (audioBuf) {
          try {
            var src = ctx.createBufferSource();
            src.buffer = audioBuf;
            connectWithSpace(ctx, src);
            curWebSrc = src;
            src.onended = function () { if (curWebSrc === src) curWebSrc = null; resolve(); };
            src.start(0);
          } catch (e) { reject(e); }
        }, function (e) { reject(e || new Error('音频解码失败')); });
      }).catch(reject);
    });
  }
  // Playback through <audio> only; rejects on failure, and the caller decides whether to fall back.
  function playViaAudioEl(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var audio = new Audio(url);
      curAudio = audio;
      var settled = false;
      function done(success, e) {
        if (settled) return; settled = true;
        try { URL.revokeObjectURL(url); } catch (er) {}
        if (curAudio === audio) curAudio = null;
        if (success) resolve(); else reject(e || new Error('<audio> 播放出错'));
      }
      audio.onended = function () { done(true); };
      audio.onerror = function () { done(false, new Error('<audio> 播放出错')); };
      audio.play().then(function () {}, function (e) { done(false, e); });
    });
  }
  // Play an already-synthesised Blob. With spatial audio gone there is one order: <audio> first,
  // Web Audio on decode failure.
  function playBlob(blob) {
    return playViaAudioEl(blob).catch(function () { return playViaWebAudio(blob); });
  }
  // Append a synthesised Blob to the sequential queue (synthesise here, enqueuePlay serialises it,
  // so clips never overlap). The queue swallows errors internally so later sentences keep playing,
  // while the returned promise still surfaces the failure for callers such as the preview.
  function enqueuePlay(blob) {
    if (!blob) return queue;
    var p = queue.then(function () { return playBlob(blob); });
    queue = p.catch(function () {});
    return p;
  }

  function speak(text) {
    var c = cfg();
    if (!c.enabled || !inApp) return;
    if (!c.refAudioPath) { console.warn("[TTS] 未设置参考音频路径 → 打开「设置 · 本地语音」填一下"); return; }
    var parts = splitSentences(cleanForSpeech(text));
    if (!parts.length) return queue;
    // Synthesise one sentence ahead (pipeline depth 1): while this one plays, the next is already
    // being synthesised, which removes the silent gap between sentences. Synthesis is async, so it
    // starts when the current clip starts playing, not after it ends.
    var ahead = synth(parts[0]);
    parts.forEach(function (s, i) {
      queue = queue.then(async function () {
        var cur = ahead;                                       // 运行时取「本句」的合成(上一步已预起)
        if (i + 1 < parts.length) ahead = synth(parts[i + 1]); // 立刻预起下一句,与本句播放重叠
        var b = null;
        try { b = await cur; } catch (e) { console.warn("[TTS] 合成出错", e); }
        try { if (b) await playBlob(b); } catch (e) { console.warn("[TTS] 播放出错", e); }
      });
    });
    return queue;
  }
  function stop() {
    // Also halt the cloud queue: the speak button and the panic path call this before autoSpeak,
    // and leaving a cloud clip playing would overlap the next reply.
    try { if (window.cloudTtsSvc) window.cloudTtsSvc.stop(); } catch (e) {}
    queue = Promise.resolve();
    if (curAudio) { try { curAudio.pause(); } catch (e) {} curAudio = null; }
    if (curWebSrc) { try { curWebSrc.stop(); } catch (e) {} curWebSrc = null; }
    // Sentences still being synthesised are unlinked too: on panic or a track switch they must not
    // play later.

  }

  // Whether this queue is still playing — what the autopilot's gateOnTts uses as "finished reading".
  function isPlaying() { return !!curAudio; }
  // Resolves once everything already queued has been read (the autopilot's "read one passage then
  // continue"); an empty queue resolves immediately.
  function whenIdle() { return queue.catch(function () {}); }

  // The single entry point for auto-read and the speak button. One voice only since the
  // multi-emotion switcher was removed; a future TTS API that splits by emotion can branch inside
  // speak() on refAudioPath — the tag parsing stays in stripVoiceTags.
  function autoSpeak(text) {
    // Cloud speech (2026-11-25): the settings card in the model-API category opts in per device.
    // When on, the same speak button and auto-read path use the Worker proxy instead of the local
    // GPT-SoVITS port; the local engine stays untouched for users who switch it back off.
    try {
      var cloud = window.cloudTtsSvc;
      if (cloud && cloud.cfg().enabled) return cloud.speak(text);
    } catch (e) {}
    return speak(text);
  }

  var omni = { speak: speak, stop: stop, cfg: cfg, refreshNativeCfg: refreshNativeCfg, probeService: probeService, isPlaying: isPlaying, whenIdle: whenIdle, synthWith: synthWith, enqueuePlay: enqueuePlay, splitSentences: splitSentences, cleanForSpeech: cleanForSpeech, getAuxRefs: getAuxRefs, setAuxRefs: setAuxRefs, listInstalledModels: listInstalledModels, switchWeights: switchWeights, getCurrentWeights: getCurrentWeights, applySavedWeights: ensureSavedWeights, warmup: warmup, pickFile: pickFile, pickFiles: pickFiles };
  // Cloud speech (2026-11-25) is loaded before this file and exposed under a non-frozen name. Fold it
  // into the single frozen handle so callers need only one speech object; no new window.__* is added.
  try { if (window.cloudTtsSvc) omni.cloud = window.cloudTtsSvc; } catch (e) {}
  window.omniTtsSvc = omni;

  // Voice/scene tag protocol — the single implementation since 2026-10-06.
  // Shape: `[key:value]`. A key is at most 8 characters and MUST NOT contain digits or commas; a
  // value is at most 12. Both the ASCII and the full-width colon are accepted.
  // Why digits and commas are barred from keys: the ENI bases force a scene line at the top of the
  // reply, such as `[深夜,海边,00:12]`. The old rule read that as key="深夜,海边,00" value="12" and
  // stripped the whole block, which users explicitly asked to keep. Real tags like `[害羞:开心]` or
  // `[情绪:3]` are still stripped, and brackets without a colon (emoji codes, `[选项]`,
  // `[日期,地点,时间]`) never matched anyway.
  // Two call sites only: hiding in the display layer (hideVoiceTags) and stripping before speaking
  // (cleanForSpeech). Whether it stays is a future agent decision — nothing consumes it today, since
  // the multi-emotion switcher went away on 2026-10-06. Kept because (1) a user preset can still make
  // the model emit tags and they must not pollute the bubble, and (2) a future TTS API can reuse the
  // same shape.

  if (!inApp) return; // 网页版:不注入任何 UI,纯空跳过

  // The readable text of one AI message, for speaking. The display layer already cut the tags, with
  // the original kept in dataset.ttsRaw, and speaking prefers that original: that way a future TTS
  // API can still see the tags the model produced, while cleanForSpeech does the stripping.
  function rowText(row) {
    if (!row) return "";
    var b = row.querySelector(".bubble");
    if (!b) return "";
    var raw = b.dataset ? b.dataset.ttsRaw : "";
    var t = (raw != null && raw !== "") ? raw : (b.textContent || "");
    // Choice-signal cleaning: strip [选项]...[/选项] / [opt]...[/opt] before speaking, so the
    // clickable options are not read aloud. Only the spoken text is cleaned, never the DOM — hiding
    // them and rendering them as chips is choices.js's job, which reads bubble.textContent directly.
    t = t.replace(/\[选项\][\s\S]*?\[\/选项\]/g, "").replace(/\[opt\][\s\S]*?\[\/opt\]/gi, "");
    return t.trim();
  }

  // Inject the speak button into an AI bubble.
  var SPK_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5v5h3.2L11.5 18V6L7.2 9.5z"/><path d="M15 8.6a4 4 0 0 1 0 6.8"/><path d="M17.3 6a7 7 0 0 1 0 12"/></svg>';
  function injectBtn(row) {
    if (!row || row.classList.contains("user") || row.classList.contains("pacing-typing")) return;
    if (row.querySelector(".omni-tts-btn")) return;
    var content = row.querySelector(".content");
    if (!content) return;
    var btn = document.createElement("button");
    btn.className = "omni-tts-btn";
    btn.type = "button";
    btn.title = "朗读这条消息";
    btn.setAttribute("aria-label", "朗读");
    btn.innerHTML = SPK_SVG;
    btn.style.cssText = "display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;margin-top:4px;padding:0;border:none;border-radius:6px;background:transparent;color:inherit;opacity:.5;cursor:pointer;transition:opacity .15s,background .15s;";
    btn.addEventListener("mouseover", function () { btn.style.opacity = "1"; btn.style.background = "rgba(127,127,127,.14)"; });
    btn.addEventListener("mouseout", function () { btn.style.opacity = ".5"; btn.style.background = "transparent"; });
    btn.addEventListener("click", function () { hideVoiceTags(row); var t = rowText(row); if (t) { stop(); autoSpeak(t); } });
    var stats = content.querySelector(".stats");
    if (stats) content.insertBefore(btn, stats); else content.appendChild(btn);
  }
  function scanAll() {
    var rows = document.querySelectorAll("#chat .row.ai");
    for (var i = 0; i < rows.length; i++) { injectBtn(rows[i]); hideVoiceTags(rows[i]); }
  }

  // Whether an AI bubble can be read yet: streaming has finished and no typing animation is running.
  function isReadable(row) {
    if (!row || row.classList.contains("pacing-typing")) return false;
    if (row.dataset && row.dataset.streaming === "1") return false;
    var b = row.querySelector(".bubble");
    if (b && b.classList.contains("wechat-typing")) return false;
    return true;
  }
  function markSeen(row) { if (row && row.dataset) row.dataset.omniTtsAuto = "1"; }


  // Tags hidden from view but still speakable: once a bubble finishes streaming, the tags are cut
  // from the DISPLAYED text and the original is stored in bubble.dataset.ttsRaw, which speaking
  // reads. Since 2026-10-06 this no longer depends on an emotion library existing — the protocol
  // stands on its own.
  function hideVoiceTags(row) {
    try {
      if (!row) return;
      if (!isReadable(row)) return;
      var b = row.querySelector(".bubble");
      if (!b || !b.dataset || b.dataset.ttsTagHidden === "1") return;
      if (b.children && b.children.length) return; // innerHTML 渲染的 agent/历史气泡不动,免破坏排版
      var raw = b.textContent || "";
      if (!hasVoiceTag(raw)) { b.dataset.ttsTagHidden = "1"; return; }
      var shown = stripVoiceTags(raw);
      b.dataset.ttsRaw = raw;        // 朗读取原文
      b.dataset.ttsTagHidden = "1";
      if (shown && shown !== raw) b.textContent = shown; // 显示去标签
    } catch (e) {}
  }

  // Auto-read: speak every AI bubble that has finished forming and has not been read yet, in DOM
  // order. WeChat-style consecutive messages split one reply into several bubbles (.row.ai), and the
  // old logic only read the last one, skipping everything before it. Now it walks DOM order from the
  // first bubble and stops at one that is still typing, so order is preserved and nothing is
  // skipped. speak() queues internally, so clips never overlap.
  var autoTimer = null;
  function maybeAutoplay() {
    var cloudOn = false;
    try { cloudOn = !!(window.cloudTtsSvc && window.cloudTtsSvc.cfg().enabled); } catch (e) {}
    if (!cfg().autoplay && !cloudOn) return;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(function () {
      var rows = document.querySelectorAll("#chat .row.ai");
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        if (row.dataset && row.dataset.omniTtsAuto === "1") continue;
        if (!isReadable(row)) break;
        markSeen(row);
        hideVoiceTags(row);
        var t = rowText(row);
        if (t) autoSpeak(t);
      }
    }, 500);
  }

  // The TTS settings card moved to settings.js and is mounted there. The old
  // injectSettingsCard_REMOVED dead code went away in 4.82; git history has it if ever needed.

  async function boot() {
    var chat = document.getElementById("chat");
    if (!chat) { setTimeout(boot, 500); return; }
    // Pull the native speech config once at startup (port / running state); on failure fall back to
    // the local cache without blocking UI injection.
    await refreshNativeCfg();
    // Mark existing AI bubbles as already read at startup, so auto-read does not read the entire
    // history — only replies that arrive after boot.
    var existing = chat.querySelectorAll(".row.ai");
    for (var i = 0; i < existing.length; i++) markSeen(existing[i]);
    scanAll();
    try {
      var mo = new MutationObserver(function () { scanAll(); maybeAutoplay(); });
      mo.observe(chat, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-streaming"] });
    } catch (e) {}
    // The TTS settings card is mounted by settings.js.
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

globalThis.hasVoiceTag = hasVoiceTag;
globalThis.stripVoiceTags = stripVoiceTags;
globalThis.cleanForSpeech = cleanForSpeech;
globalThis.splitSentences = splitSentences;
globalThis.createTtsText = createTtsText;
})();
