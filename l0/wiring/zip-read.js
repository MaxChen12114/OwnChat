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
