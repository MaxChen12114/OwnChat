/**
 * Thinking policy: what the toggle offers and what the request carries, minus the DOM.
 *
 * The level table belongs to `services/model-router/model-think.ts`; this module only compiles it
 * into a UI capability (available / off-allowed / must-on plus the label list) and into the request
 * fields. The table arrives as a validated {@link ThinkTable} because the wiring reads the emitted
 * `__modelThink` global, which may be absent in sandboxed hosts — a missing table degrades per
 * dialect instead of throwing.
 *
 * Dialect styles pass through unchanged. Defaulting an unknown style to `deepseek` puts
 * `thinking:{type}` on endpoints that reject it with a 400, so {@link thinkStyleFromMeta} spells out
 * the `none` / `effort` cases instead of relying on a catch-all.
 * @module services/ui/think-control
 */

export interface ThinkLevelRow {
  v: string;
  label: string;
}

/** The level table after validation. `labelOf` / `levelsFor` are null when the table script is absent. */
export interface ThinkTable {
  levels: ThinkLevelRow[];
  values: string[];
  labelOf: ((v: string) => string) | null;
  levelsFor: ((model: string, style: string, allowed: string[] | null) => string[]) | null;
}

/** A model's thinking capability as the UI sees it. `levels` is empty for plain on/off models. */
export interface ThinkCap {
  available: boolean;
  style: string;
  levels: ThinkLevelRow[];
  offAllowed: boolean;
  mustOn: boolean;
  model: string;
}

/** Wire fields. `reasoning_effort` appears only when the model exposes strengths. */
export interface ThinkPayload {
  thinking: string;
  reasoning_effort?: string;
}

/** Everything the toggle button renders, so the wiring only assigns. */
export interface ThinkToggleView {
  text: string;
  pressed: boolean;
  disabled: boolean;
  opacity: string;
  title: string;
}

/** One popup row. `__off__` / `__on__` are sentinels: "on, no strength" is not a level. */
export interface ThinkMenuOption {
  v: string;
  label: string;
  active: boolean;
}

export interface ThinkMenuRect {
  top: number;
  bottom: number;
  left: number;
}

export const THINK_LEVEL_KEY = "cfw_think_level_v1";
export const THINK_DEFAULT_LEVEL = "medium";

const THINK_LEVELS_FALLBACK: ThinkLevelRow[] = [
  { v: "minimal", label: "极低" },
  { v: "low", label: "低" },
  { v: "medium", label: "中" },
  { v: "high", label: "高" },
  { v: "xhigh", label: "更高" },
  { v: "max", label: "最高" },
];

/** Shallow field copy of an unknown JSON object; `null` becomes `{}` so callers stay total. */
function tkRec(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (v === null || typeof v !== "object") return out;
  for (const [k, val] of Object.entries(v)) out[k] = val;
  return out;
}

function tkStrings(v: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(v)) return out;
  for (const item of v) if (typeof item === "string") out.push(item);
  return out;
}

/**
 * Validate the emitted table global. Any missing or malformed field falls back, so a half-loaded
 * script yields the generic six-level ladder rather than an empty picker.
 * @param raw value of `__modelThink` (may be undefined)
 */
export function thinkTableFrom(raw: unknown): ThinkTable {
  const rec = tkRec(raw);
  const levels: ThinkLevelRow[] = [];
  if (Array.isArray(rec.levels)) {
    for (const item of rec.levels) {
      const row = tkRec(item);
      const v = typeof row.v === "string" ? row.v : "";
      if (!v) continue;
      levels.push({ v, label: typeof row.label === "string" && row.label ? row.label : v });
    }
  }
  const declared = tkStrings(rec.values);
  const values = declared.length ? declared : (levels.length ? levels : THINK_LEVELS_FALLBACK).map((row) => row.v);
  const labelFn = typeof rec.label === "function" ? rec.label : null;
  const levelsFn = typeof rec.levelsFor === "function" ? rec.levelsFor : null;
  return {
    levels: levels.length ? levels : THINK_LEVELS_FALLBACK,
    values,
    labelOf: labelFn
      ? (v: string): string => {
          const got = labelFn(v);
          return typeof got === "string" ? got : v;
        }
      : null,
    levelsFor: levelsFn
      ? (model: string, style: string, allowed: string[] | null): string[] => tkStrings(levelsFn(model, style, allowed))
      : null,
  };
}

/** Levels the model supports, per the table when present. Values only — UI meaning is derived later. */
export function thinkLevelsFor(table: ThinkTable, model: string, style: string, allowed: string[] | null): string[] {
  if (table.levelsFor) return table.levelsFor(model, style, allowed);
  return style === "vllm" ? ["disabled", "enabled"] : ["disabled", "low", "medium", "high", "max"];
}

export function thinkLevelLabel(table: ThinkTable, v: string): string {
  if (table.labelOf) return table.labelOf(v);
  for (const row of table.levels) if (row.v === v) return row.label;
  return "中";
}

/**
 * Compile the table into the three UI states: unavailable, on/off only, on/off plus strengths.
 * A model whose only "on" value is `enabled` gets an empty `levels` list and `mustOn` when the
 * channel offers no off switch.
 */
export function buildThinkCap(
  table: ThinkTable,
  supports: boolean,
  style: string,
  model: string,
  allowed: string[] | null,
): ThinkCap {
  const named = model || "";
  if (!supports || style === "none") {
    return { available: false, style: "none", levels: [], offAllowed: false, mustOn: false, model: named };
  }
  const values = thinkLevelsFor(table, named, style, allowed);
  const offAllowed = values.indexOf("disabled") >= 0 || values.indexOf("none") >= 0;
  const ons = values.filter((v) => v !== "disabled" && v !== "none");
  if (!ons.length) {
    return { available: false, style: "none", levels: [], offAllowed: false, mustOn: false, model: named };
  }
  if (ons.length === 1 && ons[0] === "enabled") {
    return { available: true, style, levels: [], offAllowed, mustOn: !offAllowed, model: named };
  }
  const levels: ThinkLevelRow[] = ons.map((v) => ({ v, label: thinkLevelLabel(table, v) }));
  return { available: true, style, levels, offAllowed, mustOn: !offAllowed, model: named };
}

/**
 * Stored level if this model accepts it, otherwise its highest strength. Falling back to the top
 * level (not the middle) matches the reference client: a silently weakened level is harder to
 * notice than an over-eager one.
 */
export function resolveThinkLevel(stored: string, cap: ThinkCap): string {
  if (!cap || !cap.levels || !cap.levels.length) return "";
  if (cap.levels.some((row) => row.v === stored)) return stored;
  return cap.levels[cap.levels.length - 1].v;
}

/** Stored level filtered against the table's vocabulary; anything else reads as `medium`. */
export function thinkLevelOrDefault(stored: unknown, table: ThinkTable): string {
  const v = typeof stored === "string" ? stored : "";
  return table.values.indexOf(v) >= 0 ? v : THINK_DEFAULT_LEVEL;
}

/** Channel metadata to dialect style. `none` / `effort` must survive: those endpoints 400 on `thinking`. */
export function thinkStyleFromMeta(thinkingStyle: unknown, presetId: unknown): string {
  if (thinkingStyle === "none" || thinkingStyle === "effort") return thinkingStyle;
  if (thinkingStyle === "vllm" || presetId === "nvidia") return "vllm";
  return "deepseek";
}

/** Free-form style string from a provider record; only the three known dialects are honoured. */
export function thinkStyleOf(v: unknown): string {
  if (v === "vllm") return "vllm";
  if (v === "effort") return "effort";
  if (v === "none") return "none";
  return "deepseek";
}

/**
 * Wire fields for one request. A model that cannot switch thinking off forces `enabled` even when
 * the user toggled it off, so the request matches what the channel will do anyway.
 */
export function thinkRequestPayload(cap: ThinkCap, thinkingOn: boolean, stored: string): ThinkPayload {
  const on = cap.available && (cap.mustOn || thinkingOn);
  if (!on) return { thinking: "disabled" };
  const out: ThinkPayload = { thinking: "enabled" };
  if (cap.levels.length) out.reasoning_effort = resolveThinkLevel(stored, cap);
  return out;
}

/** Button label, aria state and tooltip. Every string here is user-visible and stays Chinese. */
export function thinkToggleView(table: ThinkTable, cap: ThinkCap, thinkingOn: boolean, stored: string): ThinkToggleView {
  const on = cap.available && (cap.mustOn || thinkingOn);
  const level = resolveThinkLevel(stored, cap);
  const text = !cap.available
    ? "思考不可用"
    : (on ? (cap.levels.length ? "思考:" + thinkLevelLabel(table, level) : "思考开") : "思考关");
  const tail = cap.mustOn
    ? (cap.levels.length ? "；该模型固定开启思考，点击可改强度" : "；该模型固定开启思考")
    : ("；点击可改开关" + (cap.levels.length ? "/强度" : ""));
  const title = !cap.available
    ? "所选模型不支持思考（可在 设置 → 模型 API 的渠道里改「思考形态」）"
    : (on
      ? "思考模式：开启" + (cap.levels.length ? "（强度：" + thinkLevelLabel(table, level) + "）" : "") + "。更准，但更慢、费用较高、输出含思考过程" + tail
      : "思考模式：关闭（快、便宜）。点击选择开关" + (cap.levels.length ? "与强度" : ""));
  return { text, pressed: on, disabled: !cap.available, opacity: cap.available ? "1" : ".45", title };
}

/**
 * Popup rows in render order: the off row (only when the channel allows it), then one row per
 * strength, or a single on row. `active` marks the current choice.
 */
export function thinkMenuOptions(table: ThinkTable, cap: ThinkCap, thinkingOn: boolean, stored: string): ThinkMenuOption[] {
  const rows: ThinkMenuOption[] = [];
  if (cap.offAllowed) rows.push({ v: "__off__", label: "关闭", active: false });
  if (cap.levels.length) {
    for (const level of cap.levels) rows.push({ v: level.v, label: "开启（" + level.label + "）", active: false });
  } else {
    rows.push({ v: "__on__", label: "开启", active: false });
  }
  const onNow = thinkingOn || cap.mustOn;
  const current = resolveThinkLevel(stored, cap);
  return rows.map((row) => {
    const active = (row.v === "__off__" && !onNow)
      || (row.v === "__on__" && onNow && !cap.levels.length)
      || (row.v !== "__off__" && row.v !== "__on__" && onNow && current === row.v);
    return { v: row.v, label: row.label, active };
  });
}

/**
 * Fixed-position menu placement above the toggle, flipped below when it would clip the top edge and
 * clamped 8px inside the viewport. Missing measurements fall back to the menu's own baseline size.
 */
export function thinkMenuPosition(
  anchor: ThinkMenuRect,
  size: { height: number; width: number },
  viewportWidth: number,
): { top: number; left: number } {
  const height = size.height || 170;
  const width = size.width || 140;
  let top = anchor.top - height - 6;
  if (top < 8) top = anchor.bottom + 6;
  const left = Math.max(8, Math.min(anchor.left, viewportWidth - width - 8));
  return { top, left };
}
