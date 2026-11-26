(function () {
/**
 * `speak` — read text aloud through the local TTS.
 *
 * The returning-shape rule is the whole point: **absent speech is not an error**. On the web there
 * is no local engine, on desktop there may be no reference audio configured, and the user may have
 * switched the feature off. All three answer `{ok:true, ready:false, note}` — a refusal would make
 * the model apologise for a limitation the story does not care about, and a thrown tool would kill
 * the turn over an optional flourish.
 *
 * Only a genuine failure to start playback returns `ok:false`, because that one the user may want
 * to know about.
 *
 * @module services/tools/agent/speak
 */

                              
                            
                                                                                                  
                  
 

                            
                                                                                          
                            
 

                             
                 
 

                              
              
                  
                   
                 
                
                 
 

                           
                                               
 

function recOf(value         )                          {
  const out                          = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) out[k] = v;
  }
  return out;
}
function text(v         )         {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

function createSpeakTools(deps           )           {
  async function run(input            )                       {
    const args = recOf(input);
    const body = text(args.text).trim();
    if (!body) return { ok: false, error: "text 不能为空" };

    const tts = deps.tts();
    // Placeholder degradation: on the web the media module no-ops entirely, so omniTtsSvc is absent.
    // Answering ready:false tells the agent nothing was spoken without treating it as a fault.
    if (!tts || typeof tts.speak !== "function") {
      return { ok: true, ready: false, spoken: false, note: "TTS 接口未就绪(仅桌面 App 生效),已占位跳过" };
    }

    let cfg                          = {};
    try {
      cfg = typeof tts.cfg === "function" ? recOf(tts.cfg()) : {};
    } catch (e) {
      // An unreadable config is treated as "not configured" below, not as a failure.
    }
    if (cfg.enabled === false) {
      return { ok: true, ready: false, spoken: false, note: "本地语音未启用(设置·本地语音里打开)" };
    }
    if (!cfg.refAudioPath) {
      return { ok: true, ready: false, spoken: false, note: "未设参考音频路径,先在「设置·本地语音」填一下" };
    }

    try {
      // Splitting and queueing happen inside: this returns as soon as playback is queued.
      tts.speak(body);
      return { ok: true, ready: true, spoken: true, port: cfg.port };
    } catch (e) {
      const err = recOf(e);
      return { ok: false, error: "朗读失败: " + text(err.message || e) };
    }
  }

  return { run };
}

// ── Speak tool (2026-11-21): the "absent speech is not an error" shape and the three degradation
// notes live in services/tools/agent/speak. No IO to inject: the tools bundle passes the facade
// lookup, because the media module may land after it.

globalThis.createSpeakTools = createSpeakTools;
})();
