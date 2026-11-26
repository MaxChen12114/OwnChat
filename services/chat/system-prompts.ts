/**
 * Prompt-assembly decisions used by both send paths: the enabled preset blocks and the agent-mode
 * predicate.
 *
 * `getExtraSystemPrompts` used to parse the preset JSON, choose between the per-card `presetIds`
 * list and the global `enabled` flags, drop COT in fast mode and sort by `order` inline in app.js.
 * That is the same data `prompt-profile` and the preset editor own, so the rules live here now and
 * app.js only supplies the raw storage string and the card's cap snapshot.
 * @module services/chat/system-prompts
 */

/** Preset storage key, shared with the preset editor and the prompt profile. */
export const PROMPT_PRESETS_KEY = "cfw_prompt_presets_v1";

/** Agent-mode switch key. */
export const AGENT_MODE_KEY = "cfw_agent_mode_v1";

function recOf(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value);
    for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  }
  return out;
}

/**
 * @param raw - Raw `cfw_prompt_presets_v1` value, or null.
 * @param mode - Current model mode (`fast`/`free`).
 * @param presetIds - Per-card preset id list, when the card caps the selection.
 * @returns The enabled contents joined by a blank line, or "".
 */
export function buildExtraSystemPrompts(raw: unknown, mode: unknown, presetIds: unknown): string {
  if (!raw) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch (e) {
    return "";
  }
  if (!Array.isArray(parsed)) return "";
  const isFast = mode === "fast";
  const ids = Array.isArray(presetIds) && presetIds.length ? presetIds : null;
  const rows: { content: string; order: number }[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const p = recOf(parsed[i]);
    const content = typeof p["content"] === "string" ? p["content"] : "";
    if (!content.trim()) continue;
    if (ids ? ids.indexOf(p["id"]) < 0 : !p["enabled"]) continue;
    if (isFast && p["name"] === "COT") continue;
    const n = Number(p["order"]);
    rows.push({ content: content.trim(), order: Number.isFinite(n) ? n : 0 });
  }
  rows.sort((a, b) => a.order - b.order);
  let out = "";
  for (let i = 0; i < rows.length; i++) out += (i ? "\n\n" : "") + rows[i].content;
  return out;
}

/**
 * @param raw - Raw `cfw_agent_mode_v1` value.
 * @param kernelReady - Whether AgentKernel and the tools bundle are both present.
 * @returns Whether the agent loop should be used.
 */
export function agentModeOn(raw: unknown, kernelReady: boolean): boolean {
  return (raw == null ? "0" : raw) === "1" && kernelReady;
}
