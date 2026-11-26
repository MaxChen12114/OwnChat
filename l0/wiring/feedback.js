// ── Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name ──
// The implementation moved to services/ui/feedback.ts. Ports are the document, requestAnimationFrame
// and the two native fallbacks used only when the DOM path throws. `document` is captured once —
// its identity is stable for the page's life, and the old code read the same object every call.
(function () {
  if (window.feedbackSvc) return;
  window.feedbackSvc = createFeedback({
    doc: window.document,
    raf: function (fn) { return window.requestAnimationFrame(fn); },
    prompt: function (message, value) { return window.prompt(message, value); },
    confirm: function (message) { return window.confirm(message); },
  });
})();
