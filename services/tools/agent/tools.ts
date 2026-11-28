/**
 * Tool-catalogue policy: which tool families are visible per profile and which orchestration tools
 * need the multi-agent gate.
 *
 * The tools bundle used to carry these lists inline. Three separate consumers depend on them — the
 * settings dropdown (`cfw_agent_tools_v1`), `buildRegistry({ profile })`, and the kernel's sub-agent
 * fork — so a single source is what keeps "what this profile can see" from drifting between them.
 * The bundle still owns every schema and forward; this module owns only the lists and the predicate.
 *
 * @module services/tools/agent/tools
 */

/** Storage keys read by the bundle; the literals are shared with the settings card. */
export const AGENT_TOOLS_KEY = "cfw_agent_tools_v1";
export const MULTI_AGENT_MODE_KEY = "tavern_multi_agent_mode_v1";

/** Default profile: the tools used every day. */
export const CORE_TOOLS: readonly string[] = [
  "offer_choices", "load_skill",
  "manage_character_card", "send_image", "adjust_affinity", "speak",
  // T3-D: compaction replaces early text with a summary + seq anchor; this is the way back.
  "history_search",
  // Orchestration tools are in core, but still need the multi-agent gate below.
  "delegate_to_agent", "convene_meeting", "invite_character",
];

/** Sub-agents reuse the parent registry; only the orchestration tools are filtered, never this list. */
export const SUB_TOOLS: readonly string[] = ["load_skill"];

/** Character agents on stage: read-only tools, canvas and whisper; no writes, no orchestration. */
export const CHAR_TOOLS: readonly string[] = [
  "load_skill",
  "read_file", "search_file", "list_files", "list_source", "read_source", "search_source",
  "local_list_dir", "local_read_file",
  "stage_list", "stage_view", "stage_call",
  "whisper", "send_image",
];

/** Orchestration tool -> its settings switch. Absence of the key means ON. */
export const MA_GATED: Readonly<Record<string, string>> = {
  delegate_to_agent: "cfw_ma_delegate_v1",
  convene_meeting: "cfw_ma_meeting_v1",
  invite_character: "cfw_ma_invite_v1",
};

/**
 * Decide the effective profile. An explicit `opts.profile` wins; otherwise the stored dropdown
 * value; otherwise `core`. Unknown stored values fall back to `core` at the allow-list step.
 *
 * @param requested - `opts.profile` from the caller, if any.
 * @param stored - `cfw_agent_tools_v1`, already read by the bundle.
 * @returns The profile name.
 */
export function resolveProfile(requested: unknown, stored: unknown): string {
  if (typeof requested === "string" && requested) return requested;
  if (typeof stored === "string" && stored) return stored;
  return "core";
}

/**
 * @param profile - Resolved profile.
 * @param name - Tool name from the definition.
 * @returns Whether the profile's allow-list includes it; `full` and `sub` allow everything.
 */
export function allowedFor(profile: string, name: unknown): boolean {
  if (profile === "full" || profile === "sub") return true;
  const list = profile === "char" ? CHAR_TOOLS : CORE_TOOLS;
  return typeof name === "string" && list.indexOf(name) >= 0;
}

/** @returns The settings key gating this tool, or null when it is not orchestration. */
export function maGateKey(name: unknown): string | null {
  if (typeof name !== "string") return null;
  return Object.prototype.hasOwnProperty.call(MA_GATED, name) ? MA_GATED[name] : null;
}

/** @returns True when the sidebar mode is the literal `multi`. */
export function maModeOn(raw: unknown): boolean {
  return raw === "multi";
}

/** @returns The per-tool switch; a missing value means ON. */
export function maFlagOn(raw: unknown): boolean {
  return raw == null ? true : raw === "1";
}

/**
 * @param profile - Resolved profile; `sub` never gets orchestration tools (recursion guard).
 * @param modeRaw - Stored sidebar mode.
 * @param flagRaw - Stored per-tool switch.
 * @returns Whether the orchestration tool may be registered.
 */
export function maEnabled(profile: string, modeRaw: unknown, flagRaw: unknown): boolean {
  return profile !== "sub" && maModeOn(modeRaw) && maFlagOn(flagRaw);
}
