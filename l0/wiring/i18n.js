/**
 * i18n — bilingual UI, DOM half (the engine is lib/i18n.ts).
 *
 * Two mechanisms, in the order a paint uses them:
 *
 *   1. **Catalog** (`__i18n.t("oobe.title")`) — the forward path. Catalogs live in
 *      `/locales/zh.json` and `/locales/en.json`, are fetched at boot, and are addressed by stable
 *      key. Both files are fetched for the English UI (en for the active language, zh as the
 *      documented fallback); a Chinese user fetches only zh.
 *   2. **Legacy dictionary** (`tr`) — explains the strings the catalog migration has not reached yet.
 *      Translation runs **after rendering**: the engine matches whole strings exactly, so a user
 *      message, a model reply or a character name cannot equal a UI label and comes back untouched.
 *      The worst case is a miss — which is why the dictionary can grow incrementally without touching
 *      the ~2200 call sites.
 *
 * Two things are easy to break here:
 *   · Concatenated labels never hit the exact dictionary; they need the pattern rules that ship
 *     with the dictionary file.
 *   · Switching back to Chinese reloads the page. The DOM has already been rewritten in place and
 *     reversing that swap is neither cheap nor safe.
 *
 * What stays in this file: the boot catalog load, the DOM walk, the skip lists, the observer, the
 * dialog patch, the pseudo-element override stylesheet and the coverage collector. The dictionary
 * (/shared/core/i18n-dict.js) is fetched lazily and only for the English UI, so a Chinese user
 * pays nothing for it.
 *
 * Readiness: `loadCatalog` is async and a catalog failure must never hold up boot. Copy builders that
 * must not paint a key register with `__i18n.whenReady(fn)`; `__i18n.t` itself stays synchronous and
 * answers from whatever has landed.
 *
 * Switch: Settings -> Appearance -> "English UI (beta)"; localStorage key cfw_ui_lang_v1.
 * Export: window.__i18n = { lang, setLang, tr, t, hasCatalog, loadCatalog, whenReady, applyAll, stats,
 *         catalogStats }.
 */
;(function (global) {
  "use strict";

  // Declared before the engine reads it: `var` hoists, so a later `var LS_LANG` left `env.langKey`
  // undefined (localStorage.getItem(undefined) → the key "undefined") and the English UI could never
  // switch on. Kept at the top on purpose.
  var LS_LANG = "cfw_ui_lang_v1";
  var CATALOG_BASE = "/locales/";

  function fetchJson(url) {
    if (typeof global.fetch !== "function") return Promise.reject(new Error("fetch unavailable"));
    return global.fetch(url, { credentials: "same-origin" }).then(function (res) {
      if (!res || res.ok === false) throw new Error("HTTP " + (res && res.status ? res.status : "?"));
      return res.json();
    });
  }

  var svc = createI18n({
    storage: global.localStorage,
    langKey: LS_LANG,
    catalogBase: CATALOG_BASE,
    fetchJson: fetchJson,
  });

  var DICT_SRC = "/shared/core/i18n-dict.js?v=40"; // bump when the dictionary content changes
  var ATTRS = ["title", "placeholder", "aria-label"];
  // Two skip tiers. The text tier only skips real content areas — it MUST NOT skip select:
  // the text of an <option> is a UI label, and skipping it is why the settings dropdowns stayed
  // Chinese in the English UI. input/textarea hold no text nodes (their value is an attribute),
  // so skipping them only affects the attributes those elements carry.
  // The attribute tier translates title / placeholder / aria-label; input and select are no longer
  // blocked there.
  var TEXT_SKIP = [
    "#msg", "textarea", "[contenteditable='true']",
    "pre", "code", "script", "style",
    ".bubble", ".md-body", ".reasoning-text", ".reasoning-block",
    // `.stats` (the token estimate line) is deliberately NOT skipped: it is UI copy, and an
    // earlier version that treated it as content left Chinese showing in the English UI.
    ".conv-preview", ".char-item", ".dev-panel", "#devHud",
  ].join(",");
  var ATTR_SKIP = [
    "pre", "code", "script", "style",
    ".bubble", ".md-body", ".reasoning-text", ".reasoning-block",
    ".dev-panel", "#devHud",
  ].join(",");
  var CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

  var loading = false;
  var applying = false;

  // Lookup (implementation lives in the service).
  function tr(s) { return svc.tr(s); }
  function t(key, params) { return svc.t(key, params); }
  // Copy descriptors ({ key, params }) come back from services; rendering them is the wiring's job.
  function tCopy(copy) { return svc.tCopy(copy); }

  function inSkipText(node) {
    var el = node.nodeType === 1 ? node : node.parentElement;
    if (!el || !el.closest) return false;
    try { return !!el.closest(TEXT_SKIP); } catch (e) { return false; }
  }
  function inSkipAttr(el) {
    if (!el || !el.closest) return false;
    try { return !!el.closest(ATTR_SKIP); } catch (e) { return false; }
  }

  function doText(node) {
    if (!node || node.nodeType !== 3) return;
    var v = node.nodeValue;
    if (!v || !CJK.test(v) || inSkipText(node)) return;
    var next = tr(v);
    if (next !== v) { applying = true; node.nodeValue = next; applying = false; }
  }

  function doAttrs(el) {
    if (!el || el.nodeType !== 1 || !el.getAttribute) return;
    if (inSkipAttr(el)) return;
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
    svc.stats().nodes++;
    if (node.nodeType === 3) { doText(node); return; }
    if (node.nodeType !== 1) return;
    if (inSkipText(node)) return;
    doAttrs(node);
    for (var c = node.firstChild; c; c = c.nextSibling) walk(c);
  }

  // Observer: content rendered after the first pass is translated the same way.
  var pending = null;
  function schedule(nodes) {
    // `ready` was a free variable here for as long as the English UI was unreachable (the langKey
    // hoisting bug above kept it off), so every late mutation threw a ReferenceError in the observer
    // and late content silently stayed Chinese. Ask the engine — it is the only source of truth.
    if (!svc.ready()) return;
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

  // alert/confirm text is not in the DOM, so patch them directly. Still an exact whole-string
  // match, so the safety argument above holds.
  function patchDialogs() {
    try {
      var _alert = global.alert, _confirm = global.confirm;
      global.alert = function (m) { return _alert.call(global, tr(String(m))); };
      global.confirm = function (m) { return _confirm.call(global, tr(String(m))); };
    } catch (e) {}
  }

  // Load the dictionary lazily, then replace everything and attach the observer.
  function loadDict(cb) {
    if (svc.ready()) { cb && cb(); return; }
    if (loading) return;
    loading = true;
    var s = document.createElement("script");
    s.src = DICT_SRC;
    s.onload = function () {
      try {
        svc.loadFrom(global.i18nDict || {}, global.i18nPatterns);
      } catch (e) {}
      loading = false;
      cb && cb();
    };
    s.onerror = function () { loading = false; };
    document.head.appendChild(s);
  }

  // Pseudo-element copy (such as the three thinking-effort labels) is not a text node, so the
  // DOM walk cannot reach it. With the English UI on, an override stylesheet is injected and the
  // translated labels come from the dictionary. A new pseudo-element only needs one more selector
  // line below.
  function injectPseudoOverrides() {
    var rules = [
      ['#composer #thinkToggle.active[data-mobile-effort="minimal"] .think-label::after', "极低"],
      ['#composer #thinkToggle.active[data-mobile-effort="low"] .think-label::after', "低"],
      ['#composer #thinkToggle.active[data-mobile-effort="medium"] .think-label::after', "中"],
      ['#composer #thinkToggle.active[data-mobile-effort="high"] .think-label::after', "高"],
      ['#composer #thinkToggle.active[data-mobile-effort="max"] .think-label::after', "最高"],
      ['#composer #thinkToggle.active[data-mobile-effort="xhigh"] .think-label::after', "更高"],
    ];
    var css = "";
    for (var i = 0; i < rules.length; i++) {
      var label = tr(rules[i][1]);
      if (label !== rules[i][1]) {
        css += rules[i][0] + ' { content: "' + label.replace(/"/g, '\\"') + '" !important; }\n';
      }
    }
    if (!css) return;
    var st = document.createElement("style");
    st.id = "i18nPseudoOverrides";
    st.textContent = css;
    document.head.appendChild(st);
  }

  // Collector: lists the nodes still showing Chinese that the dictionary does not cover, which is
  // how coverage is measured. Manual only — run window.__i18n.collect() in the console. It works
  // in the mobile app too, which is the point of having it.
  function coveredByPattern(s) { return svc.coveredByPattern(s); }
  function collect() {
    var out = Object.create(null);
    (function w(n) {
      if (n.nodeType === 3) {
        var s = (n.nodeValue || "").trim();
        if (s && CJK.test(s) && s.length <= 120 && !inSkipText(n) && !svc.has(s) && !coveredByPattern(s)) {
          out[s] = (out[s] || 0) + 1;
        }
        return;
      }
      if (n.nodeType !== 1 || inSkipAttr(n)) return;
      for (var c = n.firstChild; c; c = c.nextSibling) w(c);
    })(document.body);
    return Object.keys(out).sort(function (a, b) { return out[b] - out[a]; });
  }

  function applyAll() {
    if (svc.lang() !== "en") return;
    loadDict(function () {
      applying = true;
      walk(document.body);
      applying = false;
      startObserver();
      injectPseudoOverrides();

    });
  }

  function setLang(next) {
    svc.setLang(next);
    // Full reload: English -> Chinese has to restore the original copy, and Chinese -> English
    // gets a clean first-pass replacement this way.
    location.reload();
  }

  global.__i18n = {
    get lang() { return svc.lang(); },
    setLang: setLang,
    tr: tr,
    t: t,
    tCopy: tCopy,
    hasCatalog: svc.hasCatalog,
    loadCatalog: svc.loadCatalog,
    whenReady: svc.whenReady,
    get catalogReady() { return svc.catalogReady(); },
    catalogStats: svc.catalogStats,
    applyAll: applyAll,
    collect: collect,
    get stats() { return svc.stats(); },
    get ready() { return svc.ready(); },
    _dictSize: function () { return svc.dictSize(); },
  };

  // Catalog kick-off. Started here (not on DOMContentLoaded) so the two small files are in flight
  // while the remaining ~170 boot scripts run; a failure is recorded, never thrown.
  try {
    svc.loadCatalog("zh");
    if (svc.lang() === "en") svc.loadCatalog("en");
  } catch (e) {}

  if (svc.lang() === "en") {
    try { document.documentElement.classList.add("i18n-en"); document.documentElement.lang = "en"; } catch (e) {}
    patchDialogs();
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", applyAll);
    } else {
      applyAll();
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
