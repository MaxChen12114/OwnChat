// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/ui/sidebar-groups.ts; this file owns
// the DOM: the nav scan, the wrapper nodes, the stylesheet, the delegated listeners, the childList
// observer and localStorage.
//
// Why a runtime wrapper instead of template markup: the rail is 800px tall and four sections of
// 38px buttons take 696px, leaving no room for the conversation list. Folding the section headings
// frees roughly 460px without touching the sidebar HTML, and any button added later joins a group
// by itself.
//
// Idempotence: a pass skips everything already inside a group, so the observer below only ever
// adopts the headings that a sibling module (the conversation list) inserts later. The wrap must
// happen before the fold is applied, and a pass that wraps nothing must not repaint folds.
(function () {
  "use strict";

  var STYLE_ID = "sbGroupStyles";
  var CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';

  var CSS_TEXT = `
/* The group container must reproduce the nav's flex column and 4px gap: the buttons used to be
   direct children of the nav and got their spacing from its gap; inside a plain block they would
   collapse together. */
.sb-group{display:flex;flex-direction:column;gap:4px;}
/* The heading doubles as the fold switch, so it has to match the weight of the buttons it heads.
   It used to be 30px / 10.5px / #666 against 38px / 13px buttons (ratio 0.79) — too thin and too
   dim. Now 36px / 12.5px / 600, with the colour left to each theme's section-title rule instead of
   a hardcoded grey. The chevron is 15px at opacity .8 so it reads as clickable. */
.sidebar-section-title.sb-group-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:36px;padding:8px;font-size:12.5px;font-weight:600;letter-spacing:.3px;cursor:pointer;user-select:none;border-radius:9px;transition:background .15s;}
.sidebar-section-title.sb-group-head:hover{background:rgba(127,127,127,.12);}
.sidebar-section-title.sb-group-head:focus-visible{outline:2px solid var(--btn-bg,rgba(127,127,127,.5));outline-offset:1px;}
.sb-group-head .sb-chev{display:inline-flex;flex:none;align-items:center;justify-content:center;width:20px;height:20px;border-radius:6px;opacity:.8;transition:transform .18s ease,opacity .15s,background .15s;}
.sb-group-head .sb-chev svg{width:15px;height:15px;display:block;}
.sb-group-head:hover .sb-chev{opacity:1;background:rgba(127,127,127,.18);}
.sb-group:not(.sb-folded) > .sb-group-head .sb-chev{transform:rotate(90deg);}
.sb-group.sb-folded > *:not(.sb-group-head){display:none !important;}
@media (prefers-reduced-motion:reduce){.sb-group-head .sb-chev{transition:none;}}
`;

  function ensureCss() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS_TEXT;
    (document.head || document.documentElement).appendChild(s);
  }

  function loadFolded() {
    try {
      return sbParseFolded(localStorage.getItem(SB_LS_FOLDED));
    } catch (e) { return {}; }
  }
  function saveFolded(m) {
    try { localStorage.setItem(SB_LS_FOLDED, JSON.stringify(m)); } catch (e) {}
  }

  function navEl() { return document.querySelector("#leftSidebar .sidebar-nav") || document.querySelector(".sidebar-nav"); }

  // Re-parent the headings and their siblings into groups. Returns false when there was nothing to
  // wrap, which is the common case for every pass after the first.
  function wrapAll() {
    var nav = navEl();
    if (!nav) return false;
    var kids = Array.prototype.slice.call(nav.children);
    var items = kids.map(function (el) {
      return {
        title: !!(el.classList && el.classList.contains("sidebar-section-title")),
        grouped: !!el.closest(".sb-group")
      };
    });
    var plan = sbGroupPlan(items);
    if (!plan) return false;
    var frag = document.createDocumentFragment();
    plan.lead.forEach(function (i) { frag.appendChild(kids[i]); });
    plan.groups.forEach(function (g) {
      var title = kids[g.start];
      var grp = document.createElement("div");
      grp.className = "sb-group";
      grp.dataset.sbGroup = (title.textContent || "").trim();
      if (!title.classList.contains("sb-group-head")) {
        title.classList.add("sb-group-head");
        title.setAttribute("role", "button");
        title.setAttribute("tabindex", "0");
        title.setAttribute("aria-label", sbTitleAria(grp.dataset.sbGroup));
        var chev = document.createElement("span");
        chev.className = "sb-chev";
        chev.innerHTML = CHEV;
        title.appendChild(chev);
      }
      g.members.forEach(function (i) { grp.appendChild(kids[i]); });
      frag.appendChild(grp);
    });
    nav.appendChild(frag);
    return true;
  }

  function applyFold() {
    var nodes = document.querySelectorAll(".sb-group");
    var names = Array.prototype.map.call(nodes, function (g) { return g.dataset.sbGroup || ""; });
    var rows = sbFoldRows(loadFolded(), names, SB_DEFAULT_EXPANDED);
    Array.prototype.forEach.call(nodes, function (g, i) { g.classList.toggle("sb-folded", rows[i].folded); });
  }

  function toggle(g) {
    var folded = !g.classList.contains("sb-folded");
    g.classList.toggle("sb-folded", folded);
    saveFolded(sbToggled(loadFolded(), g.dataset.sbGroup || "", !folded));
  }

  // Delegated on the nav, so headings adopted by a later pass are clickable without rebinding.
  function onClick(e) {
    var head = e.target.closest && e.target.closest(".sb-group-head");
    if (!head) return;
    var g = head.closest(".sb-group");
    if (!g) return;
    e.preventDefault();
    e.stopPropagation();
    toggle(g);
  }
  function onKey(e) {
    if (!sbIsToggleKey(e.key)) return;
    var head = e.target.closest && e.target.closest(".sb-group-head");
    if (!head) return;
    e.preventDefault();
    toggle(head.closest(".sb-group"));
  }

  function start() {
    ensureCss();
    wrapAll();
    applyFold();
    var nav = navEl();
    if (nav) {
      nav.addEventListener("click", onClick);
      nav.addEventListener("keydown", onKey);
      // Headings inserted after boot (the conversation list adds its own section) get adopted here.
      new MutationObserver(function (muts) {
        var need = false;
        muts.forEach(function (m) {
          Array.prototype.forEach.call(m.addedNodes || [], function (n) {
            if (n.nodeType === 1 && (n.classList.contains("sidebar-section-title") || n.querySelector && n.querySelector(".sidebar-section-title:not(.sb-group-head)"))) need = true;
          });
        });
        if (!need) return;
        if (wrapAll()) applyFold();
      }).observe(nav, { childList: true });
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
