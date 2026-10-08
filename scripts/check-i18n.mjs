// scripts/check-i18n.mjs — 双语插件覆盖度审计（报告用，不拦构建）
// ─────────────────────────────────────────────────────────────────────────────
// 扫 public/**/*.{js,html} 里含中文的字符串（字面量 + HTML 文本），与 /shared/i18n-dict.js 比对：
//   · 未覆盖 Top N：按出现次数排序 —— 增量补字典就补这些（不用改调用点）
//   · 过期条目：字典里有、源码里找不到的（多半是文案改过了，删掉免得误导）
//
// 用法：node scripts/check-i18n.mjs [--top 40]
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ROOT = path.resolve(import.meta.dirname, "..");
const PUB = path.join(ROOT, "public");
const CJK = /[\u3400-\u9fff]/;
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const EXT = new Set([".js", ".html"]);

function listFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(abs, out);
    else if (EXT.has(path.extname(e.name)) && !e.name.endsWith(".min.js")) out.push(abs);
  }
  return out;
}

// 近似去注释：行内 //、块 /* */、HTML <!-- -->（用于降低误报，不求完美）
function stripComments(src, isHtml) {
  let t = src.replace(/\/\*[\s\S]*?\*\//g, " ");
  t = t.split(/\r?\n/).map((l) => {
    const i = l.indexOf("//");
    if (i < 0) return l;
    // 别把 "http://..." 这种字符串里的 // 当注释
    const before = l.slice(0, i);
    if (/'[^']*$|"[^"]*$|`[^`]*$/.test(before)) return l;
    return before;
  }).join("\n");
  if (isHtml) t = t.replace(/<!--[\s\S]*?-->/g, " ");
  return t;
}

// 线性扫描取字符串字面量（不用正则：带反向引用的贪婪/懒惰组合会在 app.js 这种大文件上
// 灾难性回溯 —— 第一版实测直接卡死，别改回去）。
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

// 载入字典
let dict = {}, patterns = [];
const dictPath = path.join(PUB, "shared", "i18n-dict.js");
if (fs.existsSync(dictPath)) {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(dictPath, "utf8"), sandbox);
  dict = sandbox.__i18nDict || {};
  patterns = sandbox.__i18nPatterns || [];
} else {
  console.log("（还没有 public/shared/i18n-dict.js —— 全部算未覆盖）");
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

const topArg = process.argv.indexOf("--top");
const top = topArg >= 0 ? (Number(process.argv[topArg + 1]) || 40) : 40;

console.log(`双语覆盖度审计（public/，含中文的字符串）`);
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
