(function () {
/**
 * Zero-dependency ZIP reader — the shared floor under DOCX/XLSX extraction and skill-pack import.
 *
 * Read-only: nothing is written, nothing is unpacked to disk. It walks the central directory and
 * returns `{ name, size, compressedSize, method, data, isDir, externalAttrs, flags }` per entry, so
 * callers decide what to do with the bytes.
 *
 * Path handling is a security boundary, not a convenience: backslashes are normalised, then absolute
 * paths, drive letters, NUL bytes and any `..` segment are rejected outright. ZIP64 is refused
 * explicitly rather than mis-parsed. The ratio cap is only a bomb backstop — the real limits are the
 * per-file and total uncompressed sizes, because legitimate highly repetitive text (template-generated
 * DOCX paragraphs) can exceed 100:1 and a low ratio cap would reject real documents.
 *
 * Decompression uses the platform `DecompressionStream("deflate-raw")`; there is no bundled inflater.
 * A host without it fails the deflate entries with a named code instead of silently returning garbage.
 *
 * Layer: `lib/` — pure bytes in, bytes out; no DOM, no IO, no domain meaning. The only platform calls
 * are the standard globals (`TextDecoder` / `DecompressionStream` / `Blob` / `Response`), which is
 * what keeps the same source valid in the page, a Tauri webview and a Node test realm.
 *
 * Lock: `scripts/test-zip-read.mjs` (12 checks, self-built fixtures, no third-party ZIP writer).
 * @module lib/zip-read
 */

                            
                     
                   
                    
                   
 

                           
               
               
                         
                 
                                                                                             
                          
                 
                        
                
 

                             
               
                
                  
                    
                  
 

                            
                      
                         
 

                             
                                                              
                     
 

const ZIP_DEFAULTS            = {
  maxEntries: 500,
  maxTotal: 50 * 1024 * 1024,
  maxSingle: 20 * 1024 * 1024,
  maxRatio: 1000,
};

/** Errors carry a stable `code`; callers branch on it, never on the message. */
function zipError(code        , message         )        {
  return Object.assign(new Error(message || code), { code: code });
}

/** `obj[key]` without narrowing games — typed arrays are not plain records, so `recOf` is wrong here. */
function prop(value         , key        )          {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
  return Reflect.get(value, key);
}

function num(value         , fallback        )         {
  return typeof value === "number" ? value : fallback;
}

function mergeLimits(opts         )            {
  const o = opts && typeof opts === "object" ? opts : {};
  return {
    maxEntries: num(prop(o, "maxEntries"), ZIP_DEFAULTS.maxEntries),
    maxTotal: num(prop(o, "maxTotal"), ZIP_DEFAULTS.maxTotal),
    maxSingle: num(prop(o, "maxSingle"), ZIP_DEFAULTS.maxSingle),
    maxRatio: num(prop(o, "maxRatio"), ZIP_DEFAULTS.maxRatio),
  };
}

function toBytes(input         )             {
  const BAD = "readZip 需要 ArrayBuffer 或 Uint8Array";
  if (!input || typeof input === "string") throw zipError("BAD_INPUT", BAD);
  if (input instanceof Uint8Array) return new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  // Cross-realm views (a vm sandbox, an iframe) fail `instanceof`; fall back to duck typing.
  const byteLength = prop(input, "byteLength");
  const length = prop(input, "length");
  if (typeof byteLength === "number" && typeof length === "number") {
    const buf = prop(input, "buffer");
    const off = prop(input, "byteOffset");
    if (buf instanceof ArrayBuffer) return new Uint8Array(buf, typeof off === "number" ? off : 0, byteLength);
  }
  throw zipError("BAD_INPUT", BAD);
}

function zipU16(b            , o        )         {
  return b[o] | (b[o + 1] << 8);
}

function zipU32(b            , o        )         {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

/** The end-of-central-directory record sits within the last 65557 bytes; scan backwards. */
function zipFindEOCD(bytes            )         {
  const min = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= min; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) return i;
  }
  return -1;
}

function zipSafeName(name         )          {
  const n = String(name == null ? "" : name).replace(/\\/g, "/");
  if (!n) return false;
  if (n.indexOf("\0") >= 0) return false;
  if (n.charAt(0) === "/") return false;
  if (/^[A-Za-z]:/.test(n)) return false;
  const parts = n.split("/");
  for (let i = 0; i < parts.length; i++) if (parts[i] === "..") return false;
  return true;
}

function inflateRaw(raw            )                      {
  return Promise.resolve()
    .then(function () {
      if (
        typeof DecompressionStream === "undefined" ||
        typeof Blob === "undefined" ||
        typeof Response === "undefined"
      ) {
        throw zipError("NO_DECOMPRESSION_STREAM", "当前环境不支持 DecompressionStream，无法解压 deflate 条目");
      }
      const ds = new DecompressionStream("deflate-raw");
      // Copy into a fresh view over a plain ArrayBuffer: a subarray carries `ArrayBufferLike`
      // (it may be a SharedArrayBuffer view), which BlobPart does not accept.
      const stream = new Blob([new Uint8Array(raw)]).stream().pipeThrough(ds);
      return new Response(stream).arrayBuffer();
    })
    .then(function (buf) {
      return new Uint8Array(buf);
    });
}

/**
 * Reads a ZIP from memory.
 * @param input `ArrayBuffer` or a typed-array view; anything else throws `BAD_INPUT`.
 * @param opts numeric overrides for the limits (entry count, total/single size, ratio).
 * @throws an `Error` carrying `code` — `BAD_INPUT` / `EOCD_NOT_FOUND` / `ZIP64_UNSUPPORTED` /
 * `TOO_MANY_ENTRIES` / `TRUNCATED` / `BAD_CENTRAL_DIRECTORY` / `BAD_PATH` / `ENTRY_TOO_LARGE` /
 * `TOTAL_TOO_LARGE` / `ZIP_RATIO` / `BAD_LOCAL_HEADER` / `NO_DECOMPRESSION_STREAM`.
 * @returns entries plus non-fatal warnings (unsupported method, declared/actual size mismatch).
 */
async function readZip(input         , opts          )                     {
  const bytes = toBytes(input);
  const lim = mergeLimits(opts);
  const eocd = zipFindEOCD(bytes);
  if (eocd < 0) throw zipError("EOCD_NOT_FOUND", "不是有效的 ZIP（找不到 EOCD）");

  const total = zipU16(bytes, eocd + 10);
  const cdSize = zipU32(bytes, eocd + 12);
  const cdOffset = zipU32(bytes, eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw zipError("ZIP64_UNSUPPORTED", "暂不支持 ZIP64");
  }
  if (total > lim.maxEntries) throw zipError("TOO_MANY_ENTRIES", "条目数超过上限 " + lim.maxEntries);
  if (cdOffset + cdSize > bytes.length) throw zipError("TRUNCATED", "中央目录越界（文件被截断）");

  const entries             = [];
  const warnings               = [];
  let totalUncomp = 0;
  let off = cdOffset;

  for (let i = 0; i < total; i++) {
    if (off + 46 > bytes.length) throw zipError("TRUNCATED", "中央目录条目越界");
    if (zipU32(bytes, off) !== 0x02014b50) throw zipError("BAD_CENTRAL_DIRECTORY", "中央目录签名错误");

    const flags = zipU16(bytes, off + 8);
    const method = zipU16(bytes, off + 10);
    const compSize = zipU32(bytes, off + 20);
    const uncompSize = zipU32(bytes, off + 24);
    const nameLen = zipU16(bytes, off + 28);
    const extraLen = zipU16(bytes, off + 30);
    const commentLen = zipU16(bytes, off + 32);
    const externalAttrs = zipU32(bytes, off + 38);
    const localOffset = zipU32(bytes, off + 42);

    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      throw zipError("ZIP64_UNSUPPORTED", "条目使用 ZIP64 扩展，暂不支持");
    }
    if (off + 46 + nameLen + extraLen + commentLen > bytes.length) {
      throw zipError("TRUNCATED", "中央目录条目越界");
    }

    const rawName = new TextDecoder("utf-8").decode(bytes.subarray(off + 46, off + 46 + nameLen));
    const name = rawName.replace(/\\/g, "/");
    if (!zipSafeName(name)) throw zipError("BAD_PATH", "非法路径: " + rawName);
    const isDir = name.charAt(name.length - 1) === "/";

    if (!isDir) {
      if (uncompSize > lim.maxSingle) throw zipError("ENTRY_TOO_LARGE", "单文件超过上限: " + name);
      totalUncomp += uncompSize;
      if (totalUncomp > lim.maxTotal) throw zipError("TOTAL_TOO_LARGE", "解压后总量超过上限");
      if (compSize > 0 && uncompSize > compSize * lim.maxRatio) {
        throw zipError("ZIP_RATIO", "压缩比异常（疑似 zip 炸弹）: " + name);
      }
    }

    let data                    = null;
    if (!isDir) {
      if (localOffset + 30 > bytes.length) throw zipError("BAD_LOCAL_HEADER", "本地头越界: " + name);
      if (zipU32(bytes, localOffset) !== 0x04034b50) throw zipError("BAD_LOCAL_HEADER", "本地头签名错误: " + name);
      const lNameLen = zipU16(bytes, localOffset + 26);
      const lExtraLen = zipU16(bytes, localOffset + 28);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      if (dataStart + compSize > bytes.length) throw zipError("TRUNCATED", "条目数据越界: " + name);
      const raw = bytes.subarray(dataStart, dataStart + compSize);
      if (method === 0) {
        data = raw;
      } else if (method === 8) {
        data = await inflateRaw(raw);
      } else {
        warnings.push({ code: "UNSUPPORTED_METHOD", name: name, method: method });
      }
      if (data && uncompSize && data.length !== uncompSize) {
        warnings.push({ code: "SIZE_MISMATCH", name: name, expected: uncompSize, actual: data.length });
      }
    }

    entries.push({
      name: name,
      size: uncompSize,
      compressedSize: compSize,
      method: method,
      data: data,
      isDir: isDir,
      externalAttrs: externalAttrs,
      flags: flags,
    });
    off += 46 + nameLen + extraLen + commentLen;
  }

  return { entries: entries, warnings: warnings };
}

function createZipRead()             {
  return { readZip: readZip, _limits: ZIP_DEFAULTS };
}

// ── Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name ──
// The implementation lives in lib/zip-read.ts (pure bytes in, bytes out; moved out of core/ in the
// 2026-11-28 boundary split). No ports: the reader uses only platform
// globals (TextDecoder / DecompressionStream / Blob / Response), and a host missing the decompressor
// fails with a named code rather than degrading silently. The global is `ZipRead`, not `__zipRead` —
// both consumers (doc-extract, skills-import) already read that name and it is not a frozen contract.
(function (global) {
  if (global.ZipRead) return;
  global.ZipRead = createZipRead();
})(typeof globalThis !== "undefined" ? globalThis : window);

globalThis.createZipRead = createZipRead;
})();
