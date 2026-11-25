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
 *
 * steer / stop / injectImage are not here either: they already ride the caller's turn queues, so
 * this file only owns the in-turn execution.
 *
 * Equivalence is pinned by a real-model baseline replay (three turns: plain text, no tools, a
 * multi-round tool loop with a live fetch) and by the vm lock with a fake host and fake kernel.
 * @module services/agent-host/turn
 */

/** One session message. UI and protocol fields coexist, hence the index signature. */
export interface TurnMessage {
  role: string;
  content?: unknown;
  [key: string]: unknown;
}

/** The caller's turn. Queues and guard flags are read; lifecycle flags are never written. */
export interface AgentTurn {
  convId: string;
  alive: boolean;
  discard?: boolean;
  stopped?: boolean;
  steerQueue: unknown[];
  imageQueue: unknown[];
  [key: string]: unknown;
}

/** Per-call context handed to the retry wrapper, which owns idle timing and the attempt count. */
export interface CallCtx {
  signal: AbortSignal | null;
  armIdle(ms: number): void;
  idleMs: number;
  attempt: number;
}

/** Kernel loop result; the shape is guaranteed by the kernel's own contract. */
export interface AgentLoopResult {
  finalText?: unknown;
  messages?: unknown[];
  [key: string]: unknown;
}

/** Minimal face of a module bridge. The real modules are supersets; the wiring injects them. */
export interface KernelLike {
  runAgentLoop(o: Record<string, unknown>): Promise<AgentLoopResult>;
  isRunning?(): boolean;
}
export interface CallLoopLike {
  create(o: {
    signal: AbortSignal | null;
    callOnce(messages: unknown[], schemas: unknown, ctx: CallCtx): Promise<unknown>;
    onResetLive(): void;
    onRetry(attempt: number, code: string): void;
  }): { call(messages: unknown[], schemas: unknown): Promise<unknown> };
}
export interface EventsLike {
  create(o: {
    getTurn(): AgentTurn;
    getActiveConvId(): string;
    isCurrent(t: AgentTurn): boolean;
    getSteps(): { finish(reason: string): void } | null;
    onConsole(ev: unknown): void;
    onRoundStart(): void;
    isNearBottom(): boolean;
    scrollToBottom(): void;
  }): { dispatch(ev: unknown): void };
}
export interface ConsoleLike {
  clear?(): void;
  onEvent?(ev: unknown): void;
  note?(s: string): void;
  ensurePermission?(name: string, args: unknown): unknown;
}
export interface CharMemoryLike {
  defineTools?(registry: unknown): void;
  buildInjection?(card: unknown, query: string): Promise<string>;
}
export interface FeedbackLike {
  toast?(msg: string, ms?: number): void;
}

/** Module bridges, resolved at call time so a late-loading module is still picked up. */
export interface AgentTurnPorts {
  kernel(): KernelLike | null;
  callLoop(): CallLoopLike | null;
  events(): EventsLike | null;
  console(): ConsoleLike | null;
  charMemory(): CharMemoryLike | null;
  feedback(): FeedbackLike | null;
  /** B2 C-3: the tool-mode runtime module (window.__toolMode), or null when the policy domain is absent. */
  toolMode(): ToolModeModuleLike | null;
  /** Whether vision input is on for this send; the app writes it when it sends. */
  visionOn(): boolean;
}

/** The tool-mode module surface this file consumes (see services/policy/tool-mode.ts). */
export interface ToolModeModuleLike {
  createToolModeRuntime(input: Record<string, unknown>): {
    registerToolSearch(): boolean;
    resolveSchemas(schemas: unknown[]): unknown[];
  } | null;
}

/** Host bridge: the app's own closures, injected so this file never reaches into them. */
export interface AgentTurnHost {
  getCharacterCard(): unknown;
  /** Tool registry (built app-side, with the image callback) plus the environment snapshot.
   * B2 C-3 adds the policy manifest payload and the raw tool-mode flag; both optional, absent =
   * full mode. */
  getToolsConfig(): { registry: unknown; envSnap: string; toolManifest?: unknown; toolModeRaw?: unknown };
  /** Request assembly and SSE, which stay in the app; the wrapper's single call lands here. */
  callModel(messages: unknown[], schemas: unknown, ctx: CallCtx): Promise<unknown>;
  resetLive(): void;
  onRetry(attempt: number, code: string): void;
  /** Session projection, attachment expansion and protocol shaping; only the start is consumed. */
  getStartMessages(): Promise<TurnMessage[]>;
  getActiveConvId(): string;
  isCurrent(turn: AgentTurn): boolean;
  /** Handle for the step block; the app owns its DOM mounting. */
  getSteps(): { finish(reason: string): void } | null;
  onRoundStart(): void;
  isNearBottom(): boolean;
  scrollToBottom(): void;
  /** Permission prompt, including the background-tab wait and the five-minute auto-deny. */
  requestPermission(name: string, args: unknown): Promise<boolean>;
  /** Marker for steer messages already pushed into the session (an app-level WeakSet). */
  isSteered(m: unknown): boolean;
  /** Tool-round messages projected into session messages; the app supplies the steer marker. */
  kernelMessagesToSession(msgs: unknown[], o: {
    startLen: number;
    isSteered(m: unknown): boolean;
    characterCard: unknown;
  }): TurnMessage[];
  /** Persist this turn's private state; the guard for a deleted turn lives inside. */
  persist(): void;
  getAgentMaxRounds(): number;
  /** Knowledge-base injection plus the snapshot, read when the request body is assembled. */
  setInjections(kb: string, env: string): void;
}

export interface AgentTurnCreateArgs {
  session: TurnMessage[];
  controller: AbortController;
  turn: AgentTurn;
  host: AgentTurnHost;
}

export interface AgentTurnRunResult {
  finalText: string;
  messages: unknown[];
}

/** unknown to array, narrowed without an assertion. */
function arrOf(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Read-side bridge from unknown to a plain record; arrays and scalars yield an empty one. */
function recOf(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

export function createAgentTurn(ports: AgentTurnPorts, args: AgentTurnCreateArgs) {
  const session = args.session;
  const controller = args.controller;
  const turn = args.turn;
  const host = args.host;

  async function run(): Promise<AgentTurnRunResult> {
    // Registry comes prebuilt from the app; the image callback it took is the app's own.
    const toolsConfig = host.getToolsConfig();
    const registry = toolsConfig.registry;
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
    const callModel = (messages: unknown[], schemas: unknown) => _callLoop.call(messages, schemas);

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
    const _onEvent = (ev: unknown) => _events.dispatch(ev);

    // Permission policy belongs to the host: prompt in front, wait for a tab switch back,
    // auto-deny after five minutes.
    const _ensurePermission = (name: string, args: unknown) => host.requestPermission(name, args);

    // Tool-round write-back, shared by the normal finish and the interrupted path. On abort the
    // kernel has already paired the dangling calls, so writing them back leaves no broken protocol
    // tail in the session. Retry and delete take the discard path instead and skip this — that
    // skip is the ghost-reply defence.
    const _writeBackRounds = (allMsgs: unknown): void => {
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
    host.setInjections(_kbInj, envSnap);

    // B2 C-3: tool mode runtime. LS cfw_tool_mode_v1 defaults to full — no runtime, no
    // tool_search, the kernel sends the registry's full set exactly as before. In directory mode
    // the runtime registers the tool_search executor on the registry and hands the loop a
    // resolveSchemas closure that merges the discovered set into the resident list; the directory
    // text rides the injections so the model sees the catalog. Any failure degrades to full.
    let _resolveSchemas: ((schemas: unknown[]) => unknown[]) | undefined = undefined;
    try {
      const tm = ports.toolMode();
      const tc = toolsConfig;
      if (tm && typeof tm.createToolModeRuntime === "function") {
        const rt = tm.createToolModeRuntime({
          rawMode: tc.toolModeRaw,
          manifest: tc.toolManifest,
          registry: registry,
          onDirectoryText: function (text: string) {
            try { host.setInjections(_kbInj, envSnap + (text ? "\n\n" + text : "")); } catch (_dt) {}
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
    let result: AgentLoopResult;
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
          const out: unknown[] = [];
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
      }
      throw e;
    }

    const finalText = String((result && result.finalText) || "");
    // End of turn: the step block collapses into a one-line summary, the reply follows below.
    try { const _S = host.getSteps(); if (_S) _S.finish("done"); } catch (_fz) {}

    // Write the tool rounds back into the session. Dropping them made the model restart from
    // scratch every round, which is what made the agent look like it was playing house. Appended
    // in protocol order — assistant with tool_calls, then results — and persisted; the UI-only
    // fields are stripped when the request body is assembled.
    _writeBackRounds(result && result.messages);

    return { finalText: finalText, messages: arrOf(result && result.messages) };
  }

  return {
    run,
  };
}
