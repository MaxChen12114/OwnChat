/**
 * Settings-footer keeper: keeps the version tag and the footer pinned to the end of the settings
 * page, re-appending them after the settings panel repaints.
 *
 * The engine only decides *what to move and when*; every DOM access, the settings-button
 * subscription and the delayed re-runs arrive through {@link FooterKeeperPorts}, so the plan is
 * assertable in a vm without a document. Idempotent by construction: an appendChild of a node that
 * is already the last child is a no-op.
 * @module services/ui/settings-footer-keeper
 */

/** Elements the keeper needs; all lookups happen per call, never cached. */
export interface FooterKeeperEls {
  settings: unknown;
  tag: unknown;
  footer: unknown;
}

/** Ports: element lookup, the settings-button click subscription and the timer source. */
export interface FooterKeeperPorts {
  /** `getElementById` of the host document; returns `null` for unknown ids. */
  get(id: string): unknown;
  /** Subscribe a callback that fires after the settings button opens the panel. */
  onSettingsClick(cb: () => void): void;
  /** Delayed scheduler (ms); used for the two catch-up passes. */
  schedule(fn: () => void, ms: number): void;
}

/** Public surface; no frozen contract — the wiring runs it once at boot. */
export interface FooterKeeperApi {
  /** Append the tag and the footer to the settings node, in that order, when both belong to it. */
  moveToEnd(): void;
  /** Wire the click subscription and the 1500/3000ms catch-up passes. */
  auto(): void;
}

/** unknown -> plain-object view; arrays, null and scalars all become null (the standard bridge). */
function recOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  return out;
}

function parentOf(el: unknown): unknown {
  const rec = recOf(el);
  return rec === null ? null : rec["parentNode"];
}

function isSame(a: unknown, b: unknown): boolean {
  return a !== null && a !== undefined && a === b;
}

/**
 * Create the keeper. Nothing runs until {@link FooterKeeperApi.auto}; a missing settings node
 * makes every pass a no-op (the panel simply is not mounted).
 * @param ports - element lookup, click subscription and timer source from the wiring.
 * @returns The keeper with `moveToEnd` and `auto`.
 */
export function createFooterKeeper(ports: FooterKeeperPorts): FooterKeeperApi {
  function moveToEnd(): void {
    const settings = ports.get("settings");
    if (settings === null || settings === undefined) return;
    const settingsRec = recOf(settings);
    const append = settingsRec === null ? null : settingsRec["appendChild"];
    if (typeof append !== "function") return;
    const tag = ports.get("appVersionTag");
    const footer = ports.get("settingsFooter");
    if (isSame(parentOf(tag), settings)) append.call(settings, tag);
    if (isSame(parentOf(footer), settings)) append.call(settings, footer);
  }

  function auto(): void {
    ports.onSettingsClick(function () {
      ports.schedule(moveToEnd, 80);
    });
    ports.schedule(moveToEnd, 1500);
    ports.schedule(moveToEnd, 3000);
  }

  return { moveToEnd: moveToEnd, auto: auto };
}
