// ── Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name ──
// The state machine — mode/view/tab transitions, width clamping, persisted record, history dedupe,
// built-in page detection, clock and icons — moved to services/panel/panel-host.ts. Everything below
// is DOM: building the bar and the canvas section, view switching, drag-to-resize, the two menus, the
// detached window, and the topbar reflow.
(function (global) {
  "use strict";

  if (global.__panel && global.__panel.v === 1) return;

  var V = PANEL_VERSION;
  var LS = PANEL_LS_STATE;
  var LS_CUR = PANEL_LS_CURRENT;
  var W_MIN = PANEL_W_MIN, W_MAX = PANEL_W_MAX, W_DEF = PANEL_W_DEFAULT;
  var DESKTOP_MIN = PANEL_DESKTOP_MIN;

  // Standalone window: the same index.html opened with ?panel=1 takes over as a full-screen
  // overlay and never runs the normal controller.
  var isPanelWindow = false;
  try { isPanelWindow = new URLSearchParams(location.search || "").get("panel") === "1"; } catch (e) {}

  var st = Object.assign({}, PANEL_DEFAULT_STATE);
  var els = {};
  var frame = null;
  var listeners = [];

  function $(sel, root) { return (root || document).querySelector(sel); }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function isDesktop() {
    try { return global.innerWidth >= DESKTOP_MIN; } catch (e) { return true; }
  }

  function load() {
    var raw = null;
    try { raw = localStorage.getItem(LS); } catch (e) {}
    // Views are not persisted, the width is clamped at both ends and the tab whitelist applies —
    // all three live in loadPanelState, one implementation.
    st = loadPanelState(raw);
  }

  function save() {
    try { localStorage.setItem(LS, JSON.stringify(st)); } catch (e) {}
  }

  function emit(type, data) {
    var ev = { type: type, data: data || {} };
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](ev); } catch (e) {}
    }
  }

  // ---------- DOM assembly (built here; index.html keeps only the topbar button) ----------
  // ---------- Tool slots, not a content list ----------
  // Two tools with different standing:
  //   sandbox  our own sandbox (procedural fantasy map, zero dependencies) — always available
  //   map      the GEO map (real map, external source) — connects only once an address is set;
  //            unconfigured, it opens a setup page
  // Content (artifacts, reports, pages) is always mounted by the agent through open(); it never
  // lands here.
  var LS_MAP_URL = PANEL_LS_MAP_URL;

  function geoMapUrl() {
    try { return String(localStorage.getItem(LS_MAP_URL) || "").trim(); } catch (e) { return ""; }
  }

  var BUILTIN_TOOLS = PANEL_BUILTIN_TOOLS;
  var tools = [];

  function openTool(t) {
    if (t.id === "map") {
      var u = geoMapUrl();
      if (!u) { open({ html: geoGuideHtml(), title: "GEO 地图", _builtin: true }); return; }
      open({ url: u, title: "GEO 地图", mode: "external", _builtin: true });
      return;
    }
    open({ url: t.url, title: t.title, mode: "trusted", chrome: t.chrome || null, _builtin: true });
  }

  function renderTools() {
    // Wide panel: tools and views sit on the bar. Narrow panel: they collapse into "...".
    // Both channels are rendered — icon buttons on the bar (.pbar-tools), icon+label rows in the
    // menu. Which one is visible is decided by wireBarFit() toggling .pbar-wide, pure CSS.
    var box = $("#panelMoreMenu");
    var inline = els.bar && els.bar.querySelector(".pbar-tools");
    var items = tools.map(function (t) {
      var off = (t.id === "map" && !geoMapUrl());
      return '<button class="pmenu-item' + (off ? " is-off" : "") + '" type="button" data-tool="' + esc(t.id) + '"' +
        (off ? ' title="未配置 GEO 地图地址，点开会给引导"' : "") + ">" +
        '<span class="pmenu-ico">' + toolIcon(t.icon) + "</span>" +
        '<span class="pmenu-t">' + esc(t.title || t.id) + "</span></button>";
    }).join("");
    var VIEWS = [{ pv: "chat", t: "群聊" }, { pv: "activity", t: "活动" }, { pv: "status", t: "状态" }];
    var views = VIEWS.map(function (v) {
      var on = st.view === v.pv;
      return '<button class="pmenu-item' + (on ? " on" : "") + '" type="button" data-menu-pv="' + v.pv + '">' +
        '<span class="pmenu-t">' + v.t + "</span>" +
        '<span class="pmenu-time">' + (on ? "当前" : "") + "</span></button>";
    }).join("");
    // No group headings in the menu (neither "Open" nor "View"): list the entries directly.
    if (box) box.innerHTML = items + views;
    if (inline) {
      inline.innerHTML = tools.map(function (t) {
        var off = (t.id === "map" && !geoMapUrl());
        return '<button class="pbtn pbtn-tool' + (off ? " pbtn-off" : "") + '" type="button" data-tool="' + esc(t.id) + '"' +
          ' title="' + esc(t.title || t.id) + '">' + toolIcon(t.icon) + "</button>";
      }).join("");
    }
  }

  function registerTool(def) {
    // url may be empty: an external tool (the GEO map) still needs a slot before it is configured,
    // and openTool shows the setup page when it is clicked.
    if (!def || !def.id) return false;
    for (var i = 0; i < tools.length; i++) {
      if (tools[i].id === def.id) { tools[i] = def; renderTools(); return true; }
    }
    tools.push(def);
    renderTools();
    return true;
  }

  function buildBar() {
    var header = $("#rightSidebar .rs-header");
    if (!header) return null;
    var bar = document.createElement("div");
    // The bar keeps only [Content v][...][Pop out][Close]. Tools (sandbox, council, GEO) and view
    // switches (group chat, activity, status) all live in the "..." menu. "Content v" returns to
    // its job: the recently produced artifacts, nothing else.
    bar.className = "pbar pbar-plain-title";
    bar.id = "panelBar";
    bar.hidden = true;
    bar.innerHTML =
      // Narrow panel: only [...][Content v][Pop out][Close]. Wide panel: tools and views move back
      // out of the menu onto the bar.
      '<button class="pbtn" type="button" id="panelMoreBtn" title="工具与视图">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.35" fill="currentColor" stroke="none"/></svg></button>' +
      '<span class="pbar-tools"></span>' +
      '<button class="pbar-title" id="panelTitleBtn" type="button" title="切换最近生成的内容">' +
        '<span class="pbar-title-tx" id="panelTitle"></span>' +
        '<svg class="pbar-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 10l5 5 5-5"/></svg>' +
      '</button>' +
      '<span class="pbar-acts">' +
        '<button class="pbtn" type="button" data-pv="chat" title="群聊（再点一次回画布）">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5.5h11a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H8l-3.5 2.5V14.5H4A1.5 1.5 0 0 1 2.5 13V7A1.5 1.5 0 0 1 4 5.5z"/><path d="M17 8.5h3A1.5 1.5 0 0 1 21.5 10v5.5a1.5 1.5 0 0 1-1.5 1.5h-.5v2.5L16 17.5h-3"/></svg></button>' +
        '<button class="pbtn" type="button" data-pv="activity" title="活动（再点一次回画布）">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h4l2.5-6 4 12 2.5-6h5"/></svg></button>' +
        '<button class="pbtn" type="button" data-pv="status" title="状态（再点一次回画布）">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5h16M7.5 19.5V14M12 19.5V6.5M16.5 19.5V11"/></svg></button>' +
        '<button class="pbtn" type="button" data-pa="pop" title="拉出为独立窗口">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 5h5v5M19 5l-8 8"/><path d="M19 14v5H5V5h5"/></svg></button>' +
        '<button class="pbtn pbtn-close" type="button" data-pa="close" title="收起面板">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' +
      '</span>' +
      '<div class="pbar-menu" id="panelMenu" hidden></div>' +
      '<div class="pbar-menu" id="panelMoreMenu" hidden></div>';
    header.appendChild(bar);
    return bar;
  }

  function buildCanvas() {
    var body = $("#rightSidebar .rs-body");
    if (!body) return null;
    var sec = document.createElement("section");
    sec.className = "rs-panel rs-canvas";
    sec.setAttribute("data-rs-panel", "canvas");
    sec.setAttribute("role", "tabpanel");
    // Chrome bar: only when the content declares chrome (the sandbox does). The host draws the
    // buttons and sends commands to the iframe.
    var chrome = document.createElement("div");
    chrome.className = "chrome-bar";
    chrome.id = "panelChrome";
    chrome.hidden = true;
    var box = document.createElement("div");
    box.className = "pframe-box";
    box.id = "panelCanvasBox";
    // Empty state: says what this area is for when nothing is open. .has-content hides it once
    // something is mounted.
    var empty = document.createElement("div");
    empty.className = "pframe-empty";
    empty.innerHTML =
      '<div class="pframe-empty-t">还没有打开内容</div>' +
      '<div class="pframe-empty-d">agent 在对话里打开的地图、报告、产物会显示在这里；<br>也可以点上方图标直接打开沙盘。</div>';
    box.appendChild(empty);
    sec.appendChild(chrome);
    sec.appendChild(box);
    body.appendChild(sec);
    return sec;
  }

  // ---------- Chrome bar ----------
  var CHROMES = PANEL_CHROMES;
  function renderChrome(kind) {
    var bar = $("#panelChrome");
    if (!bar) return;
    var def = kind && CHROMES[kind];
    if (!def) { bar.hidden = true; bar.innerHTML = ""; return; }
    bar.hidden = false;
    bar.innerHTML = def.map(function (item) {
      if (item.type === "seg") {
        return '<span class="seg">' + item.items.map(function (b) {
          return '<button type="button" data-cmd="' + b.cmd + '" data-val="' + b.val + '">' + esc(b.text) + "</button>";
        }).join("") + "</span>";
      }
      return '<button type="button" data-cmd="' + item.cmd + '"' +
        (item.toggle ? ' class="tgl on" data-tgl="1"' : "") + ">" + esc(item.text) + "</button>";
    }).join("");
    bar.addEventListener("click", function (e) {
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
      if (frame && els.canvasBox) {
        frame.post(els.canvasBox, { __panel: 1, type: "command", data: payload });
      }
    });
  }

  // The content reports its state; reconcile the chrome buttons with it.
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

  // ---------- Canvas callbacks: host -> the currently open canvas page ----------
  // Why it exists: stage_open could only open a page, and once open it was read-only — the sandbox
  // could be looked at but not driven. This channel lets a canvas page register
  // window.__stage = { fn: (args) => result }, and stage_call({fn, args}) reaches it.
  // Only function NAMES are accepted, never code strings: the page declares what it exposes and
  // the host never evals anything.
  var _callSeq = 1;
  var _callPending = {};

  function callPage(fn, args, timeoutMs) {
    var name = String(fn || "").trim();
    if (!name) return Promise.reject(new Error("stage_call 需要 fn（画布页注册的函数名）"));
    if (!frame || !els.canvasBox) return Promise.reject(new Error("右栏画布还没就绪"));
    var cur = frame.current(els.canvasBox);
    if (!cur) return Promise.reject(new Error("画布是空的 —— 先用 stage_open 打开一个页面"));
    var ms = callTimeoutMs(timeoutMs);
    var id = "c" + (_callSeq++);
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        delete _callPending[id];
        reject(new Error("画布没有回应 " + name + "（" + Math.round(ms / 1000) + " 秒）。" +
          "常见原因：这个页面没注册 window.__stage，或者函数名不在里面"));
      }, ms);
      _callPending[id] = { resolve: resolve, reject: reject, fn: name, timer: timer };
      var ok = false;
      try { ok = frame.post(els.canvasBox, { __panel: 1, type: "call", data: { id: id, fn: name, args: args } }); } catch (e) {}
      if (!ok) {
        clearTimeout(timer); delete _callPending[id];
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

  function updateEmptyState() {    if (!els.canvasBox) return;
    var cur = frame ? frame.current(els.canvasBox) : null;
    els.canvasBox.classList.toggle("has-content", !!cur);
  }

  // The bar has two states, wide and narrow. Wide puts tools and views on the bar; narrow tucks
  // them into the "..." menu. The decision cannot ride on ResizeObserver alone — in a background
  // tab neither it nor rAF fires (measured: zero callbacks). So the primary path is a call at the
  // end of apply(), which every expand / collapse / drag already goes through; the observer and
  // window.resize are only a backup.
  function updateBarFit() {
    var bar = els.bar;
    if (!bar) return;
    var w = bar.getBoundingClientRect().width;
    bar.classList.toggle("pbar-wide", w >= 400);
  }

  function wireBarFit(bar) {
    if (!bar) return;
    try {
      if (typeof ResizeObserver === "function") new ResizeObserver(updateBarFit).observe(bar);
      global.addEventListener("resize", updateBarFit);
    } catch (e) {}
    global.requestAnimationFrame ? global.requestAnimationFrame(updateBarFit) : updateBarFit();
  }

  function bindBar(bar) {
    bar.addEventListener("click", function (e) {
      var t = e.target.closest ? e.target.closest("button") : null;
      if (!t) return;
      if (t.id === "panelTitleBtn") { toggleMenu(); return; }
      if (t.id === "panelMoreBtn") { toggleMore(); return; }
      // A tool entry inside the "..." menu.
      var toolId = t.getAttribute("data-tool");
      if (toolId) {
        for (var i = 0; i < tools.length; i++) if (tools[i].id === toolId) { openTool(tools[i]); break; }
        toggleMore(false);
        return;
      }
      // A view entry inside the "..." menu.
      var mpv = t.getAttribute("data-menu-pv");
      if (mpv) { setView(mpv); toggleMore(false); return; }
      var idx = t.getAttribute("data-idx");
      if (idx != null) { selectHistory(parseInt(idx, 10)); return; }
      var pv = t.getAttribute("data-pv");
      var pa = t.getAttribute("data-pa");
      if (pv) {
        // Clicking the active view again returns to the canvas.
        setView(st.view === pv ? "canvas" : pv);
        return;
      }
      if (pa === "pop") { popOut(); return; }
      if (pa === "close") { setExpanded(false); return; }
    });
    // A click anywhere outside the bar closes both dropdowns.
    document.addEventListener("click", function (e) {
      var m1 = $("#panelMenu"), m2 = $("#panelMoreMenu");
      var anyOpen = (m1 && !m1.hidden) || (m2 && !m2.hidden);
      if (!anyOpen) return;
      if (e.target.closest && (e.target.closest("#panelMenu") || e.target.closest("#panelMoreMenu") ||
          e.target.closest("#panelTitleBtn") || e.target.closest("#panelMoreBtn"))) return;
      toggleMenu(false);
      toggleMore(false);
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
    // An invalid view name makes viewState return the same object unchanged; that identity is the
    // early-exit signal here, the same guard the old implementation had.
    var next = viewState(st, name);
    if (next === st) return;
    st = next;
    save();
    apply();
    emit("view", { view: st.view, expanded: st.expanded });
  }

  function setExpanded(on) {
    // Expanding always lands on the content canvas: activity and status are temporary overlays and
    // must not be remembered. That rule lives in expandedState.
    st = expandedState(st, on);
    save();
    apply();
    emit("state", { expanded: st.expanded, view: st.view, width: st.width });
  }

  function setWidth(w) {
    st = widthState(st, w);
    save();
    apply();
    if (frame && global.__panelFrame) {
      var box = els.canvasBox;
      if (box) global.__panelFrame.resize(box);
    }
  }

  // Push the state into the DOM.
  function apply() {
    var html = document.documentElement;
    var col = $("#rightSidebar");
    if (!col) return;

    var expanded = st.expanded && isDesktop();
    html.classList.toggle("panel-expanded", expanded);
    html.style.setProperty("--panel-w", st.width + "px");
    if (expanded) markNew(false); // 展开即视为"已看到新内容"

    var bar = els.bar;
    if (bar) bar.hidden = !expanded;

    // Pinned: the original rs-tabs stay visible. Expanded: hidden.
    var tabs = $("#rightSidebar .rs-tabs");
    if (tabs) tabs.hidden = expanded;

    var ps = panels();
    // Pinned: follow st.tab only (fishbowl | status).
    // Expanded: follow st.view (canvas | activity | status), mapped to a section by panelKeyOf.
    var activeKey = activeKeyOf(st, expanded);
    var active = expanded ? st.view : st.tab;
    // Also write "who should be visible" onto the html element so CSS can hold the line: when a
    // JS-set hidden occasionally does not take, exactly one section is still visible.
    html.setAttribute("data-panel-view", activeKey);

    Object.keys(ps).forEach(function (k) {
      var el = ps[k];
      if (!el) return;
      var show = (k === activeKey);
      el.hidden = !show;
      el.classList.toggle("active", show);
    });

    // Highlight the icon buttons.
    if (bar) {
      var btns = bar.querySelectorAll("button[data-pv]");
      for (var i = 0; i < btns.length; i++) {
        var on = expanded && btns[i].getAttribute("data-pv") === active &&
                 active !== "canvas";
        btns[i].classList.toggle("active", on);
      }
    }

    // Title placeholder: show "Content" when nothing is open. Otherwise the title is an empty
    // string and the dropdown looks like it is not there.
    if (!String(lastSpec && lastSpec.title || "").trim()) setTitle("");

    // Canvas size changed: tell the content.
    if (expanded && active === "canvas" && global.__panelFrame && els.canvasBox) {
      global.__panelFrame.resize(els.canvasBox);
    }
    updateEmptyState();
    updateBarFit(); // 面板条宽/窄两态（展开、拖宽都走这里，不依赖 RO/rAF）
    // The grid reflows on the next frame, so measuring the bar width waits one more beat.
    requestAnimationFrame(refitTopbar);
  }

  // ---------- Content ----------
  var lastSpec = null;

  function open(spec) {
    spec = spec || {};
    if (!frame) return { ok: false, error: "panel-frame 未加载" };
    if (!els.canvasBox) return { ok: false, error: "画布未装配" };
    var r = frame.mount(els.canvasBox, spec);
    lastSpec = spec;
    setTitle(spec.title || "");
    pushHistory(spec);
    renderChrome(spec.chrome || null);
    updateEmptyState();
    // When the agent opens content the panel does not expand on its own: taking over the user's
    // screen is not the agent's call. While collapsed, a dot on the topbar toggle says there is new
    // content; the user opens it when they want it.
    if (!st.expanded) markNew(true); else setView("canvas");
    publishCurrent();
    emit("open", { title: spec.title || "", mode: r ? r.mode : "" });
    return { ok: true, mode: r ? r.mode : "", title: spec.title || "" };
  }

  function close() {
    if (frame && els.canvasBox) frame.unmount(els.canvasBox);
    lastSpec = null;
    setTitle("");
    renderChrome(null);
    updateEmptyState();
    setView(st.expanded ? "canvas" : st.tab);
    publishCurrent();
    emit("close", {});
  }

  // The "has new content" dot on the topbar toggle.
  function markNew(on) {
    var btn = $("#panelToggle") || $("#stageToggle");
    if (!btn) return;
    btn.classList.toggle("has-new", !!on);
  }

  // The content title on the bar.
  // It MUST NOT hide when there is no content: an earlier version did, and the dropdown simply
  // disappeared for the user. With nothing open it shows the placeholder "Content" — and because
  // the same dropdown also carries the view switches, it stays meaningful and clickable.
  function setTitle(t) {
    var el = $("#panelTitle");
    var txt = String(t || "").trim();
    if (el) el.textContent = txt || "内容";
    var bar = $("#panelBar");
    if (bar) bar.classList.toggle("pbar-plain-title", !txt);
  }

  // ---------- Content history (bar dropdown: name + generated time, reopenable) ----------
  var histList = []; // [{ title, at, spec }]，最多 10 条，最新在前

  // Built-in canvas pages are NOT artifacts. The council and the sandbox are tools, not content the
  // agent produced; listing them in the history dropdown pushes out the artifacts the user actually
  // wants to reopen (measured: the council showed up twice, back to back). The test is the URL, so
  // stage_open on a built-in page does not record it either.
  function pushHistory(spec) {
    // On a skip, nextHistory returns the same array object unchanged; that identity preserves the
    // old behaviour of not re-ordering the menu for built-in pages.
    var next = nextHistory(histList, spec, Date.now(), tools);
    if (next === histList) return;
    histList = next;
    renderMenu();
  }

  function renderMenu() {
    var menu = $("#panelMenu");
    if (!menu) return;
    // The dropdown is back to its job: recently produced content only, no view switches.
    var curTitle = lastSpec ? contentTitleOf(lastSpec) : "";
    menu.innerHTML = histList.length
      ? '<div class="pmenu-sec">最近内容</div>' + histList.map(function (it, i) {
          return '<button class="pmenu-item' + (it.title === curTitle ? " on" : "") + '" type="button" data-idx="' + i + '">' +
            '<span class="pmenu-t">' + esc(it.title) + "</span>" +
            '<span class="pmenu-time">' + fmtClock(it.at) + "</span></button>";
        }).join("")
      : '<div class="pmenu-empty">还没有生成过内容</div>';
  }

  // The dropdown used to be pinned with a CSS left:56px, so moving the title button knocked it out
  // of place. Left-aligning the "..." menu pushed it 18px past the panel's right edge instead.
  // Both now align to the trigger button's RIGHT edge, 180-240px wide and capped to the bar.
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

  function toggleMenu(force) {
    var menu = $("#panelMenu");
    if (!menu) return;
    var show = force === undefined ? menu.hidden : !!force;
    menu.hidden = !show;
    if (show) { toggleMore(false); renderMenu(); placeMenu(menu, $("#panelTitleBtn")); }
  }

  // The "..." menu: tools plus views (the bar itself keeps only pop-out and close).
  function toggleMore(force) {
    var menu = $("#panelMoreMenu");
    if (!menu) return;
    var show = force === undefined ? menu.hidden : !!force;
    menu.hidden = !show;
    if (show) { toggleMenu(false); renderTools(); placeMenu(menu, $("#panelMoreBtn")); }
  }

  function selectHistory(idx) {
    var it = histList[idx];
    if (!it || !frame || !els.canvasBox) return;
    frame.mount(els.canvasBox, it.spec);
    lastSpec = it.spec;
    setTitle(it.title);
    updateEmptyState();
    toggleMenu(false);
    setView("canvas");
    publishCurrent();
  }

  // ---------- Detached window (two channels: BroadcastChannel first, storage events as fallback) ----------
  var bc = null;
  var popupWin = null;

  function ensureChannel() {
    if (bc) return bc;
    try { bc = new BroadcastChannel("cfw-panel"); } catch (e) { return null; }
    bc.addEventListener("message", function (e) {
      var d = e.data || {};
      // A detached window asks for the current state on startup.
      if (d.kind === "ask" && !isPanelWindow) publishCurrent();
    });
    return bc;
  }

  function publishCurrent() {
    if (isPanelWindow) return; // 只有主窗发布
    var msg = { kind: "current", spec: lastSpec || null, at: Date.now() };
    var ch = ensureChannel();
    if (ch) { try { ch.postMessage(msg); } catch (e) {} }
    try { localStorage.setItem(LS_CUR, JSON.stringify(msg)); } catch (e) {}
  }

  function popOut() {
    // The Tauri webview does not implement window.open (it returns null), so the desktop shell opens
    // a native window through the open_panel_window command. The web keeps window.open.
    var url = location.origin + location.pathname + "?panel=1&t=" + Date.now();
    var T = global.__TAURI__;
    if (T && T.core && typeof T.core.invoke === "function") {
      T.core.invoke("open_panel_window", { url: url }).then(function () {
        publishCurrent();
      }).catch(function () { emit("popup-blocked", {}); });
      return;
    }
    try { popupWin = global.open(url, "ownchat_panel", "width=480,height=780"); } catch (e) { popupWin = null; }
    if (!popupWin) { emit("popup-blocked", {}); return; }
    publishCurrent();
  }

  // Detached-window mode: a full-screen overlay that renders the content plus one title bar.
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
    var f = global.__panelFrame || null;

    wrap.querySelector(".pw-close").addEventListener("click", function () {
      // In the desktop shell window.close() does nothing to a native window, so the shell command
      // closes it.
      var T = global.__TAURI__;
      if (T && T.core && typeof T.core.invoke === "function") {
        T.core.invoke("close_panel_window").catch(function () { try { global.close(); } catch (e) {} });
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
      ch.addEventListener("message", function (e) {
        var d = e.data || {};
        if (d.kind === "current") applySpec(d.spec);
      });
    }
    global.addEventListener("storage", function (e) {
      if (e.key !== LS_CUR || !e.newValue) return;
      try { var o = JSON.parse(e.newValue); if (o && o.kind === "current") applySpec(o.spec); } catch (err) {}
    });

    // Startup: read the local cache first (a BroadcastChannel message can arrive before the
    // listener is attached), then send one ask as the fallback.
    try {
      var cached = JSON.parse(localStorage.getItem(LS_CUR) || "null");
      if (cached && cached.kind === "current") applySpec(cached.spec);
    } catch (e) {}
    try { if (ch) ch.postMessage({ kind: "ask", at: Date.now() }); } catch (e) {}
    setTimeout(function () {
      try { if (ch) ch.postMessage({ kind: "ask", at: Date.now() }); } catch (e) {}
    }, 800);

    global.addEventListener("resize", function () { if (f) f.resize(box); });
    f && f.resize(box);
  }

  // ---------- Topbar adaptation ----------
  // Watch the actual width of the middle column (#app) and add .topbar-tight only below the
  // threshold. "Is the panel expanded" is the wrong test: expanded but still wide (middle column
  // over 560px) keeps the sync badge, the built-in label and the model label.
  var TOPBAR_TIGHT = PANEL_TOPBAR_TIGHT;

  function refitTopbar() {
    var app = document.getElementById("app");
    // The composer's right offset is measured directly as viewport edge minus chat-column edge. That
    // automatically includes the panel width, the seam margin and any gap; measuring the panel itself
    // misses its margin-left: 10px, which getBoundingClientRect does not report.
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
    // Two triggers: a panel state change (apply() schedules one rAF) and a viewport change.
    global.addEventListener("resize", function () { requestAnimationFrame(refitTopbar); });
    // The third: a ResizeObserver backup for grid reflows neither of those catches.
    if (typeof ResizeObserver === "function") {
      try { new ResizeObserver(function () { requestAnimationFrame(refitTopbar); }).observe(app); } catch (e) {}
    }
    requestAnimationFrame(refitTopbar);
  }

  // ---------- Drag to resize ----------
  // Pairs with "seam v2" in styles-panel.css.
  //  1. The hit band is 20px: 10px of seam (the pointer is over .app-shell) plus 10px inside the
  //     sidebar (the ::before width). The old version only accepted 8px inside the sidebar and used
  //     e.offsetX, which is relative to whatever child sits under the pointer (a header, say) and
  //     therefore misjudged; the comparison is now clientX against the sidebar's left edge.
  //  2. Entering the band adds .seam-hover, dragging adds html.panel-resizing, so the grip responds.
  //  3. Double-clicking the band resets to the default width (previously it had to be dragged back).
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
      // Pointer events are disabled on iframes while dragging: once the cursor crosses into an
      // iframe the parent stops receiving mousemove and the drag dies.
      var f = els.canvasBox && els.canvasBox.querySelector("iframe");
      if (f) f.style.pointerEvents = "none";
      document.body.style.cursor = "col-resize";
      html.classList.add("panel-resizing");
      function mv(ev) {
        moved = true;
        setWidth(startW + (startX - ev.clientX));
      }
      function up() {
        document.removeEventListener("mousemove", mv);
        document.removeEventListener("mouseup", up);
        if (f) f.style.pointerEvents = "";
        document.body.style.cursor = "";
        html.classList.remove("panel-resizing");
        if (moved) emit("width", { width: st.width });
      }
      document.addEventListener("mousemove", mv);
      document.addEventListener("mouseup", up);
    }
    function onDown(e) {
      if (isControl(e) || !inBand(e.clientX)) return;
      startDrag(e);
    }
    col.addEventListener("mousedown", onDown);
    // The seam is the sidebar's margin area, so the pointer lands on .app-shell. Only a blank hit
    // starts a drag; a bubbled event from the column has a different target and passes through, so
    // startDrag cannot run twice.
    if (shell) shell.addEventListener("mousedown", function (e) {
      if (e.target !== shell) return;
      onDown(e);
    });

    document.addEventListener("mousemove", function (e) {
      var on = inBand(e.clientX);
      if (on === hovered) return;
      hovered = on;
      col.classList.toggle("seam-hover", on);
    });
    document.addEventListener("dblclick", function (e) {
      if (isControl(e) || !inBand(e.clientX)) return;
      setWidth(W_DEF);
      emit("width", { width: W_DEF });
    });
  }

  // ---------- Topbar toggle ----------
  function bindToggle() {
    var btn = $("#stageToggle") || $("#panelToggle");
    if (!btn) return;
    btn.addEventListener("click", function () { setExpanded(!st.expanded); });
  }

  // ---------- Pinned tab switching (takes over logic that was missing) ----------
  function bindTabs() {
    var tabs = document.querySelectorAll("#rightSidebar .rs-tab");
    if (!tabs.length) return;
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener("click", function () {
        var name = this.getAttribute("data-rs-tab");
        // Pinned mode gained a group-chat tab (data-rs-tab="chat").
        st = tabState(st, name);
        save();
        apply();
        // Keep the original tabs' aria-selected and active class in sync; status-panel's observer
        // reads them.
        var all = document.querySelectorAll("#rightSidebar .rs-tab");
        for (var j = 0; j < all.length; j++) {
          var on = all[j] === this;
          all[j].classList.toggle("active", on);
          all[j].setAttribute("aria-selected", on ? "true" : "false");
        }
        emit("tab", { tab: st.tab });
      });
    }
  }

  function boot() {
    load();
    if (isPanelWindow) { bootWindow(); return; } // 独立窗：全屏覆盖层，不建右栏控制器
    if (!isDesktop()) return; // 手机端走原有底部抽屉，本控制器不介入
    wireTopbarFit();
    els.bar = buildBar();
    renderTools();      // 工具已注册过时，先把条上那排图标画出来
    wireBarFit(els.bar); // 面板宽 → 按钮铺出来；面板窄 → 收进「⋯」
    els.canvas = buildCanvas();
    els.canvasBox = $("#panelCanvasBox");
    frame = global.__panelFrame || null;
    if (frame && typeof frame.on === "function") {
      frame.on(function (ev) {
        if (!ev) return;
        if (ev.type === "state") onFrameState(ev.data);
        else if (ev.type === "call-result") onCallResult(ev.data);
      });
    }
    if (els.bar) bindBar(els.bar);
    BUILTIN_TOOLS.forEach(registerTool);
    bindResize();
    bindToggle();
    bindTabs();
    // Sync the original tab highlight on startup. Nothing did this before, so the status tab
    // started out wrong.
    var cur = document.querySelector('#rightSidebar .rs-tab[data-rs-tab="' + st.tab + '"]');
    if (cur) {
      var all = document.querySelectorAll("#rightSidebar .rs-tab");
      for (var i = 0; i < all.length; i++) {
        var on = all[i] === cur;
        all[i].classList.toggle("active", on);
        all[i].setAttribute("aria-selected", on ? "true" : "false");
      }
    }
    apply();
    // Startup timing guard: re-check visibility once layout and fonts settle (two panels were seen
    // visible at the same time).
    requestAnimationFrame(function () { try { apply(); } catch (e) {} });
    setTimeout(function () { try { apply(); } catch (e) {} }, 250);
  }

  var api = {
    v: V,
    open: open,
    close: close,
    view: setView,
    state: function () {
      return {
        expanded: st.expanded, width: st.width, view: st.view, tab: st.tab,
        hasContent: !!(frame && els.canvasBox && frame.current(els.canvasBox))
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
    // Call a function the current canvas page registered; the agent's stage_call lands here.
    call: callPage,
    // Internal / debug (not a contract).
    _toggle: function () { setExpanded(!st.expanded); },
    _width: setWidth,
    _apply: apply,
    // Tool-slot registration (shared by the built-ins and future external tools; content never goes
    // here).
    registerTool: registerTool,
    tools: function () { return tools.slice(); }
  };

  global.__panel = api;

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})(window);
