(function () {
/**
 * Agent host turn: one kernel loop invocation for a single conversation turn, plus the wiring
 * around it — registry hand-off, retry wrapper, event dispatch, permission bridge, and the two
 * queues (steer messages and screenshots) that feed the next step.
 *
 * Nothing is owned here. The turn object, the session array, the abort controller and every
 * module bridge arrive as arguments, which is what keeps this file free of `window` and of the
 * app's closures.
 *
 * Rules that shaped the code below:
 *  - The turn is never created here. Lifecycle flags (alive / running / deleted) belong to the
 *    caller; this file only reads them as guards.
 *  - Events are the only UI exit. The console hook is a port, never an import.
 *  - Stop is an abort. The caller's signal reaches the kernel, and the tool-round write-back runs
 *    here before the AbortError is rethrown, so a cancelled turn leaves no dangling tool_calls in
 *    the session; the app's catch only freezes the partial text on screen.
 *  - A steer message appends to `messages` without resetting the context. Screenshots are injected
 *    before steers so the model sees the frame before it reads the interruption.
 *  - At most six screenshots per turn; the cap is enforced where they are enqueued, not here.
 *  - The prior summary (when present) rides the system injections as a background block. It is not
 *    Layer 2: the agent keeps its assist posture while retaining what compaction removed.
 *
 * steer / stop / injectImage are not here either: they already ride the caller's turn queues, so
 * this file only owns the in-turn execution.
 *
 * Equivalence is pinned by a real-model baseline replay (three turns: plain text, no tools, a
 * multi-round tool loop with a live fetch) and by the vm lock with a fake host and fake kernel.
 * @module services/agent-host/turn
 */

/** One session message. UI and protocol fields coexist, hence the index signature. */
                              
               
                    
                         
 

/** The caller's turn. Queues and guard flags are read; lifecycle flags are never written. */
                            
                 
                 
                    
                    
                        
                        
                         
 

/** Per-call context handed to the retry wrapper, which owns idle timing and the attempt count. */
                          
                             
                            
                 
                  
 

/** Kernel loop result; the shape is guaranteed by the kernel's own contract. */
                                  
                      
                       
                         
 

/** Minimal face of a module bridge. The real modules are supersets; the wiring injects them. */
                             
                                                                     
                        
 
                               
             
                               
                                                                                    
                        
                                                 
                                                                        
 
                             
             
                         
                              
                                     
                                                        
                                 
                         
                            
                           
                                      
 
                              
                 
                              
                         
                                                          
 
                                 
                                        
                                                                 
 
                               
                                         
 

/** The memory facade this file consults at the end of a turn. */
                                   
                                                                                               
                                                                                             
                                                        
                                                                         
 

/** Module bridges, resolved at call time so a late-loading module is still picked up. */
                                 
                              
                                  
                              
                                
                                      
                                                                                    
                                    
                                  
                                                                                                             
                                        
                                                                                            
                                               
                                                                                   
                      
 

/** The tool-mode module surface this file consumes (see services/policy/tool-mode.ts). */
                                     
                                                          
                                  
                                                  
           
 

/** The tool runtime module surface this file consumes (services/agent/tool-runtime.ts). */
                                        
                                                                 
 

                                  
                             
                                       
                                 
 

/**
 * The subset of `core/runtime.ts`'s RuntimeContext a turn needs. Structural on purpose: this file
 * declares it instead of importing, so the emitted classic product stays import-free.
 */
                            
                    
                                           
                                              
                             
                  
 

/** Per-turn usage accumulator. Mounted on the turn scope, closed exactly once at teardown. */
                             
                            
                                                 
                                                                                                   
                    
 

/** The trace recorder surface (services/chat/turn-events.ts). */
                                
                             
                                             
 

                                   
                                                                                                  
 

/** Host bridge: the app's own closures, injected so this file never reaches into them. */
                                
                              
                                                                                            
                                                                                                
                  
                                                                                                          
                                                                                               
                                                                                   
                    
                                               
                                                                                                   
                                             
                                                                                            
                                                                                                 
                                        
                            
                            
                                      
                                                                  
                                                      
                       
                          
                         
                                                                                            
                                                                   
                                                                                          
                                 
                                                                                                
                                               
                     
                                   
                           
                    
                                                                                      
                  
                              
                                                                                             
                                               
                                                                             
                                      
                                                                              
                                                    
                                                                                                 
                                                                                 
 

                                      
                         
                              
                  
                      
     
                                                                                              
                                                                                                  
                                                                                      
     
                           
                                                                                                  
                                  
 

                                     
                    
                      
                                                                                             
                                             
                                                                                           
                 
 

/** unknown to array, narrowed without an assertion. */
function arrOf(v         )            {
  return Array.isArray(v) ? v : [];
}

/** Read-side bridge from unknown to a plain record; arrays and scalars yield an empty one. */
function recOf(v         )                          {
  const out                          = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

function numOf(v         )         {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The per-turn usage meter. One instance per run, bound to the host before the first model call so
 * the charging site (which owns pricing and the daily log) can report the same numbers the AI row
 * used to accumulate. Closing is the scope's job: after the turn ends, a stray call from a retried
 * request must not land in the next turn's counters.
 */
function createUsageMeter()                                 {
  let p = 0;
  let c = 0;
  let n = 0;
  let closed = false;
  return {
    add: function (usage         ) {
      if (closed) return;
      const u = recOf(usage);
      const prompt = Math.floor(numOf(u["prompt_tokens"]));
      const completion = Math.floor(numOf(u["completion_tokens"]));
      if (prompt <= 0 && completion <= 0) return;
      p += prompt;
      c += completion;
      n += 1;
    },
    summary: function () { return { p: p, c: c, n: n }; },
    closed: function () { return closed; },
    close: function () { closed = true; },
  };
}

/** Per-run mutable bits shared by `run`'s teardown and `execute`'s body. */
                        
                                
                              
                 
                 
                   
 

function createAgentTurn(ports                , args                     ) {
  const session = args.session;
  const controller = args.controller;
  const turn = args.turn;
  const host = args.host;
  const rootScope = args.scope || null;
  const traceRecorder = args.trace || null;

  async function run()                              {
    // One child scope per turn: the abort listener, the usage meter and the scoped tool registry
    // all hang from it, so the end of the turn (any exit: done / abort / error) unwinds them once.
    const turnScope                   = rootScope ? rootScope.fork() : null;
    const usage = createUsageMeter();
    const state               = { tools: null, trace: null, status: "done", reason: "", aborted: false };
    try {
      if (turnScope) {
        turnScope.effect(function () {
          return function () { usage.close(); };
        });
        turnScope.effect(function () {
          const onAbort = function () { state.aborted = true; };
          try { controller.signal.addEventListener("abort", onAbort, { once: true }); } catch (e) { /* already aborted */ }
          return function () {
            try { controller.signal.removeEventListener("abort", onAbort); } catch (e) { /* signal gone */ }
          };
        });
        // Queues belong to this turn; a finished turn must not feed leftovers to the next request.
        turnScope.effect(function () {
          return function () {
            try { if (turn.steerQueue) turn.steerQueue.length = 0; } catch (e) { /* frozen array */ }
            try { if (turn.imageQueue) turn.imageQueue.length = 0; } catch (e) { /* frozen array */ }
          };
        });
      }
      try { if (typeof host.bindUsage === "function") host.bindUsage(usage); } catch (e) { /* stats only */ }
      if (traceRecorder) {
        let meta                                    = {};
        try { meta = (host.getTurnMeta ? host.getTurnMeta() : null) || {}; } catch (e) { meta = {}; }
        state.trace = traceRecorder.begin({ convId: turn.convId, source: "agent", mode: meta.mode || "", model: meta.model || "" });
      }
      const result = await execute(state, turnScope, usage);
      state.status = result.status;
      return result;
    } catch (e) {
      const name = e && typeof e === "object" ? String(Reflect.get(e, "name")) : "";
      state.status = name === "AbortError" ? "aborted" : "error";
      state.reason = e && typeof e === "object" ? String(Reflect.get(e, "message") || "") : String(e);
      throw e;
    } finally {
      if (state.aborted) state.status = "aborted";
      try { if (state.tools) state.tools.dispose("turn-end"); } catch (e) { /* the fork is discarded; removal is best-effort */ }
      try { if (state.trace) state.trace.end(state.status, state.reason); } catch (e) { /* tracing never breaks a turn */ }
      try { if (turnScope) turnScope.dispose(); } catch (e) { /* scoped teardown is best-effort */ }
    }
  }

  async function execute(state              , turnScope                  , usage            )                              {
    // Registry comes prebuilt from the app; the image callback it took is the app's own.
    const toolsConfig = host.getToolsConfig();
    let registry = toolsConfig.registry;
    const envSnap = String(toolsConfig.envSnap || "");

    // Backoff and watchdog live in the wrapper; this only adapts it to the kernel's signature.
    const callLoopMod = ports.callLoop();
    if (!callLoopMod) throw new Error("agent-turn：__callLoop 未接线");
    const _callLoop = callLoopMod.create({
      signal: controller.signal,
      callOnce: (messages, schemas, ctx) => host.callModel(messages, schemas, ctx),
      onResetLive: () => host.resetLive(),
      onRetry: (attempt, code) => host.onRetry(attempt, code),
    });
    const callModel = (messages           , schemas         ) => _callLoop.call(messages, schemas);

    // Starting messages: projection, attachment expansion, protocol shaping. That order is
    // locked app-side, so only the result is consumed here.
    const startMessages = await host.getStartMessages();
    const _startLen = startMessages.length;

    // Console hooks feed the kernel. Clear the activity panel per send, unless a previous run is
    // still going — clearing mid-run would wipe the panel of the turn being watched.
    const _ac = ports.console();
    try {
      const kernel = ports.kernel();
      const _acRunning = !!(kernel && typeof kernel.isRunning === "function" && kernel.isRunning());
      if (_ac && typeof _ac.clear === "function" && !_acRunning) _ac.clear();
    } catch (_) {}

    // Events are recorded for background conversations and drawn only for the current one.
    const eventsMod = ports.events();
    if (!eventsMod) throw new Error("agent-turn：__agentEvents 未接线");
    const _consoleOnEvent = (_ac && typeof _ac.onEvent === "function") ? _ac.onEvent : function () {};
    const _events = eventsMod.create({
      getTurn: () => turn,
      getActiveConvId: () => host.getActiveConvId(),
      isCurrent: (t) => host.isCurrent(t),
      getSteps: () => host.getSteps(),
      onConsole: (ev) => { if (_consoleOnEvent) _consoleOnEvent(ev); },
      onRoundStart: () => host.onRoundStart(),
      isNearBottom: () => host.isNearBottom(),
      scrollToBottom: () => host.scrollToBottom(),
    });
    const _onEvent = (ev         ) => {
      try { if (state.trace) state.trace.feed(ev); } catch (e) { /* tracing never breaks a turn */ }
      _events.dispatch(ev);
    };

    // Permission policy belongs to the host: prompt in front, wait for a tab switch back,
    // auto-deny after five minutes.
    const _ensurePermission = (name        , args         ) => host.requestPermission(name, args);

    // Tool-round write-back, shared by the normal finish and the interrupted path. On abort the
    // kernel has already paired the dangling calls, so writing them back leaves no broken protocol
    // tail in the session. Retry and delete take the discard path instead and skip this — that
    // skip is the ghost-reply defence.
    const _writeBackRounds = (allMsgs         )       => {
      try {
        if (!turn.alive || turn.discard || !host.isCurrent(turn)) return;
        const _mapped = host.kernelMessagesToSession(arrOf(allMsgs), {
          startLen: _startLen,
          isSteered: (m) => host.isSteered(m),
          characterCard: host.getCharacterCard(),
        });
        _mapped.forEach(function (m) { session.push(m); });
        if (_mapped.length) host.persist();
      } catch (_wb) {}
    };

    // Character memory: register its tools, then inject this turn's hits through the host.
    const mem = ports.charMemory();
    if (mem && typeof mem.defineTools === "function") {
      try { mem.defineTools(registry); } catch (e) { console.warn("[char-memory] defineTools 失败:", e); }
    }
    // T4-A: compile this turn's tool set through the pipeline. Compiling AFTER the memory domain
    // registered its tools means those tools get pre/execute/post too; the scoped fork is what the
    // kernel, the tool-mode runtime and peer workers see. `tool_search` and the tools it discovers
    // are defined on the scoped registry during the loop — later additions bypass the wrapper by
    // design (the catalog is the permission surface, the pipeline is the accounting surface).
    try {
      const tr = typeof ports.toolRuntime === "function" ? ports.toolRuntime() : null;
      if (tr && typeof tr.create === "function") {
        let profile                                                              = null;
        try { profile = host.getToolProfile ? host.getToolProfile() : null; } catch (e) { profile = null; }
        const built = tr.create({
          registry: registry,
          profile: profile || undefined,
          scope: turnScope || undefined,
        });
        if (built && built.registry && typeof built.registry === "object") {
          state.tools = built;
          registry = built.registry;
        }
      }
    } catch (e) {
      // A broken pipeline must not cost the turn its tools: the kernel falls back to the full
      // registry the app built (same posture as tool-mode's degrade-to-full).
      state.tools = null;
    }
    let _kbInj = "";
    try {
      if (mem && typeof mem.buildInjection === "function") {
        let _lastUser = "";
        for (let i = startMessages.length - 1; i >= 0; i--) {
          if (startMessages[i] && startMessages[i].role === "user") { _lastUser = String(startMessages[i].content || ""); break; }
        }
        _kbInj = await mem.buildInjection(host.getCharacterCard(), _lastUser);
      }
    } catch (e) {}
    // Compaction continuity: the summary is a system-prompt block (not Layer 2), so the agent
    // keeps the plot/decisions removed from `session` without changing its RP posture.
    const _prior = String(host.getPriorSummary() || "").trim();
    const _summaryBlock = _prior
      ? "\n\n【先前剧情摘要】\n" + _prior + "\n（以上是早期对话压缩后的摘要，作为背景；最近消息仍是原文。）"
      : "";
    const _envWithSummary = envSnap + _summaryBlock;
    host.setInjections(_kbInj, _envWithSummary);

    // B2 C-3: tool mode runtime. LS cfw_tool_mode_v1 defaults to full — no runtime, no
    // tool_search, the kernel sends the registry's full set exactly as before. In directory mode
    // the runtime registers the tool_search executor on the registry and hands the loop a
    // resolveSchemas closure that merges the discovered set into the resident list; the directory
    // text rides the injections so the model sees the catalog. Any failure degrades to full.
    let _resolveSchemas                                                  = undefined;
    try {
      const tm = ports.toolMode();
      const tc = toolsConfig;
      if (tm && typeof tm.createToolModeRuntime === "function") {
        const rt = tm.createToolModeRuntime({
          rawMode: tc.toolModeRaw,
          manifest: tc.toolManifest,
          registry: registry,
          onDirectoryText: function (text        ) {
            try { host.setInjections(_kbInj, _envWithSummary + (text ? "\n\n" + text : "")); } catch (_dt) {}
          },
        });
        if (rt && typeof rt.registerToolSearch === "function" && typeof rt.resolveSchemas === "function") {
          rt.registerToolSearch();
          _resolveSchemas = rt.resolveSchemas;
        }
      }
    } catch (_tm) {
      _resolveSchemas = undefined; // 无 tool_search 回落 full
    }

    // Kernel loop. The round cap is configurable; the signal goes to the kernel so stop / retry /
    // delete can break both a pending permission wait and the gap between rounds.
    const kernel = ports.kernel();
    if (!kernel) throw new Error("agent-turn：AgentKernel 未接线");
    let result                 ;
    try {
      result = await kernel.runAgentLoop({
        messages: startMessages,
        registry: registry,
        callModel: callModel,
        maxIterations: host.getAgentMaxRounds(),
        context: {
          characterCard: host.getCharacterCard(),
          callModel: callModel,
          onEvent: _onEvent,
          ensurePermission: _ensurePermission,
          // Peer workers fork this exact registry, so a child gets the same tools and permission
          // posture as its session agent — only orchestration tools are excluded by the caller.
          registry: registry,
          depth: 0,
          __turn: turn,
          __convId: turn.convId,
          __card: host.getCharacterCard(),
          __visionOn: ports.visionOn(),
        },
        onEvent: _onEvent,
        ensurePermission: _ensurePermission,
        resolveSchemas: _resolveSchemas,
        beforeStep: [function _drainSteerAndShots() {
          const out            = [];
          // Screenshots first: the model should see the frame before it reads the interruption.
          if (turn.imageQueue && turn.imageQueue.length) {
            for (const im of turn.imageQueue.splice(0)) {
              const rec = recOf(im);
              const meta = recOf(rec.meta);
              out.push({
                role: "user",
                content: [
                  { type: "text", text: "[pc_shot] 远程电脑截图" + (meta.w ? " " + meta.w + "x" + meta.h : "") + "。画面仅供判断；要点击请用 pc_ui 的控件坐标或 pc_click_control。" },
                  { type: "image_url", image_url: { url: rec.dataUrl } },
                ],
              });
            }
          }
          if (turn.steerQueue && turn.steerQueue.length) out.push(...turn.steerQueue.splice(0));
          return out.length ? { append: out } : undefined;
        }],
        signal: controller.signal,
      });
    } catch (e) {
      // Abort: finish the step block, write back the dangling tool_calls the kernel prepared, then
      // rethrow untouched — the app's catch only freezes the partial text, nothing else lands.
      if (e && e.name === "AbortError") {
        try { const _S = host.getSteps(); if (_S) _S.finish("aborted"); } catch (_fz) {}
        if (e._agentMessages) _writeBackRounds(e._agentMessages);
        state.status = "aborted";
        state.reason = String((e && e.message) || "");
      } else {
        state.status = "error";
        state.reason = e && typeof e === "object" ? String(Reflect.get(e, "message") || "") : String(e);
      }
      throw e;
    }

    const finalText = String((result && result.finalText) || "");
    // The kernel's stop reason is the turn's outcome; map it onto the trace vocabulary once.
    const stopReason = result && typeof result.stopReason === "string" ? result.stopReason : "stop";
    state.status = stopReason === "stop" ? "done" : stopReason;
    // End of turn: the step block collapses into a one-line summary, the reply follows below.
    try { const _S = host.getSteps(); if (_S) _S.finish("done"); } catch (_fz) {}

    // Write the tool rounds back into the session. Dropping them made the model restart from
    // scratch every round, which is what made the agent look like it was playing house. Appended
    // in protocol order — assistant with tool_calls, then results — and persisted; the UI-only
    // fields are stripped when the request body is assembled.
    _writeBackRounds(result && result.messages);

    // End-of-turn auto write (cfw_mem_auto_v1, default off). Only the final visible answer is
    // offered to the shared writer: tool-round text never reaches here, and every failure (kernel
    // throw, abort) has already returned or rethrown before this point. The writer owns the
    // empty/config/rejection guards, so this line cannot drift from the ordinary chat path.
    try {
      const memory = ports.memory();
      if (memory && typeof memory.autoWriteTurn === "function") {
        memory.autoWriteTurn(finalText, host.getCharacterCard(), turn.convId);
      }
    } catch (e) {
      try { console.warn("[memory] 自动写入失败（回合不受影响）:", e); } catch (_) {}
    }

    return { finalText: finalText, messages: arrOf(result && result.messages), usage: usage.summary(), status: state.status };
  }

  return {
    run,
  };
}

// Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name.
// Every module bridge is resolved per call, never captured: the kernel, events, console and
// character memory are globals assembled earlier in boot and can still be missing here. The
// `__context` instance (which closes over the app) and the permission-card policy arrive through
// `host` instead — they are page state, not platform surface.
(function () {
  if (window.__agentTurn) return;
  var ports = {
    kernel: function () { return window.AgentKernel || null; },
    callLoop: function () { return window.__callLoop || null; },
    events: function () { return window.__agentEvents || null; },
    console: function () { return window.agentConsoleSvc || null; },
    charMemory: function () { return window.__charMemory || null; },
    // L1/L2 memory facade: the turn-end auto writer reads cfw_mem_auto_v1 and calls remember().
    memory: function () { return window.__memCore || null; },
    feedback: function () { return window.feedbackSvc || null; },
    // B2 C-3: the tool-mode runtime (policy domain). Absent product → null → full mode, no tool_search.
    toolMode: function () { try { return window.toolModeSvc || null; } catch (e) { return null; } },
    // T4-A: the scoped tool pipeline. Absent product → the kernel gets the app-built registry as-is.
    toolRuntime: function () { try { return window.toolRuntimeSvc || null; } catch (e) { return null; } },
    visionOn: function () {
      try { return !!window.__agentVisionOn; } catch (e) { return false; }
    },
  };
  window.__agentTurn = {
    create: function (o) { return createAgentTurn(ports, o); },
  };
})();

globalThis.createUsageMeter = createUsageMeter;
globalThis.createAgentTurn = createAgentTurn;
})();
