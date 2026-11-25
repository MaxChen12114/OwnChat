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
export interface PromptProfileLike {
  baseIdPayload(card?: unknown): Record<string, unknown>;
  neutralIdPayload(): Record<string, unknown>;
  stateLayerPayload(): Record<string, unknown>;
}

/** Only the part of an AbortSignal this module forwards. */
export interface SignalLike {
  readonly aborted: boolean;
}

/** The AbortSignal constructor surface used to fold a hard timeout into the caller's signal. */
export interface SignalCtorLike {
  any?(signals: unknown[]): SignalLike;
  timeout?(ms: number): SignalLike;
}

/** Only what this module reads off a `/api/chat` response. */
export interface ChatResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/** Request init this module sends; a real RequestInit satisfies it structurally. */
export interface PostInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: SignalLike;
}

/** A role card as this module sees it: an opaque record addressed by `id` / `name`. */
export interface Card {
  [key: string]: unknown;
  id?: unknown;
  name?: unknown;
}

interface KernelLike {
  runAgentLoop(args: Record<string, unknown>): Promise<unknown>;
}

interface ToolsLike {
  buildRegistry(opts: { profile: string }): unknown;
}

interface ToolGroupLike {
  defineTools(registry: unknown): void;
}

interface MemCoreLike {
  buildInjection(cid: unknown, brief: string): unknown;
  enabled?(): unknown;
  remember?(text: string, meta?: unknown): unknown;
}

interface CharMemoryLike {
  buildInjection(card: unknown, brief: string): unknown;
}

interface PanelLike {
  state(): unknown;
  call(fn: string, args: unknown[], timeoutMs?: number): Promise<unknown>;
}

/**
 * Browser globals the page owns. Wiring resolves each one lazily, so a module that loads early still
 * sees the kernel and memory core that appear later. Every member may be absent: each call site has
 * a defined degraded path, and the old code swallowed the same failures.
 */
export interface PeerEnv {
  /** `__multi.getSceneCards()` — the characters currently on stage. */
  sceneCards?(): unknown;
  /** `__character.listAllCards()` — the whole card library. */
  allCards?(): unknown;
  /** The user's own provider when one is configured; undefined on the hosted path. */
  byo?(): unknown;
  /** The agent kernel module (ESM, so possibly not there yet). */
  kernel?(): unknown;
  /** The tools bundle; `buildRegistry` is the only entry used. */
  tools?(): unknown;
  /** One tool group by name — the ones the tools bundle's tiers do not cover are attached by hand. */
  toolGroup?(name: string): unknown;
  /** The memory core: injection, enable flag, remember. */
  memCore?(): unknown;
  /** Per-character memory; a separate store from the memory core above. */
  charMemory?(): unknown;
  /** The right-hand council panel. */
  panel?(): unknown;
}

/** Page-level state and exits, one member per old `host` field. All optional (the old code defaulted too). */
export interface PeerCaps {
  env?: PeerEnv;
  /** The current turn's controller, so the stop button also kills a peer call. Null when idle. */
  signal?(): { signal: SignalLike } | null;
  /** `AbortSignal` itself; wiring forwards the browser constructor. */
  signalCtor?(): SignalCtorLike | undefined;
  mode?(): string;
  /** One localStorage read; the reply-style stamp and the council knobs both come through here. */
  setting?(key: string): string | null;
  modelFallback?(): unknown;
  useBuiltin?(): boolean;
  promptEnabled?(): boolean;
  customPrompt?(): string;
  extraPrompts?(mode: string, card: unknown): string;
  promptProfile?: PromptProfileLike;
  providerId?(): Record<string, unknown>;
  formatError?(text: string): string;
  usage?(prompt: number, completion: number, cached: number, model: unknown, byo: unknown): void;
  /** Network exit. */
  fetch?(url: string, init: PostInit): Promise<ChatResponse>;
}

/** Result of {@link PeerCallsApi.runCharacterAgent}. `error` is display text, never thrown. */
export interface AgentRunResult {
  ok: boolean;
  error?: string;
  said?: string;
  iterations?: unknown;
  stopReason?: unknown;
}

/** Options for one character-as-agent run, field for field the old `opts`. */
export interface AgentRunOpts {
  maxIterations?: unknown;
  depth?: unknown;
  onEvent?(event: Record<string, unknown>): void;
  /** Gate for side-effecting tools; defaults to deny, so a peer can never mutate user data. */
  ensurePermission?(name: string, args?: unknown): Promise<boolean>;
}

/** Options for {@link PeerCallsApi.oneShot}. */
export interface OneShotOpts {
  user?: unknown;
  system?: unknown;
  timeoutMs?: number;
}

/** Public surface, name for name the old window contract. `v` stays 1. */
export interface PeerCallsApi {
  v: number;
  cardByName(name: unknown): Card | null;
  cfg(): { meetingMax: number; meetingRounds: number; ctxMsgs: number };
  councilPush(fn: string, args?: unknown[]): Promise<void>;
  callWithTools(card: Card | null, messages: unknown[], schemas: unknown): Promise<Record<string, unknown>>;
  runCharacterAgent(card: Card | null, brief: unknown, opts?: AgentRunOpts): Promise<AgentRunResult>;
  oneShot(opts?: OneShotOpts): Promise<string>;
  callPeerModel(card: Card | null, view: unknown, brief: unknown): Promise<string>;
}

const EMPTY_PROFILE: PromptProfileLike = {
  baseIdPayload: () => ({}),
  neutralIdPayload: () => ({}),
  stateLayerPayload: () => ({}),
};

/** Tool groups a peer agent must be handed explicitly; the tools bundle's tiers do not cover them. */
const EXTRA_TOOL_GROUPS = ["__agentWorkspace", "__sourceTools", "__localExecTools", "__stageTools"];

function isCard(value: unknown): value is Card {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cardOf(value: unknown): Card | null {
  return isCard(value) ? value : null;
}

function arrOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function strOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** String coercion matching the old `String(x || "")`, which also let numbers through. */
function textOf(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function numOf(value: unknown): number {
  return typeof value === "number" && isFinite(value) ? value : 0;
}

/** Name normalisation for card matching: drop whitespace, brackets and punctuation, then lower-case. */
function normalizeName(value: unknown): string {
  return textOf(value).replace(/[\s【】\[\]()（）「」·,，.。!！?？~]/g, "").toLowerCase();
}

/** The assistant message of a chat-completions response, or null for any other shape. */
function pickMessage(json: unknown): unknown {
  if (!isCard(json)) return null;
  const choices = arrOf(json.choices);
  const first = choices.length ? choices[0] : null;
  return isCard(first) ? first.message : null;
}

function isKernel(value: unknown): value is KernelLike {
  return isCard(value) && typeof value.runAgentLoop === "function";
}

function isTools(value: unknown): value is ToolsLike {
  return isCard(value) && typeof value.buildRegistry === "function";
}

function isToolGroup(value: unknown): value is ToolGroupLike {
  return isCard(value) && typeof value.defineTools === "function";
}

function isMemCore(value: unknown): value is MemCoreLike {
  return isCard(value) && typeof value.buildInjection === "function";
}

function isCharMemory(value: unknown): value is CharMemoryLike {
  return isCard(value) && typeof value.buildInjection === "function";
}

function isPanel(value: unknown): value is PanelLike {
  return isCard(value) && typeof value.call === "function";
}

export function createPeerCalls(caps: PeerCaps): PeerCallsApi {
  const port: PeerCaps = caps || {};
  const env: PeerEnv = port.env || {};

  const setting = typeof port.setting === "function" ? port.setting : function (): string | null { return null; };
  const post = typeof port.fetch === "function" ? port.fetch : null;
  const signalCtor = typeof port.signalCtor === "function" ? port.signalCtor : function (): SignalCtorLike | undefined { return undefined; };
  const prof: PromptProfileLike = port.promptProfile || EMPTY_PROFILE;

  /** Read one browser handle; missing getter and missing value collapse to undefined. */
  function envRaw(getter: (() => unknown) | undefined): unknown {
    return typeof getter === "function" ? getter() : undefined;
  }

  /** Reply style is read per call: the user can switch it mid-session and the next peer call obeys. */
  function replyStyle(): string {
    try {
      return setting("cfw_reply_style_v1") || "default";
    } catch (e) {
      return "default";
    }
  }

  /** Caller's signal folded with a hard timeout — non-streaming calls have no watchdog of their own. */
  function peerSignal(timeoutMs: number): SignalLike | undefined {
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

  function byoProvider(): Card | null {
    const raw = typeof env.byo === "function" ? env.byo() : undefined;
    return raw ? cardOf(raw) : null;
  }

  function modelFor(byo: Card | null): unknown {
    return byo ? byo.model : (typeof port.modelFallback === "function" ? port.modelFallback() : "");
  }

  function modeNow(): string {
    return typeof port.mode === "function" ? port.mode() : "";
  }

  /** Persona switch combination: the custom prompt applies only when the built-in persona is off. */
  function customPromptNow(): string {
    const builtin = typeof port.useBuiltin === "function" ? port.useBuiltin() : false;
    const enabled = typeof port.promptEnabled === "function" ? port.promptEnabled() : false;
    if (builtin || !enabled) return "";
    return typeof port.customPrompt === "function" ? port.customPrompt() : "";
  }

  function extraPromptsNow(card: unknown): string {
    return typeof port.extraPrompts === "function" ? port.extraPrompts(modeNow(), card) : "";
  }

  function providerNow(): Record<string, unknown> {
    const raw = typeof port.providerId === "function" ? port.providerId() : {};
    return isCard(raw) ? raw : {};
  }

  function formatErrorNow(text: string): string {
    return typeof port.formatError === "function" ? port.formatError(text) : text;
  }

  function bookUsage(usage: unknown, byo: Card | null): void {
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

  function send(body: Record<string, unknown>, signal: SignalLike | undefined): Promise<ChatResponse> {
    if (!post) return Promise.reject(new Error("fetch 未注入"));
    return post("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: signal,
      body: JSON.stringify(body),
    });
  }

  /** Card name matching: exact, then decoration-stripped equality, then mutual containment (≥2 chars). */
  function matchName(list: unknown[], raw: string, norm: string): Card | null {
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
  function cardByName(name: unknown): Card | null {
    const raw = textOf(name).trim();
    if (!raw) return null;
    const norm = normalizeName(raw);
    const onStage = matchName(arrOf(envRaw(env.sceneCards)), raw, norm);
    if (onStage) return onStage;
    return matchName(arrOf(envRaw(env.allCards)), raw, norm);
  }

  function cfg(): { meetingMax: number; meetingRounds: number; ctxMsgs: number } {
    const num = function (key: string, def: number, lo: number, hi: number): number {
      const n = parseInt(textOf(setting(key)), 10);
      return isNaN(n) ? def : Math.max(lo, Math.min(hi, n));
    };
    return {
      meetingMax: num("cfw_ma_meeting_max_v1", 6, 1, 6),
      meetingRounds: num("cfw_ma_meeting_rounds_v1", 1, 1, 2),
      ctxMsgs: num("cfw_ma_ctx_msgs_v1", 60, 0, 400),
    };
  }

  /**
   * One "hands on" call as a peer: rp profile, non-streaming, 90s hard timeout, tools when given.
   * Resolves `{ content }` plus whatever of `tool_calls` / `reasoning_content` came back; rejects with
   * the beautified upstream text on a non-2xx.
   */
  function callWithTools(card: Card | null, messages: unknown[], schemas: unknown): Promise<Record<string, unknown>> {
    const sig = peerSignal(90000);
    const byo = byoProvider();
    const body: Record<string, unknown> = {
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
        const out: Record<string, unknown> = { content: strOf(isCard(message) ? message.content : "") };
        if (isCard(message) && Array.isArray(message.tool_calls) && message.tool_calls.length) out.tool_calls = message.tool_calls;
        if (isCard(message) && message.reasoning_content) out.reasoning_content = message.reasoning_content;
        return out;
      });
    });
  }

  /** Attach the tool groups the tools bundle's tiers leave out; one failing group must not sink the run. */
  function attachExtraTools(registry: unknown): void {
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
  function runCharacterAgent(card: Card | null, brief: unknown, opts?: AgentRunOpts): Promise<AgentRunResult> {
    const o: AgentRunOpts = opts || {};
    if (!card) return Promise.resolve({ ok: false, error: "缺少角色" });
    const kernel = envRaw(env.kernel);
    if (!isKernel(kernel)) return Promise.resolve({ ok: false, error: "内核未就绪" });
    let registry: unknown = null;
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
        callModel: function (msgs: unknown[], schemas: unknown) { return callWithTools(card, arrOf(msgs), schemas); },
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
  function oneShot(opts?: OneShotOpts): Promise<string> {
    const o: OneShotOpts = opts || {};
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
  function callPeerModel(card: Card | null, view: unknown, brief: unknown): Promise<string> {
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
  function councilPush(fn: string, args?: unknown[]): Promise<void> {
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
