// Bilingual coverage audit over the strings the UI actually shows. By default it reports only;
// `--strict` turns the hard invariants into a build gate (see below).
//
// TWO ENGINES, TWO REPORTS (i18n v2, 2026-11-26):
//   · **catalog** — `public/locales/{zh,en}.json`, addressed by key, checked by
//     scripts/i18n-catalog-audit.mjs (key parity, placeholders, plurals). This file prints the
//     per-namespace table and re-runs the same audit under `--strict`, so one gate covers both.
//   · **legacy dictionary** — `public/shared/core/i18n-dict.js`, keyed by the rendered Chinese
//     string, covering the call sites the catalog migration has not reached yet.
//
// THREE CLASSES (plus one), configured in `scripts/.i18n-ignore.json`:
//   ui          — text a user reads in this document. **Only this class counts toward the coverage
//                 percentage**; it is the number the migration can move.
//   error       — console.* diagnostics, internal throws, `[module]` log lines.
//   prompt      — Chinese sent to the model (tool descriptions, env context, skill docs).
//   outOfScope  — separate documents (public/tools/**) and the dev HUD the DOM walker skips.
// Classification is by file (explicit, with a reason in the JSON) or by the source line the string
// sits on (`console.warn(`, `throw new Error(`). It is deliberately conservative: a user-facing
// error sentence stays in `ui` because it still needs translating.
//
// DICTIONARY PATH — single source of truth (2026-11-17):
// The dictionary path is read from DICT_SRC in the engine (public/shared/lib/i18n.js), the same
// constant the browser uses to lazy-load it. Deriving it from the engine means a future path bump
// can never desync the gate.
//
// SCAN EXCLUSIONS — the dictionary file itself is NOT a UI source. Counting it made every one of its
// ~2200 keys "covered by itself", which inflated the old headline number and hid real gaps.
//
// STRICT MODE (`--strict`): these invariants, all about REGRESSION, not about chasing 100% coverage:
//   1. a string that WAS covered at baseline must stay covered (any class — the baseline records the
//      whole scan, so reclassifying never silently drops a string);
//   2. dictionary + pattern counts must not shrink (no silent mass deletion);
//   3. the catalog must pass i18n-catalog-audit (both languages parse, same key set, placeholders
//      match, plurals have `other`).
// A baseline is stored at scripts/.i18n-baseline.json.
//
// HOW TO MOVE THE BASELINE AFTER A MIGRATION (the sanctioned way):
// `t()` migration deletes Chinese strings from the sources and puts them in public/locales/*.json.
// Deleted strings are no longer "covered", so strict would (correctly) call them regressions. After
// a migration batch: run `node scripts/check-i18n.mjs --top 0` (eyeball the class table and the UI
// number), then `--write-baseline` and commit the new baseline **in the same commit as the
// migration**, with the commit message saying which namespace moved. Never write the baseline to
// silence a string you did not migrate.
//
// Usage: node scripts/check-i18n.mjs [--top 40] [--strict] [--write-baseline]
// @module scripts/check-i18n
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { auditCatalogs } from "./i18n-catalog-audit.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const PUB = path.join(ROOT, "public");
const ENGINE_PATH = path.join(PUB, "shared", "lib", "i18n.js");
const BASELINE_PATH = path.join(ROOT, "scripts", ".i18n-baseline.json");
const CONFIG_PATH = path.join(ROOT, "scripts", ".i18n-ignore.json");
const CJK = /[\u3400-\u9fff]/;
const SKIP_DIRS = new Set(["node_modules", ".git"]);
// public/bundles/ holds generated tool manifests fed to the MODEL (group/summary/schema metadata),
// not text nodes the runtime DOM replacer can see. Scanning them floods the "uncovered" list with
// strings that are neither translatable by this engine nor actionable. Exclude by absolute path so a
// same-named dir elsewhere is not skipped.
const SKIP_PATHS = new Set([path.join(PUB, "bundles")]);
const EXT = new Set([".js", ".html"]);

// ── classification config ───────────────────────────────────────────────────────────────────────

function loadConfig() {
  const fallback = { classes: {}, order: [], scanExclude: new Set(), scanExcludeReason: "" };
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    const classes = {};
    for (const [name, cls] of Object.entries(raw.classes || {})) {
      classes[name] = {
        files: new Set(Array.isArray(cls.files) ? cls.files : []),
        filePrefixes: Array.isArray(cls.filePrefixes) ? cls.filePrefixes : [],
        linePatterns: (Array.isArray(cls.linePatterns) ? cls.linePatterns : []).map((p) => new RegExp(p)),
        stringPatterns: (Array.isArray(cls.stringPatterns) ? cls.stringPatterns : []).map((p) => new RegExp(p)),
      };
    }
    return {
      classes: classes,
      // outOfScope first, then prompt, then error: the most specific verdict wins.
      order: ["outOfScope", "prompt", "error"].filter((n) => classes[n]),
      scanExclude: new Set(Array.isArray(raw.scanExclude) ? raw.scanExclude : []),
      scanExcludeReason: raw.scanExcludeReason || "",
    };
  } catch (e) {
    return fallback;
  }
}

const CONFIG = loadConfig();

/** Class of one string, from its file, then its source line, then the string itself. */
function classifyString(rel, value, lineText) {
  for (const name of CONFIG.order) {
    const cls = CONFIG.classes[name];
    if (cls.files.has(rel)) return name;
    for (const prefix of cls.filePrefixes) if (rel.startsWith(prefix)) return name;
  }
  for (const name of CONFIG.order) {
    const cls = CONFIG.classes[name];
    for (const re of cls.linePatterns) if (re.test(lineText)) return name;
  }
  for (const name of CONFIG.order) {
    const cls = CONFIG.classes[name];
    for (const re of cls.stringPatterns) if (re.test(value)) return name;
  }
  return "ui";
}

// ── dictionary path ─────────────────────────────────────────────────────────────────────────────

// Read DICT_SRC from the engine so the gate and the browser load the exact same file.
function resolveDictPath() {
  const engine = fs.readFileSync(ENGINE_PATH, "utf8");
  const m = engine.match(/DICT_SRC\s*=\s*["']([^"']+)["']/);
  if (!m) throw new Error(`check-i18n: cannot find DICT_SRC in ${path.relative(ROOT, ENGINE_PATH)}`);
  const urlPath = m[1].split("?")[0]; // strip ?v= cache key
  const cacheKey = m[1].match(/[?&]v=([^&]+)/)?.[1] ?? "";
  const abs = path.join(PUB, urlPath.replace(/^\/+/, ""));
  if (!fs.existsSync(abs)) {
    throw new Error(`check-i18n: engine DICT_SRC points to a missing file: ${urlPath}`);
  }
  return { abs, rel: urlPath, cacheKey };
}

function listFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (SKIP_PATHS.has(abs)) continue;
    if (e.isDirectory()) listFiles(abs, out);
    else if (EXT.has(path.extname(e.name)) && !e.name.endsWith(".min.js")) out.push(abs);
  }
  return out;
}

// Approximate comment removal (line, block, HTML) — good enough to cut false positives, not a parser.
function stripComments(src, isHtml) {
  let t = src.replace(/\/\*[\s\S]*?\*\//g, " ");
  t = t.split(/\r?\n/).map((l) => {
    const i = l.indexOf("//");
    if (i < 0) return l;
    // A // inside a string ("http://...") is not a comment: bail out when a quote is left open.
    const before = l.slice(0, i);
    if (/'[^']*$|"[^"]*$|`[^`]*$/.test(before)) return l;
    return before;
  }).join("\n");
  if (isHtml) t = t.replace(/<!--[\s\S]*?-->/g, " ");
  return t;
}

// Character-by-character string-literal scan. A regex was tried first and died on app.js: the greedy
// and lazy forms with backreferences backtrack catastrophically there. Do not go back to a regex.
// Returns `{ s, line }` where line is the index into the (comment-stripped) source lines.
function extract(src, isHtml) {
  const out = [];
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (idx) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"' || c === "`") {
      const q = c;
      let j = i + 1;
      let buf = "";
      while (j < src.length) {
        const ch = src[j];
        if (ch === "\\") { buf += src[j + 1] || ""; j += 2; continue; }
        if (ch === q) break;
        if (ch === "\n" && q !== "`") break; // 单双引号字符串不跨行
        buf += ch;
        j++;
      }
      if (buf && CJK.test(buf) && buf.length <= 400) out.push({ s: buf, line: lineOf(i) });
      i = j + 1;
      continue;
    }
    i++;
  }
  if (isHtml) {
    const textRe = />([^<>]+)</g;
    let m;
    while ((m = textRe.exec(src))) {
      const s = m[1].trim();
      if (s && CJK.test(s) && s.length <= 400) out.push({ s: s, line: lineOf(m.index) });
    }
  }
  return out;
}

// ── scan ─────────────────────────────────────────────────────────────────────────────────────────

const counts = new Map(); // string -> { n, files:Set, classes:Map }
for (const f of listFiles(PUB)) {
  const rel = path.relative(ROOT, f).split(path.sep).join("/");
  if (CONFIG.scanExclude.has(rel)) continue;
  const raw = fs.readFileSync(f, "utf8");
  const src = stripComments(raw, f.endsWith(".html"));
  const lines = src.split(/\r?\n/);
  for (const hit of extract(src, f.endsWith(".html"))) {
    const key = hit.s.replace(/\s+/g, " ").trim();
    if (!key) continue;
    const cls = classifyString(rel, hit.s, lines[hit.line] || "");
    if (!counts.has(key)) counts.set(key, { n: 0, files: new Set(), classes: new Map() });
    const rec = counts.get(key);
    rec.n++;
    if (rec.files.size < 3) rec.files.add(rel);
    rec.classes.set(cls, (rec.classes.get(cls) || 0) + 1);
  }
}

/** A string's class is its most frequent one; a tie resolves to ui (the harder verdict). */
function dominantClass(rec) {
  let best = "ui";
  let bestN = -1;
  for (const [cls, n] of rec.classes) {
    if (n > bestN || (n === bestN && cls === "ui")) {
      best = cls;
      bestN = n;
    }
  }
  return best;
}

// ── dictionary ─────────────────────────────────────────────────────────────────────────────────

let dict = {}, patterns = [];
let dictRel = "(unresolved)", dictSha = "", dictCacheKey = "";
try {
  const resolved = resolveDictPath();
  dictRel = resolved.rel;
  dictCacheKey = resolved.cacheKey;
  const dictSrc = fs.readFileSync(resolved.abs, "utf8");
  dictSha = crypto.createHash("sha256").update(dictSrc).digest("hex").slice(0, 16);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(dictSrc, sandbox);
  dict = sandbox.i18nDict || {};
  patterns = Array.isArray(sandbox.i18nPatterns) ? sandbox.i18nPatterns : [];
} catch (e) {
  console.error(`  字典加载失败：${e.message}`);
  process.exitCode = 1;
}

function covered(s) {
  if (Object.prototype.hasOwnProperty.call(dict, s)) return true;
  for (const [re] of patterns) { try { if (re.test(s)) return true; } catch (e) {} }
  return false;
}

// ── reporting ──────────────────────────────────────────────────────────────────────────────────

const all = [...counts.entries()].map(([s, r]) => ({ s, n: r.n, files: [...r.files], cls: dominantClass(r) }));
const ui = all.filter((x) => x.cls === "ui");
const coveredList = all.filter((x) => covered(x.s));
const coveredUi = ui.filter((x) => covered(x.s));
const missingUi = ui.filter((x) => !covered(x.s)).sort((a, b) => b.n - a.n);
const totalOcc = all.reduce((a, x) => a + x.n, 0);
const covOcc = coveredList.reduce((a, x) => a + x.n, 0);
const uiOcc = ui.reduce((a, x) => a + x.n, 0);
const uiCovOcc = coveredUi.reduce((a, x) => a + x.n, 0);
const coveredSet = new Set(coveredList.map((x) => x.s));
const classCounts = { ui: ui.length, error: 0, prompt: 0, outOfScope: 0 };
for (const x of all) if (x.cls !== "ui") classCounts[x.cls] = (classCounts[x.cls] || 0) + 1;

const argv = process.argv.slice(2);
const topArg = argv.indexOf("--top");
const top = topArg >= 0 ? (Number(argv[topArg + 1]) || 40) : 40;
const strict = argv.includes("--strict");
const writeBaseline = argv.includes("--write-baseline");

const catalogAudit = auditCatalogs();
const catalogNamespaces = catalogAudit.namespaces.map((n) => ({ name: n.name, keys: n.keys, en: n.en }));

const snapshot = {
  version: 2,
  generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  dictPath: dictRel,
  dictSha,
  dictCacheKey,
  dictKeys: Object.keys(dict).length,
  patterns: patterns.length,
  coveredStrings: coveredSet.size,
  coveredOccurrences: covOcc,
  totalStrings: all.length,
  totalOccurrences: totalOcc,
  // The number the migration moves: UI class only.
  ui: {
    strings: ui.length,
    occurrences: uiOcc,
    coveredStrings: coveredUi.length,
    coveredOccurrences: uiCovOcc,
  },
  classes: classCounts,
  catalog: {
    languages: catalogAudit.langs,
    namespaces: catalogNamespaces,
    problems: catalogAudit.problems.length,
  },
  scanExclude: [...CONFIG.scanExclude],
  coveredKeys: [...coveredSet].sort(),
};

if (writeBaseline) {
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(snapshot, null, 2) + "\n");
  console.log(`基线已写入 ${path.relative(ROOT, BASELINE_PATH)}（全类覆盖 ${coveredSet.size} 条 / UI 覆盖 ${coveredUi.length} 条）`);
  console.log(`  说明：迁移把中文从源码搬进 public/locales/*.json 后，--write-baseline 是合法的收口动作；`);
  console.log(`        但只允许在同一个提交里、迁移确已完成时刷新，别用它压掉没迁的字符串。`);
}

console.log(`双语覆盖度审计（public/，含中文的字符串）`);
console.log(`  字典来源：${dictRel}`);
if (CONFIG.scanExclude.size) console.log(`  扫描排除：${[...CONFIG.scanExclude].join(" · ")}（字典本体不是 UI 源码）`);
console.log(`  去重字符串：${all.length} 条；出现次数合计 ${totalOcc}`);
console.log(`  分类：UI ${classCounts.ui} · 错误与日志 ${classCounts.error} · 模型提示 ${classCounts.prompt} · 不在链路 ${classCounts.outOfScope}`);
console.log(`  UI 覆盖率：${coveredUi.length} 条 / ${(coveredUi.length / (ui.length || 1) * 100).toFixed(1)}%（按出现次数计 ${(uiCovOcc / (uiOcc || 1) * 100).toFixed(1)}%）`);
console.log(`  全类覆盖率（参考）：${coveredList.length} / ${all.length} 条（${(covOcc / (totalOcc || 1) * 100).toFixed(1)}%）`);
console.log(`  字典条目数：${Object.keys(dict).length}（含可能过期条目）`);

// Catalog: per-namespace table (the half that has real namespaces).
console.log(`\n  目录（public/locales）按命名空间：`);
for (const lang of ["zh", "en"]) {
  const row = catalogAudit.langs[lang];
  console.log(`    ${lang}：${row.keys} 条${row.error ? "  ✗ " + row.error : ""}`);
}
console.log("    " + catalogAudit.namespaces.map((n) => `${n.name} ${n.keys}`).join(" · "));
if (catalogAudit.problems.length) {
  console.log(`    目录问题 ${catalogAudit.problems.length} 条（详情跑 node scripts/i18n-catalog-audit.mjs）`);
}

// Legacy UI gaps grouped by domain, then the flat Top N the migration can act on.
if (missingUi.length) {
  const byDomain = new Map();
  for (const x of missingUi) {
    const domain = (x.files[0] || "").split("/").slice(0, 3).join("/");
    byDomain.set(domain, (byDomain.get(domain) || 0) + 1);
  }
  const domains = [...byDomain.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log(`\n  UI 未覆盖按域（前 8）：` + domains.map(([d, n]) => `${d} ${n}`).join(" · "));
  console.log(`  UI 未覆盖 Top ${Math.min(top, missingUi.length)}（增量补字典或迁 catalog 就补这些）：`);
  for (const x of missingUi.slice(0, top)) {
    const s = x.s.length > 42 ? x.s.slice(0, 42) + "…" : x.s;
    console.log(`    ×${String(x.n).padStart(3)}  ${s}   [${x.files[0]}]`);
  }
}

const stale = Object.keys(dict).filter((k) => !counts.has(k));
if (stale.length) {
  console.log(`\n  疑过期条目 ${stale.length} 条（源码里找不到，多为文案已改）：`);
  for (const s of stale.slice(0, 20)) console.log(`    ~  ${s.length > 42 ? s.slice(0, 42) + "…" : s}`);
}

if (strict) {
  if (!fs.existsSync(BASELINE_PATH)) {
    console.error(`\n  --strict 需要基线文件 ${path.relative(ROOT, BASELINE_PATH)}；先跑一次 --write-baseline 确认当前覆盖水平。`);
    process.exitCode = 1;
  } else {
    const base = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
    const regressions = base.coveredKeys.filter((k) => !coveredSet.has(k));
    const problems = [];
    if (regressions.length) {
      problems.push(`${regressions.length} 条原本覆盖的字符串失去覆盖：`);
      for (const k of regressions.slice(0, 15)) problems.push(`    - ${k.length > 42 ? k.slice(0, 42) + "…" : k}`);
    }
    if (dictKeysShrunk(base, snapshot)) {
      problems.push(`字典规模缩水：键 ${base.dictKeys}→${snapshot.dictKeys}，规则 ${base.patterns}→${snapshot.patterns}`);
    }
    // Cache-buster guard: when the dictionary bytes change, DICT_SRC's ?v= must be bumped, or users
    // keep the old cached dictionary and never see the new translation. Compare content hash against
    // the version recorded at baseline; a changed hash with an unchanged ?v= is a hard error.
    if (base.dictSha && base.dictSha !== dictSha && base.dictCacheKey === dictCacheKey) {
      problems.push(`字典内容已改（sha ${base.dictSha}→${dictSha}）但 DICT_SRC 的 ?v=${dictCacheKey} 未 bump；`
        + `用户浏览器会命中旧缓存，翻译改动不生效。请在 i18n.js 递增版本号后重跑 --write-baseline。`);
    }
    if (catalogAudit.problems.length) {
      problems.push(`目录（public/locales）校验失败 ${catalogAudit.problems.length} 条：`);
      for (const p of catalogAudit.problems.slice(0, 10)) problems.push(`    ${p.code} ${p.key} — ${p.detail}`);
    }
    if (problems.length) {
      console.error(`\n  双语门禁 --strict 失败：`);
      for (const p of problems) console.error(p);
      process.exitCode = 1;
    } else {
      console.log(`\n  双语门禁 --strict 通过（${coveredSet.size} 条覆盖无回退，字典规模未缩水，目录双语一致）`);
    }
  }
}

function dictKeysShrunk(base, now) {
  return now.dictKeys < base.dictKeys || now.patterns < base.patterns;
}
