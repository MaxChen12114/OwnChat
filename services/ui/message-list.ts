/**
 * The message-list rules, minus the DOM: spacer height math, the near-bottom threshold, the
 * tool-turn collector and the renderSession per-message decisions (empty shells, bubble
 * hide/remove, stats lines, speaker cards).
 *
 * The tool-turn collector is the part worth locking. Agent tool rounds do NOT get their own row:
 * they fold into the final assistant answer as one process panel per turn. The collector walks
 * forward from an assistant message carrying tool_calls, pairs each call with the tool results
 * that immediately follow, and merges the `_tool` metadata (name/ok/ms/denied) recorded at call
 * time over the wire-format `function.arguments`. A call whose recorded meta is missing still
 * renders (fallback name "tool", args parsed from the wire JSON, ok defaults to true).
 *
 * History rows also carry sidx (the true session index) — DOM order diverges whenever tool rounds
 * folded, and retry/delete must truncate by session index, not by row position.
 * @module services/ui/message-list
 */

/** Distance (px) from the bottom inside which a new row triggers auto-scroll. */
export const ML_NEAR_BOTTOM_DIST = 120;

/** CSS-var fallbacks for the bottom spacer: composer gap and breathing room below it. */
export const ML_DEFAULT_GAP = 18;
export const ML_DEFAULT_EXTRA = 28;

/** Parse a CSS length custom property; missing or non-numeric yields the fallback. */
export function mlParseLen(raw: string | null | undefined, fallback: number): number {
  const v = raw != null ? parseFloat(raw) : NaN;
  return Number.isFinite(v) ? v : fallback;
}

/** Spacer height: composer height + gap + extra + keyboard inset, rounded up so fractional
 * composer heights never leave a 1px sliver of chat visible behind the composer. */
export function mlSpacerHeight(
  composerHeight: number,
  gap: number,
  extra: number,
  kb: number,
): number {
  return Math.ceil(composerHeight + gap + extra + kb);
}

/** Near-bottom test: within ML_NEAR_BOTTOM_DIST of the scroll end counts as "following". */
export function mlIsNearBottom(distFromBottom: number): boolean {
  return distFromBottom < ML_NEAR_BOTTOM_DIST;
}

/** One decoded tool call as the process panel expects it. */
export interface MlToolCall {
  name: unknown;
  args: unknown;
  ok: boolean;
  ms?: unknown;
  error?: unknown;
  denied: boolean;
  result?: unknown;
}

/** One folded tool round: a process panel payload plus its round number. */
export interface MlToolTurn {
  round: number;
  calls: MlToolCall[];
  preamble?: unknown;
  thinking?: unknown;
}

/** Parse the wire-format `function.arguments` JSON; malformed or empty yields null (the panel
 * renders the call without args rather than blowing up a whole history restore). */
export function mlParseCallArgs(raw: unknown): unknown {
  if (typeof raw !== "string" || !raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_e) {
    return null;
  }
}

function rec(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

/** Map one wire tool_call plus its paired tool result message onto the panel shape. The `_tool`
 * metadata recorded at call time wins over wire defaults: its args replace the parsed JSON (it
 * holds the already-validated object), its ok flag is authoritative (only an explicit false
 * means failure), and name/result fall back to the wire values. */
export function mlBuildCall(tc: unknown, toolMsg: unknown): MlToolCall {
  const call = rec(tc);
  const fn = rec(call["function"]);
  const meta = rec(rec(toolMsg)["_tool"]);
  const argsParsed = mlParseCallArgs(fn["arguments"]);
  const args =
    meta["args"] !== undefined ? meta["args"] : argsParsed;
  return {
    name: meta["name"] ? meta["name"] : fn["name"] ? fn["name"] : "tool",
    args,
    ok: meta["ok"] !== false,
    ms: meta["ms"],
    error: meta["error"],
    denied: Boolean(meta["denied"]),
    result: rec(toolMsg)["content"],
  };
}

/** Collect the tool round starting at `list[i]` (an assistant message carrying non-empty
 * tool_calls) and return it with `end`, the index of the first message after the round's tool
 * results. Returns null when the caller mis-aimed: no calls, or the entry is not an assistant
 * message with tool_calls — the caller must then render the message normally, not skip it. */
export function mlCollectToolTurn(
  list: unknown[],
  i: number,
  roundNo: number,
): { turn: MlToolTurn; end: number } | null {
  const m = rec(list[i]);
  const rawCalls = m["tool_calls"];
  if (m["role"] !== "assistant" || !Array.isArray(rawCalls) || rawCalls.length === 0) return null;
  const toolMsgs: unknown[] = [];
  let j = i + 1;
  while (j < list.length) {
    const t = rec(list[j]);
    if (t["role"] !== "tool") break;
    toolMsgs.push(list[j]);
    j++;
  }
  const calls = rawCalls.map((tc, k) => mlBuildCall(tc, toolMsgs[k] ?? {}));
  const turn: MlToolTurn = { round: roundNo, calls };
  // Visible prose emitted alongside the call and the round's thinking both fold into the panel
  // top, keeping one continuous workflow (thinking / tools / prose) with the live path.
  if (m["agentPreamble"] !== undefined) turn.preamble = m["agentPreamble"];
  if (m["reasoning_content"] !== undefined) turn.thinking = m["reasoning_content"];
  return { turn, end: j };
}

/** An assistant message with nothing to show — no prose, no thinking, no attachments. These
 * shells only appear when navigation/system reclamation interrupts a turn mid-flight; rendering
 * them used to produce a headless avatar-only "empty message" that also split adjacent panels
 * from their answers. Skipped only when no pending tool rounds need a host row. */
export function mlEmptyShell(msg: unknown): boolean {
  const m = rec(msg);
  const files = Array.isArray(m["files"]) ? m["files"] : [];
  const images = Array.isArray(m["images"]) ? m["images"] : [];
  const content = m["content"];
  // String(m.content || "") semantics: non-string content still stringifies (42 → "42"),
  // null/undefined collapse to "".
  return (
    !String(content || "").trim() &&
    !m["reasoning_content"] &&
    files.length === 0 &&
    images.length === 0
  );
}

/** What to do with a synthetic host row whose bubble stayed empty: remove the whole row when the
 * panel contributed nothing visible (no text, no children), hide just the bubble when the panel
 * rendered but has no prose, and leave the row alone once the bubble has content. */
export function mlBubbleAction(
  bubbleText: string,
  bubbleChildCount: number,
): "remove" | "hide" | null {
  const text = typeof bubbleText === "string" ? bubbleText.trim() : "";
  if (!text && bubbleChildCount === 0) return "remove";
  if (!text) return "hide";
  return null;
}

/** Per-row stats line for user messages (estimated input + running total). */
export function mlStatsLineUser(inEst: number, totalIn: number): string {
  return `Input(估算): ≈${inEst} | Total In(估算): ≈${totalIn}`;
}

/** Per-row stats line for assistant messages (estimated output + running total). Real usage
 * cannot be recovered on restore; the estimate convention matches the live free-mode path. */
export function mlStatsLineAssistant(outEst: number, totalOut: number): string {
  return `Output(估算): ≈${outEst} | Total Out(估算): ≈${totalOut}`;
}

/** Speaker card handed to decorateAiRow (or used for the emoji fallback when character.js is not
 * ready yet): id may be empty, icon falls back to 🙂. Fields keep the original truthy-fallback
 * semantics — a numeric id/icon passes through as-is rather than being coerced away. */
export function mlSpeakerCard(msg: unknown): {
  id: unknown;
  name: unknown;
  icon: unknown;
} {
  const m = rec(msg);
  const id = m["speakerId"] ? m["speakerId"] : "";
  const icon = m["speakerIcon"] ? m["speakerIcon"] : "🙂";
  return { id, name: m["speakerName"], icon };
}
