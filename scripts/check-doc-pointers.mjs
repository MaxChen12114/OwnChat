#!/usr/bin/env node
// @ts-check
// scripts/check-doc-pointers.mjs — code must not name a process document or its section number
// (wired into CI verify).
//
// Why: plans, proposals, work orders, placement tables and round ledgers live in a process archive
// outside the repo; they are history written for people. Their section numbers drift with every
// revision, so a pointer in code rots by construction — once `§5.3 decision a` is shortened to
// `§5.3 a`, a reader can search the whole repo and never find it (measured 2026-11-15: neither plan
// document had a §5.3 at all). The rule lives in AGENTS.md, but a "must not" in prose without a
// gate is only a reminder — this repo has already paid for that mistake.
//
// Criterion: any hit is red, no allowlist. When an anchor is genuinely needed, point at a live
// source that a test pins (AGENTS.md, schema.json, the header of a test/*.test.mjs): those change
// rarely and go red the moment they do, so the pointer cannot rot silently.
//
// Usage: node scripts/check-doc-pointers.mjs → exit 0 when clean, else print every hit and exit 1.
// Dependencies: none.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = path.basename(fileURLToPath(import.meta.url));

/** Scan roots: where hand-written code lives. Generated trees (public/services, public/bundles) are not listed. */
const SCAN_ROOTS = [
  'core',
  'services',
  'app',
  'l0',
  'scripts',
  'test',
  'bundles',
  'src',
  'public/js',
  'public/shared',
  'public/shell',
  'public/tools',
];

const EXTENSIONS = new Set(['.ts', '.js', '.mjs']);
/** Generated and dependency directories, skipped even when they sit under a scan root. */
const SKIP_DIRS = new Set(['node_modules', 'services', 'bundles', 'dist']);

// The archive directory name is assembled from fragments: this file is inside a scan root, so writing
// it whole would make the gate match itself.
const ARCHIVE_DIR = `${'_'}${'docs'}\\/`;

const PATTERNS = [
  { re: new RegExp(ARCHIVE_DIR, 'u'), label: '过程文档目录路径' },
  { re: /计划\s*§/u, label: '计划文档章节号' },
  { re: /方案\s*§/u, label: '方案文档章节号' },
  { re: /施工单\s*§/u, label: '施工单章节号' },
  { re: /交接文档\s*§/u, label: '交接文档章节号' },
  { re: /plan\s*§/iu, label: '英文计划文档章节号' },
  { re: /见账本/u, label: '轮次账本引用' },
];

const hits = [];

/** @param {string} dir @returns {void} */
function walk(dir) {
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.') || SKIP_DIRS.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walk(full);
      continue;
    }
    if (ent.name === SELF) continue;
    if (!EXTENSIONS.has(path.extname(ent.name))) continue;
    scan(full);
  }
}

/** @param {string} file @returns {void} */
function scan(file) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { re, label } of PATTERNS) {
      re.lastIndex = 0;
      if (re.test(line)) {
        hits.push({ rel, line: i + 1, label, text: line.trim().slice(0, 140) });
        break;
      }
    }
  }
}

for (const root of SCAN_ROOTS) walk(path.join(ROOT, root));

if (hits.length === 0) {
  console.log('[check-doc-pointers] 代码里没有过程文档指针 ✓');
  process.exit(0);
}

for (const h of hits) {
  console.error(`  ✗ ${h.rel}:${h.line}  ${h.label}`);
  console.error(`      ${h.text}`);
}
console.error(`[check-doc-pointers] ${hits.length} 处过程文档指针。`);
console.error('[check-doc-pointers] 注释只写结论本身；要锚点就指 AGENTS.md、bundles/agent/manifest/schema.json 或 test/*.test.mjs 的文件头。');
process.exit(1);
