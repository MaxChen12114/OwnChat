/**
 * Agent console decisions: turn kernel events into a small plan the DOM wiring can apply.
 *
 * The console is a renderer, but the interesting parts are not DOM: which status a kernel event
 * means, whether the clock starts/stops, how a tool step is shaped, how the write_file card picks
 * its title, how the compat `ensurePermission(a, b)` signature is normalized, and how meeting /
 * peer / sub-agent lines read. Those live here so they can be asserted without a document; the
 * wiring keeps the elements, styles, timers and permission promises.
 *
 * @module services/ui/agent-console
 */

/** JSON preview for a tool argument body; long payloads are cut with an explicit marker. */
export function pretty(value: unknown): string {
  try {
    const s = JSON.stringify(value, null, 2);
    return s.length > 2000 ? s.slice(0, 2000) + "\n…(已截断)" : s;
  } catch (e) {
    return String(value);
  }
}

/** Duration label: milliseconds below one second, otherwise one decimal below ten seconds. */
export function fmtMs(ms: number): string {
  return ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + "s";
}

/** `ensurePermission` accepts the kernel's `(name, args)` and the older `({ name, args })` shape. */
export function normalizePermissionArgs(a: unknown, b: unknown): { name: unknown; args: unknown } {
  if (a && typeof a === "object" && !Array.isArray(a)) {
    const rec = recOf(a);
    return { name: rec["name"], args: rec["args"] };
  }
  return { name: a, args: b };
}

/** Write-file card: title falls back through the four names callers use; body is only a string. */
export function writeFileInfo(args: unknown): { path: string; content: string } {
  const rec = recOf(args);
  const path = rec["path"] || rec["filename"] || rec["file_path"] || rec["name"] || "文件";
  const content = typeof rec["content"] === "string" ? rec["content"] : "";
  return { path: String(path), content: content };
}

/** Round heading shown in the timeline. */
export function roundLabel(n: number): string {
  return "· 第 " + n + " 轮 ·";
}

export type StatusKind = "idle" | "thinking" | "tool" | "done" | "warn" | "error" | "perm";

export interface ConsoleEventPlan {
  /** Start the elapsed clock before applying the rest. */
  startClock: boolean;
  /** Stop the elapsed clock after applying the rest. */
  stopClock: boolean;
  /** Header dot + label. */
  status?: { kind: StatusKind; label: string };
  /** Round number to record and render. */
  round?: number;
  tool?: {
    phase: "run" | "done" | "error" | "denied";
    name: string;
    args?: unknown;
    message?: string;
  };
  /** One timeline line for a sub-agent / meeting / peer event. */
  subagent?: { label: string; starting: boolean };
}

function recOf(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value);
    for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  }
  return out;
}

function text(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

/**
 * Translate one kernel event into the console plan. Unknown events produce null (the console was
 * always tolerant of future event types). The labels are user-facing Chinese and are kept verbatim.
 *
 * @param ev - Kernel event with at least a `type`.
 * @returns The plan, or null when the event is not rendered.
 */
export function eventPlan(ev: unknown): ConsoleEventPlan | null {
  const e = recOf(ev);
  const type = e["type"];
  if (!type) return null;
  const plan: ConsoleEventPlan = { startClock: true, stopClock: false };
  switch (type) {
    case "model_call": {
      const round = (Number(e["iteration"]) || 0) + 1;
      plan.round = round;
      plan.status = { kind: "thinking", label: (e["agent"] ? "[" + String(e["agent"]) + "] " : "") + "思考中 · 第 " + round + " 轮" };
      return plan;
    }
    case "tool_run":
      plan.status = { kind: "tool", label: "调用 " + text(e["name"]) };
      plan.tool = { phase: "run", name: text(e["name"]), args: e["args"] };
      return plan;
    case "tool_done":
      plan.status = { kind: "thinking", label: "已完成 " + text(e["name"]) + "，继续…" };
      plan.tool = { phase: "done", name: text(e["name"]) };
      return plan;
    case "tool_error":
      plan.status = { kind: "error", label: "工具出错 " + text(e["name"]) };
      plan.tool = { phase: "error", name: text(e["name"]), message: text(e["message"]) || text(e["error"]) || "调用失败" };
      return plan;
    case "tool_denied":
      plan.status = { kind: "warn", label: "已拒绝 " + text(e["name"]) };
      plan.tool = { phase: "denied", name: text(e["name"]) };
      return plan;
    case "subagent_start": {
      const role = text(e["role"]);
      const task = e["task"] ? text(e["task"]) : "";
      plan.subagent = { label: `子 agent 启动 · ${role}${task ? " · " + task : ""}`, starting: true };
      return plan;
    }
    case "subagent_done": {
      const role = text(e["role"]);
      plan.subagent = { label: `子 agent 完成 · ${role}`, starting: false };
      return plan;
    }
    case "meeting_start":
      plan.status = { kind: "thinking", label: "私下小会 · " + text(e["topic"]).slice(0, 28) };
      plan.subagent = {
        label: "小会 · " + (Array.isArray(e["participants"]) ? e["participants"].map((p) => text(p)).join("、") : "—") + " · 共 " + text(e["rounds"] || 1) + " 轮",
        starting: true,
      };
      return plan;
    case "meeting_speaker": {
      const who = text(e["who"]);
      if (e["phase"] === "start") {
        plan.subagent = { label: "小会 · " + who + " 思考中…", starting: true };
      } else if (e["phase"] === "done") {
        plan.subagent = { label: "小会 · " + who + " · 第 " + text(e["round"] || 1) + " 轮已答 · " + text(e["summary"]).slice(0, 60), starting: false };
      } else {
        plan.subagent = { label: "小会 · " + who + " 出错：" + text(e["error"]).slice(0, 60), starting: false };
      }
      return plan;
    }
    case "meeting_done":
      plan.status = { kind: "thinking", label: "小会结束，汇总中…" };
      return plan;
    case "peer_invite":
      plan.subagent = {
        label: "上台 · " + text(e["who"]) + (e["phase"] === "done" ? " 已上台" : " 上台回答中…") + (e["phase"] === "done" && e["text"] ? " · " + text(e["text"]).slice(0, 60) : ""),
        starting: e["phase"] !== "done",
      };
      return plan;
    case "model_error":
      plan.status = { kind: "error", label: "模型调用出错" + (e["error"] ? " · " + text(e["error"]).slice(0, 80) : "") };
      plan.stopClock = true;
      return plan;
    case "final":
      plan.status = { kind: "done", label: "已完成" };
      plan.stopClock = true;
      return plan;
    case "max_iterations":
      plan.status = { kind: "warn", label: "已达最大轮数" };
      plan.stopClock = true;
      return plan;
    case "aborted":
      plan.status = { kind: "warn", label: "已中止" };
      plan.stopClock = true;
      return plan;
    case "blocked":
      plan.status = { kind: "warn", label: "已拦截（权限未放行）" };
      plan.stopClock = true;
      return plan;
    default:
      // Unknown event types still start the elapsed clock, exactly like the old switch default.
      return plan;
  }
}
