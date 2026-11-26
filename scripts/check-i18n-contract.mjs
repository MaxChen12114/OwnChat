// Dictionary contract gate — the runtime-dictionary analogue of a compile-time typed locale map.
//
// deepseek-ai/deepseek-harness makes the dictionary the single source of translated text and lets
// TypeScript enforce a complete key set ("Chinese defines the keys"). This repo's i18n is a runtime
// DOM-replacement engine (keys are the rendered Chinese strings themselves, 2200+ call sites never
// touch the dict), so there is no `t('key')` for tsc to check. This script supplies that missing
// contract mechanically, over the actual dictionary file the engine loads:
//
//   C1 loadable        — the IIFE runs in a vm and publishes both plain globals
//   C2 shape           — i18nDict is a string→string map; i18nPatterns is [RegExp, string][]
//   C3 no duplicate    — no key literal appears twice (JS silently keeps the last; a translation
//                        edit to the first copy would then have no effect — a real trap)
//   C4 no empty entry  — every key has a non-empty value, and value !== key (untranslated stub)
//   C5 patterns valid  — every pattern's regex compiles, and every $n placeholder in the template
//                        has a matching capture group in the regex
//   C6 retired names   — the old __i18nDict / __i18nPatterns frozen names are absent from
//                        contracts.json (B4 zeroed them; C1 proves the plain names are published)
//
// WARN-ONLY (reported, never gates — these need an owner decision, not a mechanical fix):
//   W1 value contains CJK — may be an intentional bilingual label (e.g. "Interface language / 语言")
//
// Exit 0 when all contract checks pass; exit 1 on the first C-level violation.
// Usage: node scripts/check-i18n-contract.mjs
// @module scripts/check-i18n-contract
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ROOT = path.resolve(import.meta.dirname, "..");
const PUB = path.join(ROOT, "public");
const ENGINE_PATH = path.join(PUB, "shared", "lib", "i18n.js");
const CONTRACTS_PATH = path.join(ROOT, "tooling", "typecheck", "contracts.json");
const CJK = /[\u3400-\u9fff]/;
const problems = [];
const warnings = [];

function fail(code, msg) { problems.push(`[${code}] ${msg}`); }
function warn(code, msg) { warnings.push(`[${code}] ${msg}`); }

// Same single-source-of-truth as check-i18n.mjs: read the path from the engine.
function resolveDictPath() {
  const engine = fs.readFileSync(ENGINE_PATH, "utf8");
  const m = engine.match(/DICT_SRC\s*=\s*["']([^"']+)["']/);
  if (!m) throw new Error(`cannot find DICT_SRC in i18n.js`);
  return path.join(PUB, m[1].split("?")[0].replace(/^\/+/, ""));
}

const dictPath = resolveDictPath();
const src = fs.readFileSync(dictPath, "utf8");

// C1 — loadable + frozen globals present.
const sandbox = {};
let dict, patterns;
try {
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  dict = sandbox.i18nDict;
  patterns = sandbox.i18nPatterns;
  if (!dict) fail("C1", "i18nDict not published on global");
  if (!patterns) fail("C1", "i18nPatterns not published on global");
} catch (e) {
  fail("C1", `dictionary IIFE threw: ${e.message}`);
}

// C2 — shape: string→string map, [RegExp, string][].
if (dict && (typeof dict !== "object" || Array.isArray(dict))) {
  fail("C2", "i18nDict is not an object");
} else if (dict) {
  for (const [k, v] of Object.entries(dict)) {
    if (typeof v !== "string") fail("C2", `value for ${JSON.stringify(k)} is ${typeof v}, expected string`);
  }
}
if (patterns && !Array.isArray(patterns)) {
  fail("C2", "i18nPatterns is not an array");
} else if (patterns) {
  patterns.forEach((p, i) => {
    const isRe = Object.prototype.toString.call(p?.[0]) === "[object RegExp]";
    if (!Array.isArray(p) || p.length !== 2 || !isRe || typeof p[1] !== "string") {
      fail("C2", `pattern #${i} is not [RegExp, string]`);
    }
  });
}

// C3 — duplicate key literals. Scan source lines: only dict entries ("中文": "..."), not patterns.
const seen = new Map();
for (const [i, line] of src.split(/\r?\n/).entries()) {
  const m = line.match(/^\s*["']([^"']+)["']\s*:/);
  if (!m) continue;
  const k = m[1];
  if (!CJK.test(k)) continue;
  if (seen.has(k)) fail("C3", `duplicate key ${JSON.stringify(k)} at lines ${seen.get(k)} and ${i + 1}`);
  else seen.set(k, i + 1);
}

// C4 — no empty / untranslated entries.
if (dict) {
  for (const [k, v] of Object.entries(dict)) {
    if (typeof v === "string" && v.trim() === "") fail("C4", `empty value for ${JSON.stringify(k)}`);
    if (v === k) fail("C4", `untranslated stub (value === key): ${JSON.stringify(k)}`);
  }
}

// C5 — pattern regex compiles and $n placeholders have matching capture groups.
if (patterns) {
  patterns.forEach((p, i) => {
    if (!Array.isArray(p) || p.length !== 2) return;
    const [re, tpl] = p;
    if (Object.prototype.toString.call(re) !== "[object RegExp]") return;
    let groups = 0;
    try { new RegExp(re.source); } // compile check
    catch (e) { fail("C5", `pattern #${i} regex does not compile: ${e.message}`); return; }
    // Count capturing groups from the pattern source: a `(` that is not escaped and not a
    // non-capturing / lookaround group (`(?:`, `(?=`, `(?!`, `(?<=`, `(?<!`).
    groups = (re.source.match(/(?<!\\)\((?!\?)/g) || []).length;
    const placeholders = [...String(tpl).matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    const maxRef = placeholders.length ? Math.max(...placeholders) : 0;
    if (maxRef > groups) {
      fail("C5", `pattern #${i} references $${maxRef} but regex has only ${groups} capture group(s): ${tpl}`);
    }
  });
}

// C6 — retired frozen names: the dictionary now publishes plain i18nDict / i18nPatterns, so the
// old window.__ names must be gone from contracts.json. C1 proves the replacements are published.
try {
  const contracts = JSON.parse(fs.readFileSync(CONTRACTS_PATH, "utf8"));
  const names = contracts.names ?? contracts.contracts ?? contracts;
  for (const key of ["__i18nDict", "__i18nPatterns"]) {
    if (key in names) fail("C6", `${key} still frozen (B4 retired it; plain name should be used)`);
  }
} catch (e) {
  fail("C6", `cannot read contracts.json: ${e.message}`);
}

// W1 — value still contains CJK (report only; may be an intentional bilingual label).
if (dict) {
  for (const [k, v] of Object.entries(dict)) {
    if (typeof v === "string" && CJK.test(v)) warn("W1", `${JSON.stringify(k)} → ${JSON.stringify(v)}`);
  }
}

console.log(`i18n 字典契约校验：${path.relative(ROOT, dictPath)}`);
console.log(`  条目 ${dict ? Object.keys(dict).length : 0}；规则 ${patterns ? patterns.length : 0}`);
if (warnings.length) {
  console.log(`  报告 ${warnings.length} 条（不影响门禁）：`);
  for (const w of warnings.slice(0, 10)) console.log(`    ${w}`);
}
if (problems.length) {
  console.error(`\n  契约失败 ${problems.length} 条：`);
  for (const p of problems.slice(0, 30)) console.error(`    ${p}`);
  process.exit(1);
}
console.log(`  契约通过：可加载 / 形态正确 / 无重复键 / 无空条目 / 规则合法 / 退役名已清`);
