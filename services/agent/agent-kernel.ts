/**
 * Tool-calling kernel: the registry a turn reaches tools through, and the loop that drives it.
 *
 * Transport-agnostic and DOM-free, because everything it cannot know arrives as a port: which model
 * to call, which capabilities exist, how to ask a human for permission. The kernel owns only the
 * registry and the while-loop (model -> tool_calls -> run -> feed back -> repeat).
 *
 * Two invariants make the loop safe to abandon mid-flight. `activeLoops` is module-wide, so
 * `isRunning()` answers the autopilot mutex without knowing which turn owns it; and every exit path
 * pairs pending tool calls first, because a `tool_call` without its `tool` result is a protocol break
 * that 400s the next request — the AbortError the host catches carries `_agentMessages` already
 * repaired. Cancellation wins against both long waits (permission, tool run), which is why neither
 * is awaited bare.
 *
 * The permission gate is fail-closed, and its three denials are worded apart — gate missing, gate
 * threw, user refused — so the model can reroute instead of retrying the same call blindly.
 * @module services/agent/agent-kernel
 */

export interface ToolSchema {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** Predicate form exists because one tool can be harmless for reads and destructive for writes. */
export type DestructivePredicate = (args: Record<string, unknown>) => boolean;
export type ToolRunner = (args: Record<string, unknown>, context: Record<string, unknown>) => unknown;

export interface ToolDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  run: ToolRunner;
  destructive?: boolean | DestructivePredicate;
}

export interface RegisteredTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run: ToolRunner;
  /** Kept in callable form on purpose: the gate evaluates it per call, not per registration. */
  destructive: boolean | DestructivePredicate;
}

export interface ToolRegistry {
  define(def: ToolDefinition): ToolRegistry;
  get(name: string): RegisteredTool | undefined;
  list(): RegisteredTool[];
  toSchemas(): ToolSchema[];
  /** Remove one tool in place. Returns true when a tool was actually removed. */
  remove(name: string): boolean;
  /**
   * Copy this registry, minus the named tools. The copy shares nothing mutable with the source:
   * a child agent gets the parent's full capability set except orchestration tools, so it is a
   * peer worker rather than a read-only helper, and cannot spawn another child.
   */
  fork(exclude?: string[]): ToolRegistry;
}

export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, RegisteredTool>();

  /**
   * Register one tool. `destructive` is stored as given — a function stays a function, so the gate
   * can judge a call by its actual arguments.
   */
  function define(def: ToolDefinition): ToolRegistry {
    if (!def || !def.name || typeof def.run !== "function") {
      throw new Error("[agent-kernel] define 需要 { name, run }");
    }
    tools.set(def.name, {
      name: def.name,
      description: def.description || "",
      parameters: def.parameters || { type: "object", properties: {} },
      run: def.run,
      destructive: def.destructive ?? false,
    });
    return registry;
  }

  function get(name: string): RegisteredTool | undefined {
    return tools.get(name);
  }

  function list(): RegisteredTool[] {
    return [...tools.values()];
  }

  /** OpenAI / DeepSeek compatible `tools` array. */
  function toSchemas(): ToolSchema[] {
    return list().map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  /**
   * Copy the registered tools into a fresh registry, skipping the excluded names. Entries are
   * re-defined one by one so `destructive` stays a callable predicate and the source map is never
   * aliased — mutating the fork cannot change the parent turn's tools.
   */
  function fork(exclude?: string[]): ToolRegistry {
    const skip = new Set(exclude || []);
    const copy = createToolRegistry();
    for (const t of list()) {
      if (skip.has(t.name)) continue;
      copy.define({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        run: t.run,
        destructive: t.destructive,
      });
    }
    return copy;
  }

  /** Remove one tool in place so a freshly built fallback registry can shed orchestration tools. */
  function remove(name: string): boolean {
    return tools.delete(name);
  }

  const registry: ToolRegistry = { define, get, list, toSchemas, fork, remove };
  return registry;
}

/** Turns currently inside `runAgentLoop`, module-wide: the mutex signal autopilot probes. */
let activeLoops = 0;

/** Whether any agent turn is running right now. */
export function isRunning(): boolean {
  return activeLoops > 0;
}

export interface ToolCall {
  id?: string;
  /** OpenAI protocol discriminant; every echoed call must carry it or DeepSeek 422s the next turn. */
  type?: string;
  function?: { name?: string; arguments?: string };
  [key: string]: unknown;
}

/** Repairs stored calls from older turns by adding the required discriminant before a new request. */
export function normalizeToolCallTypes(calls: unknown): ToolCall[] {
  if (!Array.isArray(calls)) return [];
  return calls.map((call) => {
    if (call === null || typeof call !== "object" || Array.isArray(call)) return {};
    const entry: ToolCall = {};
    for (const [key, value] of Object.entries(call)) entry[key] = value;
    entry.type = typeof entry.type === "string" && entry.type ? entry.type : "function";
    return entry;
  });
}

export interface ToolResultMeta {
  name: string;
  args: Record<string, unknown> | null;
  ok: boolean;
  ms?: number;
  error?: string;
  denied?: boolean;
  denied_reason?: string;
}

export interface LoopMessage {
  role: string;
  content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
  /** Render-only hint for the tool-call card; request assembly strips it before sending. */
  _tool?: ToolResultMeta;
  [key: string]: unknown;
}

export interface ModelReply {
  content?: string;
  tool_calls?: ToolCall[];
  reasoning_content?: string;
}

export interface StepState {
  iteration: number;
  messages: LoopMessage[];
  registry: ToolRegistry;
}

export interface StepVerdict {
  reject?: string;
  append?: LoopMessage[];
}

export type KernelEvent = Record<string, unknown>;
export type CallModel = (messages: LoopMessage[], schemas: ToolSchema[]) => Promise<ModelReply> | ModelReply;
export type EnsurePermission = (toolName: string, args: Record<string, unknown>) => Promise<boolean>;
export type BeforeStepHook = (state: StepState) => Promise<StepVerdict | void> | StepVerdict | void;

export type StopReason = "stop" | "model_error" | "max_iterations" | "blocked";

export interface RunAgentLoopOpts {
  /** OpenAI-shaped messages. Appended to in place; the caller keeps ownership. */
  messages: LoopMessage[];
  registry: ToolRegistry;
  callModel: CallModel;
  maxIterations?: number;
  context?: Record<string, unknown>;
  /**
   * Pre-flight gate for destructive tools. Absent, throwing, or refusing all deny the call — the
   * three cases carry different wording and `denied_reason` so the model can tell them apart.
   */
  ensurePermission?: EnsurePermission;
  onEvent?: (event: KernelEvent) => void;
  /**
   * Policy hook(s) run before each model request. `{reject}` ends the turn with `blocked` without
   * spending a request; `{append}` injects context (time, state, compaction checkpoints) first.
   * A hook that throws counts as a rejection: policy failure must not let a request through.
   */
  beforeStep?: BeforeStepHook | BeforeStepHook[];
  /**
   * Cancellation. On abort the kernel repairs pending tool calls and then **throws** an AbortError
   * carrying `_agentMessages` — it never returns a half result. Upstream/tool errors are not
   * cancellation: they close the turn with `model_error` or a fed-back tool error.
   */
  signal?: AbortSignal;
  /** Schema swap hook (catalogue / adaptive modes). Runs once per turn so the prefix stays stable. */
  resolveSchemas?: (schemas: ToolSchema[]) => ToolSchema[];
}

export interface RunAgentLoopResult {
  finalText: string;
  messages: LoopMessage[];
  iterations: number;
  stopReason: StopReason;
}

interface AbortWithMessages extends Error {
  _agentMessages?: LoopMessage[];
}

export const runAgentLoop = async (opts: RunAgentLoopOpts): Promise<RunAgentLoopResult> => {
  const o: Partial<RunAgentLoopOpts> = opts || {};
  const { messages, registry, callModel, ensurePermission, beforeStep, signal, resolveSchemas } = o;
  const maxIterations = o.maxIterations ?? 8;
  const context = o.context || {};
  const onEvent = o.onEvent || (() => {});

  if (!Array.isArray(messages)) throw new Error("[agent-kernel] messages 必须是数组");
  if (!registry || typeof registry.toSchemas !== "function")
    throw new Error("[agent-kernel] 需要合法 registry");
  if (typeof callModel !== "function")
    throw new Error("[agent-kernel] 需要注入 callModel");

  const abortError = (msg?: string): AbortWithMessages => {
    const e: AbortWithMessages = new Error(msg || "回合已中断");
    e.name = "AbortError";
    e._agentMessages = messages;
    return e;
  };
  const isAborted = () => !!(signal && signal.aborted);
  /**
   * Race a promise that has no signal parameter of its own (the permission gate waits for a human,
   * a tool may never return) against cancellation. Abort rejects; the caller then throws.
   */
  const raceWithAbort = <T>(promise: Promise<T>, onAbort: () => Error): Promise<T> => {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(onAbort());
    return new Promise<T>((resolve, reject) => {
      const hit = () => reject(onAbort());
      signal.addEventListener("abort", hit, { once: true });
      promise.then(
        (v) => { signal.removeEventListener("abort", hit); resolve(v); },
        (e) => { signal.removeEventListener("abort", hit); reject(e); },
      );
    });
  };
  const abortNow = (phase: string, i: number): AbortWithMessages => {
    onEvent({ type: "aborted", iteration: i, phase });
    pairPendingToolCalls(messages, "回合被用户中断，本轮已发出的工具调用结果未知");
    return abortError("回合被用户中断");
  };

  const beforeSteps: BeforeStepHook[] = Array.isArray(beforeStep) ? beforeStep : beforeStep ? [beforeStep] : [];

  activeLoops++;
  try {
    for (let i = 0; i < maxIterations; i++) {
      // A tool run is not interruptible, so cancellation can land between iterations; converge here.
      if (isAborted()) throw abortNow("between_iterations", i);

      // Schemas resolve per round, not once up front: a tool registered mid-loop (tool_search
      // pulling a catalog entry in) must be visible to the very next callModel, and
      // `resolveSchemas` must always see the registry's CURRENT full set.
      const rawSchemas = registry.toSchemas();
      const schemas = typeof resolveSchemas === "function" ? resolveSchemas(rawSchemas) : rawSchemas;
      if (!Array.isArray(schemas)) throw new Error("[agent-kernel] resolveSchemas 必须返回数组");

      let rejected: string | null = null;
      for (const hook of beforeSteps) {
        let d: StepVerdict | void = null;
        try {
          d = await hook({ iteration: i, messages, registry });
        } catch (e) {
          d = { reject: `beforeStep 钩子异常: ${e && e.message ? e.message : e}` };
        }
        if (!d) continue;
        if (d.reject) { rejected = String(d.reject); break; }
        if (Array.isArray(d.append)) for (const m of d.append) if (m && m.role) messages.push(m);
      }
      if (rejected) {
        onEvent({ type: "blocked", iteration: i, reason: rejected });
        pairPendingToolCalls(messages, "回合在请求前被否决，本轮调用未发生");
        const finalText = `（回合被否决：${rejected}）`;
        messages.push({ role: "assistant", content: finalText });
        return { finalText, messages, iterations: i, stopReason: "blocked" };
      }

      onEvent({ type: "model_call", iteration: i });
      let res: ModelReply;
      try {
        res = (await callModel(messages, schemas)) || {};
      } catch (e) {
        // Cancellation is not a model failure: the host's half-reply fallback owns that case.
        if (isAborted() || (e && e.name === "AbortError")) throw abortNow("model_call", i);
        // Real upstream failure still closes the turn gracefully — the UI needs the reason, not a hang.
        const errMsg = String(e && e.message ? e.message : e);
        onEvent({ type: "model_error", iteration: i, error: errMsg });
        pairPendingToolCalls(messages, `模型调用失败（${errMsg}），本轮已发出的工具调用结果未知`);
        const finalText = `（第 ${i + 1} 轮模型调用失败，已中止：${errMsg}）`;
        messages.push({ role: "assistant", content: finalText });
        return { finalText, messages, iterations: i + 1, stopReason: "model_error" };
      }
      const toolCalls = res.tool_calls || [];

      if (toolCalls.length === 0) {
        const finalText = res.content || "";
        messages.push({ role: "assistant", content: finalText });
        onEvent({ type: "final", iteration: i, text: finalText });
        pairPendingToolCalls(messages, "循环正常收尾前的配对检查");
        return { finalText, messages, iterations: i + 1, stopReason: "stop" };
      }

      // The assistant turn carrying tool_calls must echo reasoning_content: DeepSeek 400s the next
      // request when a reasoning model's tool turn loses it. Content stays as returned; request
      // assembly is what blanks it before sending. Same protocol family: every echoed call carries
      // the OpenAI `type` discriminant, or the next request 422s on calls that omit it.
      const asstMsg: LoopMessage = { role: "assistant", content: res.content || "", tool_calls: normalizeToolCallTypes(toolCalls) };
      if (res.reasoning_content) asstMsg.reasoning_content = res.reasoning_content;
      messages.push(asstMsg);

      for (const call of toolCalls) {
        const fn = call.function || {};
        const name = fn.name;
        let args: Record<string, unknown> = {};
        try {
          const parsed: unknown = fn.arguments ? JSON.parse(fn.arguments) : {};
          args = isRecord(parsed) ? parsed : {};
        } catch (e) {
          const err = `参数 JSON 解析失败: ${e.message}`;
          pushToolResult(messages, call, { error: err }, { name, args: null, ok: false, error: err });
          onEvent({ type: "tool_error", name, error: "bad_json", message: err });
          continue;
        }

        const tool = registry.get(name);
        if (!tool) {
          const err = `未知工具: ${name}`;
          pushToolResult(messages, call, { error: err }, { name, args, ok: false, error: err });
          onEvent({ type: "tool_error", name, error: "unknown_tool", message: err });
          continue;
        }

        const needPerm = typeof tool.destructive === "function" ? !!tool.destructive(args) : !!tool.destructive;
        if (needPerm && typeof ensurePermission !== "function") {
          const err = "权限闸门不可用（宿主未提供确认机制），破坏性操作已拒绝";
          pushToolResult(messages, call, { error: err }, { name, args, ok: false, error: err, denied: true, denied_reason: "gate_unavailable" });
          onEvent({ type: "tool_denied", name, args, reason: "gate_unavailable" });
          continue;
        }
        if (needPerm) {
          let ok = false;
          try {
            ok = await raceWithAbort(ensurePermission(name, args), () => abortNow("permission", i));
          } catch (e) {
            if (e && e.name === "AbortError") throw e;
            const err = `权限检查失败（闸门异常）：${e && e.message ? e.message : e}`;
            pushToolResult(messages, call, { error: err }, { name, args, ok: false, error: err, denied: true, denied_reason: "gate_error" });
            onEvent({ type: "tool_denied", name, args, reason: "gate_error" });
            continue;
          }
          if (!ok) {
            const err = "用户拒绝了该操作";
            pushToolResult(messages, call, { error: err }, { name, args, ok: false, error: err, denied: true, denied_reason: "user_denied" });
            onEvent({ type: "tool_denied", name, args, reason: "user_denied" });
            continue;
          }
        }

        const t0 = Date.now();
        try {
          if (isAborted()) throw abortNow("between_tools", i);
          onEvent({ type: "tool_run", name, args });
          const result = await raceWithAbort(Promise.resolve().then(() => tool.run(args, context)), () => abortNow("tool", i));
          const ms = Date.now() - t0;
          pushToolResult(messages, call, result, { name, args, ok: true, ms });
          onEvent({ type: "tool_done", name, args, ok: true, ms, summary: summarizeToolResult(result) });
        } catch (e) {
          if (isAborted() || (e && e.name === "AbortError")) throw e;
          // Errors are fed back too: reading its own failure is how the model reroutes next round.
          const err = String(e && e.message ? e.message : e);
          const ms = Date.now() - t0;
          pushToolResult(messages, call, { error: err }, { name, args, ok: false, ms, error: err });
          onEvent({ type: "tool_error", name, args, error: "throw", message: err, ms });
        }
      }
    }

    // Ceiling reached. The final text is visible and pushed like any other close, so the bubble is
    // never blank and the protocol stays paired.
    onEvent({ type: "max_iterations" });
    pairPendingToolCalls(messages, `已达最大轮数（${maxIterations}），本条工具调用未及执行，结果未知`);
    const finalText = `（已达到最大工具调用轮数 ${maxIterations} 轮，已自动停止。如果任务尚未完成，可缩小范围或分步重试。）`;
    messages.push({ role: "assistant", content: finalText });
    return { finalText, messages, iterations: maxIterations, stopReason: "max_iterations" };
  } finally {
    activeLoops--;
  }
};

/** Fed-back tool result ceiling. A whole web page or search dump would otherwise blow the context. */
const MAX_TOOL_RESULT_CHARS = 8000;

/**
 * Push one tool result in OpenAI shape. Over-long results keep both ends: the decisive line (final
 * state, error summary, exit code) usually sits at the tail, so head-only truncation loses it.
 */
function pushToolResult(messages: LoopMessage[], call: ToolCall, result: unknown, meta?: ToolResultMeta): void {
  let content = typeof result === "string" ? result : JSON.stringify(result);
  if (content && content.length > MAX_TOOL_RESULT_CHARS) {
    const total = content.length;
    const omitted = total - MAX_TOOL_RESULT_CHARS;
    const head = content.slice(0, 6000);
    const tail = total > 6000 ? content.slice(-1500) : "";
    content =
      head +
      `\n…[中间省略 ${omitted} 字，原文共 ${total} 字。如需完整内容请缩小范围或分页/分段获取]…\n` +
      tail;
  }
  const msg: LoopMessage = { role: "tool", tool_call_id: call.id, content };
  if (meta) msg._tool = meta;
  messages.push(msg);
}

/** Short preview for the UI card. Never fed back into the request, so it cannot grow the context. */
function summarizeToolResult(result: unknown): string {
  try {
    if (result == null) return "";
    if (typeof result === "string") return result.slice(0, 400);
    const j = JSON.stringify(result);
    return j && j.length > 400 ? j.slice(0, 400) + "…" : j || "";
  } catch (e) { return ""; }
}

/**
 * Repair the message log: give every pending `tool_call` a synthetic result so call and result stay
 * paired. A clean loop makes this a no-op — it exists for early exits (abort, model error, ceiling)
 * and is reused by request assembly and worker-side inbound sanitising, which is also why synthetic
 * results are spliced right after their assistant turn instead of appended: a dangling call in the
 * middle of a stored history is illegal order, not just untidy.
 *
 * Because request assembly runs this immediately before sending, it is also where echoed calls get
 * their `type` discriminant repaired in place (`normalizeToolCallTypes`): stored calls from older
 * turns may predate it, and a call without `type` 422s the next request. The repair is idempotent —
 * a call that already carries a valid `type` is byte-identical after it.
 * @returns how many results were synthesised
 */
export function pairPendingToolCalls(messages: LoopMessage[], note?: string): number {
  const answered = new Set<string>();
  for (const m of messages) {
    if (m && m.role === "tool" && m.tool_call_id) answered.add(m.tool_call_id);
  }
  let n = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "assistant" || !Array.isArray(m.tool_calls)) continue;
    m.tool_calls = normalizeToolCallTypes(m.tool_calls);
    const missing = m.tool_calls.filter((c) => c && c.id && !answered.has(c.id));
    if (!missing.length) continue;
    const synth: LoopMessage[] = missing.map((c) => ({
      role: "tool",
      tool_call_id: c.id,
      content: JSON.stringify({ error: note || "工具调用未完成（循环提前退出），结果未知" }),
    }));
    messages.splice(i + 1, 0, ...synth);
    for (const s of synth) answered.add(s.tool_call_id);
    n += synth.length;
  }
  return n;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
