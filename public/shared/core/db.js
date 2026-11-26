(function () {
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
                        
                         
 

/** Rows only. Writes answer `{rows:[]}`, matching `src/data-api.js`'s exec response. */
                           
                
 

/** The three FTS5 surfaces the schema materialises. There is no fourth: scope decides the join. */
                                                         

/** Scope is per surface: `conv` for messages, `cid` for memory and kb. A missing key is an error. */
                              
                
               
 

/** The statement sink handed to a `transaction` callback; writes only. */
                       
                                              
 

/** The port. Every adapter implements all three members; switching hosts never changes this shape. */
                         
                                                           
                                                                                                    
                                                               
                                                                                                  
 

/** The wire key for a binary value. Matches `src/data-api.js` literally; the test pins both. */
const B64_KEY = "__b64";

/** Base64 for a byte view. Chunked so a multi-megabyte attachment cannot blow the argument stack. */
function bytesToBase64(bytes            )         {
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, bytes.length);
    const codes           = [];
    for (let j = i; j < end; j++) codes.push(bytes[j]);
    out += String.fromCharCode.apply(null, codes);
  }
  return btoa(out);
}

/** Bytes for a base64 string. A malformed input makes `atob` throw, which is the loud answer. */
function base64ToBytes(text        )             {
  const bin = atob(String(text));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Object (not array, not null) view. Type predicate so callers index without an assertion. */
function isPlainObject(value         )                                   {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Wire → caller value: `{__b64}` becomes bytes; arrays recurse; everything else passes through. */
function decodeWireValue(value         )          {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return value;
  if (isPlainObject(value) && typeof value[B64_KEY] === "string") return base64ToBytes(value[B64_KEY]);
  if (Array.isArray(value)) return value.map(decodeWireValue);
  return value;
}

/** Caller value → wire: bytes become `{__b64}`; everything else passes through. */
function encodeWireValue(value         )          {
  if (value instanceof Uint8Array) return { [B64_KEY]: bytesToBase64(value) };
  if (value instanceof ArrayBuffer) return { [B64_KEY]: bytesToBase64(new Uint8Array(value)) };
  return value;
}

/** Encode a whole row without trusting its shape (driver rows may be null-prototype objects). */
function encodeRow(row         )        {
  if (!isPlainObject(row)) return {};
  const out        = {};
  for (const key of Object.keys(row)) out[key] = encodeWireValue(row[key]);
  return out;
}

/** Inverse of {@link encodeRow}: the caller-facing row, with blobs materialised as Uint8Array. */
function decodeRow(row         )        {
  if (!isPlainObject(row)) return {};
  const out        = {};
  for (const key of Object.keys(row)) out[key] = decodeWireValue(row[key]);
  return out;
}

/**
 * Validate and normalise bindings to what all three runtimes accept: string, finite number,
 * null or `{__b64}`. Called by every adapter before anything leaves the process so a bad binding is
 * a local error naming its index, not a server 400 or a driver-specific surprise.
 */
function normalizeParams(params            )            {
  if (params === undefined) return [];
  if (!Array.isArray(params)) throw new Error("db: params must be an array");
  const out            = [];
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

// Browser wiring, appended by tooling/l0/emit.mjs. Engine: core/db.ts (DbPort types + the {__b64} wire codec).
//
// Public API: window.dbWire = { v, B64_KEY, bytesToBase64, base64ToBytes, encodeWireValue,
// decodeWireValue, encodeRow, decodeRow, normalizeParams }. Adapters and T3 services read the codec
// through this object instead of reaching for the emitter's bare-name bridge: one named seam, and a
// missing script fails with "dbWire is not defined" at the first call instead of a silent no-op.
(function (g) {
  "use strict";
  if (g.dbWire) return;
  g.dbWire = {
    v: 1,
    B64_KEY: B64_KEY,
    bytesToBase64: bytesToBase64,
    base64ToBytes: base64ToBytes,
    encodeWireValue: encodeWireValue,
    decodeWireValue: decodeWireValue,
    encodeRow: encodeRow,
    decodeRow: decodeRow,
    normalizeParams: normalizeParams,
  };
})(window);

globalThis.B64_KEY = B64_KEY;
globalThis.bytesToBase64 = bytesToBase64;
globalThis.base64ToBytes = base64ToBytes;
globalThis.decodeWireValue = decodeWireValue;
globalThis.encodeWireValue = encodeWireValue;
globalThis.encodeRow = encodeRow;
globalThis.decodeRow = decodeRow;
globalThis.normalizeParams = normalizeParams;
})();
