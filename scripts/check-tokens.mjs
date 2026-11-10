#!/usr/bin/env node
// scripts/check-tokens.mjs — 设计令牌体检（16.4）
// 扫 public/ 下 .html/.css/.js：收集 --token 定义（`:root{--x:..}`、style 块、JS 字符串均可）
// 与 var(--token) 引用；报「用了不存在的令牌」（exit 1）与「定义了没人用」（提示）。
// 跑法：node scripts/check-tokens.mjs [--dir public]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DIR = path.resolve(ROOT, process.argv.includes("--dir") ? process.argv[process.argv.indexOf("--dir") + 1] : "public");
const EXTS = new Set([".html", ".css", ".js", ".mjs"]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXTS.has(path.extname(e.name))) out.push(p);
  }
  return out;
}

const files = walk(DIR);
const defs = new Map();   // token -> [位置]
const uses = new Map();   // token -> [位置]
const DEF_RE = /(^|[^-\w])(--[\w-]+)\s*:/g;          // 定义：--x:（排除 --x- 前缀误配）
const SET_RE = /setProperty\(\s*['"`](--[\w-]+)/g;   // 定义：JS 动态 setProperty('--x', ..)
const USE_RE = /var\(\s*(--[\w-]+)\s*(,)?/g;         // 引用：var(--x，捕获有无兜底参数

for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, "/");
  const text = fs.readFileSync(f, "utf8");
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const m of line.matchAll(DEF_RE)) {
      const tok = m[2];
      if (!defs.has(tok)) defs.set(tok, []);
      defs.get(tok).push(`${rel}:${i + 1}`);
    }
    for (const m of line.matchAll(SET_RE)) {
      const tok = m[1];
      if (!defs.has(tok)) defs.set(tok, []);
      defs.get(tok).push(`${rel}:${i + 1} (setProperty)`);
    }
    for (const m of line.matchAll(USE_RE)) {
      const tok = m[1];
      if (!uses.has(tok)) uses.set(tok, []);
      uses.get(tok).push(`${rel}:${i + 1}${m[2] ? "（有兜底）" : ""}`);
    }
  });
}

const missing = [...uses.keys()].filter((t) => !defs.has(t)).sort();
const unused = [...defs.keys()].filter((t) => !uses.has(t)).sort();

console.log(`[tokens] 扫描 ${files.length} 个文件 · 定义 ${defs.size} · 引用 ${uses.size}`);
if (missing.length) {
  console.log("\n✗ 用了不存在的令牌（会渲染成 fallback 或空）：");
  for (const t of missing) console.log(`  ${t}  ←  ${uses.get(t).slice(0, 3).join(", ")}${uses.get(t).length > 3 ? ` 等 ${uses.get(t).length} 处` : ""}`);
}
if (unused.length) {
  console.log("\n○ 定义了但没人引用（提示，不算错）：");
  for (const t of unused) console.log(`  ${t}  （${defs.get(t)[0]}）`);
}
if (missing.length) { console.log(`\nFAIL：${missing.length} 个缺失令牌`); process.exit(1); }
console.log("\nOK — 所有 var() 引用都有定义");
