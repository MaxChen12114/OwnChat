// Browser wiring injected by l0/emit.mjs: exposes the extractor under its frozen global.
// The only window access is the ZIP reader, which stays a classic script; the service itself is
// realm-neutral and takes it as a port. Returning null (rather than throwing) keeps a missing
// script reported as ZIP_READER_MISSING instead of a parse error.
(function () {
  if (window.__docExtract) return;
  var svc = createDocExtract({
    readZip: function (bytes) {
      if (!window.ZipRead || typeof window.ZipRead.readZip !== "function") return null;
      return window.ZipRead.readZip(bytes);
    },
  });
  window.__docExtract = {
    extractFile: svc.extractFile,
    extractBytes: svc.extractBytes,
    extractDocx: svc.extractDocx,
    extractXlsx: svc.extractXlsx,
    extractCsv: svc.extractCsv,
    _limits: svc.limits,
  };
})();
