(function () {
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
const SB_LS_FOLDED = "cfw_sidebar_folded_v1";

/** Groups expanded on a first run, when the stored map has no entry for them. */
const SB_DEFAULT_EXPANDED = ["模式", "对话"];

/** One nav child as the planner sees it: its role and whether a previous pass already adopted it. */
                            
                                                                          
                 
                                                                                             
                   
 

/** One group to build: the title that heads it plus the children that move into it. */
                               
                                                             
                
                                                             
                    
 

/** What one wrap pass should do, expressed in indices of the scanned child list. */
                         
                                                                         
                 
                                             
                         
 

/**
 * Plan one wrap pass over the nav children.
 *
 * @param items Children in document order, each flagged by {@link SbNavItem}.
 * @returns The indices to keep and the groups to build, or `null` when no ungrouped title exists
 *   (nothing to do — callers use this to skip the repaint entirely).
 */
function sbGroupPlan(items             )                {
  const starts           = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].title && !items[i].grouped) starts.push(i);
  }
  if (!starts.length) return null;

  const lead           = [];
  for (let i = 0; i < starts[0]; i++) {
    if (!items[i].grouped) lead.push(i);
  }

  const groups                 = [];
  for (let n = 0; n < starts.length; n++) {
    const end = n + 1 < starts.length ? starts[n + 1] : items.length;
    const members           = [starts[n]];
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
function sbFoldedOf(
  state                         ,
  name        ,
  defaultExpanded          ,
)          {
  if (name in state) return !!state[name];
  return defaultExpanded.indexOf(name) < 0;
}

/**
 * Resolve the whole nav in one call, aligned with the group nodes the caller holds.
 *
 * @returns One row per name, same order — the caller zips it back onto its node list.
 */
function sbFoldRows(
  state                         ,
  names          ,
  defaultExpanded          ,
)                                      {
  const rows                                      = [];
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
function sbToggled(
  state                         ,
  name        ,
  currentlyFolded         ,
)                          {
  const next                          = {};
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
function sbParseFolded(raw         )                          {
  if (typeof raw !== "string" || raw === "") return {};
  let parsed         ;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out                          = {};
  for (const [k, v] of Object.entries(parsed)) out[k] = v;
  return out;
}

/**
 * Accessible label for a heading, naming the group it folds.
 *
 * @param name Group name; callers pass the trimmed heading text.
 */
function sbTitleAria(name        )         {
  return name + " 分组,点击展开/收起";
}

/** Whether a keydown on a heading should toggle it. Space is the button convention, not Enter only. */
function sbIsToggleKey(key        )          {
  return key === "Enter" || key === " ";
}

// Browser adapter, appended by l0/emit.mjs. Engine: services/ui/sidebar-groups.ts; this file owns
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

globalThis.SB_LS_FOLDED = SB_LS_FOLDED;
globalThis.SB_DEFAULT_EXPANDED = SB_DEFAULT_EXPANDED;
globalThis.sbGroupPlan = sbGroupPlan;
globalThis.sbFoldedOf = sbFoldedOf;
globalThis.sbFoldRows = sbFoldRows;
globalThis.sbToggled = sbToggled;
globalThis.sbParseFolded = sbParseFolded;
globalThis.sbTitleAria = sbTitleAria;
globalThis.sbIsToggleKey = sbIsToggleKey;
})();
