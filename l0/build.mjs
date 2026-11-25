#!/usr/bin/env node
// l0/build.mjs — L0a-2: the boot-manifest generator, and the only entry allowed to write
// public/index.html and l0/scripts.json.
//
// Why this lives apart from l0/manifest.mjs: that module is pinned by a structural lock to expose no
// write API (the lock proves the read side stays free of side effects), so every disk write belongs
// here. This file only reads, plans and writes; parseScriptTags / planVersions / render /
// contentHash come from manifest.mjs.
//
// Rules (owner decision, 2026-11-14):
//   1) `?v=` is the content hash (first 8 hex of sha256). Rerun after touching any public/** script;
//      wrangler [build] already calls --write, so deployment heals it automatically.
//   2) `--check` is an offline tool and stays out of run-regression: it would fight every business
//      change.
//
// Two shapes, told apart by the presence of the boot line in index.html:
//   · legacy shape (125 tags): --write does a value-level `?v=` surgery (the α1 behaviour).
//   · boot shape (107 external tags collapsed into one bootstrap line): the manifest in
//     l0/scripts.json is the source of truth. An item may carry `w` (load-order archaeology,
//     stripped when rendering), and the boot line is generated from the manifest — adding a script
//     means editing scripts.json, the source, never the generated line.
//
// Modes:
//   node l0/build.mjs            # read-only report (drift details included)
//   node l0/build.mjs --check    # drift → exit 1 (release gate)
//   node l0/build.mjs --write    # write (per-shape semantics; idempotent: no drift, no write)
//   node l0/build.mjs --adopt    # one-shot migration: legacy shape → boot shape
// Common flag: --root DIR (defaults to the repo root; tests point it at a synthetic fixture).
// Exit codes: 0 = fine or already current; 1 = missing file (fail-closed) / drift under --check /
// corrupt manifest.
//
// Bootstrap-loader invariant (ships only after a real-window check):
//   document.write emits the <script> tags one at a time — parser-inserted and individually
//   blocking, which matches how the original 107 tags behaved at parse time (same order, same
//   DOMContentLoaded timing, same defer semantics for modules). The emitted open tag never contains
//   the literal `</script` (the string is assembled as '</'+'script>'), so the inline body cannot be
//   terminated early.
import fs from "node:fs";
import { scanToolPages, catalogState, placeCatalog } from "./tool-pages.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseScriptTags, planVersions, render, contentHash, stripComments } from "./manifest.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOOT_MARK = "l0-boot-v1";

/**
 * The boot-line loader body, extracted textually from app/boot.ts — the single definition. It is not
 * imported because CI runs Node 20, which has no type stripping; a failed extraction is red on
 * purpose, never a silent fallback to an inline copy.
 */
function bootLoader() {
  // Anchored one level above l0/ (repo level) so it ignores --root: fixtures test emission, and the
  // loader always comes from the repo's app/boot.ts.
  const src = fs.readFileSync(path.resolve(HERE, "..", "app", "boot.ts"), "utf8");
  const m = /^export const BOOT_LOADER_BODY = "(.*)";$/m.exec(src);
  if (!m) throw new Error("app/boot.ts 缺 BOOT_LOADER_BODY（加载器真源被改形，同步锁会拦）");
  return JSON.parse('"' + m[1] + '"');
}

/** Render the boot line from manifest items (v = content hash; routes carry none; cdn keeps SRI). */
function renderBootLine(items) {
  return "<script>/*" + BOOT_MARK + "*/(function(){var m=" + JSON.stringify(items) + ";" + bootLoader() + "})();</script>";
}

/** Manifest item + on-disk content → render item. A missing file throws here: the fail-closed point. */
function toRenderItems(manifest, root) {
  return manifest.map((it) => {
    if (it.c === "cdn") {
      const o = { s: it.s };
      if (it.x) o.x = it.x;
      if (it.o) o.o = it.o;
      return o;
    }
    if (it.c === "route") return { s: it.s };
    const abs = path.join(root, "public", ...it.s.split("/").filter(Boolean));
    // Hash over LF-normalised text (same fix as manifest.mjs): immune to the checkout's line endings.
    const v = contentHash(fs.readFileSync(abs).toString("utf8").replace(/\r\n/g, "\n"));
    return it.c === "module" ? { s: it.s, v, t: "module" } : { s: it.s, v };
  });
}

/**
 * Extract the external-script manifest from a legacy html. HTML comments sitting immediately above a
 * tag are that tag's load-order notes and become its `w`.
 */
function extractManifest(html, warn) {
  const { entries } = parseScriptTags(html);
  const ext = entries.filter((e) => e.kind !== "inline");
  if (ext.length === 0) return null;
  const out = [];
  let cursor = ext[0].offset;
  for (let i = 0; i < ext.length; i++) {
    const e = ext[i];
    // Only the gap between the previous tag's end and this tag belongs to this tag.
    const gap = html.slice(cursor, e.offset);
    const whys = [];
    for (const m of gap.matchAll(/<!--([\s\S]*?)-->/g)) {
      const t = m[1].replace(/\s+/g, " ").trim();
      if (t) whys.push(t);
    }
    const item = { s: e.srcPath };
    const q = e.src.indexOf("?");
    const base = q < 0 ? e.src : e.src.slice(0, q);
    item.s = base;
    if (e.kind === "cdn") {
      item.c = "cdn";
      const x = /integrity\s*=\s*"([^"]*)"/i.exec(e.attrs);
      const o = /crossorigin\s*=\s*("([^"]*)"|'([^']*)')/i.exec(e.attrs);
      if (x) item.x = x[1];
      if (o) item.o = o[2] ?? o[3];
    } else if (e.kind === "module") item.c = "module";
    else if (base === "/config.js") item.c = "route";
    else item.c = "classic";
    if (whys.length) item.w = whys.join(" ");
    out.push(item);
    cursor = html.indexOf("</script", e.offset) + "</script".length;
  }
  if (warn) {
    // Conservative: comments after the block and before the next inline script follow no tag, so
    // they stay where they are and are only reported.
    const tail = html.slice(cursor, (() => {
      const nextInline = parseScriptTags(html).entries.find((x) => x.kind === "inline" && x.offset > cursor);
      return nextInline ? nextInline.offset : html.length;
    })());
    for (const m of tail.matchAll(/<!--([\s\S]*?)-->/g)) {
      const t = m[1].replace(/\s+/g, " ").trim();
      if (t) warn.push(t.slice(0, 60));
    }
  }
  return out;
}

/** Locate the boot line's source span [open, closeEnd) in the html. */
function bootSpan(html) {
  const { entries } = parseScriptTags(html);
  const boot = entries.find((e) => e.kind === "inline" && (() => {
    const openEnd = html.indexOf(">", e.offset) + 1;
    return html.slice(openEnd, html.indexOf("</script", openEnd)).includes(BOOT_MARK);
  })());
  if (!boot) return null;
  const close = html.indexOf("</script", boot.offset);
  return [boot.offset, close + "</script>".length];
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  const has = (name) => argv.includes(name);
  // Tests point --root at a synthetic fixture (it must contain public/index.html); the default is
  // the repo root, one level above l0/.
  const ROOT = path.resolve(flag("--root") || path.resolve(HERE, ".."));
  const HTML_PATH = path.join(ROOT, "public", "index.html");
  // The manifest follows --root as well: the repo's l0/scripts.json by default, the fixture's own
  // l0/ directory under test.
  const SCRIPTS_JSON = path.join(ROOT, "l0", "scripts.json");
  const html = fs.readFileSync(HTML_PATH, "utf8");
  const isBootEra = html.includes(BOOT_MARK);

  // adopt: one-shot migration, legacy shape only.
  if (has("--adopt")) {
    if (isBootEra) {
      console.log("[l0/build] 已是 boot 形态，--adopt 无事可做（幂等）");
      return;
    }
    const warns = [];
    const manifest = extractManifest(html, warns);
    if (!manifest) {
      console.log("[l0/build] ✗ 没有外链标签可收敛（清单为空）");
      process.exit(1);
    }
    const items = toRenderItems(manifest, ROOT); // A missing file fails closed here.
    const { entries } = parseScriptTags(html);
    const ext = entries.filter((e) => e.kind !== "inline");
    const spanStart = ext[0].offset;
    const spanEnd = html.indexOf("</script", ext[ext.length - 1].offset) + "</script>".length;
    const bootLine = renderBootLine(items);
    const out = html.slice(0, spanStart) + bootLine + html.slice(spanEnd);
    if (parseScriptTags(out).entries.length !== entries.length - ext.length + 1) {
      console.log("[l0/build] ✗ 收敛后标签数不对（解析器与替换区间不同源），拒绝落盘");
      process.exit(1);
    }
    fs.writeFileSync(SCRIPTS_JSON, JSON.stringify({ version: 1, note: "加载清单唯一真源：顺序即执行顺序；w=加载顺序注解（boot 行渲染时剥掉）。加脚本=在此追加一项，再跑 --write。", scripts: manifest }, null, 2) + "\n", "utf8");
    fs.writeFileSync(HTML_PATH, out, "utf8");
    // Idempotence: re-rendering must reproduce the written boot line byte for byte.
    const again = renderBootLine(toRenderItems(manifest, ROOT));
    if (again !== bootLine) {
      console.log("[l0/build] ✗ boot 行不幂等（清单渲染与写入不同源），已落盘请先修");
      process.exit(1);
    }
    console.log(`[l0/build] --adopt 完成：${manifest.length} 个外链标签 → 1 行 boot（清单真源 l0/scripts.json，含 ${manifest.filter((m) => m.w).length} 条顺序注解）`);
    for (const w of warns) console.log(`  ⚠ 块尾游离注释（未跟随任何标签，留在原位）：${w}`);
    return;
  }


  // boot shape: manifest → boot line.
  if (isBootEra) {
    const base = JSON.parse(fs.readFileSync(SCRIPTS_JSON, "utf8"));
    const manifest = base.scripts;
    if (!Array.isArray(manifest) || manifest.length === 0) {
      console.log("[l0/build] ✗ l0/scripts.json 损坏（缺 scripts 数组）");
      process.exit(1);
    }
    const items = toRenderItems(manifest, ROOT);
    const fresh = renderBootLine(items);
    const span = bootSpan(html);
    const current = html.slice(span[0], span[1]);
    const curItems = JSON.parse(/var m=(\[[\s\S]*?\]);/.exec(current)[1]);
    const drift = JSON.stringify(curItems) !== JSON.stringify(items);
    const pages = scanToolPages(ROOT, (msg) => { console.error(`[l0/build] ✗ ${msg}`); process.exit(1); });
    const cat = catalogState(html, pages);
    const catalogDrift = cat.drift;
    const st = (d) => (d ? "需更新" : "已是最新");
    console.log(`[l0/build] boot 形态：${manifest.length} 项 · boot ${st(drift)} · 工具页 ${pages.length} 个 · 目录 ${st(catalogDrift)}`);
    if (has("--write")) {
      if (!drift && !catalogDrift) {
        console.log("[l0/build] 已是最新，零写入（幂等）");
        return;
      }
      // Catalog sits right before the boot line so the renderer reads it synchronously (no fetch).
      const staged = catalogDrift ? placeCatalog(html, cat.fresh, cat.span, span[0]) : html;
      const span2 = bootSpan(staged);
      fs.writeFileSync(HTML_PATH, staged.slice(0, span2[0]) + fresh + staged.slice(span2[1]), "utf8");
      // Idempotence: re-rendering must reproduce the written boot line byte for byte.
      const again = renderBootLine(toRenderItems(manifest, ROOT));
      if (again !== fresh) {
        console.log("[l0/build] ✗ boot 行不幂等（清单渲染与写入不同源），已落盘请先修");
        process.exit(1);
      }
      console.log(`[l0/build] 已写入 boot 行（清单 ${manifest.length} 项）+ 工具页目录 ${pages.length} 个，幂等自检通过`);
      return;
    }
    if (has("--check")) {
      if (drift || catalogDrift) {
        for (let i = 0; i < Math.max(curItems.length, items.length); i++) {
          if (JSON.stringify(curItems[i]) !== JSON.stringify(items[i])) {
            console.log(`  ✗ 第 ${i} 项：html=${JSON.stringify(curItems[i])} 应为 ${JSON.stringify(items[i])}`);
          }
        }
        process.exit(1);
      }
      if (catalogDrift) {
        console.log(`  ✗ 工具页目录块与 public/tools/*/tool.json 不一致（${pages.length} 个页面）`);
        process.exit(1);
      }
      console.log("[l0/build] --check 通过：boot 行、工具页目录与磁盘内容一致");
      return;
    }
    console.log("[l0/build] 只读完成（--check 报漂移 / --write 落盘）");
    return;
  }

  // legacy shape: value-level `?v=` surgery, kept for checkouts that predate the boot convergence.
  const plan = planVersions(html, { root: ROOT });
  const s = plan.stats;
  if (plan.unresolved.length) {
    console.log(`[l0/build] ✗ ${plan.unresolved.length} 个本地脚本落不了盘也不在路由白名单（fail-closed）：`);
    for (const u of plan.unresolved) console.log(`  ✗ ${u.srcPath}`);
    process.exit(1);
  }
  console.log(`[l0/build] 清单 ${s.total} 个标签（本地 ${s.local} / 路由 ${plan.routes.length} / 参与哈希 ${s.hashed}）· 已带 ?v= ${s.withVersion} · 待更新 ${s.updates}`);
  if (has("--write")) {
    if (plan.updates.length === 0) {
      console.log("[l0/build] 已是最新，零写入（幂等）");
      return;
    }
    const out = render(html, plan.updates);
    if (out === html) {
      console.log("[l0/build] ✗ 计划非空但 render 无变化：清单与回写不同源，拒绝静默通过");
      process.exit(1);
    }
    fs.writeFileSync(HTML_PATH, out, "utf8");
    for (const u of plan.updates.slice(0, 10)) console.log(`  ~ ${u.srcPath} → ${u.to}`);
    if (plan.updates.length > 10) console.log(`  … 另有 ${plan.updates.length - 10} 处`);
    const again = planVersions(out, { root: ROOT });
    if (again.updates.length !== 0) {
      console.log(`[l0/build] ✗ 写入后仍有 ${again.updates.length} 处待更新：不幂等，生成器有 bug（已落盘，先修再发）`);
      process.exit(1);
    }
    console.log(`[l0/build] 已写入 ${path.relative(ROOT, HTML_PATH)}（${plan.updates.length} 处值级替换），幂等自检通过`);
    return;
  }
  if (has("--check")) {
    if (plan.updates.length) {
      console.log(`[l0/build] ✗ ${plan.updates.length} 处 ?v= 与内容脱钩：`);
      for (const u of plan.updates.slice(0, 10)) console.log(`  ✗ ${u.srcPath} 现值 ≠ 内容哈希（应作 ${u.to}）`);
      if (plan.updates.length > 10) console.log(`  … 另有 ${plan.updates.length - 10} 处`);
      process.exit(1);
    }
    console.log("[l0/build] --check 通过：全部 ?v= 与内容一致");
    return;
  }
  for (const u of plan.updates.slice(0, 8)) console.log(`  ~ ${u.srcPath} → ${u.to}`);
  if (plan.updates.length > 8) console.log(`  … 另有 ${plan.updates.length - 8} 处`);
  console.log("[l0/build] 只读完成（旧形态：--write 补 ?v=；收敛 boot 用 --adopt）");
}

main();
