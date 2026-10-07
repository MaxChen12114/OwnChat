// public/js/text/ui/sidebar-groups.js — 左栏分组折叠 · 2026-09-14
//
// 为什么需要:左栏 800px 高、4 个分组共占 696px(16 个 38px 按钮),再放会话列表就没地方了。
// 把分组标题行变成可点击的折叠开关,默认只展开「模式」,其余收起 → 腾出约 460px。
//
// 实现要点(刻意不改 index.html 的 HTML):
//   运行时扫描 .sidebar-nav,把每个 .sidebar-section-title 及其后的兄弟按钮包进 .sb-group,
//   标题行加折叠箭头变可点击。好处是以后新增侧栏按钮自动纳入分组,不用改模板。
// 折叠状态存 LS cfw_sidebar_folded_v1 = { [分组名]: true }(true=收起)。
// 幂等:已包裹过就跳过;并监听 .sidebar-nav 的 childList,自动包裹后插入的新分组(如会话列表)。
(function () {
  "use strict";
  if (window.__sidebarGroups) return;

  var LS_FOLDED = "cfw_sidebar_folded_v1";
  var STYLE_ID = "sbGroupStyles";
  // 首次运行的默认折叠状态:只展开「模式」「对话」(最常用的两个),其余收起
  var DEFAULT_EXPANDED = ["模式", "对话"];
  var CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';

  var CSS_TEXT = `
/* 分组容器:必须复刻 .sidebar-nav 的 flex 列 + 4px gap —— 原来按钮是 nav 的直接子元素,
   间距由 nav 的 gap 提供;包进 .sb-group 后若用普通 block,组内按钮会贴在一起(间距丢失)。 */
.sb-group{display:flex;flex-direction:column;gap:4px;}
/* 分组标题行 = 可点击的折叠开关。
   两处关键:① 它本身就是按钮(折叠是高频操作),所以体量要跟组内 .sidebar-btn 匹配 ——
   原来只有 30px 高 / 10.5px 字号 / #666 灰,相对 38px/13px 的按钮太瘦太暗(比例 0.79),
   现改为 36px / 12.5px / 600 权重,颜色交给各主题的 .sidebar-section-title 规则(不写死灰)。
   ② 箭头要够显眼:15px、常态 opacity .8、悬停满亮 + 浅色底块。 */
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
      var m = JSON.parse(localStorage.getItem(LS_FOLDED) || "{}");
      return (m && typeof m === "object" && !Array.isArray(m)) ? m : {};
    } catch (e) { return {}; }
  }
  function saveFolded(m) { try { localStorage.setItem(LS_FOLDED, JSON.stringify(m)); } catch (e) {} }

  function navEl() { return document.querySelector("#leftSidebar .sidebar-nav") || document.querySelector(".sidebar-nav"); }

  // 把「标题 + 其后兄弟」包进 .sb-group(幂等)
  function wrapAll() {
    var nav = navEl();
    if (!nav) return false;
    var kids = Array.prototype.slice.call(nav.children);
    var starts = [];
    kids.forEach(function (el, i) {
      if (el.classList && el.classList.contains("sidebar-section-title") && !el.closest(".sb-group")) starts.push(i);
    });
    if (!starts.length) return false;
    var frag = document.createDocumentFragment();
    kids.slice(0, starts[0]).forEach(function (el) { if (!el.closest(".sb-group")) frag.appendChild(el); });
    starts.forEach(function (start, n) {
      var end = (n + 1 < starts.length) ? starts[n + 1] : kids.length;
      var title = kids[start];
      var g = document.createElement("div");
      g.className = "sb-group";
      g.dataset.sbGroup = (title.textContent || "").trim();
      if (!title.classList.contains("sb-group-head")) {
        title.classList.add("sb-group-head");
        title.setAttribute("role", "button");
        title.setAttribute("tabindex", "0");
        title.setAttribute("aria-label", g.dataset.sbGroup + " 分组,点击展开/收起");
        var chev = document.createElement("span");
        chev.className = "sb-chev";
        chev.innerHTML = CHEV;
        title.appendChild(chev);
      }
      g.appendChild(title);
      kids.slice(start + 1, end).forEach(function (el) {
        if (!el.closest(".sb-group")) g.appendChild(el);
      });
      frag.appendChild(g);
    });
    nav.appendChild(frag);
    return true;
  }

  function applyFold() {
    var st = loadFolded();
    Array.prototype.forEach.call(document.querySelectorAll(".sb-group"), function (g) {
      var k = g.dataset.sbGroup || "";
      var folded = (k in st) ? !!st[k] : (DEFAULT_EXPANDED.indexOf(k) < 0);
      g.classList.toggle("sb-folded", folded);
    });
  }

  function toggle(g) {
    var k = g.dataset.sbGroup || "";
    var folded = !g.classList.contains("sb-folded");
    g.classList.toggle("sb-folded", folded);
    var st = loadFolded();
    st[k] = folded;
    saveFolded(st);
  }

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
    if (e.key !== "Enter" && e.key !== " ") return;
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
      // 标题行点击/键盘(事件委托,包裹后新插入的分组同样生效)
      nav.addEventListener("click", onClick);
      nav.addEventListener("keydown", onKey);
      // 新分组(例如 conv-list.js 插入的「对话」)自动纳入
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

  window.__sidebarGroups = { refresh: function () { if (wrapAll()) applyFold(); }, applyFold: applyFold };
})();
