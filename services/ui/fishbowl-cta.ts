/**
 * Empty-state call to action for the group-chat console: is multi-agent mode on, should the build
 * button show, and which of the two guidance messages applies.
 *
 * The mode has two sources of truth read in a fixed order — a live `multi` query, then a storage
 * key. The live source wins *even when it answers false*; storage is consulted only when the live
 * bridge is absent. A throw from either source resolves to off: a hint row must never take the boot
 * sequence down during hot reload.
 *
 * Button visibility and guidance text are one decision returned as a plan, because they are two
 * halves of the same state — showing "build a group" while multi is off, or the "switch mode" hint
 * while it is on, is the bug this used to produce. The literal copy stays in the wiring: this
 * module decides *which* message, never its wording.
 * @module services/ui/fishbowl-cta
 */

/** The guidance variants. The wiring maps each to its own literal copy. */
export type CtaKind = "start" | "enable";

/** What the empty-state row should look like. */
export interface CtaPlan {
  buildVisible: boolean;
  message: CtaKind;
}

/**
 * Decide the empty-state row for a mode.
 *
 * @param multiOn Whether multi-agent mode is active.
 * @returns With multi on, the build button shows and the "start a group" guidance is chosen; with
 * it off, the button hides and the "enable multi-agent" guidance is chosen.
 */
export function ctaPlan(multiOn: boolean): CtaPlan {
  return multiOn
    ? { buildVisible: true, message: "start" }
    : { buildVisible: false, message: "enable" };
}

/**
 * Read multi-agent mode from injected ports, preserving the live-first / storage-fallback order.
 *
 * @param queryMulti Live query returning a boolean, or `undefined` when the bridge is absent. When
 * it returns a boolean that value is final — including `false`, which does NOT consult storage.
 * @param readKey Storage reader, may be absent.
 * @param key Storage key holding the multi-agent mode.
 * @param onValue The stored value that means multi mode is on.
 * @returns Off if either port throws, if no port is present, or if storage holds another value.
 */
export function isMultiFrom(
  queryMulti: (() => boolean | undefined) | undefined,
  readKey: ((k: string) => string | null) | undefined,
  key: string,
  onValue: string,
): boolean {
  try {
    if (queryMulti) {
      const live = queryMulti();
      if (live !== undefined) return !!live;
    }
    if (readKey) return readKey(key) === onValue;
    return false;
  } catch (e) {
    return false;
  }
}
