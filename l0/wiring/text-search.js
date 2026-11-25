// Browser adapter appended by l0/emit.mjs. Engine: services/agent/text-search.ts (windowing, glob
// translation, literal/regex search with its guards, output budgeting). This file only publishes the
// module under its frozen name and keeps the CommonJS bridge for out-of-repo harnesses.
//
// Publishing here rather than in the engine keeps the engine free of globals; the agent-workspace
// adapter resolves this port lazily on every call, so load order does not matter.
(function () {
  "use strict";
  if (typeof window === "undefined") return;

  window.__textSearch = {
    sliceLines: tsSliceLines,
    globToRe: tsGlobToRe,
    searchText: tsSearchText,
    fitBlocks: tsFitBlocks,
    LIMITS: TS_LIMITS,
  };

  // Node-side harnesses (no window) require the product directly; browsers never reach this branch.
  if (typeof module !== "undefined" && module.exports) module.exports = window.__textSearch;
})();
