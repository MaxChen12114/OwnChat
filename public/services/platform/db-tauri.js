(function () {
/**
 * Tauri adapter: DbPort over the desktop shell's native commands (`db_exec`, `db_tx`, `db_migrate`).
 *
 * Why search is built locally: there is no HTTP server to ask, so the adapter hands rusqlite exactly
 * the statement the server would have run — `core/db-search.ts` owns that decision, and the port test
 * runs both paths against one SQLite database to prove they agree.
 *
 * Migration is lazy and exactly once: `db_migrate` is awaited before the first command, and the
 * promise is memoised. A failed migration clears the memo so the next call retries instead of
 * pretending the schema exists; a first-call-only rule would otherwise leave the app permanently
 * broken after one bad start.
 *
 * The invoker is injected (the wiring closes over `tauriSvc`), so this module never reads a shell
 * global itself — that keeps `services/platform/tauri.ts` the single place that names `__TAURI__`.
 * @module services/platform/db-tauri
 */

                                                                                               

                                                                                            
                                                                                           

/** The one shell call shape this adapter needs. */
                                                                            

/** Options the facade's `use("tauri", opts)` passes through (the wiring supplies `invoke`). */
                                 
                                
 

                              
              
                    
 

/** Object view without an assertion. */
function isRecord(value         )                                   {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Build the shell-backed port.
 * @throws when no invoke function is supplied — a missing shell port is a wiring bug, and a port
 *         that silently returns no rows would make every read look like an empty database.
 */
function createTauriPort(options          )         {
  const rec = isRecord(options) ? options : {};
  const invoke = typeof rec.invoke === "function" ? rec.invoke : null;
  if (invoke === null) throw new Error("db-tauri: invoke is required (window.tauriSvc.invoke)");

  let migrated                          = null;

  /** Memoised schema migration; a rejection clears the memo so the next call retries. */
  function ensureMigrated()                   {
    if (migrated === null) {
      migrated = Promise.resolve()
        .then(() => invoke("db_migrate"))
        .then(
          (value) => value,
          (e) => {
            migrated = null;
            throw e;
          },
        );
    }
    return migrated;
  }

  /** One command after the migration gate; rows are decoded at this boundary. */
  async function runRows(cmd        , args         )                   {
    await ensureMigrated();
    let out         ;
    try {
      out = await invoke(cmd, args);
    } catch (e) {
      throw new Error("db-tauri: " + cmd + " failed (" + (e instanceof Error ? e.message : String(e)) + ")");
    }
    const rows            = Array.isArray(out) ? out : [];
    return rows.map((row) => dbWire.decodeRow(row));
  }

  async function exec(sql        , params            )                    {
    if (typeof sql !== "string" || !sql.trim()) throw new Error("db-tauri: sql is required");
    return { rows: await runRows("db_exec", { sql: sql, params: dbWire.normalizeParams(params) }) };
  }

  async function transaction   (fn                              )             {
    if (typeof fn !== "function") throw new Error("db-tauri: transaction requires a callback");
    const statements                       = [];
    const tx       = {
      exec(statementSql        , params            )       {
        if (typeof statementSql !== "string" || !statementSql.trim()) throw new Error("db-tauri: tx statement sql is required");
        statements.push({ sql: statementSql, params: dbWire.normalizeParams(params) });
      },
    };
    // A throw here skips the invoke: nothing was committed and nothing needs rolling back.
    const result = await fn(tx);
    if (statements.length > 0) {
      await ensureMigrated();
      try {
        await invoke("db_tx", { statements: statements });
      } catch (e) {
        throw new Error("db-tauri: db_tx failed (" + (e instanceof Error ? e.message : String(e)) + ")");
      }
    }
    return result;
  }

  async function search(surface               , scope             , q        , limit         )                   {
    const built = dbSearchSql.buildSearchQuery(surface, scope, q, limit);
    return runRows("db_exec", { sql: built.sql, params: dbWire.normalizeParams(built.params) });
  }

  return { exec: exec, transaction: transaction, search: search };
}

// Browser wiring, appended by l0/emit.mjs. Engine: services/platform/db-tauri.ts.
//
// The invocation is resolved per call, not captured: the shell may inject `__TAURI__` after this
// script runs, and `tauriSvc.invoke` already rejects with a readable error when the shell is absent.
// Callers may also hand in their own `opts.invoke` (tests, a future native bridge) and that wins.
(function (g) {
  "use strict";
  if (!g.dbSvc || typeof g.dbSvc.register !== "function") {
    throw new Error("db-tauri: window.dbSvc is missing (load /services/platform/db.js first)");
  }
  g.dbSvc.register("tauri", function (opts) {
    var chosen = opts && typeof opts.invoke === "function" ? opts.invoke : null;
    var invoke = chosen || function (cmd, args) {
      var t = g.tauriSvc;
      if (!t || typeof t.invoke !== "function") {
        return Promise.reject(new Error("db-tauri: window.tauriSvc.invoke is unavailable"));
      }
      return t.invoke(cmd, args);
    };
    return createTauriPort({ invoke: invoke });
  });
})(window);

globalThis.createTauriPort = createTauriPort;
})();
