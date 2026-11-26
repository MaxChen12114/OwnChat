/**
 * Settings page data: the page-level storage keys and the rules its open/sync passes apply.
 *
 * Most cards now delegate their own keys to dedicated services. What remains here is the page
 * shell: the controls refreshed when the panel opens, the two value tables (`historyKeep` /
 * `promptKeep` / font size) and the external-settings re-read. Keys owned by other services
 * (appearance, multi-agent, persona) stay as literals in {@link SYNCED_CONTROLS} on purpose — this
 * product loads beside them, not above them, and the list is reviewed as one page-level snapshot.
 * @module services/ui/settings
 */

/** Page-level keys; changing one is changing what a saved browser profile sees. */
export const SETTINGS_PAGE_KEYS: Readonly<Record<string, string>> = {
  history: "cfw_history_enabled",
  prompt: "cfw_prompt_enabled",
  customPrompt: "cfw_custom_prompt_v1",
  personalize: "cfw_agent_personalize_v1",
  fontSize: "cfw_chat_font_size_v1",
  fontFamily: "cfw_chat_font_family_v1",
  textFx: "cfw_chat_text_fx_v1",
  chatSession: "cfw_chat_session_v1",
  autoplay: "cfw_tts_autoplay_v1",
  mode: "cfw_mode",
  agentWorkMode: "cfw_agent_work_mode_v1",
  agentTools: "cfw_agent_tools_v1",
  agentMaxRounds: "cfw_agent_max_rounds_v1",
};

/** `[element id, storage key]` pairs re-read after an external-settings broadcast. */
export const SYNCED_CONTROLS: ReadonlyArray<readonly [string, string]> = [
  ["historyKeep", SETTINGS_PAGE_KEYS.history],
  ["promptKeep", SETTINGS_PAGE_KEYS.prompt],
  // Owned by the persona service; kept literal because that product loads beside this one.
  ["useBuiltinToggle", "cfw_use_builtin"],
  ["appFxRichToggle", "cfw_app_fx_rich_v1"],
  ["appMemIdleToggle", "cfw_mem_idle_release_v1"],
  ["maDelegate", "cfw_ma_delegate_v1"],
  ["maMeeting", "cfw_ma_meeting_v1"],
  ["maInvite", "cfw_ma_invite_v1"],
  ["agentMaxRounds", SETTINGS_PAGE_KEYS.agentMaxRounds],
  // Compaction parameters (owned by the context service; the card mirrors them).
  ["ctxCompactEnabled", "cfw_summary_enabled"],
  ["ctxTrigger", "cfw_summary_trigger"],
  ["ctxKeep", "cfw_summary_keep"],
  ["ctxRatio", "cfw_summary_ratio_v1"],
];

/** History switch: only the literal `"1"` enables sending history. */
export function normalizeHistoryKeep(raw: unknown): boolean {
  return raw === "1";
}

/** Custom-prompt switch: missing means ON; any other value must be the literal `"1"`. */
export function normalizePromptKeep(raw: unknown): boolean {
  return raw == null ? true : raw === "1";
}

/** Chat font size: stored value clamped to the slider range, anything invalid falls back to 13px. */
export function normalizeFontSize(raw: unknown): number {
  const n = parseInt(String(raw ?? ""), 10);
  return n >= 12 && n <= 22 ? n : 13;
}

/** Top-level mode mirror: only the literal `fast` selects fast; everything else is free. */
export function normalizeMode(raw: unknown): string {
  return raw === "fast" ? "fast" : "free";
}

/** Local TTS auto-read: only the literal `"1"` enables it. */
export function normalizeAutoplay(raw: unknown): boolean {
  return raw === "1";
}

/** Re-read rule for the synced checkbox table: missing means ON, otherwise only `"1"` is on. */
export function syncedCheckboxChecked(raw: unknown): boolean {
  return raw == null ? true : raw === "1";
}
