#!/usr/bin/env node
// pc-bridge/server.mjs — 主站「远程电脑」的本机受限执行桥
// ─────────────────────────────────────────────────────────────
// 与 local-exec-server.mjs 刻意分开：
//   · 只暴露屏幕 / UIA 控件树 / 窗口 / 鼠标键盘 / 剪贴板
//   · 不提供 /exec、不提供任意文件读写、不提供 /static 通配
//   · 只绑 127.0.0.1，每个请求要 x-pc-token
//   · 默认 30 分钟无写操作即拒绝继续操作；POST /pc/panic 立即急停
//
// 用法：
//   node pc-bridge/server.mjs --root . --port 8802 --ttl-min 30
//   首次启动生成 <root>/.pc-token
//   只读模式：--readonly（截图/UIA/窗口/剪贴板读仍可用，所有输入被拒）
// ─────────────────────────────────────────────────────────────
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const PORT = parseInt(getArg("port", "8802"), 10);
const ROOT = path.resolve(getArg("root", process.cwd()));
const TTL_MIN = Math.max(0, parseInt(getArg("ttl-min", "30"), 10) || 0);
const READONLY = args.includes("--readonly");
// 4.72: lib 跟着脚本走（不再跟 --root），这样脚本可以随 App 打包到 resources 里运行
const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), "lib");
const TOKEN_FILE = path.join(ROOT, ".pc-token");
const AUDIT_FILE = path.join(ROOT, "audit.jsonl");
const VERSION = 1;
const MAX_BODY = 64 * 1024;

// token：首次生成，之后复用
let token = "";
try { token = fs.readFileSync(TOKEN_FILE, "utf8").trim(); } catch (e) { /* generate */ }
if (!token) {
  token = crypto.randomBytes(24).toString("hex");
  try { fs.writeFileSync(TOKEN_FILE, token + "\n", { mode: 0o600 }); } catch (e) {
    console.error("[pc-bridge] token 写入失败（继续用内存 token）:", e.message);
  }
}
const TOKEN_BUF = Buffer.from(token, "utf8");

let panic = false;
let lastMutation = Date.now();
const started = Date.now();

function json(res, code, obj, extra) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, x-pc-token, authorization",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "cache-control": "no-store",
    ...(extra || {}),
  });
  res.end(body);
}

function tokenOk(req) {
  const got = Buffer.from(String(req.headers["x-pc-token"] || ""), "utf8");
  if (got.length !== TOKEN_BUF.length) return false;
  try { return crypto.timingSafeEqual(got, TOKEN_BUF); } catch (e) { return false; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("请求体过大")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (e) { reject(new Error("JSON 解析失败")); }
    });
    req.on("error", reject);
  });
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

function parseJsonOut(stdout) {
  const s = String(stdout || "").trim();
  if (!s) return null;
  // PowerShell 可能在 JSON 前后带空行/杂项；取最后一个像 JSON 的行块
  const lines = s.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{") && !line.startsWith("[")) continue;
    try { return JSON.parse(line); } catch (e) { /* keep trying */ }
  }
  try { return JSON.parse(s); } catch (e) { return null; }
}

function runPs(script, data, timeoutMs = 20000) {
  const b64 = Buffer.from(JSON.stringify(data || {}), "utf8").toString("base64");
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(LIB, script), "-Json", b64],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const parsed = parseJsonOut(stdout);
        if (parsed) return resolve(parsed);
        const msg = String(stderr || err && err.message || "").trim();
        resolve({ ok: false, error: msg || ("PowerShell 无输出: " + script) });
      }
    );
  });
}

function summarize(op, data) {
  data = data || {};
  switch (op) {
    case "shot": return { max: data.max, q: data.q };
    case "ls": return { path: String(data.path || "").slice(0, 160) };
    case "read": return { path: String(data.path || "").slice(0, 160) };
    case "grep": return { path: String(data.path || "").slice(0, 160), pattern: String(data.pattern || "").slice(0, 60) };
    case "click": return data.name
      ? { name: data.name, type: data.type, exact: data.exact }
      : { x: data.x, y: data.y, button: data.button, count: data.count };
    case "type": return { len: String(data.text || "").length };
    case "key": return { key: data.key };
    case "scroll": return { x: data.x, y: data.y, dx: data.dx, dy: data.dy };
    case "focus": return { hwnd: data.hwnd, title: data.title };
    case "clipboard": return { action: data.action, len: String(data.text || "").length };
    default: return {};
  }
}

function audit(req, op, data, ok, ms, extra) {
  const rec = {
    ts: new Date().toISOString(),
    ip: String(req.headers["cf-connecting-ip"] || req.socket.remoteAddress || ""),
    op,
    args: summarize(op, data),
    ok: !!ok,
    ms,
    ...(extra || {}),
  };
  try {
    // 2026-11-11: 按天轮转 —— 文件mtime不是今天就归档成 audit-YYYYMMDD.jsonl 重开
    // （fs 三端点上线后写入频率上来了，不轮转会无限涨）。轮转失败忽略，照常追加。
    try {
      const st = fs.statSync(AUDIT_FILE);
      const today = new Date();
      const m = st.mtime;
      if (m.getFullYear() !== today.getFullYear() || m.getMonth() !== today.getMonth() || m.getDate() !== today.getDate()) {
        const d = m.getFullYear() * 10000 + (m.getMonth() + 1) * 100 + m.getDate();
        fs.renameSync(AUDIT_FILE, AUDIT_FILE.replace(/\.jsonl$/, "-" + d + ".jsonl"));
      }
    } catch (e) { /* 不存在=首次 */ }
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(rec) + "\n");
  } catch (e) { /* ignore */ }
}

function ttlExpired() {
  return TTL_MIN > 0 && Date.now() - lastMutation > TTL_MIN * 60000;
}

function mutationBlocked() {
  if (panic) return { code: 423, error: "已急停（panic）。重启 pc-bridge 才恢复。" };
  if (READONLY) return { code: 403, error: "只读模式（--readonly），输入类操作已禁用。" };
  if (ttlExpired()) return { code: 423, error: "TTL 已过期（" + TTL_MIN + " 分钟无写操作）。POST /pc/arm 续期。" };
  return null;
}

// ─── 只读文件/源码服务（2026-11-11）─────────────────────────────
// 白名单：只允许 OwnChat-Workspace 工作区之下；黑名单硬排密钥/凭据与 .git/node_modules。
// 纯读、全程 audit；不做任何写操作（panic/TTL 只管输入类，这里与 status/shot 同属只读面）。
const FILE_ALLOW_ROOT = path.resolve("C:\\Users\\Max\\Desktop\\OwnChat-Workspace");
const FILE_READ_MAX = 200 * 1024;
const GREP_FILE_MAX = 1024 * 1024;
const FILE_NAME_DENY = /(^|[\\/])(\.pc-token|\.dev\.vars|\.remote-desk-vnc\.txt|id_rsa|id_ed25519|credentials?|htpasswd)(\.[a-z0-9]+)?$/i;
const FILE_EXT_DENY = /\.(pem|key|pfx|p12|keystore|jks|kdbx|env|mobileprovision)$/i;
const FILE_WORD_DENY = /secret|passwd|password|credential|private[-_]?key|api[-_]?key|access[-_]?token/i;
const DIR_DENY_PARTS = new Set([".git", "node_modules", ".wrangler", ".ssh", ".gnupg"]);

function fileDenied(p) {
  if (FILE_NAME_DENY.test(p) || FILE_EXT_DENY.test(p) || FILE_WORD_DENY.test(p)) return true;
  const parts = p.split(/[\\/]/);
  return parts.some((s) => DIR_DENY_PARTS.has(s.toLowerCase()));
}
async function resolveUnderRoot(requested) {
  if (requested == null || typeof requested !== "string" || !requested.trim()) {
    return { error: "path 必填（工作区内相对路径或绝对路径）" };
  }
  const abs = path.resolve(FILE_ALLOW_ROOT, requested);
  let real;
  try { real = await fs.promises.realpath(abs); } catch (e) {
    return { code: 404, error: "路径不存在（" + (e.code || e.message) + "）" };
  }
  const norm = path.normalize(real);
  if (!(norm === FILE_ALLOW_ROOT || norm.startsWith(FILE_ALLOW_ROOT + path.sep))) {
    return { code: 403, denied: true, error: "越权路径：只允许 " + FILE_ALLOW_ROOT + " 之内" };
  }
  if (fileDenied(norm)) {
    return { code: 403, denied: true, error: "该路径在黑名单内（密钥/凭据/敏感文件不开放）" };
  }
  return { real: norm };
}
function relToRoot(real) {
  return path.relative(FILE_ALLOW_ROOT, real).split(path.sep).join("/");
}
function globMatch(name, globs) {
  if (!globs || !globs.length) return true;
  const lower = name.toLowerCase();
  return globs.some((gl) => {
    const g = String(gl).toLowerCase().trim();
    if (!g) return false;
    if (g.startsWith("*.")) return lower.endsWith(g.slice(1));
    return lower === g || lower.endsWith("/" + g);
  });
}
async function walkFiles(rootReal, opts) {
  // 返回 {files:[绝对路径], scanned, truncated}；跳过黑名单目录/文件
  const out = [];
  let scanned = 0;
  let truncated = false;
  const deadline = Date.now() + (opts.timeCapMs || 4000);
  async function walk(dir, depth) {
    if (truncated || depth > (opts.depthCap || 6) || out.length >= (opts.fileCap || 3000)) { if (out.length >= (opts.fileCap || 3000) || depth > (opts.depthCap || 6)) truncated = true; return; }
    if (Date.now() > deadline) { truncated = true; return; }
    let ents;
    try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of ents) {
      if (truncated || out.length >= (opts.fileCap || 3000)) { truncated = out.length >= (opts.fileCap || 3000); return; }
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (DIR_DENY_PARTS.has(ent.name.toLowerCase())) continue;
        await walk(full, depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;
      if (fileDenied(full)) continue;
      if (!globMatch(ent.name, opts.globs)) continue;
      let st;
      try { st = await fs.promises.stat(full); } catch (e) { continue; }
      if (st.size > GREP_FILE_MAX) continue;
      scanned++;
      out.push(full);
    }
  }
  await walk(rootReal, 0);
  return { files: out, scanned, truncated };
}
function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, x-pc-token, authorization",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    });
    return res.end();
  }

  const op = url.pathname.replace(/^\/pc\/?/, "").replace(/\/+$/, "");

  // 根路径：调试用
  if (url.pathname === "/" || url.pathname === "") {
    return json(res, 200, {
      ok: true, name: "remote-desk-bridge", version: VERSION,
      endpoints: ["/pc/health", "/pc/status", "/pc/shot", "/pc/ui", "/pc/windows", "/pc/focus",
        "/pc/click", "/pc/type", "/pc/key", "/pc/scroll", "/pc/clipboard", "/pc/audit",
        "/pc/ls", "/pc/read", "/pc/grep", "/pc/arm", "/pc/panic"],
    });
  }

  // health 不校验 token（Worker/本地探活）
  if (op === "health") {
    return json(res, 200, {
      ok: true, name: "remote-desk-bridge", version: VERSION,
      readonly: READONLY, panic, ttlMin: TTL_MIN,
      uptime: Math.round((Date.now() - started) / 1000),
    });
  }

  const t0 = Date.now();
  if (!tokenOk(req)) {
    audit(req, op || "unknown", null, false, 0, { error: "bad token" });
    return json(res, 401, { ok: false, error: "x-pc-token 不正确（见 " + TOKEN_FILE + "）" });
  }

  try {
    if (op === "status" && req.method === "GET") {
      const r = await runPs("status.ps1", {});
      audit(req, op, null, r && r.ok !== false, Date.now() - t0);
      return json(res, r && r.ok === false ? 500 : 200, r);
    }

    if (op === "shot" && req.method === "GET") {
      const max = clampInt(url.searchParams.get("max"), 320, 2560, 1280);
      // 先看锁屏：锁屏时 CopyFromScreen 会黑屏/抛错，直接 409
      const st = await runPs("status.ps1", {});
      if (st && st.ok !== false && st.locked) {
        audit(req, op, { max }, false, Date.now() - t0, { locked: true });
        return json(res, 409, { ok: false, locked: true, error: "锁屏/安全桌面中，截图不可用" });
      }
      const r = await runPs("shot.ps1", { max });
      const shotPath = String(r && r.path || "");
      const base = path.basename(shotPath);
      if (!base.startsWith("pc-bridge-shot-")) {
        audit(req, op, { max }, false, Date.now() - t0, { error: "bad shot path" });
        return json(res, 500, { ok: false, error: (r && r.error) || "截图路径异常" });
      }
      let buf = null;
      try { buf = fs.readFileSync(shotPath); } catch (e) { /* missing */ }
      try { fs.unlinkSync(shotPath); } catch (e) { /* ignore */ }
      const ok = r && r.ok !== false && buf && buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8;
      audit(req, op, { max }, ok, Date.now() - t0);
      if (!ok) {
        return json(res, 500, { ok: false, error: (r && r.error) || "截图失败" });
      }
      res.writeHead(200, {
        "content-type": "image/jpeg",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
        "x-pc-width": String(r.width || ""),
        "x-pc-height": String(r.height || ""),
        "x-pc-source-width": String(r.sourceWidth || ""),
        "x-pc-source-height": String(r.sourceHeight || ""),
      });
      return res.end(buf);
    }

    if (op === "ui" && req.method === "GET") {
      const limit = clampInt(url.searchParams.get("limit"), 20, 200, 80);
      const r = await runPs("ui.ps1", { limit });
      audit(req, op, { limit }, r && r.ok !== false, Date.now() - t0);
      return json(res, r && r.ok === false ? 500 : 200, r);
    }

    if (op === "windows" && req.method === "GET") {
      const r = await runPs("windows.ps1", { action: "list" });
      audit(req, op, null, r && r.ok !== false, Date.now() - t0);
      return json(res, r && r.ok === false ? 500 : 200, r);
    }

    if (op === "focus" && req.method === "POST") {
      const b = await readBody(req);
      const blocked = mutationBlocked();
      if (blocked) return json(res, blocked.code, { ok: false, error: blocked.error });
      lastMutation = Date.now();
      const r = await runPs("windows.ps1", { action: "focus", hwnd: b.hwnd, title: b.title });
      audit(req, op, b, r && r.ok !== false, Date.now() - t0);
      return json(res, r && r.ok === false ? 400 : 200, r);
    }

    if (op === "click" && req.method === "POST") {
      const b = await readBody(req);
      const blocked = mutationBlocked();
      if (blocked) return json(res, blocked.code, { ok: false, error: blocked.error });
      lastMutation = Date.now();
      let r;
      if (b.name) {
        r = await runPs("uia-click.ps1", {
          name: String(b.name), type: b.type || "", exact: b.exact !== false, index: b.index,
        });
      } else {
        r = await runPs("input.ps1", {
          action: "click",
          x: clampInt(b.x, -10000, 10000, 0),
          y: clampInt(b.y, -10000, 10000, 0),
          button: String(b.button || "left"),
          count: clampInt(b.count, 1, 2, 1),
        });
      }
      audit(req, op, b, r && r.ok !== false, Date.now() - t0);
      return json(res, r && r.ok === false ? 400 : 200, r);
    }

    if (op === "type" && req.method === "POST") {
      const b = await readBody(req);
      const blocked = mutationBlocked();
      if (blocked) return json(res, blocked.code, { ok: false, error: blocked.error });
      const text = String(b.text == null ? "" : b.text);
      if (!text) return json(res, 400, { ok: false, error: "text 不能为空" });
      if (text.length > 2000) return json(res, 400, { ok: false, error: "text 超过 2000 字，请分段" });
      lastMutation = Date.now();
      const r = await runPs("input.ps1", { action: "type", text });
      audit(req, op, b, r && r.ok !== false, Date.now() - t0);
      return json(res, r && r.ok === false ? 400 : 200, r);
    }

    if (op === "key" && req.method === "POST") {
      const b = await readBody(req);
      const blocked = mutationBlocked();
      if (blocked) return json(res, blocked.code, { ok: false, error: blocked.error });
      const key = String(b.key || "").trim();
      if (!key) return json(res, 400, { ok: false, error: "key 不能为空" });
      lastMutation = Date.now();
      const r = await runPs("input.ps1", { action: "key", key });
      audit(req, op, b, r && r.ok !== false, Date.now() - t0);
      return json(res, r && r.ok === false ? 400 : 200, r);
    }

    if (op === "scroll" && req.method === "POST") {
      const b = await readBody(req);
      const blocked = mutationBlocked();
      if (blocked) return json(res, blocked.code, { ok: false, error: blocked.error });
      lastMutation = Date.now();
      const r = await runPs("input.ps1", {
        action: "scroll",
        x: clampInt(b.x, -10000, 10000, 0),
        y: clampInt(b.y, -10000, 10000, 0),
        dx: clampInt(b.dx, -50, 50, 0),
        dy: clampInt(b.dy, -50, 50, 0),
      });
      audit(req, op, b, r && r.ok !== false, Date.now() - t0);
      return json(res, r && r.ok === false ? 400 : 200, r);
    }

    if (op === "clipboard" && req.method === "GET") {
      const r = await runPs("clipboard.ps1", { action: "get" });
      audit(req, op, { action: "get" }, r && r.ok !== false, Date.now() - t0);
      return json(res, r && r.ok === false ? 500 : 200, r);
    }

    if (op === "clipboard" && req.method === "POST") {
      const b = await readBody(req);
      const blocked = mutationBlocked();
      if (blocked) return json(res, blocked.code, { ok: false, error: blocked.error });
      const text = String(b.text == null ? "" : b.text);
      if (text.length > 8000) return json(res, 400, { ok: false, error: "剪贴板文本超过 8000 字" });
      lastMutation = Date.now();
      const r = await runPs("clipboard.ps1", { action: "set", text });
      audit(req, op, b, r && r.ok !== false, Date.now() - t0);
      return json(res, r && r.ok === false ? 400 : 200, r);
    }

    if (op === "audit" && req.method === "GET") {
      const limit = clampInt(url.searchParams.get("limit"), 1, 200, 30);
      let lines = [];
      try {
        const all = fs.readFileSync(AUDIT_FILE, "utf8").trim().split(/\r?\n/).filter(Boolean);
        lines = all.slice(-limit);
      } catch (e) { /* empty */ }
      return json(res, 200, { ok: true, count: lines.length, lines });
    }

    // ─── 只读文件/源码服务 ───
    if (op === "ls" && (req.method === "GET" || req.method === "POST")) {
      const b = req.method === "POST" ? await readBody(req) : { path: url.searchParams.get("path") || "" };
      const r = await resolveUnderRoot(b.path || FILE_ALLOW_ROOT);
      if (r.error) {
        audit(req, op, { path: b.path }, false, Date.now() - t0, { error: r.error });
        return json(res, r.code || 400, { ok: false, error: r.error });
      }
      let ents;
      try { ents = await fs.promises.readdir(r.real, { withFileTypes: true }); }
      catch (e) {
        audit(req, op, { path: b.path }, false, Date.now() - t0, { error: e.code });
        return json(res, 400, { ok: false, error: "读取目录失败: " + (e.code || e.message) });
      }
      const cap = clampInt(b.limit, 1, 2000, 500);
      const entries = [];
      for (const ent of ents.slice(0, cap)) {
        const full = path.join(r.real, ent.name);
        let size = 0, mtime = 0;
        try { const st = await fs.promises.stat(full); size = st.size; mtime = Math.round(st.mtimeMs); } catch (e) { /* race */ }
        entries.push({ name: ent.name, dir: ent.isDirectory(), size, mtime });
      }
      entries.sort((a, z) => (z.dir - a.dir) || a.name.localeCompare(z.name));
      const out = { ok: true, path: relToRoot(r.real) || ".", count: entries.length, truncated: ents.length > cap, entries };
      audit(req, op, { path: b.path }, true, Date.now() - t0);
      return json(res, 200, out);
    }

    if (op === "read" && (req.method === "GET" || req.method === "POST")) {
      const b = req.method === "POST" ? await readBody(req) : { path: url.searchParams.get("path") || "" };
      const r = await resolveUnderRoot(b.path);
      if (r.error) {
        audit(req, op, { path: b.path }, false, Date.now() - t0, { error: r.error });
        return json(res, r.code || 400, { ok: false, error: r.error });
      }
      let st;
      try { st = await fs.promises.stat(r.real); } catch (e) {
        return json(res, 404, { ok: false, error: "读取失败: " + (e.code || e.message) });
      }
      if (st.isDirectory()) {
        audit(req, op, { path: b.path }, false, Date.now() - t0, { error: "is_dir" });
        return json(res, 400, { ok: false, error: "这是目录，用 /pc/ls 看列表或 /pc/grep 搜内容" });
      }
      const fh = await fs.promises.open(r.real, "r");
      try {
        // 2026-11-11 自主项: 支持 offset/maxBytes 分段读（默认 offset=0 一次 200KB，超出给 nextOffset 续读）
        const offset = clampInt(b.offset, 0, 1024 * 1024 * 1024, 0);
        const maxBytes = clampInt(b.maxBytes, 512, FILE_READ_MAX, FILE_READ_MAX);
        if (offset >= st.size) {
          audit(req, op, { path: b.path }, true, Date.now() - t0, { offset, eof: true });
          return json(res, 200, { ok: true, path: relToRoot(r.real), size: st.size, offset, nextOffset: null, truncated: false, content: "", note: "offset 已到文件尾" });
        }
        const len = Math.min(maxBytes, st.size - offset);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, offset);
        if (offset === 0 && looksBinary(buf)) {
          audit(req, op, { path: b.path }, true, Date.now() - t0, { binary: true });
          return json(res, 200, { ok: true, path: relToRoot(r.real), size: st.size, binary: true, content: "", note: "二进制文件不回传内容" });
        }
        let content = buf.toString("utf8");
        if (offset === 0 && content.startsWith("\uFEFF")) content = content.slice(1);
        const nextOffset = (offset + len < st.size) ? offset + len : null;
        const out = {
          ok: true, path: relToRoot(r.real), size: st.size, offset,
          nextOffset, truncated: nextOffset != null,
          totalSize: st.size, content,
          note: nextOffset != null ? ("未读完，续读：pc_read offset=" + nextOffset) : "",
        };
        audit(req, op, { path: b.path }, true, Date.now() - t0, { size: st.size, offset });
        return json(res, 200, out);
      } finally {
        try { await fh.close(); } catch (e) { /* ignore */ }
      }
    }

    if (op === "grep" && req.method === "POST") {
      const b = await readBody(req);
      const pattern = String(b.pattern || "");
      if (!pattern) return json(res, 400, { ok: false, error: "pattern 必填" });
      let re;
      try {
        const flags = b.ignoreCase === false ? "" : "i";
        re = b.regex ? new RegExp(pattern, flags) : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
      } catch (e) {
        return json(res, 400, { ok: false, error: "正则不合法: " + e.message });
      }
      const r = await resolveUnderRoot(b.path || FILE_ALLOW_ROOT);
      if (r.error) {
        audit(req, op, { path: b.path, pattern: pattern.slice(0, 80) }, false, Date.now() - t0, { error: r.error });
        return json(res, r.code || 400, { ok: false, error: r.error });
      }
      const globs = String(b.glob || "").split(",").map((s) => s.trim()).filter(Boolean);
      const maxMatches = clampInt(b.max, 1, 120, 60);
      // 路径是单文件就只搜它；目录才走递归
      let walkRes;
      try {
        const stp = await fs.promises.stat(r.real);
        if (stp.isFile()) walkRes = { files: [r.real], scanned: 1, truncated: false };
        else walkRes = await walkFiles(r.real, { globs: globs.length ? globs : null });
      } catch (e) {
        return json(res, 400, { ok: false, error: "读取路径失败: " + (e.code || e.message) });
      }
      const ctxN = clampInt(b.context, 0, 5, 0); // 2026-11-11 自主项: 命中行前后各 N 行上下文
      const results = [];
      let truncated = walkRes.truncated;
      for (const f of walkRes.files) {
        if (results.length >= maxMatches) { truncated = true; break; }
        let buf;
        try { buf = await fs.promises.readFile(f); } catch (e) { continue; }
        if (looksBinary(buf)) continue;
        const lines = buf.toString("utf8").split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            const hit = { file: relToRoot(f), line: i + 1, text: lines[i].trim().slice(0, 240) };
            if (ctxN > 0) {
              const parts = [];
              for (let j = Math.max(0, i - ctxN); j <= Math.min(lines.length - 1, i + ctxN); j++) {
                parts.push((j === i ? "> " : "  ") + String(j + 1).padStart(5) + " | " + lines[j].slice(0, 240));
              }
              hit.ctx = parts.join("\n");
            }
            results.push(hit);
            if (results.length >= maxMatches) { truncated = true; break; }
          }
        }
      }
      const out = {
        ok: true, pattern: pattern.slice(0, 120), path: relToRoot(r.real) || ".",
        scanned: walkRes.scanned, matches: results.length, truncated, results,
      };
      audit(req, op, { path: b.path, pattern: pattern.slice(0, 80) }, true, Date.now() - t0, { matches: results.length });
      return json(res, 200, out);
    }

    if (op === "arm" && req.method === "POST") {
      lastMutation = Date.now();
      return json(res, 200, { ok: true, ttlMin: TTL_MIN, armedAt: new Date().toISOString() });
    }

    if (op === "panic" && req.method === "POST") {
      panic = true;
      audit(req, op, null, true, Date.now() - t0);
      return json(res, 200, { ok: true, panic: true, note: "输入已急停；重启 pc-bridge 恢复。" });
    }

    return json(res, 404, { ok: false, error: "未知端点：/pc/" + op });
  } catch (e) {
    audit(req, op || "unknown", null, false, Date.now() - t0, { error: String(e && e.message || e) });
    return json(res, 400, { ok: false, error: String(e && e.message || e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("[pc-bridge] 已启动 http://127.0.0.1:" + PORT);
  console.log("[pc-bridge] root: " + ROOT);
  console.log("[pc-bridge] token 文件: " + TOKEN_FILE);
  console.log("[pc-bridge] readonly=" + READONLY + " ttl=" + TTL_MIN + "min panic=" + panic);
});
