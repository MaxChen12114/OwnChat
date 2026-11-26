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

import type { DbPort, DbResult, DbRow, DbTx, SearchScope, SearchSurface } from "../../core/db";

declare const dbWire: Pick<typeof import("../../core/db"), "normalizeParams" | "decodeRow">;
declare const dbSearchSql: Pick<typeof import("../../core/db-search"), "buildSearchQuery">;

/** The one shell call shape this adapter needs. */
export type TauriInvoke = (cmd: string, args?: unknown) => Promise<unknown>;

/** Options the facade's `use("tauri", opts)` passes through (the wiring supplies `invoke`). */
export interface TauriDbOptions {
  readonly invoke?: TauriInvoke;
}

interface CollectedStatement {
  sql: string;
  params: unknown[];
}

/** Object view without an assertion. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Build the shell-backed port.
 * @throws when no invoke function is supplied — a missing shell port is a wiring bug, and a port
 *         that silently returns no rows would make every read look like an empty database.
 */
export function createTauriPort(options?: unknown): DbPort {
  const rec = isRecord(options) ? options : {};
  const invoke = typeof rec.invoke === "function" ? rec.invoke : null;
  if (invoke === null) throw new Error("db-tauri: invoke is required (window.tauriSvc.invoke)");

  let migrated: Promise<unknown> | null = null;

  /** Memoised schema migration; a rejection clears the memo so the next call retries. */
  function ensureMigrated(): Promise<unknown> {
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
  async function runRows(cmd: string, args: unknown): Promise<DbRow[]> {
    await ensureMigrated();
    let out: unknown;
    try {
      out = await invoke(cmd, args);
    } catch (e) {
      throw new Error("db-tauri: " + cmd + " failed (" + (e instanceof Error ? e.message : String(e)) + ")");
    }
    const rows: unknown[] = Array.isArray(out) ? out : [];
    return rows.map((row) => dbWire.decodeRow(row));
  }

  async function exec(sql: string, params?: unknown[]): Promise<DbResult> {
    if (typeof sql !== "string" || !sql.trim()) throw new Error("db-tauri: sql is required");
    return { rows: await runRows("db_exec", { sql: sql, params: dbWire.normalizeParams(params) }) };
  }

  async function transaction<T>(fn: (tx: DbTx) => Promise<T> | T): Promise<T> {
    if (typeof fn !== "function") throw new Error("db-tauri: transaction requires a callback");
    const statements: CollectedStatement[] = [];
    const tx: DbTx = {
      exec(statementSql: string, params?: unknown[]): void {
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

  async function search(surface: SearchSurface, scope: SearchScope, q: string, limit?: number): Promise<DbRow[]> {
    const built = dbSearchSql.buildSearchQuery(surface, scope, q, limit);
    return runRows("db_exec", { sql: built.sql, params: dbWire.normalizeParams(built.params) });
  }

  return { exec: exec, transaction: transaction, search: search };
}
