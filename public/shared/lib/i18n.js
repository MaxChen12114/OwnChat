(function () {
/**
 * The translation engine: a key catalog (v2) in front of the legacy exact-string dictionary, plus the
 * counters behind both.
 *
 * Two engines, one file, deliberately:
 *
 *   · **Catalog (`t`)** — the forward path. UI copy is addressed by a stable key
 *     (`"oobe.steps.password.title"`), the text lives in `/locales/<lang>.json`, and rendering asks
 *     for the key. Params interpolate with `{name}`; plurals use the ICU subset
 *     `{count, plural, one{…} other{…}}` (exact `=0{…}` selectors and `#` also work). A key missing
 *     from the active language falls back to `zh` and is counted; a key missing everywhere returns
 *     the key itself and is counted, so a coverage report can list exactly what to translate.
 *
 *   · **Legacy dictionary (`tr`)** — the safety net for the ~2200 call sites not migrated yet.
 *     It translates **after rendering**, matching whole strings exactly. A user's message, a model's
 *     output or a character name will not equal a UI label, so it cannot be mistranslated by
 *     accident — the worst case is a miss. That is also why the dictionary can grow incrementally
 *     (even from outside contributions) without touching the call sites.
 *
 * Two subtleties live in `tr()` and are easy to break:
 *   · Only CJK strings are looked up. An English string is returned untouched, so re-running the pass
 *     is harmless and the dictionary never has to contain its own output.
 *   · The hit is spliced back into the **original** string via `s.replace(key, hit)`, where `key` is the
 *     trimmed form. Leading and trailing whitespace around a label therefore survives translation —
 *     replacing `s` wholesale would collapse the layout spacing that DOM text nodes rely on.
 *
 * Concatenated strings (`'已加 ' + n + ' 条'`) go through the pattern rules instead; a pattern that does
 * not change the text counts as a miss, not a hit.
 *
 * Loading posture (why `t()` can be synchronous even though a catalog is a file):
 *   `loadCatalog` is kicked off at boot and `t()` answers from whatever is loaded. A caller that must
 *   not paint a key registers with `whenReady(fn)`; the copy builders in the pilot namespaces do.
 *   A failed load never throws and never blocks boot — the legacy dictionary still covers the old UI,
 *   and `catalogStats()` reports the failure.
 *
 * The DOM walking, skip lists, observer and dialog patching stay in the wiring.
 *
 * Lock: `test/i18n-catalog.test.mjs`.
 * @module lib/i18n
 */

                               

/** Interpolation values. `count` additionally drives the plural form. */
                                             

/** `[pattern, replacement]` pairs from the dictionary file. */
                                           

                            
                  
                 
                
 

/** What a coverage report needs to know about the catalog half. */
                               
             
                                                                                    
                 
                                                        
               
                                                            
                 
                                                                                 
                       
                                                         
                 
                                            
                                                     
                                                               
                    
 

                          
               
                               
                                                                                                              
                         
                                                                                     
                                           
     
                                                                                                  
                                                                                                
     
                               
                                                                                  
                                                    
                                                                                       
                                               
                          
                                                                                    
                                  
                               
                                                          
                                                      
                   
                     
                     
                                        
                                                                                    
                           
 

                          
                                                                                              
                  
                                                                                                 
                       
                                                              
                                                
 

const I18N_CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

/** unknown → plain-object view; null, arrays and scalars become an empty object. */
function recOf(value         )                          {
  const out                          = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value);
    for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  }
  return out;
}

/**
 * Flatten `{ oobe: { title: "…" } }` into `"oobe.title" → "…"`. Dotted segments mean a key can never
 * contain a dot of its own; the audit enforces that shape. `$`-prefixed keys are file metadata
 * (version/updated) and never messages.
 */
function flattenInto(source         , prefix        , out                     )       {
  const record = recOf(source);
  const keys = Object.keys(record);
  for (let i = 0; i < keys.length; i++) {
    const name = keys[i];
    if (name.charAt(0) === "$") continue;
    const value = record[name];
    const full = prefix === "" ? name : prefix + "." + name;
    if (typeof value === "string") {
      if (value !== "") out.set(full, value);
      continue;
    }
    if (value && typeof value === "object") flattenInto(value, full, out);
  }
}

/** Index of the `}` matching the `{` at `open`, or -1 when the braces do not balance. */
function closingBrace(text        , open        )         {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** `one{…} other{…}` → selector/body pairs, in source order. */
function readSelectors(body        )                                       {
  const out                                       = [];
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i++;
    if (i >= body.length) break;
    let j = i;
    while (j < body.length && body[j] !== "{") j++;
    if (j >= body.length) break;
    const sel = body.slice(i, j).trim();
    const close = closingBrace(body, j);
    if (close < 0) break;
    out.push({ sel: sel, body: body.slice(j + 1, close) });
    i = close + 1;
  }
  return out;
}

/**
 * Plural selector for a count. English inflects on exactly one; Chinese does not inflect at all, so a
 * zh message should carry a single `other` branch (writing `one` there would still work but the
 * `other` branch is what readers expect).
 */
function pluralForm(lang      , count        )         {
  if (lang === "en") return count === 1 ? "one" : "other";
  return "other";
}

/** `{name}` → the param, or the placeholder itself when the param is missing (a visible bug). */
function paramText(name        , params                    )         {
  if (!params) return "{" + name + "}";
  const value = params[name];
  if (value === undefined || value === null) return "{" + name + "}";
  return String(value);
}

/** Renders one branch body: `#` becomes the count, then `{name}` interpolation runs. */
function formatPlural(lang      , rawCount         , body        , params                    )         {
  const count = Number(rawCount);
  const n = Number.isFinite(count) ? count : 0;
  const branches = readSelectors(body);
  if (!branches.length) return "";
  let chosen = "";
  for (let i = 0; i < branches.length; i++) {
    if (branches[i].sel === "=" + String(n)) {
      chosen = branches[i].body;
      break;
    }
  }
  if (chosen === "") {
    const form = pluralForm(lang, n);
    for (let i = 0; i < branches.length; i++) {
      if (branches[i].sel === form) {
        chosen = branches[i].body;
        break;
      }
    }
  }
  if (chosen === "") {
    for (let i = 0; i < branches.length; i++) {
      if (branches[i].sel === "other") {
        chosen = branches[i].body;
        break;
      }
    }
  }
  if (chosen === "") chosen = branches[0].body;
  // `#` inside a plural branch is the count in ICU. Split on it so a `{name}` in the same branch still
  // gets interpolated; the count itself is already a string by then.
  const parts = chosen.split("#");
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) out += String(n);
    out += formatMessage(lang, parts[i], params);
  }
  return out;
}

/** The message formatter: `{name}`, `{count, plural, …}` and plain text. Unknown braces stay literal. */
function formatMessage(lang      , message        , params                    )         {
  let out = "";
  let i = 0;
  while (i < message.length) {
    const c = message[i];
    if (c !== "{") {
      out += c;
      i++;
      continue;
    }
    const close = closingBrace(message, i);
    if (close < 0) {
      out += c;
      i++;
      continue;
    }
    const inner = message.slice(i + 1, close);
    const comma1 = inner.indexOf(",");
    if (comma1 < 0) {
      out += paramText(inner.trim(), params);
      i = close + 1;
      continue;
    }
    const name = inner.slice(0, comma1).trim();
    const rest = inner.slice(comma1 + 1);
    const comma2 = rest.indexOf(",");
    const kind = (comma2 < 0 ? rest : rest.slice(0, comma2)).trim();
    if (kind === "plural") {
      const body = comma2 < 0 ? "" : rest.slice(comma2 + 1);
      const count = params ? params[name] : 0;
      out += formatPlural(lang, count, body, params);
      i = close + 1;
      continue;
    }
    // Unknown argument kind (number/date/select are out of scope): keep the raw text so the mistake is
    // visible instead of silently rendering half a sentence.
    out += message.slice(i, close + 1);
    i = close + 1;
  }
  return out;
}

function createI18n(env         )          {
  let lang       = (function () {
    try {
      return env.storage.getItem(env.langKey) === "en" ? "en" : "zh";
    } catch (e) {
      return "zh";
    }
  })();

  const dict                         = Object.create(null);
  let patterns                = [];
  let isReady = false;
  const counters            = { applied: 0, misses: 0, nodes: 0 };

  // ── catalog state ──────────────────────────────────────────────────────────────────────────────
  const catalogs                                           = { zh: null, en: null };
  const inFlight                                        = { zh: null, en: null };
  const missing                         = Object.create(null);
  const readyHooks                    = [];
  let catalogState                   = "idle";
  let fallbackHits = 0;
  let catalogMisses = 0;
  let lastError = "";

  function asLang(value         )       {
    return value === "en" ? "en" : "zh";
  }

  function markCatalogReady()       {
    if (catalogState === "ready") return;
    catalogState = "ready";
    const hooks = readyHooks.splice(0, readyHooks.length);
    for (let i = 0; i < hooks.length; i++) {
      try {
        hooks[i]();
      } catch (e) {
        // A copy builder that throws must not take the other hooks down with it.
      }
    }
  }

  function install(langName      , data         )          {
    const map = new Map                ();
    flattenInto(data, "", map);
    if (!map.size) return false; // an empty or malformed catalog is a failure, not a success
    catalogs[langName] = map;
    lastError = "";
    return true;
  }

  function loadCatalog(name         )                   {
    const target = asLang(name);
    if (catalogs[target] !== null) {
      if (target === lang) markCatalogReady();
      return Promise.resolve(true);
    }
    const pending = inFlight[target];
    if (pending !== null) return pending;
    const fetchJson = env.fetchJson;
    if (typeof fetchJson !== "function") {
      lastError = "no fetch";
      if (target === lang) markCatalogReady();
      return Promise.resolve(false);
    }
    const base = env.catalogBase || "/locales/";
    const url = base + target + ".json";
    const promise = Promise.resolve()
      .then(function () {
        return fetchJson(url);
      })
      .then(
        function (data) {
          const ok = install(target, data);
          if (!ok) lastError = "empty catalog: " + url;
          return ok;
        },
        function (error) {
          lastError = (error && error.message ? String(error.message) : String(error)) + " (" + url + ")";
          return false;
        },
      )
      .then(function (ok) {
        inFlight[target] = null;
        if (target === lang) markCatalogReady();
        return ok;
      });
    inFlight[target] = promise;
    return promise;
  }

  /**
   * @returns the translated string, or the input unchanged. Counters are bumped on hit and miss, so a
   * coverage report can tell "not in the dictionary" apart from "not UI text".
   */
  function tr(value         )         {
    const s = typeof value === "string" ? value : value == null ? "" : String(value);
    if (!s) return s;
    const key = s.trim();
    if (!key || !I18N_CJK.test(key)) return s;
    const hit = dict[key];
    if (hit != null) {
      counters.applied++;
      return s.replace(key, hit);
    }
    for (let i = 0; i < patterns.length; i++) {
      const rule = patterns[i];
      if (rule[0].exec(key)) {
        const out = key.replace(rule[0], rule[1]);
        if (out !== key) {
          counters.applied++;
          return s.replace(key, out);
        }
      }
    }
    counters.misses++;
    return s;
  }

  /**
   * Catalog lookup. Order: active language → zh → the key. Every step is counted so
   * `catalogStats()` can answer "what is missing" without a browser session.
   */
  function t(key         , params         )         {
    const id = typeof key === "string" ? key : key == null ? "" : String(key);
    if (!id) return "";
    const active = catalogs[lang];
    const hit = active !== null ? active.get(id) : undefined;
    if (hit !== undefined) return formatMessage(lang, hit, params);
    const zhHit = catalogs.zh !== null ? catalogs.zh.get(id) : undefined;
    if (zhHit !== undefined) {
      fallbackHits++;
      return formatMessage("zh", zhHit, params);
    }
    catalogMisses++;
    missing[id] = (missing[id] || 0) + 1;
    return id;
  }

  function hasCatalog(key         , which          )          {
    const id = typeof key === "string" ? key : key == null ? "" : String(key);
    if (!id) return false;
    const map = catalogs[which === undefined ? lang : asLang(which)];
    return map !== null && map.has(id);
  }

  /**
   * Renders a copy descriptor. This is the bridge between a service (which must not know about the
   * DOM or the engine) and the catalog: the service answers `{ key: "settings.deploy.profile.guest" }`
   * and the wiring renders it here. Nested descriptors are rendered depth-first, so
   * `{ key: "capability.line", params: { profile: { key: "profile.guest" } } }` works.
   */
  function tCopy(copy         )         {
    const record = recOf(copy);
    const key = typeof record.key === "string" ? record.key : "";
    if (!key) return "";
    const raw = recOf(record.params);
    const params         = {};
    const names = Object.keys(raw);
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const value = raw[name];
      const nested = recOf(value);
      params[name] = typeof nested.key === "string" ? tCopy(value) : value;
    }
    return t(key, params);
  }

  function catalogStats()               {
    const out                                        = [];
    const keys = Object.keys(missing);
    for (let i = 0; i < keys.length; i++) out.push({ key: keys[i], count: missing[keys[i]] });
    out.sort(function (a, b) {
      return b.count - a.count;
    });
    const active = catalogs[lang];
    const zhMap = catalogs.zh;
    return {
      lang: lang,
      ready: catalogState === "ready",
      keys: active !== null ? active.size : 0,
      zhKeys: zhMap !== null ? zhMap.size : 0,
      fallbackHits: fallbackHits,
      misses: catalogMisses,
      missingKeys: out,
      lastError: lastError,
    };
  }

  function loadFrom(dictObj         , patternList         )       {
    try {
      if (dictObj && typeof dictObj === "object") {
        for (const [k, v] of Object.entries(dictObj)) {
          if (typeof v === "string") dict[k] = v;
        }
      }
      const list = Array.isArray(patternList) ? patternList : [];
      const out                = [];
      for (const p of list) {
        if (Array.isArray(p) && p[0] instanceof RegExp && typeof p[1] === "string") {
          out.push([p[0], p[1]]);
        }
      }
      patterns = out;
    } catch (e) {
      // A malformed dictionary leaves the engine on whatever it already had.
    }
    isReady = true;
  }

  /** True when a pattern rule would rewrite this string — used by the coverage collector. */
  function coveredByPattern(value         )          {
    const s = typeof value === "string" ? value : value == null ? "" : String(value);
    for (let i = 0; i < patterns.length; i++) {
      try {
        if (patterns[i][0].test(s)) return true;
      } catch (e) {
        // A broken rule must not stop the scan.
      }
    }
    return false;
  }

  function has(value         )          {
    const key = (typeof value === "string" ? value : value == null ? "" : String(value)).trim();
    return key !== "" && dict[key] != null;
  }

  function setLang(next         )       {
    lang = asLang(next);
    try {
      env.storage.setItem(env.langKey, lang);
    } catch (e) {
      // A blocked store still switches for this session.
    }
    // The wiring reloads on a switch, so readiness belongs to the new language: an unloaded one goes
    // back to "not ready" and the hook fires when its catalog lands.
    if (catalogs[lang] !== null) markCatalogReady();
    else catalogState = "idle";
    return lang;
  }

  return {
    lang: () => lang,
    setLang: setLang,
    tr: tr,
    t: t,
    tCopy: tCopy,
    hasCatalog: hasCatalog,
    loadCatalog: loadCatalog,
    catalogReady: () => catalogState === "ready",
    whenReady: function (fn) {
      if (typeof fn !== "function") return;
      if (catalogState === "ready") {
        fn();
        return;
      }
      readyHooks.push(fn);
    },
    catalogStats: catalogStats,
    loadFrom: loadFrom,
    ready: () => isReady,
    dictSize: () => Object.keys(dict).length,
    stats: () => counters,
    coveredByPattern: coveredByPattern,
    has: has,
  };
}

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

  var DICT_SRC = "/shared/core/i18n-dict.js?v=41"; // bump when the dictionary content changes
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

globalThis.createI18n = createI18n;
})();
