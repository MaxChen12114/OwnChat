// public/shared/panel-host.js — 右栏内容面板：双态控制器
// ─────────────────────────────────────────────────────────────────────
// 两态（2026-11-08 所有者定稿，2026-11-09 定稿成文）：
//   固定态  对称布局，右栏 240px，两个文字 tab：活动 / 状态 —— 快速切换拿信息
//   展开态  右栏 320~640px（拖左缘调宽），条上三个 28px 图形钮：活动 / 状态 / 新窗
//           主体 = 内容画布（默认视图），点活动/状态临时覆盖，再点一次回画布
//
// 为什么没有插件按钮行：
//   内容由 agent 调 __panel.open() 挂进来，不是一排写死的 viewer 按钮。
//   写死的只有"仪表"（活动/状态）与"窗口控制"（新窗/开合）——它们不属于内容。
//
// 职责边界：
//   本文件 = 状态机 + 视图切换 + 持久化 + 新窗拉出。不画 iframe（那是 panel-frame.js）。
//   不认识任何具体内容（地图/复盘/产物全都只是"一份 url"）。
//
// 修复的历史缺陷：
//   右栏两个 tab 原本没有切换逻辑（status-panel.js 只用 MutationObserver 观察，
//   没人实现）——「状态」面板点不到。本文件接管 tab 切换。
//
// 对外契约（window.__panel，5 个成员）：
//   v / open(spec) / close() / view(name) / state() / on(type, fn)
//   open: { url?, html?, text?, title?, mode?: 'trusted'|'host-html'|'external' }
// ─────────────────────────────────────────────────────────────────────
(function (global) {
  "use strict";

  if (global.__panel && global.__panel.v === 1) return;

  var V = 1;
  var LS = "cfw_panel_state_v1";
  var LS_CUR = "cfw_panel_current_v1";
  // 2026-11-10（所有者：展开的演示台拉不到中间）：上限 640 太窄 —— 1440 宽下中线需要
  // 约 720，旧值把拖拽卡在离中线一截。放宽到 1200，实际仍受 grid 的 calc 约束
  // （中间列保底 460px），所以不会把聊天区挤没。
  var W_MIN = 240, W_MAX = 1200, W_DEF = 460;
  var DESKTOP_MIN = 1024;

  // 独立窗口：同一个 index.html 带 ?panel=1 打开，接管成全屏覆盖层，不跑常规控制器
  var isPanelWindow = false;
  try { isPanelWindow = new URLSearchParams(location.search || "").get("panel") === "1"; } catch (e) {}

  var st = { expanded: false, width: W_DEF, view: "canvas", tab: "fishbowl" };
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
    try {
      var o = JSON.parse(localStorage.getItem(LS) || "{}") || {};
      st.expanded = o.expanded === true;
      st.width = Math.max(W_MIN, Math.min(W_MAX, parseInt(o.width, 10) || W_DEF));
      // 视图不持久化：展开态的主场永远是内容画布；活动/状态是用户临时点开的覆盖视图。
      // （原来恢复上次 view，导致"上次点了活动 → 之后每次打开都在活动列"）
      st.view = "canvas";
      st.tab = (o.tab === "status") ? "status" : "fishbowl";
    } catch (e) {}
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

  // ---------- DOM 装配（动态创建，index.html 只留一个顶栏按钮） ----------
  // ---------- 工具位（不是内容目录） ----------
  // 两类工具，身份不同：
  //   sandbox  自家沙盘（幻想地图，程序化生成，零依赖）—— 永远可用
  //   map      GEO 地图（现实地图，外部源）—— 配了地址才连，未配置时给引导页
  // 内容（产物/报告/网页）一律由 agent 通过 open() 挂进来，不进这里。
  var LS_MAP_URL = "cfw_panel_map_url_v1";

  function geoMapUrl() {
    try { return String(localStorage.getItem(LS_MAP_URL) || "").trim(); } catch (e) { return ""; }
  }

  function geoGuideHtml() {
    return '<div style="margin:0;padding:20px 18px;font:12.5px/1.75 system-ui,\'Microsoft YaHei\',sans-serif;color:#c9d3de">' +
      '<div style="font-size:13px;font-weight:600;color:#eaf2fa;margin-bottom:6px">GEO 地图未连接</div>' +
      '<div style="color:#8595a6;margin-bottom:14px">这里是 GEO-Agent 提供的真实地图（OSM/卫星），属于外部源，需要先把 GEO-Agent 跑起来。</div>' +
      '<div style="color:#8595a6;margin-bottom:6px">1. 启动 GEO-Agent（它的启动器会拉起 8795 / 8796）</div>' +
      '<div style="color:#8595a6;margin-bottom:6px">2. 在控制台执行一次（只需一次）：</div>' +
      '<pre style="margin:0 0 12px;padding:9px 11px;background:#111820;border:1px solid #243040;border-radius:8px;' +
      'font:11px/1.6 ui-monospace,Consolas,monospace;color:#9fc0e0;overflow:auto;white-space:pre-wrap">' +
      "localStorage.setItem('cfw_panel_map_url_v1', 'http://127.0.0.1:8796/map-viewer/')</pre>" +
      '<div style="color:#6f8194;font-size:11px">配置后重新点这个图标。沙盘不需要这一步，随时可开。</div>' +
      '</div>';
  }

  var BUILTIN_TOOLS = [
    { id: "sandbox", title: "沙盘（幻想地图）", icon: "map", url: "/tools/sandbox/index.html?v=19", chrome: "map" },
    // 2026-11-09：多智能体讨论区。convene_meeting 的结果原来只回给主 agent，界面上一片空白，
    // 于是 agent 找不到"讨论区"在哪，干脆自己写一页 HTML、在一个上下文里把四个角都扮演掉。
    // 这一页把「N 个独立 agent 各自发言」变成看得见的东西，也是 agent 该找到的那条路。
    { id: "council", title: "多智能体讨论区", icon: "users", url: "/tools/council/index.html?v=3" },
    { id: "map", title: "GEO 地图（真实地图，外部源）", icon: "globe", url: "" }
  ];
  var tools = [];

  function toolIcon(name) {
    if (name === "map") {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4L3.5 6v14L9 18l6 2 5.5-2V4L15 6 9 4z"/><path d="M9 4v14M15 6v14"/></svg>';
    }
    if (name === "globe") {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.2"/><path d="M3.8 12h16.4M12 3.8c2.2 2.3 3.3 5.1 3.3 8.2s-1.1 5.9-3.3 8.2c-2.2-2.3-3.3-5.1-3.3-8.2s1.1-5.9 3.3-8.2z"/></svg>';
    }
    if (name === "users") {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8.2" r="3.2"/><path d="M3.4 19c0-3.1 2.5-5.2 5.6-5.2s5.6 2.1 5.6 5.2"/><circle cx="16.8" cy="9.4" r="2.4"/><path d="M15.6 13.6c2.6 0 4.8 1.7 4.8 4.4"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/></svg>';
  }

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
    if (!els.bar) return;
    var box = els.bar.querySelector(".pbar-tools");
    if (!box) return;
    box.innerHTML = "";
    tools.forEach(function (t) {
      var b = document.createElement("button");
      b.className = "pbtn pbtn-tool";
      b.type = "button";
      b.setAttribute("data-tool", t.id);
      b.title = t.title || t.id;
      b.innerHTML = toolIcon(t.icon);
      if (t.id === "map" && !geoMapUrl()) b.classList.add("pbtn-off");
      b.addEventListener("click", function () { openTool(t); });
      box.appendChild(b);
    });
    if (tools.length) {
      var sep = document.createElement("span");
      sep.className = "pbar-sep";
      box.appendChild(sep);
    }
  }

  function registerTool(def) {
    // url 允许为空：外部工具（GEO 地图）未配置时仍要占位，点击由 openTool 给引导页
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
    bar.className = "pbar";
    bar.id = "panelBar";
    bar.hidden = true;
    bar.innerHTML =
      '<span class="pbar-tools"></span>' +
      '<button class="pbar-title" id="panelTitleBtn" type="button" title="切换最近生成的内容">' +
        '<span class="pbar-title-tx" id="panelTitle"></span>' +
        '<svg class="pbar-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 10l5 5 5-5"/></svg>' +
      '</button>' +
      '<span class="pbar-acts">' +
        // 2026-11-09（拆三栏）：展开态也要能看群聊 —— 和固定态三栏一一对应。
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
      '<div class="pbar-menu" id="panelMenu" hidden></div>';
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
    // 工具条：仅当内容声明了 chrome（如沙盘）时显示，按钮由宿主画、命令发给 iframe
    var chrome = document.createElement("div");
    chrome.className = "chrome-bar";
    chrome.id = "panelChrome";
    chrome.hidden = true;
    var box = document.createElement("div");
    box.className = "pframe-box";
    box.id = "panelCanvasBox";
    // 空态：没有内容时告诉用户这块地方干什么用。有内容时由 .has-content 隐藏。
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

  // ---------- 工具条（chrome） ----------
  var CHROMES = {
    map: [
      { type: "seg", items: [
        { cmd: "skin", val: "A", text: "像素" },
        { cmd: "skin", val: "B", text: "等距" }
      ] },
      { cmd: "regen", text: "换世界" },
      { cmd: "run", text: "跑图", toggle: true }
    ]
  };

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

  // 内容回报状态 → 校正工具条按钮
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

  // ---------- 画布回调（2026-11-09）：宿主 → 当前画布页的函数调用 ----------
  // 为什么需要：agent 原来只能 stage_open 把页面「打开」，打开之后就只能是只读的 ——
  // 沙盘能看不能改。这条通道让画布页注册 window.__stage = { fn: (args) => 结果 }，
  // agent 用 stage_call({fn,args}) 就能驱动它。
  // 只认**函数名**，不接受任意代码字符串：能力由页面自己声明，宿主不 eval 任何东西。
  var _callSeq = 1;
  var _callPending = {};

  function callPage(fn, args, timeoutMs) {
    var name = String(fn || "").trim();
    if (!name) return Promise.reject(new Error("stage_call 需要 fn（画布页注册的函数名）"));
    if (!frame || !els.canvasBox) return Promise.reject(new Error("右栏画布还没就绪"));
    var cur = frame.current(els.canvasBox);
    if (!cur) return Promise.reject(new Error("画布是空的 —— 先用 stage_open 打开一个页面"));
    var ms = Math.max(1000, Math.min(120000, parseInt(timeoutMs, 10) || 15000));
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

  function bindBar(bar) {
    bar.addEventListener("click", function (e) {
      var t = e.target.closest ? e.target.closest("button") : null;
      if (!t) return;
      if (t.id === "panelTitleBtn") { toggleMenu(); return; }
      var idx = t.getAttribute("data-idx");
      if (idx != null) { selectHistory(parseInt(idx, 10)); return; }
      var pv = t.getAttribute("data-pv");
      var pa = t.getAttribute("data-pa");
      if (pv) {
        // 再点一次回画布
        setView(st.view === pv ? "canvas" : pv);
        return;
      }
      if (pa === "pop") { popOut(); return; }
      if (pa === "close") { setExpanded(false); return; }
    });
    // 点面板条以外的任何地方 → 收起下拉
    document.addEventListener("click", function (e) {
      var m = $("#panelMenu");
      if (!m || m.hidden) return;
      if (e.target.closest && (e.target.closest("#panelMenu") || e.target.closest("#panelTitleBtn"))) return;
      toggleMenu(false);
    });
  }

  // ---------- 视图 ----------
  function panels() {
    var out = {};
    var list = document.querySelectorAll("#rightSidebar .rs-panel");
    for (var i = 0; i < list.length; i++) {
      out[list[i].getAttribute("data-rs-panel")] = list[i];
    }
    return out;
  }

  // 视图名 → 面板 key（右栏原有 section 的 data-rs-panel 值）
  // 右栏历史命名：活动面板的 key 是 fishbowl（鱼缸，历史名），状态是 status，画布是 canvas。
  function panelKeyOf(view) {
    if (view === "activity") return "fishbowl";
    if (view === "chat") return "chat";
    if (view === "status") return "status";
    return "canvas";
  }

  function setView(name) {
    if (name !== "canvas" && name !== "activity" && name !== "chat" && name !== "status") return;
    st.view = name;
    if (!st.expanded) st.tab = (name === "status") ? "status" : (name === "chat" ? "chat" : "fishbowl");
    save();
    apply();
    emit("view", { view: st.view, expanded: st.expanded });
  }

  function setExpanded(on) {
    st.expanded = !!on;
    if (st.expanded) {
      // 展开时永远回内容画布（活动/状态是临时覆盖，不该被记住）
      st.view = "canvas";
    }
    save();
    apply();
    emit("state", { expanded: st.expanded, view: st.view, width: st.width });
  }

  function setWidth(w) {
    st.width = Math.max(W_MIN, Math.min(W_MAX, Math.round(w) || W_DEF));
    save();
    apply();
    if (frame && global.__panelFrame) {
      var box = els.canvasBox;
      if (box) global.__panelFrame.resize(box);
    }
  }

  // 把状态刷到 DOM
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

    // 固定态：原 rs-tabs 显示；展开态：隐藏
    var tabs = $("#rightSidebar .rs-tabs");
    if (tabs) tabs.hidden = expanded;

    var ps = panels();
    // 固定态：只按 st.tab（fishbowl | status）
    // 展开态：按 st.view（canvas | activity | status）→ panelKeyOf 映射到实际 section
    var activeKey = expanded ? panelKeyOf(st.view)
      : (st.tab === "status" ? "status" : (st.tab === "chat" ? "chat" : "fishbowl"));
    var active = expanded ? st.view : st.tab;
    // 同时把"当前该显示谁"写到 html 上，交给 CSS 兜底（JS 的 hidden 偶发不生效时仍只有一个可见）
    html.setAttribute("data-panel-view", activeKey);

    Object.keys(ps).forEach(function (k) {
      var el = ps[k];
      if (!el) return;
      var show = (k === activeKey);
      el.hidden = !show;
      el.classList.toggle("active", show);
    });

    // 图形钮高亮
    if (bar) {
      var btns = bar.querySelectorAll("button[data-pv]");
      for (var i = 0; i < btns.length; i++) {
        var on = expanded && btns[i].getAttribute("data-pv") === active &&
                 active !== "canvas";
        btns[i].classList.toggle("active", on);
      }
    }

    // 画布尺寸变化 → 通知内容
    if (expanded && active === "canvas" && global.__panelFrame && els.canvasBox) {
      global.__panelFrame.resize(els.canvasBox);
    }
    updateEmptyState();
    // 网格重排发生在下一帧，这里延后一拍再量顶栏所需宽度
    requestAnimationFrame(refitTopbar);
  }

  // ---------- 内容 ----------
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
    // 2026-11-09 所有者裁定：agent 打开内容**不自动展开面板**——不抢用户的屏幕。
    // 收起状态下在顶栏 ⊞ 上点一个小圆点提示"有新内容"；用户自己点开才看。
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

  // 顶栏 ⊞ 的"有新内容"圆点
  function markNew(on) {
    var btn = $("#panelToggle") || $("#stageToggle");
    if (!btn) return;
    btn.classList.toggle("has-new", !!on);
  }

  // 面板条上的内容标题
  function setTitle(t) {
    var el = $("#panelTitle");
    if (el) el.textContent = String(t || "");
  }

  // ---------- 内容历史（面板条下拉：名字 + 生成时间，可回看） ----------
  var histList = []; // [{ title, at, spec }]，最多 10 条，最新在前

  function fmtClock(ts) {
    var d = new Date(ts);
    return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
  }

  // 2026-11-09：**内置画布页不算产物**。
  // 讨论区/沙盘是"工具"，不是 agent 生成的内容。它们进"内容历史"下拉会把真正要回看的产物挤掉
  // （实测讨论区出现了两次、时间还挨着）。判断按 URL，所以 agent 用 stage_open 打开内置页也不记。
  function isBuiltinPage(u) {
    var s = String(u || "").split("?")[0];
    if (!s) return false;
    for (var i = 0; i < tools.length; i++) {
      var t = tools[i];
      if (!t || !t.url) continue;
      var b = String(t.url).split("?")[0].replace(/index\.html$/, "");
      if (s === b || s.indexOf(b) === 0) return true;
    }
    return false;
  }

  function pushHistory(spec) {
    if (spec && spec._builtin) return;
    if (spec && isBuiltinPage(spec.url)) return;
    var title = String(spec.title || "").trim() || (spec.url ? "页面" : "内联内容");
    for (var i = 0; i < histList.length; i++) {
      if (histList[i].title === title) { histList.splice(i, 1); break; }
    }
    histList.unshift({ title: title, at: Date.now(), spec: spec });
    if (histList.length > 10) histList.length = 10;
    renderMenu();
  }

  function renderMenu() {
    var menu = $("#panelMenu");
    if (!menu) return;
    if (!histList.length) { menu.innerHTML = ""; menu.hidden = true; return; }
    var curTitle = lastSpec ? (String(lastSpec.title || "").trim() || (lastSpec.url ? "页面" : "内联内容")) : "";
    menu.innerHTML = histList.map(function (it, i) {
      return '<button class="pmenu-item' + (it.title === curTitle ? " on" : "") + '" type="button" data-idx="' + i + '">' +
        '<span class="pmenu-t">' + esc(it.title) + "</span>" +
        '<span class="pmenu-time">' + fmtClock(it.at) + "</span></button>";
    }).join("");
  }

  // 2026-11-09：下拉原来用 CSS 里的 left:56px 硬定位，标题按钮一挪就歪（实测偏左一大截）。
  // 改成按标题按钮的**实际位置**对齐，宽度也跟按钮一致。
  function placeMenu() {
    var menu = $("#panelMenu"), btn = $("#panelTitleBtn");
    if (!menu || !btn) return;
    var host = menu.parentNode;
    if (!host) return;
    var b = btn.getBoundingClientRect(), p = host.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.round(b.left - p.left)) + "px";
    menu.style.top = Math.round(b.bottom - p.top + 4) + "px";
    menu.style.width = Math.max(200, Math.round(b.width)) + "px";
  }

  function toggleMenu(force) {
    var menu = $("#panelMenu");
    if (!menu) return;
    var show = force === undefined ? menu.hidden : !!force;
    if (show && !histList.length) return;
    menu.hidden = !show;
    if (show) { renderMenu(); placeMenu(); }
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

  // ---------- 独立窗口（双通道：BroadcastChannel 优先，localStorage/storage 事件兜底） ----------
  var bc = null;
  var popupWin = null;

  function ensureChannel() {
    if (bc) return bc;
    try { bc = new BroadcastChannel("cfw-panel"); } catch (e) { return null; }
    bc.addEventListener("message", function (e) {
      var d = e.data || {};
      // 独立窗启动时索要现状
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
    var url = location.pathname + "?panel=1&t=" + Date.now();
    try { popupWin = global.open(url, "ownchat_panel", "width=480,height=780"); } catch (e) { popupWin = null; }
    if (!popupWin) { emit("popup-blocked", {}); return; }
    publishCurrent();
  }

  // 独立窗模式：全屏覆盖层，只渲染内容 + 一条标题栏
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

    // 启动：先读本地缓存（BC 在加载期可能收不到），再发一次 ask 兜底
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

  // ---------- 顶栏自适应 ----------
  // 盯中间列（#app）的**实际宽度**，低于阈值才给 html 加 .topbar-tight。
  // 不用「是否展开」判断：展开但窗口够宽时（中间列 > 560），云同步/内置文字/Model 标签全保留。
  var TOPBAR_TIGHT = 560;

  function refitTopbar() {
    var app = document.getElementById("app");
    // 底部输入框的 right 偏移：直接取"视口右边缘到聊天列右边界"的距离。
    // 这样自动把面板宽度、撕离缝 margin、任何间隙都算进去（不能只量面板自身宽度，
    // 面板 margin-left: 10px 不在 getBoundingClientRect 里）。
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
    // 1) 面板状态变化（展开/收起/拖宽）→ apply() 里会 rAF 调一次
    // 2) 视口变化
    global.addEventListener("resize", function () { requestAnimationFrame(refitTopbar); });
    // 3) ResizeObserver 兜底（网格重排不在 1/2 覆盖范围内时）
    if (typeof ResizeObserver === "function") {
      try { new ResizeObserver(function () { requestAnimationFrame(refitTopbar); }).observe(app); } catch (e) {}
    }
    requestAnimationFrame(refitTopbar);
  }

  // ---------- 拖拽调宽 ----------
  function bindResize() {
    var col = $("#rightSidebar");
    if (!col) return;
    col.addEventListener("mousedown", function (e) {
      if (!st.expanded) return;
      if (e.target.closest && e.target.closest("button")) return;
      if (e.offsetX > 8) return;
      e.preventDefault();
      var startX = e.clientX, startW = st.width, moved = false;
      // 拖拽期间禁用 iframe 的指针事件：否则鼠标滑进 iframe 后
      // 父页收不到 mousemove，拖拽会中断。
      var f = els.canvasBox && els.canvasBox.querySelector("iframe");
      if (f) f.style.pointerEvents = "none";
      document.body.style.cursor = "col-resize";
      function mv(ev) {
        moved = true;
        setWidth(startW + (startX - ev.clientX));
      }
      function up() {
        document.removeEventListener("mousemove", mv);
        document.removeEventListener("mouseup", up);
        if (f) f.style.pointerEvents = "";
        document.body.style.cursor = "";
        if (moved) emit("width", { width: st.width });
      }
      document.addEventListener("mousemove", mv);
      document.addEventListener("mouseup", up);
    });
  }

  // ---------- 顶栏开关 ----------
  function bindToggle() {
    var btn = $("#stageToggle") || $("#panelToggle");
    if (!btn) return;
    btn.addEventListener("click", function () { setExpanded(!st.expanded); });
  }

  // ---------- 固定态 tab 切换（接管原缺失的逻辑） ----------
  function bindTabs() {
    var tabs = document.querySelectorAll("#rightSidebar .rs-tab");
    if (!tabs.length) return;
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener("click", function () {
        var name = this.getAttribute("data-rs-tab");
        // 2026-11-09（拆三栏）：固定态多了「群聊」一栏（data-rs-tab="chat"）。
        var map = { fishbowl: "fishbowl", chat: "chat", status: "status" };
        st.tab = map[name] || "fishbowl";
        if (st.expanded) st.view = (st.tab === "status") ? "status" : "activity";
        save();
        apply();
        // 原 tab 的 aria-selected / active 类同步（兼容 status-panel 的观察器）
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
    // 初始同步原 tab 的高亮（原来没人做，状态 tab 首屏是反的）
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
    // 初始渲染时序兜底：布局/字体稳定后再校一次显隐（实测偶发两面板同时可见）
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
    // 调当前画布页注册的函数（agent 的 stage_call 走这里）
    call: callPage,
    // 内部/调试（非契约）
    _toggle: function () { setExpanded(!st.expanded); },
    _width: setWidth,
    _apply: apply,
    // 工具位注册（内置件与将来外部工具共用；内容不走这里）
    registerTool: registerTool,
    tools: function () { return tools.slice(); }
  };

  global.__panel = api;

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})(window);
