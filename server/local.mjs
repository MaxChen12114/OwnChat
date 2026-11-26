// server/local.mjs — the desktop host: run the OwnChat Cloudflare Worker on plain Node.
//
// This is the supported self-hosted entry (the Tauri shell spawns it as the `host` service on port
// 8787; a developer can also run it by hand). Every binding the worker reads is emulated here:
//   env.ASSETS.fetch(request)   static files from public/, GET/HEAD only, no SPA fallback
//   env.TAVERN_SYNC             get/put/delete over a SQLite `sync_kv` table (no list, no TTL)
//   env.TAVERN_EVENTS           D1-ish prepare/bind/all/first/run/batch over the unified schema
//   ctx.waitUntil(promise)      fire-and-forget with error logging
//   .dev.vars / process.env     secrets (process env wins; data-dir .dev.vars beats the app one)
//
// Access gate (no bare server): a CHAT_PASSWORD is mandatory. Resolution order is process env,
// data-dir .dev.vars, app-root .dev.vars, then the persisted `<data dir>/admin-password.txt`; if none
// exists one is generated and written there (0600) on first run. The value is never printed — the
// path is, because a headless start must still be usable. `CHAT_MODE` defaults to `private` here, so
// an unauthenticated POST /api/chat cannot spend the owner's quota by accident.
//
// Data layout: one directory, one SQLite file (`ownchat.db`) shared with the Tauri rusqlite adapter.
// The sidecar owns the `sync_kv` table (the /sync blob) and the migration ledger; `native_kv` belongs
// to the shell's kv_* commands. A legacy `ownchat.sqlite` is renamed into place on first start.
//
// CORS: the desktop page is served from the app protocol (`tauri://localhost` / `http://tauri.localhost`),
// which is a different origin from this server, so browser calls need CORS headers. Origins are
// reflected because the access gate is a Bearer token, never a cookie: a hostile page can send a
// request but cannot read the answer without the password.
//
// Deliberate limits (fail loud instead of pretending):
//   · no Range requests on static files (Cloudflare assets supports them)
//   · no streaming request bodies (response bodies are streamed)
//   · no CF-only behaviours (cf object, cache API, scheduled events, email)
//
// Usage: node server/local.mjs [--port 8787] [--host 127.0.0.1] [--data-dir ./.local-data]
//                               [--app-root .] [--root <data dir alias, Tauri services.rs contract>]
//   LOCAL_QUIET=1 silences the per-request log (smoke tests use it).

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";

const HERE = import.meta.dirname;
const DEFAULT_APP_ROOT = path.resolve(HERE, "..");
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const QUIET = process.env.LOCAL_QUIET === "1";
const HOST_NAME = "node-sidecar";
const ADMIN_PASSWORD_FILE = "admin-password.txt";
/** API prefixes that a cross-origin page may call; the static tree is same-origin only. */
const CORS_PATHS = ["/api/", "/sync", "/img/"];

// ─────────────────────────── CLI / env ───────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

function intArg(value, fallback, name) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    console.error(`[local] invalid ${name}: ${value}`);
    process.exit(1);
  }
  return n;
}

const APP_ROOT = path.resolve(String(args["app-root"] || DEFAULT_APP_ROOT));
const PORT = intArg(args.port ?? process.env.PORT, 8787, "port");
const HOST = String(args.host || process.env.HOST || "127.0.0.1");
// services.rs passes `--root <dir>` to every sidecar; for the main server that directory is the
// writable data home, not the app root (assets come from this script's own location).
const DATA_DIR = path.resolve(String(args["data-dir"] || args.root || process.env.DATA_DIR || path.join(APP_ROOT, ".local-data")));
const PUBLIC_DIR = path.join(APP_ROOT, "public");
// One file for the unified store, shared with src-tauri's rusqlite adapter (same directory, same
// ledger). `ownchat.sqlite` is the spike-era name and is renamed on first start.
const DB_FILE = path.join(DATA_DIR, "ownchat.db");
const LEGACY_DB_FILE = path.join(DATA_DIR, "ownchat.sqlite");

// ─────────────────────────── .dev.vars ───────────────────────────

/** Minimal .dev.vars parser: KEY=VALUE, `#` comments, optional single/double quotes. */
function parseDevVars(text) {
  const out = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) {
      console.warn(`[local] .dev.vars: ignoring line without KEY=VALUE: ${line.slice(0, 40)}`);
      continue;
    }
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      console.warn(`[local] .dev.vars: invalid key: ${key.slice(0, 40)}`);
      continue;
    }
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadEnv() {
  const env = {};
  // Two locations, data dir last: a packaged app cannot write next to its own resources, so operator
  // overrides live beside the database. Within a location, the later file wins on a duplicate key.
  const candidates = [path.join(APP_ROOT, ".dev.vars"), path.join(DATA_DIR, ".dev.vars")];
  const seen = new Set();
  let fileCount = 0;
  let devVarsPassword = false;
  for (const devVarsPath of candidates) {
    if (!fs.existsSync(devVarsPath)) continue;
    const vars = parseDevVars(fs.readFileSync(devVarsPath, "utf8"));
    Object.assign(env, vars);
    fileCount += Object.keys(vars).length;
    if (String(vars.CHAT_PASSWORD || "").trim()) devVarsPassword = true;
    seen.add(devVarsPath);
  }
  // Container / shell env wins: an operator overriding one key should not have to edit a file.
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  return { env, fileCount, files: [...seen], devVarsPassword };
}

/**
 * Resolve the admin password, generating and persisting one on first run.
 * @returns {{ password: string, source: "env"|"dev.vars"|"file"|"generated", file: string }}
 */
function resolveAdminPassword(env, devVarsPassword, dataDir) {
  const fromEnv = String(env.CHAT_PASSWORD || "").trim();
  const file = path.join(dataDir, ADMIN_PASSWORD_FILE);
  if (fromEnv) return { password: fromEnv, source: devVarsPassword ? "dev.vars" : "env", file };
  let existing = "";
  try {
    existing = fs.readFileSync(file, "utf8").trim();
  } catch (e) {
    // Absent on first run is the normal path; anything else (permissions) surfaces on write below.
  }
  if (existing) return { password: existing, source: "file", file };
  const generated = crypto.randomBytes(18).toString("base64url");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, generated + "\n", { encoding: "utf8", mode: 0o600 });
  return { password: generated, source: "generated", file };
}

// ─────────────────────────── prompt registries ───────────────────────────

// src/prompts/registry.js statically imports four generated files (gitignored). wrangler runs the
// generator through [build]; here it is generated on demand so a fresh clone can start with plain
// `node server/local.mjs`.
function ensurePromptRegistries() {
  const generated = [
    path.join(APP_ROOT, "src/prompts/bases/unlocked/index.js"),
    path.join(APP_ROOT, "src/prompts/bases/locked/index.js"),
    path.join(APP_ROOT, "src/prompts/presets/index.js"),
    path.join(APP_ROOT, "src/prompts/skills/index.js"),
  ];
  const missing = generated.filter((p) => !fs.existsSync(p));
  if (!missing.length) return;
  console.log(`[local] generated prompt registries missing (${missing.length}); running tooling/scripts/gen-prompts.mjs`);
  const r = spawnSync(process.execPath, [path.join(APP_ROOT, "tooling/scripts/gen-prompts.mjs")], {
    cwd: APP_ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (r.status !== 0) {
    console.error("[local] tooling/scripts/gen-prompts.mjs failed; cannot start");
    process.exit(r.status || 1);
  }
}

// ─────────────────────────── ASSETS ───────────────────────────

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".bin": "application/octet-stream",
};

function isInside(root, target) {
  return target === root || target.startsWith(root + path.sep);
}

function plain(status, text, extraHeaders = {}) {
  return new Response(text, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache", ...extraHeaders },
  });
}

/**
 * Static-asset shim. Contract: `fetch(request) -> Response`, GET/HEAD only, path confined to
 * public/. Unknown files are 404 (Cloudflare's `not_found_handling` default is "none"; serving
 * index.html for anything would hide broken links and change app behaviour).
 */
export function makeAssets(publicDir) {
  if (!fs.existsSync(publicDir) || !fs.statSync(publicDir).isDirectory()) {
    throw new Error(`public/ not found at ${publicDir}`);
  }
  const realRoot = fs.realpathSync.native(publicDir);

  return {
    async fetch(request) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return plain(405, "Method Not Allowed", { Allow: "GET, HEAD" });
      }
      const url = new URL(request.url);
      let pathname;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        return plain(400, "Bad Request");
      }
      // Windows: reject backslashes and colons outright. A backslash is treated as a separator by
      // the OS but not by the URL parser, and `file.txt:stream` opens an NTFS alternate stream.
      if (pathname.includes("\0") || pathname.includes("\\") || pathname.includes(":")) {
        return plain(400, "Bad Request");
      }
      const abs = path.resolve(realRoot, "." + pathname);
      if (!isInside(realRoot, abs)) return plain(404, "Not Found");

      let stat;
      try { stat = fs.statSync(abs); } catch { return plain(404, "Not Found"); }

      if (stat.isDirectory()) {
        if (!pathname.endsWith("/")) {
          const location = pathname + "/" + url.search;
          return new Response(null, { status: 308, headers: { Location: location, "Cache-Control": "no-cache" } });
        }
        return fileResponse(path.join(abs, "index.html"), realRoot, request);
      }
      if (!stat.isFile()) return plain(404, "Not Found");
      return fileResponse(abs, realRoot, request);
    },
  };
}

function fileResponse(absPath, realRoot, request) {
  // Resolve symlinks/junctions *after* the lexical confinement check: a link inside public/ may
  // point anywhere, and following it out of the tree would be an escape. Fail closed.
  let real, stat;
  try {
    real = fs.realpathSync.native(absPath);
    if (!isInside(realRoot, real)) return plain(404, "Not Found");
    stat = fs.statSync(real);
  } catch { return plain(404, "Not Found"); }
  if (!stat.isFile()) return plain(404, "Not Found");
  const ext = path.extname(real).toLowerCase();
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers = {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Length": String(stat.size),
    "Cache-Control": "no-cache",
    ETag: etag,
  };
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "no-cache" } });
  }
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  const stream = Readable.toWeb(fs.createReadStream(real));
  return new Response(stream, { status: 200, headers });
}

// ─────────────────────────── KV ───────────────────────────

/**
 * TAVERN_SYNC over `sync_kv`. The table name is deliberately not `kv`: the shell's settings table
 * lives in `native_kv`, and the spike-era `kv` shape is copied here once (see main()).
 */
export function makeKv(db) {
  const getStmt = db.prepare("SELECT value FROM sync_kv WHERE key = ?");
  const putStmt = db.prepare("INSERT INTO sync_kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at");
  const delStmt = db.prepare("DELETE FROM sync_kv WHERE key = ?");
  return {
    async get(key, options) {
      const row = getStmt.get(String(key));
      if (!row) return null;
      if (options && options.type === "json") return JSON.parse(row.value);
      return row.value;
    },
    async put(key, value) {
      // The worker only ever writes strings (JSON blobs). Anything else is a bug here, not a
      // feature request: fail loud instead of silently stringifying an ArrayBuffer.
      if (typeof value !== "string") throw new TypeError("local KV shim only accepts string values");
      putStmt.run(String(key), value, Date.now());
    },
    async delete(key) {
      delStmt.run(String(key));
    },
  };
}

/** Create the sync table and carry rows over from the spike-era three-column `kv` table, once. */
export function ensureSyncKv(db) {
  db.exec("CREATE TABLE IF NOT EXISTS sync_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kv'").all();
  if (!tables.length) return 0;
  const columns = db.prepare("PRAGMA table_info(kv)").all().map((r) => String(r.name));
  // The shell's old settings table is four columns (namespace first); the sidecar's is exactly three.
  const legacy = columns.length === 3 && columns.includes("key") && columns.includes("value");
  if (!legacy) return 0;
  const copied = db
    .prepare("INSERT OR IGNORE INTO sync_kv (key, value, updated_at) SELECT key, value, COALESCE(updated_at, 0) FROM kv")
    .run();
  const moved = Number(copied.changes || 0);
  if (moved > 0) console.log(`[local] migrated ${moved} row(s) from legacy kv → sync_kv`);
  return moved;
}

/**
 * Apply every `migrations/*.sql` in filename order, recording each in `_migrations`.
 * Extracted so test/sidecar-db.test.mjs exercises the real runner (idempotence included) instead of
 * re-implementing the ledger rule.
 * @returns the file names, in application order
 */
export function applyMigrations(db, migrationsDir) {
  if (!fs.existsSync(migrationsDir)) throw new Error(`migrations dir missing: ${migrationsDir}`);
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, ts INTEGER NOT NULL)");
  const applied = new Set(db.prepare("SELECT name FROM _migrations").all().map((r) => String(r.name)));
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    db.exec(sql);
    // INSERT OR IGNORE: the desktop shell may apply the same ledger through rusqlite at the same
    // moment; a duplicate-key race must not take the host down.
    db.prepare("INSERT OR IGNORE INTO _migrations (name, ts) VALUES (?, ?)").run(file, Date.now());
  }
  return files;
}

// ─────────────────────────── D1 ───────────────────────────

class D1Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    return new D1Statement(this.db, this.sql, params);
  }
  async all() {
    const results = this.db.prepare(this.sql).all(...this.params);
    return { results, success: true, meta: {} };
  }
  async first(column) {
    const row = this.db.prepare(this.sql).get(...this.params);
    if (row === undefined || row === null) return null;
    if (column !== undefined) return row[column] ?? null;
    return row;
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return {
      success: true,
      results: [],
      meta: { changes: Number(r.changes || 0), last_row_id: Number(r.lastInsertRowid || 0) },
    };
  }
}

/** D1 shim limited to prepare/bind/all/first/run/batch — the surface src/worker.js uses. */
export function makeD1(db) {
  // 2026-11-28: one connection, many concurrent HTTP requests. Two overlapping batch() calls used
  // to interleave BEGIN/COMMIT on the same connection ("cannot start a transaction within a
  // transaction"). Serialise the batches through a promise chain; single statements stay
  // auto-commit and need no lock.
  let txChain = Promise.resolve();
  return {
    prepare(sql) {
      return new D1Statement(db, sql);
    },
    async batch(statements) {
      const run = async () => {
        const out = [];
        db.exec("BEGIN");
        try {
          for (const stmt of statements) out.push(await stmt.run());
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
        return out;
      };
      const next = txChain.then(run, run);
      txChain = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
}

// ─────────────────────────── request / response bridge ───────────────────────────

function nodeHeadersToWeb(req) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else headers.set(name, value);
  }
  return headers;
}

async function readRequestBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      const err = new Error("request body too large");
      err.code = "E_TOO_LARGE";
      throw err;
    }
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : null;
}

/** Whether a path is part of the API surface a cross-origin page may call. */
function isCorsPath(pathname) {
  const p = String(pathname || "");
  for (const prefix of CORS_PATHS) {
    // "/sync" is both a path of its own (the main blob GET/PUT) and a prefix (/sync/chat/events).
    if (prefix === "/sync") {
      if (p === "/sync" || p.startsWith("/sync/")) return true;
      continue;
    }
    if (p.startsWith(prefix)) return true;
  }
  return false;
}

/** CORS headers for one reflected origin; a worker route that set its own ACAO keeps it. */
function addCors(headers, origin) {
  if (!origin) return;
  const has = Object.keys(headers).some((k) => k.toLowerCase() === "access-control-allow-origin");
  if (has) return;
  headers["Access-Control-Allow-Origin"] = origin;
  headers["Vary"] = headers["Vary"] ? headers["Vary"] + ", Origin" : "Origin";
  headers["Access-Control-Allow-Methods"] = "GET, HEAD, POST, PUT, DELETE, OPTIONS";
  headers["Access-Control-Allow-Headers"] = "authorization, content-type";
  headers["Access-Control-Max-Age"] = "600";
}

function writeWebResponse(res, response, origin) {
  const headers = {};
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() === "set-cookie") continue;
    headers[name] = value;
  }
  const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  if (cookies.length) headers["set-cookie"] = cookies;
  addCors(headers, origin);

  // `writeHead(status, undefined, headers)` would treat `undefined` as the headers argument in
  // some Node versions; branch instead of relying on that overload.
  if (response.statusText) res.writeHead(response.status, response.statusText, headers);
  else res.writeHead(response.status, headers);
  if (!response.body) { res.end(); return; }  const body = Readable.fromWeb(response.body);
  body.on("error", (e) => {
    console.error("[local] response stream error:", e && e.message);
    res.destroy(e);
  });
  body.pipe(res);
}

// ─────────────────────────── boot ───────────────────────────

async function main() {
  ensurePromptRegistries();

  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Spike-era file name: rename rather than ignore, so a user who already ran the sidecar keeps the
  // /sync blob. A failed rename (file locked) falls through to a fresh database only after a warning.
  if (!fs.existsSync(DB_FILE) && fs.existsSync(LEGACY_DB_FILE)) {
    try {
      fs.renameSync(LEGACY_DB_FILE, DB_FILE);
      for (const suffix of ["-wal", "-shm"]) {
        const from = LEGACY_DB_FILE + suffix;
        if (fs.existsSync(from)) fs.renameSync(from, DB_FILE + suffix);
      }
      console.log(`[local] renamed legacy ${path.basename(LEGACY_DB_FILE)} → ${path.basename(DB_FILE)}`);
    } catch (e) {
      console.warn(`[local] could not rename ${LEGACY_DB_FILE}: ${(e && e.message) || e}`);
    }
  }

  const db = new DatabaseSync(DB_FILE);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");

  // 2026-11-28（T1）：按文件名顺序应用 migrations/*.sql，用 _migrations 留痕。
  // 每个文件自身也是幂等的（IF NOT EXISTS），账本只是省掉重复执行与给出可查的历史。
  const migrationsDir = path.join(APP_ROOT, "migrations");
  const files = applyMigrations(db, migrationsDir);
  ensureSyncKv(db);

  const loaded = loadEnv();
  const env = loaded.env;
  const auth = resolveAdminPassword(env, loaded.devVarsPassword, DATA_DIR);
  env.CHAT_PASSWORD = auth.password;
  // Safe default for a self-hosted box: without an access token there is no chat. An operator can
  // still opt into CHAT_MODE=byo/open explicitly.
  const mode = String(env.CHAT_MODE || "").trim().toLowerCase();
  if (!mode) env.CHAT_MODE = "private";
  env.ASSETS = makeAssets(PUBLIC_DIR);
  env.TAVERN_SYNC = makeKv(db);
  env.TAVERN_EVENTS = makeD1(db);

  const pending = new Set();
  const ctx = {
    waitUntil(promise) {
      const p = Promise.resolve(promise).catch((e) => console.error("[local] waitUntil:", e && e.message));
      pending.add(p);
      p.finally(() => pending.delete(p));
    },
    passThroughOnException() {},
  };

  const worker = (await import("../src/worker.js")).default;
  if (!worker || typeof worker.fetch !== "function") throw new Error("src/worker.js has no fetch handler");

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let status = 0;
    const origin = String(req.headers.origin || "");
    try {
      const host = req.headers.host || `${HOST}:${PORT}`;
      let url;
      try { url = new URL(req.url || "/", `http://${host}`); }
      catch { res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Bad Request"); return; }

      // Preflight never reaches the worker: the worker has no OPTIONS route and would 404, which a
      // browser reads as a CORS failure for every JSON POST from the app origin.
      if (req.method === "OPTIONS" && origin && isCorsPath(url.pathname)) {
        const headers = { "Cache-Control": "no-cache" };
        addCors(headers, origin);
        res.writeHead(204, headers);
        res.end();
        status = 204;
        return;
      }

      // Sidecar-only capability report (not part of the worker surface): the first-run steps and the
      // host provider read it to tell "host is up, auth configured, node version" apart from "the
      // worker answered". No secret, no filesystem path.
      if (req.method === "GET" && url.pathname === "/api/host") {
        const body = JSON.stringify({
          ok: true,
          host: HOST_NAME,
          profile: "desktop",
          version: 1,
          node: process.version,
          port: PORT,
          auth: { configured: true, source: auth.source },
          chatMode: env.CHAT_MODE,
          storage: { engine: "node:sqlite", migrations: files.length },
        });
        const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
        addCors(headers, origin);
        res.writeHead(200, headers);
        res.end(body);
        status = 200;
        return;
      }

      let body = null;
      if (req.method !== "GET" && req.method !== "HEAD") {
        try { body = await readRequestBody(req); }
        catch (e) {
          if (e.code === "E_TOO_LARGE") {
            res.writeHead(413, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Payload Too Large");
            status = 413;
            return;
          }
          throw e;
        }
      }

      const request = new Request(url, {
        method: req.method,
        headers: nodeHeadersToWeb(req),
        body: body && body.length ? body : undefined,
        redirect: "manual",
      });
      const response = await worker.fetch(request, env, ctx);
      status = response.status;
      writeWebResponse(res, response, origin);
    } catch (e) {
      status = 500;
      console.error("[local] unhandled:", (e && e.stack) || e);
      if (!res.headersSent) {
        const headers = { "Content-Type": "text/plain; charset=utf-8" };
        addCors(headers, origin);
        res.writeHead(500, headers);
      }
      if (!res.writableEnded) res.end("Internal Server Error");
    } finally {
      if (!QUIET) console.log(`[local] ${req.method} ${req.url} -> ${status} (${Date.now() - started}ms)`);
    }
  });

  server.on("clientError", (err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, HOST, resolve);
  });

  console.log(`[local] listening on http://${HOST}:${PORT}`);
  console.log(`[local] app root: ${APP_ROOT}`);
  console.log(`[local] data dir: ${DATA_DIR}`);
  console.log(`[local] database: ${DB_FILE}`);
  console.log(`[local] secrets: ${loaded.files.length} .dev.vars file(s), process env on top`);
  console.log(`[local] access gate: configured (source=${auth.source}); chat mode: ${env.CHAT_MODE}`);
  if (auth.source === "generated") {
    console.log(`[local] first run: an admin password was generated and written to ${auth.file}`);
    console.log(`[local]            enter it in the app's first-run step (it is never printed here)`);
  }

  let closing = false;
  const shutdown = async (signal, code = 0) => {
    if (closing) return;
    closing = true;
    console.log(`[local] ${signal}: shutting down`);
    // Cap the drain: a keep-alive socket from the shell must not keep the process alive.
    const hard = setTimeout(() => {
      try { db.close(); } catch (e) {}
      process.exit(code);
    }, 3000);
    hard.unref?.();
    try { server.close(); } catch (e) {}
    try { server.closeIdleConnections?.(); } catch (e) {}
    await Promise.allSettled([...pending]);
    try { server.closeAllConnections?.(); } catch (e) {}
    try { db.close(); } catch (e) {}
    clearTimeout(hard);
    process.exit(code);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (e) => {
    console.error("[local] uncaught exception:", (e && e.stack) || e);
    shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (e) => {
    // Logged, not fatal: a rejected background promise must not take the host down mid-turn.
    console.error("[local] unhandled rejection:", (e && (e.stack || e.message)) || e);
  });
}

// Import-safe: the module exports its shims for test/sidecar-db.test.mjs, so only the CLI invocation
// starts a server. `process.argv[1]` is undefined under `node -e`, hence the guard.
const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  } catch (e) {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((e) => {
    console.error("[local] fatal:", (e && e.stack) || e);
    process.exit(1);
  });
}
