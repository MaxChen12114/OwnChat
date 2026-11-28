// Browser wiring (injected by tooling/l0/emit.mjs): keeps both carriers — the CommonJS export that
// node:test loads directly, and the frozen window name the browser uses.
(function () {
  var G = (typeof window !== "undefined" ? window : globalThis);
  var api = { build: build, dayKey: dayKey };
  if (typeof module === "object" && module.exports) module.exports = api;
  G.__usageStats = api;
})();
