// Browser wiring for services/media/cloud-tts.ts: fetch, Audio playback and the frozen global.
// Config keys, voice whitelist and text chunking live in the emitted TS product. The speech engine
// is opt-in; nothing is requested until the settings card turns it on and a caller asks to speak.
// Speech calls the Worker's /api/tts proxy — the API key never reaches the browser.
(function () {
  // Non-`__` global on purpose: the L1a freeze refuses new window.__* names. The local speech
  // service (tts-text.js, loaded later) folds this object into its frozen omniTtsSvc handle, so callers
  // still see one speech entry point and the contract surface does not grow.
  if (window.cloudTtsSvc) return;

  var svc = createCloudTts({
    getItem: function (k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    setItem: function (k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} },
  });

  var queue = Promise.resolve();
  var curAudio = null;
  var lastError = "";

  function stop() {
    queue = Promise.resolve();
    if (curAudio) { try { curAudio.pause(); } catch (e) {} try { curAudio.src = ""; } catch (e) {} curAudio = null; }
  }

  function playBlob(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var audio = new Audio(url);
      curAudio = audio;
      var settled = false;
      function done(ok, err) {
        if (settled) return;
        settled = true;
        try { URL.revokeObjectURL(url); } catch (e) {}
        if (curAudio === audio) curAudio = null;
        if (ok) resolve(); else reject(err || new Error("云端语音播放失败"));
      }
      audio.onended = function () { done(true); };
      audio.onerror = function () { done(false, new Error("云端语音播放失败")); };
      audio.play().then(function () {}, function (e) { done(false, e); });
    });
  }

  async function synth(text) {
    var c = svc.cfg();
    var res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text, voice_id: c.voice, format: "wav", filter_markdown: true }),
    });
    if (!res.ok) {
      var detail = "";
      try { var j = await res.json(); detail = j && (j.error || j.detail) ? (j.error + (j.detail ? ": " + j.detail : "")) : ""; } catch (e) {}
      throw new Error(detail || ("语音服务返回 " + res.status));
    }
    return res.blob();
  }

  function speak(text) {
    var c = svc.cfg();
    if (!c.enabled) return queue;
    var parts = svc.chunks(text);
    if (!parts.length) return queue;
    parts.forEach(function (p) {
      queue = queue.then(async function () {
        var blob = null;
        try { blob = await synth(p); } catch (e) { lastError = (e && e.message) || String(e); console.warn("[cloudTTS] 合成失败", e); }
        if (blob) { try { await playBlob(blob); } catch (e) { console.warn("[cloudTTS] 播放失败", e); } }
      }).catch(function () {});
    });
    return queue;
  }

  window.cloudTtsSvc = {
    cfg: function () { return svc.cfg(); },
    setEnabled: function (on) { svc.setEnabled(!!on); if (!on) stop(); },
    setVoice: function (v) { svc.setVoice(v); },
    speak: speak,
    stop: stop,
    isPlaying: function () { return !!curAudio; },
    lastError: function () { return lastError; },
  };
})();
