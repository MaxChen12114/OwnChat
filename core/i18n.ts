/**
 * The translation engine: exact-string dictionary hits plus pattern rules, and the counters behind them.
 *
 * The design decision that makes this safe: translation happens **after rendering**, matching whole
 * strings exactly. A user's message, a model's output or a character name will not equal a UI label, so
 * it cannot be mistranslated by accident — the worst case is a miss. That is also why the dictionary can
 * grow incrementally (even from outside contributions) without touching the ~2200 call sites.
 *
 * Two subtleties live in `tr()` and are easy to break:
 *   · Only CJK strings are looked up. An English string is returned untouched, so re-running the pass is
 *     harmless and the dictionary never has to contain its own output.
 *   · The hit is spliced back into the **original** string via `s.replace(key, hit)`, where `key` is the
 *     trimmed form. Leading and trailing whitespace around a label therefore survives translation —
 *     replacing `s` wholesale would collapse the layout spacing that DOM text nodes rely on.
 *
 * Concatenated strings (`'已加 ' + n + ' 条'`) go through the pattern rules instead; a pattern that does
 * not change the text counts as a miss, not a hit.
 *
 * The DOM walking, skip lists, observer and dialog patching stay in the wiring.
 *
 * Lock: `test/i18n.test.mjs` (written with the migration).
 * @module core/i18n
 */

export type Lang = "en" | "zh";

/** `[pattern, replacement]` pairs from the dictionary file. */
export type PatternRule = [RegExp, string];

export interface I18nStats {
  applied: number;
  misses: number;
  nodes: number;
}

export interface I18nApi {
  lang(): Lang;
  setLang(next: unknown): Lang;
  /** Translates one string; non-CJK and unknown strings come back unchanged. */
  tr(s: unknown): string;
  /** Loads the dictionary object and the pattern list. */
  loadFrom(dictObj: unknown, patterns: unknown): void;
  ready(): boolean;
  dictSize(): number;
  stats(): I18nStats;
  coveredByPattern(s: unknown): boolean;
  /** True when the dictionary already has an exact entry for this (trimmed) key. */
  has(s: unknown): boolean;
}

const I18N_CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

export function createI18n(env: { storage: { getItem(key: string): string | null; setItem(key: string, value: string): void }; langKey: string }): I18nApi {
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
    lang = next === "en" ? "en" : "zh";
    try {
      env.storage.setItem(env.langKey, lang);
    } catch (e) {
      // A blocked store still switches for this session.
    }
    return lang;
  }

  return {
    lang: () => lang,
    setLang: setLang,
    tr: tr,
    loadFrom: loadFrom,
    ready: () => isReady,
    dictSize: () => Object.keys(dict).length,
    stats: () => counters,
    coveredByPattern: coveredByPattern,
    has: has,
  };
}
