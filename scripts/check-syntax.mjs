// Real syntax gate: run it after touching code and before deploying.
//
// Why `node --check` is not enough here: it under-reports. Measured against a positive control, a
// file holding `export default {...}` plus one extra `}` exits 0 under `node --check xxx.js` while
// executing or bundling it reports `Unexpected "}"`. With no package.json, Node guesses ESM vs CJS
// and that probe path swallows the error — a check that goes green for the wrong reason is worse
// than none. That is how a stray `}` reached src/worker.js on 2026-10-05 and was caught only by
// wrangler's esbuild. Renaming the same file to .mjs does make `--check` fail, so ESM sources are
// copied into a temp dir as .mjs and parsed there (parse only, never execute).
//
// wrangler parses just the import chain of src/worker.js; public/** is invisible to it, so a broken
// frontend script uploads and ships silently. This gate covers public/ and l0/ as well.
//
// Parser choice:
//   classic scripts (public/js/**, inline <script>) -> `new vm.Script(...)`, real parse with line/col
//   ES modules (src/**, scripts/*.mjs, l0/**)       -> temp .mjs copy + `node --check`, no side effects
//   inline HTML blocks blank out `<!-- -->` first, because that text contains the literal `<script`
//   and without stripping, span extraction lands in the wrong place.
//
// Usage: node scripts/check-syntax.mjs   → exit 0 all parsed, exit 1 with every failure listed

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
// Type stripping is the Node 22.13+ built-in. CI runs Node 20, so the skip is explicit and
// counted, never silent.
import * as nodeModule from "node:module";

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "..");
const SKIP_DIRS = new Set(["node_modules", ".git", ".wrangler", "dist", "build"]);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "oai-syntax-"));

const failures = [];
let checked = 0;
/** Concatenation halves (open/close one shared IIFE) cannot parse alone; their emitted product is
 * parsed instead. The marker is explicit, and the skip is counted in the summary — never silent. */
let wiringPartsSkipped = 0;
/** `.ts` files skipped for lack of the stripping API. When > 0 the summary line must say so, or
 * the green is fake. */
let tsSkipped = 0;
const isEsm = (src) => /(^|\n)\s*(import|export)[\s{*]/.test(src);

/** TypeScript to JavaScript, types only and no transform. Returns null where the runtime lacks
 * the API; the caller counts that case itself. */
function stripTypes(code) {
  const strip = typeof nodeModule.stripTypeScriptTypes === "function" ? nodeModule.stripTypeScriptTypes : null;
  if (strip === null) return null;
  try {
    return strip(code, { sourceMap: false });
  } catch (e) {
    // The stripper is fail-closed on non-erasable syntax (enum / namespace / parameter
    // properties). The failure is the point, but the report must name the file, so it is wrapped
    // and rethrown into the caller's failure list.
    throw new Error("TS 解析失败：" + e.message);
  }
}

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

/** Classic script: parsed in-process. */
function checkClassic(rel, code) {
  checked++;
  try { new vm.Script(code, { filename: rel }); }
  catch (e) { fail(rel, e.message); }
}

/** ES module: temp .mjs copy parsed by `node --check`, so nothing executes. */
function checkModule(rel, code) {
  checked++;
  const tmp = path.join(TMP, crypto.createHash("sha1").update(rel).digest("hex") + ".mjs");
  fs.writeFileSync(tmp, code, "utf8");
  const r = spawnSync(process.execPath, ["--check", tmp], { encoding: "utf8" });
  if (r.status !== 0) {
    // Rewrite the temp path back to the repo-relative one and drop the stack frames.
    const msg = ((r.stderr || "") + (r.stdout || "")).replaceAll(tmp, rel).replace(/^\s*at .*$/gm, "").trim();
    fail(rel, msg);
  }
}

/** HTML: blank out comments (newlines kept so line numbers hold) -> extract inline blocks -> parse each. */
function checkHtml(rel, src) {
  const stripped = src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
  let i = 0;
  for (const m of stripped.matchAll(/<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    const code = m[1];
    if (!code.trim()) continue;
    // `<script type="application/json">` is a data block (the build-injected tool-page catalog),
    // not JavaScript — parsing it as code fails on the first colon.
    const typeAttr = /type\s*=\s*["']([^"']+)["']/i.exec(m[0]);
    if (typeAttr && !/^(?:module|text\/javascript|application\/javascript)$/i.test(typeAttr[1])) continue;
    i++;
    const label = `${rel} · 内联 <script> #${i}`;
    if (isEsm(code) || /type\s*=\s*["']module["']/i.test(m[0])) checkModule(label, code);
    else checkClassic(label, code);
  }
}

try {
  const files = walk(path.join(ROOT, "src"))
    .concat(
      walk(path.join(ROOT, "public")),
      walk(path.join(ROOT, "scripts")),
      // l0/ is the offline startup tooling (pure node + ESM). Leaving it out would give a new
      // generator neither a syntax gate nor regression discovery — a false green.
      walk(path.join(ROOT, "l0")),
      // server/ is the Node-side spike (server/local.mjs). It is not on the wrangler import chain,
      // so without this root a break there would only surface when someone runs it by hand.
      walk(path.join(ROOT, "server")),
      // services/, core/ and lib/ are the TS sources emit consumes, and used to sit outside the scan
      // roots: a break only surfaced when someone ran emit, which no build runs on every change.
      walk(path.join(ROOT, "services")),
      walk(path.join(ROOT, "core")),
      // lib/ is the shell-side shared layer (i18n moved there 2026-11-26): same rule as core/.
      walk(path.join(ROOT, "lib")),
    )
    // public/models/ holds vendored third-party assets (transformers.min.js ships as ESM) and is
    // gitignored: not our scripts, so not our gate.
    .filter((f) => !f.includes(path.join("public", "models") + path.sep));
  for (const abs of files) {
    const rel = path.relative(ROOT, abs).replace(/\\/g, "/");
    const ext = path.extname(abs).toLowerCase();
    if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
      const code = fs.readFileSync(abs, "utf8");
      if (code.startsWith("/* l0-wiring-part:")) { wiringPartsSkipped++; continue; }
      // src/**, scripts/** and l0/** are ESM; anything under public/ carrying import/export too.
      if (ext === ".mjs" || isEsm(code)) checkModule(rel, code);
      else checkClassic(rel, code);
    } else if (ext === ".ts") {
      // Node 22.13+ ships type stripping. Environments without the API (CI runs Node 20) skip the
      // file and count it in `tsSkipped`; a skip is reported, never passed off as a pass.
      let stripped;
      try {
        stripped = stripTypes(fs.readFileSync(abs, "utf8"));
      } catch (e) {
        // The stripper doubles as the TS parser, so syntax errors surface here. Record per file
        // instead of aborting the whole sweep on the first one.
        checked++;
        fail(rel, e.message);
        continue;
      }
      if (stripped === null) {
        tsSkipped++;
        continue;
      }
      checkModule(rel, stripped);
    } else if (ext === ".html") {
      checkHtml(rel, fs.readFileSync(abs, "utf8"));
    }
  }
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`[check-syntax] 解析 ${checked} 个脚本${wiringPartsSkipped ? `（另有 ${wiringPartsSkipped} 个接线拼接片段跳过：与宿主共享 IIFE，产物已整体解析）` : ""}${tsSkipped ? `（另有 ${tsSkipped} 个 .ts 因环境无类型剥离 API 跳过，未检查）` : ""}${failures.length ? `，${failures.length} 个失败:` : "，全部通过 ✓"}`);
if (failures.length) {
  console.log("");
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
}
