/**
 * Agent turn replay store — one record per agent round, every tool event kept as it happened.
 *
 * Records live in IndexedDB (`cfw_agent_trace_v1`), capped at 200 rounds and 500 events per round.
 * Every write goes through {@link redact} first: secret-looking keys are dropped whole and `sk-…` /
 * `Bearer …` inside strings are replaced, because a trace is meant to be exportable as plain JSON.
 *
 * Two decisions worth knowing. Writes go to an in-memory map *and* to IndexedDB, and reads merge
 * both with the memory copy winning — an IndexedDB round-trip is async, so a caller reading right
 * after `begin()` would otherwise see nothing. And a host without IndexedDB (or with it blocked)
 * degrades to memory-only instead of throwing: losing replay history must never break the loop.
 *
 * Lock: `tooling/scripts/test-agent-trace.mjs` (18 assertions, vm + fake IndexedDB).
 * @module services/agent/trace
 */

/** The IndexedDB surface this module uses; declared structurally so no DOM lib is required. */
export interface IdbFactoryLike {
  open(name: string, version: number): IdbOpenRequestLike;
}

interface IdbOpenRequestLike {
  result?: IdbDatabaseLike;
  onupgradeneeded?: (() => void) | null;
  onsuccess?: (() => void) | null;
  onerror?: (() => void) | null;
  onblocked?: (() => void) | null;
}

interface IdbRowsRequestLike {
  result?: TraceRecord[];
  onsuccess?: (() => void) | null;
  onerror?: (() => void) | null;
}

interface IdbDatabaseLike {
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string, opts: { keyPath: string }): IdbObjectStoreLike;
  transaction(name: string, mode: string): IdbTransactionLike;
}

interface IdbObjectStoreLike {
  createIndex(name: string, keyPath: string, opts?: { unique?: boolean }): unknown;
  put(rec: TraceRecord): unknown;
  getAll(): IdbRowsRequestLike;
  delete(id: string): unknown;
  clear(): unknown;
}

interface IdbTransactionLike {
  objectStore(name: string): IdbObjectStoreLike;
  oncomplete?: (() => void) | null;
  onerror?: (() => void) | null;
  onabort?: (() => void) | null;
}

/** One persisted round. `events` holds whatever the kernel emitted, already redacted. */
export interface TraceRecord {
  id: string;
  version: number;
  convId: string;
  kind: string;
  model: string;
  userText: string;
  startedAt: number;
  status: string;
  events: unknown[];
  finalText: string;
  stopReason: string;
  error: string;
  iterations: number;
  updatedAt?: number;
  endedAt?: number;
  durationMs?: number;
}

/** The kernel handle the decorator wraps; only `runAgentLoop` is touched. */
export interface KernelLike {
  runAgentLoop?: (opts: unknown) => unknown;
}

export interface TraceEnv {
  /**
   * Resolves the IndexedDB factory, or null when the host has none.
   * Called on the first open only; the result (including null) is cached for the instance's life.
   */
  idb(): IdbFactoryLike | null;
}

/** Frozen contract surface, mounted as `window.__agentTrace` by the wiring. */
export interface AgentTraceApi {
  begin(meta?: unknown): string;
  event(id: string, evt: unknown): boolean;
  end(id: string, patch?: unknown): boolean;
  list(convId?: unknown, limit?: unknown): Promise<TraceRecord[]>;
  get(id: string): Promise<TraceRecord | null | undefined>;
  clear(): Promise<boolean>;
  exportJSON(id: string): Promise<string>;
  redact(value: unknown, depth?: number): unknown;
  installKernelTrace(kernel: KernelLike | null | undefined, defaults?: unknown): () => void;
  _trim(): Promise<number>;
  _limits: { maxTraces: number; maxEvents: number; maxString: number };
}

const TRACE_DB_NAME = "cfw_agent_trace_v1";
const TRACE_STORE = "traces";
const TRACE_MAX_RECORDS = 200;
const TRACE_MAX_EVENTS = 500;
const TRACE_MAX_STRING = 2000;

const TRACE_SECRET_KEY =
  /^(api[-_]?key|authorization|proxy-authorization|token|access_token|refresh_token|id_token|secret|client_secret|password|passwd|cookie|set-cookie)$/i;

type AnyFn = (...args: unknown[]) => unknown;

function isFn(value: unknown): value is AnyFn {
  return typeof value === "function";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function recOf(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) out[k] = v;
  }
  return out;
}

function text(value: unknown): string {
  return value == null ? "" : typeof value === "string" ? value : String(value);
}

/**
 * Creates an isolated store. Two instances never share the memory map or the cached connection —
 * the module used to keep both at module scope, which made a second load a silent no-op.
 * @param env IndexedDB accessor; see {@link TraceEnv.idb}.
 * @returns the frozen contract surface.
 */
export function createAgentTrace(env: TraceEnv): AgentTraceApi {
  let dbPromise: Promise<IdbDatabaseLike | null> | null = null;
  /** Write-through cache: a record just written wins over the older IndexedDB copy. */
  const mem = new Map<string, TraceRecord>();

  function openDB(): Promise<IdbDatabaseLike | null> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      try {
        const factory = env.idb();
        if (!factory) {
          resolve(null);
          return;
        }
        const req = factory.open(TRACE_DB_NAME, 1);
        req.onupgradeneeded = function () {
          try {
            const db = req.result;
            if (!db) return;
            if (!db.objectStoreNames.contains(TRACE_STORE)) {
              const os = db.createObjectStore(TRACE_STORE, { keyPath: "id" });
              os.createIndex("convId", "convId", { unique: false });
              os.createIndex("startedAt", "startedAt", { unique: false });
            }
          } catch (e) {
            // A failed schema upgrade must not block the open; the next put() surfaces the real error.
          }
        };
        req.onsuccess = function () {
          resolve(req.result || null);
        };
        req.onerror = function () {
          resolve(null);
        };
        req.onblocked = function () {
          resolve(null);
        };
      } catch (e) {
        resolve(null);
      }
    });
    return dbPromise;
  }

  function put(rec: TraceRecord): Promise<boolean> {
    mem.set(rec.id, rec);
    return openDB()
      .then(function (db) {
        if (!db) return false;
        return new Promise<boolean>((resolve) => {
          try {
            const tx = db.transaction(TRACE_STORE, "readwrite");
            tx.objectStore(TRACE_STORE).put(rec);
            tx.oncomplete = function () {
              resolve(true);
            };
            tx.onerror = function () {
              resolve(false);
            };
            tx.onabort = function () {
              resolve(false);
            };
          } catch (e) {
            resolve(false);
          }
        });
      })
      .catch(function () {
        return false;
      });
  }

  function getAll(): Promise<TraceRecord[]> {
    return openDB()
      .then(function (db) {
        if (!db) return Array.from(mem.values());
        return new Promise<TraceRecord[]>((resolve) => {
          try {
            const tx = db.transaction(TRACE_STORE, "readonly");
            const req = tx.objectStore(TRACE_STORE).getAll();
            req.onsuccess = function () {
              resolve(req.result || []);
            };
            req.onerror = function () {
              resolve(Array.from(mem.values()));
            };
          } catch (e) {
            resolve(Array.from(mem.values()));
          }
        });
      })
      .catch(function () {
        return Array.from(mem.values());
      });
  }

  function scrubString(value: unknown): string {
    return String(value)
      .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
      .replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, "Bearer ***")
      .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=***")
      .slice(0, TRACE_MAX_STRING);
  }

  /**
   * Strips anything that looks like a credential, then truncates.
   * Depth is capped at 6 and breadth at 100 items / 50 keys so a cyclic or huge payload cannot hang
   * a round; a value that survives no branch is stringified rather than dropped.
   * @returns a JSON-safe copy — the input is never mutated.
   */
  function redact(value: unknown, depth?: number): unknown {
    const d = depth || 0;
    if (d > 6) return "[max-depth]";
    if (value == null) return value;
    if (typeof value === "string") return scrubString(value);
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "function") return "[function]";
    if (Array.isArray(value)) {
      const arr: unknown[] = [];
      for (let i = 0; i < value.length && i < 100; i++) arr.push(redact(value[i], d + 1));
      return arr;
    }
    if (isPlainRecord(value)) {
      const out: Record<string, unknown> = {};
      const keys = Object.keys(value);
      for (let k = 0; k < keys.length && k < 50; k++) {
        const key = keys[k];
        if (TRACE_SECRET_KEY.test(key)) continue;
        out[key] = redact(value[key], d + 1);
      }
      return out;
    }
    return String(value);
  }

  function truncate(value: unknown, n: number): string {
    const s = text(value);
    return s.length > n ? s.slice(0, n) : s;
  }

  function begin(meta?: unknown): string {
    const m = recOf(meta);
    const now = Date.now();
    const id = "tr_" + now.toString(36) + "_" + Math.random().toString(36).slice(2, 8);
    const rec: TraceRecord = {
      id: id,
      version: 1,
      convId: m.convId == null ? "" : String(m.convId),
      kind: text(m.kind) || "agent",
      model: m.model ? truncate(m.model, 120) : "",
      userText: truncate(redact(m.userText == null ? "" : m.userText), TRACE_MAX_STRING),
      startedAt: Number(m.startedAt) || now,
      status: "running",
      events: [],
      finalText: "",
      stopReason: "",
      error: "",
      iterations: 0,
    };
    put(rec);
    return id;
  }

  /**
   * Appends one kernel event. `t` is milliseconds since the round started.
   * @returns false when the round is unknown — a late event after `trim()` dropped it is not an error.
   */
  function event(id: string, evt: unknown): boolean {
    const rec = mem.get(id);
    if (!rec) return false;
    const clean = redact(evt);
    const at = Date.now() - rec.startedAt;
    let row: unknown;
    if (isPlainRecord(clean)) {
      // Redact always builds a fresh object, so writing `t` here cannot leak into the caller's data.
      clean.t = at;
      row = clean;
    } else {
      row = { t: at, value: clean };
    }
    rec.events.push(row);
    if (rec.events.length > TRACE_MAX_EVENTS) rec.events.splice(0, rec.events.length - TRACE_MAX_EVENTS);
    rec.updatedAt = Date.now();
    put(rec);
    return true;
  }

  /** Closes a round and trims the store to the newest {@link TRACE_MAX_RECORDS} records. */
  function end(id: string, patch?: unknown): boolean {
    const rec = mem.get(id);
    if (!rec) return false;
    const p = recOf(patch);
    rec.status = text(p.status) || text(p.stopReason) || "stop";
    rec.endedAt = Date.now();
    rec.durationMs = Math.max(0, rec.endedAt - rec.startedAt);
    rec.finalText = truncate(redact(p.finalText == null ? "" : p.finalText), TRACE_MAX_STRING);
    rec.stopReason = p.stopReason ? String(p.stopReason) : "";
    rec.error = truncate(redact(p.error == null ? "" : p.error), TRACE_MAX_STRING);
    rec.iterations = Number(p.iterations) || 0;
    put(rec);
    trim();
    return true;
  }

  /** Newest first, memory copy winning over the stored copy. Defaults to 20 rows. */
  function list(convId?: unknown, limit?: unknown): Promise<TraceRecord[]> {
    return getAll().then(function (rows) {
      const map = new Map<string, TraceRecord>();
      (rows || []).forEach(function (r) {
        if (r && r.id) map.set(r.id, r);
      });
      mem.forEach(function (r, id) {
        map.set(id, r);
      });
      let arr = Array.from(map.values());
      if (convId != null && convId !== "") {
        arr = arr.filter(function (r) {
          return String(r.convId || "") === String(convId);
        });
      }
      arr.sort(function (a, b) {
        return (b.startedAt || 0) - (a.startedAt || 0);
      });
      return arr.slice(0, Number(limit) > 0 ? Number(limit) : 20);
    });
  }

  function get(id: string): Promise<TraceRecord | null | undefined> {
    if (mem.has(id)) return Promise.resolve(mem.get(id));
    return getAll().then(function (rows) {
      for (let i = 0; i < rows.length; i++) if (rows[i] && rows[i].id === id) return rows[i];
      return null;
    });
  }

  function exportJSON(id: string): Promise<string> {
    return get(id).then(function (rec) {
      return rec ? JSON.stringify(rec, null, 2) : "";
    });
  }

  function clear(): Promise<boolean> {
    mem.clear();
    return openDB()
      .then(function (db) {
        if (!db) return true;
        return new Promise<boolean>((resolve) => {
          try {
            const tx = db.transaction(TRACE_STORE, "readwrite");
            tx.objectStore(TRACE_STORE).clear();
            tx.oncomplete = function () {
              resolve(true);
            };
            tx.onerror = function () {
              resolve(false);
            };
          } catch (e) {
            resolve(false);
          }
        });
      })
      .catch(function () {
        return false;
      });
  }

  /** Drops everything past the newest {@link TRACE_MAX_RECORDS}; failures are silent by design. */
  function trim(): Promise<number> {
    return getAll()
      .then(function (rows) {
        const map = new Map<string, TraceRecord>();
        (rows || []).slice().forEach(function (r) {
          if (r && r.id) map.set(r.id, r);
        });
        mem.forEach(function (r, id) {
          map.set(id, r);
        });
        const all = Array.from(map.values());
        all.sort(function (a, b) {
          return (b.startedAt || 0) - (a.startedAt || 0);
        });
        const old = all.slice(TRACE_MAX_RECORDS);
        if (!old.length) return 0;
        old.forEach(function (r) {
          mem.delete(r.id);
        });
        return openDB().then(function (db) {
          if (!db) return old.length;
          return new Promise<number>((resolve) => {
            try {
              const tx = db.transaction(TRACE_STORE, "readwrite");
              const os = tx.objectStore(TRACE_STORE);
              old.forEach(function (r) {
                try {
                  os.delete(r.id);
                } catch (e) {
                  // One missing key must not abort the whole sweep.
                }
              });
              tx.oncomplete = function () {
                resolve(old.length);
              };
              tx.onerror = function () {
                resolve(0);
              };
            } catch (e) {
              resolve(0);
            }
          });
        });
      })
      .catch(function () {
        return 0;
      });
  }

  /**
   * Wraps `kernel.runAgentLoop` so every round is recorded: a record opens before the loop starts,
   * each kernel event is appended, and the round closes on resolve *and* on reject (an AbortError
   * becomes status `aborted`, anything else `error`). The caller's own `onEvent` still runs, and a
   * failure inside the trace path is swallowed so it cannot abort a live round.
   * @returns an uninstall function that restores the original `runAgentLoop`.
   */
  function installKernelTrace(kernel: KernelLike | null | undefined, defaults?: unknown): () => void {
    if (!kernel || !isFn(kernel.runAgentLoop)) return function () {};
    const orig = kernel.runAgentLoop;
    kernel.runAgentLoop = function (opts: unknown) {
      // The caller's options object is mutated in place (onEvent is replaced), exactly as before:
      // a host that keeps its own reference expects to see the wrapper there.
      const o: Record<string, unknown> = isPlainRecord(opts) ? opts : {};
      const ctx = recOf(o.context);
      const dflt = recOf(defaults);
      const convId = (ctx.__convId != null ? ctx.__convId : dflt.convId) || "";
      const model = ctx.model || dflt.model || "";
      let userText = "";
      const msgs = Array.isArray(o.messages) ? o.messages : [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = recOf(msgs[i]);
        if (m.role === "user") {
          userText = typeof m.content === "string" ? m.content : "";
          break;
        }
      }
      const id = begin({ convId: convId, kind: "agent", model: model, userText: userText });
      const prev = o.onEvent;
      const origOnEvent = isFn(prev) ? prev : null;
      o.onEvent = function (evt: unknown) {
        try {
          event(id, evt);
        } catch (e) {
          // Tracing is diagnostic only; it must never break the round it observes.
        }
        if (origOnEvent) return origOnEvent(evt);
        return undefined;
      };
      return Promise.resolve()
        .then(function () {
          return orig.call(kernel, o);
        })
        .then(
          function (res) {
            // Direct property reads, not recOf: `stopReason`/`finalText` may be inherited getters,
            // and recOf would flatten them away.
            const r: Record<string, unknown> = isPlainRecord(res) ? res : {};
            try {
              end(id, {
                status: r.stopReason || "stop",
                stopReason: r.stopReason || "",
                finalText: r.finalText || "",
                iterations: r.iterations || 0,
              });
            } catch (e) {
              // Same reason as above: a broken close must not swallow a finished round.
            }
            return res;
          },
          function (err) {
            // `name` / `message` on an Error are non-enumerable, so they must be read off the
            // object itself — copying entries first would yield an empty record.
            const eName = isPlainRecord(err) ? text(err.name) : "";
            const eMsg = isPlainRecord(err) ? text(err.message) : "";
            try {
              end(id, {
                status: eName === "AbortError" ? "aborted" : "error",
                error: eMsg ? eMsg : String(err),
              });
            } catch (x) {
              // Same reason as above.
            }
            throw err;
          }
        );
    };
    return function uninstall() {
      kernel.runAgentLoop = orig;
    };
  }

  return {
    begin: begin,
    event: event,
    end: end,
    list: list,
    get: get,
    clear: clear,
    exportJSON: exportJSON,
    redact: redact,
    installKernelTrace: installKernelTrace,
    _trim: trim,
    _limits: { maxTraces: TRACE_MAX_RECORDS, maxEvents: TRACE_MAX_EVENTS, maxString: TRACE_MAX_STRING },
  };
}
