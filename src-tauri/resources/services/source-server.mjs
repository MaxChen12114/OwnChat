#!/usr/bin/env node
// scripts/dev/source-server.mjs — 本地只读源码/产物检索服务（开发工具）
// ─────────────────────────────────────────────────────────────────────
// 干什么：给 agent 的 list_source / search_source / read_source / list_artifacts /
//   read_artifact 五个工具提供后端。只读、只绑 127.0.0.1、无写端点。
// 端点：
//   GET /health
//   GET /list?prefix=                     文件清单（扩展名白名单 + deny 过滤，≤3000）
//   GET /grep?q=&regex=&prefix=&ci=&max=  逐文件搜索 → 文件:行号 + 行内容（默认 60 条）
//   GET /raw?path=&start=&lines=          按行读原文（带行号 + 续读起点）
//   GET /list_artifacts?prefix=           产物清单（需 --artifacts 指定根）
//   GET /read_artifact?path=&start=&lines= 产物读回（TEXT 白名单 ≤2MiB；二进制给 URL）
// 用法：
//   node scripts/dev/source-server.mjs [--port 8797] [--root <目录>]...
//        [--artifacts <产物目录>] [--artifact-url http://127.0.0.1:8796/artifacts]
//   默认 --root = 本仓库根；可重复 --root 允许多个根（相对路径按当前目录解析）。
// 安全纪律：
//   · 只绑 127.0.0.1，永不对局域网/公网开放；只读，无写端点
//   · 扩展名白名单；.env/.dev.vars/*.nvapi/*.pem/*.key、node_modules/.git/.venv 等一律 deny
//   · 解析后校验不越根（防 ../ 穿越）
// ─────────────────────────────────────────────────────────────────────
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");

function argOf(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : def;
}
const PORT = Math.max(1, parseInt(argOf("port", "8797"), 10) || 8797);
const ROOTS = [];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === "--root" && process.argv[i + 1]) ROOTS.push(path.resolve(process.argv[i + 1]));
}
if (!ROOTS.length) ROOTS.push(REPO_ROOT);
const ARTIFACTS = argOf("artifacts", "") ? path.resolve(argOf("artifacts", "")) : "";
const ARTIFACT_URL = String(argOf("artifact-url", "http://127.0.0.1:8796/artifacts")).replace(/\/+$/, "");

const EXT_ALLOW = new Set((
  ".js .mjs .cjs .jsx .ts .tsx .vue .svelte .css .scss .less .html .htm .json .jsonc " +
  ".md .markdown .txt .py .yml .yaml .toml .ini .conf .cfg .json5 .ps1 .bat .cmd .sh .bash " +
  ".sql .graphql .lua .rs .go .java .kt .c .h .cpp .hpp .cs .php .rb .swift .dart .r .pl"
).split(/\s+/).filter(Boolean));

const DENY_SEGMENTS = new Set([".git", "node_modules", ".wrangler", ".geoenv", ".venv", "vendor", "__pycache__"]);
const DENY_NAME = [/^\.dev\.vars$/i, /^\.env/i, /\.nvapi$/i, /\.pem$/i, /\.key$/i];

const GREP_MAX_FILE_BYTES = 800_000;
const LIST_MAX_FILES = 3000;
const GREP_DEFAULT_MAX = 60;
const GREP_MAX_CAP = 200;
const GREP_PER_FILE = 10;
const READ_CHAR_BUDGET = 5200;
const ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;
const ARTIFACT_MAX_CHARS = 5200;
const TEXT_EXTS = EXT_ALLOW;

const textCache = new Map();

function json(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}
function relOf(abs, root) {
  return path.relative(root, abs).split(path.sep).join("/");
}
function cleanRel(s) {
  return String(s == null ? "" : s).replace(/\\/g, "/").replace(/^\/+/, "").replace(/^artifacts\//, "");
}
function resolveIn(root, rel) {
  const norm = String(rel == null ? "" : rel).replace(/\\/g, "/").replace(/^\/+/, "");
  if (!norm || norm.includes("\0")) return null;
  const abs = path.resolve(root, norm);
  const r = path.relative(root, abs);
  if (!r || r.startsWith("..") || path.isAbsolute(r)) return null;
  if (r.split(path.sep).some((s) => DENY_SEGMENTS.has(s))) return null;
  if (DENY_NAME.some((re) => re.test(path.basename(abs)))) return null;
  return { abs, rel: r.split(path.sep).join("/") };
}
function* iterFiles(prefix) {
  const seen = new Set();
  for (const root of ROOTS) {
    let base = root;
    if (prefix) {
      const cand = path.resolve(root, String(prefix));
      const r = path.relative(root, cand);
      if (!r || r.startsWith("..") || path.isAbsolute(r)) continue;
      base = cand;
    }
    let st;
    try { st = fs.statSync(base); } catch { continue; }
    if (!st.isDirectory()) continue;
    const stack = [base];
    while (stack.length) {
      const dir = stack.pop();
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        const abs = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          if (!DENY_SEGMENTS.has(e.name)) stack.push(abs);
        } else if (e.isFile()) {
          if (DENY_NAME.some((re) => re.test(e.name))) continue;
          if (!EXT_ALLOW.has(path.extname(e.name).toLowerCase())) continue;
          const rel = relOf(abs, root);
          if (seen.has(rel)) continue;
          seen.add(rel);
          yield { abs, rel };
        }
      }
    }
  }
}
function readText(abs, st) {
  const key = abs + "|" + st.mtimeMs + "|" + st.size;
  if (textCache.has(key)) return textCache.get(key);
  const text = fs.readFileSync(abs, "utf8");
  if (textCache.size > 6000) textCache.clear();
  textCache.set(key, text);
  return text;
}
function parseParams(u) {
  const out = {};
  for (const [k, v] of u.searchParams) out[k] = v;
  return out;
}

const server = http.createServer((req, res) => {
  let u;
  try { u = new URL(req.url, "http://127.0.0.1"); } catch { return json(res, { ok: false, error: "bad url" }, 400); }
  if (req.method !== "GET") return json(res, { ok: false, error: "read-only" }, 405);
  const p = parseParams(u);

  if (u.pathname === "/health") {
    return json(res, { ok: true, roots: ROOTS, artifacts: ARTIFACTS || null, artifactUrl: ARTIFACT_URL });
  }

  if (u.pathname === "/list") {
    const prefix = String(p.prefix || "");
    const files = [];
    let truncated = false;
    for (const f of iterFiles(prefix)) {
      files.push(f.rel);
      if (files.length > LIST_MAX_FILES) { truncated = true; break; }
    }
    files.sort();
    return json(res, { ok: true, count: files.length, truncated, files: files.slice(0, LIST_MAX_FILES) });
  }

  if (u.pathname === "/grep") {
    const q = String(p.q || "").trim();
    if (!q) return json(res, { ok: false, error: "缺少 q 参数" }, 400);
    const isRegex = p.regex === "1" || p.regex === "true";
    const ci = !(p.ci === "0" || p.ci === "false");
    const max = Math.min(GREP_MAX_CAP, Math.max(1, parseInt(p.max || GREP_DEFAULT_MAX, 10) || GREP_DEFAULT_MAX));
    let re;
    try { re = new RegExp(isRegex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), ci ? "i" : ""); }
    catch (e) { return json(res, { ok: false, error: "正则不合法: " + String(e.message).slice(0, 200) }, 400); }
    const t0 = Date.now();
    const hits = [];
    let scanned = 0;
    for (const f of iterFiles(String(p.prefix || ""))) {
      let st;
      try { st = fs.statSync(f.abs); } catch { continue; }
      if (st.size > GREP_MAX_FILE_BYTES) continue;
      let text;
      try { text = readText(f.abs, st); } catch { continue; }
      scanned++;
      let inFile = 0;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          hits.push({ path: f.rel, line: i + 1, text: lines[i].trim().slice(0, 180) });
          if (++inFile >= GREP_PER_FILE) break;
          if (hits.length >= max) break;
        }
      }
      if (hits.length >= max) break;
    }
    return json(res, { ok: true, hits, hitCount: hits.length, truncated: hits.length >= max,
      scannedFiles: scanned, seconds: Number(((Date.now() - t0) / 1000).toFixed(2)) });
  }

  if (u.pathname === "/raw") {
    const rel = String(p.path || "");
    let hit = null;
    for (const root of ROOTS) { hit = resolveIn(root, rel); if (hit) break; }
    if (!hit) return json(res, { ok: false, error: "路径不可读（越根 / 不在白名单 / 被 deny）：" + rel.slice(0, 200) }, 400);
    let st;
    try { st = fs.statSync(hit.abs); } catch { return json(res, { ok: false, error: "文件不存在：" + rel.slice(0, 200) }, 404); }
    if (!st.isFile()) return json(res, { ok: false, error: "不是文件：" + rel.slice(0, 200) }, 400);
    if (!EXT_ALLOW.has(path.extname(hit.abs).toLowerCase())) return json(res, { ok: false, error: "该扩展名不在可读清单内" }, 400);
    const all = readText(hit.abs, st).split(/\r?\n/);
    const total = all.length;
    let start = Math.max(1, parseInt(p.start || "1", 10) || 1);
    const want = Math.min(400, Math.max(1, parseInt(p.lines || "200", 10) || 200));
    if (start > total) return json(res, { ok: false, error: `start=${start} 超过总行数 ${total}` }, 400);
    const out = [];
    let used = 0;
    for (let i = start - 1; i < total && out.length < want; i++) {
      const t = all[i];
      if (used + t.length > READ_CHAR_BUDGET && out.length) break;
      used += t.length + 1;
      out.push({ n: i + 1, text: t });
    }
    const end = start + out.length - 1;
    return json(res, { ok: true, path: hit.rel, totalLines: total, start, end,
      nextStart: end < total ? end + 1 : null, lines: out });
  }

  if (u.pathname === "/list_artifacts") {
    if (!ARTIFACTS) return json(res, { ok: false, error: "产物根未配置：启动时加 --artifacts <目录>" }, 400);
    const prefix = cleanRel(p.prefix || "");
    const t0 = Date.now();
    const files = [];
    const stack = [ARTIFACTS];
    while (stack.length) {
      const dir = stack.pop();
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        const abs = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) { stack.push(abs); continue; }
        if (!e.isFile()) continue;
        const rel = relOf(abs, ARTIFACTS);
        if (prefix && !rel.startsWith(prefix)) continue;
        const st = fs.statSync(abs);
        files.push({ path: rel, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) });
        if (files.length >= 2000) break;
      }
      if (files.length >= 2000) break;
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return json(res, { ok: true, root: "artifacts", count: files.length, truncated: files.length >= 2000,
      files, seconds: Number(((Date.now() - t0) / 1000).toFixed(2)) });
  }

  if (u.pathname === "/read_artifact") {
    if (!ARTIFACTS) return json(res, { ok: false, error: "产物根未配置：启动时加 --artifacts <目录>" }, 400);
    const rel = cleanRel(p.path || "");
    const hit = resolveIn(ARTIFACTS, rel);
    if (!hit) return json(res, { ok: false, error: "产物路径不可读：" + rel.slice(0, 200) }, 400);
    let st;
    try { st = fs.statSync(hit.abs); } catch { return json(res, { ok: false, error: "产物不存在：" + rel.slice(0, 200) }, 404); }
    if (!st.isFile()) return json(res, { ok: false, error: "不是文件：" + rel.slice(0, 200) }, 400);
    const url = ARTIFACT_URL + "/" + hit.rel;
    if (!TEXT_EXTS.has(path.extname(hit.abs).toLowerCase()) || st.size > ARTIFACT_MAX_BYTES) {
      return json(res, { ok: false, binary: true, url, error: "二进制/超限，请用 URL 打开" });
    }
    const all = readText(hit.abs, st).split(/\r?\n/);
    const total = all.length;
    let start = Math.max(1, parseInt(p.start || "1", 10) || 1);
    if (start > total) return json(res, { ok: false, error: `start=${start} 超过总行数 ${total}` }, 400);
    const want = Math.min(400, Math.max(1, parseInt(p.lines || "200", 10) || 200));
    const out = [];
    let used = 0;
    for (let i = start - 1; i < total && out.length < want; i++) {
      const t = all[i];
      if (used + t.length > ARTIFACT_MAX_CHARS && out.length) break;
      used += t.length + 1;
      out.push({ n: i + 1, text: t });
    }
    const end = start + out.length - 1;
    return json(res, { ok: true, path: hit.rel, totalLines: total, start, end,
      nextStart: end < total ? end + 1 : null, lines: out, url });
  }

  json(res, { ok: false, error: "not found" }, 404);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[source-server] http://127.0.0.1:${PORT}  roots=${ROOTS.join(", ")}` + (ARTIFACTS ? ` artifacts=${ARTIFACTS}` : ""));
  console.log("[source-server] 只读、仅回环；Ctrl+C 退出");
});
