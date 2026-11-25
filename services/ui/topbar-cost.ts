/**
 * The top-bar billing button: the mode gate, the two amount spellings, and the bill card's markup and
 * placement. No storage and no DOM — the wiring hands in the mode flag, the figures, the anchor rect
 * and the viewport width.
 *
 * Two amount formatters survive on purpose. The dataset/title spelling reads a non-numeric figure as
 * zero before rounding, while the card re-formats whatever the dataset already holds and maps a
 * non-finite value to "0.0000". Collapsing them changes what a garbled figure renders as.
 *
 * @module services/ui/topbar-cost
 */

/** The mode lives in storage, not in memory: `applyMode` writes it before repainting the top bar. */
export const TOPBAR_COST_LS_MODE = "cfw_mode";

/** Free mode keeps the icon and drops the figures — the button says "not billed", never "¥0". */
export const TOPBAR_COST_FREE_TITLE = "免费模式，不计费";

/** Gap under the button and against both viewport edges. */
export const TOPBAR_COST_POP_GAP = 8;

/** Width used when the card measures zero (read before layout) so the edge clamp still means something. */
export const TOPBAR_COST_POP_FALLBACK_WIDTH = 220;

/** The figures the cost facade reports; `unknown` because the facade is a plain JS global. */
export interface TopbarCostFigures {
  today: unknown;
  total: unknown;
}

/** What the button should read after one refresh. */
export interface TopbarCostView {
  /** Free mode: keep the icon, carry no figures. */
  placeholder: boolean;
  /** Four-decimal figure for the dataset, or null when the dataset must be cleared. */
  today: string | null;
  /** Same spelling as {@link TopbarCostView.today}; always null when `today` is. */
  total: string | null;
  title: string;
  ariaLabel: string;
}

/** Viewport coordinates for the card. */
export interface TopbarCostPopPlace {
  left: number;
  top: number;
}

/**
 * A figure as the dataset stores it: four decimals, rounded first; anything non-numeric reads as zero
 * (an `Infinity` still prints as "Infinity", which is what the previous spelling did).
 */
export function topbarCostDatasetAmount(raw: unknown): string {
  const n = Number(raw) || 0;
  return (Math.round(n * 10000) / 10000).toFixed(4);
}

/** A figure as the card shows it: the dataset string rounded to four decimals, non-finite reads as zero. */
export function topbarCostCardAmount(raw: unknown): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return "0.0000";
  return n.toFixed(4);
}

/**
 * The button's next state. Free mode must not read the figures at all, so callers pass `null` there;
 * billable with null figures means the facade answered nothing and the button shows zeros rather than
 * falling back to the placeholder — "billed nothing" and "not billed" are different statements.
 */
export function topbarCostView(input: { billable: boolean; figures: TopbarCostFigures | null }): TopbarCostView {
  if (!input.billable) {
    return {
      placeholder: true,
      today: null,
      total: null,
      title: TOPBAR_COST_FREE_TITLE,
      ariaLabel: TOPBAR_COST_FREE_TITLE,
    };
  }
  const figures = input.figures;
  const today = topbarCostDatasetAmount(figures ? figures.today : 0);
  const total = topbarCostDatasetAmount(figures ? figures.total : 0);
  return {
    placeholder: false,
    today,
    total,
    title: "今日 ¥" + today + " · 总计 ¥" + total + "（点开账单）",
    ariaLabel: "计费：今日 ¥" + today + "，总计 ¥" + total,
  };
}

/**
 * The bill card's inner markup. Both figures missing means the card was never filled (free mode), a
 * different statement from "zero spent", so that case gets its own copy instead of a ¥0.0000 card.
 */
export function topbarCostBillHtml(today: string | null | undefined, total: string | null | undefined): string {
  if (today == null && total == null) {
    return (
      '<div class="bill-empty">当前不计费</div>' +
      '<div class="bill-note">免费模式不产生费用；切到「快速」模式后按 token 计费。</div>'
    );
  }
  return (
    '<div class="bill-big">¥' +
    topbarCostCardAmount(today) +
    "</div>" +
    '<div class="bill-sub">今日 · 累计 ¥' +
    topbarCostCardAmount(total) +
    "</div>" +
    '<div class="bill-note">仅快速模式计费。明细随对话实时更新。</div>'
  );
}

/**
 * Where the card goes. It hangs `TOPBAR_COST_POP_GAP` below the button and is pulled back inside both
 * viewport edges; the caller zeroes the coordinates before measuring, because a leftover `left` would
 * feed back into the measured width.
 */
export function topbarCostPopPlace(input: {
  anchorLeft: number;
  anchorBottom: number;
  popWidth: number;
  viewportWidth: number;
}): TopbarCostPopPlace {
  const width = input.popWidth || TOPBAR_COST_POP_FALLBACK_WIDTH;
  let left = input.anchorLeft;
  if (left + width > input.viewportWidth - TOPBAR_COST_POP_GAP) left = input.viewportWidth - width - TOPBAR_COST_POP_GAP;
  if (left < TOPBAR_COST_POP_GAP) left = TOPBAR_COST_POP_GAP;
  return { left: Math.round(left), top: Math.round(input.anchorBottom + TOPBAR_COST_POP_GAP) };
}
