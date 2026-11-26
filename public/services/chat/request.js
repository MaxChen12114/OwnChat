(function () {
/**
 * Request-body assembly for /api/chat on the agent path.
 *
 * The body is where "how the model answers" is actually decided, and every field it loses fails
 * silently: no promptProfile and the voice turns chatty, no baseId and the persona base is gone,
 * no tools and nothing can be called, no thinking and the model stops reasoning — none of which
 * raises. That is why the golden lock covers both the key set and the key order
 * (test/request.test.mjs): adding or dropping a field must be accompanied by a test change.
 *
 * replyStyle is read through {@link RequestPorts} on every call rather than captured at assembly
 * time, matching the old direct localStorage read (tsconfig has no DOM lib, so the service itself
 * touches no environment).
 *
 * Two invariants carried over from the old comments:
 *   - The agent path is pinned to promptProfile: "assist". It must not take RP's Layer 2
 *     (relation / emotion / affection / priorSummary), which colours tool-calling tone, so those
 *     four are hard-coded defaults here.
 *   - Spread order is meaningful: think, generation params, baseId, neutralId, stateLayer and
 *     webSearch are all optional layers that the user or the channel may switch off, and later
 *     spreads overwrite same-named keys from earlier ones. Do not reorder.
 * @module services/chat/request
 */

/** Minimal contract of a thinkControl instance; the instance is created inside app.js's closure, not a module global. */
                                   
                                                 
 

/** Minimal contract of a promptProfile instance, likewise injected by the caller. */
                                    
                                             
                                                                  
                                              
                                               
                                              
                                                 
 

/** Snapshot passed into agentBody, field for field the old `__request.agentBody(s)` argument. */
                                    
                  
                
                 
                       
                         
                          
                               
                           
                                              
                     
                                  
                                    
 

/** Environment ports, injected by the wiring layer. */
                               
                                                                                                                             
                       
 

/** Snapshot for one compaction call. The model fields follow the send-path snapshot rules: a BYO
 *  channel's own model wins over the top-bar selection; mode/providerId ride along so the worker
 *  routes the summary through the same channel the user is actually chatting with. */
                                    
                     
                         
                          
                           
                 
                  
                       
 

/** Read the BYO model, if the custom-provider snapshot carries one. */
function byoModelOf(customProvider         )         {
  const cp = (customProvider && typeof customProvider === "object" && !Array.isArray(customProvider))
    ? Object.fromEntries(Object.entries(customProvider))
    : {};
  const model = cp.model;
  return typeof model === "string" ? model.trim() : "";
}

/**
 * Body for `POST /api/summarize`.
 *
 * Field rules, all carried over from the old inline object:
 *   - `messages` is always an array (the worker answers an empty summary for an empty one);
 *   - `priorSummary` / `characterName` are strings, never undefined;
 *   - `model` prefers the BYO channel's model and otherwise uses the top-bar selection — the same
 *     precedence the chat request uses. `mode` and `providerId` let the worker resolve the channel
 *     instead of falling back to its `fast` default;
 *   - `customProvider` and `providerId` stay `undefined` when absent, so JSON serialisation drops
 *     them and an old client body keeps its exact bytes.
 * @param snapshot - the send-time snapshot collected by the app.
 * @returns The request body.
 */
function summarizeBody(snapshot                                      )                          {
  const s = snapshot || {};
  const model = byoModelOf(s.customProvider) || (typeof s.model === "string" ? s.model.trim() : "");
  return {
    messages: Array.isArray(s.messages) ? s.messages : [],
    priorSummary: typeof s.priorSummary === "string" ? s.priorSummary : "",
    characterName: typeof s.characterName === "string" ? s.characterName : "",
    customProvider: s.customProvider,
    mode: typeof s.mode === "string" ? s.mode : undefined,
    providerId: s.providerId,
    model: model || undefined,
  };
}

/**
 * Agent-path request body. `s` must carry the *instances* created inside app.js's closure: calling
 * these methods on the module globals instead yields "thinkRequestPayload is not a function", which
 * e2e has already caught once.
 * @param s - snapshot of the current send state, including the two instance ports.
 * @param ports - environment ports (reply style).
 * @returns The body sent to /api/chat. Throws when either instance is missing, because the thinking
 * layer and the base/state layers would otherwise disappear without a trace.
 */
function agentBody(s                                      , ports              )                          {
  s = s || {};
  const think = s.thinkControl;
  const prof = s.promptProfile;
  if (!think || typeof think.thinkRequestPayload !== "function") {
    throw new Error("request.agentBody：缺少 thinkControl 实例（thinking 层会静默丢失，所以必须显式给）");
  }
  if (!prof || typeof prof.baseIdPayload !== "function") {
    throw new Error("request.agentBody：缺少 promptProfile 实例（底座/状态层会静默丢失，所以必须显式给）");
  }
  return {
    stream: true,
    tools: s.tools,
    tool_choice: "auto",
    mode: s.mode,
    model: s.model,
    promptProfile: "assist",
    use_builtin_persona: s.useBuiltin,
    custom_system_prompt: s.customPrompt,
    characterCard: s.characterCard,
    // The agent path needs the card's personality only, never RP closeness, emotion or plot summary
    relation: "default",
    emotion: "neutral",
    affection: null,
    priorSummary: "",
    extraSystemPrompts: s.extraSystemPrompts || "",
    // Thinking is no longer tied to the fast tier: it follows the channel/model, and thinkRequestPayload
    // downgrades to "disabled" by itself when unsupported
    ...think.thinkRequestPayload(),
    ...prof.genParamPayload(),
    replyStyle: ports.replyStyle(),
    customProvider: s.customProvider,
    ...(s.providerId || {}),
    ...prof.baseIdPayload(s.characterCard),
    ...prof.neutralIdPayload(),
    ...prof.stateLayerPayload(),
    ...prof.webSearchPayload(),
    ...(prof.deepseekKitPayload ? prof.deepseekKitPayload() : {}),
    messages: s.messages,
  };
}

// Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name.
// The implementation lives in services/chat/request.ts. `replyStyle` used to read localStorage
// inline with a try/catch falling back to "default"; that read now lives here as a port, still
// resolved per call rather than captured.
(function () {
  if (window.__request && window.__request.v === 1) return;
  var ports = {
    replyStyle: function () {
      try { return window.localStorage.getItem("cfw_reply_style_v1") || "default"; }
      catch (e) { return "default"; }
    },
  };
  window.__request = {
    v: 1,
    agentBody: function (s) { return agentBody(s, ports); },
    summarizeBody: function (s) { return summarizeBody(s); },
  };
})();

globalThis.summarizeBody = summarizeBody;
globalThis.agentBody = agentBody;
})();
