// Browser wiring for services/memory/auto-write.ts: mount the shared writer on the existing
// __memCore facade (no new window.__* contract). Load after memory/core.js and memory/config.js;
// every dependency is resolved per call, so the facade's own remember/config can be replaced by
// tests or by a later wiring step without re-mounting.
(function () {
  var writer = createAutoWriter({
    enabled: function () {
      var cfg = window.__memCore && window.__memCore.config;
      return cfg ? !!cfg.read().autoWrite : false;
    },
    remember: function (text, opts) {
      var core = window.__memCore;
      if (!core || typeof core.remember !== "function") {
        return Promise.reject(new Error("memory facade 未接线"));
      }
      return core.remember(text, opts);
    },
    warn: function (message, error) {
      try { console.warn(message, error); } catch (e) {}
    },
  });
  if (window.__memCore) window.__memCore.autoWriteTurn = function (text, card, convId) { return writer.afterReply(text, card, convId); };
  else window.__memCore = { autoWriteTurn: function (text, card, convId) { return writer.afterReply(text, card, convId); } };
})();
