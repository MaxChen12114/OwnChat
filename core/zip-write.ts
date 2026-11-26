/**
 * Zero-dependency ZIP writer — the mirror of `core/zip-read.ts` for the backup path.
 *
 * Why this exists: the backup feature has to hand the user one file containing a dozen SQLite dumps.
 * A third-party zip library would be a new runtime dependency for something the platform already
 * does (`CompressionStream("deflate-raw")`), and the reader half is already hand-written here. This
 * writer follows the same rules as the reader so the pair round-trips byte-for-byte:
 *
 *   · entry names are UTF-8 and carry the language-encoding flag (bit 11); backslashes are
 *     normalised to `/`, and absolute paths, drive letters, NUL bytes and any `..` segment are
 *     rejected — an archive this writer refuses to create is one the reader would refuse to read;
 *   · deflate uses `CompressionStream("deflate-raw")`, exactly what `DecompressionStream` expects;
 *     a host without it fails with `NO_COMPRESSION_STREAM` instead of silently writing a broken
 *     archive. Incompressible payloads are stored (method 0) — a valid ZIP, not a failure;
 *   · CRC32 is computed here (the reader does not verify it, so this is the only place the checksum
 *     is real); the table is built once.
 *
 * Limits mirror the reader's contract: 65535 entries (EOCD is 16-bit), 4 GB per entry and in total,
 * no ZIP64. Exceeding them throws `ZIP64_UNSUPPORTED` rather than writing an archive that a strict
 * reader would mis-parse.
 *
 * Boundary: pure bytes in, bytes out. No DOM, no filesystem, no clock beyond the optional timestamp
 * used for the DOS date/time fields.
 *
 * Lock: `test/zip-write.test.mjs` (round-trips through `core/zip-read.ts`; Chinese names, empty and
 * multi-megabyte entries, CRC pinned against a known value).
 * @module core/zip-write
 */

export interface ZipWriteLimits {
  maxEntries: number;
  maxSingle: number;
  maxTotal: number;
}

export interface ZipWriteOptions {
  /** Compress with deflate-raw when it actually shrinks the payload. Default true. */
  deflate?: boolean;
  /** Epoch ms for the DOS date/time fields. Default `Date.now()`. */
  date?: number;
}

export interface ZipWriteApi {
  writeZip(entries: unknown, opts?: unknown): Promise<Uint8Array>;
  _limits: ZipWriteLimits;
}

const ZIP_DEFAULTS: ZipWriteLimits = {
  maxEntries: 65535,
  maxSingle: 0xffffffff,
  maxTotal: 0xffffffff,
};

const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
/** ZIP spec: 2.0 is enough for deflate and the UTF-8 flag; no ZIP64 extensions are written. */
const VERSION_NEEDED = 20;
const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const U32_MAX = 0xffffffff;

/** Errors carry a stable `code`; callers branch on it, never on the message. */
function zipError(code: string, message?: string): Error {
  return Object.assign(new Error(message || code), { code: code });
}

function prop(value: unknown, key: string): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
  return Reflect.get(value, key);
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function recOf(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
  const entries = Object.entries(value);
  for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  return out;
}

function mergeLimits(opts: unknown): ZipWriteLimits {
  const o = opts && typeof opts === "object" ? opts : {};
  return {
    maxEntries: num(prop(o, "maxEntries"), ZIP_DEFAULTS.maxEntries),
    maxSingle: num(prop(o, "maxSingle"), ZIP_DEFAULTS.maxSingle),
    maxTotal: num(prop(o, "maxTotal"), ZIP_DEFAULTS.maxTotal),
  };
}

function toBytes(value: unknown): Uint8Array {
  const BAD = "writeZip 的条目数据需要 Uint8Array、ArrayBuffer 或字符串";
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  // Cross-realm views (a vm sandbox, an iframe) fail `instanceof`; fall back to duck typing.
  const byteLength = prop(value, "byteLength");
  const length = prop(value, "length");
  if (typeof byteLength === "number" && typeof length === "number") {
    const buf = prop(value, "buffer");
    const off = prop(value, "byteOffset");
    if (buf instanceof ArrayBuffer) return new Uint8Array(buf, typeof off === "number" ? off : 0, byteLength);
  }
  throw zipError("BAD_INPUT", BAD);
}

/** Backslashes normalised, then the same refusals as the reader — the two halves must agree. */
function zipSafeName(name: unknown): string {
  const n = String(name == null ? "" : name).replace(/\\/g, "/");
  if (!n) throw zipError("BAD_PATH", "条目名为空");
  if (n.indexOf("\0") >= 0) throw zipError("BAD_PATH", "条目名含 NUL: " + n);
  if (n.charAt(0) === "/") throw zipError("BAD_PATH", "绝对路径: " + n);
  if (/^[A-Za-z]:/.test(n)) throw zipError("BAD_PATH", "盘符路径: " + n);
  const parts = n.split("/");
  for (let i = 0; i < parts.length; i++) if (parts[i] === "..") throw zipError("BAD_PATH", "路径穿越: " + n);
  return n;
}

/** CRC32 (IEEE 802.3), the checksum the ZIP format stores. Built once at first use.
 *  Deliberately module-private: the emitter bridges exports to bare globals, and `crc32` is far
 *  too generic a name to add to the page's global scope. */
let crcTable: Uint32Array | null = null;
function crcTableOf(): Uint32Array {
  if (crcTable !== null) return crcTable;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  crcTable = table;
  return table;
}

function crc32(bytes: Uint8Array): number {
  const table = crcTableOf();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time (local time, 2-second resolution). Years clamp to 1980–2107 as the format requires. */
function dosDateTime(ms: number): { date: number; time: number } {
  const d = new Date(ms);
  let year = d.getFullYear();
  if (!Number.isFinite(year)) year = 1980;
  if (year < 1980) year = 1980;
  if (year > 2107) year = 2107;
  const date = ((year - 1980) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f);
  return { date: date, time: time };
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  if (
    typeof CompressionStream === "undefined" ||
    typeof Blob === "undefined" ||
    typeof Response === "undefined"
  ) {
    throw zipError("NO_COMPRESSION_STREAM", "当前环境不支持 CompressionStream，无法写入 deflate 条目");
  }
  const cs = new CompressionStream("deflate-raw");
  // Copy into a fresh view over a plain ArrayBuffer: a subarray carries `ArrayBufferLike`
  // (it may be a SharedArrayBuffer view), which BlobPart does not accept.
  const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function u16(out: Uint8Array, offset: number, value: number): void {
  out[offset] = value & 0xff;
  out[offset + 1] = (value >>> 8) & 0xff;
}

function u32(out: Uint8Array, offset: number, value: number): void {
  out[offset] = value & 0xff;
  out[offset + 1] = (value >>> 8) & 0xff;
  out[offset + 2] = (value >>> 16) & 0xff;
  out[offset + 3] = (value >>> 24) & 0xff;
}

/** One prepared entry: enough to emit both headers and the payload. */
interface PreparedEntry {
  nameBytes: Uint8Array;
  crc: number;
  method: number;
  data: Uint8Array;
  uncompSize: number;
  offset: number;
}

/**
 * Writes a ZIP from `{ name, data }` entries.
 *
 * @param entries array of `{ name: string, data: Uint8Array | ArrayBuffer | string }`; strings are
 *        UTF-8 encoded. Duplicate names and unsafe paths throw.
 * @param opts `{ deflate?: boolean, date?: number }` plus numeric limit overrides.
 * @throws an `Error` carrying `code` — `BAD_INPUT` / `BAD_ENTRY` / `BAD_PATH` / `DUPLICATE_NAME` /
 *         `TOO_MANY_ENTRIES` / `ENTRY_TOO_LARGE` / `TOTAL_TOO_LARGE` / `NO_COMPRESSION_STREAM`.
 * @returns the archive bytes.
 */
async function writeZip(entries: unknown, opts?: unknown): Promise<Uint8Array> {
  if (!Array.isArray(entries)) throw zipError("BAD_INPUT", "writeZip 需要条目数组");
  const lim = mergeLimits(opts);
  const o = opts && typeof opts === "object" ? opts : {};
  const useDeflate = prop(o, "deflate") !== false;
  const nowMs = num(prop(o, "date"), Date.now());
  const stamp = dosDateTime(nowMs);

  if (entries.length > lim.maxEntries) throw zipError("TOO_MANY_ENTRIES", "条目数超过上限 " + lim.maxEntries);

  const prepared: PreparedEntry[] = [];
  const seen: Record<string, 1> = {};
  let localSize = 0;
  let totalUncomp = 0;

  for (let i = 0; i < entries.length; i++) {
    const rec = recOf(entries[i]);
    const name = zipSafeName(rec["name"]);
    if (Object.prototype.hasOwnProperty.call(seen, name)) throw zipError("DUPLICATE_NAME", "条目名重复: " + name);
    seen[name] = 1;
    const raw = toBytes(rec["data"]);
    if (raw.length > lim.maxSingle) throw zipError("ENTRY_TOO_LARGE", "单文件超过上限: " + name);
    totalUncomp += raw.length;
    if (totalUncomp > lim.maxTotal) throw zipError("TOTAL_TOO_LARGE", "写入总量超过上限");

    let method = METHOD_STORE;
    let body = raw;
    if (useDeflate && raw.length > 0) {
      const packed = await deflateRaw(raw);
      // Storing a payload that does not shrink keeps small text files readable in any tool.
      if (packed.length < raw.length) {
        method = METHOD_DEFLATE;
        body = packed;
      }
    }
    const nameBytes = new TextEncoder().encode(name);
    localSize += 30 + nameBytes.length + body.length;
    prepared.push({
      nameBytes: nameBytes,
      crc: crc32(raw),
      method: method,
      data: body,
      uncompSize: raw.length,
      offset: localSize - (30 + nameBytes.length + body.length),
    });
  }

  const centralParts: Uint8Array[] = [];
  let centralSize = 0;
  for (let i = 0; i < prepared.length; i++) {
    const e = prepared[i];
    const head = new Uint8Array(46 + e.nameBytes.length);
    u32(head, 0, CENTRAL_SIG);
    u16(head, 4, VERSION_NEEDED);
    u16(head, 6, VERSION_NEEDED);
    u16(head, 8, FLAG_UTF8);
    u16(head, 10, e.method);
    u16(head, 12, stamp.time);
    u16(head, 14, stamp.date);
    u32(head, 16, e.crc);
    u32(head, 20, e.data.length);
    u32(head, 24, e.uncompSize);
    u16(head, 28, e.nameBytes.length);
    u16(head, 30, 0);
    u16(head, 32, 0);
    u16(head, 34, 0);
    u16(head, 36, 0);
    u32(head, 38, 0);
    u32(head, 42, e.offset);
    head.set(e.nameBytes, 46);
    centralParts.push(head);
    centralSize += head.length;
  }

  if (localSize > U32_MAX || centralSize > U32_MAX || prepared.length > 0xffff) {
    throw zipError("ZIP64_UNSUPPORTED", "归档超过 4GB 或 65535 条目，暂不支持 ZIP64");
  }
  const total = localSize + centralSize + 22;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (let i = 0; i < prepared.length; i++) {
    const e = prepared[i];
    const head = new Uint8Array(30 + e.nameBytes.length);
    u32(head, 0, LOCAL_SIG);
    u16(head, 4, VERSION_NEEDED);
    u16(head, 6, FLAG_UTF8);
    u16(head, 8, e.method);
    u16(head, 10, stamp.time);
    u16(head, 12, stamp.date);
    u32(head, 14, e.crc);
    u32(head, 18, e.data.length);
    u32(head, 22, e.uncompSize);
    u16(head, 26, e.nameBytes.length);
    u16(head, 28, 0);
    head.set(e.nameBytes, 30);
    out.set(head, cursor);
    cursor += head.length;
    out.set(e.data, cursor);
    cursor += e.data.length;
  }
  for (let i = 0; i < centralParts.length; i++) {
    out.set(centralParts[i], cursor);
    cursor += centralParts[i].length;
  }
  u32(out, cursor, EOCD_SIG);
  u16(out, cursor + 4, 0);
  u16(out, cursor + 6, 0);
  u16(out, cursor + 8, prepared.length);
  u16(out, cursor + 10, prepared.length);
  u32(out, cursor + 12, centralSize);
  u32(out, cursor + 16, localSize);
  u16(out, cursor + 20, 0);
  return out;
}

export function createZipWrite(): ZipWriteApi {
  return { writeZip: writeZip, _limits: ZIP_DEFAULTS };
}
