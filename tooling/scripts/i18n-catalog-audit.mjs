// Catalog gate for `public/locales/**` — the "translated text is a data file, not a JS constant"
// half of the i18n v2 migration (the legacy whole-string dictionary stays covered by
// check-i18n.mjs and check-i18n-contract.mjs).
//
// What this proves, mechanically, before a translation can ship:
//   P1 both languages exist and parse
//   P2 key sets are identical (zh defines the keys; en must not add or drop one)
//   P3 no empty message, and no message identical to its key
//   P4 placeholders match between languages (`{name}` / `{count, plural, …}`)
//   P5 every plural message has an `other` branch (the only branch both languages share)
//   P6 dotted key shape: every leaf is `ns.section.key` with no whitespace and no dots inside a
//      segment (a dot inside a name would make the flattened key ambiguous)
//
// Reported, never fatal:
//   O1 orphan keys — present in both catalogs but referenced by no source file. Dead weight: the
//      audit lists them so the next translation pass can delete instead of guessing.
//   N1 namespace table — key counts per top-level namespace (where the copy lives).
//
// Usage:
//   node tooling/scripts/i18n-catalog-audit.mjs            # problems → exit 1, orphans printed
//   node tooling/scripts/i18n-catalog-audit.mjs --json     # machine-readable report
//   node tooling/scripts/i18n-catalog-audit.mjs --strict-orphans  # orphans also fail (release hygiene)
// @module tooling/scripts/i18n-catalog-audit
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");

/** Language files, in fallback order: zh is the source language, en mirrors it. */
export const LANGS = ["zh", "en"];
export const LOCALES_DIR = path.join(ROOT, "public", "locales");

/** Where a key may be referenced. Both the TS source and its emitted artifact are scanned. */
const REF_ROOTS = ["public", "services", "core", "lib", "l0", "app"];

function recOf(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/**
 * Flatten nested namespaces into dotted keys. Empty strings are collected separately instead of
 * dropped, so P3 can name them; `$`-prefixed keys are file metadata and never messages.
 * @param {unknown} source
 * @param {string} prefix
 * @param {Map<string, string>} out
 * @param {string[]} empties
 */
export function flattenCatalog(source, prefix = "", out = new Map(), empties = []) {
  const record = recOf(source);
  if (!record) return out;
  for (const [name, value] of Object.entries(record)) {
    if (name.startsWith("$")) continue;
    const full = prefix === "" ? name : prefix + "." + name;
    if (typeof value === "string") {
      if (value.trim() === "") empties.push(full);
      else out.set(full, value);
      continue;
    }
    if (recOf(value)) flattenCatalog(value, full, out, empties);
  }
  return out;
}

/** @param {string} lang @returns {{ lang: string, file: string, flat: Map<string,string>, empties: string[], error: string }} */
export function loadCatalog(lang) {
  const file = path.join(LOCALES_DIR, lang + ".json");
  const result = { lang, file, flat: new Map(), empties: [], error: "" };
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    flattenCatalog(raw, "", result.flat, result.empties);
  } catch (e) {
    result.error = e && e.message ? e.message : String(e);
  }
  return result;
}

/** Parameter names used by a message: `{name}` and the selector side of `{count, plural, …}`. */
export function placeholders(message) {
  /** @type {string[]} */
  const out = [];
  const re = /\{([A-Za-z_][A-Za-z0-9_]*)\s*[,}]/g;
  let m;
  while ((m = re.exec(message))) if (!out.includes(m[1])) out.push(m[1]);
  out.sort();
  return out;
}

/** True when a plural message carries the `other` branch every language falls back to. */
export function hasOtherBranch(message) {
  return /\bother\s*\{/.test(message);
}

/** True when the message uses the ICU plural subset at all. */
export function usesPlural(message) {
  return /,\s*plural\s*,/.test(message);
}

/**
 * Full audit. Pure apart from reading the two JSON files.
 * @returns {{ langs: Record<string, {keys:number, empties:string[], error:string}>, keys: Map<string,string>[], namespaces: Array<{name:string, keys:number, zh:number, en:number}>, problems: Array<{code:string, key:string, detail:string}>, warnings: Array<{code:string, key:string, detail:string}> }}
 */
export function auditCatalogs() {
  const loaded = LANGS.map(loadCatalog);
  /** @type {Array<{code:string,key:string,detail:string}>} */
  const problems = [];
  /** @type {Array<{code:string,key:string,detail:string}>} */
  const warnings = [];
  /** @type {Record<string, {keys:number, empties:string[], error:string}>} */
  const langs = {};
  for (const cat of loaded) {
    langs[cat.lang] = { keys: cat.flat.size, empties: cat.empties, error: cat.error };
    if (cat.error) problems.push({ code: "P1", key: cat.lang, detail: "无法读取/解析：" + cat.error });
    for (const key of cat.empties) problems.push({ code: "P3", key, detail: cat.lang + " 的译文为空" });
  }
  const zh = loaded[0];
  const en = loaded[1];

  // P2 — identical key sets.
  for (const key of zh.flat.keys()) if (!en.flat.has(key)) problems.push({ code: "P2", key, detail: "缺 en 译文" });
  for (const key of en.flat.keys()) if (!zh.flat.has(key)) problems.push({ code: "P2", key, detail: "en 有、zh 没有（zh 是源语言）" });

  // P3/P4/P5/P6 — per shared key.
  for (const [key, zhMessage] of zh.flat) {
    for (const segment of key.split(".")) {
      if (segment === "" || /\s/.test(segment) || !/^[A-Za-z0-9_-]+$/.test(segment)) {
        problems.push({ code: "P6", key, detail: "key 段含非法字符：" + JSON.stringify(segment) });
        break;
      }
    }
    if (key.split(".").length < 2) problems.push({ code: "P6", key, detail: "key 至少要有 命名空间.名字 两段" });
    if (zhMessage === key) problems.push({ code: "P3", key, detail: "译文与 key 相同（占位未翻译）" });
    const enMessage = en.flat.get(key);
    if (enMessage === undefined) continue;
    if (enMessage === key) problems.push({ code: "P3", key, detail: "en 译文与 key 相同（占位未翻译）" });
    const zhParams = placeholders(zhMessage);
    const enParams = placeholders(enMessage);
    if (zhParams.join(",") !== enParams.join(",")) {
      problems.push({
        code: "P4",
        key,
        detail: "占位符不一致：zh {" + zhParams.join(", ") + "} / en {" + enParams.join(", ") + "}",
      });
    }
    for (const [lang, message] of [["zh", zhMessage], ["en", enMessage]]) {
      if (usesPlural(message) && !hasOtherBranch(message)) {
        problems.push({ code: "P5", key, detail: lang + " 的复数消息缺 other 分支" });
      }
    }
    // Same-script copies are not a hard error (a product name may stay), but a full sentence that
    // still carries CJK in the English catalog is almost certainly a missed translation.
    if (/[\u3400-\u9fff]/.test(enMessage) && key !== "common.none") {
      warnings.push({ code: "W1", key, detail: "en 译文仍含中文：" + enMessage.slice(0, 40) });
    }
  }

  // Namespace table (top-level segment).
  const ns = new Map();
  for (const key of zh.flat.keys()) {
    const name = key.split(".")[0];
    if (!ns.has(name)) ns.set(name, { name, keys: 0, zh: 0, en: 0 });
    const row = ns.get(name);
    row.keys++;
    row.zh++;
    if (en.flat.has(key)) row.en++;
  }
  const namespaces = [...ns.values()].sort((a, b) => b.keys - a.keys || a.name.localeCompare(b.name));
  return { langs, keys: [zh.flat, en.flat], namespaces, problems, warnings };
}

/** Every string literal in the reference roots — a key counts as used when it appears verbatim. */
export function collectSourceLiterals() {
  /** @type {Set<string>} */
  const literals = new Set();
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "bundles") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(?:js|mjs|ts|json|html)$/.test(entry.name)) continue;
      // The catalogs themselves are data, not references.
      if (full.startsWith(LOCALES_DIR)) continue;
      let src = "";
      try {
        src = fs.readFileSync(full, "utf8");
      } catch (e) {
        continue;
      }
      for (const m of src.matchAll(/["'`]([A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+)+)["'`]/g)) literals.add(m[1]);
    }
  };
  for (const dir of REF_ROOTS) walk(path.join(ROOT, dir));
  return literals;
}

/** Keys that exist in the catalog but in no source file. */
export function orphanKeys(audit, literals) {
  const out = [];
  for (const key of audit.keys[0].keys()) {
    if (!literals.has(key)) out.push(key);
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const audit = auditCatalogs();
  const literals = collectSourceLiterals();
  const orphans = orphanKeys(audit, literals);
  if (argv.includes("--json")) {
    console.log(JSON.stringify({
      langs: audit.langs,
      namespaces: audit.namespaces,
      problems: audit.problems,
      warnings: audit.warnings,
      orphans: orphans,
    }, null, 2));
  } else {
    console.log("i18n 目录审计（public/locales）");
    for (const lang of LANGS) {
      const row = audit.langs[lang];
      console.log(`  ${lang}: ${row.keys} 条` + (row.error ? `  ✗ ${row.error}` : ""));
    }
    console.log("  命名空间：" + audit.namespaces.map((n) => `${n.name} ${n.keys}`).join(" · "));
    if (audit.warnings.length) {
      console.log(`\n  提示 ${audit.warnings.length} 条（不拦门禁）：`);
      for (const w of audit.warnings.slice(0, 10)) console.log(`    ${w.code} ${w.key} — ${w.detail}`);
    }
    if (orphans.length) {
      console.log(`\n  孤儿 key ${orphans.length} 条（源码里没有引用，考虑删除或补接线）：`);
      for (const key of orphans.slice(0, 20)) console.log(`    ? ${key}`);
    }
    if (audit.problems.length) {
      console.error(`\n  目录校验失败 ${audit.problems.length} 条：`);
      for (const p of audit.problems.slice(0, 40)) console.error(`    ${p.code} ${p.key} — ${p.detail}`);
    } else {
      console.log("  校验通过：两语言可读 / key 集合一致 / 无空译文 / 占位符一致 / 复数有 other / key 形态合法");
    }
  }
  if (audit.problems.length) process.exitCode = 1;
  if (argv.includes("--strict-orphans") && orphans.length) process.exitCode = 1;
}

// Run as a CLI only; `check-i18n.mjs` imports the pure functions above.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
