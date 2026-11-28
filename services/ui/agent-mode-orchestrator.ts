/**
 * Agent-mode orchestration rules: persisted mode flag, button state, console-health predicate,
 * target-container choice, external-settings key filtering and startup/remount decisions. The
 * wiring owns DOM lookup, mounting, events and the frozen console global.
 *
 * A console root is healthy only while it is still connected AND lives in the container the
 * orchestrator mounts into. The mobile shell moves that same right-side container into its console,
 * so both breakpoints share one host and a stale root MUST be rebuilt.
 * @module services/ui/agent-mode-orchestrator
 */

export const AM_LS_AGENT = "cfw_agent_mode_v1";
export const AM_LS_MULTI = "tavern_multi_agent_mode_v1";

/** @returns whether the stored mode flag means the agent mode is on. */
export function amIsAgentOn(raw: unknown): boolean {
  return raw === "1";
}

/** @returns the value to persist for an on/off transition. */
export function amAgentOnValue(on: boolean): string {
  return on ? "1" : "0";
}

/** @returns the visual state of the topbar toggle; the titles are user-facing copy. */
export function amButtonState(on: boolean): { active: boolean; ariaPressed: string; title: string } {
  return {
    active: on,
    ariaPressed: on ? "true" : "false",
    title: on ? "Agent 模式：开启（点击关闭）" : "Agent 模式（点击开启）",
  };
}

/** @returns the container the console must live in (same slot on desktop and inside the mobile shell). */
export function amTargetBox(consoleSlot: unknown, fishbowlSlot: unknown): unknown {
  return consoleSlot || fishbowlSlot;
}

/** @returns whether an existing console root can be reused. */
export function amConsoleHealthy(rootConnected: boolean, boxContainsRoot: boolean): boolean {
  return rootConnected && boxContainsRoot;
}

/** @returns whether a resize or tab click must remount the console. */
export function amNeedsRemount(isOn: boolean, healthy: boolean): boolean {
  return isOn && !healthy;
}

/**
 * External changes come from cloud sync, another tab or a dev tool. A null key means the whole
 * store was cleared; every namespaced key is relevant because the settings are spread across them.
 */
export function amIsExternalSettingsKey(key: unknown): boolean {
  if (key === null) return true;
  const k = String(key);
  return k === AM_LS_AGENT || k === AM_LS_MULTI || /^(cfw_|tavern_)/.test(k);
}

/** @returns the startup plan: a restored session must mount lazily without activating the tab. */
export function amStartupPlan(isOn: boolean): { syncClass: boolean; delayedMount: boolean } {
  return { syncClass: isOn, delayedMount: isOn };
}
