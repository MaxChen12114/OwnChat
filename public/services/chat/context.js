(function () {
/**
 * Scene scoping, speaker projection, tool-protocol sanitizing and the token watermark.
 *
 * Everything that is read at call time arrives as a getter on {@link ContextEnv} — multi, character,
 * agentKernel, the ctxExact/ctxHints tables, storage and the current model id — so the old "look it up
 * when needed, never capture up front" semantics survive. The host callbacks passed to `create()`
 * (getActiveConvId / getSession) stay injected by the caller.
 *
 * Equivalence: the golden fingerprint in test/context.test.mjs plus the side-by-side run in
 * test/chat-migration-equiv.test.mjs.
 * @module services/chat/context
 */

                              
                
                    
              
              
                       
                     
                       
                       
                        
                             
                                                                                              
                                                                                                           
                                                                                      
                          
                    
                  
                  
                   
                  
                         
 

                            
              
                
                
 

                             
                                          
                                                             
                                                                                             
                                             
                                         
                                                            
                                                                                                      
                    
 

                              
                             
                               
 

                             
                            
                                             
                                 
                                                                                                            
                                                                                                
                                                                                              
                                       
                               
                                 
                                                                                               
                                                                          
                                                                                     
                                                                                                            
                                                                                  
                                               
                                                          
 

// Implementation mirrors the old context.js statement by statement; only window lookups became env ports.

/** unknown -> Record read bridge (via Object.entries; arrays and scalars yield an empty shell), no assertions. */
function recOf(v         )                          {
  const out                          = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

function asNumber(v         , fallback        )         {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * Leading messages to summarize plus their count, or null when nothing is cut. `cutoff` is floored
 * at zero; the same slice feeds both the request body and the host's DOM row removal.
 */
function planCompact(session         , keep         )                                                              {
  if (!Array.isArray(session)) return null;
  const cutoff = Math.max(0, session.length - asNumber(keep, 10));
  if (cutoff <= 0) return null;
  const toSum                            = [];
  for (let i = 0; i < cutoff; i++) toSum.push(recOf(session[i]));
  return { cutoff, toSum };
}

/** Trimmed summary from an upstream reply, or null for every unusable shape. */
function readSummary(payload         )                {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = recOf(payload)["summary"];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

                                             
function isSteeredFn(v         )                 { return typeof v === "function"; }
function isScopeCard(v         )                 {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function createContextFactory(env            ) {
  return {
    create(host              )             {
      const h = host || {};
      const getActiveConvId = typeof h.getActiveConvId === "function" ? h.getActiveConvId : function () { return ""; };
      const getSession = typeof h.getSession === "function" ? h.getSession : function () { return []; };

      function currentScopeKey() {
        try {
          const M = env.multi;
          // Group chat must scope per conversation: the old code returned the constant "group", so a new
          // conversation inherited the previous one's history.
          if (M && M.isMulti && M.isMulti()) {
            let cid = "";
            try { cid = getActiveConvId(); } catch (e) { cid = ""; }
            return cid ? ("group:" + cid) : "group";
          }
        } catch (e) {}
        try {
          const c = env.character && env.character.getActiveCard ? env.character.getActiveCard() : null;
          if (c && c.id) return "char:" + c.id;
        } catch (e) {}
        return "free";
      }

      function scopeTag                       (obj   )    {
        try { obj.sc = currentScopeKey(); } catch (e) {}
        return obj;
      }

      function scopeLabel(sc        ) {
        if (sc === "group") return "群聊";
        if (sc === "free") return "自由对话";
        if (sc && sc.indexOf("char:") === 0) return "单聊";
        return "全部";
      }

      // Project the shared session into one speaker's context: scope filter, speaker projection, private whispers.
      function selectSpeakerView(msgs               , opts                                              ) {
        const scope = (opts && opts.scope) || currentScopeKey();
        const card = (opts && opts.card) || null;
        const myName = (card && typeof card.name === "string") ? card.name : "";
        const out                = [];
        for (const m of msgs || []) {
          if (!m || !m.role) continue;
          if (m._uiOnly) continue;
          if (m.sc && m.sc !== scope && !(scope.indexOf("group:") === 0 && m.sc === "group")) continue;
          if (m.to && myName && m.to !== myName) continue;
          if (m.role === "assistant" && !(Array.isArray(m.tool_calls) && m.tool_calls.length)) {
            const speaker = typeof m.speakerName === "string" ? m.speakerName : "";
            if (myName && speaker && speaker !== myName) {
              out.push({ role: "user", content: "【" + speaker + "】" + (typeof m.content === "string" ? m.content : "") });
              continue;
            }
          }
          out.push(m);
        }
        return out;
      }

      // Agent protocol assembly (G-1/G-2/G-3) plus UI-field stripping and dangling-tool_call self-healing.
      function sanitizeToolProtocol(msgs               , opts                               ) {
        const drop = !!(opts && opts.dropToolRounds);
        const out                = [];
        (msgs || []).forEach((m) => {
          if (!m || !m.role) return;
          if (m._uiOnly) return;
          if (m.role === "tool") {
            if (!drop) out.push({ role: "tool", tool_call_id: m.tool_call_id, content: typeof m.content === "string" ? m.content : String(m.content == null ? "" : JSON.stringify(m.content)) });
            return;
          }
          const hasTC = m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length;
          if (hasTC && drop) return;
          // Array content (vision image+text) must be preserved as-is, never flattened to ""
          const o              = { role: m.role, content: typeof m.content === "string" ? m.content : (Array.isArray(m.content) ? m.content : "") };
          if (hasTC) {
            o.content = "";
            o.tool_calls = m.tool_calls;
            if (typeof m.reasoning_content === "string" && m.reasoning_content) o.reasoning_content = m.reasoning_content;
          }
          if (typeof m.speakerName === "string") o.speakerName = m.speakerName;
          if (typeof m.speakerId === "string") o.speakerId = m.speakerId;
          out.push(o);
        });
        if (!drop) {
          const declared = new Set         ();
          for (const m of out) {
            if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
              for (const c of m.tool_calls) {
                const call = recOf(c);
                if (c && call.id) declared.add(call.id);
              }
            }
          }
          const kept = out.filter((m) => m.role !== "tool" || (m.tool_call_id && declared.has(m.tool_call_id)));
          try {
            if (env.agentKernel && typeof env.agentKernel.pairPendingToolCalls === "function") {
              env.agentKernel.pairPendingToolCalls(kept, "回合被中断，工具结果未知（客户端协议自愈）");
            }
          } catch (e) {}
          return kept;
        }
        return out;
      }

      // One CJK character is roughly one token; four other characters are roughly one, whitespace skipped.
      function estimateTokens(text        ) {
        if (!text) return 0;
        let cjk = 0, ascii = 0;
        for (const ch of text) {
          const code = ch.charCodeAt(0);
          if (ch === " " || ch === "\n" || ch === "\t" || ch === "\r") continue;
          const isCJK =
            (code >= 0x4E00 && code <= 0x9FFF) ||
            (code >= 0x3400 && code <= 0x4DBF) ||
            (code >= 0x3040 && code <= 0x30FF) ||
            (code >= 0xAC00 && code <= 0xD7AF) ||
            (code >= 0xFF00 && code <= 0xFFEF);
          if (isCJK) cjk++; else ascii++;
        }
        return cjk + Math.ceil(ascii / 4);
      }

      // Manual override, else APP_CTX_EXACT/HINTS pushed by the worker's /config.js, else the 128K fallback.
      function ctxLimitForCompact() {
        let v = 0;
        try { v = parseInt(env.storage.getItem("cfw_ctx_window_v1") || "", 10) || 0; } catch (e) {}
        if (v >= 1024) return v;
        try {
          const mid = env.modelId();
          const exact = env.ctxExact || {};
          if (mid && exact[mid]) return exact[mid];
          const hints = Array.isArray(env.ctxHints) ? env.ctxHints : [];
          for (let i = 0; i < hints.length; i++) {
            try { if (new RegExp(hints[i][0], "i").test(mid)) return hints[i][1]; } catch (e) {}
          }
        } catch (e) {}
        return 131072;
      }

      function sessTokensForCompact() {
        let t = 0;
        for (const m of getSession() || []) {
          if (m && typeof m.content === "string") t += estimateTokens(m.content);
        }
        return t;
      }

      // Numeric gate only: the host short-circuits the on/off switches and the in-flight flag so
      // token counting stays off the common no-summarization path. 70% leaves room for the summary
      // request and the next turn; the count trigger preserves the legacy short-message fallback.
      function shouldCompact(sessionLength         , summaryTrigger         )          {
        const length = asNumber(sessionLength, 0);
        if (length <= 4) return false;
        const limit = ctxLimitForCompact();
        const watermark = limit > 0 && sessTokensForCompact() >= limit * 0.7;
        return watermark || length > asNumber(summaryTrigger, 0);
      }

      function toRenderableMessages(arr               ) {
        const next                = [];
        for (const m of arr || []) {
          if (!m || typeof m.content !== "string") continue;
          const role = m.role;
          if (role !== "user" && role !== "assistant" && role !== "tool") continue;
          const e              = { role, content: m.content };
          const hasTC = role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length;
          if (hasTC) {
            e.tool_calls = m.tool_calls;
            if (typeof m.agentPreamble === "string" && m.agentPreamble) e.agentPreamble = m.agentPreamble;
          }
          if (role === "tool") {
            if (typeof m.tool_call_id === "string") e.tool_call_id = m.tool_call_id;
            if (m._tool && typeof m._tool === "object") e._tool = m._tool;
          }
          if (typeof m.sc === "string" && m.sc) e.sc = m.sc;
          if (role === "assistant" && typeof m.reasoning_content === "string" && m.reasoning_content) {
            e.reasoning_content = m.reasoning_content;
          }
          if (role === "assistant") {
            if (typeof m.speakerId === "string") e.speakerId = m.speakerId;
            if (typeof m.speakerName === "string") e.speakerName = m.speakerName;
            if (typeof m.speakerIcon === "string") e.speakerIcon = m.speakerIcon;
            if (m._meta && typeof m._meta === "object") e._meta = m._meta;
          }
          if (Array.isArray(m.images) && m.images.length) e.images = m.images;
          if (m._uiOnly) e._uiOnly = true;
          if (role === "user") {
            if (Array.isArray(m.files) && m.files.length) e.files = m.files;
            if (Array.isArray(m.images) && m.images.length) e.images = m.images;
          }
          next.push(e);
        }
        return next;
      }

      // A33b: pure projection from kernel messages to session messages.
      function kernelMessagesToSession(allMsgs               , o                          ) {
        const opt = o || {};
        const startLen = Number(opt.startLen) || 0;
        const isSteered            = isSteeredFn(opt.isSteered) ? opt.isSteered : function () { return false; };
        const card                   = isScopeCard(opt.characterCard) ? opt.characterCard : null;
        const newMsgs = Array.isArray(allMsgs) ? allMsgs.slice(startLen) : [];
        if (newMsgs.length && newMsgs[newMsgs.length - 1].role === "assistant") newMsgs.pop();
        const out                = [];
        newMsgs.forEach((m) => {
          if (!m) return;
          if (isSteered(m)) return;
          if (m.role === "tool") {
            const t              = scopeTag({ role: "tool", tool_call_id: m.tool_call_id, content: m.content });
            if (m._tool) t._tool = m._tool;
            out.push(t);
            return;
          }
          if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
            const a              = scopeTag({ role: "assistant", content: "", tool_calls: m.tool_calls });
            if (m.reasoning_content) a.reasoning_content = m.reasoning_content;
            if (m.content) a.agentPreamble = m.content;
            if (card) { a.speakerId = card.id; a.speakerName = card.name; a.speakerIcon = card.icon || "🙂"; }
            out.push(a);
            return;
          }
          out.push(scopeTag({ role: m.role, content: typeof m.content === "string" ? m.content : "" }));
        });
        return out;
      }

      return { currentScopeKey, scopeTag, scopeLabel, selectSpeakerView, sanitizeToolProtocol,
        kernelMessagesToSession,
        estimateTokens, ctxLimitForCompact, sessTokensForCompact,
        shouldCompact, planCompact, readSummary,
        toRenderableMessages };
    },
  };
}

// Browser wiring (injected by l0/emit.mjs): binds the service to the existing window contract.
// The bridges are getters rather than snapshotted fields, so a module that loads after this one is
// still reachable — the old file read them at call time for the same reason. Every bridge name is
// spelled out in full with the `window.` prefix: an alias makes the contract scan count drop to
// zero and look like the name was retired.
(function () {
  if (window.__context) return;

  var env = {};
  Object.defineProperties(env, {
    multi: { get: function () { return window.__multi; }, enumerable: true },
    character: { get: function () { return window.__character; }, enumerable: true },
    agentKernel: { get: function () { return window.AgentKernel; }, enumerable: true },
    ctxExact: { get: function () { return window.APP_CTX_EXACT; }, enumerable: true },
    ctxHints: { get: function () { return window.APP_CTX_HINTS; }, enumerable: true },
  });
  env.storage = {
    getItem: function (key) { return window.localStorage.getItem(key); },
  };
  // The `#modelSel` / `cfw_model` lookup for the compaction limit lives here; a throw becomes the
  // empty string and the service falls back to the 128K default.
  env.modelId = function () {
    try {
      return (document.getElementById("modelSel") || {}).value || window.localStorage.getItem("cfw_model") || "";
    } catch (e) { return ""; }
  };

  var factory = createContextFactory(env);
  window.__context = { create: factory.create };
})();

globalThis.createContextFactory = createContextFactory;
})();
