(function () {
/**
 * Image generation, as one tool: `send_image` gives the user a picture.
 *
 * The 150-second ceiling is the reason this file exists as code rather than as a one-line forward.
 * The image pipeline already has its own timeouts, but a tool that never returns hangs the whole
 * agent loop and leaves the bubble spinning — so there is a hard limit here too, and a timeout is
 * reported as a normal failure the model can retry or explain. Nothing below may await the facade
 * without that race.
 *
 * Two callbacks come from outside, because the tools bundle owns both: the facade (a global looked
 * up per call — the image module is a classic script and may land after this one) and the renderer
 * that puts the returned URL into the transcript.
 *
 * @module services/tools/agent/image
 */

/** Hard ceiling for one generation. Past this the tool fails rather than hanging the loop. */
const SEND_IMAGE_TIMEOUT_MS = 150000;

                              
                                                                                                      
 

                            
                                                                                    
                                  
                                                                                              
                                                                               
 

                             
                 
                         
                         
 

                              
              
                    
                 
 

                           
                                                              
 

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

function createImageTools(deps           )           {
  async function send(input            , ctx         )                       {
    const args = recOf(input);
    const facade = deps.chatImage();
    if (!facade || typeof facade.sendPhoto !== "function") {
      return { ok: false, error: "发图模块未就绪 (image-chat.js / window.__chatImage)" };
    }

    let timer                                       = null;
    const deadline = new Promise       (function (_, reject) {
      timer = setTimeout(function () {
        reject(new Error("发图超时(>150s),可能网络不稳或出图服务繁忙"));
      }, SEND_IMAGE_TIMEOUT_MS);
    });

    let res         ;
    try {
      res = await Promise.race([
        facade.sendPhoto({
          kind: text(args.type) === "scene" ? "scene" : undefined,
          characterId: args.character_id,
          scenePrompt: args.scene_prompt,
        }),
        deadline,
      ]);
    } catch (e) {
      const err = recOf(e);
      return { ok: false, error: "发图失败: " + text(err.message || e) };
    } finally {
      if (timer) clearTimeout(timer);
    }

    const out = recOf(res);
    const url = text(out.imageUrl);
    if (url && typeof deps.onImage === "function") {
      deps.onImage(url, { type: args.type, taskId: out.taskId }, ctx);
    }
    return url ? { ok: true, imageUrl: url } : { ok: false, error: "发图无返回" };
  }

  return { send };
}

// ── Image tools (2026-11-21): the generation call, its hard 150s ceiling and the result shape
// live in services/agent/tools/image. No IO to inject from here: the tools bundle supplies both
// the facade lookup and the transcript renderer, because it owns the globals and the bubble.

globalThis.SEND_IMAGE_TIMEOUT_MS = SEND_IMAGE_TIMEOUT_MS;
globalThis.createImageTools = createImageTools;
})();
