/**
 * DbPort: the one storage seam shared by all three runtimes (D1 over HTTP, the Node sidecar over
 * HTTP, the Tauri shell over rusqlite), plus the single wire shape binary values travel in.
 *
 * Why the port is this small: D1 has no interactive transactions, only `batch()`. `transaction`
 * therefore collects statements from the callback and commits them once — the only shape all three
 * runtimes can honour. Reads inside a transaction are deliberately not supported by the contract;
 * scope any read before the call. A caller that needs a read and a write does the read first.
 *
 * Value domain: JSON scalars, null and Uint8Array. Binary values travel as `{__b64:"<base64>"}`;
 * every adapter translates the wire form at its own boundary, so service code never sees it. Three
 * normalisations keep the runtimes answering identically instead of "works on D1, throws on SQLite":
 * booleans become 0/1 (node:sqlite refuses booleans, D1 accepts them), `undefined` becomes NULL, and
 * objects/arrays are rejected with a message pointing at JSON serialisation (no adapter may guess).
 *
 * Boundary: types plus the codec. No DOM, no I/O, no storage. The codec is deliberately the same
 * arithmetic as `src/data-api.js`, the server side of the same wire; `test/db-wire.test.mjs`
 * compares both implementations byte for byte so the pair cannot drift.
 * @module core/db
 */

/** One result row. Keys are column names; values are JSON scalars, null or Uint8Array. */
export interface DbRow {
  [key: string]: unknown;
}

/** Rows only. Writes answer `{rows:[]}`, matching `src/data-api.js`'s exec response. */
export interface DbResult {
  rows: DbRow[];
}

/** The three FTS5 surfaces the schema materialises. There is no fourth: scope decides the join. */
export type SearchSurface = "messages" | "memory" | "kb";

/** Scope is per surface: `conv` for messages, `cid` for memory and kb. A missing key is an error. */
export interface SearchScope {
  conv?: string;
  cid?: string;
}

/** The statement sink handed to a `transaction` callback; writes only. */
export interface DbTx {
  exec(sql: string, params?: unknown[]): void;
}

/** The port. Every adapter implements all three members; switching hosts never changes this shape. */
export interface DbPort {
  exec(sql: string, params?: unknown[]): Promise<DbResult>;
  /** Collect statements → one atomic commit. The callback must not read; its result is returned. */
  transaction<T>(fn: (tx: DbTx) => Promise<T> | T): Promise<T>;
  search(surface: SearchSurface, scope: SearchScope, q: string, limit?: number): Promise<DbRow[]>;
}

/** The wire key for a binary value. Matches `src/data-api.js` literally; the test pins both. */
export const B64_KEY = "__b64";

/** Base64 for a byte view. Chunked so a multi-megabyte attachment cannot blow the argument stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, bytes.length);
    const codes: number[] = [];
    for (let j = i; j < end; j++) codes.push(bytes[j]);
    out += String.fromCharCode.apply(null, codes);
  }
  return btoa(out);
}

/** Bytes for a base64 string. A malformed input makes `atob` throw, which is the loud answer. */
export function base64ToBytes(text: string): Uint8Array {
  const bin = atob(String(text));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Object (not array, not null) view. Type predicate so callers index without an assertion. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Wire → caller value: `{__b64}` becomes bytes; arrays recurse; everything else passes through. */
export function decodeWireValue(value: unknown): unknown {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return value;
  if (isPlainObject(value) && typeof value[B64_KEY] === "string") return base64ToBytes(value[B64_KEY]);
  if (Array.isArray(value)) return value.map(decodeWireValue);
  return value;
}

/** Caller value → wire: bytes become `{__b64}`; everything else passes through. */
export function encodeWireValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return { [B64_KEY]: bytesToBase64(value) };
  if (value instanceof ArrayBuffer) return { [B64_KEY]: bytesToBase64(new Uint8Array(value)) };
  return value;
}

/** Encode a whole row without trusting its shape (driver rows may be null-prototype objects). */
export function encodeRow(row: unknown): DbRow {
  if (!isPlainObject(row)) return {};
  const out: DbRow = {};
  for (const key of Object.keys(row)) out[key] = encodeWireValue(row[key]);
  return out;
}

/** Inverse of {@link encodeRow}: the caller-facing row, with blobs materialised as Uint8Array. */
export function decodeRow(row: unknown): DbRow {
  if (!isPlainObject(row)) return {};
  const out: DbRow = {};
  for (const key of Object.keys(row)) out[key] = decodeWireValue(row[key]);
  return out;
}

/**
 * Validate and normalise bindings to what all three runtimes accept: string, finite number,
 * null or `{__b64}`. Called by every adapter before anything leaves the process so a bad binding is
 * a local error naming its index, not a server 400 or a driver-specific surprise.
 */
export function normalizeParams(params?: unknown[]): unknown[] {
  if (params === undefined) return [];
  if (!Array.isArray(params)) throw new Error("db: params must be an array");
  const out: unknown[] = [];
  for (let i = 0; i < params.length; i++) {
    const value = params[i];
    if (value === undefined || value === null) {
      out.push(null);
      continue;
    }
    if (typeof value === "string") {
      out.push(value);
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("db: params[" + i + "] is not a finite number");
      out.push(value);
      continue;
    }
    if (typeof value === "boolean") {
      // SQLite has no boolean: D1 binds true/false, node:sqlite rejects them outright.
      out.push(value ? 1 : 0);
      continue;
    }
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
      out.push(encodeWireValue(value));
      continue;
    }
    throw new Error("db: params[" + i + "] must be string|number|boolean|null|Uint8Array (serialise JSON yourself)");
  }
  return out;
}
