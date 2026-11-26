/**
 * Settings category navigation rules: which category exists, which one is the visible default,
 * and whether a saved category can be restored. The wiring owns DOM toggling, scroll reset and
 * the listeners.
 *
 * A saved category that no longer has a panel MUST fall back to the first visible item instead of
 * leaving every panel inactive. Visibility is caller-supplied because offsetParent is a DOM fact.
 * @module services/ui/settings-nav-init
 */

export const SNI_LS_CAT = "cfw_settings_cat_v1";

/** @returns whether a category has a matching panel. */
export function sniHit(cats: (string | null | undefined)[], cat: string): boolean {
  return cats.indexOf(cat) >= 0;
}

/** @returns the first visible category, or the first one when none is visible. */
export function sniFirstVisible(items: { cat: string; visible: boolean }[]): string {
  for (const it of items) if (it.visible) return it.cat;
  return items.length ? items[0].cat : "";
}

/** @returns whether the saved category can be restored directly. */
export function sniShouldRestore(saved: string | null, cats: (string | null | undefined)[]): boolean {
  return !!saved && sniHit(cats, saved);
}

/** @returns the category to activate on startup. */
export function sniInitialCat(
  saved: string | null,
  cats: (string | null | undefined)[],
  items: { cat: string; visible: boolean }[],
): string {
  return sniShouldRestore(saved, cats) ? String(saved) : sniFirstVisible(items);
}
