/**
 * Tool send mode card row: the settings switch for `cfw_tool_mode_v1` (B2 C-4). Lives as a row
 * inside the existing Agent card (mountAgentToolsCard) rather than a card of its own — it governs
 * how the SAME tool set is sent, not a new capability.
 *
 * The rule here is the honest-display rule: the stored value is what the user chose, but the row
 * always shows the EFFECTIVE mode. The runtime (services/policy/tool-mode.ts) degrades `directory`
 * to `full` when its dependency set is missing, so a row that kept showing "目录" after the policy
 * products failed to load would lie about what is being sent. `directory` is also unselectable
 * until the runtime is present — the switch the design doc asks for ("directory 仅在 tool_search
 * 就位时可选").
 *
 * Only the mode gate, the option table and the row model live here; the DOM and localStorage stay
 * in the wiring, which reads and writes through the ports. The same key is read independently by
 * the request path (app.js getToolsConfig → toolModeRaw) — the source-anchor lock keeps both sides
 * on one key.
 * @module services/ui/tool-mode-card
 */

/** Storage key shared with the request path (app.js getToolsConfig) and the policy runtime. */
export const LS_TOOL_MODE = "cfw_tool_mode_v1";

/** The two modes v1 exposes. `adaptive` is compiled but stays behind the switch (B2 design §6). */
export type ToolSendMode = "full" | "directory";

/** Storage port; the wiring wraps localStorage so quota errors stay outside this module. */
export interface ToolModeCardPorts {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** One select option as the wiring renders it. */
export interface ToolModeOption {
  readonly value: ToolSendMode;
  readonly label: string;
  readonly disabled: boolean;
  readonly selected: boolean;
}

/** The row model: selected value (effective), the note line, and the option list in order. */
export interface ToolModeRowModel {
  readonly value: ToolSendMode;
  readonly note: string;
  readonly options: readonly ToolModeOption[];
}

/**
 * The read side. Only the exact string "directory" means directory — blank, garbage and wrong
 * types all read as full, which is the runtime's own gate (readToolMode in tool-mode.ts) and the
 * default IS the old behaviour, so the flag doubles as the rollback.
 */
export function parseToolMode(raw: string | null): ToolSendMode {
  return raw === "directory" ? "directory" : "full";
}

/**
 * Build the row model. `toolModePresent` means the policy runtime answered (window.__toolMode
 * with v === 1, checked by the wiring at render time).
 * @param ports - storage access for the stored choice.
 * @param toolModePresent - whether the tool_search runtime is live this boot.
 */
export function buildToolModeRow(ports: ToolModeCardPorts, toolModePresent: boolean): ToolModeRowModel {
  const stored = parseToolMode(ports.getItem(LS_TOOL_MODE));
  const value: ToolSendMode = toolModePresent ? stored : "full";
  const note = stored === "directory" && !toolModePresent
    ? "目录模式需要工具目录运行时就位（本次启动未加载，刷新页面后再试）；当前仍按全量发送。"
    : value === "directory"
      ? "只发常驻工具和 tool_search；模型需要某个工具的完整定义时自己调 tool_search 取。省 token，但模型要多走一步。"
      : "每轮把全部工具定义发给模型。最稳，模型直接看到每个工具的参数。";
  return {
    value: value,
    note: note,
    options: [
      { value: "full", label: "全量（每轮发全部工具定义）", disabled: false, selected: value === "full" },
      { value: "directory", label: "目录（只发常驻 + tool_search 按需取）", disabled: !toolModePresent, selected: value === "directory" },
    ],
  };
}

/** Public surface; the wiring assigns it to a non-`__` global (no frozen-contract growth). */
export interface ToolModeCardApi {
  read(): ToolSendMode;
  /** Store a mode. Only the two exact values are accepted; anything else is a no-op (the row's
   * select never offers anything else, and a garbage write must not fabricate state). */
  write(value: string): ToolSendMode;
  /** Read the stored choice and build the row model for the wiring. */
  row(toolModePresent: boolean): ToolModeRowModel;
}

/**
 * Create the API. A failed storage write is swallowed by the wiring, so this layer may assume the
 * port reports success.
 * @param ports - storage access from the wiring.
 */
export function createToolModeCard(ports: ToolModeCardPorts): ToolModeCardApi {
  function read(): ToolSendMode {
    return parseToolMode(ports.getItem(LS_TOOL_MODE));
  }
  function write(value: string): ToolSendMode {
    if (value === "full" || value === "directory") ports.setItem(LS_TOOL_MODE, value);
    return read();
  }
  function row(toolModePresent: boolean): ToolModeRowModel {
    return buildToolModeRow(ports, toolModePresent);
  }
  return { read: read, write: write, row: row };
}
