// Browser adapter, appended by l0/emit.mjs. Engine: services/save-file.ts; this file owns the frozen
// global name, the Tauri probe and the anchor lifetime.
//
// The 4 s cleanup is not cosmetic: the anchor has to stay in the DOM until the browser has consumed
// the click, and the object URL must outlive it, or the download fails silently on a slow machine.
(function () {
  var G = (typeof window !== "undefined" ? window : globalThis);
  var CLEANUP_MS = 4000;

  function shellInvoke() {
    try {
      var t = G.__TAURI__;
      if (t && t.core && typeof t.core.invoke === "function") return t.core.invoke.bind(t.core);
      return null;
    } catch (e) {
      return null;
    }
  }

  function clickAnchor(a) {
    a.rel = "noopener";
    a.style.position = "fixed";
    a.style.left = "-9999px";
    a.style.top = "-9999px";
    G.document.body.appendChild(a);
    a.dispatchEvent(new G.MouseEvent("click", { bubbles: true, cancelable: true, view: G }));
  }

  function removeLater(a, revokeUrl) {
    G.setTimeout(function () {
      try { if (a && a.parentNode) a.parentNode.removeChild(a); } catch (e) {}
      if (revokeUrl) { try { G.URL.revokeObjectURL(revokeUrl); } catch (e) {} }
    }, CLEANUP_MS);
  }

  var saveFile = createSaveFile({
    shell: shellInvoke,
    now: function () { return Date.now(); },
    downloadText: function (name, text) {
      var blob = new G.Blob([text], { type: "text/plain;charset=utf-8" });
      var url = G.URL.createObjectURL(blob);
      var a = G.document.createElement("a");
      a.href = url;
      a.download = name;
      clickAnchor(a);
      removeLater(a, url);
    },
    downloadHref: function (name, href) {
      var a = G.document.createElement("a");
      a.href = href;
      a.download = name;
      clickAnchor(a);
      removeLater(a, null);
    }
  });

  G.__saveFile = {
    saveTextFile: saveFile.saveTextFile,
    saveJsonFile: saveFile.saveJsonFile,
    saveBinaryFile: saveFile.saveBinaryFile,
    isTauri: saveFile.isTauri
  };
})();
