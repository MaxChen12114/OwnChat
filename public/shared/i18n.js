/**
 * i18n.js — 界面中英双语（运行时"插件"式实现，零依赖）
 * ─────────────────────────────────────────────────────────────────────────────
 * 设计取舍（2026-10-07，作者定稿：做成插件脚本，不做全量重写）：
 *   · 本文件是**引擎**：字典在 /shared/i18n-dict.js，只在用户启用英文时按需加载（中文用户零开销）。
 *   · 翻译发生在**渲染之后**：扫描 DOM 文本节点与白名单属性，用字典做整串替换。
 *     因为匹配是"整串精确命中"，用户内容/模型输出/角色名不会命中字典 → 天然不会被误翻；
 *     但气泡等区域仍在跳过清单里（性能 + 保险）。
 *   · 拼接串（`'已加 ' + n + ' 条'`）交给词典里的 pattern 规则（见字典文件）。
 *   · 覆盖度只取决于字典命中率：字典可以增量补（甚至社区贡献），不用回头改 2200 处调用点。
 *   · 切回中文 = 整页刷新（DOM 已被替换，反向还原不划算也不安全）。
 *
 * 开关：设置 → 外观 → 「English UI (beta)」；localStorage 键 cfw_ui_lang_v1（'en' / 'zh'）。
 * 出口：window.__i18n = { lang, setLang, tr, applyAll, stats }
 */
;(function (global) {
  "use strict";

  var LS_LANG = "cfw_ui_lang_v1";
  var DICT_SRC = "/shared/i18n-dict.js";
  var ATTRS = ["title", "placeholder", "aria-label"];
  // 跳过清单：输入框、代码、模型输出/用户内容相关区域、推理与统计块、脚本样式
  var SKIP_SEL = [
    "#msg", "textarea", "input", "select", "[contenteditable='true']",
    "pre", "code", "script", "style",
    ".bubble", ".md-body", ".reasoning-text", ".reasoning-block", ".stats",
    ".conv-preview", ".char-item", ".dev-panel", "#devHud"
  ].join(",");
  var CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

  var lang = (function () {
    try { return localStorage.getItem(LS_LANG) === "en" ? "en" : "zh"; } catch (e) { return "zh"; }
  })();

  var dict = Object.create(null);
  var patterns = [];
  var ready = false;
  var loading = false;
  var applying = false;
  var stats = { applied: 0, misses: 0, nodes: 0 };

  // ── 查表 ────────────────────────────────────────────────────────────────────
  function tr(s) {
    if (!s) return s;
    var key = s.trim();
    if (!key || !CJK.test(key)) return s;
    var hit = dict[key];
    if (hit != null) { stats.applied++; return s.replace(key, hit); }
    for (var i = 0; i < patterns.length; i++) {
      var m = patterns[i][0].exec(key);
      if (m) {
        var out = key.replace(patterns[i][0], patterns[i][1]);
        if (out !== key) { stats.applied++; return s.replace(key, out); }
      }
    }
    stats.misses++;
    return s;
  }

  function inSkip(node) {
    var el = node.nodeType === 1 ? node : node.parentElement;
    if (!el || !el.closest) return false;
    try { return !!el.closest(SKIP_SEL); } catch (e) { return false; }
  }

  function doText(node) {
    if (!node || node.nodeType !== 3) return;
    var v = node.nodeValue;
    if (!v || !CJK.test(v) || inSkip(node)) return;
    var next = tr(v);
    if (next !== v) { applying = true; node.nodeValue = next; applying = false; }
  }

  function doAttrs(el) {
    if (!el || el.nodeType !== 1 || !el.getAttribute) return;
    if (inSkip(el)) return;
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i];
      var v = el.getAttribute(a);
      if (!v || !CJK.test(v)) continue;
      var next = tr(v);
      if (next !== v) { applying = true; el.setAttribute(a, next); applying = false; }
    }
  }

  function walk(node) {
    if (!node) return;
    stats.nodes++;
    if (node.nodeType === 3) { doText(node); return; }
    if (node.nodeType !== 1) return;
    if (inSkip(node)) return;
    doAttrs(node);
    for (var c = node.firstChild; c; c = c.nextSibling) walk(c);
  }

  // ── 观察者：渲染后的新内容同样翻译 ─────────────────────────────────────────
  var pending = null;
  function schedule(nodes) {
    if (!ready) return;
    if (!pending) pending = [];
    for (var i = 0; i < nodes.length; i++) pending.push(nodes[i]);
    if (pending.__t) return;
    pending.__t = setTimeout(function () {
      var list = pending; pending = null;
      applying = true;
      for (var i = 0; i < list.length; i++) {
        var n = list[i];
        if (!n || !n.isConnected) continue;
        if (n.nodeType === 3) doText(n);
        else if (n.nodeType === 1) { doAttrs(n); for (var c = n.firstChild; c; c = c.nextSibling) walk(c); }
      }
      applying = false;
    }, 40);
  }

  function startObserver() {
    try {
      var mo = new MutationObserver(function (records) {
        if (applying) return;
        var batch = [];
        for (var i = 0; i < records.length; i++) {
          var r = records[i];
          if (r.type === "childList") {
            for (var j = 0; j < r.addedNodes.length; j++) batch.push(r.addedNodes[j]);
          } else if (r.type === "characterData") {
            batch.push(r.target);
          } else if (r.type === "attributes") {
            batch.push(r.target);
          }
        }
        if (batch.length) schedule(batch);
      });
      mo.observe(document.documentElement, {
        childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ATTRS,
      });
    } catch (e) { /* 观察者失败不影响一次性全量替换 */ }
  }

  // alert / confirm 的内容不在 DOM 里，单独猴补（仍是整串精确命中，安全）
  function patchDialogs() {
    try {
      var _alert = global.alert, _confirm = global.confirm;
      global.alert = function (m) { return _alert.call(global, tr(String(m))); };
      global.confirm = function (m) { return _confirm.call(global, tr(String(m))); };
    } catch (e) {}
  }

  // ── 加载字典（懒）→ 全量替换 → 挂观察者 ────────────────────────────────────
  function loadDict(cb) {
    if (ready) { cb && cb(); return; }
    if (loading) return;
    loading = true;
    var s = document.createElement("script");
    s.src = DICT_SRC;
    s.onload = function () {
      try {
        var d = global.__i18nDict || {};
        for (var k in d) if (Object.prototype.hasOwnProperty.call(d, k)) dict[k] = d[k];
        patterns = Array.isArray(global.__i18nPatterns) ? global.__i18nPatterns : [];
      } catch (e) {}
      ready = true; loading = false;
      cb && cb();
    };
    s.onerror = function () { loading = false; };
    document.head.appendChild(s);
  }

  function applyAll() {
    if (lang !== "en") return;
    loadDict(function () {
      applying = true;
      walk(document.body);
      applying = false;
      startObserver();
      stats.__done = true;
    });
  }

  function setLang(next) {
    var v = next === "en" ? "en" : "zh";
    try { localStorage.setItem(LS_LANG, v); } catch (e) {}
    // 整页刷新：英文→中文需要还原文案，中文→英文走一遍干净的首屏替换
    location.reload();
  }

  global.__i18n = {
    get lang() { return lang; },
    setLang: setLang,
    tr: tr,
    applyAll: applyAll,
    stats: stats,
    get ready() { return ready; },
    _dictSize: function () { return Object.keys(dict).length; },
  };

  if (lang === "en") {
    try { document.documentElement.classList.add("i18n-en"); document.documentElement.lang = "en"; } catch (e) {}
    patchDialogs();
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", applyAll);
    } else {
      applyAll();
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
