// public/shared/tts.js
// OwnChat 本地语音 (GPT-SoVITS via 桌面壳 http_request 代理)
// 仅桌面 App 内生效(网页版没有本地 9880、也没有 http_request 代理 → 整个文件空跳过)。
// 注入 UI:① 每条 AI 回复气泡左下角的 🔊 朗读按钮;②「本地语音」设置卡已迁移至 settings.js(本文件不再自注入)。
// 依赖:托盘已「语音·启动服务」(127.0.0.1:9880) + 4.68.0 的 http_request 命令
(function () {
  if (window.__omniTTS) return;

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
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  // 多参考(稳定音色)辅助参考音路径列表:JSON 数组存 LS,仅本设备。synthWith 合成时随主参考一起喂给 api_v2 的 aux_ref_audio_paths。
  function getAuxRefs() {
    try { var a = JSON.parse(lsGet(LS.auxRefs, "[]")); return Array.isArray(a) ? a.filter(function (x) { return x && typeof x === "string"; }) : []; }
    catch (e) { return []; }
  }
  function setAuxRefs(arr) { lsSet(LS.auxRefs, JSON.stringify(Array.isArray(arr) ? arr.filter(function (x) { return x && typeof x === "string"; }) : [])); }

  // 上次「扫描热切」选定的底模权重(相对 tts_dir 路径):{sovits, gpt}。存 LS,仅本设备。
  // 用途:① 重开设置面板/重启 App 后回显并预选下拉,免得看着像「没记住」;
  //      ② App/服务重启后 api_v2 会回落 tts_infer.yaml 默认底模,这里在首次合成前按保存值
  //         自动热切一次(ensureSavedWeights),让选过的底模「粘住」,不用每次重选。
  function getCurrentWeights() {
    try { var o = JSON.parse(lsGet(LS.weightsCur, "{}")); return (o && typeof o === "object") ? { sovits: o.sovits || "", gpt: o.gpt || "" } : { sovits: "", gpt: "" }; }
    catch (e) { return { sovits: "", gpt: "" }; }
  }
  function setCurrentWeights(w) { try { lsSet(LS.weightsCur, JSON.stringify({ sovits: (w && w.sovits) || "", gpt: (w && w.gpt) || "" })); } catch (e) {} }

  var inApp = !!(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke);

  // App 内的原生语音配置缓存:启动时(及打开设置/试听前)从 Rust 的 tts_get_config 拉一次,作为单一可信源。
  // Rust 把配置存在本地 SQLite 的 settings 命名空间(tts_dir/tts_port/tts_autostart),这里只关心与发声相关的
  // 「端口 / 服务是否在跑」。网页版没有 Tauri,nativeCfg 恒为 null → 自动回退本地缓存,行为不变。
  var nativeCfg = null;
  async function refreshNativeCfg() {
    if (!inApp) return null;
    try {
      nativeCfg = await window.__TAURI__.core.invoke("tts_get_config");
    } catch (e) {
      nativeCfg = null;
      console.warn("[TTS] 读取原生配置失败,暂回退本地缓存", e);
    }
    return nativeCfg;
  }

  function cfg() {
    // 端口以 Rust(tts_get_config)为单一可信源:App 内优先用它;网页版 / 尚未拉到时回退本地缓存默认 9880。
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
      // 语速(speed_factor):1.0=模型原速,<1 变慢,>1 变快。越界/非法值一律回 1。
      speed: (function(){ var v = parseFloat(lsGet(LS.speed, "1")); return (v >= 0.5 && v <= 2) ? v : 1; })(),
      // 以下两项仅 App 内有效(来自原生配置),网页版为 null/空,供 UI 据此提示。
      serviceRunning: nativeCfg ? !!nativeCfg.running : null,
      ttsDir: nativeCfg ? (nativeCfg.dir || "") : "",
    };
  }

  // 服务探活(真连端口):直接打一发 HTTP 到 api_v2 端口,有任何响应(哪怕 404)即视为「在跑」,
  // 连接被拒/超时即「没起来」。不依赖「是不是 App 自己 spawn 的子进程」—— 用户用自己的 .bat /
  // 外部方式启动 9880 时,tts_get_config.running 恒 false,但端口其实在听,这里据实测端口纠正。
  async function probeService() {
    if (!inApp) return false;
    try {
      await window.__TAURI__.core.invoke("http_request", {
        method: "GET",
        url: "http://127.0.0.1:" + cfg().port + "/",
        headers: {},
      });
      return true;
    } catch (e) { return false; }
  }

  // 朗读前清洗:去掉旁白/动作等不该念出来的标记内容,只保留"说出来的话"。
  // 过滤:全角括号（）、半角括号()、方括号【】、星号包裹 *动作* / **强调**。
  function cleanForSpeech(text) {
    // 2026-10-06: 先剥语音标签 —— agent 的 speak 工具直接调 speak()，以前会把 [情绪:开心] 念出来。
    text = stripVoiceTags(text);
    return String(text || "")
      .replace(/（[^（）]*）/g, " ")
      .replace(/\([^()]*\)/g, " ")
      .replace(/【[^【】]*】/g, " ")
      .replace(/\*+([^*]+)\*+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // 按句切(句末标点处断开),并把微信连发分隔符 || 也当作断句点;丢掉纯标点/空块。
  // 说明:微信连发模式靠 || 把一条回复拆成多个气泡;切回默认输出后模型有时仍残留 ||,
  // 这里统一当成断句,既不会把"竖线"念出来,也不会把整段连成一句串读。
  function splitSentences(text) {
    return String(text || "")
      .replace(/\s*\|+\s*/g, "\n")
      .replace(/[^\S\n]+/g, " ")
      .split(/(?<=[。！？!?…\n])/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s && /[\u4e00-\u9fa5A-Za-z0-9]/.test(s); });
  }

  // 调一次 /tts 合成单句 → 可播放 Blob(失败返回 null)。
  // opts.refAudioPath / opts.promptText 缺省时回退设置面板里的默认单音色(cfg);
  // 逐句切参考音只需传入不同的 refAudioPath 复用这个入口（多情绪系统已删，接口留着）。
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
    // 多参考(稳定音色):主参考 ref_audio_path + 若干辅助 aux_ref_audio_paths,api_v2 融合多条参考的音色,
    // 比单条更稳、不易被某条口癖/情绪带偏。opts.auxRefs 缺省回退设置面板里的默认辅助参考(cfg.auxRefs);
    // 把与主参考重复的那条剔掉,避免重复喂入。
    var auxRefs = (opts.auxRefs != null ? opts.auxRefs : c.auxRefs) || [];
    if (Array.isArray(auxRefs) && auxRefs.length) {
      var aux = auxRefs.filter(function (p) { return p && p !== refAudioPath; });
      if (aux.length) payload.aux_ref_audio_paths = aux;
    }
    var res = await window.__TAURI__.core.invoke("http_request", {
      method: "POST",
      url: "http://127.0.0.1:" + c.port + "/tts",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.status !== 200 || ("" + (res.content_type || "")).indexOf("audio") < 0) {
      var _detail = "";
      try { _detail = atob(res.body_base64); } catch (e) {}
      try { console.warn("[TTS] 合成失败", res.status, _detail); } catch (e) {}
      // 服务在跑但合成被拒(常见:所选底模/版本与 GPT-SoVITS 核心不兼容)→ 抛出带 api_v2 原始报错的 Error,
      // 供试听等调用方如实展示;speak() 已 try/catch,不会因此中断。
      var _err = new Error("api_v2 /tts 返回 " + res.status + (_detail ? (": " + _detail) : ""));
      _err.status = res.status; _err.detail = _detail;
      throw _err;
    }
    var bin = atob(res.body_base64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: res.content_type || "audio/wav" });
  }
  // 默认单音色合成(读设置面板里那条参考音)= synthWith 不带覆盖
  function synth(sentence) { return synthWith({ text: sentence }); }

  // ── 底模(GPT-SoVITS 权重)热切换 ──
  // 不改 tts_infer.yaml、不重启服务,直接打 api_v2 /set_sovits_weights(.pth,带 version 先切)+ /set_gpt_weights(.ckpt),
  // 走桌面壳 http_request 代理(与 /tts 同一通道)。统一由「扫描已装」列出 → switchWeights 即点即切,不再保留手填命名条目。

  // 扫描已安装权重(仿 WebUI 自动列表):调原生 tts_list_models 扫 GPT-SoVITS 目录下
  // GPT_weights*/SoVITS_weights* 里的 .ckpt/.pth,返回相对 tts_dir 的路径数组。仅桌面版。
  async function listInstalledModels() {
    if (!inApp) return { gpt: [], sovits: [] };
    try { return await window.__TAURI__.core.invoke("tts_list_models"); }
    catch (e) { return { gpt: [], sovits: [], error: String((e && e.message) || e) }; }
  }
  // 直接按给定权重路径热切(不写模型清单/不记当前选择),供"扫描下拉"即点即切。
  async function switchWeights(opts) {
    opts = opts || {};
    if (!inApp) return { ok: false, reason: "仅桌面版可切换底模" };
    var sovits = opts.sovits || "", gpt = opts.gpt || "";
    if (!sovits && !gpt) return { ok: false, reason: "未提供任何权重路径" };
    var base = "http://127.0.0.1:" + cfg().port;
    async function hit(path, wp) {
      var res = await window.__TAURI__.core.invoke("http_request", {
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

  // App/服务重启后 api_v2 会回落到 tts_infer.yaml 的默认底模 → 之前选过的底模等于丢了。
  // 这里在首次合成前(synthWith 调用)按保存的选择静默热切一次,让选过的底模自动恢复,无需每次手动重选。
  // ── 冷启动预热(v2ProPlus 等半精度底模「切完第一发」哑音的根治) ──
  // is_half:true 的底模在切完权重 / 服务刚起来后,第一发推理常出哑音(CUDA 半精度首次 kernel 跑出 NaN/空)。
  // 这里打一发极短合成并丢弃,把冷启动那一发哑音吃掉,之后第一句真合成就有声。
  // 仅主参考、极短文本、不入播放队列、错误吞掉 —— 纯预热,对用户无感。拿到任何响应(哪怕哑音/非200)即算已热 → 返回 true。
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
      var res = await window.__TAURI__.core.invoke("http_request", {
        method: "POST",
        url: "http://127.0.0.1:" + c.port + "/tts",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return !!res;
    } catch (e) { return false; }
  }

  // 只尝试一次;若此刻服务还没起来(切换失败),保持未应用,下次合成再试。手动「应用所选」成功后会置位,不再覆盖。
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

  // 弹原生「选择文件」对话框选参考音频(.wav),返回绝对路径(取消/失败返回 null)。
  // 仅桌面版:网页版没有 tts_pick_file 命令;跑旧版 .exe(命令未注册/未授权)会被 ACL 拒,这里捕获返回 null,由调用方提示更新。
  async function pickFile() {
    if (!inApp) return null;
    try { return await window.__TAURI__.core.invoke("tts_pick_file"); }
    catch (e) { console.warn("[TTS] 选择文件失败(可能是旧版 .exe 未含 tts_pick_file 命令)", e); return null; }
  }

  // 弹原生「选择文件」对话框,允许一次多选 .wav,返回路径数组(取消/失败返回 [])。
  // 优先用多选命令 tts_pick_files;旧版 .exe 未含该命令(ACL 拒/未注册)时自动回落单选 tts_pick_file 包成单元素数组,
  // 让「稳定音色·多参考」的「选择文件」在新旧 .exe 上都能用(新版可一次多选,旧版退化为一次一条)。
  async function pickFiles() {
    if (!inApp) return [];
    try {
      var arr = await window.__TAURI__.core.invoke("tts_pick_files");
      return Array.isArray(arr) ? arr.filter(function (p) { return p && typeof p === "string"; }) : [];
    } catch (e) {
      try { var p = await window.__TAURI__.core.invoke("tts_pick_file"); return p ? [p] : []; }
      catch (e2) { console.warn("[TTS] 多选文件失败(旧版 .exe 无 tts_pick_files/tts_pick_file)", e2); return []; }
    }
  }

  // 顺序播放队列(避免多句重叠)
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
  // 2026-10-06: 空间音效（tts-spatial*.js）随多情绪系统一并删除 —— 这里只做直连。
  function connectWithSpace(ctx, src) {
    try { src.connect(ctx.destination); } catch (e2) {}
  }
  // Web Audio 播放:解码 PCM →(空间音效开则)立体声混响 → 播放。解码失败 reject。
  // 旧注:某些 WebView 里 <audio>+blob: 会「play() 成功却没声」,这条路同时兼作兜底解码播放。
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
  // 仅用 <audio> 播放(失败 reject;由 playBlob 决定是否回落 Web Audio)。
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
  // 播一个已合成的 Blob:
  // 2026-10-06: 空间音效删除后只剩一条路径 —— <audio> 优先、解码失败回落 Web Audio。
  function playBlob(blob) {
    return playViaAudioEl(blob).catch(function () { return playViaWebAudio(blob); });
  }
  // 把已合成的 Blob 接到顺序播放队列尾部（自己合成 → enqueuePlay 串行播，不重叠）。
  // 队列内部吞错(catch)保证后续句子继续播;返回的 promise 仍透出错误,供试听等调用方如实判断成败。
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
    // 提前一句合成(pipeline 深度 1):本句播放时下一句已在合成,播完即接上,
    // 消除「等下一句合成」造成的句间静音空档。synth 是异步的,在上一句辘播放时就起下一句。
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
    queue = Promise.resolve();
    if (curAudio) { try { curAudio.pause(); } catch (e) {} curAudio = null; }
    if (curWebSrc) { try { curWebSrc.stop(); } catch (e) {} curWebSrc = null; }
    // 情绪音库还在合成中的句子也一并断链(Panic / 切歌时不要再追播)

  }

  // 这段队列是否还在播(供自驱 gateOnTts 判断 "读完没")
  function isPlaying() { return !!curAudio; }
  // 当前已入队的朗读全部读完后 resolve(自驱 "读完一段再续" 用;队列为空则立即 resolve)
  function whenIdle() { return queue.catch(function () {}); }

  // 自动朗读 / 🔊 按钮统一入口（2026-10-06: 多情绪切换系统删除后只剩单音色；将来接 TTS API 要分情绪，
  // 在 speak() 里按 refAudioPath 切即可 —— 标签协议的解析保留在 stripVoiceTags）。
  function autoSpeak(text) {
    return speak(text);
  }

  window.__omniTTS = { speak: speak, stop: stop, cfg: cfg, refreshNativeCfg: refreshNativeCfg, probeService: probeService, isPlaying: isPlaying, whenIdle: whenIdle, synthWith: synthWith, enqueuePlay: enqueuePlay, splitSentences: splitSentences, cleanForSpeech: cleanForSpeech, getAuxRefs: getAuxRefs, setAuxRefs: setAuxRefs, listInstalledModels: listInstalledModels, switchWeights: switchWeights, getCurrentWeights: getCurrentWeights, applySavedWeights: ensureSavedWeights, warmup: warmup, pickFile: pickFile, pickFiles: pickFiles };

  // ─── 语音/场景标签协议（2026-10-06 收口为**唯一实现**）───
  // 形状 = `[键:值]`：键 ≤ 8 字且**不含数字与逗号**、值 ≤ 12 字，中英文冒号都认。
  // 为什么键要排除数字/逗号：ENI 系底座强制正文以 `[深夜,海边,00:12]` 这类时地头行开头，
  //   旧规则把它当成「键=深夜,海边,00 + 值=12」整块剥掉了（用户明确要求保留这种头行）；
  //   而 `[害羞:开心]` `[情绪:3]` 这类真标签照剥。无冒号的方括号（表情码 [害羞]、[选项]、[日期,地点,时间]）本就不匹配。
  // 用法只有两处：显示层隐藏（hideVoiceTags）与朗读前剥离（cleanForSpeech）。**去留由未来的 agent 决定**：
  //   目前没有消费方（多情绪切换系统已于 2026-10-06 删除，见提交说明），留它是为了
  //   ① 用户自定义预设仍可能让模型吐标签，别让标签污染气泡；② 将来接 TTS API 时可复用同一形状。
  var VOICE_TAG_RE = /\[\s*[^\[\]:：\d,，\n]{1,8}\s*[:：]\s*[^\[\]\n]{0,12}\s*\]/g;
  function hasVoiceTag(text) { VOICE_TAG_RE.lastIndex = 0; return VOICE_TAG_RE.test(String(text || "")); }
  function stripVoiceTags(text) { return String(text == null ? "" : text).replace(VOICE_TAG_RE, "").replace(/[ \t]{2,}/g, " ").trim(); }

  if (!inApp) return; // 网页版:不注入任何 UI,纯空跳过

  // 取一条 AI 消息的可读文本(朗读用)。
  // 2026-10-06: 标签在显示层已被 hideVoiceTags 剥掉(原文存 dataset.ttsRaw)。朗读优先读该原文 ——
  // 保留它是为了将来接 TTS API 时还能看到模型给的标签；剥标签在 cleanForSpeech 里统一做。
  function rowText(row) {
    if (!row) return "";
    var b = row.querySelector(".bubble");
    if (!b) return "";
    var raw = b.dataset ? b.dataset.ttsRaw : "";
    var t = (raw != null && raw !== "") ? raw : (b.textContent || "");
    // 2026-06-24 选择信号清洗:朗读前剥掉 [选项]…[/选项] / [opt]…[/opt] 选择信号块,避免把可点选项念出来。
    // 仅清洗"朗读文本",不动 DOM —— 气泡里的隐藏与「渲染成可点芯片」由 choices.js 负责(它直接读 bubble.textContent 提取选项)。
    t = t.replace(/\[选项\][\s\S]*?\[\/选项\]/g, "").replace(/\[opt\][\s\S]*?\[\/opt\]/gi, "");
    return t.trim();
  }

  // 给 AI 气泡注入 🔊 朗读按钮
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

  // 一条 AI 气泡是否"读得了"(流式已结束、不在打字动画中)
  function isReadable(row) {
    if (!row || row.classList.contains("pacing-typing")) return false;
    if (row.dataset && row.dataset.streaming === "1") return false;
    var b = row.querySelector(".bubble");
    if (b && b.classList.contains("wechat-typing")) return false;
    return true;
  }
  function markSeen(row) { if (row && row.dataset) row.dataset.omniTtsAuto = "1"; }


  // 情绪标签「彻底隐藏但仍能朗读」：气泡流式结束后把标签从**显示文本**剥掉，原文转存 bubble.dataset.ttsRaw
  // （朗读时取自它，去掉标签前的文本）。2026-10-06 起不再依赖情绪库是否存在 —— 协议自成一体。
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

  // 自动朗读:按出现顺序逐条读"还没读过且已成形"的 AI 气泡。
  // 微信连发会把一条回复拆成多个气泡(多个 .row.ai),旧逻辑只读最后一个 → 跳过了前面的句子;
  // 现在按 DOM 顺序补齐,从第一句起读;遇到还在打字的气泡就停下等下一次,保证顺序不串、不跳第一句。
  // speak() 内部有播放队列,逐条排队,不会重叠。
  var autoTimer = null;
  function maybeAutoplay() {
    if (!cfg().autoplay) return;
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

  // TTS 设置卡已迁移至 settings.js 统一挂载(旧的 injectSettingsCard_REMOVED 死代码已于 4.82 删除,
  // 需要找回参考 git 历史)

  async function boot() {
    var chat = document.getElementById("chat");
    if (!chat) { setTimeout(boot, 500); return; }
    // 启动时从原生侧同步一次语音配置(端口/运行状态);失败回退本地缓存,不阻塞 UI 注入。
    await refreshNativeCfg();
    // 启动时把已有的历史 AI 气泡标记为"已读",避免自动朗读把整段历史念一遍(只读启动后的新回复)
    var existing = chat.querySelectorAll(".row.ai");
    for (var i = 0; i < existing.length; i++) markSeen(existing[i]);
    scanAll();
    try {
      var mo = new MutationObserver(function () { scanAll(); maybeAutoplay(); });
      mo.observe(chat, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-streaming"] });
    } catch (e) {}
    // TTS 设置卡由 settings.js 统一挂载
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();