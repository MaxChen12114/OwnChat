// scripts/check-syntax.mjs — 真语法门（改代码后、部署前跑）
// ─────────────────────────────────────────────────────────────
// 为什么需要它:`node --check` 在本仓库**会漏报**。实测(有正控):
//   文件 = `export default {...}` 且多一个 `}` → `node --check xxx.js` 退出码 0,而实际执行/打包报
//   「Unexpected "}"」。原因是没有 package.json,Node 靠"语法探测"决定 ESM/CJS,那条探测分支里
//   没把错误冒出来 —— 一个"绿得发假"的检查比没有更危险。
//   2026-10-05 就是这么让一个多余的 `}` 混进 src/worker.js 的(最后靠 wrangler 的 esbuild 抓到)。
//   注意:同一份文件改名成 .mjs 后 `--check` **能**报错 —— 所以本脚本的做法是:
//   ESM 文件复制到临时目录改名 .mjs 再交给 `node --check`(只解析、不执行)。
//
// 另一件事:wrangler 只解析 src/worker.js 那条 import 链,**不解析 public/**。
// 前端脚本写坏了会原样上传、静默上线 —— 这个脚本把 public/ 也一起过一遍。
//
// 解析器选择:
//   · 经典脚本(public/js/**、HTML 内联 <script>) → `new vm.Script(...)` 真解析,报错带行列
//   · ES 模块(src/**、scripts/*.mjs)             → 临时 .mjs 副本 + `node --check`(零副作用)
//   · HTML 内联块先剥掉 `<!-- -->` 注释再抽取(注释里写过 <script> 字样,不剥就会错位)
//
// 用法: node scripts/check-syntax.mjs
// 退出码: 0 = 全部通过;1 = 有文件解析失败(逐条列出)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "..");
const SKIP_DIRS = new Set(["node_modules", ".git", ".wrangler", "dist", "build"]);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "oai-syntax-"));

const failures = [];
let checked = 0;
const isEsm = (src) => /(^|\n)\s*(import|export)[\s{*]/.test(src);

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, out); }
    else out.push(p);
  }
  return out;
}
const fail = (rel, msg) => failures.push(`${rel}\n      ${String(msg).trim().split("\n").slice(0, 3).join("\n      ")}`);

/** 经典脚本:进程内真解析 */
function checkClassic(rel, code) {
  checked++;
  try { new vm.Script(code, { filename: rel }); }
  catch (e) { fail(rel, e.message); }
}

/** ES 模块:临时 .mjs 副本 + `node --check`(只解析不执行,避免跑出副作用) */
function checkModule(rel, code) {
  checked++;
  const tmp = path.join(TMP, crypto.createHash("sha1").update(rel).digest("hex") + ".mjs");
  fs.writeFileSync(tmp, code, "utf8");
  const r = spawnSync(process.execPath, ["--check", tmp], { encoding: "utf8" });
  if (r.status !== 0) {
    // 报错里的路径换成仓库内相对路径,并去掉临时目录噪音
    const msg = ((r.stderr || "") + (r.stdout || "")).replaceAll(tmp, rel).replace(/^\s*at .*$/gm, "").trim();
    fail(rel, msg);
  }
}

/** HTML:剥注释(保留换行以维持行号)→ 抽内联块 → 逐块解析 */
function checkHtml(rel, src) {
  const stripped = src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
  let i = 0;
  for (const m of stripped.matchAll(/<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    const code = m[1];
    if (!code.trim()) continue;
    i++;
    const label = `${rel} · 内联 <script> #${i}`;
    if (isEsm(code) || /type\s*=\s*["']module["']/i.test(m[0])) checkModule(label, code);
    else checkClassic(label, code);
  }
}

try {
  const files = walk(path.join(ROOT, "src")).concat(walk(path.join(ROOT, "public")), walk(path.join(ROOT, "scripts")))
    // 2026-11-09：public/models/ 是第三方 vendored 资产（transformers.min.js 是 ESM 包），
    // 不该按"我们自己的脚本"来检查；它也不进仓库（.gitignore）。
    .filter((f) => !f.includes(path.join("public", "models") + path.sep));
  for (const abs of files) {
    const rel = path.relative(ROOT, abs).replace(/\\/g, "/");
    const ext = path.extname(abs).toLowerCase();
    if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
      const code = fs.readFileSync(abs, "utf8");
      // src/** 与 scripts/** 是 ESM;public/** 里带 import/export 的也走模块解析
      if (ext === ".mjs" || isEsm(code)) checkModule(rel, code);
      else checkClassic(rel, code);
    } else if (ext === ".html") {
      checkHtml(rel, fs.readFileSync(abs, "utf8"));
    }
  }
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`[check-syntax] 解析 ${checked} 个脚本${failures.length ? `，${failures.length} 个失败:` : "，全部通过 ✓"}`);
if (failures.length) {
  console.log("");
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
}
