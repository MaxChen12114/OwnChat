// Browser adapter, appended by l0/emit.mjs. Engine: services/sync/char-sync-merge.ts.
//
// The merge is pure and storage-free; this file publishes it under a non-frozen bridge that the
// cloud-sync engine reads through its `charMerge` port. The port is looked up lazily on every merge,
// so load order against services/data/sync.js does not matter — only that this artifact ran once.
(function () {
  "use strict";

  window.charSyncMerge = { mergeCharsState: mergeCharsState, hash32: charSyncHash32 };
})();
