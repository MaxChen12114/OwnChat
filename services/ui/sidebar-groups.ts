/**
 * Left-rail fold groups, minus the DOM: which nodes the wrapper re-parents, the folded state each
 * group resolves to, and the toggle / aria / key rules.
 *
 * The sidebar template is never edited. The wiring scans the nav at runtime and wraps every
 * section title together with its following siblings, so buttons added later join a group on their
 * own. This file answers "what gets wrapped and what is folded"; the wrapper nodes, the
 * stylesheet, the delegated listeners and the childList observer stay in the wiring.
 *
 * Two rules are easy to break: a node already inside a group is never re-parented (wrapping is
 * idempotent, a later pass only adopts freshly inserted titles), and a title always heads the
 * range it opens even when that range holds nothing else.
 * @module services/ui/sidebar-groups
 */

/** Fold-state map key. Values are `true` for collapsed; the key itself is frozen. */
export const SB_LS_FOLDED = "cfw_sidebar_folded_v1";

/** Groups expanded on a first run, when the stored map has no entry for them. */
export const SB_DEFAULT_EXPANDED = ["模式", "对话"];

/** One nav child as the planner sees it: its role and whether a previous pass already adopted it. */
export interface SbNavItem {
  /** The node carries the section-title class, so it can open a group. */
  title: boolean;
  /** The node already sits inside a group; re-parenting it would reorder existing groups. */
  grouped: boolean;
}

/** One group to build: the title that heads it plus the children that move into it. */
export interface SbGroupRange {
  /** Index of the heading node in the scanned child list. */
  start: number;
  /** Indices to append in order; `start` is always first. */
  members: number[];
}

/** What one wrap pass should do, expressed in indices of the scanned child list. */
export interface SbPlan {
  /** Children before the first title: left in place, order preserved. */
  lead: number[];
  /** Groups to create, in document order. */
  groups: SbGroupRange[];
}

/**
 * Plan one wrap pass over the nav children.
 *
 * @param items Children in document order, each flagged by {@link SbNavItem}.
 * @returns The indices to keep and the groups to build, or `null` when no ungrouped title exists
 *   (nothing to do — callers use this to skip the repaint entirely).
 */
export function sbGroupPlan(items: SbNavItem[]): SbPlan | null {
  const starts: number[] = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].title && !items[i].grouped) starts.push(i);
  }
  if (!starts.length) return null;

  const lead: number[] = [];
  for (let i = 0; i < starts[0]; i++) {
    if (!items[i].grouped) lead.push(i);
  }

  const groups: SbGroupRange[] = [];
  for (let n = 0; n < starts.length; n++) {
    const end = n + 1 < starts.length ? starts[n + 1] : items.length;
    const members: number[] = [starts[n]];
    for (let i = starts[n] + 1; i < end; i++) {
      if (!items[i].grouped) members.push(i);
    }
    groups.push({ start: starts[n], members });
  }
  return { lead, groups };
}

/**
 * Folded state for one group.
 *
 * Stored entries win over the default even when the value is falsy, so an explicit `false` keeps a
 * group open across releases that change {@link SB_DEFAULT_EXPANDED}. Unknown groups start folded
 * unless listed there.
 *
 * @param state Parsed fold map (see {@link sbParseFolded}).
 * @param name Group name as captured from the heading text.
 * @param defaultExpanded Names expanded by default.
 */
export function sbFoldedOf(
  state: Record<string, unknown>,
  name: string,
  defaultExpanded: string[],
): boolean {
  if (name in state) return !!state[name];
  return defaultExpanded.indexOf(name) < 0;
}

/**
 * Resolve the whole nav in one call, aligned with the group nodes the caller holds.
 *
 * @returns One row per name, same order — the caller zips it back onto its node list.
 */
export function sbFoldRows(
  state: Record<string, unknown>,
  names: string[],
  defaultExpanded: string[],
): { name: string; folded: boolean }[] {
  const rows: { name: string; folded: boolean }[] = [];
  for (let i = 0; i < names.length; i++) {
    rows.push({ name: names[i], folded: sbFoldedOf(state, names[i], defaultExpanded) });
  }
  return rows;
}

/**
 * Flip one group, returning a copy rather than mutating the caller's map.
 *
 * Untouched entries keep their raw stored values (a hand-edited `"yes"` survives), so the written
 * bytes stay a superset of what other releases understand.
 *
 * @param currentlyFolded The state before the click; the result stores the negation.
 */
export function sbToggled(
  state: Record<string, unknown>,
  name: string,
  currentlyFolded: boolean,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(state)) next[k] = v;
  next[name] = !currentlyFolded;
  return next;
}

/**
 * Parse the stored fold map, tolerating anything localStorage can hand back.
 *
 * A malformed value, `null`, an array or a primitive all collapse to an empty map: losing the
 * stored folds is recoverable, throwing inside the boot pass is not.
 *
 * @param raw The raw stored string, possibly absent.
 */
export function sbParseFolded(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) out[k] = v;
  return out;
}

/**
 * Accessible label for a heading, naming the group it folds.
 *
 * @param name Group name; callers pass the trimmed heading text.
 */
export function sbTitleAria(name: string): string {
  return name + " 分组,点击展开/收起";
}

/** Whether a keydown on a heading should toggle it. Space is the button convention, not Enter only. */
export function sbIsToggleKey(key: string): boolean {
  return key === "Enter" || key === " ";
}
