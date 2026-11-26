(function () {
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
const TOPBAR_COST_LS_MODE = "cfw_mode";

/** Free mode keeps the icon and drops the figures — the button says "not billed", never "¥0". */
const TOPBAR_COST_FREE_TITLE = "免费模式，不计费";

/** Gap under the button and against both viewport edges. */
const TOPBAR_COST_POP_GAP = 8;

/** Width used when the card measures zero (read before layout) so the edge clamp still means something. */
const TOPBAR_COST_POP_FALLBACK_WIDTH = 220;

/** The figures the cost facade reports; `unknown` because the facade is a plain JS global. */
                                    
                 
                 
 

/** What the button should read after one refresh. */
                                 
                                                    
                       
                                                                                       
                       
                                                                                    
                       
                
                    
 

/** Viewport coordinates for the card. */
                                     
               
              
 

/**
 * A figure as the dataset stores it: four decimals, rounded first; anything non-numeric reads as zero
 * (an `Infinity` still prints as "Infinity", which is what the previous spelling did).
 */
function topbarCostDatasetAmount(raw         )         {
  const n = Number(raw) || 0;
  return (Math.round(n * 10000) / 10000).toFixed(4);
}

/** A figure as the card shows it: the dataset string rounded to four decimals, non-finite reads as zero. */
function topbarCostCardAmount(raw         )         {
  const n = Number(raw);
  if (!Number.isFinite(n)) return "0.0000";
  return n.toFixed(4);
}

/**
 * The button's next state. Free mode must not read the figures at all, so callers pass `null` there;
 * billable with null figures means the facade answered nothing and the button shows zeros rather than
 * falling back to the placeholder — "billed nothing" and "not billed" are different statements.
 */
function topbarCostView(input                                                          )                 {
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
function topbarCostBillHtml(today                           , total                           )         {
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
function topbarCostPopPlace(input   
                     
                       
                   
                        
 )                     {
  const width = input.popWidth || TOPBAR_COST_POP_FALLBACK_WIDTH;
  let left = input.anchorLeft;
  if (left + width > input.viewportWidth - TOPBAR_COST_POP_GAP) left = input.viewportWidth - width - TOPBAR_COST_POP_GAP;
  if (left < TOPBAR_COST_POP_GAP) left = TOPBAR_COST_POP_GAP;
  return { left: Math.round(left), top: Math.round(input.anchorBottom + TOPBAR_COST_POP_GAP) };
}

// Browser adapter, appended by l0/emit.mjs. Engine: services/ui/topbar-cost.ts; this file owns the two
// elements, the listeners, the body re-parenting and every host read (localStorage, the cost facade,
// the viewport). All text, rounding and placement arithmetic live in the engine.
//
// `refresh` is also called from app.js on a timer, so it must survive a page that never received the
// cost facade: it returns silently instead of throwing into the caller's tick.
(function () {
  "use strict";
  if (window.__topbarCost) return;

  function costApi() {
    var api = window.hostApi;
    var cost = api && api.cost ? api.cost : null;
    if (!cost || typeof cost.getCostStats !== "function") return null;
    return cost;
  }

  function refresh() {
    var btn = document.getElementById("costDisplay");
    if (!btn) return;
    var cost = costApi();
    if (!cost) return;
    var billable = localStorage.getItem(TOPBAR_COST_LS_MODE) === "fast";
    var stats = billable ? cost.getCostStats() : null;
    var view = topbarCostView({
      billable: billable,
      figures: stats && typeof stats === "object" ? stats : null,
    });
    if (view.placeholder) btn.classList.add("cost-placeholder");
    else btn.classList.remove("cost-placeholder");
    btn.title = view.title;
    btn.setAttribute("aria-label", view.ariaLabel);
    if (view.today === null || view.total === null) {
      delete btn.dataset.today;
      delete btn.dataset.total;
    } else {
      btn.dataset.today = view.today;
      btn.dataset.total = view.total;
    }
  }

  function ready() {
    var btn = document.getElementById("costDisplay");
    var pop = document.getElementById("billPop");
    if (!btn || !pop) return;

    // #topbar carries backdrop-filter: blur(), which makes it the containing block for fixed children.
    // A card left inside it would position against the bar instead of the viewport, so it moves to body
    // and `left`/`top` stay viewport coordinates.
    if (pop.parentElement !== document.body) document.body.appendChild(pop);

    function render() {
      pop.innerHTML = topbarCostBillHtml(btn.dataset.today, btn.dataset.total);
    }

    function place() {
      // Zero first: a leftover left from the previous open would feed back into the measured width.
      pop.style.left = "0px";
      pop.style.top = "0px";
      var anchor = btn.getBoundingClientRect();
      var next = topbarCostPopPlace({
        anchorLeft: anchor.left,
        anchorBottom: anchor.bottom,
        popWidth: pop.getBoundingClientRect().width,
        viewportWidth: window.innerWidth,
      });
      pop.style.left = next.left + "px";
      pop.style.top = next.top + "px";
    }

    function open() {
      render();
      pop.hidden = false;
      place();
    }

    function close() {
      pop.hidden = true;
    }

    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (pop.hidden) open();
      else close();
    });
    btn.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (pop.hidden) open();
        else close();
      }
    });
    document.addEventListener("click", function (e) {
      if (pop.hidden) return;
      if (pop.contains(e.target)) return;
      close();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !pop.hidden) close();
    });
    window.addEventListener("resize", function () {
      if (!pop.hidden) place();
    });
    // Follow the dataset while the card is open: app.js refreshes it on its own cycle.
    setInterval(function () {
      if (!pop.hidden) render();
    }, 2000);
  }

  function boot() {
    ready();
    refresh();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  window.__topbarCost = { __v: 1, refresh: refresh };
})();

globalThis.TOPBAR_COST_LS_MODE = TOPBAR_COST_LS_MODE;
globalThis.TOPBAR_COST_FREE_TITLE = TOPBAR_COST_FREE_TITLE;
globalThis.TOPBAR_COST_POP_GAP = TOPBAR_COST_POP_GAP;
globalThis.TOPBAR_COST_POP_FALLBACK_WIDTH = TOPBAR_COST_POP_FALLBACK_WIDTH;
globalThis.topbarCostDatasetAmount = topbarCostDatasetAmount;
globalThis.topbarCostCardAmount = topbarCostCardAmount;
globalThis.topbarCostView = topbarCostView;
globalThis.topbarCostBillHtml = topbarCostBillHtml;
globalThis.topbarCostPopPlace = topbarCostPopPlace;
})();
