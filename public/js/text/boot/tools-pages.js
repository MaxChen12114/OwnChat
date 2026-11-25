// public/js/text/boot/tools-pages.js — 工具页入口渲染（目录即入口）
// ─────────────────────────────────────────────────────────────
// 数据源是构建期注入的 #toolsPageCatalog（l0/build.mjs 扫 public/tools/<id>/tool.json 生成），
// 本脚本只负责把它渲染成侧栏入口。没有 tool.json 的目录不产生入口；一个都没有时整段隐藏。
// 文本一律走 textContent（清单虽由本仓维护，但入口是「可增删的数据」，不按代码信任）。
// 图标按 key 从固定表取；未知 key 用默认图标，不让新页面因少画一个图标就消失。
(function () {
  "use strict";
  var host = document.getElementById("toolsPageList");
  if (!host) return;
  var titleEl = document.getElementById("toolsPageSection");
  var pages = [];
  try {
    var raw = document.getElementById("toolsPageCatalog");
    var data = raw ? JSON.parse(raw.textContent || "") : null;
    if (data && Array.isArray(data.pages)) pages = data.pages;
  } catch (e) {
    pages = [];
  }
  var ICONS = {
    studio: '<path d="M4 20l4-1 9.6-9.6a2 2 0 0 0-2.8-2.8L5.4 16z"/><path d="M13.5 6.3l4.2 4.2"/>',
    write: '<path d="M7 3.5h7L18.5 8v12.5H7z"/><path d="M14 3.5V8h4.5"/><path d="M9.5 12.5h6M9.5 15.5h6M9.5 18h3.5"/>',
    flow: '<path d="M9 8l-4 4 4 4"/><path d="M15 8l4 4-4 4"/><path d="M13.2 5l-2.4 14"/>',
    coding: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M8 10l-2.2 2.2L8 14.4"/><path d="M13 9.5l-2 5.5"/>',
    audio: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
    sandbox: '<path d="M3 6.5l6-2 6 2 6-2v13l-6 2-6-2-6 2z"/><path d="M9 4.5v13M15 6.5v13"/>',
  };
  var FALLBACK = '<rect x="4" y="4" width="16" height="16" rx="3"/>';
  var SVG_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  if (pages.length === 0) {
    host.style.display = "none";
    if (titleEl) titleEl.style.display = "none";
    return;
  }
  // 构建期已按 order 排过；这里再排一次是防御：目录块被人手改过也不会乱序。
  pages = pages.slice().sort(function (a, b) {
    var oa = typeof a.order === "number" ? a.order : 0;
    var ob = typeof b.order === "number" ? b.order : 0;
    if (oa !== ob) return oa - ob;
    return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
  });
  for (var i = 0; i < pages.length; i++) {
    var p = pages[i];
    var a = document.createElement("a");
    a.className = "sidebar-btn";
    a.id = String(p.id) + "ToolBtn";
    a.href = String(p.href);
    a.target = "_blank";
    a.rel = "noopener";
    a.title = typeof p.desc === "string" && p.desc ? p.desc : String(p.label);
    var icon = document.createElement("span");
    icon.className = "sidebar-btn-icon";
    icon.innerHTML = SVG_OPEN + (ICONS[p.icon] || FALLBACK) + "</svg>";
    var label = document.createElement("span");
    label.className = "sidebar-btn-label";
    label.textContent = String(p.label);
    a.appendChild(icon);
    a.appendChild(label);
    host.appendChild(a);
  }
})();
