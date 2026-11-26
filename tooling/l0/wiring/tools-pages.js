// Browser wiring for services/ui/tools-pages.ts: reads the build-injected catalog block, publishes
// it once for every consumer (`window.toolCatalog`, a non-`__` bridge), then renders one sidebar
// launcher per record. All parsing, sorting and icon choice live in the service; this file only
// touches the document.
//
// The launchers open a right-column tab, not a browser tab. Right-click (or a middle click) is the
// secondary "open in the browser" path: a launcher is a button, so the browser offers no context
// menu of its own and the listener supplies one.
(function () {
  "use strict";

  var raw = document.getElementById("toolsPageCatalog");
  var pages = sortPages(parseCatalog(raw ? raw.textContent || "" : null));

  // One parse, two hosts. panel-host and the mobile shell read this instead of re-reading the DOM
  // block; a second copy of the catalogue is exactly what the directory unification removed.
  window.toolCatalog = {
    version: 1,
    entries: function () { return pages.slice(); }
  };

  var host = document.getElementById("toolsPageList");
  if (!host) return;
  var titleEl = document.getElementById("toolsPageSection");

  var visible = [];
  for (var i = 0; i < pages.length; i++) {
    var entry = entryFor(pages[i]);
    if (!entry.sidebar) continue;
    visible.push(entry);
  }
  if (visible.length === 0) {
    // Empty catalogue: hide the whole section instead of leaving a dangling "工作台" heading.
    host.style.display = "none";
    if (titleEl) titleEl.style.display = "none";
    return;
  }

  function openInBrowser(entry) {
    try { window.open(entry.href, "_blank", "noopener"); } catch (e) {}
  }

  function launch(entry) {
    var panel = window.panelSvc;
    if (entry.page && entry.embed && panel && typeof panel.openPage === "function") {
      try {
        var r = panel.openPage(entry.id);
        if (!r || r.ok !== false) {
          // A collapsed right column would hide the page the user just clicked.
          if (typeof panel.expand === "function") panel.expand();
          return;
        }
      } catch (e) {}
    }
    openInBrowser(entry);
  }

  function bind(entry) {
    return function (e) {
      if (e && e.type === "contextmenu") {
        e.preventDefault();
        openInBrowser(entry);
        return;
      }
      if (e && e.type === "auxclick") {
        if (e.button !== 1) return;
        e.preventDefault();
        openInBrowser(entry);
        return;
      }
      launch(entry);
    };
  }

  for (var v = 0; v < visible.length; v++) {
    var item = visible[v];
    var b = document.createElement("button");
    b.type = "button";
    b.className = "sidebar-btn";
    b.id = item.id + "ToolBtn";
    b.title = item.title;
    var handler = bind(item);
    b.addEventListener("click", handler);
    b.addEventListener("contextmenu", handler);
    b.addEventListener("auxclick", handler);
    var icon = document.createElement("span");
    icon.className = "sidebar-btn-icon";
    icon.innerHTML = item.iconHtml;
    var label = document.createElement("span");
    label.className = "sidebar-btn-label";
    label.textContent = item.label;
    b.appendChild(icon);
    b.appendChild(label);
    host.appendChild(b);
  }
})();
