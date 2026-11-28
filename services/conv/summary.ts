/**
 * Per-conversation prior summaries: the compressed early history that rides every request as
 * `priorSummary`.
 *
 * The old storage was one global key (`cfw_prior_summary_v1`), so compressing conversation A
 * injected A's plot into conversation B. This module owns the table keyed by conversation id,
 * the one-shot migration of the legacy value, and the deletion cascades. The host keeps the
 * in-memory `priorSummary` mirror because the send path reads it synchronously; every read and
 * write of that mirror goes through here.
 *
 * Storage failure policy: storage may throw (quota, private mode). A failed write leaves the
 * previous table intact and reports `false`; a failed migration keeps the legacy key in place and
 * calls the injected `warn` port, because silently dropping the only copy of an old summary is
 * data loss. A corrupt table reads as empty and warns — the next save rewrites it.
 *
 * Cloud-sync tradeoff (2026-11-26, accepted): the sync allow-list carries the new table only. An
 * in-place upgrade migrates the legacy global key locally on first boot, but a brand-new device
 * that pulls an old cloud blob will not receive that legacy summary.
 *
 * Persistent copy (T3-D, 2026-11-28): the `summaries` table (three runtimes) is fed through the
 * optional mirror port. The public API stays synchronous — localStorage is the hot read, the SQL
 * write is fire-and-forget, and `hydrate()` merges rows that exist only on the server (fresh
 * device, cleared storage) at boot. A mirror failure is reported and never changes the boolean the
 * synchronous caller reads.
 * @module services/conv/summary
 */

export interface SummaryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Report a condition the caller should see; the wiring forwards it to console.warn. */
export type SummaryWarn = (message: string, error?: unknown) => void;

/** The optional SQL copy. Every method is async; failures are swallowed by the store. */
export interface SummaryMirrorPort {
  all(): Promise<Array<Record<string, unknown>>>;
  put(convId: string, text: string, ts: number): Promise<unknown>;
  remove(convId: string): Promise<unknown>;
  clear(): Promise<unknown>;
}

export interface SummaryStore {
  /** The summary for one conversation; empty when none or when the table is unreadable. */
  load(convId: string): string;
  /** Replace the entry; an empty text removes it. Returns whether storage accepted the write. */
  save(convId: string, text: unknown): boolean;
  /** Drop one conversation's entry. Returns whether an entry existed. */
  remove(convId: string): boolean;
  /** Drop the whole table and the legacy key (the "clear all conversations" cascade). */
  clear(): void;
  /** Move the legacy global value into `convId` once, then delete the legacy key. */
  migrate(convId: string): { ok: boolean; migrated: boolean };
  /** Read-only copy for debugging and tests. */
  snapshot(): Record<string, string>;
  /** Merge summaries that exist only in the SQL copy; localStorage keeps its newer entries. */
  hydrate(): Promise<{ ok: boolean; merged: number }>;
}

export const SUMMARY_TABLE_KEY = "cfw_prior_summary_by_conv_v1";
export const SUMMARY_LEGACY_KEY = "cfw_prior_summary_v1";

/** Parse the stored table without trusting it: non-objects and non-string values are dropped. */
export function parseSummaryTable(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof raw !== "string" || !raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return out;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string" && value) out[key] = value;
  }
  return out;
}

export function createSummaryStore(storage: SummaryStorage, warn?: SummaryWarn, mirror?: SummaryMirrorPort): SummaryStore {
  const report: SummaryWarn = typeof warn === "function" ? warn : function () {};
  const sql = mirror && typeof mirror.all === "function" ? mirror : null;

  /** Fire-and-forget SQL copy: a mirror failure never changes the synchronous answer. */
  function mirrorCall(run: (port: SummaryMirrorPort) => Promise<unknown>, label: string): void {
    if (!sql) return;
    try {
      Promise.resolve(run(sql)).catch(function (e) {
        report("[summary] SQL 摘要副本" + label + "失败（本地表仍是热读）", e);
      });
    } catch (e) {
      report("[summary] SQL 摘要副本" + label + "异常（本地表仍是热读）", e);
    }
  }

  function readTable(): Record<string, string> {
    let raw: string | null = null;
    try {
      raw = storage.getItem(SUMMARY_TABLE_KEY);
    } catch (e) {
      report("[summary] 读取会话摘要表失败，按空表处理", e);
      return {};
    }
    if (!raw) return {};
    const table = parseSummaryTable(raw);
    if (!Object.keys(table).length && raw !== "{}") {
      report("[summary] 会话摘要表内容损坏，按空表处理（下次保存会重写）", raw.slice(0, 120));
    }
    return table;
  }

  function writeTable(table: Record<string, string>): boolean {
    try {
      if (!Object.keys(table).length) storage.removeItem(SUMMARY_TABLE_KEY);
      else storage.setItem(SUMMARY_TABLE_KEY, JSON.stringify(table));
      return true;
    } catch (e) {
      report("[summary] 写入会话摘要表失败（旧值保持不变）", e);
      return false;
    }
  }

  function load(convId: string): string {
    const id = String(convId || "");
    if (!id) return "";
    return readTable()[id] || "";
  }

  function save(convId: string, text: unknown): boolean {
    const id = String(convId || "");
    if (!id) return false;
    const value = String(text == null ? "" : text).trim();
    const table = readTable();
    if (!value) {
      if (!(id in table)) {
        // Local table already agrees; the SQL copy may still hold a stale row from another host.
        mirrorCall(function (port) { return port.remove(id); }, "删除");
        return true;
      }
      delete table[id];
    } else {
      table[id] = value;
    }
    const ok = writeTable(table);
    if (ok) {
      if (value) mirrorCall(function (port) { return port.put(id, value, Date.now()); }, "写入");
      else mirrorCall(function (port) { return port.remove(id); }, "删除");
    }
    return ok;
  }

  function remove(convId: string): boolean {
    const id = String(convId || "");
    if (!id) return false;
    const table = readTable();
    const existed = id in table;
    if (existed) {
      delete table[id];
      writeTable(table);
    }
    // Remove from the copy even when the local table had no entry: hydration must not resurrect a
    // summary the user deleted on this device.
    mirrorCall(function (port) { return port.remove(id); }, "删除");
    return existed;
  }

  function clear(): void {
    try {
      storage.removeItem(SUMMARY_TABLE_KEY);
    } catch (e) {
      report("[summary] 清空会话摘要表失败", e);
    }
    try {
      storage.removeItem(SUMMARY_LEGACY_KEY);
    } catch (e) {
      report("[summary] 清空旧全局摘要失败", e);
    }
    mirrorCall(function (port) { return port.clear(); }, "清空");
  }

  // The legacy value belongs to the conversation that is current at upgrade time; only that
  // conversation is allowed to adopt it. A failed table write must leave the legacy key alone.
  function migrate(convId: string): { ok: boolean; migrated: boolean } {
    const id = String(convId || "");
    if (!id) return { ok: false, migrated: false };
    let legacy = "";
    try {
      legacy = String(storage.getItem(SUMMARY_LEGACY_KEY) || "").trim();
    } catch (e) {
      report("[summary] 读取旧全局摘要失败，暂不迁移", e);
      return { ok: false, migrated: false };
    }
    if (!legacy) return { ok: true, migrated: false };
    const table = readTable();
    if (table[id]) {
      // Already migrated by an earlier boot; the legacy copy is redundant.
      try {
        storage.removeItem(SUMMARY_LEGACY_KEY);
      } catch (e) {
        report("[summary] 旧全局摘要无法删除（值已被新表覆盖）", e);
      }
      return { ok: true, migrated: false };
    }
    table[id] = legacy;
    if (!writeTable(table)) return { ok: false, migrated: false };
    mirrorCall(function (port) { return port.put(id, legacy, Date.now()); }, "迁移写入");
    try {
      storage.removeItem(SUMMARY_LEGACY_KEY);
    } catch (e) {
      report("[summary] 旧全局摘要已迁移但无法删除，下次启动会再尝试", e);
    }
    return { ok: true, migrated: true };
  }

  function snapshot(): Record<string, string> {
    return readTable();
  }

  /**
   * Boot hydration: rows that exist only in the SQL copy (fresh device, cleared storage) are
   * merged into the local table. A local entry always wins — it is the hot read the send path
   * just used, and the SQL row may lag by one fire-and-forget write.
   */
  async function hydrate(): Promise<{ ok: boolean; merged: number }> {
    if (!sql) return { ok: false, merged: 0 };
    let rows: Array<Record<string, unknown>>;
    try {
      rows = await sql.all();
    } catch (e) {
      report("[summary] 读取 SQL 摘要副本失败，按无副本处理", e);
      return { ok: false, merged: 0 };
    }
    if (!Array.isArray(rows) || !rows.length) return { ok: true, merged: 0 };
    const table = readTable();
    let merged = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row || typeof row !== "object") continue;
      const id = String(row["convId"] == null ? "" : row["convId"]);
      const text = typeof row["text"] === "string" ? row["text"].trim() : "";
      if (!id || !text || table[id]) continue;
      table[id] = text;
      merged++;
    }
    if (merged) writeTable(table);
    return { ok: true, merged: merged };
  }

  return { load, save, remove, clear, migrate, snapshot, hydrate };
}
