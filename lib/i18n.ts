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

export type Lang = "en" | "zh";

/** Interpolation values. `count` additionally drives the plural form. */
export type Params = Record<string, unknown>;

/** `[pattern, replacement]` pairs from the dictionary file. */
export type PatternRule = [RegExp, string];

export interface I18nStats {
  applied: number;
  misses: number;
  nodes: number;
}

/** What a coverage report needs to know about the catalog half. */
export interface CatalogStats {
  lang: Lang;
  /** True once the active language catalog has been loaded (or its load failed). */
  ready: boolean;
  /** Flattened message count in the active language. */
  keys: number;
  /** Flattened message count in the zh fallback catalog. */
  zhKeys: number;
  /** `t()` calls answered from zh because the active language lacked the key. */
  fallbackHits: number;
  /** `t()` calls whose key exists in neither catalog. */
  misses: number;
  /** Missing keys, most requested first. */
  missingKeys: Array<{ key: string; count: number }>;
  /** Last load error message, "" when the last load worked. */
  lastError: string;
}

export interface I18nApi {
  lang(): Lang;
  setLang(next: unknown): Lang;
  /** Translates one string through the legacy dictionary; non-CJK and unknown strings come back unchanged. */
  tr(s: unknown): string;
  /** Catalog lookup by stable key. Synchronous; see the module note on readiness. */
  t(key: unknown, params?: Params): string;
  /**
   * Renders a `{ key, params }` descriptor (the shape services return instead of composing copy).
   * Params that are themselves descriptors are rendered first, so a sentence can embed a label.
   */
  tCopy(copy: unknown): string;
  /** True when the given language (default: active) has this key. No fallback. */
  hasCatalog(key: unknown, lang?: unknown): boolean;
  /** Fetches and installs one catalog. Resolves false on any failure; never throws. */
  loadCatalog(lang: unknown): Promise<boolean>;
  catalogReady(): boolean;
  /** Runs `fn` now when the active catalog is ready, else once it becomes ready. */
  whenReady(fn: () => void): void;
  catalogStats(): CatalogStats;
  /** Loads the dictionary object and the pattern list. */
  loadFrom(dictObj: unknown, patterns: unknown): void;
  ready(): boolean;
  dictSize(): number;
  stats(): I18nStats;
  coveredByPattern(s: unknown): boolean;
  /** True when the dictionary already has an exact entry for this (trimmed) key. */
  has(s: unknown): boolean;
}

export interface I18nEnv {
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  langKey: string;
  /** Catalog directory; `loadCatalog("en")` fetches `<base>en.json`. Defaults to `/locales/`. */
  catalogBase?: string;
  /** Injected by the wiring (platform fetch) and by tests. */
  fetchJson?: (url: string) => Promise<unknown>;
}

const I18N_CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

/** unknown → plain-object view; null, arrays and scalars become an empty object. */
function recOf(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
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
function flattenInto(source: unknown, prefix: string, out: Map<string, string>): void {
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
function closingBrace(text: string, open: number): number {
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
function readSelectors(body: string): Array<{ sel: string; body: string }> {
  const out: Array<{ sel: string; body: string }> = [];
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
function pluralForm(lang: Lang, count: number): string {
  if (lang === "en") return count === 1 ? "one" : "other";
  return "other";
}

/** `{name}` → the param, or the placeholder itself when the param is missing (a visible bug). */
function paramText(name: string, params: Params | undefined): string {
  if (!params) return "{" + name + "}";
  const value = params[name];
  if (value === undefined || value === null) return "{" + name + "}";
  return String(value);
}

/** Renders one branch body: `#` becomes the count, then `{name}` interpolation runs. */
function formatPlural(lang: Lang, rawCount: unknown, body: string, params: Params | undefined): string {
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
function formatMessage(lang: Lang, message: string, params: Params | undefined): string {
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

export function createI18n(env: I18nEnv): I18nApi {
  let lang: Lang = (function () {
    try {
      return env.storage.getItem(env.langKey) === "en" ? "en" : "zh";
    } catch (e) {
      return "zh";
    }
  })();

  const dict: Record<string, string> = Object.create(null);
  let patterns: PatternRule[] = [];
  let isReady = false;
  const counters: I18nStats = { applied: 0, misses: 0, nodes: 0 };

  // ── catalog state ──────────────────────────────────────────────────────────────────────────────
  const catalogs: Record<Lang, Map<string, string> | null> = { zh: null, en: null };
  const inFlight: Record<Lang, Promise<boolean> | null> = { zh: null, en: null };
  const missing: Record<string, number> = Object.create(null);
  const readyHooks: Array<() => void> = [];
  let catalogState: "idle" | "ready" = "idle";
  let fallbackHits = 0;
  let catalogMisses = 0;
  let lastError = "";

  function asLang(value: unknown): Lang {
    return value === "en" ? "en" : "zh";
  }

  function markCatalogReady(): void {
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

  function install(langName: Lang, data: unknown): boolean {
    const map = new Map<string, string>();
    flattenInto(data, "", map);
    if (!map.size) return false; // an empty or malformed catalog is a failure, not a success
    catalogs[langName] = map;
    lastError = "";
    return true;
  }

  function loadCatalog(name: unknown): Promise<boolean> {
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
  function tr(value: unknown): string {
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
  function t(key: unknown, params?: Params): string {
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

  function hasCatalog(key: unknown, which?: unknown): boolean {
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
  function tCopy(copy: unknown): string {
    const record = recOf(copy);
    const key = typeof record.key === "string" ? record.key : "";
    if (!key) return "";
    const raw = recOf(record.params);
    const params: Params = {};
    const names = Object.keys(raw);
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const value = raw[name];
      const nested = recOf(value);
      params[name] = typeof nested.key === "string" ? tCopy(value) : value;
    }
    return t(key, params);
  }

  function catalogStats(): CatalogStats {
    const out: Array<{ key: string; count: number }> = [];
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

  function loadFrom(dictObj: unknown, patternList: unknown): void {
    try {
      if (dictObj && typeof dictObj === "object") {
        for (const [k, v] of Object.entries(dictObj)) {
          if (typeof v === "string") dict[k] = v;
        }
      }
      const list = Array.isArray(patternList) ? patternList : [];
      const out: PatternRule[] = [];
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
  function coveredByPattern(value: unknown): boolean {
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

  function has(value: unknown): boolean {
    const key = (typeof value === "string" ? value : value == null ? "" : String(value)).trim();
    return key !== "" && dict[key] != null;
  }

  function setLang(next: unknown): Lang {
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
