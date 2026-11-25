// @ts-check
// l0/manifest.mjs — L0a-1: order-preserving manifest extraction, content hashing and surgical
// version rewrite. Read-only on purpose: this file exposes no write API, generating index.html is
// L0a-2's job (l0/build.mjs).
//
// The choice that shapes everything here is length-preserving comment stripping: every offset and
// line number must keep pointing at the original bytes, because the rewrite replaces a `src` value
// in place and any shift would corrupt a neighbouring tag. `/config.js` is served by the Worker and
// has no file on disk, so it is whitelisted by name; anything else that cannot be read fails closed
// rather than being skipped (a silently dropped tag ships a blank page).
// @module l0/manifest

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

/** Content hash, first 8 hex chars: spread enough, short enough to keep cache strings stable. */
export const HASH_LEN = 8;

/**
 * Worker routes: served dynamically, so no file exists under public/. Confirm the route really exists
 * in `src/worker.js` before adding a name here — otherwise this whitewashes a deleted file.
 */
export const ROUTES = Object.freeze(["/config.js"]);

/** Replace comments with blanks of the same length (newlines kept) so offsets still match the source. */
export function stripComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
}

/** Read an attribute value. Only quoted forms count; unquoted is treated as unparsable, never guessed. */
function attrValue(attrs, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(attrs)
    || new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, "i").exec(attrs);
  return m ? m[1] : null;
}

/** Absolute span of the `src` *value* in the html, so the rewrite can replace exactly that slice. */
function srcValueSpan(stripped, tagOffset, tagLength) {
  const tag = stripped.slice(tagOffset, tagOffset + tagLength);
  const m = /\bsrc\s*=\s*(["'])/i.exec(tag);
  if (!m) return null;
  const valueStart = tagOffset + m.index + m[0].length;
  const valueEnd = stripped.indexOf(m[1], valueStart);
  if (valueEnd < 0) return null;
  return [valueStart, valueEnd];
}

/**
 * Extract every script tag in document order; reordering is not this function's business.
 * An inline body is raw text per the browser: a `<script` sequence inside it (the boot loader writes
 * open tags that way) is not a tag. Those are skipped by remembering where each inline body closes
 * and are counted in `inBody`, kept apart from both `entries` and the comment `phantom` count.
 * @param {string} html
 */
export function parseScriptTags(html) {
  const stripped = stripComments(html);
  const raw = (html.match(/<script/gi) || []).length;
  const phantom = raw - (stripped.match(/<script/gi) || []).length;

  const entries = [];
  let inBody = 0;
  let dataBlocks = 0; // `<script type="application/json">` 之类的数据块：不算脚本，但总账要认
  let skipUntil = -1;
  const re = /<script\b([^>]*)>/gi;
  let m;
  let index = 0;
  let line = 1;
  let cursor = 0;
  while ((m = re.exec(stripped))) {
    const offset = m.index;
    if (offset < skipUntil) { inBody++; continue; }
    while (cursor < offset) {
      if (stripped.charCodeAt(cursor) === 10) line++;
      cursor++;
    }
    const attrs = m[1];
    const src = attrValue(attrs, "src");
    const srcPath = src === null ? null : src.split("?")[0];
    const vMatch = src === null ? null : /\?v=([^&"']*)/.exec(src);
    // A data block (`type="application/json"`, e.g. the build-injected tool-page catalog) is not a
    // script unit: skip its body like an inline one, but do not emit an entry.
    const typeAttr = attrValue(attrs, "type");
    if (src === null && typeAttr !== null && !/^(?:module|text\/javascript|application\/javascript)$/i.test(typeAttr)) {
      const openEndData = stripped.indexOf(">", offset) + 1;
      const closeData = stripped.indexOf("</script", openEndData);
      skipUntil = closeData < 0 ? stripped.length : closeData;
      dataBlocks++;
      continue;
    }
    let kind = "classic";
    if (src === null) kind = "inline";
    else if (/^https?:/i.test(src)) kind = "cdn";
    else if (/type\s*=\s*["']module["']/i.test(attrs)) kind = "module";
    entries.push({
      index: index++,
      kind,
      src,
      srcPath,
      version: vMatch ? vMatch[1] : null,
      attrs,
      offset,
      line,
      srcSpan: src === null ? null : srcValueSpan(stripped, offset, m[0].length),
    });
    if (src === null) {
      // Body starts after the open tag's ">" and ends at the first real `</script`; a `<\/script`
      // escape inside a string literal does not terminate it.
      const openEnd = stripped.indexOf(">", offset) + 1;
      const close = stripped.indexOf("</script", openEnd);
      skipUntil = close < 0 ? stripped.length : close;
    }
  }
  return { entries, raw, phantom, inBody, dataBlocks };
}

/** Content hash: sha256, first HASH_LEN hex chars. Fixed vectors (empty string / "abc") live in the test. */
export function contentHash(input) {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, HASH_LEN);
}

/** Replace the version parameter in a src, keeping every other query parameter and its order. */
function withVersion(src, hash) {
  const q = src.indexOf("?");
  const base = q < 0 ? src : src.slice(0, q);
  const params = q < 0 ? [] : src.slice(q + 1).split("&").filter((p) => p && !/^v=/.test(p));
  params.push(`v=${hash}`);
  return `${base}?${params.join("&")}`;
}

/**
 * Compute what *would* change, without touching a byte.
 * @param {string} html
 * @param {{root?:string, routes?:readonly string[]|string[], readFile?:(abs:string)=>string|Buffer}} [opts]
 */
export function planVersions(html, opts = {}) {
  const root = opts.root || process.cwd();
  const routes = (opts.routes || ROUTES).slice();
  const readFile = opts.readFile || ((abs) => fs.readFileSync(abs));
  const { entries } = parseScriptTags(html);

  const updates = [];
  const routeHits = [];
  const unresolved = [];
  let local = 0;
  let withV = 0;

  for (const e of entries) {
    if (!e.srcPath || e.kind === "cdn") continue;
    local++;
    if (e.version !== null) withV++;
    if (routes.includes(e.srcPath)) {
      routeHits.push({ index: e.index, srcPath: e.srcPath, reason: "worker-route" });
      continue;
    }
    const abs = path.join(root, "public", ...e.srcPath.split("/").filter(Boolean));
    let buf;
    try {
      buf = readFile(abs);
    } catch {
      unresolved.push({ index: e.index, srcPath: e.srcPath, reason: "missing-on-disk" });
      continue;
    }
    // Hash the LF-normalised text, not the raw bytes: with autocrlf on, every checkout has a
    // different byte shape (worktree mixed LF / main all CRLF / CI all LF), so raw bytes would give
    // each checkout its own ?v= and leave main permanently dirty. LF-normalised equals the git blob,
    // equals CI and production, which makes the hash immune to how the tree was checked out.
    const hash = contentHash(buf.toString("utf8").replace(/\r\n/g, "\n"));
    if (e.version === hash) continue; // Already current: this is what keeps reruns from faking a diff.
    updates.push({ index: e.index, srcPath: e.srcPath, from: e.src, to: withVersion(e.src, hash) });
  }

  return {
    entries,
    updates,
    routes: routeHits,
    unresolved,
    stats: {
      total: entries.length, local, hashed: local - routeHits.length,
      withVersion: withV, missingVersion: local - withV, updates: updates.length,
    },
  };
}

/**
 * Surgical rewrite: replace only the src values named by `updates`; every other byte stays put.
 * Throws when an update points at a tag that no longer carries the expected src, which means the
 * plan and the html came from different sources.
 * @param {string} html
 * @param {Array<{index:number,from:string,to:string}>} updates
 * @returns {string}
 */
export function render(html, updates) {
  if (!updates || updates.length === 0) return html;
  const { entries } = parseScriptTags(html);
  const byIndex = new Map(entries.map((e) => [e.index, e]));
  const reps = [];
  for (const u of updates) {
    const e = byIndex.get(u.index);
    if (!e || !e.srcSpan) throw new Error(`update 指向不存在的标签 #${u.index}（清单与 html 不同源）`);
    if (e.src !== u.from) throw new Error(`标签 #${u.index} 的 src 已变：期望 ${u.from}，实得 ${e.src}`);
    reps.push({ start: e.srcSpan[0], end: e.srcSpan[1], text: u.to });
  }
  reps.sort((a, b) => b.start - a.start); // Back to front, so earlier offsets stay valid.
  let out = html;
  for (const r of reps) out = out.slice(0, r.start) + r.text + out.slice(r.end);
  return out;
}

// CLI: read-only report. There is deliberately no --write here.
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  const plan = planVersions(html, { root: ROOT });
  const s = plan.stats;
  console.log(`清单：${s.total} 个标签（本地 ${s.local} / 路由 ${plan.routes.length} / 参与哈希 ${s.hashed}）`);
  console.log(`版本：${s.withVersion} 个已有 ?v=，${s.missingVersion} 个待补，${s.updates} 处需更新`);
  if (plan.unresolved.length) {
    console.log("缺失：");
    for (const u of plan.unresolved) console.log(`  ✗ ${u.srcPath}`);
    process.exit(1);
  }
  for (const u of plan.updates.slice(0, 8)) console.log(`  ~ ${u.srcPath} → ${u.to}`);
  if (plan.updates.length > 8) console.log(`  … 另有 ${plan.updates.length - 8} 处`);
  console.log("只读完成（本文件不写盘；写 index.html 走 l0/build.mjs）");
}
