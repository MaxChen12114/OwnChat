// Browser wiring (injected by tooling/l0/emit.mjs): binds the service to the frozen window contract name.
// The implementation lives in services/chat/reasoning.ts; the display preference is read and
// written through the storage port.
(function () {
  if (window.__reasoning) return;
  var ports = {
    storage: {
      getItem: function (key) { return window.localStorage.getItem(key); },
      setItem: function (key, value) { window.localStorage.setItem(key, value); },
    },
  };
  var rs = createReasoning(ports);
  window.__reasoning = {
    getThinkDisplay: rs.getThinkDisplay,
    setThinkDisplay: rs.setThinkDisplay,
    THINK_DISPLAY_MODES: THINK_DISPLAY_MODES,
    applyThinkDisplay: rs.applyThinkDisplay,
    extractThinkText: rs.extractThinkText,
    buildReasoningArchive: rs.buildReasoningArchive,
    reasoningDelta: rs.reasoningDelta,
  };
})();
