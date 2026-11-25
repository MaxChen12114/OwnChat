// Browser wiring (injected by l0/emit.mjs): binds the service to the existing window contract.
// The CDN libraries and the escape bridge are resolved per call, mirroring the old markdown.js
// rule of never capturing a reference up front — the scripts load when they load.
// Normalising the marked-highlight UMD shape (a bare function versus an exports object carrying
// `.markedHighlight`) belongs here too, so the service touches no window and asserts no types.
// Bridge names are spelled out with the `window.` prefix: the contract scan only counts that form.
(function () {
  if (window.__markdown) return;

  function resolveHighlight() {
    var raw = window.markedHighlight;
    if (!raw) return null;
    if (typeof raw === "function") return raw;
    if (raw.markedHighlight && typeof raw.markedHighlight === "function") return raw.markedHighlight;
    return null;
  }

  var ports = {
    libs: function () {
      if (typeof window === "undefined") return null;
      if (!window.marked || !window.DOMPurify) return null;
      return {
        marked: window.marked,
        domPurify: window.DOMPurify,
        hljs: window.hljs,
        highlight: resolveHighlight(),
      };
    },
    esc: function (text) { return window.__ownEscape.esc(text); },
  };

  var md = createMarkdown(ports);
  window.__markdown = {
    safe: md.safe,
    rich: md.rich,
    legacy: md.legacy,
  };
})();
