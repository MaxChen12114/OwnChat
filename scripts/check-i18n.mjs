// Bilingual coverage audit over the strings the UI actually shows. By default it reports only;
// `--strict` turns the two hard invariants into a build gate (see below).
//
// Scans public/**/*.{js,html} for strings containing CJK (literals and HTML text) and compares them
// with the runtime dictionary loaded by the i18n engine:
//   · uncovered Top N — most frequent first, i.e. exactly what to add to the dictionary next; adding
//     an entry needs no change at the call site
//   · stale entries — present in the dictionary, absent from the sources (wording moved on; drop them
//     so the dictionary stops misleading)
//
// DICTIONARY PATH — single source of truth (2026-11-17):
// The dictionary path is read from DICT_SRC in the engine (public/shared/core/i18n.js), the same
// constant the browser uses to lazy-load it. It used to be hardcoded here as `shared/i18n-dict.js`
// (missing `/core/`), so this audit silently read no dictionary and reported 0% coverage forever.
// Deriving it from the engine means a future path bump can never desync the gate again.
//
// STRICT MODE (`--strict`): two invariants, both about REGRESSION, not about chasing 100% coverage
// (the dictionary is intentionally incremental — uncovered strings are expected and reported):
//   1. a string that WAS covered at baseline must stay covered (no regression in the shipped dict);
//   2. dictionary + pattern counts must not shrink (no silent mass deletion).
// A baseline is stored at scripts/.i18n-baseline.json; `--write-baseline` refreshes it and is the
// explicit "I confirm this coverage level" act. Strict fails loudly when no baseline exists.
//
// Usage: node scripts/check-i18n.mjs [--top 40] [--strict] [--write-baseline]
// @module scripts/check-i18n
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const PUB = path.join(ROOT, "public");
const ENGINE_PATH = path.join(PUB, "shared", "core", "i18n.js");
const BASELINE_PATH = path.join(ROOT, "scripts", ".i18n-baseline.json");
const CJK = /[\u3400-\u9fff]/;
const SKIP_DIRS = new Set(["node_modules", ".git"]);
// public/bundles/ holds generated tool manifests fed to the MODEL (group/summary/schema metadata),
// not text nodes the runtime DOM replacer can see. Scanning them floods the "uncovered" list with
// strings that are neither translatable by this engine nor actionable. Exclude by absolute path so a
// same-named dir elsewhere is not skipped.
const SKIP_PATHS = new Set([path.join(PUB, "bundles")]);
const EXT = new Set([".js", ".html"]);

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
function extract(src, isHtml) {
  const out = [];
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
      if (buf && CJK.test(buf) && buf.length <= 400) out.push(buf);
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
      if (s && CJK.test(s) && s.length <= 400) out.push(s);
    }
  }
  return out;
}

const counts = new Map(); // string -> { n, files:Set }
for (const f of listFiles(PUB)) {
  const rel = path.relative(ROOT, f).split(path.sep).join("/");
  const raw = fs.readFileSync(f, "utf8");
  const src = stripComments(raw, f.endsWith(".html"));
  for (const s of extract(src, f.endsWith(".html"))) {
    const key = s.replace(/\s+/g, " ").trim();
    if (!key) continue;
    if (!counts.has(key)) counts.set(key, { n: 0, files: new Set() });
    const rec = counts.get(key);
    rec.n++;
    if (rec.files.size < 3) rec.files.add(rel);
  }
}

// Load the dictionary from the path the engine actually uses.
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

const all = [...counts.entries()].map(([s, r]) => ({ s, n: r.n, files: [...r.files] }));
const coveredList = all.filter((x) => covered(x.s));
const missing = all.filter((x) => !covered(x.s)).sort((a, b) => b.n - a.n);
const totalOcc = all.reduce((a, x) => a + x.n, 0);
const covOcc = coveredList.reduce((a, x) => a + x.n, 0);
const coveredSet = new Set(coveredList.map((x) => x.s));

const argv = process.argv.slice(2);
const topArg = argv.indexOf("--top");
const top = topArg >= 0 ? (Number(argv[topArg + 1]) || 40) : 40;
const strict = argv.includes("--strict");
const writeBaseline = argv.includes("--write-baseline");

const snapshot = {
  dictPath: dictRel,
  dictSha,
  dictCacheKey,
  dictKeys: Object.keys(dict).length,
  patterns: patterns.length,
  coveredStrings: coveredSet.size,
  coveredOccurrences: covOcc,
  totalStrings: all.length,
  totalOccurrences: totalOcc,
  coveredKeys: [...coveredSet].sort(),
};

if (writeBaseline) {
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(snapshot, null, 2) + "\n");
  console.log(`基线已写入 ${path.relative(ROOT, BASELINE_PATH)}（覆盖 ${coveredSet.size} 条 / ${covOcc} 次）`);
}

console.log(`双语覆盖度审计（public/，含中文的字符串）`);
console.log(`  字典来源：${dictRel}`);
console.log(`  去重字符串：${all.length} 条；出现次数合计 ${totalOcc}`);
console.log(`  字典已覆盖：${coveredList.length} 条 / ${(coveredList.length / (all.length || 1) * 100).toFixed(1)}%（按出现次数计 ${(covOcc / (totalOcc || 1) * 100).toFixed(1)}%）`);
console.log(`  字典条目数：${Object.keys(dict).length}（含可能过期条目）`);
if (missing.length) {
  console.log(`\n  未覆盖 Top ${Math.min(top, missing.length)}（增量补字典就补这些）：`);
  for (const x of missing.slice(0, top)) {
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
    if (problems.length) {
      console.error(`\n  双语门禁 --strict 失败：`);
      for (const p of problems) console.error(p);
      process.exitCode = 1;
    } else {
      console.log(`\n  双语门禁 --strict 通过（${coveredSet.size} 条覆盖无回退，字典规模未缩水）`);
    }
  }
}

function dictKeysShrunk(base, now) {
  return now.dictKeys < base.dictKeys || now.patterns < base.patterns;
}
