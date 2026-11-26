/**
 * Settings category navigation: which tabs are visible and which one opens.
 *
 * Two gates hide tabs (developer mode, and the voice tab which only exists inside a shell) and a
 * remembered category may point at a tab that is hidden on this device — in that case the first
 * visible tab wins, and `account` is the last resort. Keeping the decision here means the DOM
 * wiring only applies a plan, so a hidden saved tab can no longer leave the panel on an empty
 * category.
 * @module services/ui/settings-cat-nav
 */

/** One tab as the DOM reports it: its category id and whether it is developer-only. */
export interface CatItem {
  readonly cat: string;
  readonly devOnly: boolean;
}

/** Everything the plan depends on. */
export interface CatNavInput {
  readonly items: readonly CatItem[];
  /** Developer mode switch (`cfw_dev_mode_v1`). */
  readonly devOn: boolean;
  /** Whether a desktop/mobile shell is hosting the page (native GPT-SoVITS needs it). */
  readonly isApp: boolean;
  /** Whether cloud speech is loaded — the voice tab stays useful in the browser without a shell. */
  readonly hasCloudTts: boolean;
  /** Last remembered category, `null` when never set. */
  readonly saved: string | null;
}

/** The plan: hidden tabs and the tab to activate. */
export interface CatNavPlan {
  readonly hidden: readonly string[];
  readonly active: string;
}

/** Category used when nothing else is visible (the panel always has an account tab). */
export const FALLBACK_CATEGORY = "account";

/**
 * Decide visibility and the active tab.
 * @param input - items plus the two gates and the remembered category.
 * @returns Hidden category ids and the active one; an empty item list still yields the fallback.
 */
export function planCatNav(input: CatNavInput): CatNavPlan {
  const hidden: string[] = [];
  for (let i = 0; i < input.items.length; i++) {
    const item = input.items[i];
    if (item.devOnly && !input.devOn) hidden.push(item.cat);
    // The voice tab used to be shell-only because local GPT-SoVITS needs native audio. Cloud speech
    // (2026-11-25) runs through the Worker and works in the browser, so the tab is visible whenever
    // either engine is available — otherwise the only speech setting in a web guest session would
    // be buried in the model-API category.
    else if (item.cat === "voice" && !input.isApp && !input.hasCloudTts) hidden.push(item.cat);
  }
  const visible = (cat: string): boolean => hidden.indexOf(cat) < 0;
  // 旧实现用 `items.find(cat === saved && 可见)`：保存的分类必须**当前存在于列表里**才算数，
  // 否则回落首个可见页（例如换了版本后某分类被移除）。只判 visible 会让空表也接受任意 saved。
  const exists = (cat: string): boolean => {
    for (let i = 0; i < input.items.length; i++) if (input.items[i].cat === cat) return true;
    return false;
  };
  if (input.saved !== null && input.saved !== "" && exists(input.saved) && visible(input.saved)) {
    return { hidden: hidden, active: input.saved };
  }
  for (let i = 0; i < input.items.length; i++) {
    if (visible(input.items[i].cat)) return { hidden: hidden, active: input.items[i].cat };
  }
  return { hidden: hidden, active: FALLBACK_CATEGORY };
}
