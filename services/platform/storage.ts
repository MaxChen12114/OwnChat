/**
 * Native KV for the hot window: a synchronous mirror over an asynchronous store.
 *
 * Why this shape: the desktop shell keeps settings in SQLite (`kv_list` / `kv_set` / `kv_delete`),
 * which is async, while ~200 existing call sites read localStorage synchronously. Rewriting them now
 * would be a second migration stacked on T3's; instead this port preloads the namespace once, serves
 * reads from memory, and queues writes with last-write-wins coalescing per key.
 *
 * Queue contract (the part a caller must be able to reason about):
 *   · `set`/`remove` are synchronous and only touch the mirror + queue; they never await.
 *   · one key carries at most one pending op — a later `set` replaces an earlier one, and a `remove`
 *     after a set the store never saw drops the pair entirely (no write-then-delete round trip).
 *   · `flush()` drains in insertion order and stops at the first failure, re-queueing that op and the
 *     rest so the next flush retries in the same order. A newer op for the same key while a flush is
 *     in flight wins over the re-queued one.
 *   · a preload never overwrites a key that has a pending write: the write happened after the load
 *     started, so it is the newer fact.
 *
 * Reads before the preload finishes THROW instead of returning null. An empty mirror that answers
 * "no value" is indistinguishable from "this key was never written", and this repo has paid for
 * silent fallbacks repeatedly; a loud error plus `status().lastError` is the honest failure.
 *
 * `createLocalStorageKv` is the web/no-shell sibling with the same interface and no queue (writes hit
 * localStorage immediately), so a call site can take one port type and run in both hosts. Neither
 * factory publishes a global: `tooling/l0/wiring/storage.js` owns the instance and the flush listeners.
 * @module services/platform/storage
 */

/** The IO a native KV needs. `load` returns already-paired entries; order is irrelevant. */
export interface KvIo {
  load(): Promise<ReadonlyArray<readonly [string, string]>>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Outcome of one drain. `remaining` counts ops still queued (a failure keeps the rest). */
export interface FlushReport {
  readonly ok: boolean;
  readonly written: number;
  readonly deleted: number;
  readonly failed: number;
  readonly remaining: number;
}

/** Everything a status panel (or the first-run step) needs to explain the port. */
export interface KvStatus {
  readonly adapter: string;
  readonly namespace: string;
  readonly ready: boolean;
  readonly disposed: boolean;
  readonly keys: number;
  readonly pending: number;
  readonly writes: number;
  readonly deletes: number;
  readonly failures: number;
  readonly lastError: string;
}

/** The hot-window store. Sync reads/writes, async durability. */
export interface KvStorage {
  readonly v: 1;
  readonly namespace: string;
  readonly adapter: string;
  /** Resolves once the preload is in the mirror; rejects when the preload failed (then reads throw). */
  readonly ready: Promise<KvStorage>;
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  has(key: string): boolean;
  keys(): string[];
  status(): KvStatus;
  flush(): Promise<FlushReport>;
  /** Stop the auto-flush timer. Queued ops stay (a caller may still flush explicitly). */
  dispose(): void;
}

/** Options shared by both factories. */
export interface KvOptions {
  /** Namespace label for status output; the IO already carries the real namespace. */
  readonly namespace?: string;
  /** Adapter label for status output (`native` / `localStorage`). */
  readonly adapter?: string;
  /**
   * Auto-flush debounce in ms. `0` = one macrotask (coalesces synchronous bursts); a negative value
   * disables the timer and leaves every drain to an explicit `flush()`.
   */
  readonly flushDelayMs?: number;
}

/** A value as a readable string; never "[object Object]". */
function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error("kv: " + name + " must be a string");
  return value;
}

/** The browser store shape `createLocalStorageKv` needs (a `Storage`, or a test double). */
export interface LocalStorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Build the native-backed port. Nothing is read until the caller awaits `ready` (the factory kicks
 * the preload immediately, so boot pays it once in the background).
 */
export function createKvStorage(io: KvIo, options?: KvOptions): KvStorage {
  if (!io || typeof io.load !== "function" || typeof io.write !== "function" || typeof io.remove !== "function") {
    throw new Error("kv: io.load/io.write/io.remove are required");
  }
  const namespace = options && typeof options.namespace === "string" ? options.namespace : "native";
  const adapter = options && typeof options.adapter === "string" ? options.adapter : "native";
  const delay = options && typeof options.flushDelayMs === "number" ? options.flushDelayMs : 0;

  const mirror = new Map<string, string>();
  const queue = new Map<string, { op: "set" | "del"; value: string }>();
  /** Keys the store is known to hold (preload + successful writes), so a remove can be dropped. */
  const persisted = new Set<string>();
  let loaded = false;
  let loadError = "";
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let draining: Promise<FlushReport> | null = null;
  let writes = 0;
  let deletes = 0;
  let failures = 0;
  let lastError = "";

  let settleReady: (value: KvStorage) => void = () => undefined;
  let failReady: (reason: unknown) => void = () => undefined;
  const ready = new Promise<KvStorage>((resolve, reject) => {
    settleReady = resolve;
    failReady = reject;
  });

  const api: KvStorage = {
    v: 1,
    namespace: namespace,
    adapter: adapter,
    ready: ready,

    get(key: string): string | null {
      assertReadable(key);
      return mirror.get(key) ?? null;
    },

    set(key: string, value: string): void {
      requireString(key, "key");
      requireString(value, "value");
      if (disposed) throw new Error("kv: storage is disposed");
      mirror.set(key, value);
      queue.set(key, { op: "set", value: value });
      schedule();
    },

    remove(key: string): void {
      requireString(key, "key");
      if (disposed) throw new Error("kv: storage is disposed");
      mirror.delete(key);
      const pending = queue.get(key);
      // A remove after a set that never reached the store is a no-op: the key does not exist there,
      // so a delete round trip would be pure latency. Before the preload nothing is known — keep it.
      if (pending !== undefined && pending.op === "set" && !persisted.has(key) && loaded) {
        queue.delete(key);
        return;
      }
      queue.set(key, { op: "del", value: "" });
      schedule();
    },

    has(key: string): boolean {
      assertReadable(key);
      return mirror.has(key);
    },

    keys(): string[] {
      assertReadable("");
      return Array.from(mirror.keys());
    },

    status(): KvStatus {
      return {
        adapter: adapter,
        namespace: namespace,
        ready: loaded,
        disposed: disposed,
        keys: mirror.size,
        pending: queue.size,
        writes: writes,
        deletes: deletes,
        failures: failures,
        lastError: lastError,
      };
    },

    flush(): Promise<FlushReport> {
      if (draining !== null) return draining;
      if (queue.size === 0) {
        return Promise.resolve({ ok: loadError === "", written: 0, deleted: 0, failed: 0, remaining: 0 });
      }
      const batch = Array.from(queue.entries());
      queue.clear();
      let written = 0;
      let deleted = 0;
      let failed = 0;
      const run = async (): Promise<FlushReport> => {
        for (let i = 0; i < batch.length; i++) {
          const [key, op] = batch[i];
          try {
            if (op.op === "del") {
              await io.remove(key);
              persisted.delete(key);
              deleted++;
            } else {
              await io.write(key, op.value);
              persisted.add(key);
              writes++;
              written++;
            }
          } catch (e) {
            failed++;
            failures++;
            lastError = "kv: " + op.op + " " + key + " failed (" + errText(e) + ")";
            // Re-queue this op and everything after it, preserving order. A newer op for the same key
            // (a set that arrived while this flush was awaiting) stays the winner.
            for (let j = i; j < batch.length; j++) {
              const rest = batch[j];
              if (!queue.has(rest[0])) queue.set(rest[0], rest[1]);
            }
            break;
          }
        }
        if (deleted > 0) deletes += deleted;
        return { ok: failed === 0, written: written, deleted: deleted, failed: failed, remaining: queue.size };
      };
      const p = run().then(
        (report) => {
          draining = null;
          // Writes that arrived during the drain need their own turn; the timer was consumed.
          if (queue.size > 0 && delay >= 0) schedule();
          return report;
        },
        (e) => {
          draining = null;
          throw e;
        },
      );
      draining = p;
      return p;
    },

    dispose(): void {
      disposed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };

  /** Reads before the preload are an error, not an empty answer. */
  function assertReadable(key: string): void {
    if (!loaded) {
      const why = loadError ? " (" + loadError + ")" : "";
      throw new Error("kv: " + namespace + " not loaded yet" + why + (key ? " — key " + key : ""));
    }
  }

  function schedule(): void {
    if (disposed || delay < 0 || timer !== null || queue.size === 0) return;
    timer = setTimeout(() => {
      timer = null;
      void api.flush();
    }, delay);
  }

  // Preload: pending writes win over the stored value (they happened later).
  void Promise.resolve()
    .then(() => io.load())
    .then(
      (rows) => {
        const list = Array.isArray(rows) ? rows : [];
        for (const row of list) {
          if (!Array.isArray(row) || row.length < 2) continue;
          const key = String(row[0]);
          persisted.add(key);
          if (queue.has(key)) continue;
          mirror.set(key, String(row[1]));
        }
        loaded = true;
        settleReady(api);
      },
      (e) => {
        loadError = "kv: preload failed (" + errText(e) + ")";
        failures++;
        lastError = loadError;
        failReady(new Error(loadError));
      },
    );

  return api;
}

/**
 * localStorage-backed sibling: synchronous reads/writes, no queue, same interface.
 * @param store the page's `localStorage` (or a double)
 * @param options `namespace` becomes a key prefix, so two instances never collide
 */
export function createLocalStorageKv(store: LocalStorageLike, options?: KvOptions): KvStorage {
  if (!store || typeof store.getItem !== "function" || typeof store.setItem !== "function") {
    throw new Error("kv: localStorage-like store is required");
  }
  const namespace = options && typeof options.namespace === "string" ? options.namespace : "local";
  const adapter = options && typeof options.adapter === "string" ? options.adapter : "localStorage";
  const prefix = namespace + ":";
  let writes = 0;
  let deletes = 0;
  let disposed = false;
  let settleReady: (value: KvStorage) => void = () => undefined;
  const ready = new Promise<KvStorage>((resolve) => {
    settleReady = resolve;
  });
  const api: KvStorage = {
    v: 1,
    namespace: namespace,
    adapter: adapter,
    ready: ready,
    get(key: string): string | null {
      return store.getItem(prefix + requireString(key, "key"));
    },
    set(key: string, value: string): void {
      if (disposed) throw new Error("kv: storage is disposed");
      store.setItem(prefix + requireString(key, "key"), requireString(value, "value"));
      writes++;
    },
    remove(key: string): void {
      if (disposed) throw new Error("kv: storage is disposed");
      store.removeItem(prefix + requireString(key, "key"));
      deletes++;
    },
    has(key: string): boolean {
      return store.getItem(prefix + requireString(key, "key")) !== null;
    },
    keys(): string[] {
      const out: string[] = [];
      for (let i = 0; i < store.length; i++) {
        const full = store.key(i);
        if (full !== null && full.indexOf(prefix) === 0) out.push(full.slice(prefix.length));
      }
      return out;
    },
    status(): KvStatus {
      return {
        adapter: adapter,
        namespace: namespace,
        ready: true,
        disposed: disposed,
        keys: api.keys().length,
        pending: 0,
        writes: writes,
        deletes: deletes,
        failures: 0,
        lastError: "",
      };
    },
    flush(): Promise<FlushReport> {
      return Promise.resolve({ ok: true, written: 0, deleted: 0, failed: 0, remaining: 0 });
    },
    dispose(): void {
      disposed = true;
    },
  };
  settleReady(api);
  return api;
}
