// ── Browser wiring (injected by l0/emit.mjs): binds the ZIP writer to a plain global ──
// The implementation lives in core/zip-write.ts. No ports: the writer uses only platform globals
// (TextEncoder / CompressionStream / Blob / Response), and a host missing the compressor fails with
// `NO_COMPRESSION_STREAM` rather than writing an archive later readers cannot open. The global is
// `ZipWrite`, mirroring `ZipRead` (both are loaded on demand by the backup card, not at boot).
(function (global) {
  if (global.ZipWrite) return;
  global.ZipWrite = createZipWrite();
})(typeof globalThis !== "undefined" ? globalThis : window);
