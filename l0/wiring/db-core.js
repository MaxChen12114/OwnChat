// Browser wiring, appended by l0/emit.mjs. Engine: core/db.ts (DbPort types + the {__b64} wire codec).
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
