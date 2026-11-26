(function () {
/**
 * Model-call primitives for *peer* characters — one role card calling its own model.
 *
 * Vocabulary, because the two kinds are constantly confused: a **peer** is a properly configured
 * role card with its own context, able to message other cards; a **sub-agent** is a throwaway
 * worker the main agent spins up on the spot (the least-privilege tier in the tools bundle). This
 * module only does peers: it hands a card its persona, its view of the context and a brief, and
 * gets text back.
 *
 * It deliberately touches neither DOM nor session. Every product of these functions is either one
 * string or one accounting entry, and whoever plots that string (a council panel, a timeline row)
 * lives further out — that split is why the orchestration in `peer-actions` can be tested without a
 * document.
 *
 * Nothing here closes over the page: page-level state arrives through {@link PeerCaps} and browser
 * globals through {@link PeerEnv}, both supplied by `l0/wiring/agent-peer-calls.js`. The env handles
 * are re-read on every call rather than captured at construction, because boot order is not fixed —
 * the agent kernel is an ESM module that lands after the classic scripts, and the memory core can be
 * attached later still. A handle captured at construction would be permanently null.
 *
 * Lock: `test/peer-calls.test.mjs` (vm, fake fetch, fake host) covers the three-level card matching,
 * the config clamps, and every request-body contract.
 * @module services/agent/peer-calls
 */

/** The prompt-profile instance owned by the caller; only its payload builders are used here. */
                                    
                                                         
                                              
                                               
 

/** Only the part of an AbortSignal this module forwards. */
                             
                            
 

/** The AbortSignal constructor surface used to fold a hard timeout into the caller's signal. */
                                 
                                       
                                   
 

/** Only what this module reads off a `/api/chat` response. */
                               
              
                 
                          
                           
 

/** Request init this module sends; a real RequestInit satisfies it structurally. */
                           
                 
                                  
               
                      
 

/** A role card as this module sees it: an opaque record addressed by `id` / `name`. */
                       
                         
               
                 
 

                      
                                                                
 

                     
                                                    
 

                         
                                       
 

                       
                                                       
                      
                                                   
 

                          
                                                        
 

                     
                   
                                                                          
 

/**
 * Browser globals the page owns. Wiring resolves each one lazily, so a module that loads early still
 * sees the kernel and memory core that appear later. Every member may be absent: each call site has
 * a defined degraded path, and the old code swallowed the same failures.
 */
                          
                                                                        
                         
                                                                
                       
                                                                                      
                  
                                                                  
                     
                                                                  
                    
                                                                                                      
                                    
                                                           
                      
                                                                           
                         
                                      
                    
 

/** Page-level state and exits, one member per old `host` field. All optional (the old code defaulted too). */
                           
                
                                                                                                  
                                           
                                                                       
                                            
                  
                                                                                                   
                                       
                            
                         
                            
                          
                                                     
                                    
                                         
                                     
                                                                                                 
                      
                                                             
 

/** Result of {@link PeerCallsApi.runCharacterAgent}. `error` is display text, never thrown. */
                                 
              
                 
                
                       
                       
 

/** Options for one character-as-agent run, field for field the old `opts`. */
                               
                          
                  
                                                 
                                                                                               
                                                                    
 

/** Options for {@link PeerCallsApi.oneShot}. */
                              
                 
                   
                     
 

/** Public surface, name for name the old window contract. `v` stays 1. */
                               
            
                                         
                                                                        
                                                           
                                                                                                            
                                                                                                     
                                               
                                                                                   
 

const EMPTY_PROFILE                    = {
  baseIdPayload: () => ({}),
  neutralIdPayload: () => ({}),
  stateLayerPayload: () => ({}),
};

/** Tool groups a peer agent must be handed explicitly; the tools bundle's tiers do not cover them. */
const EXTRA_TOOL_GROUPS = ["__agentWorkspace", "__sourceTools", "__localExecTools", "__stageTools"];

function isCard(value         )                {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cardOf(value         )              {
  return isCard(value) ? value : null;
}

function arrOf(value         )            {
  return Array.isArray(value) ? value : [];
}

function strOf(value         )         {
  return typeof value === "string" ? value : "";
}

/** String coercion matching the old `String(x || "")`, which also let numbers through. */
function textOf(value         )         {
  return value === null || value === undefined ? "" : String(value);
}

function numOf(value         )         {
  return typeof value === "number" && isFinite(value) ? value : 0;
}

/** Name normalisation for card matching: drop whitespace, brackets and punctuation, then lower-case. */
function normalizeName(value         )         {
  return textOf(value).replace(/[\s【】\[\]()（）「」·,，.。!！?？~]/g, "").toLowerCase();
}

/** The assistant message of a chat-completions response, or null for any other shape. */
function pickMessage(json         )          {
  if (!isCard(json)) return null;
  const choices = arrOf(json.choices);
  const first = choices.length ? choices[0] : null;
  return isCard(first) ? first.message : null;
}

function isKernel(value         )                      {
  return isCard(value) && typeof value.runAgentLoop === "function";
}

function isTools(value         )                     {
  return isCard(value) && typeof value.buildRegistry === "function";
}

function isToolGroup(value         )                         {
  return isCard(value) && typeof value.defineTools === "function";
}

function isMemCore(value         )                       {
  return isCard(value) && typeof value.buildInjection === "function";
}

function isCharMemory(value         )                          {
  return isCard(value) && typeof value.buildInjection === "function";
}

function isPanel(value         )                     {
  return isCard(value) && typeof value.call === "function";
}

function createPeerCalls(caps          )               {
  const port           = caps || {};
  const env          = port.env || {};

  const setting = typeof port.setting === "function" ? port.setting : function ()                { return null; };
  const post = typeof port.fetch === "function" ? port.fetch : null;
  const signalCtor = typeof port.signalCtor === "function" ? port.signalCtor : function ()                             { return undefined; };
  const prof                    = port.promptProfile || EMPTY_PROFILE;

  /** Read one browser handle; missing getter and missing value collapse to undefined. */
  function envRaw(getter                             )          {
    return typeof getter === "function" ? getter() : undefined;
  }

  /** Reply style is read per call: the user can switch it mid-session and the next peer call obeys. */
  function replyStyle()         {
    try {
      return setting("cfw_reply_style_v1") || "default";
    } catch (e) {
      return "default";
    }
  }

  /** Caller's signal folded with a hard timeout — non-streaming calls have no watchdog of their own. */
  function peerSignal(timeoutMs        )                         {
    try {
      const ctl = typeof port.signal === "function" ? port.signal() : null;
      const ctor = signalCtor();
      if (ctl && ctor && typeof ctor.any === "function") {
        return ctor.any([ctl.signal, ctor.timeout ? ctor.timeout(timeoutMs) : undefined]);
      }
      if (ctl) return ctl.signal;
    } catch (e) {
      /* A signal that cannot be composed must not cancel the call: fall through to "no signal". */
    }
    return undefined;
  }

  function byoProvider()              {
    const raw = typeof env.byo === "function" ? env.byo() : undefined;
    return raw ? cardOf(raw) : null;
  }

  function modelFor(byo             )          {
    return byo ? byo.model : (typeof port.modelFallback === "function" ? port.modelFallback() : "");
  }

  function modeNow()         {
    return typeof port.mode === "function" ? port.mode() : "";
  }

  /** Persona switch combination: the custom prompt applies only when the built-in persona is off. */
  function customPromptNow()         {
    const builtin = typeof port.useBuiltin === "function" ? port.useBuiltin() : false;
    const enabled = typeof port.promptEnabled === "function" ? port.promptEnabled() : false;
    if (builtin || !enabled) return "";
    return typeof port.customPrompt === "function" ? port.customPrompt() : "";
  }

  function extraPromptsNow(card         )         {
    return typeof port.extraPrompts === "function" ? port.extraPrompts(modeNow(), card) : "";
  }

  function providerNow()                          {
    const raw = typeof port.providerId === "function" ? port.providerId() : {};
    return isCard(raw) ? raw : {};
  }

  function formatErrorNow(text        )         {
    return typeof port.formatError === "function" ? port.formatError(text) : text;
  }

  function bookUsage(usage         , byo             )       {
    if (!isCard(usage) || typeof port.usage !== "function") return;
    try {
      port.usage(
        numOf(usage.prompt_tokens),
        numOf(usage.completion_tokens),
        numOf(usage.prompt_cache_hit_tokens),
        modelFor(byo),
        byo || undefined
      );
    } catch (e) {
      /* Accounting must never break a reply that already arrived. */
    }
  }

  function send(body                         , signal                        )                        {
    if (!post) return Promise.reject(new Error("fetch 未注入"));
    return post("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: signal,
      body: JSON.stringify(body),
    });
  }

  /** Card name matching: exact, then decoration-stripped equality, then mutual containment (≥2 chars). */
  function matchName(list           , raw        , norm        )              {
    const exact = list.find((c) => isCard(c) && c.name === raw);
    if (exact) return cardOf(exact);
    if (!norm) return null;
    const loose = list.find((c) => isCard(c) && normalizeName(c.name) === norm);
    if (loose) return cardOf(loose);
    const partial = list.find((c) => {
      const cn = normalizeName(isCard(c) ? c.name : "");
      return cn.length >= 2 && norm.length >= 2 && (cn.indexOf(norm) >= 0 || norm.indexOf(cn) >= 0);
    });
    return cardOf(partial);
  }

  /**
   * Resolve a name to a card, stage first. Names collide constantly — the same character standing in
   * a scene and sitting in the library — and the one the user can see is the one they mean, so the
   * stage wins before the library is consulted at all.
   */
  function cardByName(name         )              {
    const raw = textOf(name).trim();
    if (!raw) return null;
    const norm = normalizeName(raw);
    const onStage = matchName(arrOf(envRaw(env.sceneCards)), raw, norm);
    if (onStage) return onStage;
    return matchName(arrOf(envRaw(env.allCards)), raw, norm);
  }

  function cfg()                                                                 {
    const num = function (key        , def        , lo        , hi        )         {
      const n = parseInt(textOf(setting(key)), 10);
      return isNaN(n) ? def : Math.max(lo, Math.min(hi, n));
    };
    // Defaults and clamps mirror services/ui/settings-multi-agent.ts (the write-side home). The
    // old meetingMax default was 6 here vs 3 in the card, so the shown value was not the one used;
    // test/settings-multi-agent.test.mjs locks this cfg() against that service's engineConfig().
    return {
      meetingMax: num("cfw_ma_meeting_max_v1", 3, 1, 6),
      meetingRounds: num("cfw_ma_meeting_rounds_v1", 1, 1, 2),
      ctxMsgs: num("cfw_ma_ctx_msgs_v1", 60, 0, 400),
    };
  }

  /**
   * One "hands on" call as a peer: rp profile, non-streaming, 90s hard timeout, tools when given.
   * Resolves `{ content }` plus whatever of `tool_calls` / `reasoning_content` came back; rejects with
   * the beautified upstream text on a non-2xx.
   */
  function callWithTools(card             , messages           , schemas         )                                   {
    const sig = peerSignal(90000);
    const byo = byoProvider();
    const body                          = {
      stream: false,
      mode: modeNow(),
      model: modelFor(byo),
      promptProfile: "rp",
      use_builtin_persona: typeof port.useBuiltin === "function" ? port.useBuiltin() : false,
      custom_system_prompt: customPromptNow(),
      characterCard: card || null,
      relation: "default", emotion: "neutral", affection: null, priorSummary: "",
      extraSystemPrompts: extraPromptsNow(card),
      thinking: "disabled",
      replyStyle: replyStyle(),
      customProvider: byo || undefined,
      ...providerNow(), ...prof.baseIdPayload(card), ...prof.neutralIdPayload(), ...prof.stateLayerPayload(),
      messages: messages,
    };
    const toolList = arrOf(schemas);
    if (toolList.length) {
      body.tools = toolList;
      body.tool_choice = "auto";
    }
    return send(body, sig).then(function (res) {
      if (!res.ok) {
        return res.text().catch(function () { return ""; }).then(function (t) {
          throw new Error("Request failed (" + res.status + "): " + formatErrorNow(String(t).slice(0, 200)));
        });
      }
      return res.json().catch(function () { return null; }).then(function (j) {
        const message = pickMessage(j);
        const out                          = { content: strOf(isCard(message) ? message.content : "") };
        if (isCard(message) && Array.isArray(message.tool_calls) && message.tool_calls.length) out.tool_calls = message.tool_calls;
        if (isCard(message) && message.reasoning_content) out.reasoning_content = message.reasoning_content;
        return out;
      });
    });
  }

  /** Attach the tool groups the tools bundle's tiers leave out; one failing group must not sink the run. */
  function attachExtraTools(registry         )       {
    for (let i = 0; i < EXTRA_TOOL_GROUPS.length; i++) {
      const group = envRaw(() => (typeof env.toolGroup === "function" ? env.toolGroup(EXTRA_TOOL_GROUPS[i]) : undefined));
      if (!isToolGroup(group)) continue;
      try {
        group.defineTools(registry);
      } catch (e) {
        /* Each group is independent: skip the broken one and keep the rest. */
      }
    }
  }

  /**
   * Run one card as an agent: up to six tool iterations, side-effecting tools denied unless the
   * caller passes its own gate. Resolves a status object on every path — a missing card, a cold
   * kernel, an unbuildable registry and an empty answer are all `{ ok: false, error }`, never throws.
   */
  function runCharacterAgent(card             , brief         , opts               )                          {
    const o               = opts || {};
    if (!card) return Promise.resolve({ ok: false, error: "缺少角色" });
    const kernel = envRaw(env.kernel);
    if (!isKernel(kernel)) return Promise.resolve({ ok: false, error: "内核未就绪" });
    let registry          = null;
    try {
      const tools = envRaw(env.tools);
      if (isTools(tools)) {
        registry = tools.buildRegistry({ profile: "char" });
        attachExtraTools(registry);
      }
    } catch (e) {
      registry = null;
    }
    if (!registry) return Promise.resolve({ ok: false, error: "工具表构建失败" });
    const onEvent = typeof o.onEvent === "function" ? o.onEvent : function () {};
    const depth = (typeof o.depth === "number" ? o.depth : 0) + 1;
    const wanted = parseInt(textOf(o.maxIterations), 10);
    const maxIterations = Math.max(1, Math.min(6, wanted || 3));
    const memCore = envRaw(env.memCore);
    const memory = isMemCore(memCore) ? memCore : null;
    const memInj = memory
      ? Promise.resolve(memory.buildInjection(card.id || card.name, textOf(brief))).catch(function () { return ""; })
      : Promise.resolve("");
    return memInj.then(function (injection) {
      return kernel.runAgentLoop({
        messages: [{ role: "user", content: textOf(brief) + textOf(injection) }],
        registry: registry,
        callModel: function (msgs           , schemas         ) { return callWithTools(card, arrOf(msgs), schemas); },
        maxIterations: maxIterations,
        context: { characterCard: card, depth: depth, onEvent: onEvent },
        ensurePermission: typeof o.ensurePermission === "function" ? o.ensurePermission : function () { return Promise.resolve(false); },
        onEvent: onEvent,
      });
    }).then(function (res) {
      const text = textOf(isCard(res) ? res.finalText : "").trim();
      if (!text) return { ok: false, error: textOf(card.name) + " 没有产出内容" };
      try {
        if (memory && typeof memory.enabled === "function" && memory.enabled() && typeof memory.remember === "function") {
          memory.remember("【" + textOf(card.name) + "】" + text, { speakerCid: card.id });
        }
      } catch (e) {
        /* Memory is an amplifier: a failed write must not turn a good answer into an error. */
      }
      return {
        ok: true,
        said: text,
        iterations: isCard(res) ? res.iterations : undefined,
        stopReason: isCard(res) ? res.stopReason : undefined,
      };
    }).catch(function (e) {
      return { ok: false, error: String(isCard(e) ? e.message : e) };
    });
  }

  /**
   * One neutral call (memory extraction / consolidation): no persona, no card, no reasoning chain.
   * Resolves "" for an empty prompt; rejects with the raw upstream slice on a non-2xx.
   */
  function oneShot(opts              )                  {
    const o              = opts || {};
    const user = textOf(o.user);
    if (!user) return Promise.resolve("");
    const sig = peerSignal(o.timeoutMs || 60000);
    const byo = byoProvider();
    return send({
      stream: false,
      mode: modeNow(),
      model: modelFor(byo),
      promptProfile: "assist",
      use_builtin_persona: false,
      custom_system_prompt: textOf(o.system),
      characterCard: null,
      relation: "default", emotion: "neutral", affection: null, priorSummary: "",
      extraSystemPrompts: "",
      thinking: "disabled",
      replyStyle: replyStyle(),
      customProvider: byo || undefined,
      ...providerNow(),
      ...prof.neutralIdPayload(),
      messages: [{ role: "user", content: user }],
    }, sig).then(function (res) {
      if (!res.ok) {
        return res.text().catch(function () { return ""; }).then(function (t) {
          throw new Error("oneShot " + res.status + " " + String(t).slice(0, 200));
        });
      }
      return res.json().catch(function () { return null; }).then(function (j) {
        const message = pickMessage(j);
        return strOf(isCard(message) ? message.content : "");
      });
    });
  }

  /**
   * One utterance by a peer inside a group chat: its card, its (optional) slice of the history and a
   * brief. Character memory goes into the system prompts and usage is booked here, so the caller
   * never has to remember either.
   */
  function callPeerModel(card             , view         , brief         )                  {
    const sig = peerSignal(60000);
    const history = arrOf(view);
    const briefText = textOf(brief);
    const messages = briefText ? history.concat([{ role: "user", content: briefText }]) : history;
    const byo = byoProvider();
    const charMemory = envRaw(env.charMemory);
    const memory = isCharMemory(charMemory) ? charMemory : null;
    const memReady = memory
      ? Promise.resolve(memory.buildInjection(card, briefText.slice(0, 600))).catch(function () { return ""; })
      : Promise.resolve("");
    return memReady.then(function (kbInj) {
      const injection = textOf(kbInj);
      return send({
        stream: false,
        mode: modeNow(),
        model: modelFor(byo),
        promptProfile: "rp",
        use_builtin_persona: typeof port.useBuiltin === "function" ? port.useBuiltin() : false,
        custom_system_prompt: customPromptNow(),
        characterCard: card || null,
        relation: "default",
        emotion: "neutral",
        affection: null,
        priorSummary: "",
        extraSystemPrompts: extraPromptsNow(card) + (injection ? "\n\n" + injection : ""),
        thinking: "disabled", // A council wants the conclusion, not the reasoning: cheaper and faster.
        replyStyle: replyStyle(),
        customProvider: byo || undefined,
        ...providerNow(),
        ...prof.baseIdPayload(card),
        ...prof.neutralIdPayload(),
        ...prof.stateLayerPayload(),
        messages: messages,
      }, sig);
    }).then(function (res) {
      if (!res.ok) {
        return res.text().catch(function () { return ""; }).then(function (t) {
          throw new Error("Request failed (" + res.status + "): " + formatErrorNow(String(t).slice(0, 200)));
        });
      }
      return res.json().catch(function () { return null; }).then(function (j) {
        // The fast tier is billed and the free tier still records tokens (cost 0), so the stats view
        // can total across both modes.
        bookUsage(isCard(j) ? j.usage : null, byo);
        const message = pickMessage(j);
        return isCard(message) ? strOf(message.content) : "";
      });
    });
  }

  /**
   * Push one council step into the right-hand panel. Silent by design: the panel may not exist, may
   * not be showing the council canvas, or may time out — none of which is the caller's problem.
   */
  function councilPush(fn        , args            )                {
    try {
      const panel = envRaw(env.panel);
      if (!isPanel(panel)) return Promise.resolve();
      const st = typeof panel.state === "function" ? panel.state() : null;
      if (!isCard(st) || !st.hasContent) return Promise.resolve();
      return Promise.resolve(panel.call(fn, args || [], 5000)).then(function () {}, function () {});
    } catch (e) {
      return Promise.resolve();
    }
  }

  return {
    v: 1,
    cardByName: cardByName,
    cfg: cfg,
    councilPush: councilPush,
    callWithTools: callWithTools,
    runCharacterAgent: runCharacterAgent,
    oneShot: oneShot,
    callPeerModel: callPeerModel,
  };
}

// ── Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name ──
// agent domain, seventh brick (2026-11-15): the implementation moved to services/agent/peer-calls.ts,
// so every window access lives here — localStorage reads, the fetch exit, the AbortSignal
// constructor, and the five page globals (card library, cards on stage, kernel, tool bundle, memory
// and panel). Each global is resolved per call, never snapshotted: the kernel is an ESM module that
// loads after this file, and services hold these as ports.
(function () {
  if (window.__peerCalls && window.__peerCalls.v === 1) return;

  function browserCaps(host) {
    var caps = {};
    if (host) {
      for (var k in host) {
        if (Object.prototype.hasOwnProperty.call(host, k)) caps[k] = host[k];
      }
    }
    caps.setting = function (key) {
      try {
        return window.localStorage.getItem(key);
      } catch (e) {
        return null;
      }
    };
    caps.signalCtor = function () {
      return typeof AbortSignal !== "undefined" ? AbortSignal : undefined;
    };
    caps.fetch = function (url, init) {
      return window.fetch(url, init);
    };
    caps.env = {
      sceneCards: function () {
        return window.multiSvc && window.multiSvc.getSceneCards ? window.multiSvc.getSceneCards() : null;
      },
      allCards: function () {
        return window.characterSvc && window.characterSvc.listAllCards ? window.characterSvc.listAllCards() : null;
      },
      byo: function () {
        return window.byoProviderSvc && window.byoProviderSvc.get ? window.byoProviderSvc.get() : undefined;
      },
      kernel: function () {
        return window.AgentKernel;
      },
      tools: function () {
        return window.OwnChatTools;
      },
      toolGroup: function (name) {
        return window[name];
      },
      memCore: function () {
        return window.__memCore;
      },
      charMemory: function () {
        return window.__charMemory;
      },
      panel: function () {
        return window.panelSvc;
      },
    };
    return caps;
  }

  window.__peerCalls = {
    v: 1,
    create: function (host) {
      return createPeerCalls(browserCaps(host));
    },
  };
})();

globalThis.createPeerCalls = createPeerCalls;
})();
