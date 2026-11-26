#!/usr/bin/env node
// @ts-check
// scripts/check-global-collisions.mjs — no two classic scripts may declare the same top-level
// lexical name (wired into CI verify).
//
// Why: every script in the boot manifest shares one global lexical environment. Two scripts that
// both declare `const X` at top level make the LATER one fail instantiation outright ("Identifier
// 'X' has already been declared") — not one broken function but the whole artifact dead: its
// service and its wiring never run, the global name is missing, the feature disappears silently.
// Two pairs were caught in the wild on 2026-11-15: `STYLES` (theme.js × portrait.js, portraits
// stopped entirely) and `TOKEN_KEY` (token.js × chat-realtime.js, live sync stopped entirely).
// A per-file syntax gate cannot see this: each file parses fine on its own.
//
// Criterion 1: collect top-level `const` / `let` (no leading indent) across files; a duplicate name
// is red. `var` may be redeclared, so it does not count.
// Criterion 2: duplicate top-level `function` names are red too. They do not throw — the later
// script just replaces the global property — so callers of the earlier one silently run someone
// else's code. That was the 2026-11-15 real-window incident: 26 artifacts each declared top-level
// `recOf` with two different semantics (`null` vs `{}`), and world-book parsing judged the result
// "not an object", returning 0 entries without a word.
// Exemption: a whole file wrapped in one IIFE (the emit shape, `(function () { … })();`) — its
// declarations are closure-private and never reach the global. emit supplies that wrapper;
// hand-written scripts must not rely on it.
// A top-level `function` sharing a name with a top-level `const` is not red: the function lands as a
// global property and the lexical binding shadows it, which is legal.
//
// Usage: node scripts/check-global-collisions.mjs → exit 0 when clean, else print every hit and exit 1.
// Dependencies: none.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Directories the boot manifest actually loads (hand-written and emitted); order is irrelevant — only names are collected. */
const SCAN_ROOTS = [
  'public/js',
  'public/shared',
  'public/services',
  'public/shell',
  'public/tools',
];

const DECL_RE = /^(?:const|let)\s+([A-Za-z_$][\w$]*)/gm;
const FN_DECL_RE = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm;

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      walk(p, out);
    } else if (p.endsWith('.js')) {
      out.push(p);
    }
  }
  return out;
}

const files = SCAN_ROOTS.flatMap((r) => walk(path.join(ROOT, r), []));
const owners = new Map(); // name -> [file, ...]
/** Top-level function declarations are collected separately: no redeclaration error, the later one silently wins. */
const fnOwners = new Map();
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  // An emit artifact is one IIFE end to end, so every "line-start declaration" inside it is
  // closure-scoped and cannot collide. Hand-written scripts are scanned as usual.
  if (/^\s*\(function \(\) \{\r?\n/.test(src) && /\}\)\(\);\s*$/.test(src)) continue;
  for (const m of src.matchAll(DECL_RE)) {
    if (!owners.has(m[1])) owners.set(m[1], []);
    owners.get(m[1]).push(rel);
  }
  for (const m of src.matchAll(FN_DECL_RE)) {
    if (!fnOwners.has(m[1])) fnOwners.set(m[1], []);
    fnOwners.get(m[1]).push(rel);
  }
}

const hits = [];
for (const [name, list] of [...owners].sort()) {
  const uniq = [...new Set(list)];
  if (uniq.length > 1) hits.push({ name, files: uniq });
}

// Same-name top-level functions do not throw: the later script swaps the global property and the
// earlier one's callers end up in the wrong implementation (the 2026-11-15 recOf incident above).
const fnHits = [];
for (const [name, list] of [...fnOwners].sort()) {
  const uniq = [...new Set(list)];
  if (uniq.length > 1) fnHits.push({ name, files: uniq });
}

if (hits.length || fnHits.length) {
  if (hits.length) {
    console.error('[check-global-collisions] 顶层 const/let 跨文件重声明，后加载的脚本会整体失效：');
    for (const h of hits) {
      console.error(`  ✗ ${h.name} → ${h.files.join(' , ')}`);
    }
  }
  if (fnHits.length) {
    console.error('[check-global-collisions] 顶层 function 跨文件同名，后加载者静默覆盖先加载者：');
    for (const h of fnHits) {
      console.error(`  ✗ ${h.name} → ${h.files.join(' , ')}`);
    }
  }
  console.error(`  共 ${hits.length + fnHits.length} 组。服务侧产物已由 emit 包进 IIFE（私有辅助不外泄），`);
  console.error(`  手写脚本请带域前缀，别改先加载的那份。`);
  process.exit(1);
}
console.log(
  `[check-global-collisions] ${files.length} 个 classic 脚本，顶层词法名与顶层函数名均无跨文件冲突 ✓`
);
