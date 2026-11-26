// ── Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name ──
// The implementation moved to services/ui/chat-appearance.ts. Ports are localStorage and the document;
// every function still takes an optional `doc` so a caller can target a specific document.
// The apply-on-load that used to run inside the module body happens here, after the object exists.
(function (g) {
  "use strict";
  if (g.__chatAppearance) return;
  g.__chatAppearance = createChatAppearance({
    storage: {
      getItem: function (key) { return g.localStorage.getItem(key); },
      setItem: function (key, value) { g.localStorage.setItem(key, value); },
      removeItem: function (key) { g.localStorage.removeItem(key); },
    },
    doc: g.document || null,
  });
  // settings.js 之后只负责控件回填与交互；首次应用在这里做一次。
  g.__chatAppearance.applyAll();
})(window);
