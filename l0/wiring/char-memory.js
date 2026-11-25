// Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name.
// The data capability lives in services/memory/char-memory.ts; this file owns four things:/n//   1) the real IndexedDB adapter (raw IDB objects satisfy the service's structural ports as-is);
//   2) the window ports (hostApi.app / __character / __charMemoryUiRefresh / alert / IDBKeyRange);
//   3) the v1 import UI (file picker + FileReader — browser glue, same precedent as the vector
//      loader in core.ts);
//   4) the member list, kept verbatim: twelve members plus `_db`.
(function () {
  // Every global is spelled out with the `window.` prefix: the boot graph and the contract scan
  // only recognise that form, and the vm test context provides the same shape.
  var ports = {
    idb: function () { return window.indexedDB || null; },
    keyRangeBound: function (a, b) { return IDBKeyRange.bound(a, b); },
    hostApp: function () {
      try { return (window.hostApi && window.hostApi.app) ? window.hostApi.app : null; } catch (e) { return null; }
    },
    activeCard: function () {
      try { return (window.__character && window.__character.getActiveCard) ? window.__character.getActiveCard() : null; } catch (e) { return null; }
    },
    uiRefresh: function () {
      // Must stay the full `window.`-prefixed form: check-contracts scans text, and an alias would
      // drop this name's reference count to zero — which reads as "the contract was retired".
      try { if (window.__charMemoryUiRefresh) window.__charMemoryUiRefresh(); } catch (e) {}
    },
    alertMsg: function (msg) { if (typeof alert === "function") alert(msg); },
  };
  var svc = createCharMemory(ports);
  window.__charMemory = {
    defineTools: svc.defineTools,
    importText: svc.importText,
    listDocs: svc.listDocs,
    removeDoc: svc.removeDoc,
    removeCard: svc.removeCard,
    search: svc.search,
    getDocText: svc.getDocText,
    buildInjection: svc.buildInjection,
    ui: function () {
      // The v1 import UI: pick a file, import it into the active character. The full editor-side
      // capability panel is a later batch.
      var card = ports.activeCard() || null;
      if (!card || !card.id) { ports.alertMsg("先挂一张角色卡（左栏角色面板）—— 知识库是「每个角色一套」的。"); return; }
      var input = document.createElement("input");
      input.type = "file";
      input.accept = ".txt,.md,.json,.csv,.log,text/*";
      input.style.display = "none";
      document.body.appendChild(input);
      input.addEventListener("change", function () {
        var f = input.files && input.files[0];
        if (!f) { input.remove(); return; }
        var fr = new FileReader();
        fr.onload = async function () {
          try {
            var r = await svc.importText(card.id, f.name, String(fr.result || ""), "file");
            ports.alertMsg("已导入《" + f.name + "》到「" + card.name + "」的知识库：分 " + r.chunks + " 段，共 " + r.chars + " 字。\n发消息时会按话题自动命中注入；agent 也能用 kb_search / kb_read 深挖。");
          } catch (e) { ports.alertMsg("导入失败：" + String((e && e.message) || e)); }
        };
        fr.readAsText(f);
        input.remove();
      });
      input.click();
    },
    // Entity graph (L4, the light version): `listEntities` answers which entities a character knows.
    extractEntities: svc.extractEntities,
    listEntities: svc.listEntities,
    _db: svc._db,
  };
})();
