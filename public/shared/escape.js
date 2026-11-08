// shared/escape.js — HTML 转义唯一实现（2026-11-08 收口）
// 此前 15+ 处各自定义 esc/safe，行为漂移（multi-agent 的版本不转义双引号 → 属性逃逸）。
// 统一从这里取：转义 & < > " '（文本与属性通用，文本里的引号转义后渲染不变）。
(function () {
  "use strict";
  if (window.__ownEscape) return;
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  window.__ownEscape = { esc: esc };
})();
