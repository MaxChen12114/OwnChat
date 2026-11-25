// Classic binding for services/agent/skills-import.ts. The importer facade keeps its frozen name;
// both IO ports resolve on every call so a lazily loaded reader is visible to an importer that was
// already installed at boot. All package decisions live in the service, none in this file.
(function () {
  window.__skillsImport = createSkillImport({
    store: function () { return window.__skills || null; },
    zip: function (bytes, limits) {
      var reader = window.ZipRead;
      if (!reader || typeof reader.readZip !== "function") return null;
      return reader.readZip(bytes, limits);
    },
    now: function () { return Date.now(); },
    random: function () { return Math.random(); },
  });
})();
