/**
 * Boolean settings switches: the storage key, the default polarity and the class side effect each
 * one carries. The keys are the contract — the chat path reads several of them back — so they live
 * here once instead of being re-spelled at every checkbox.
 *
 * Two polarities exist in the wild and are easy to mix up: `defaultOn` switches store `'0'` only
 * when turned off (missing key means on), while `defaultOff` ones store `'1'` only when turned on.
 * {@link readToggle} owns that rule; the DOM wiring only reflects it.
 * @module services/ui/settings-toggles
 */

/** One switch: where it is stored, what "on" means, and which class it toggles (if any). */
export interface ToggleSpec {
  readonly key: string;
  /** `true` = on unless the stored value is `'0'`; `false` = off unless the stored value is `'1'`. */
  readonly defaultOn: boolean;
  /** Class applied to `<html>`; empty string when the switch has no visual side effect. */
  readonly className: string;
  /** Apply the class while the switch is on, or while it is off (inverted switches like topbar). */
  readonly classWhen: "on" | "off";
}

/** The switch table. Adding a switch = one line here plus its wiring; keys must not be re-spelled. */
export const SETTINGS_TOGGLES: Record<string, ToggleSpec> = {
  stateLayer: { key: "cfw_state_layer_v1", defaultOn: true, className: "", classWhen: "on" },
  topbarCost: { key: "cfw_show_topbar_cost_v1", defaultOn: true, className: "hide-topbar-cost", classWhen: "off" },
  hideMsgActions: { key: "cfw_hide_msg_actions_v1", defaultOn: false, className: "hide-msg-actions", classWhen: "on" },
  hideStats: { key: "cfw_hide_stats_v1", defaultOn: false, className: "hide-stats", classWhen: "on" },
};

/** Storage port; the wiring wraps localStorage so quota errors never reach this module. */
export interface TogglePorts {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Read one switch under its declared polarity.
 * @param spec - the table entry.
 * @param raw - the stored string, `null` when absent.
 * @returns The effective boolean; a corrupt value falls back to the default.
 */
export function readToggle(spec: ToggleSpec, raw: string | null): boolean {
  if (spec.defaultOn) return raw !== "0";
  return raw === "1";
}

/**
 * Which class to add or remove for this switch state.
 * @returns `{ className, add }`; `className` is empty when the switch has no visual side effect.
 */
export function planToggleClass(spec: ToggleSpec, on: boolean): { className: string; add: boolean } {
  if (spec.className === "") return { className: "", add: false };
  const add = spec.classWhen === "on" ? on : !on;
  return { className: spec.className, add: add };
}

/** Public surface; the wiring assigns it to a non-`__` global. */
export interface SettingsTogglesApi {
  read(id: string): boolean;
  write(id: string, on: boolean): void;
  /** Class plan for `id`; an unknown id yields an empty plan instead of throwing. */
  planClass(id: string, on: boolean): { className: string; add: boolean };
  /** The stored key for `id`, so callers never spell it themselves. */
  keyOf(id: string): string;
}

/** Create the API. An unknown id reads as off and writes nothing (fail-safe, not fail-loud: a
 * stale DOM id must not break the whole settings panel). */
export function createSettingsToggles(ports: TogglePorts): SettingsTogglesApi {
  function specOf(id: string): ToggleSpec | null {
    const spec = SETTINGS_TOGGLES[id];
    return spec === undefined ? null : spec;
  }
  function read(id: string): boolean {
    const spec = specOf(id);
    if (spec === null) return false;
    return readToggle(spec, ports.getItem(spec.key));
  }
  function write(id: string, on: boolean): void {
    const spec = specOf(id);
    if (spec === null) return;
    ports.setItem(spec.key, on ? "1" : "0");
  }
  function planClass(id: string, on: boolean): { className: string; add: boolean } {
    const spec = specOf(id);
    if (spec === null) return { className: "", add: false };
    return planToggleClass(spec, on);
  }
  function keyOf(id: string): string {
    const spec = specOf(id);
    return spec === null ? "" : spec.key;
  }
  return { read: read, write: write, planClass: planClass, keyOf: keyOf };
}
