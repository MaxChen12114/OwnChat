(function () {
/**
 * The right-side panel's mode/view machine — two modes, four views, one persisted record.
 *
 * Fixed mode is a symmetric 240 px column with two text tabs (activity / status). Expanded mode is a
 * resizable 240–1200 px column whose body is the tabbed content canvas; activity and status are
 * temporary overlays you step back out of. Nothing here draws anything: which section is visible, how
 * the bar lays itself out and where the panes live are all `tooling/l0/wiring/panel-host.js`.
 *
 * Two rules that are easy to get wrong and are therefore pure functions here:
 *   · `view` is **not** persisted. The expanded panel always comes back to the canvas; restoring the
 *     last overlay is how "I clicked activity once and now every open starts on activity" happens.
 *   · Width is clamped on both read and write, and `0` means "no opinion" rather than "zero pixels".
 *
 * Tab identity, persistence and the page catalogue moved to `services/panel/tab-state.ts`; this file
 * deliberately knows nothing about what is inside the canvas.
 * @module services/panel/panel-host
 */

                                                                  
                                                      

/** One row of the right column's view list. */
                               
                                                                                      
                                   
                                                                 
                
                                                                           
                
                                                                                        
               
 

/**
 * Every view of the right column, in fixed-tab order. This table is the only place a view is
 * declared: the fixed strip (`#rsTabs`), the expanded bar's `data-pv` buttons and the "⋯" menu all
 * render from it, and `panelKeyOf` / `viewState` derive their view→tab mapping from it too. Adding
 * a view means one row here plus its `<section data-rs-panel>` in index.html.
 *
 * `chat` is the group-chat discussion area: multi-agent output mounts into `#fishbowlSlot` inside
 * that panel. It is permanent — it must NOT become a closable dynamic tab, because the discussion
 * content has nowhere else to render.
 */
const PANEL_VIEWS                          = [
  { id: "activity", tab: "fishbowl", label: "活动", icon: "activity" },
  { id: "chat", tab: "chat", label: "群聊", icon: "chat" },
  { id: "status", tab: "status", label: "状态", icon: "status" },
];

/** The table row for a view name, or null for `canvas` / an unknown name. */
function viewDefOf(view         )                      {
  for (let i = 0; i < PANEL_VIEWS.length; i++) {
    if (PANEL_VIEWS[i].id === view) return PANEL_VIEWS[i];
  }
  return null;
}

                             
                    
                
                  
                
 

const PANEL_VERSION = 1;
const PANEL_LS_STATE = "cfw_panel_state_v1";
const PANEL_LS_CURRENT = "cfw_panel_current_v1";

const PANEL_W_MIN = 240;
/** Raised from 640: at 1440 px the middle column wants ~720, so 640 stranded the drag short. */
const PANEL_W_MAX = 1200;
const PANEL_W_DEFAULT = 460;
const PANEL_DESKTOP_MIN = 1024;
const PANEL_TOPBAR_TIGHT = 560;

const PANEL_DEFAULT_STATE             = { expanded: false, width: PANEL_W_DEFAULT, view: "canvas", tab: "fishbowl" };

function recOf(value         )                          {
  const out                          = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) out[k] = v;
  }
  return out;
}

function text(value         )         {
  return value == null ? "" : typeof value === "string" ? value : String(value);
}

/** `Math.round(w) || default` — a width of 0 means "no opinion", not "zero pixels". */
function clampPanelWidth(w         )         {
  const n = Math.round(Number(w)) || PANEL_W_DEFAULT;
  return Math.max(PANEL_W_MIN, Math.min(PANEL_W_MAX, n));
}

/**
 * Rebuilds the state from the persisted record.
 * @returns the default state when the record is missing or unparseable. `view` always resets to
 * `canvas` — see the module note on why overlays must not be remembered.
 */
function loadPanelState(raw         )             {
  let o                          = {};
  try {
    const parsed          = JSON.parse(text(raw) || "{}");
    o = recOf(parsed);
  } catch (e) {
    return { expanded: false, width: PANEL_W_DEFAULT, view: "canvas", tab: "fishbowl" };
  }
  const width = Math.max(PANEL_W_MIN, Math.min(PANEL_W_MAX, parseInt(text(o.width), 10) || PANEL_W_DEFAULT));
  return {
    expanded: o.expanded === true,
    width: width,
    view: "canvas",
    tab: o.tab === "status" ? "status" : "fishbowl",
  };
}

function isPanelView(name         )                    {
  return name === "canvas" || viewDefOf(name) !== null;
}

/** Maps a tab's `data-rs-tab` to the stored tab, defaulting to the fishbowl (the historical name). */
function tabFromName(name         )           {
  const n = text(name);
  if (n === "chat") return "chat";
  if (n === "status") return "status";
  return "fishbowl";
}

/**
 * View name → the `data-rs-panel` key of the section that renders it. The section keys are the tab
 * names, so the mapping is the view's `tab`; `canvas` is its own section.
 */
function panelKeyOf(view         )         {
  const def = viewDefOf(view);
  return def ? def.tab : "canvas";
}

/** The section that should be visible, given the mode. */
function activeKeyOf(state            , expanded         )         {
  if (expanded) return panelKeyOf(state.view);
  if (state.tab === "status") return "status";
  if (state.tab === "chat") return "chat";
  return "fishbowl";
}

/** @returns a new state; expanding always snaps the view back to the canvas. */
function expandedState(state            , on         )             {
  const next             = { expanded: !!on, width: state.width, view: state.view, tab: state.tab };
  if (next.expanded) next.view = "canvas";
  return next;
}

/**
 * Switches the view.
 * @returns the same state object when the name is not a view — callers rely on identity to skip a
 * re-render. In fixed mode the view also drives which tab is highlighted.
 */
function viewState(state            , name         )             {
  if (!isPanelView(name)) return state;
  const def = viewDefOf(name);
  const next             = { expanded: state.expanded, width: state.width, view: name, tab: state.tab };
  if (!state.expanded) next.tab = def ? def.tab : state.tab;
  return next;
}

function widthState(state            , w         )             {
  return { expanded: state.expanded, width: clampPanelWidth(w), view: state.view, tab: state.tab };
}

function tabState(state            , name         )             {
  const tab = tabFromName(name);
  return {
    expanded: state.expanded,
    width: state.width,
    // In expanded mode the tab picks the overlay; the canvas is not reachable from a tab.
    view: state.expanded ? (tab === "status" ? "status" : "activity") : state.view,
    tab: tab,
  };
}

/** `HH:MM` in local time, for the "recently closed" rows. */
function fmtClock(ts         )         {
  const d = new Date(Number(ts));
  return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
}

/** `stage_call` timeout: default 15 s, clamped to 1–120 s. */
function callTimeoutMs(raw         )         {
  return Math.max(1000, Math.min(120000, parseInt(text(raw), 10) || 15000));
}

// ── Browser wiring (injected by tooling/l0/emit.mjs): binds the service to the frozen window contract name ──
// The right-column tab host. Every decision about *which* tabs exist, what they mount and what
// survives a reload lives in services/panel/tab-state.ts; the mode/view machine lives in
// services/panel/panel-host.ts. This file owns only the DOM: the bar, the tab strip, the "+" menu,
// one pane per tab (created lazily, destroyed on close or when the live-frame cap is hit), the
// visibility pause message, the detached window and the topbar reflow.
(function (global) {
  "use strict";

  var HOST = (global.runtimeCore && global.runtimeCore.host) || null;
  var mounted = false;
  var teardown = [];
  var created = [];

  /** Track one listener; its inverse runs LIFO on dispose. */
  function on(target, type, fn, opts) {
    if (!target || typeof target.addEventListener !== "function") return;
    target.addEventListener(type, fn, opts);
    teardown.push(function () {
      try { target.removeEventListener(type, fn, opts); } catch (e) {}
    });
  }

  /** Track one timer so a dispose cannot leave an apply()/ask() callback behind. */
  function later(fn, ms) {
    var handle = setTimeout(fn, ms);
    teardown.push(function () { try { clearTimeout(handle); } catch (e) {} });
    return handle;
  }

  /** Track an arbitrary inverse (a ResizeObserver, an unsubscribe, a channel close). */
  function manual(fn) {
    if (typeof fn === "function") teardown.push(fn);
  }

  function apply() {
    if (mounted || (global.panelSvc && global.panelSvc.v === 1)) return function () {};
    mounted = true;

  var V = PANEL_VERSION;
  var LS = PANEL_LS_STATE;
  var LS_CUR = PANEL_LS_CURRENT;
  var LS_TABS = PANEL_LS_TABS;
  var W_MIN = PANEL_W_MIN, W_MAX = PANEL_W_MAX, W_DEF = PANEL_W_DEFAULT;
  var DESKTOP_MIN = PANEL_DESKTOP_MIN;
  var LIVE_MAX = PANEL_TAB_LIVE_MAX;

  // Standalone window: the same index.html opened with ?panel=1 takes over as a full-screen
  // overlay and never runs the normal controller.
  var isPanelWindow = false;
  try { isPanelWindow = new URLSearchParams(location.search || "").get("panel") === "1"; } catch (e) {}

  var st = Object.assign({}, PANEL_DEFAULT_STATE);
  var tset = panelTabs.empty();
  var pages = [];
  var els = {};
  var frame = null;
  var listeners = [];
  var idSeq = 0;

  function $(sel, root) { return (root || document).querySelector(sel); }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function isDesktop() {
    try { return global.innerWidth >= DESKTOP_MIN; } catch (e) { return true; }
  }

  function origin() {
    try { return location.origin || ""; } catch (e) { return ""; }
  }

  function readLs(key) {
    try { return localStorage.getItem(key) || ""; } catch (e) { return ""; }
  }

  function writeLs(key, value) {
    try { localStorage.setItem(key, value); } catch (e) {}
  }

  function geoMapUrl() { return readLs(PANEL_MAP_URL_KEY).trim(); }

  // Capability bits for `requires` in tool.json. Only what the page itself can know; an unknown
  // required bit simply keeps the page out instead of mounting something half-broken.
  function caps() {
    return {
      panel: true,
      tauri: !!(global.tauriSvc && global.tauriSvc.has()) ||
        !!(global.top && global.top.tauriSvc && global.top.tauriSvc.has()),
      unlocked: readLs("cfw_unlocked_v1") === "1",
      pcEnabled: readLs("cfw_pc_enabled_v1") === "1",
      pcBridge: false,
      localExec: false,
      sourceServer: false,
      multiAgent: true,
    };
  }

  // Single scan of #toolsPageCatalog: the left sidebar's renderer publishes `window.toolCatalog`;
  // falling back to the raw block keeps the panel working if that script has not run yet.
  function catalogEntries() {
    if (global.toolCatalog && typeof global.toolCatalog.entries === "function") {
      try { return global.toolCatalog.entries(); } catch (e) {}
    }
    var raw = document.getElementById("toolsPageCatalog");
    if (!raw) return [];
    var parsed = parseCatalog(raw.textContent || "");
    return parsed;
  }

  function buildPages() {
    var fromCatalog = panelTabs.pagesFromCatalog(catalogEntries(), caps());
    var host = panelTabs.hostPages({ geoUrl: geoMapUrl(), views: global.sandboxViews });
    return panelTabs.mergePages(fromCatalog, host);
  }

  function pageOfId(id) { return global.panelTabs ? panelTabs.findPageById(id, pages) : null; }

  // Icons are a catalogue string -> SVG path table (services/ui/tools-pages.ts, one table for both
  // sidebars). An unknown icon key falls back to the neutral square rather than dropping the tab.
  function iconSvg(name) {
    var open = typeof SVG_OPEN === "string"
      ? SVG_OPEN
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
    var table = typeof ICON_PATHS === "object" && ICON_PATHS ? ICON_PATHS : {};
    var fallback = typeof FALLBACK_ICON_PATH === "string"
      ? FALLBACK_ICON_PATH
      : '<rect x="4" y="4" width="16" height="16" rx="3"/>';
    var key = String(name || "");
    return open + (Object.prototype.hasOwnProperty.call(table, key) ? table[key] : fallback) + "</svg>";
  }

  function load() {
    st = loadPanelState(readLs(LS));
    pages = buildPages();
    tset = panelTabs.deserialize(readLs(LS_TABS), pages, { origin: origin(), now: Date.now() });
  }

  function save() { writeLs(LS, JSON.stringify(st)); }
  function saveTabs() { writeLs(LS_TABS, panelTabs.serialize(tset)); }

  function emit(type, data) {
    var ev = { type: type, data: data || {} };
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](ev); } catch (e) {}
    }
  }

  // ---------- DOM assembly ----------
  // The expanded bar's view buttons. Generated from PANEL_VIEWS so the bar, the fixed strip and the
  // "⋯" menu cannot disagree about which views exist (a hardcoded list here was one of the four
  // copies that had to be edited to add a view).
  function viewBarButtons() {
    return PANEL_VIEWS.map(function (entry) {
      return '<button class="pbtn" type="button" data-pv="' + esc(entry.id) + '" title="' +
        esc(entry.label + "（再点一次回画布）") + '">' + iconSvg(entry.icon) + "</button>";
    }).join("");
  }

  function buildBar() {
    var header = $("#rightSidebar .rs-header");
    if (!header) return null;
    var bar = document.createElement("div");
    // The tab strip owns content navigation, so the bar keeps only the panel-level switches:
    // 活动 / 群聊 / 状态 + 拉出 + 收起. The old page-shortcut row, the "内容" title dropdown and
    // the "..." menu were duplicates of the tab strip and are gone.
    bar.className = "pbar";
    bar.id = "panelBar";
    bar.hidden = true;
    bar.innerHTML =
      '<span class="pbar-acts">' +
        viewBarButtons() +
        '<button class="pbtn" type="button" data-pa="pop" title="把当前标签拉出为独立窗口">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 5h5v5M19 5l-8 8"/><path d="M19 14v5H5V5h5"/></svg></button>' +
        '<button class="pbtn pbtn-close" type="button" data-pa="close" title="收起面板">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' +
      '</span>';
    header.appendChild(bar);
    created.push(bar);
    return bar;
  }

  function buildCanvas() {
    var body = $("#rightSidebar .rs-body");
    if (!body) return null;
    var sec = document.createElement("section");
    sec.className = "rs-panel rs-canvas";
    sec.setAttribute("data-rs-panel", "canvas");
    sec.setAttribute("role", "tabpanel");

    // Tab strip: horizontal scroll on the left, "+" on the right. The menu drops from the "+".
    var strip = document.createElement("div");
    strip.className = "ptab-strip";
    strip.id = "panelTabStrip";
    strip.innerHTML =
      '<div class="ptab-scroll" id="panelTabScroll" role="tablist" aria-label="内容标签"></div>' +
      '<button class="ptab-add" id="panelTabAdd" type="button" title="打开页面">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>' +
      '<div class="pbar-menu ptab-menu" id="panelTabMenu" hidden></div>';

    var chrome = document.createElement("div");
    chrome.className = "chrome-bar";
    chrome.id = "panelChrome";
    chrome.hidden = true;

    var box = document.createElement("div");
    box.className = "pframe-box";
    box.id = "panelCanvasBox";
    // Empty state: says what this area is for when no tab is open.
    var empty = document.createElement("div");
    empty.className = "pframe-empty";
    empty.innerHTML =
      '<div class="pframe-empty-t">还没有打开内容</div>' +
      '<div class="pframe-empty-d">点上方 + 选一个页面，或让 agent 在对话里打开内容；<br>每个页面都是一个标签，切走会暂停。</div>';
    box.appendChild(empty);

    sec.appendChild(strip);
    sec.appendChild(chrome);
    sec.appendChild(box);
    body.appendChild(sec);
    created.push(sec);
    return sec;
  }

  // ---------- Pane management ----------
  function paneEl(id) {
    if (!els.canvasBox) return null;
    return els.canvasBox.querySelector('.ptab-pane[data-tab-id="' + String(id).replace(/"/g, "") + '"]');
  }

  function createPane(tab) {
    var pane = document.createElement("div");
    pane.className = "ptab-pane";
    pane.setAttribute("data-tab-id", tab.id);
    pane.hidden = true;
    els.canvasBox.appendChild(pane);
    return pane;
  }

  function mountPane(pane, tab) {
    if (!frame || !pane || !tab) return null;
    var c = panelTabs.contentOf(tab, pages);
    var spec = { title: c.title || tab.title, mode: c.mode };
    if (c.url) spec.url = c.url;
    if (c.html) spec.html = c.html;
    if (c.text) spec.text = c.text;
    pane.dataset.chrome = c.chrome || "";
    return frame.mount(pane, spec);
  }

  function destroyPane(id) {
    var pane = paneEl(id);
    if (!pane) return;
    if (frame) frame.unmount(pane);
    try { pane.parentNode.removeChild(pane); } catch (e) {}
  }

  function mountedIds() {
    var out = [];
    if (!els.canvasBox) return out;
    var panes = els.canvasBox.querySelectorAll(".ptab-pane");
    for (var i = 0; i < panes.length; i++) {
      if (frame && frame.current(panes[i])) out.push(panes[i].getAttribute("data-tab-id"));
    }
    return out;
  }

  // Keep the live-frame count bounded. A page that ignores the pause message still costs one frame
  // per tab, so the host tears the oldest background pane down; the tab record stays and remounts
  // on its next activation.
  function trimLive() {
    var victims = panelTabs.liveToDestroy(tset, mountedIds(), LIVE_MAX);
    for (var i = 0; i < victims.length; i++) destroyPane(victims[i]);
  }

  // Push the active tab into the DOM. Panes are created on first activation; background panes stay
  // mounted but hidden and are sent the visibility pause. A tab that only exists in the strip has
  // no iframe yet — that is the lazy-create rule, not a bug.
  function syncPanes() {
    if (!els.canvasBox) return;
    var canvasVisible = st.expanded && st.view === "canvas";
    var activeId = tset.activeId;

    var panes = els.canvasBox.querySelectorAll(".ptab-pane");
    for (var p = 0; p < panes.length; p++) {
      var paneId = panes[p].getAttribute("data-tab-id");
      if (!panelTabs.byId(tset, paneId)) destroyPane(paneId);
    }

    for (var i = 0; i < tset.tabs.length; i++) {
      var tab = tset.tabs[i];
      var on = canvasVisible && tab.id === activeId;
      var pane = paneEl(tab.id);
      if (on && !pane) pane = createPane(tab);
      if (!pane) continue;
      if (on && frame && !frame.current(pane)) mountPane(pane, tab);
      pane.hidden = !on;
      if (frame) {
        frame.setVisible(pane, on);
        if (on) frame.resize(pane);
      }
    }

    trimLive();
    updateEmptyState();
    updateChrome();
  }

  function ensurePaneFor(tab) {
    if (!els.canvasBox || !tab) return null;
    var pane = paneEl(tab.id) || createPane(tab);
    if (frame && !frame.current(pane)) {
      mountPane(pane, tab);
      // A call may target a background tab while the panel is collapsed: mount it paused so a page
      // that starts its own animation loop does not keep running off screen.
      if (frame && pane.hidden) frame.setVisible(pane, false);
    }
    return pane;
  }

  function updateEmptyState() {
    if (!els.canvasBox) return;
    els.canvasBox.classList.toggle("has-content", tset.tabs.length > 0);
  }

  // ---------- Tab strip ----------
  function renderTabStrip() {
    if (!els.strip) return;
    els.strip.innerHTML = tset.tabs.map(function (tab) {
      var on = tab.id === tset.activeId;
      return '<span class="ptab' + (on ? " on" : "") + '" data-ptab="' + esc(tab.id) + '" role="tab" aria-selected="' + (on ? "true" : "false") + '">' +
        '<button class="ptab-main" type="button" title="' + esc(tab.title) + '">' +
          iconSvg(tab.icon) + '<span class="ptab-t">' + esc(tab.title) + "</span></button>" +
        '<button class="ptab-x" type="button" data-ptab-close="' + esc(tab.id) + '" title="关闭标签" aria-label="关闭标签">×</button>' +
        "</span>";
    }).join("");
    var on = els.strip.querySelector(".ptab.on");
    if (on && on.scrollIntoView) {
      try { on.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (e) {}
    }
  }

  function renderTabMenu() {
    var menu = $("#panelTabMenu");
    if (!menu) return;
    var openRows = pages.map(function (p) {
      var missing = !p.href;
      return '<button class="pmenu-item' + (missing ? " is-off" : "") + '" type="button" data-page="' + esc(p.id) + '"' +
        (missing ? ' title="未配置地址，点开会给启动引导"' : "") + ">" +
        '<span class="pmenu-ico">' + iconSvg(p.icon) + "</span>" +
        '<span class="pmenu-t">' + esc(p.label || p.id) + "</span>" +
        (missing ? '<span class="pmenu-time">未配置</span>' : "") + "</button>";
    }).join("");
    var closedRows = tset.closed.map(function (c, i) {
      return '<button class="pmenu-item" type="button" data-closed="' + i + '">' +
        '<span class="pmenu-ico">' + iconSvg(c.icon) + "</span>" +
        '<span class="pmenu-t">' + esc(c.title || c.url) + "</span>" +
        '<span class="pmenu-time">' + esc(fmtClock(c.at)) + "</span></button>";
    }).join("");
    menu.innerHTML = '<div class="pmenu-sec">打开页面</div>' + openRows +
      (closedRows ? '<div class="pmenu-sec">最近关闭</div>' + closedRows : "");
  }

  function reopenClosed(index) {
    var c = tset.closed[index];
    if (!c) return;
    var req = c.pageId ? { pageId: c.pageId, title: c.title } : { url: c.url, title: c.title };
    open(req);
    tset = panelTabs.forgetClosed(tset, c.pageId || c.url);
    saveTabs();
  }

  // ---------- Chrome bar (page-owned definitions) ----------
  // tool.json's `chrome` string says "this page owns a chrome bar"; the page then sends the buttons
  // over `{__panel:1,type:"chrome",data:{items}}`. No definitions are hardcoded in the host.
  function chromeItemHtml(item) {
    if (!item || typeof item !== "object") return "";
    if (item.type === "seg" && Array.isArray(item.items)) {
      return '<span class="seg">' + item.items.map(function (b) {
        return '<button type="button" data-cmd="' + esc(b.cmd) + '" data-val="' + esc(b.val) + '">' + esc(b.text) + "</button>";
      }).join("") + "</span>";
    }
    return '<button type="button" data-cmd="' + esc(item.cmd) + '"' +
      (item.toggle ? ' class="tgl on" data-tgl="1"' : "") + ">" + esc(item.text) + "</button>";
  }

  function setChromeItems(items) {
    var bar = $("#panelChrome");
    if (!bar) return;
    var tab = panelTabs.active(tset);
    var content = tab ? panelTabs.contentOf(tab, pages) : null;
    if (!content || !content.chrome || !Array.isArray(items) || items.length === 0) {
      bar.hidden = true;
      bar.innerHTML = "";
      return;
    }
    bar.hidden = false;
    bar.innerHTML = items.map(chromeItemHtml).join("");
  }

  function updateChrome() {
    var bar = $("#panelChrome");
    if (!bar) return;
    var tab = panelTabs.active(tset);
    var content = tab ? panelTabs.contentOf(tab, pages) : null;
    var kind = content && content.chrome ? content.chrome : "";
    // A different page owns the bar: drop the previous page's buttons. The new page declares its
    // own through the `chrome` message; until then the bar stays hidden instead of flashing empty.
    if (bar.getAttribute("data-chrome") !== kind) {
      bar.hidden = true;
      bar.innerHTML = "";
      bar.setAttribute("data-chrome", kind);
    }
  }

  function bindChrome() {
    var bar = $("#panelChrome");
    if (!bar) return;
    on(bar, "click", function (e) {
      var b = e.target.closest ? e.target.closest("button[data-cmd]") : null;
      if (!b) return;
      var cmd = b.getAttribute("data-cmd");
      var payload = { name: cmd };
      if (b.hasAttribute("data-tgl")) {
        var on = !b.classList.contains("on");
        b.classList.toggle("on", on);
        payload.value = on;
      } else if (b.hasAttribute("data-val")) {
        payload.value = b.getAttribute("data-val");
      }
      var tab = panelTabs.active(tset);
      var pane = tab ? paneEl(tab.id) : null;
      if (pane && frame) frame.post(pane, { __panel: 1, type: "command", data: payload });
    });
  }

  // The page reports state; reconcile the chrome buttons with it.
  function onFrameState(data) {
    var bar = $("#panelChrome");
    if (!bar || !data) return;
    if (data.skin) {
      var btns = bar.querySelectorAll('button[data-cmd="skin"]');
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle("on", btns[i].getAttribute("data-val") === data.skin);
      }
    }
    if (typeof data.running === "boolean") {
      var r = bar.querySelector('button[data-cmd="run"]');
      if (r) r.classList.toggle("on", data.running);
    }
  }

  // ---------- Canvas callbacks: host -> one tab's page ----------
  // Why it exists: stage_open could only open a page and the page was read-only afterwards.
  // A page registers window.__stage = { fn: (args) => result } and stage_call({fn,args,id}) reaches
  // it. Only function NAMES are accepted, never code strings.
  var _callSeq = 1;
  var _callPending = {};

  function callPage(fn, args, timeoutMs, id) {
    var name = String(fn || "").trim();
    if (!name) return Promise.reject(new Error("stage_call 需要 fn（画布页注册的函数名）"));
    if (!frame || !els.canvasBox) return Promise.reject(new Error("右栏画布还没就绪"));
    var tab = id ? panelTabs.byId(tset, id) : panelTabs.active(tset);
    if (!tab) return Promise.reject(new Error("画布是空的 —— 先用 stage_open 打开一个页面"));
    var pane = ensurePaneFor(tab);
    if (!pane) return Promise.reject(new Error("画布是空的 —— 先用 stage_open 打开一个页面"));
    var ms = callTimeoutMs(timeoutMs);
    var callId = "c" + (_callSeq++);
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        delete _callPending[callId];
        reject(new Error("画布没有回应 " + name + "（" + Math.round(ms / 1000) + " 秒）。" +
          "常见原因：这个页面没注册 window.__stage，或者函数名不在里面"));
      }, ms);
      _callPending[callId] = { resolve: resolve, reject: reject, fn: name, timer: timer };
      var ok = false;
      try { ok = frame.post(pane, { __panel: 1, type: "call", data: { id: callId, fn: name, args: args } }); } catch (e) {}
      if (!ok) {
        clearTimeout(timer); delete _callPending[callId];
        reject(new Error("调用发不出去（画布页可能已经卸载）"));
      }
    });
  }

  function onCallResult(data) {
    if (!data || !data.id) return;
    var p = _callPending[data.id];
    if (!p) return;
    clearTimeout(p.timer);
    delete _callPending[data.id];
    if (data.ok) p.resolve(data.result);
    else p.reject(new Error(String(data.error || ("画布页执行 " + p.fn + " 失败"))));
  }

  // The bar keeps a fixed set of view switches; no width-dependent "..." collapsing is needed now
  // that the page shortcuts and title dropdown are gone.
  function bindBar(bar) {
    on(bar, "click", function (e) {
      var t = e.target.closest ? e.target.closest("button") : null;
      if (!t) return;
      var pv = t.getAttribute("data-pv");
      var pa = t.getAttribute("data-pa");
      if (pv) { setView(st.view === pv ? "canvas" : pv); return; }
      if (pa === "pop") { popOut(); return; }
      if (pa === "close") { setExpanded(false); return; }
    });
  }

  function bindTabStrip() {
    var strip = $("#panelTabStrip");
    if (!strip) return;
    on(strip, "click", function (e) {
      var t = e.target;
      var closeBtn = t.closest ? t.closest("[data-ptab-close]") : null;
      if (closeBtn) {
        close(closeBtn.getAttribute("data-ptab-close"));
        return;
      }
      var tabBtn = t.closest ? t.closest("[data-ptab]") : null;
      if (tabBtn) { activate(tabBtn.getAttribute("data-ptab")); return; }
      if (t.closest && t.closest("#panelTabAdd")) { toggleTabMenu(); return; }
    });
    var menu = $("#panelTabMenu");
    if (menu) {
      on(menu, "click", function (e) {
        var t = e.target;
        var pageBtn = t.closest ? t.closest("[data-page]") : null;
        if (pageBtn) { openPage(pageBtn.getAttribute("data-page")); toggleTabMenu(false); return; }
        var closedBtn = t.closest ? t.closest("[data-closed]") : null;
        if (closedBtn) { reopenClosed(parseInt(closedBtn.getAttribute("data-closed"), 10)); toggleTabMenu(false); }
      });
    }
    // A click anywhere outside the strip closes the menu.
    on(document, "click", function (e) {
      var m = $("#panelTabMenu");
      if (!m || m.hidden) return;
      if (e.target.closest && (e.target.closest("#panelTabMenu") || e.target.closest("#panelTabAdd"))) return;
      toggleTabMenu(false);
    });
  }

  // ---------- Views ----------
  function panels() {
    var out = {};
    var list = document.querySelectorAll("#rightSidebar .rs-panel");
    for (var i = 0; i < list.length; i++) {
      out[list[i].getAttribute("data-rs-panel")] = list[i];
    }
    return out;
  }

  function setView(name) {
    var next = viewState(st, name);
    if (next === st) return;
    st = next;
    save();
    apply();
    emit("view", { view: st.view, expanded: st.expanded });
  }

  function setExpanded(on) {
    st = expandedState(st, on);
    save();
    apply();
    emit("state", { expanded: st.expanded, view: st.view, width: st.width });
  }

  function setWidth(w) {
    st = widthState(st, w);
    save();
    apply();
    if (els.canvasBox && frame) {
      var tab = panelTabs.active(tset);
      var pane = tab ? paneEl(tab.id) : null;
      if (pane) frame.resize(pane);
    }
  }

  // Push the mode/view state into the DOM.
  function apply() {
    var html = document.documentElement;
    var col = $("#rightSidebar");
    if (!col) return;

    var expanded = st.expanded && isDesktop();
    html.classList.toggle("panel-expanded", expanded);
    html.style.setProperty("--panel-w", st.width + "px");
    if (expanded) markNew(false);

    var bar = els.bar;
    if (bar) bar.hidden = !expanded;

    var tabs = $("#rightSidebar .rs-tabs");
    if (tabs) tabs.hidden = expanded;

    var ps = panels();
    var activeKey = activeKeyOf(st, expanded);
    var active = expanded ? st.view : st.tab;
    html.setAttribute("data-panel-view", activeKey);

    Object.keys(ps).forEach(function (k) {
      var el = ps[k];
      if (!el) return;
      var show = (k === activeKey);
      el.hidden = !show;
      el.classList.toggle("active", show);
    });

    if (bar) {
      var btns = bar.querySelectorAll("button[data-pv]");
      for (var i = 0; i < btns.length; i++) {
        var on = expanded && btns[i].getAttribute("data-pv") === active && active !== "canvas";
        btns[i].classList.toggle("active", on);
      }
    }

    syncPanes();
    requestAnimationFrame(refitTopbar);
  }

  // ---------- Tabs ----------
  function openPage(id) {
    var p = pageOfId(id);
    if (!p) return { ok: false, error: "未知页面：" + String(id) };
    return open({ pageId: p.id });
  }

  function open(spec) {
    if (!frame) return { ok: false, error: "panel-frame 未加载" };
    if (!els.canvasBox) return { ok: false, error: "画布未装配" };
    var req = spec || {};
    tset = panelTabs.open(tset, req, pages, { now: Date.now(), origin: origin(), seq: ++idSeq });
    var tab = panelTabs.active(tset);
    if (!tab) return { ok: false, error: "至少给 url / html / text 之一。" };
    saveTabs();
    renderTabStrip();
    if (!st.expanded) {
      // Taking over the user's screen is not the agent's call: while collapsed, only a dot says
      // there is new content. The pane mounts on the first expansion.
      markNew(true);
    } else {
      setView("canvas");
      syncPanes();
    }
    publishCurrent();
    emit("open", { title: tab.title, mode: tab.mode, id: tab.id });
    return { ok: true, mode: tab.mode, title: tab.title, id: tab.id };
  }

  function activate(id) {
    var before = tset;
    tset = panelTabs.activate(tset, id);
    if (tset === before) return false;
    saveTabs();
    renderTabStrip();
    syncPanes();
    publishCurrent();
    emit("tab", { id: tset.activeId });
    return true;
  }

  function close(id) {
    var target = id ? String(id) : tset.activeId;
    if (!target) return { ok: true, id: "" };
    var before = tset;
    tset = panelTabs.close(tset, target, { now: Date.now() });
    if (tset === before) return { ok: false, error: "没有这个标签：" + target };
    destroyPane(target);
    saveTabs();
    renderTabStrip();
    syncPanes();
    publishCurrent();
    emit("close", { id: target });
    return { ok: true, id: target };
  }

  function markNew(on) {
    var btn = $("#panelToggle") || $("#stageToggle");
    if (!btn) return;
    btn.classList.toggle("has-new", !!on);
  }

  // ---------- Menus ----------
  function placeMenu(menu, btn) {
    if (!menu || !btn) return;
    var host = menu.parentNode;
    if (!host) return;
    var b = btn.getBoundingClientRect(), p = host.getBoundingClientRect();
    var w = Math.max(180, Math.min(240, Math.round(p.width - 8)));
    var left = Math.round(b.right - p.left - w);
    left = Math.max(0, Math.min(left, Math.round(p.width - w)));
    menu.style.left = left + "px";
    menu.style.top = Math.round(b.bottom - p.top + 4) + "px";
    menu.style.width = w + "px";
  }

  function toggleTabMenu(force) {
    var menu = $("#panelTabMenu");
    if (!menu) return;
    var show = force === undefined ? menu.hidden : !!force;
    menu.hidden = !show;
    if (show) {
      renderTabMenu();
      placeMenu(menu, $("#panelTabAdd"));
    }
  }

  // ---------- Detached window (BroadcastChannel first, storage events as fallback) ----------
  // Mirrors the ACTIVE tab only. Mirroring the whole tab set would need a second tab strip in the
  // detached window; the owner ruled that cost is not worth it yet.
  var bc = null;
  var popupWin = null;

  function ensureChannel() {
    if (bc) return bc;
    try { bc = new BroadcastChannel("cfw-panel"); } catch (e) { return null; }
    on(bc, "message", function (e) {
      var d = e.data || {};
      if (d.kind === "ask" && !isPanelWindow) publishCurrent();
    });
    return bc;
  }

  function activeSpec() {
    var tab = panelTabs.active(tset);
    if (!tab) return null;
    var c = panelTabs.contentOf(tab, pages);
    var spec = { title: c.title || tab.title, mode: c.mode };
    if (c.url) spec.url = c.url;
    if (c.html) spec.html = c.html;
    if (c.text) spec.text = c.text;
    if (c.chrome) spec.chrome = c.chrome;
    return spec;
  }

  function publishCurrent() {
    if (isPanelWindow) return; // only the main window publishes
    var msg = { kind: "current", spec: activeSpec(), at: Date.now() };
    var ch = ensureChannel();
    if (ch) { try { ch.postMessage(msg); } catch (e) {} }
    try { localStorage.setItem(LS_CUR, JSON.stringify(msg)); } catch (e) {}
  }

  function popOut() {
    // The Tauri webview does not implement window.open (it returns null), so the desktop shell opens
    // a native window through the open_panel_window command. The web keeps window.open.
    var url = location.origin + location.pathname + "?panel=1&t=" + Date.now();
    var invoke = global.tauriSvc ? global.tauriSvc.invokeOrNull() : null;
    if (invoke) {
      invoke("open_panel_window", { url: url }).then(function () {
        publishCurrent();
      }).catch(function () { emit("popup-blocked", {}); });
      return;
    }
    try { popupWin = global.open(url, "ownchat_panel", "width=480,height=780"); } catch (e) { popupWin = null; }
    if (!popupWin) { emit("popup-blocked", {}); return; }
    publishCurrent();
  }

  // Detached-window mode: a full-screen overlay that renders the mirrored tab plus one title bar.
  function bootWindow() {
    document.documentElement.classList.add("panel-window");
    var wrap = document.createElement("div");
    wrap.id = "panelWindow";
    wrap.innerHTML =
      '<div class="pw-bar"><span class="pw-title">内容面板</span>' +
      '<button class="pw-close" type="button" title="关闭窗口">×</button></div>' +
      '<div class="pw-body"><div class="pframe-box" id="panelWinBox"></div></div>';
    document.body.appendChild(wrap);

    var box = wrap.querySelector("#panelWinBox");
    var titleEl = wrap.querySelector(".pw-title");
    var f = global.panelSvcFrame || null;

    on(wrap.querySelector(".pw-close"), "click", function () {
      // In the desktop shell window.close() does nothing to a native window, so the shell command
      // closes it.
      var invoke = global.tauriSvc ? global.tauriSvc.invokeOrNull() : null;
      if (invoke) {
        invoke("close_panel_window").catch(function () { try { global.close(); } catch (e) {} });
        return;
      }
      try { global.close(); } catch (e) {}
    });

    function applySpec(spec) {
      if (!f || !box) return;
      if (!spec) { f.unmount(box); titleEl.textContent = "内容面板"; return; }
      f.mount(box, spec);
      titleEl.textContent = spec.title || (spec.url ? "内容" : "内联内容");
      f.resize(box);
    }

    var ch = ensureChannel();
    if (ch) {
      on(ch, "message", function (e) {
        var d = e.data || {};
        if (d.kind === "current") applySpec(d.spec);
      });
    }
    on(global, "storage", function (e) {
      if (e.key !== LS_CUR || !e.newValue) return;
      try { var o = JSON.parse(e.newValue); if (o && o.kind === "current") applySpec(o.spec); } catch (err) {}
    });

    try {
      var cached = JSON.parse(localStorage.getItem(LS_CUR) || "null");
      if (cached && cached.kind === "current") applySpec(cached.spec);
    } catch (e) {}
    try { if (ch) ch.postMessage({ kind: "ask", at: Date.now() }); } catch (e) {}
    later(function () {
      try { if (ch) ch.postMessage({ kind: "ask", at: Date.now() }); } catch (e) {}
    }, 800);

    on(global, "resize", function () { if (f) f.resize(box); });
    f && f.resize(box);
  }

  // ---------- Topbar adaptation ----------
  var TOPBAR_TIGHT = PANEL_TOPBAR_TIGHT;

  function refitTopbar() {
    var app = document.getElementById("app");
    if (app && document.documentElement.classList.contains("panel-expanded")) {
      var gap = Math.round(global.innerWidth - app.getBoundingClientRect().right);
      document.documentElement.style.setProperty("--panel-actual", Math.max(0, gap) + "px");
    }
    if (!app) return;
    var w = app.getBoundingClientRect().width;
    document.documentElement.classList.toggle("topbar-tight", w > 0 && w < TOPBAR_TIGHT);
  }

  function wireTopbarFit() {
    var app = document.getElementById("app");
    if (!app) return;
    on(global, "resize", function () { requestAnimationFrame(refitTopbar); });
    if (typeof ResizeObserver === "function") {
      try {
        var ro2 = new ResizeObserver(function () { requestAnimationFrame(refitTopbar); });
        ro2.observe(app);
        manual(function () { try { ro2.disconnect(); } catch (e) {} });
      } catch (e) {}
    }
    requestAnimationFrame(refitTopbar);
  }

  // ---------- Drag to resize ----------
  var SEAM_W = 10, HIT_W = 10;

  function bindResize() {
    var col = $("#rightSidebar");
    var shell = document.querySelector(".app-shell");
    if (!col) return;
    var html = document.documentElement;
    var hovered = false;

    function inBand(clientX) {
      if (!st.expanded) return false;
      var left = col.getBoundingClientRect().left;
      return clientX >= left - SEAM_W && clientX <= left + HIT_W;
    }
    function isControl(e) {
      return !!(e.target && e.target.closest &&
        e.target.closest("button, input, select, textarea, a, [contenteditable]"));
    }
    function startDrag(e) {
      e.preventDefault();
      var startX = e.clientX, startW = st.width, moved = false;
      // Pointer events are disabled on every pane while dragging: crossing into an iframe would
      // otherwise stop mousemove on the parent and kill the drag.
      var fs = els.canvasBox ? els.canvasBox.querySelectorAll("iframe") : [];
      var i;
      for (i = 0; i < fs.length; i++) fs[i].style.pointerEvents = "none";
      document.body.style.cursor = "col-resize";
      html.classList.add("panel-resizing");
      function mv(ev) {
        moved = true;
        setWidth(startW + (startX - ev.clientX));
      }
      function up() {
        document.removeEventListener("mousemove", mv);
        document.removeEventListener("mouseup", up);
        for (i = 0; i < fs.length; i++) fs[i].style.pointerEvents = "";
        document.body.style.cursor = "";
        html.classList.remove("panel-resizing");
        if (moved) emit("width", { width: st.width });
      }
      on(document, "mousemove", mv);
      on(document, "mouseup", up);
    }
    function onDown(e) {
      if (isControl(e) || !inBand(e.clientX)) return;
      startDrag(e);
    }
    on(col, "mousedown", onDown);
    if (shell) on(shell, "mousedown", function (e) {
      if (e.target !== shell) return;
      onDown(e);
    });

    on(document, "mousemove", function (e) {
      var on = inBand(e.clientX);
      if (on === hovered) return;
      hovered = on;
      col.classList.toggle("seam-hover", on);
    });
    on(document, "dblclick", function (e) {
      if (isControl(e) || !inBand(e.clientX)) return;
      setWidth(W_DEF);
      emit("width", { width: W_DEF });
    });
  }

  // ---------- Topbar toggle ----------
  function bindToggle() {
    var btn = $("#stageToggle") || $("#panelToggle");
    if (!btn) return;
    on(btn, "click", function () { setExpanded(!st.expanded); });
  }

  // ---------- Pinned tab switching (activity / chat / status) ----------
  // The fixed strip is rendered from PANEL_VIEWS; index.html ships an empty `#rsTabs` container.
  // It lives here (not in the page) so the three views are declared exactly once, in the service.
  // Must run before bindTabs() and before boot()'s `st.tab` lookup below.
  // services/ui/right-sidebar-tabs.js loads ~170 manifest rows earlier and resolves `.rs-tab` on
  // every use (`readTabs`), so its three automatic switches (boot pass / console mount / topbar
  // multi-agent) see this strip once it is rendered. They call `panelSvc.chooseTab` so the highlight
  // and the visible panel move together; a tab click stays owned here, with its persisted state.
  function renderFixedTabs() {
    var box = document.getElementById("rsTabs") || $("#rightSidebar .rs-tabs");
    if (!box) return;
    box.innerHTML = PANEL_VIEWS.map(function (entry) {
      var on = entry.tab === st.tab;
      return '<button class="rs-tab' + (on ? " active" : "") + '" data-rs-tab="' + esc(entry.tab) + '"' +
        ' role="tab" aria-selected="' + (on ? "true" : "false") + '" type="button">' +
        iconSvg(entry.icon) + "<span>" + esc(entry.label) + "</span>" +
        '<span class="rs-dot" aria-hidden="true"></span></button>';
    }).join("");
  }

  // Fixed-mode selection: one body for a strip click and for the strip's own automatic moves
  // (boot pass / console mount / topbar button, services/ui/right-sidebar-tabs.js). Keeping the
  // state machine here is what makes the highlight and the visible panel agree — when the two
  // modules each painted their own copy, the next apply() re-showed the old panel under a new tab.
  // `persist:false` keeps an automatic move out of localStorage: a reload must land on the tab the
  // user picked, not on the one the boot pass guessed.
  function selectTab(name, opts) {
    var persist = !(opts && opts.persist === false);
    st = tabState(st, name);
    if (persist) save();
    apply();
    var all = document.querySelectorAll("#rightSidebar .rs-tab");
    for (var i = 0; i < all.length; i++) {
      var on = all[i].getAttribute("data-rs-tab") === st.tab;
      all[i].classList.toggle("active", on);
      all[i].setAttribute("aria-selected", on ? "true" : "false");
      // Looking at a tab clears its unread dot. The rule (`clearActivity`) is owned by
      // services/ui/right-sidebar-tabs.ts; that module's own clear only reaches the buttons it
      // snapshotted, which are none — this strip is rendered from PANEL_VIEWS.
      if (on) all[i].classList.remove("has-activity");
    }
    if (persist) emit("tab", { tab: st.tab });
  }

  function bindTabs() {
    var tabs = document.querySelectorAll("#rightSidebar .rs-tab");
    if (!tabs.length) return;
    for (var i = 0; i < tabs.length; i++) {
      on(tabs[i], "click", function () {
        selectTab(this.getAttribute("data-rs-tab"));
      });
    }
  }

  // Settings changed a URL: rebuild pages, keep tabs (page-backed tabs re-resolve at mount). The
  // active pane is torn down so a sandbox guide → real URL switch takes effect immediately.
  function refreshPages() {
    pages = buildPages();
    if (tset.activeId) destroyPane(tset.activeId);
    renderTabStrip();
    syncPanes();
  }

  function boot() {
    load();
    // Before the mode gates: the strip markup belongs to the page, not to the desktop layout, and a
    // narrow window that grows later must not find an empty column.
    renderFixedTabs();
    if (isPanelWindow) { bootWindow(); return; }
    if (!isDesktop()) return;
    wireTopbarFit();
    els.bar = buildBar();
    els.canvas = buildCanvas();
    els.canvasBox = $("#panelCanvasBox");
    els.strip = $("#panelTabScroll");
    frame = global.panelSvcFrame || null;
    if (frame && typeof frame.on === "function") {
      frame.on(function (ev) {
        if (!ev) return;
        if (ev.type === "state") onFrameState(ev.data);
        else if (ev.type === "call-result") onCallResult(ev.data);
        else if (ev.type === "chrome") setChromeItems(ev.data && ev.data.items);
      });
    }
    if (els.bar) bindBar(els.bar);
    bindChrome();
    bindTabStrip();
    bindResize();
    bindToggle();
    bindTabs();
    on(global, "panel:config-changed", refreshPages);
    var cur = document.querySelector('#rightSidebar .rs-tab[data-rs-tab="' + st.tab + '"]');
    if (cur) {
      var all = document.querySelectorAll("#rightSidebar .rs-tab");
      for (var i = 0; i < all.length; i++) {
        var isCurrent = all[i] === cur;
        all[i].classList.toggle("active", isCurrent);
        all[i].setAttribute("aria-selected", isCurrent ? "true" : "false");
      }
    }
    renderTabStrip();
    apply();
    requestAnimationFrame(function () { try { apply(); } catch (e) {} });
    later(function () { try { apply(); } catch (e) {} }, 250);
  }

  var api = {
    v: V,
    // Content API. `open` keeps the pre-tab contract: it creates/focuses a tab and returns the
    // active tab's mode/title. `openPage` addresses a catalog page by id.
    open: open,
    openPage: openPage,
    close: close,
    activate: activate,
    view: setView,
    // Fixed-tab selection for the strip's automatic moves (services/ui/right-sidebar-tabs.js):
    // adopts the tab in the same state machine a click uses, without persisting it. Ignored while
    // expanded — the fixed strip is off screen there, and re-selecting a tab would swap the canvas
    // for an overlay the user never asked for.
    chooseTab: function (name) {
      if (st.expanded) return;
      selectTab(name, { persist: false });
    },
    state: function () {
      var tab = panelTabs.active(tset);
      return {
        expanded: st.expanded, width: st.width, view: st.view, tab: st.tab,
        hasContent: tset.tabs.length > 0,
        activeId: tset.activeId,
        title: tab ? tab.title : "",
        tabs: tset.tabs.map(function (t) {
          return { id: t.id, title: t.title, pageId: t.pageId, icon: t.icon, active: t.id === tset.activeId };
        }),
        catalog: pages.map(function (p) {
          return { id: p.id, title: p.label, url: p.href || "", icon: p.icon || "", chrome: p.chrome || "" };
        }),
      };
    },
    on: function (fn) {
      if (typeof fn !== "function") return function () {};
      listeners.push(fn);
      return function () {
        var i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    // Call a function on one tab's page (active by default); the agent's stage_call lands here.
    call: callPage,
    // Re-read tool.json + the two URL settings without a reload.
    refresh: refreshPages,
    // Panel-open control, so a launcher can reveal what it just opened.
    expand: function () { setExpanded(true); },
    collapse: function () { setExpanded(false); },
    // Internal / debug (not a contract).
    _toggle: function () { setExpanded(!st.expanded); },
    _width: setWidth,
    _apply: apply,
    tools: function () {
      return pages.map(function (p) {
        return { id: p.id, title: p.label, url: p.href || "", icon: p.icon || "", chrome: p.chrome || "" };
      });
    }
  };

    global.panelSvc = api;

    // A boot failure must not leave the façade behind without an inverse: the kernel would mark the
    // plugin "error" and the global would survive every subsequent remount.
    try {
      if (document.readyState === "loading") on(document, "DOMContentLoaded", boot);
      else boot();
    } catch (e) {
      try { console.warn("[panel] 启动失败（卸载仍可执行）", e); } catch (_e) {}
    }

    return function dispose() {
      for (var i = teardown.length - 1; i >= 0; i--) {
        try { teardown[i](); } catch (e) {}
      }
      teardown.length = 0;
      // Pane unmounts go through the frame host so its own window listeners go with them.
      try {
        if (els.canvasBox) {
          var panes = els.canvasBox.querySelectorAll(".ptab-pane");
          for (var p = 0; p < panes.length; p++) {
            try { if (frame) frame.unmount(panes[p]); } catch (e) {}
          }
        }
      } catch (e) {}
      for (var c = created.length - 1; c >= 0; c--) {
        try { if (created[c] && created[c].parentNode) created[c].parentNode.removeChild(created[c]); } catch (e) {}
      }
      created.length = 0;
      try { document.documentElement.classList.remove("panel-window", "panel-resizing"); } catch (e) {}
      try { if (bc) bc.close(); } catch (e) {}
      bc = null;
      if (global.panelSvc === api) {
        try { delete global.panelSvc; } catch (e) { global.panelSvc = undefined; }
      }
      mounted = false;
    };
  }

  // Read-only bridge for the equivalence lock (and for debugging): the fixed view table is the
  // single source, so the test reads the emitted artifact instead of re-declaring the list.
  try { global.PANEL_VIEWS = PANEL_VIEWS; } catch (e) {}

  var mod = { name: "panel-host", inject: ["db", "transport"], apply: apply };
  if (HOST) {
    HOST.define("panel-host", mod);
    HOST.start("panel-host");
    return;
  }
  apply({ get: function () { return null; } });
})(window);

globalThis.PANEL_VIEWS = PANEL_VIEWS;
globalThis.PANEL_VERSION = PANEL_VERSION;
globalThis.PANEL_LS_STATE = PANEL_LS_STATE;
globalThis.PANEL_LS_CURRENT = PANEL_LS_CURRENT;
globalThis.PANEL_W_MIN = PANEL_W_MIN;
globalThis.PANEL_W_MAX = PANEL_W_MAX;
globalThis.PANEL_W_DEFAULT = PANEL_W_DEFAULT;
globalThis.PANEL_DESKTOP_MIN = PANEL_DESKTOP_MIN;
globalThis.PANEL_TOPBAR_TIGHT = PANEL_TOPBAR_TIGHT;
globalThis.PANEL_DEFAULT_STATE = PANEL_DEFAULT_STATE;
globalThis.clampPanelWidth = clampPanelWidth;
globalThis.loadPanelState = loadPanelState;
globalThis.isPanelView = isPanelView;
globalThis.tabFromName = tabFromName;
globalThis.panelKeyOf = panelKeyOf;
globalThis.activeKeyOf = activeKeyOf;
globalThis.expandedState = expandedState;
globalThis.viewState = viewState;
globalThis.widthState = widthState;
globalThis.tabState = tabState;
globalThis.fmtClock = fmtClock;
globalThis.callTimeoutMs = callTimeoutMs;
})();
