/**
 * ZIP backup and restore over the unified SQLite store.
 *
 * The contract in one paragraph: export dumps every owned table into one ZIP, `session_events`
 * included; import replaces the local tables wholesale, then rebuilds the `messages` / `summaries`
 * projections from the event truth with `sessionEventsSvc.replay()` — the backup's own projection
 * files are never trusted as the answer. An import that fails anywhere restores an in-memory copy
 * of the pre-import rows, so a rejected archive leaves the device exactly as it was.
 *
 * Why full replacement and not a merge: two event logs cannot be merged without deciding whose
 * seq space wins, and a silent merge is how duplicate conversations appear. The user chose "restore
 * this backup"; the honest behaviour is to make the device equal the backup, and to say so before
 * starting (the card asks for confirmation).
 *
 * Transaction shape: `DbPort.transaction` is collect-then-commit (D1 has no interactive
 * transactions), and one request is capped at 200 statements. A whole database therefore cannot be
 * one atomic statement batch; the import uses bounded multi-row inserts per transaction and keeps an
 * in-memory undo image. A crash *between* those transactions can leave a partial database — the
 * archive is still on disk and a re-import is idempotent, which is the documented recovery path.
 *
 * Not included on purpose: API keys, `cfw_*` settings (localStorage, never touched) and sync
 * cursors. `native_kv` is opt-in and even then secret-looking namespaces are filtered out.
 *
 * Gates are refusals, not truncation: a table over 500 000 rows or a 200 MB table file stops the
 * operation with a message; silently dropping half a backup would be worse than failing.
 *
 * Boundary: no DOM, no localStorage, no fetch. Storage arrives as `DbPort`, ZIP as the two core
 * readers/writers, replay as the session-events service, user-visible refusals as the `alert` port.
 * @module services/data/backup
 */

import type { DbPort, DbRow } from "../../core/db";

/** Separate emit products bridged on globalThis by the emitter; declared instead of imported. */
declare const dbWire: Pick<typeof import("../../core/db"), "encodeRow" | "decodeRow">;

/** The archive format tag written into `manifest.json`. */
export const BACKUP_FORMAT = "ownchat-backup";
/** Schema version of the archive's own layout (not the SQLite migration number). */
export const BACKUP_VERSION = 1;

type BackupPhase =
  | "count"
  | "dump"
  | "write"
  | "read"
  | "validate"
  | "snapshot"
  | "clear"
  | "insert"
  | "rebuild"
  | "rollback"
  | "done";

export interface BackupProgress {
  phase: BackupPhase;
  table?: string;
  done?: number;
  total?: number;
}

export type BackupProgressFn = (progress: BackupProgress) => void;

/** One archive entry as auctioned by `lib/zip-read`; only what this service reads is declared. */
export interface BackupZipEntryLike {
  name: string;
  size: number;
  data: Uint8Array | null;
}

export interface BackupZipReadPort {
  readZip(input: unknown, opts?: unknown): Promise<{ entries: BackupZipEntryLike[]; warnings?: unknown[] }>;
}

export interface BackupZipWritePort {
  writeZip(entries: unknown, opts?: unknown): Promise<Uint8Array>;
}

/** The slice of `sessionEventsSvc` the rebuild needs. `replay` derives and rewrites in one go. */
export interface BackupSessionEventsPort {
  replay(convId: string): Promise<{ ok: boolean; messages?: number; repaired?: number; error?: string }>;
}

export interface BackupPorts {
  /** Late-bound: the facade may pick its adapter after this script loads. */
  db(): DbPort;
  zipRead(): BackupZipReadPort | Promise<BackupZipReadPort>;
  zipWrite(): BackupZipWritePort | Promise<BackupZipWritePort>;
  /** Late-bound event truth; missing means "cannot rebuild the projection" (import refuses). */
  sessionEvents(): BackupSessionEventsPort | null | undefined;
  /** Optional user-visible refusal channel (the card renders its own status too). */
  alert?(message: string, level?: string): void;
  now?(): number;
}

export interface BackupLimits {
  /** Per-table row cap. Above this the operation refuses; it never truncates. */
  maxTableRows: number;
  /** Per-table uncompressed JSON cap. */
  maxTableBytes: number;
}

export interface BackupExportOptions {
  /** Include `native_kv` rows whose namespace does not look secret. Default false. */
  includeNativeKv?: boolean;
  /** Free-form tag recorded in the manifest (e.g. "pre-merge"). */
  reason?: string;
  onProgress?: BackupProgressFn;
  /** Test/tuning override; production defaults below. */
  limits?: unknown;
}

export interface BackupImportOptions {
  /** ZIP bytes (`Uint8Array` / `ArrayBuffer`). */
  bytes?: unknown;
  onProgress?: BackupProgressFn;
  /** Test/tuning override; production defaults below. */
  limits?: unknown;
}

export interface BackupTableCounts {
  [table: string]: number;
}

export interface BackupExportOk {
  ok: true;
  filename: string;
  createdAt: string;
  /** The finished archive; the wiring saves it, the service never touches the DOM. */
  archive: Uint8Array;
  size: number;
  tables: BackupTableCounts;
  rows: number;
  nativeKv: boolean;
  warnings: string[];
}

export interface BackupExportFail {
  ok: false;
  code: string;
  error: string;
}

export type BackupExportResult = BackupExportOk | BackupExportFail;

export interface BackupImportOk {
  ok: true;
  createdAt: string;
  tables: BackupTableCounts;
  rows: number;
  rebuilt: { conversations: number; messages: number; repaired: number };
  legacy: { conversations: number; messages: number };
  warnings: string[];
}

export interface BackupImportFail {
  ok: false;
  code: string;
  error: string;
  /** True when the pre-import rows were restored; false only if the restore itself failed. */
  rolledBack: boolean;
}

export type BackupImportResult = BackupImportOk | BackupImportFail;

export interface BackupSnapshotOk {
  ok: true;
  tables: BackupTableCounts;
  rows: number;
  missing: string[];
}

export interface BackupSnapshotFail {
  ok: false;
  code: string;
  error: string;
}

export type BackupSnapshotResult = BackupSnapshotOk | BackupSnapshotFail;

export interface BackupApi {
  v: 1;
  exportAll(options?: BackupExportOptions): Promise<BackupExportResult>;
  importAll(options?: BackupImportOptions): Promise<BackupImportResult>;
  snapshot(): Promise<BackupSnapshotResult>;
}

const DEFAULT_LIMITS: BackupLimits = {
  maxTableRows: 500000,
  maxTableBytes: 200 * 1024 * 1024,
};

/**
 * One statement may carry at most 256 bindings on the Worker route, but Cloudflare D1 itself caps
 * a query at 100 bound parameters — the strictest runtime wins, or a backup that works on the Node
 * sidecar fails on the deployed Worker.
 */
const MAX_PARAMS = 100;
/** One `/api/data/tx` carries at most 200 statements; 120 leaves headroom for the clear batch. */
const MAX_STATEMENTS_PER_TX = 120;
/** Keep one INSERT statement's payload small (a 2 MB attachment becomes ~2.7 MB of base64). */
const MAX_STATEMENT_BYTES = 4 * 1024 * 1024;
/** Keep one transaction's request body well under the Workers/D1 request ceiling. */
const MAX_TX_BYTES = 8 * 1024 * 1024;
/** Rows read per SELECT page. */
const PAGE_ROWS = 2000;
/** ZIP entries: manifest + the tables below. */
const MAX_ENTRIES = 64;

interface BackupTableSpec {
  name: string;
  /** Plain column names; `sqlIdent` quotes the reserved ones for both SELECT and INSERT. */
  columns: readonly string[];
  /** Deterministic page order (raw SQL expressions, constants only). */
  order: readonly string[];
  /** Only dumped when explicitly requested (native_kv) and preserved otherwise. */
  optional?: boolean;
  /** Projection of the event log: exported, but not trusted on import. */
  projection?: boolean;
  /** Columns allowed to carry the `{__b64}` wire shape. */
  blobs?: readonly string[];
}

/**
 * The owned tables. Insert order matters: `session_events` first (the truth), parents before
 * children (`kb_docs` before `kb_chunks`), and the two projections last (legacy rows only).
 */
const TABLES: readonly BackupTableSpec[] = [
  {
    name: "session_events",
    columns: ["id", "conv_id", "seq", "type", "payload", "ts"],
    order: ["conv_id ASC", "seq ASC"],
  },
  {
    name: "chars",
    columns: ["id", "name", "data"],
    order: ["id ASC"],
  },
  {
    name: "epi",
    columns: ["id", "cid", "what", "kind", "fact_type", "fact_kind", "entities", "terms", "ts", "when", "where", "who", "why", "scene", "vec"],
    order: ["cid ASC", "ts ASC", "id ASC"],
  },
  {
    name: "kb_docs",
    columns: ["id", "cid", "title", "size", "chars", "ts"],
    order: ["cid ASC", "id ASC"],
  },
  {
    name: "kb_chunks",
    columns: ["id", "doc_id", "cid", "chunk", "offset", "ord"],
    order: ["doc_id ASC", "ord ASC", "id ASC"],
  },
  {
    name: "entities",
    columns: ["cid", "name", "kind", "ref_id"],
    order: ["cid ASC", "name ASC", "kind ASC", "ref_id ASC"],
  },
  {
    name: "char_kv",
    columns: ["cid", "key", "value", "ts"],
    order: ["cid ASC", "key ASC"],
  },
  {
    name: "workspace",
    columns: ["path", "cid", "content", "lines", "ts"],
    order: ["path ASC"],
  },
  {
    name: "workspace_versions",
    columns: ["id", "scope_key", "conv_id", "path", "seq", "ts", "kind", "hash", "bytes", "lines", "prev_hash", "from_version"],
    order: ["scope_key ASC", "seq ASC", "id ASC"],
  },
  {
    name: "workspace_blobs",
    columns: ["id", "conv_id", "hash", "content", "bytes"],
    order: ["conv_id ASC", "hash ASC", "id ASC"],
  },
  {
    name: "attachments",
    columns: ["id", "name", "mime", "size", "body", "text", "ts"],
    order: ["id ASC"],
    blobs: ["body"],
  },
  {
    name: "gallery",
    columns: ["url", "source", "ts"],
    order: ["url ASC"],
  },
  {
    name: "native_kv",
    columns: ["namespace", "key", "value", "updated_at"],
    order: ["namespace ASC", "key ASC"],
    optional: true,
  },
  {
    name: "messages",
    columns: ["id", "conv_id", "seq", "role", "content", "tool_calls", "tool_call_id", "reasoning_content", "sc", "speaker_name", "ts"],
    order: ["conv_id ASC", "seq ASC"],
    projection: true,
  },
  {
    name: "summaries",
    columns: ["conv_id", "text", "ts"],
    order: ["conv_id ASC"],
    projection: true,
  },
];

/** Reserved words this schema actually uses as column names. */
const RESERVED_IDENTS: Record<string, 1> = {
  key: 1, when: 1, where: 1, offset: 1, order: 1, group: 1, values: 1, index: 1,
};

/** `key` → `"key"`; everything else passes through. Constants only — never user text. */
function sqlIdent(name: string): string {
  return Object.prototype.hasOwnProperty.call(RESERVED_IDENTS, name) ? '"' + name + '"' : name;
}

function selectList(spec: BackupTableSpec): string {
  return spec.columns.map(sqlIdent).join(", ");
}

function insertHead(spec: BackupTableSpec): string {
  return "INSERT INTO " + spec.name + " (" + spec.columns.map(sqlIdent).join(", ") + ") VALUES ";
}

function specOf(name: string): BackupTableSpec | null {
  for (let i = 0; i < TABLES.length; i++) if (TABLES[i].name === name) return TABLES[i];
  return null;
}

/* ── small value bridges (no assertions) ─────────────────────────────────────────────── */

function recOf(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
  const entries = Object.entries(value);
  for (let i = 0; i < entries.length; i++) {
    const key = entries[i][0];
    // Archive JSON is untrusted: a `__proto__` own key must not become this object's prototype
    // (the row validators reject the key anyway; this keeps option/manifest reads honest).
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    out[key] = entries[i][1];
  }
  return out;
}

function strOf(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function numOf(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function errText(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  const msg = recOf(e)["message"];
  if (typeof msg === "string" && msg) return msg;
  return String(e);
}

function codeOf(e: unknown): string {
  const code = recOf(e)["code"];
  return typeof code === "string" && code ? code : "BACKUP_FAILED";
}

function backupError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code: code });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function mergeLimits(raw: unknown): BackupLimits {
  const o = recOf(raw);
  return {
    maxTableRows: numOf(o["maxTableRows"], DEFAULT_LIMITS.maxTableRows),
    maxTableBytes: numOf(o["maxTableBytes"], DEFAULT_LIMITS.maxTableBytes),
  };
}

function emitProgress(fn: BackupProgressFn | undefined, progress: BackupProgress): void {
  if (typeof fn !== "function") return;
  try {
    fn(progress);
  } catch (e) {
    // A broken progress listener must not abort a backup.
  }
}

/** Narrow an unknown option to the progress callback without a type assertion. */
function progressOf(value: unknown): BackupProgressFn | undefined {
  if (typeof value !== "function") return undefined;
  return function (progress: BackupProgress): void {
    value(progress);
  };
}

/** `ownchat-backup-YYYY-MM-DD.zip` in local time; the same day twice just overwrites. */
export function backupFilename(nowMs: number): string {
  const d = new Date(nowMs);
  const year = Number.isFinite(d.getFullYear()) ? d.getFullYear() : 1970;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return "ownchat-backup-" + year + "-" + mm + "-" + dd + ".zip";
}

/** Namespaces/keys that look like secrets, settings or sync cursors are never exported, even opt-in. */
const SECRET_WORD_RE = /(?:^|[._-])(key|keys|secret|token|auth|cred|credential|password|passwd|cursor|session)(?:$|[._-])/i;
const SETTINGS_NAMESPACE_RE = /^(?:cfw|ownchat[-_.]?settings|settings|sync|storage)(?:$|[._-])/i;

function isSecretNamespace(namespace: string): boolean {
  return SETTINGS_NAMESPACE_RE.test(namespace) || SECRET_WORD_RE.test(namespace) || /api[_-]?key/i.test(namespace);
}

/** A native_kv row is skipped when either half looks secret: the platform may keep a secret under
 *  a generic namespace, or a harmless name under a settings namespace. */
function isSecretKv(namespace: string, key: string): boolean {
  return isSecretNamespace(namespace) || SECRET_WORD_RE.test(key) || /(?:api|secret|access|private)[_-]?key|authorization/i.test(key);
}

/** Rows of one table, encoded for JSON (`{__b64}` for bytes), paged and capped. */
async function dumpTable(
  port: DbPort,
  spec: BackupTableSpec,
  limits: BackupLimits,
  onProgress: BackupProgressFn | undefined,
  phase: BackupPhase,
): Promise<DbRow[]> {
  const rows: DbRow[] = [];
  const sql =
    "SELECT " + selectList(spec) + " FROM " + spec.name +
    " ORDER BY " + spec.order.join(", ") +
    " LIMIT " + PAGE_ROWS + " OFFSET ?";
  for (let offset = 0; ; offset += PAGE_ROWS) {
    let page: DbRow[];
    try {
      const res = await port.exec(sql, [offset]);
      page = Array.isArray(res.rows) ? res.rows : [];
    } catch (e) {
      throw backupError("TABLE_UNREADABLE", "读取表 " + spec.name + " 失败：" + errText(e));
    }
    for (let i = 0; i < page.length; i++) rows.push(dbWire.encodeRow(page[i]));
    if (rows.length > limits.maxTableRows) {
      throw backupError(
        "TABLE_TOO_MANY_ROWS",
        "表 " + spec.name + " 超过 " + limits.maxTableRows + " 行，备份已拒绝（不做截断）。请先清理或分批导出。",
      );
    }
    emitProgress(onProgress, { phase: phase, table: spec.name, done: rows.length });
    if (page.length < PAGE_ROWS) break;
  }
  return rows;
}

async function countRows(port: DbPort, table: string): Promise<number> {
  try {
    const res = await port.exec("SELECT COUNT(*) AS n FROM " + table, []);
    const row = recOf((res.rows || [])[0]);
    return numOf(row["n"], 0);
  } catch (e) {
    throw backupError("TABLE_UNREADABLE", "读取表 " + table + " 失败：" + errText(e));
  }
}

/** Validate one decoded JSON row against the table spec. Strict: unknown/missing keys are errors. */
function validateRow(spec: BackupTableSpec, row: unknown, index: number): void {
  if (!isPlainObject(row)) {
    throw backupError("BAD_ROW", "表 " + spec.name + " 第 " + (index + 1) + " 行不是对象");
  }
  const keys = Object.keys(row);
  for (let i = 0; i < keys.length; i++) {
    if (spec.columns.indexOf(keys[i]) < 0) {
      throw backupError("BAD_ROW", "表 " + spec.name + " 第 " + (index + 1) + " 行含未知列 " + keys[i]);
    }
  }
  for (let c = 0; c < spec.columns.length; c++) {
    const col = spec.columns[c];
    if (!Object.prototype.hasOwnProperty.call(row, col)) {
      throw backupError("BAD_ROW", "表 " + spec.name + " 第 " + (index + 1) + " 行缺少列 " + col);
    }
    const value = row[col];
    if (value === null) continue;
    const blob = spec.blobs !== undefined && spec.blobs.indexOf(col) >= 0;
    if (blob) {
      const obj = recOf(value);
      if (!isPlainObject(value) || typeof obj["__b64"] !== "string" || Object.keys(obj).length !== 1) {
        throw backupError("BAD_ROW", "表 " + spec.name + " 第 " + (index + 1) + " 行的二进制列 " + col + " 不是 {__b64} 形态");
      }
      continue;
    }
    if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) continue;
    throw backupError("BAD_ROW", "表 " + spec.name + " 第 " + (index + 1) + " 行的列 " + col + " 不是标量");
  }
}

/** Values of one row in column order, decoded from the wire shape. */
function rowParams(spec: BackupTableSpec, row: Record<string, unknown>): unknown[] {
  const decoded = dbWire.decodeRow(row);
  const out: unknown[] = [];
  for (let c = 0; c < spec.columns.length; c++) out.push(decoded[spec.columns[c]]);
  return out;
}

/** Conservative wire-size estimate for one row's bindings (UTF-8 ×3 per UTF-16 unit, base64 ×4/3). */
function paramsBytes(params: readonly unknown[]): number {
  let total = 0;
  for (let i = 0; i < params.length; i++) {
    const value = params[i];
    if (typeof value === "string") total += value.length * 3 + 8;
    else if (value instanceof Uint8Array) total += Math.ceil((value.length * 4) / 3) + 16;
    else total += 24;
  }
  return total;
}

/**
 * Bounded multi-row inserts: ≤100 bindings per statement (D1's cap), ≤4 MB per statement and
 * ≤8 MB per transaction, ≤120 statements per transaction. A single oversized row still goes out
 * alone (the caps gate the *groups*, never the row) — the 500 000-row / 200 MB gates bound the
 * archive long before a row can be too large.
 */
async function insertRows(
  port: DbPort,
  spec: BackupTableSpec,
  rows: readonly Record<string, unknown>[],
  onProgress: BackupProgressFn | undefined,
  phase: BackupPhase,
): Promise<void> {
  if (!rows.length) return;
  const perRow = spec.columns.length;
  const maxRowsPerStmt = Math.max(1, Math.floor(MAX_PARAMS / perRow));
  const placeholders = "(" + new Array(perRow).fill("?").join(",") + ")";
  const head = insertHead(spec);
  let values: string[] = [];
  let params: unknown[] = [];
  let stmtBytes = 0;
  let statements: Array<{ sql: string; params: unknown[] }> = [];
  let txBytes = 0;
  let written = 0;

  async function flushStatements(): Promise<void> {
    if (!statements.length) return;
    const batch = statements;
    statements = [];
    txBytes = 0;
    try {
      await port.transaction(function (tx) {
        for (let i = 0; i < batch.length; i++) tx.exec(batch[i].sql, batch[i].params);
      });
    } catch (e) {
      throw backupError("WRITE_FAILED", "写入表 " + spec.name + " 失败（约第 " + written + " 行）：" + errText(e));
    }
  }

  async function flushStatement(): Promise<void> {
    if (!values.length) return;
    statements.push({ sql: head + values.join(","), params: params });
    values = [];
    params = [];
    stmtBytes = 0;
    if (statements.length >= MAX_STATEMENTS_PER_TX || txBytes >= MAX_TX_BYTES) await flushStatements();
  }

  for (let i = 0; i < rows.length; i++) {
    const p = rowParams(spec, rows[i]);
    const bytes = paramsBytes(p);
    if (values.length >= maxRowsPerStmt || (values.length > 0 && stmtBytes + bytes > MAX_STATEMENT_BYTES)) {
      await flushStatement();
    }
    values.push(placeholders);
    for (let k = 0; k < p.length; k++) params.push(p[k]);
    stmtBytes += bytes;
    txBytes += bytes;
    written = i + 1;
    if (written === rows.length || written % 5000 === 0) {
      emitProgress(onProgress, { phase: phase, table: spec.name, done: written, total: rows.length });
    }
  }
  await flushStatement();
  await flushStatements();
  emitProgress(onProgress, { phase: phase, table: spec.name, done: written, total: rows.length });
}

async function clearTables(port: DbPort, specs: readonly BackupTableSpec[]): Promise<void> {
  await port.transaction(function (tx) {
    // Reverse order: children before parents (kb_chunks before kb_docs), the projection last.
    for (let i = specs.length - 1; i >= 0; i--) tx.exec("DELETE FROM " + specs[i].name, []);
  });
}

/** UTF-8 encode without depending on a text encoder being injected as a port. */
function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function parseJson(bytes: Uint8Array | null, label: string): unknown {
  if (!bytes) throw backupError("BAD_ENTRY", label + " 没有数据（不支持的压缩方法或无内容）");
  let text: string;
  try {
    text = decodeUtf8(bytes);
  } catch (e) {
    throw backupError("BAD_JSON", label + " 不是合法的 UTF-8 文本");
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw backupError("BAD_JSON", label + " 不是合法 JSON：" + errText(e));
  }
}

interface ParsedArchive {
  manifest: {
    format: string;
    version: number;
    createdAt: string;
    tables: BackupTableCounts;
  };
  /** Declared tables in TABLES order (insert order), already validated. */
  tables: Array<{ spec: BackupTableSpec; rows: DbRow[] }>;
  warnings: string[];
}

async function parseArchive(
  zip: BackupZipReadPort,
  bytes: unknown,
  limits: BackupLimits,
  onProgress: BackupProgressFn | undefined,
): Promise<ParsedArchive> {
  let result: { entries: BackupZipEntryLike[]; warnings?: unknown[] };
  try {
    result = await zip.readZip(bytes, {
      maxEntries: MAX_ENTRIES,
      maxSingle: limits.maxTableBytes,
      maxTotal: Math.min(0xffffffff, limits.maxTableBytes * TABLES.length),
      maxRatio: 100000,
    });
  } catch (e) {
    const code = codeOf(e);
    if (code === "ENTRY_TOO_LARGE" || code === "TOTAL_TOO_LARGE") {
      throw backupError("TABLE_TOO_LARGE", "备份内有表超过 " + limits.maxTableBytes + " 字节，已拒绝（不做截断）：" + errText(e));
    }
    throw backupError("BAD_ZIP", "读取备份 ZIP 失败：" + errText(e));
  }
  const entries = Array.isArray(result.entries) ? result.entries : [];
  // Null-prototype name maps: entry names and conv ids come from the archive, and `__proto__`
  // must stay an ordinary key (never this object's prototype).
  const byName: Record<string, BackupZipEntryLike> = Object.create(null);
  for (let i = 0; i < entries.length; i++) byName[entries[i].name] = entries[i];

  const manifestEntry = byName["manifest.json"];
  if (!manifestEntry) throw backupError("MANIFEST_MISSING", "备份里没有 manifest.json，不是 OwnChat 备份");
  const rawManifest = parseJson(manifestEntry.data, "manifest.json");
  if (!isPlainObject(rawManifest)) throw backupError("BAD_MANIFEST", "manifest.json 不是对象");

  const format = strOf(rawManifest["format"]);
  if (format !== BACKUP_FORMAT) {
    throw backupError("UNSUPPORTED_FORMAT", "这不是 OwnChat 备份（format=" + (format || "空") + "）");
  }
  const version = numOf(rawManifest["version"], 0);
  if (version !== BACKUP_VERSION) {
    throw backupError(
      "UNSUPPORTED_VERSION",
      "备份格式版本 " + version + " 不受支持（本版本只认 " + BACKUP_VERSION + "）；请升级后再导入。",
    );
  }
  const manifestTables = recOf(rawManifest["tables"]);
  const declaredNames = Object.keys(manifestTables);
  if (!declaredNames.length) throw backupError("BAD_MANIFEST", "manifest.json 的 tables 为空");

  const declared: Record<string, number> = {};
  for (let i = 0; i < declaredNames.length; i++) {
    const name = declaredNames[i];
    const spec = specOf(name);
    if (!spec) {
      throw backupError("UNKNOWN_TABLE", "备份包含本版本不认识的表 " + name + "，导入会丢数据；已拒绝。");
    }
    const count = numOf(manifestTables[name], -1);
    if (count < 0) throw backupError("BAD_MANIFEST", "manifest 里表 " + name + " 的行数无效");
    if (count > limits.maxTableRows) {
      throw backupError(
        "TABLE_TOO_MANY_ROWS",
        "备份里表 " + name + " 有 " + count + " 行，超过 " + limits.maxTableRows + " 行上限，已拒绝（不做截断）。",
      );
    }
    declared[name] = count;
  }
  for (let i = 0; i < TABLES.length; i++) {
    const spec = TABLES[i];
    if (spec.optional) continue;
    if (!Object.prototype.hasOwnProperty.call(declared, spec.name)) {
      throw backupError("MISSING_TABLE", "备份缺少表 " + spec.name + "，不是完整的备份");
    }
  }

  // Any table file the manifest did not declare is a schema mismatch, not something to ignore:
  // importing the rest would silently drop it.
  for (let i = 0; i < entries.length; i++) {
    const name = entries[i].name;
    if (name.indexOf("tables/") !== 0 || name.slice(-5) !== ".json") continue;
    const table = name.slice("tables/".length, -5);
    if (!Object.prototype.hasOwnProperty.call(declared, table)) {
      throw backupError("UNDECLARED_TABLE", "备份里有未在 manifest 声明的表文件 " + name + "；已拒绝以免静默丢数据。");
    }
  }

  const warnings: string[] = [];
  const archiveWarnings = Array.isArray(result.warnings) ? result.warnings : [];
  for (let i = 0; i < archiveWarnings.length; i++) {
    const w = recOf(archiveWarnings[i]);
    warnings.push("ZIP 警告 " + strOf(w["code"]) + (w["name"] ? "：" + strOf(w["name"]) : ""));
  }

  const tables: Array<{ spec: BackupTableSpec; rows: DbRow[] }> = [];
  let validated = 0;
  for (let i = 0; i < TABLES.length; i++) {
    const spec = TABLES[i];
    if (!Object.prototype.hasOwnProperty.call(declared, spec.name)) continue;
    const entry = byName["tables/" + spec.name + ".json"];
    if (!entry) throw backupError("MISSING_TABLE", "备份缺少表文件 tables/" + spec.name + ".json");
    if (entry.size > limits.maxTableBytes) {
      throw backupError("TABLE_TOO_LARGE", "表 " + spec.name + " 的解压大小超过 " + limits.maxTableBytes + " 字节，已拒绝。");
    }
    const parsed = parseJson(entry.data, "tables/" + spec.name + ".json");
    if (!Array.isArray(parsed)) throw backupError("BAD_JSON", "表 " + spec.name + " 的文件不是数组");
    if (parsed.length !== declared[spec.name]) {
      throw backupError(
        "COUNT_MISMATCH",
        "表 " + spec.name + " 实际 " + parsed.length + " 行，manifest 声明 " + declared[spec.name] + " 行",
      );
    }
    const rows: DbRow[] = [];
    for (let k = 0; k < parsed.length; k++) {
      validateRow(spec, parsed[k], k);
      rows.push(recOf(parsed[k]));
    }
    tables.push({ spec: spec, rows: rows });
    validated++;
    emitProgress(onProgress, { phase: "validate", table: spec.name, done: validated, total: declaredNames.length });
  }
  return {
    manifest: {
      format: format,
      version: version,
      createdAt: strOf(rawManifest["createdAt"]),
      tables: declared,
    },
    tables: tables,
    warnings: warnings,
  };
}

/** Build the service. One instance per page; the wiring publishes it as `window.backupSvc`. */
export function createBackupService(ports: BackupPorts): BackupApi {
  if (!ports || typeof ports.db !== "function") throw new Error("backup: db 端口是必需的");
  const now = typeof ports.now === "function" ? ports.now : function (): number { return Date.now(); };

  function notify(message: string, level?: string): void {
    if (typeof ports.alert !== "function") return;
    try {
      ports.alert(message, level);
    } catch (e) {
      // A broken toast port must not swallow the result object.
    }
  }

  function fail(code: string, error: string): BackupExportFail {
    notify(error, "error");
    return { ok: false, code: code, error: error };
  }

  async function exportAll(options?: BackupExportOptions): Promise<BackupExportResult> {
    const opts = recOf(options);
    const limits = mergeLimits(opts["limits"]);
    const includeNativeKv = opts["includeNativeKv"] === true;
    const reason = strOf(opts["reason"]);
    const onProgress = progressOf(opts["onProgress"]);
    const nowMs = now();
    const createdAt = new Date(nowMs).toISOString();
    try {
      const port = ports.db();
      const entries: Array<{ name: string; data: Uint8Array }> = [];
      const counts: BackupTableCounts = {};
      const warnings: string[] = [];
      let totalRows = 0;

      for (let i = 0; i < TABLES.length; i++) {
        const spec = TABLES[i];
        if (spec.optional && !includeNativeKv) continue;
        const count = await countRows(port, spec.name);
        emitProgress(onProgress, { phase: "count", table: spec.name, done: 0, total: count });
        if (count > limits.maxTableRows) {
          return fail(
            "TABLE_TOO_MANY_ROWS",
            "表 " + spec.name + " 有 " + count + " 行，超过 " + limits.maxTableRows + " 行上限；备份已拒绝（不做截断）。",
          );
        }
        let rows = await dumpTable(port, spec, limits, onProgress, "dump");
        if (spec.name === "native_kv") {
          const kept = rows.filter(function (row) {
            return !isSecretKv(strOf(row["namespace"]), strOf(row["key"]));
          });
          if (kept.length !== rows.length) {
            warnings.push("native_kv 跳过 " + (rows.length - kept.length) + " 行疑似密钥/设置/同步游标的记录");
          }
          rows = kept;
        }
        const json = JSON.stringify(rows);
        const bytes = utf8(json);
        if (bytes.length > limits.maxTableBytes) {
          return fail(
            "TABLE_TOO_LARGE",
            "表 " + spec.name + " 序列化后 " + bytes.length + " 字节，超过 " + limits.maxTableBytes + " 字节上限；备份已拒绝。",
          );
        }
        entries.push({ name: "tables/" + spec.name + ".json", data: bytes });
        counts[spec.name] = rows.length;
        totalRows += rows.length;
        emitProgress(onProgress, { phase: "dump", table: spec.name, done: rows.length, total: rows.length });
      }

      const manifest = {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        createdAt: createdAt,
        app: "OwnChat",
        reason: reason,
        nativeKv: includeNativeKv,
        tables: counts,
      };
      entries.unshift({ name: "manifest.json", data: utf8(JSON.stringify(manifest, null, 2)) });

      emitProgress(onProgress, { phase: "write", done: entries.length, total: entries.length });
      const writer = await ports.zipWrite();
      const archive = await writer.writeZip(entries, { deflate: true, date: nowMs });
      emitProgress(onProgress, { phase: "done", done: totalRows, total: totalRows });
      return {
        ok: true,
        filename: backupFilename(nowMs),
        createdAt: createdAt,
        archive: archive,
        size: archive.length,
        tables: counts,
        rows: totalRows,
        nativeKv: includeNativeKv,
        warnings: warnings,
      };
    } catch (e) {
      return fail(codeOf(e), errText(e));
    }
  }

  /** Undo image: encoded rows of every table the import will touch. */
  async function snapshotTables(
    port: DbPort,
    specs: readonly BackupTableSpec[],
    limits: BackupLimits,
    onProgress: BackupProgressFn | undefined,
  ): Promise<Record<string, DbRow[]>> {
    const out: Record<string, DbRow[]> = {};
    let done = 0;
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      const count = await countRows(port, spec.name);
      if (count > limits.maxTableRows) {
        throw backupError(
          "UNDO_TOO_LARGE",
          "本机表 " + spec.name + " 有 " + count + " 行，超过回滚快照上限 " + limits.maxTableRows +
          "；为避免导入失败后无法恢复，本次导入已拒绝。",
        );
      }
      out[spec.name] = await dumpTable(port, spec, limits, onProgress, "snapshot");
      done++;
      emitProgress(onProgress, { phase: "snapshot", table: spec.name, done: done, total: specs.length });
    }
    return out;
  }

  async function restore(
    port: DbPort,
    undo: Record<string, DbRow[]>,
    specs: readonly BackupTableSpec[],
    onProgress: BackupProgressFn | undefined,
  ): Promise<void> {
    emitProgress(onProgress, { phase: "rollback", done: 0, total: specs.length });
    await clearTables(port, specs);
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      const rows = undo[spec.name] || [];
      await insertRows(port, spec, rows, onProgress, "rollback");
      emitProgress(onProgress, { phase: "rollback", table: spec.name, done: i + 1, total: specs.length });
    }
  }

  async function importAll(options?: BackupImportOptions): Promise<BackupImportResult> {
    const opts = recOf(options);
    const limits = mergeLimits(opts["limits"]);
    const onProgress = progressOf(opts["onProgress"]);
    const bytes = opts["bytes"];

    let archive: ParsedArchive;
    try {
      const zip = await ports.zipRead();
      emitProgress(onProgress, { phase: "read" });
      archive = await parseArchive(zip, bytes, limits, onProgress);
    } catch (e) {
      return { ok: false, code: codeOf(e), error: errText(e), rolledBack: false };
    }

    const port = ports.db();
    const events = ports.sessionEvents();
    if (!events || typeof events.replay !== "function") {
      const error = "事件服务（sessionEventsSvc）未就绪：没有它就无法从事件真源重建消息投影，导入已拒绝。";
      notify(error, "error");
      return { ok: false, code: "EVENTS_UNAVAILABLE", error: error, rolledBack: true };
    }

    const declared: Record<string, 1> = {};
    for (let i = 0; i < archive.tables.length; i++) declared[archive.tables[i].spec.name] = 1;
    const touched: BackupTableSpec[] = [];
    for (let i = 0; i < TABLES.length; i++) {
      const spec = TABLES[i];
      if (spec.optional && !Object.prototype.hasOwnProperty.call(declared, spec.name)) continue;
      touched.push(spec);
    }

    let undo: Record<string, DbRow[]>;
    try {
      undo = await snapshotTables(port, touched, limits, onProgress);
    } catch (e) {
      return { ok: false, code: codeOf(e), error: errText(e), rolledBack: true };
    }

    try {
      // Event-backed conversations: every conv id present in the imported event log.
      const eventRows = archive.tables.find(function (t) { return t.spec.name === "session_events"; });
      const eventConvs: Record<string, 1> = Object.create(null);
      let rows = 0;
      if (eventRows) {
        rows += eventRows.rows.length;
        for (let i = 0; i < eventRows.rows.length; i++) {
          const conv = strOf(eventRows.rows[i]["conv_id"]);
          if (conv) eventConvs[conv] = 1;
        }
      }
      for (let i = 0; i < archive.tables.length; i++) {
        if (archive.tables[i].spec.name !== "session_events") rows += archive.tables[i].rows.length;
      }

      emitProgress(onProgress, { phase: "clear", done: 0, total: touched.length });
      await clearTables(port, touched);

      const legacyConvs: Record<string, 1> = Object.create(null);
      let legacyMessages = 0;
      let doneTables = 0;
      for (let i = 0; i < archive.tables.length; i++) {
        const item = archive.tables[i];
        const spec = item.spec;
        let tableRows: readonly Record<string, unknown>[] = item.rows;
        if (spec.projection) {
          // Do not trust the archive's projection: keep only rows whose conversation has no event
          // truth at all (pre-T3-D data). Everything else is rebuilt from events below.
          const kept: DbRow[] = [];
          for (let k = 0; k < tableRows.length; k++) {
            const conv = strOf(tableRows[k]["conv_id"]);
            if (conv && Object.prototype.hasOwnProperty.call(eventConvs, conv)) continue;
            kept.push(tableRows[k]);
            if (spec.name === "messages") legacyMessages++;
            if (conv) legacyConvs[conv] = 1;
          }
          tableRows = kept;
        }
        await insertRows(port, spec, tableRows, onProgress, "insert");
        doneTables++;
        emitProgress(onProgress, { phase: "insert", table: spec.name, done: doneTables, total: archive.tables.length });
      }

      const convs: string[] = Object.keys(eventConvs).sort();
      let rebuiltMessages = 0;
      let repaired = 0;
      for (let i = 0; i < convs.length; i++) {
        const out = await events.replay(convs[i]);
        if (!out || out.ok !== true) {
          throw backupError(
            "REBUILD_FAILED",
            "会话 " + convs[i] + " 的投影重建失败：" + (out && out.error ? out.error : "replay 未返回 ok"),
          );
        }
        rebuiltMessages += numOf(out.messages, 0);
        repaired += numOf(out.repaired, 0);
        emitProgress(onProgress, { phase: "rebuild", table: "messages", done: i + 1, total: convs.length });
      }

      const warnings = archive.warnings.slice();
      const legacyConvCount = Object.keys(legacyConvs).length;
      if (legacyConvCount > 0) {
        warnings.push(
          "有 " + legacyConvCount + " 个会话只有消息投影、没有事件真源（旧格式数据），已按备份里的投影保留。",
        );
      }
      emitProgress(onProgress, { phase: "done", done: rows, total: rows });
      return {
        ok: true,
        createdAt: archive.manifest.createdAt,
        tables: archive.manifest.tables,
        rows: rows,
        rebuilt: { conversations: convs.length, messages: rebuiltMessages, repaired: repaired },
        legacy: { conversations: legacyConvCount, messages: legacyMessages },
        warnings: warnings,
      };
    } catch (e) {
      const original = codeOf(e) + "：" + errText(e);
      try {
        await restore(port, undo, touched, onProgress);
      } catch (restoreError) {
        const error = original + "；回滚也失败：" + errText(restoreError) + "（本机数据可能不完整，请重新导入备份）";
        notify(error, "error");
        return { ok: false, code: "ROLLBACK_FAILED", error: error, rolledBack: false };
      }
      const error = original + "；已回滚到导入前的数据。";
      notify(error, "error");
      return { ok: false, code: codeOf(e), error: error, rolledBack: true };
    }
  }

  async function snapshot(): Promise<BackupSnapshotResult> {
    try {
      const port = ports.db();
      const counts: BackupTableCounts = {};
      const missing: string[] = [];
      let rows = 0;
      for (let i = 0; i < TABLES.length; i++) {
        const spec = TABLES[i];
        try {
          const count = await countRows(port, spec.name);
          counts[spec.name] = count;
          rows += count;
        } catch (e) {
          missing.push(spec.name);
          counts[spec.name] = 0;
        }
      }
      return { ok: true, tables: counts, rows: rows, missing: missing };
    } catch (e) {
      return { ok: false, code: codeOf(e), error: errText(e) };
    }
  }

  return { v: 1, exportAll: exportAll, importAll: importAll, snapshot: snapshot };
}
