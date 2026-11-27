/**
 * The agent workflow panel's rules, minus the DOM: how a tool call is briefed, which state a step and
 * the whole panel end in, the one-line summary text, and how a background turn's recorded rounds are
 * replayed onto a live handle.
 *
 * The replay contract is the reason this module exists at all: when the user switches away mid-run,
 * the row (and the live panel) is destroyed, but the turn keeps recording rounds. Switching back
 * replays those rounds through the same handle methods a live run would call — one rendering path,
 * no duplicates. `ok === true/false/undefined` means done / failed / still running; a replay must
 * leave an in-flight card in the running state, because that is exactly what the user should see.
 *
 * The summary never says "已完成 · 0 步": a panel without tool calls was pure thinking, and calling
 * that a workflow is a lie. Aborts are also an ending — the old version kept spinning "运行中" after
 * the user pressed stop, while the truth was "interrupted, result unknown".
 * @module services/agent/steps
 */

function recOf(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

/** Argument keys worth showing in the brief line, in priority order. */
export const STEP_BRIEF_KEYS = ["path", "file", "file_path", "filename", "url", "command", "cmd", "query", "q", "keyword", "name", "pattern", "id", "topic", "text", "content"];

/** One-line argument brief: the first known key wins, else the remaining pairs, truncated. */
export function briefArgs(name: unknown, args: unknown): string {
  void name;
  if (!args || typeof args !== "object") return "";
  const a = recOf(args);
  for (let i = 0; i < STEP_BRIEF_KEYS.length; i++) {
    const v = a[STEP_BRIEF_KEYS[i]];
    if (typeof v === "string" && v) return v.length > 90 ? v.slice(0, 90) + "…" : v;
  }
  const rest = Object.keys(a)
    .filter((k) => STEP_BRIEF_KEYS.indexOf(k) < 0 && a[k] != null && a[k] !== "")
    .map((k) => k + "=" + String(a[k]).slice(0, 40));
  return rest.length ? rest.join(" ") : "";
}

export type StepState = "run" | "done" | "err";

/** Semantic tool family used by the document-mode process rows. */
export type ToolCategory = "read" | "commands" | "edit" | "web" | "subagents" | "tools";

/**
 * Classify a tool name into the row family shown by the document transcript. The match is
 * deliberately prefix/substring based: tool names differ by host (local_read_file, read_source,
 * bash, exec_command, ...), but the reader only needs the family.
 */
export function stepCategory(name: unknown): ToolCategory {
  const n = String(name == null ? "" : name).toLowerCase();
  if (/subagent|agent_team|delegate/.test(n)) return "subagents";
  if (/web|fetch|http|browse_url|url_read/.test(n)) return "web";
  if (/bash|shell|exec|terminal|command|run|pwsh|cmd|process/.test(n)) return "commands";
  if (/edit|write|patch|create|update|delete|rename|move|mkdir|mkdirs/.test(n)) return "edit";
  if (/read|grep|glob|search|list|browse|inspect|view|cat|head|tail|stat/.test(n)) return "read";
  return "tools";
}

/**
 * The document transcript's collapsed process summary: category counts, e.g. "已查阅 1 项，已执行
 * 3 命令". Bubble mode keeps the existing "已完成 · N 步" capsule.
 */
export function panelDocTitle(steps: unknown, enLabels: boolean): string {
  const list = Array.isArray(steps) ? steps : [];
  const counts: Record<ToolCategory, number> = { read: 0, commands: 0, edit: 0, web: 0, subagents: 0, tools: 0 };
  list.forEach((el) => {
    counts[stepCategory(recOf(el).name)]++;
  });
  const labels = enLabels
    ? {
        read: (n: number) => `Read ${n} item${n === 1 ? "" : "s"}`,
        commands: (n: number) => `Ran ${n} command${n === 1 ? "" : "s"}`,
        edit: (n: number) => `Edited ${n} file${n === 1 ? "" : "s"}`,
        web: (n: number) => `Browsed ${n} page${n === 1 ? "" : "s"}`,
        subagents: (n: number) => `Used ${n} subagent${n === 1 ? "" : "s"}`,
        tools: (n: number) => `Called ${n} tool${n === 1 ? "" : "s"}`,
      }
    : {
        read: (n: number) => `已查阅 ${n} 项`,
        commands: (n: number) => `已执行 ${n} 命令`,
        edit: (n: number) => `已修改 ${n} 文件`,
        web: (n: number) => `已联网 ${n} 次`,
        subagents: (n: number) => `已调用 ${n} 个子智能体`,
        tools: (n: number) => `已调用 ${n} 个工具`,
      };
  const order: ToolCategory[] = ["read", "commands", "edit", "web", "subagents", "tools"];
  const parts: string[] = [];
  for (const kind of order) if (counts[kind] > 0) parts.push(labels[kind](counts[kind]));
  if (parts.length === 0) return enLabels ? "Thinking process" : "思考过程";
  return parts.slice(0, 3).join(enLabels ? ", " : "，");
}

/** First line of a reasoning block, or the latest paragraph's first line while streaming. */
export function reasoningSummary(text: unknown, running: boolean): string {
  const value = String(text == null ? "" : text).replaceAll("**", "");
  if (!running) {
    const newline = value.indexOf("\n");
    return (newline === -1 ? value : value.slice(0, newline)).trim();
  }
  const paragraphs = value.split(/\r?\n(?:[\t ]*\r?\n)+/);
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const line = paragraphs[i].trim();
    if (!line) continue;
    const newline = line.indexOf("\n");
    return (newline === -1 ? line : line.slice(0, newline)).trim();
  }
  return "";
}

/** denied or ok===false is a failure; ok===true done; anything else still running. */
export function stepState(info: unknown): StepState {
  const i = recOf(info);
  return i.denied || i.ok === false ? "err" : i.ok === true ? "done" : "run";
}

export interface PanelDone {
  state: "aborted" | "err" | "done";
  /** The header line: 已中断 / 已结束 / 已完成 / 思考过程, with the step count when there are steps. */
  title: string;
  /** Document-mode header: category counts, e.g. "已查阅 1 项，已执行 3 命令". */
  docTitle: string;
  /** Tool names, deduplicated, capped at four; the suffix is " 等" or " +" by UI language. */
  names: string;
  errored: boolean;
}

/** Decide the collapsed summary of a finished panel from its step elements' name/state pairs. */
export function panelDone(steps: unknown, ms: number | null, reason: unknown, enLabels: boolean): PanelDone {
  const list = Array.isArray(steps) ? steps : [];
  const names: string[] = [];
  let err = 0;
  list.forEach((el) => {
    const s = recOf(el);
    const n = String(s.name || "");
    if (names.indexOf(n) < 0) names.push(n);
    if (s.state === "err") err++;
  });
  const hasSteps = list.length > 0;
  // An abort is also an ending; conflating it with "done" hid the fact that the result is unknown.
  const aborted = reason === "aborted";
  const suffix = enLabels ? " +" : " 等";
  return {
    state: aborted ? "aborted" : err ? "err" : "done",
    title: aborted
      ? "已中断" + (hasSteps ? " · " + list.length + " 步" : "")
      : hasSteps
        ? (err ? "已结束" : "已完成") + " · " + list.length + " 步"
        : "思考过程",
    docTitle: panelDocTitle(list, enLabels),
    names: names.slice(0, 4).join(", ") + (names.length > 4 ? suffix : ""),
    errored: err > 0,
  };
}

/** Milliseconds as the header shows them: >=1s gets one decimal + "s", else raw + "ms". */
export function panelMs(ms: number | null): string | null {
  if (ms == null) return null;
  return ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : ms + "ms";
}

/** The recorded round shape (documentation of the wire format; access goes through recOf). */
export interface RoundRecord {
  thinking?: string;
  preamble?: string;
  calls?: StepRecord[];
  events?: { type?: string }[];
}

export interface StepRecord {
  name?: string;
  args?: unknown;
  ok?: boolean;
  ms?: number;
  error?: string;
  denied?: boolean;
  summary?: string;
}

export interface RoundRecord {
  thinking?: string;
  preamble?: string;
  calls?: StepRecord[];
  events?: { type?: string }[];
}

export interface ReplayHandle {
  model_call?: () => void;
  roundThinking?: (text: string) => void;
  preamble?: (text: string) => void;
  tool_run?: (name: string, args: unknown) => void;
  tool_done?: (name: string, info: unknown) => void;
  tool_error?: (name: string, info: unknown) => void;
  tool_denied?: (name: string, args: unknown) => void;
  [ev: string]: unknown;
}

/** The meeting/turn-card prefix both live and replay use. */
export function meetingLabel(ev: unknown): string {
  const e = recOf(ev);
  const participants = Array.isArray(e.participants) ? e.participants.join("、") : "";
  return "私下小会 · " + String(e.topic || "").slice(0, 80) + "（" + (participants || "—") + " · 共 " + (Number(e.rounds) || 1) + " 轮）";
}

export function peerStepKey(kind: string, who: unknown, round: unknown): string {
  const r = Number(round) || 1;
  return kind === "meeting" ? "小会 · " + String(who || "") + "（第 " + r + " 轮）" : "上台 · " + String(who || "");
}

function strField(v: unknown, k: string): string {
  const x = recOf(v)[k];
  return typeof x === "string" ? x : "";
}

function arrField(v: unknown, k: string): unknown[] {
  const x = recOf(v)[k];
  return Array.isArray(x) ? x : [];
}

/**
 * Replay recorded rounds onto a live handle. Returns the number of tool cards replayed (0 means
 * "nothing worth drawing"). Unknown event types are skipped, not fatal.
 */
export function replayTurn(handle: ReplayHandle | null, rounds: unknown): number {
  if (!handle || !Array.isArray(rounds)) return 0;
  let played = 0;
  rounds.forEach((r) => {
    if (!r) return;
    if (typeof handle.model_call === "function") handle.model_call();
    const thinking = strField(r, "thinking");
    if (thinking && typeof handle.roundThinking === "function") handle.roundThinking(thinking);
    const preamble = strField(r, "preamble");
    if (preamble && typeof handle.preamble === "function") handle.preamble(preamble);
    arrField(r, "calls").forEach((raw) => {
      const c = recOf(raw);
      const name = typeof c.name === "string" ? c.name : "";
      if (!name) return;
      if (typeof handle.tool_run === "function") handle.tool_run(name, c.args || {});
      played++;
      if (c.denied) {
        if (typeof handle.tool_denied === "function") handle.tool_denied(name, c.args || {});
      } else if (c.ok === false) {
        if (typeof handle.tool_error === "function") handle.tool_error(name, { error: typeof c.error === "string" ? c.error : "调用失败", ms: c.ms });
      } else if (c.ok === true) {
        if (typeof handle.tool_done === "function") handle.tool_done(name, { ok: true, ms: c.ms, summary: c.summary });
      }
      // ok neither true nor false: the card was still running -- replay keeps it running.
    });
    arrField(r, "events").forEach((ev) => {
      try {
        const type = strField(ev, "type");
        const fn = handle[type];
        if (typeof fn === "function") fn(ev);
      } catch (e) {}
    });
  });
  return played;
}
