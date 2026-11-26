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
