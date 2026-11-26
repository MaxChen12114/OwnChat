(function () {
/**
 * Cloud speech configuration for the DeepSeek tool API.
 *
 * This module owns only the decisions that must stay identical between the settings card and the
 * playback loop: which localStorage keys hold the switches, the two allowed voices, the text budget
 * and the rule that turns a reply into the chunks sent to /api/tts. It deliberately does not fetch,
 * touch the DOM or play audio — those ports live in the wiring, so this logic can be exercised
 * without a browser or a key.
 *
 * The cloud path is opt-in and device-local. It exists beside the desktop-only GPT-SoVITS path and
 * never silently replaces it: the caller chooses which engine to use before any request is made.
 * @module services/media/cloud-tts
 */

/** Storage keys. Kept in one place so the card and the playback loop cannot drift. */
const CLOUD_TTS_KEYS                                                = {
  enabled: "cfw_cloud_tts_enabled_v1",
  voice: "cfw_cloud_tts_voice_v1",
};

/** The only two voices the upstream accepts. */
const CLOUD_VOICES                    = ["stella", "tide"];

/** Characters sent per request. The upstream bills Chinese as two; stay well under its 10k ceiling. */
const CLOUD_TTS_CHUNK_CHARS = 4000;

                                
                                      
                                            
 

                                 
                            
                         
 

                              
                        
                                
                                 
                                                                                   
                                  
 

function read(port               , key        )         {
  try {
    const v = port.getItem(key);
    return typeof v === "string" ? v : "";
  } catch (e) { return ""; }
}

function write(port               , key        , value        )       {
  try { port.setItem(key, value); } catch (e) {}
}

function isVoice(value         )                             {
  return value === "stella" || value === "tide";
}

/**
 * Split on sentence ends first, then pack sentences into chunks no longer than the budget. A single
 * sentence beyond the budget is hard-cut — the upstream would reject it otherwise.
 */
function splitChunks(text         , budget        )           {
  const raw = text == null ? "" : typeof text === "string" ? text : String(text);
  const limit = budget > 0 && budget < 20000 ? budget : CLOUD_TTS_CHUNK_CHARS;
  const sentences = raw.replace(/\r/g, "").split(/(?<=[。！？!?…\n])/).map((s) => s.trim()).filter(Boolean);
  const out           = [];
  let buf = "";
  for (const s of sentences) {
    if (buf && buf.length + s.length > limit) { out.push(buf); buf = ""; }
    if (s.length > limit) {
      if (buf) { out.push(buf); buf = ""; }
      for (let i = 0; i < s.length; i += limit) out.push(s.slice(i, i + limit));
      continue;
    }
    buf += s;
  }
  if (buf) out.push(buf);
  return out;
}

function createCloudTts(port               )              {
  function cfg()                 {
    const storedVoice = read(port, CLOUD_TTS_KEYS.voice);
    return {
      enabled: read(port, CLOUD_TTS_KEYS.enabled) === "1",
      voice: isVoice(storedVoice) ? storedVoice : "stella",
    };
  }
  return {
    cfg: cfg,
    setEnabled: function (on         )       {
      write(port, CLOUD_TTS_KEYS.enabled, on ? "1" : "0");
    },
    setVoice: function (voice         )       {
      write(port, CLOUD_TTS_KEYS.voice, isVoice(voice) ? voice : "stella");
    },
    chunks: function (text         )           {
      return splitChunks(text, CLOUD_TTS_CHUNK_CHARS);
    },
  };
}

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

globalThis.CLOUD_TTS_KEYS = CLOUD_TTS_KEYS;
globalThis.CLOUD_VOICES = CLOUD_VOICES;
globalThis.CLOUD_TTS_CHUNK_CHARS = CLOUD_TTS_CHUNK_CHARS;
globalThis.splitChunks = splitChunks;
globalThis.createCloudTts = createCloudTts;
})();
