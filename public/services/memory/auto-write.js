(function () {
/**
 * End-of-reply memory writer shared by the agent turn and the ordinary chat path.
 *
 * One decision point for the three rules that must never drift:
 *   - the switch is `cfw_mem_auto_v1` (default off; one extra extraction call per reply);
 *   - only a non-empty final reply is written — tool-round text, empty replies and failed/aborted
 *     turns never reach this function;
 *   - a failed write is reported through the `warn` port and never breaks the reply.
 *
 * The caller decides *when* a reply finished; this module decides *whether* and *what* to write.
 * Exactly one call per reply is the caller's contract (both call sites invoke it once).
 * @module services/memory/auto-write
 */

/** The subset of a character card the writer needs. */
                                    
               
                 
                         
 

                                 
                                                                                              
                     
                                                                                             
                                                                          
                                             
                                               
 

                             
     
                                          
                                            
                                                                           
                                                         
                                                   
     
                                                                     
 

function recOf(value         )                    {
  const out                    = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) out[k] = v;
  }
  return out;
}

function createAutoWriter(ports                )             {
  function afterReply(text         , card         , convId         )          {
    let on = false;
    try {
      on = !!ports.enabled();
    } catch (e) {
      ports.warn("[memory] 自动写入开关读取失败，已跳过", e);
      return false;
    }
    if (!on) return false;
    const raw = String(text == null ? "" : text).trim();
    if (!raw) return false;
    const c = recOf(card);
    const cid = typeof c.id === "string" ? c.id : "";
    const name = typeof c.name === "string" ? c.name : "";
    const fallback = String(convId == null ? "" : convId);
    if (!cid && !fallback) return false;
    const opts                          = cid
      ? { speakerCid: cid, kind: "said" }
      : { cid: fallback, kind: "observed" };
    try {
      const write = ports.remember(name ? "【" + name + "】" + raw : raw, opts);
      // Fire-and-forget: a slow extraction must not delay the reply, and a rejected storage
      // transaction must surface as a warning rather than an unhandled rejection.
      if (write && typeof write.catch === "function") {
        write.catch(function (e         ) { ports.warn("[memory] 自动写入失败（回合不受影响）", e); });
      }
      return true;
    } catch (e) {
      ports.warn("[memory] 自动写入失败（回合不受影响）", e);
      return false;
    }
  }
  return { afterReply };
}

// Browser wiring for services/memory/auto-write.ts: mount the shared writer on the existing
// __memCore facade (no new window.__* contract). Load after memory/core.js and memory/config.js;
// every dependency is resolved per call, so the facade's own remember/config can be replaced by
// tests or by a later wiring step without re-mounting.
(function () {
  var writer = createAutoWriter({
    enabled: function () {
      var cfg = window.__memCore && window.__memCore.config;
      return cfg ? !!cfg.read().autoWrite : false;
    },
    remember: function (text, opts) {
      var core = window.__memCore;
      if (!core || typeof core.remember !== "function") {
        return Promise.reject(new Error("memory facade 未接线"));
      }
      return core.remember(text, opts);
    },
    warn: function (message, error) {
      try { console.warn(message, error); } catch (e) {}
    },
  });
  if (window.__memCore) window.__memCore.autoWriteTurn = function (text, card, convId) { return writer.afterReply(text, card, convId); };
  else window.__memCore = { autoWriteTurn: function (text, card, convId) { return writer.afterReply(text, card, convId); } };
})();

globalThis.createAutoWriter = createAutoWriter;
})();
