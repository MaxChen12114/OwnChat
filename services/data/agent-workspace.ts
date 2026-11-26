/**
 * Agent file workspace: a per-conversation file store handed to the model as six tools
 * (list / read / search / write / edit / delete) plus an export that reaches the real disk.
 *
 * The store arrives through {@link WorkspacePorts}: the browser wiring backs it with the unified
 * SQLite `workspace` / `workspace_versions` / `workspace_blobs` tables, keeps the legacy IndexedDB
 * database only as the one-time import source and as a fallback for hosts without those tables,
 * and the tests use a map. So do line slicing, text search, the clock and the disk export, because
 * each of them already has an owner elsewhere. This file touches no `window`, `document` or
 * `indexedDB`; the adapter lives in l0/wiring/agent-workspace.js.
 *
 * Files are keyed by `convId::path` (the SQL row keeps that composite key in `path`, because the
 * table's primary key is `path` alone), so a task's intermediate products die with its
 * conversation. That is the non-obvious choice here: the workspace is a scratchpad per
 * conversation, not a shared drive, and every path is flat — `..` is rejected rather than resolved.
 *
 * Tools are registered one `try` at a time. A duplicate name makes `define` throw, and a shared
 * `try` would take every later file tool down with it.
 * @module services/data/agent-workspace
 */

/** Key-value storage is not used here, but the change hook and clock are shared with the domain. */
export type RawRow = Record<string, unknown>;

/** One stored file, exactly as the store hands it back. Legacy rows may miss fields. */
export interface WorkspaceFile {
  path: string;
  bytes: number;
  lines?: number;
  ts: number;
  content: string;
}

/** One immutable version, as `history` returns it (no content). */
export interface WorkspaceVersion {
  version: number;
  ts: number;
  bytes: number;
  lines: number;
  kind: string;
}

/** The stored version row. `hash` is null for a delete; `fromVersion` marks a restore. */
interface VersionRow {
  id: string;
  scopeKey: string;
  convId: string;
  path: string;
  seq: number;
  ts: number;
  kind: string;
  hash: string | null;
  bytes: number;
  lines: number;
  prevHash: string | null;
  fromVersion?: number;
}

/** File-store port: one flat namespace of rows keyed by `id`. */
export interface FileStore {
  all(): Promise<RawRow[]>;
  get(id: string): Promise<RawRow | null>;
  put(row: RawRow): Promise<void>;
  remove(id: string): Promise<void>;
  /** Delete every row the predicate accepts; resolves with how many were removed. */
  removeWhere(match: (row: RawRow) => boolean): Promise<number>;
  clear(): Promise<void>;
}

/** Line slicing and text search, owned by the text-search module. */
export interface TextSearchPort {
  LIMITS: {
    READ_MAX_BYTES: number;
    SEARCH_HARD_MAX: number;
    SEARCH_DEF_MAX: number;
    SEARCH_CTX_DEF: number;
    SEARCH_OUT_BUDGET: number;
  };
  sliceLines(content: string, offset?: unknown, limit?: unknown): SliceResult;
  searchText(content: string, opts: SearchOpts): SearchResult;
  globToRe(glob: string): RegExp | null;
  fitBlocks(blocks: SearchBlock[], budget: number): FitResult;
}

export interface SliceResult {
  total: number;
  from: number;
  to: number;
  text: string;
  more: boolean;
  clippedLines?: number;
  droppedByBytes?: number;
}

export interface SearchOpts {
  pattern: string;
  regex: boolean;
  ignore_case: boolean;
  context: unknown;
  max_results: number;
}

export interface SearchResult {
  matches: unknown[];
  total: number;
  totalLines: number;
  truncated?: boolean;
  degraded?: string;
}

export interface SearchBlock {
  path: string;
  totalLines: number;
  matchCount: number;
  matches: unknown[];
  truncated?: boolean;
}

export interface FitResult {
  blocks: SearchBlock[];
  truncated: boolean;
}

/** Disk export, already resolved to a platform by the wiring layer (Tauri dialog or download). */
export type ExportOutcome =
  | { ok: true; mode: string; path?: string; filename?: string; bytes: number }
  | { ok: false; error: string };

/** A tool descriptor as the model sees it. `parameters` is JSON Schema, kept opaque here. */
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  destructive?: boolean;
  run: (args: unknown) => unknown;
}

export interface ToolRegistryPort {
  define(def: ToolDef): void;
}

export interface WorkspacePorts {
  store: FileStore;
  /** Immutable version rows, keyed `${scopeKey}#${seq}`; absent disables history. */
  versions?: FileStore;
  /** Content-addressed text blobs, keyed `${convId}::${hash}`; absent disables history. */
  blobs?: FileStore;
  /** Content hash for dedupe; absent or rejecting disables history, never blocks a file write. */
  digest?: (text: string) => Promise<string>;
  /** Active conversation id; `__none__` when nothing is open. */
  convId(): string;
  /** Current timestamp for the `ts` stamp. */
  now(): number;
  /** Text slicing and search; read on every call because the module may load after this one. */
  text(): TextSearchPort | null;
  /** Write to the real disk and report what actually happened. */
  exportFile(filename: string, content: string): Promise<ExportOutcome>;
  /** A tool failed to register; the duplicate name and the error go to the console. */
  onToolError(name: string, error: unknown): void;
}

const NO_CONV = "__none__";
/** Keep at most this many versions of one file (baseline/delete included). */
const MAX_VERSIONS_PER_FILE = 50;
/** Keep at most this many versions across one conversation. */
const MAX_VERSIONS_PER_CONV = 200;
/** Keep at most this much version text per conversation; the main file write always wins. */
const MAX_HISTORY_BYTES_PER_CONV = 16 * 1024 * 1024;

/**
 * Object guard for values that came back from the model or from storage. Fields are copied one by
 * one: that is how this codebase reads unknown JSON without a cast.
 */
export function recOf(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
  const entries = Object.entries(value);
  for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  return out;
}

/** Array guard for the same reason as {@link recOf}. */
export function arrOf(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  const out: unknown[] = [];
  for (let i = 0; i < value.length; i++) out.push(value[i]);
  return out;
}

function strOf(v: unknown): string {
  return v == null ? "" : String(v);
}

function numOf(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Normalize a workspace path: forward slashes, no leading `./` or `/`, no `..` segment.
 * An empty result means "rejected" — the workspace is flat, so a traversal has no meaning here.
 */
export function normPath(p: unknown): string {
  const s = strOf(p)
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .replace(/^\/+/, "");
  if (!s) return "";
  const parts = s.split("/").filter((x) => x && x !== ".");
  if (parts.some((x) => x === "..")) return "";
  return parts.join("/");
}

/** Storage key of a path inside one conversation. */
export function fileKey(convId: string, path: string): string {
  return convId + "::" + path;
}

function toFile(row: unknown): WorkspaceFile {
  const r = recOf(row);
  const bytes = numOf(r["bytes"]);
  const lines = numOf(r["lines"]);
  return {
    path: strOf(r["path"]),
    bytes,
    lines: lines || undefined,
    ts: numOf(r["ts"]),
    content: strOf(r["content"]),
  };
}

function toVersion(row: unknown): VersionRow {
  const r = recOf(row);
  return {
    id: strOf(r["id"]),
    scopeKey: strOf(r["scopeKey"]),
    convId: strOf(r["convId"]),
    path: strOf(r["path"]),
    seq: numOf(r["seq"]),
    ts: numOf(r["ts"]),
    kind: strOf(r["kind"]),
    hash: r["hash"] == null ? null : strOf(r["hash"]),
    bytes: numOf(r["bytes"]),
    lines: numOf(r["lines"]),
    prevHash: r["prevHash"] == null ? null : strOf(r["prevHash"]),
    fromVersion: r["fromVersion"] == null ? undefined : numOf(r["fromVersion"]),
  };
}

/**
 * Build the workspace over its ports. Every method returns a result object instead of throwing:
 * the callers are model tools, and a thrown error would surface as a broken tool call.
 */
export function createWorkspace(ports: WorkspacePorts) {
  const convId = (): string => ports.convId() || NO_CONV;

  function list(): Promise<WorkspaceFile[]> {
    const c = convId();
    const empty: RawRow[] = [];
    return ports.store
      .all()
      .catch(() => empty)
      .then((rows) => {
      const out: WorkspaceFile[] = [];
      for (const row of rows) {
        const r = recOf(row);
        if (!r || strOf(r["convId"]) !== c) continue;
        const f = toFile(r);
        out.push({ path: f.path, bytes: f.bytes, lines: f.lines, ts: f.ts, content: "" });
      }
      out.sort((a, b) => (a.path < b.path ? -1 : 1));
      return out;
    });
  }

  function read(path: unknown): Promise<WorkspaceFile | null> {
    const p = normPath(path);
    if (!p) return Promise.resolve(null);
    return ports.store
      .get(fileKey(convId(), p))
      .then((row) => (row ? toFile(row) : null))
      .catch(() => null);
  }

  // ── History: append-only versions + content-addressed blobs ──
  // Best effort by design: a missing/broken history port turns history off for the rest of the
  // page and never blocks the file itself. `write` / `remove` keep their old result shapes.
  let historyOff = false;

  function historyReady(): boolean {
    return !historyOff && !!ports.versions && !!ports.blobs && !!ports.digest;
  }

  function versionsOf(scopeKey: string): Promise<VersionRow[]> {
    const v = ports.versions;
    if (!v) return Promise.resolve([]);
    return v.all()
      .then((rows) => rows.map(toVersion).filter((r) => r.scopeKey === scopeKey).sort((a, b) => a.seq - b.seq))
      .catch(() => []);
  }

  function versionsForConv(c: string): Promise<VersionRow[]> {
    const v = ports.versions;
    if (!v) return Promise.resolve([]);
    return v.all()
      .then((rows) => rows.map(toVersion).filter((r) => r.convId === c))
      .catch(() => []);
  }

  function digestOf(text: string): Promise<string | null> {
    const d = ports.digest;
    if (!d) { historyOff = true; return Promise.resolve(null); }
    return d(text)
      .then((hash) => strOf(hash) || null)
      .catch(() => { historyOff = true; return null; });
  }

  function putBlob(c: string, hash: string, text: string): Promise<boolean> {
    const b = ports.blobs;
    if (!b) return Promise.resolve(false);
    const id = c + "::" + hash;
    return b.get(id)
      .then((row) => {
        if (row) return true;
        return b.put({ id, convId: c, hash, content: text, bytes: text.length }).then(() => true);
      })
      .catch(() => { historyOff = true; return false; });
  }

  async function appendVersion(
    c: string, p: string, scopeKey: string, kind: string, text: string, fromVersion?: number,
  ): Promise<number | null> {
    if (!historyReady()) return null;
    const hash = await digestOf(text);
    if (!hash) return null;
    if (!(await putBlob(c, hash, text))) return null;
    const rows = await versionsOf(scopeKey);
    const seq = rows.length ? rows[rows.length - 1].seq + 1 : 1;
    const last = rows.length ? rows[rows.length - 1] : null;
    const row: RawRow = {
      id: scopeKey + "#" + seq,
      scopeKey,
      convId: c,
      path: p,
      seq,
      ts: ports.now(),
      kind,
      hash,
      bytes: text.length,
      lines: text.split("\n").length,
      prevHash: last ? last.hash : null,
    };
    if (fromVersion != null) row["fromVersion"] = fromVersion;
    const v = ports.versions;
    if (!v) return null;
    try {
      await v.put(row);
      return seq;
    } catch (_e) {
      historyOff = true;
      return null;
    }
  }

  /** A pre-history file's old content becomes seq 0 before the first mutation. */
  async function ensureBaseline(c: string, p: string, scopeKey: string, oldContent: string): Promise<void> {
    if (!historyReady()) return;
    const rows = await versionsOf(scopeKey);
    if (rows.length) return;
    const hash = await digestOf(oldContent);
    if (!hash) return;
    if (!(await putBlob(c, hash, oldContent))) return;
    const v = ports.versions;
    if (!v) return;
    try {
      await v.put({
        id: scopeKey + "#0",
        scopeKey,
        convId: c,
        path: p,
        seq: 0,
        ts: ports.now(),
        kind: "baseline",
        hash,
        bytes: oldContent.length,
        lines: oldContent.split("\n").length,
        prevHash: null,
      });
    } catch (_e) {
      historyOff = true;
    }
  }

  async function appendDelete(c: string, p: string, scopeKey: string): Promise<number | null> {
    if (!historyReady()) return null;
    const rows = await versionsOf(scopeKey);
    const seq = rows.length ? rows[rows.length - 1].seq + 1 : 1;
    const last = rows.length ? rows[rows.length - 1] : null;
    const v = ports.versions;
    if (!v) return null;
    try {
      await v.put({
        id: scopeKey + "#" + seq,
        scopeKey,
        convId: c,
        path: p,
        seq,
        ts: ports.now(),
        kind: "delete",
        hash: null,
        bytes: 0,
        lines: 0,
        prevHash: last ? last.hash : null,
      });
      return seq;
    } catch (_e) {
      historyOff = true;
      return null;
    }
  }

  /** Trim old versions and GC blobs no remaining version references. */
  async function prune(c: string): Promise<void> {
    const v = ports.versions;
    const b = ports.blobs;
    if (!v || !b) return;
    const rows = await versionsForConv(c);
    if (!rows.length) return;

    const latest = new Map<string, VersionRow>();
    for (const r of rows) {
      const cur = latest.get(r.scopeKey);
      if (!cur || r.seq > cur.seq) latest.set(r.scopeKey, r);
    }

    const drop = new Set<string>();
    const byScope = new Map<string, VersionRow[]>();
    for (const r of rows) {
      const list = byScope.get(r.scopeKey) || [];
      list.push(r);
      byScope.set(r.scopeKey, list);
    }
    for (const list of byScope.values()) {
      list.sort((a, b) => b.seq - a.seq);
      for (let i = MAX_VERSIONS_PER_FILE; i < list.length; i++) drop.add(list[i].id);
    }

    const kept = rows.filter((r) => !drop.has(r.id));
    const ordered = kept.slice().sort((a, b) => a.ts - b.ts || a.seq - b.seq);
    let count = ordered.length;
    let bytes = ordered.reduce((n, r) => n + r.bytes, 0);
    for (const r of ordered) {
      if (count <= MAX_VERSIONS_PER_CONV && bytes <= MAX_HISTORY_BYTES_PER_CONV) break;
      if (latest.get(r.scopeKey) === r) continue; // never drop the latest version of a file
      drop.add(r.id);
      count--;
      bytes -= r.bytes;
    }

    for (const id of drop) {
      try { await v.remove(id); } catch (_e) { /* best effort */ }
    }

    const remaining = rows.filter((r) => !drop.has(r.id));
    const used = new Set<string>();
    for (const r of remaining) if (r.hash) used.add(r.hash);
    let blobs: RawRow[] = [];
    try { blobs = await b.all(); } catch (_e) { blobs = []; }
    for (const raw of blobs) {
      const row = recOf(raw);
      if (strOf(row["convId"]) !== c) continue;
      const hash = strOf(row["hash"]);
      if (hash && !used.has(hash)) {
        try { await b.remove(strOf(row["id"])); } catch (_e) { /* best effort */ }
      }
    }
  }

  type WriteResult =
    | { ok: true; path: string; bytes: number; version: number | null }
    | { ok: false; error: string };

  function writeInternal(path: unknown, content: unknown, kind: string, fromVersion?: number): Promise<WriteResult> {
    const p = normPath(path);
    if (!p) return Promise.resolve({ ok: false, error: "路径不合法(不能为空、不能含 ..)" });
    const text = strOf(content);
    const c = convId();
    const scopeKey = fileKey(c, p);
    const row: RawRow = {
      id: scopeKey,
      convId: c,
      path: p,
      content: text,
      bytes: text.length,
      lines: text.split("\n").length,
      ts: ports.now(),
    };
    const withHistory = historyReady();
    const oldP = withHistory ? ports.store.get(scopeKey).catch(() => null) : Promise.resolve(null);
    return oldP.then(async (oldRow) => {
      const old = oldRow ? toFile(oldRow) : null;
      if (withHistory && old) await ensureBaseline(c, p, scopeKey, old.content);
      try {
        await ports.store.put(row);
      } catch (_e) {
        return { ok: false, error: "工作区不可用(存储未就绪)" };
      }
      let version: number | null = null;
      if (withHistory) {
        version = await appendVersion(c, p, scopeKey, kind, text, fromVersion);
        await prune(c);
      }
      return { ok: true, path: p, bytes: text.length, version };
    });
  }

  function write(path: unknown, content: unknown): Promise<
    { ok: true; path: string; bytes: number } | { ok: false; error: string }
  > {
    return writeInternal(path, content, "write").then((r) => (
      r.ok ? { ok: true, path: r.path, bytes: r.bytes } : r
    ));
  }

  function remove(path: unknown): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
    const p = normPath(path);
    if (!p) return Promise.resolve({ ok: false, error: "路径不合法" });
    const c = convId();
    const scopeKey = fileKey(c, p);
    const withHistory = historyReady();
    const oldP = withHistory ? ports.store.get(scopeKey).catch(() => null) : Promise.resolve(null);
    return oldP.then(async (oldRow) => {
      const old = oldRow ? toFile(oldRow) : null;
      if (withHistory && old) await ensureBaseline(c, p, scopeKey, old.content);
      try {
        await ports.store.remove(scopeKey);
      } catch (_e) {
        return { ok: false, error: "工作区不可用" };
      }
      if (withHistory && old) {
        await appendDelete(c, p, scopeKey);
        await prune(c);
      }
      return { ok: true, path: p };
    });
  }

  /**
   * Drop every file of one conversation. Called when a conversation is deleted or its history is
   * cleared; without it the workspace keeps orphans whose convId no longer exists.
   */
  function removeByConv(cid?: unknown): Promise<{ ok: boolean; removed: number }> {
    const target = strOf(cid) || convId();
    return ports.store
      .removeWhere((row) => strOf(recOf(row)["convId"]) === target)
      .then((removed) => {
        const jobs: Array<Promise<unknown>> = [];
        const v = ports.versions;
        const b = ports.blobs;
        if (v) jobs.push(v.removeWhere((row) => strOf(recOf(row)["convId"]) === target).catch(() => 0));
        if (b) jobs.push(b.removeWhere((row) => strOf(recOf(row)["convId"]) === target).catch(() => 0));
        return Promise.all(jobs).then(() => ({ ok: true, removed }));
      })
      .catch(() => ({ ok: false, removed: 0 }));
  }

  /** Wipe the whole workspace, used by "clear all conversations". */
  function clearAll(): Promise<{ ok: boolean }> {
    const jobs: Array<Promise<unknown>> = [ports.store.clear()];
    if (ports.versions) jobs.push(ports.versions.clear());
    if (ports.blobs) jobs.push(ports.blobs.clear());
    return Promise.all(jobs)
      .then(() => ({ ok: true }))
      .catch(() => ({ ok: false }));
  }

  /** Version metadata for one file, newest first; no content. */
  function history(path: unknown, limit?: unknown): Promise<unknown> {
    const p = normPath(path);
    if (!p) return Promise.resolve({ ok: false, error: "路径不合法" });
    if (!historyReady()) return Promise.resolve({ ok: false, error: "历史未启用（wiring 未提供 versions/blobs/digest）" });
    const max = Math.max(1, Math.min(50, numOf(limit) || 20));
    return versionsOf(fileKey(convId(), p)).then((rows) => {
      const all = rows.slice().sort((a, b) => b.seq - a.seq);
      return {
        ok: true,
        path: p,
        total: all.length,
        versions: all.slice(0, max).map((r) => ({
          version: r.seq,
          ts: r.ts,
          bytes: r.bytes,
          lines: r.lines,
          kind: r.kind,
        })),
      };
    });
  }

  /** One version's full text; the UI restores by seq, never by content. */
  function readVersion(path: unknown, version: unknown): Promise<unknown> {
    const p = normPath(path);
    if (!p) return Promise.resolve({ ok: false, error: "路径不合法" });
    if (!historyReady()) return Promise.resolve({ ok: false, error: "历史未启用" });
    const b = ports.blobs;
    if (!b) return Promise.resolve({ ok: false, error: "历史未启用" });
    const c = convId();
    return versionsOf(fileKey(c, p)).then((rows) => {
      const v = rows.find((r) => r.seq === numOf(version));
      if (!v) return { ok: false, error: "版本不存在" };
      if (!v.hash) return { ok: false, error: "该版本是删除记录，没有正文" };
      return b.get(c + "::" + v.hash).then((blob) => {
        if (!blob) return { ok: false, error: "版本正文已清理" };
        return {
          ok: true,
          path: p,
          version: v.seq,
          ts: v.ts,
          bytes: v.bytes,
          lines: v.lines,
          kind: v.kind,
          content: strOf(recOf(blob)["content"]),
        };
      }).catch(() => ({ ok: false, error: "版本正文读取失败" }));
    });
  }

  /**
   * Restore an old version by writing a NEW version with its content. History is append-only:
   * the restored-from row is never rewritten, so a restore can itself be undone.
   */
  async function restore(path: unknown, version: unknown): Promise<unknown> {
    const p = normPath(path);
    if (!p) return { ok: false, error: "路径不合法" };
    if (!historyReady()) return { ok: false, error: "历史未启用" };
    const c = convId();
    const rows = await versionsOf(fileKey(c, p));
    const v = rows.find((r) => r.seq === numOf(version));
    if (!v) return { ok: false, error: "版本不存在" };
    if (!v.hash) return { ok: false, error: "该版本是删除记录，没有正文" };
    const b = ports.blobs;
    if (!b) return { ok: false, error: "历史未启用" };
    const blob = await b.get(c + "::" + v.hash).catch(() => null);
    if (!blob) return { ok: false, error: "版本正文已清理" };
    const text = strOf(recOf(blob)["content"]);
    const w = await writeInternal(p, text, "restore", v.seq);
    if (w.ok === false) return w;
    return { ok: true, path: p, version: w.version, restoredFrom: v.seq, bytes: text.length };
  }

  function listFiles(): Promise<unknown> {
    return list().then((arr) => {
      if (!arr.length) return { ok: true, files: [], note: "工作区还是空的。用 write_file 写入第一个文件。" };
      return { ok: true, count: arr.length, files: arr };
    });
  }

  function readFile(args: unknown): Promise<unknown> {
    const a = recOf(args);
    return read(a["path"]).then((r) => {
      if (!r) return { ok: false, error: "文件不存在: " + normPath(a["path"]) };
      const TS = ports.text();
      if (!TS) return { ok: false, error: "text-search 模块未加载（分页读不可用）" };
      const sl = TS.sliceLines(r.content, a["offset"], a["limit"]);
      const out: Record<string, unknown> = {
        ok: true,
        path: r.path,
        bytes: r.bytes,
        totalLines: sl.total,
        from: sl.from,
        to: sl.to,
        text: sl.text,
      };
      if (sl.more) {
        out["truncated"] = true;
        out["nextOffset"] = sl.to + 1;
        out["hint"] =
          "共 " +
          sl.total +
          " 行，本次返回第 " +
          sl.from +
          "–" +
          sl.to +
          " 行；继续读用 read_file(offset=" +
          (sl.to + 1) +
          ")，或先 search_file 定位再读窗口。";
      } else if (sl.from > 1) {
        out["hint"] = "已到文件末尾（共 " + sl.total + " 行）。";
      }
      if (sl.clippedLines) out["clippedLines"] = sl.clippedLines;
      if (sl.droppedByBytes) {
        out["hint"] =
          (out["hint"] ? out["hint"] + " " : "") +
          "（单窗字节上限 " +
          TS.LIMITS.READ_MAX_BYTES +
          "，本次少返回 " +
          sl.droppedByBytes +
          " 行）";
      }
      return out;
    });
  }

  function searchFile(args: unknown): Promise<unknown> {
    const a = recOf(args);
    const pattern = strOf(a["pattern"]);
    if (!pattern) return Promise.resolve({ ok: false, error: "缺少 pattern" });
    const TS = ports.text();
    if (!TS) return Promise.resolve({ ok: false, error: "text-search 模块未加载（检索不可用）" });
    return list().then((found) => {
      let picked = found;
      const rawPath = a["path"];
      if (rawPath) {
        const p = normPath(rawPath);
        const re = TS.globToRe(p);
        const exact = picked.filter((f) => f.path === p);
        if (exact.length) picked = exact;
        else if (re) picked = picked.filter((f) => re.test(f.path));
        else picked = picked.filter((f) => f.path.indexOf(p) >= 0);
      }
      if (!picked.length) {
        return { ok: true, files: [], totalMatches: 0, note: "没有匹配的文件（先 list_files 看工作区里有什么）" };
      }
      const max = Math.max(
        1,
        Math.min(TS.LIMITS.SEARCH_HARD_MAX, parseInt(strOf(a["max_results"]), 10) || TS.LIMITS.SEARCH_DEF_MAX)
      );
      const ctx = a["context"] == null ? TS.LIMITS.SEARCH_CTX_DEF : a["context"];
      let remaining = max;
      const blocks: SearchBlock[] = [];
      let total = 0;
      let degraded: string | null = null;
      let scanned = 0;
      let perFileTruncated = false;

      const step = (i: number): Promise<void> => {
        if (i >= picked.length || remaining <= 0) return Promise.resolve();
        const f = picked[i];
        return read(f.path)
          .then((r) => {
            if (!r) return;
            scanned++;
            const res = TS.searchText(r.content, {
              pattern,
              regex: !!a["regex"],
              ignore_case: !!a["ignore_case"],
              context: ctx,
              max_results: remaining,
            });
            if (res.degraded && !degraded) degraded = f.path + "：" + res.degraded;
            total += res.total;
            if (res.matches.length) {
              const blk: SearchBlock = {
                path: f.path,
                totalLines: res.totalLines,
                matchCount: res.total,
                matches: res.matches,
              };
              if (res.truncated) {
                blk.truncated = true;
                perFileTruncated = true;
              }
              blocks.push(blk);
              remaining -= res.matches.length;
            }
          })
          .then(() => step(i + 1));
      };

      return step(0).then(() => {
        // Output budget matches the kernel's per-tool-result cap: past it the kernel would keep the
        // head and tail and cut the middle out, so trim by item here and say so.
        const fit = TS.fitBlocks(blocks, TS.LIMITS.SEARCH_OUT_BUDGET);
        const out: Record<string, unknown> = {
          ok: true,
          totalMatches: total,
          filesScanned: scanned,
          files: fit.blocks,
        };
        if (fit.truncated) {
          out["truncated"] = true;
          out["hint"] =
            "命中过多，输出已按预算（" + TS.LIMITS.SEARCH_OUT_BUDGET + " 字符）截断；请收窄 pattern 或加 path 限定文件。";
        } else if (perFileTruncated) {
          out["truncated"] = true;
          out["hint"] =
            "部分文件命中数超过返回上限（见各文件 matchCount）；收窄 pattern 或调大 max_results（上限 " +
            TS.LIMITS.SEARCH_HARD_MAX +
            "）。";
        } else if (remaining <= 0) {
          out["hint"] =
            "已达 max_results 上限（" + max + "）；收窄 pattern 或调大 max_results（上限 " + TS.LIMITS.SEARCH_HARD_MAX + "）。";
        }
        if (!total) {
          out["note"] =
            "没有命中（模式：" +
            (a["regex"] ? "正则" : "字面") +
            "）。换关键词、去掉大小写限制，或确认真的是这个文件。";
        } else {
          out["readHint"] = "读窗口：read_file(path, offset=命中行-" + (numOf(ctx) + 1) + ", limit=" + (numOf(ctx) * 2 + 10) + ")。";
        }
        if (degraded) out["degraded"] = degraded;
        return out;
      });
    });
  }

  function writeFile(args: unknown): Promise<unknown> {
    const a = recOf(args);
    return write(a["path"], a["content"]).then((r) => {
      if (!r.ok) return r;
      return {
        ok: true,
        path: r.path,
        bytes: r.bytes,
        note: "已写入工作区,可用 read_file 读回或 export_file 导出到磁盘",
      };
    });
  }

  function editFile(args: unknown): Promise<unknown> {
    const a = recOf(args);
    return read(a["path"]).then((r): unknown => {
      if (!r) return { ok: false, error: "文件不存在: " + normPath(a["path"]) };
      const oldS = strOf(a["old_string"]);
      if (!oldS) return { ok: false, error: "old_string 不能为空" };
      const cnt = r.content.split(oldS).length - 1;
      if (cnt === 0) return { ok: false, error: "没找到 old_string(注意空格/换行要完全一致)" };
      if (cnt > 1 && a["replace_all"] !== true) {
        return {
          ok: false,
          error:
            "old_string 在文件里出现了 " +
            cnt +
            " 次,不唯一。请把上下文补足让它唯一,或传 replace_all:true；也可以先用 search_file 看各处命中行号再补足上下文。",
        };
      }
      const next =
        a["replace_all"] === true
          ? r.content.split(oldS).join(strOf(a["new_string"]))
          : r.content.replace(oldS, strOf(a["new_string"]));
      return writeInternal(a["path"], next, "edit").then((w): unknown => {
        if (w.ok === false) return w;
        return { ok: true, path: w.path, replaced: cnt, bytes: w.bytes };
      });
    });
  }

  function deleteFile(args: unknown): Promise<unknown> {
    const a = recOf(args);
    return remove(a["path"]).then((r) => (r.ok ? { ok: true, path: r.path, note: "已删除" } : r));
  }

  /**
   * Export a workspace file to the real disk. The browser-side split (Tauri dialog on desktop,
   * download on the web) belongs to the wiring layer, which reports a cancelled save as a failure
   * rather than a success.
   */
  function exportFile(args: unknown): Promise<unknown> {
    const a = recOf(args);
    return read(a["path"]).then((r): ExportOutcome | Promise<ExportOutcome> => {
      if (!r) return { ok: false, error: "文件不存在: " + normPath(a["path"]) };
      const fallback = r.path.split("/").pop() || "file.txt";
      const name = strOf(a["filename"]) || fallback;
      return ports.exportFile(name, r.content);
    });
  }

  const DEFS: ToolDef[] = [
    {
      name: "list_files",
      description: "列出当前会话工作区里的文件(路径 / 大小 / 最后修改时间)。工作区存于统一存储,按会话隔离。",
      parameters: { type: "object", properties: {} },
      run: () => listFiles(),
    },
    {
      name: "read_file",
      description:
        "读取工作区文件（**按行分页**）。默认返回前 400 行；文件更长时结果里带 totalLines 与 nextOffset，" +
        "继续读就把 offset 传成 nextOffset。要找内容先用 search_file（先搜后读，比整读省得多，也不会被截断挖掉中段）。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "工作区内的文件路径,如 report.md / src/app.js" },
          offset: { type: "integer", description: "起始行号（1 起，默认 1）" },
          limit: { type: "integer", description: "最多返回多少行（默认 400，上限 2000）" },
        },
        required: ["path"],
      },
      run: (args) => readFile(args),
    },
    {
      name: "search_file",
      description:
        "在工作区文件里检索（grep 语义）：返回命中**行号 + 上下文**。" +
        "默认**字面**匹配（快、零误报）；regex:true 才按正则解释 pattern（带长度上限与嵌套量词拒绝，防回溯炸弹）。" +
        "用法：大文件先 search 定位 → read_file(path, offset=命中行-15, limit=40) 读窗口；不要整读大文件。",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "要找的内容（默认字面文本；regex:true 时为正则）" },
          path: { type: "string", description: "可选：只搜某个文件（精确路径、glob 如 *.md / src/*，或路径片段）" },
          regex: { type: "boolean", description: "true=按正则解释 pattern（默认 false=字面）" },
          ignore_case: { type: "boolean", description: "忽略大小写" },
          context: { type: "integer", description: "每个命中的上下文行数（默认 2，上限 10；0=不要上下文）" },
          max_results: { type: "integer", description: "最多返回多少条命中（默认 30，上限 100）" },
        },
        required: ["pattern"],
      },
      run: (args) => searchFile(args),
    },
    {
      name: "write_file",
      description:
        "把内容写入当前会话工作区(统一存储,真持久化,可被 read_file 立刻读回)。" +
        "适合产出报告/代码/数据,或作为多步任务的中间产物。要导出到真实磁盘用 export_file。",
      destructive: true,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "工作区内的文件路径,如 report.md / src/app.js" },
          content: { type: "string", description: "文件内容(UTF-8 文本)" },
        },
        required: ["path", "content"],
      },
      run: (args) => writeFile(args),
    },
    {
      name: "edit_file",
      description:
        "在工作区文件里做精确替换(把 old_string 换成 new_string)。old_string 必须在文件里唯一出现,否则报错让你补足上下文。是最常用的「改文件」工具。",
      destructive: true,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "工作区内的文件路径" },
          old_string: { type: "string", description: "要被替换的原文(需在文件中唯一)" },
          new_string: { type: "string", description: "替换成的新内容" },
          replace_all: { type: "boolean", description: "true = 替换全部出现(默认 false,要求唯一)" },
        },
        required: ["path", "old_string", "new_string"],
      },
      run: (args) => editFile(args),
    },
    {
      name: "delete_file",
      description: "从工作区删除一个文件。",
      destructive: true,
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "工作区内的文件路径" } },
        required: ["path"],
      },
      run: (args) => deleteFile(args),
    },
    {
      name: "export_file",
      description:
        "把工作区文件导出到**真实磁盘**(桌面端弹保存对话框,网页端触发下载)。要落盘给用户时才用;" +
        "只是产出中间文件请用 write_file(写工作区,不需要用户干预)。",
      destructive: true,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "工作区内要导出的文件路径" },
          filename: { type: "string", description: "另存为的文件名(默认用 path 的文件名)" },
        },
        required: ["path"],
      },
      run: (args) => exportFile(args),
    },
  ];

  /** Register every file tool. One failure is contained: the rest still register. */
  function defineTools(registry: ToolRegistryPort | null): void {
    if (!registry || typeof registry.define !== "function") return;
    for (const def of DEFS) {
      try {
        registry.define(def);
      } catch (e) {
        ports.onToolError(def.name, e);
      }
    }
  }

  return {
    list,
    read,
    write,
    remove,
    removeByConv,
    clearAll,
    history,
    readVersion,
    restore,
    defineTools,
    convId,
  };
}

export type Workspace = ReturnType<typeof createWorkspace>;
