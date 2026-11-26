// Browser wiring for services/conv/summary.ts: localStorage is the hot read (the send path reads
// it synchronously), the `summaries` table is the persistent copy. The facade is a plain global
// (`convSummarySvc`), matching the post-thaw naming (contracts.json tracks `__*` only).
//
// The SQL mirror is late-bound on purpose: this script loads before the app and before the first
// DbPort selection, so each method resolves `window.dbSvc.get()` when it actually runs. A missing
// port rejects, and the store swallows that into a warn — the synchronous answer never changes.
(function () {
  function dbPort() {
    if (!window.dbSvc || typeof window.dbSvc.get !== "function") return null;
    return window.dbSvc.get();
  }
  function off(sql, params) {
    var port = dbPort();
    if (!port) return Promise.reject(new Error("db not ready"));
    return port.exec(sql, params);
  }
  var mirror = {
    all: function () {
      return off("SELECT conv_id AS convId, text, ts FROM summaries").then(function (r) {
        return (r && r.rows) || [];
      });
    },
    put: function (convId, text, ts) {
      return off(
        "INSERT INTO summaries (conv_id, text, ts) VALUES (?,?,?) ON CONFLICT(conv_id) DO UPDATE SET text=excluded.text, ts=excluded.ts",
        [convId, text, ts],
      );
    },
    remove: function (convId) {
      return off("DELETE FROM summaries WHERE conv_id = ?", [convId]);
    },
    clear: function () {
      return off("DELETE FROM summaries");
    },
  };
  window.convSummarySvc = createSummaryStore(
    {
      getItem: function (key) { return window.localStorage.getItem(key); },
      setItem: function (key, value) { window.localStorage.setItem(key, value); },
      removeItem: function (key) { window.localStorage.removeItem(key); },
    },
    function (message, error) { try { console.warn(message, error); } catch (e) {} },
    mirror,
  );
})();
