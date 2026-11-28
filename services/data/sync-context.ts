/**
 * Shared context for the sync engine's channel factories: the key and path constants, the storage
 * and HTTP primitives, the status bus, the switch set, the exclusion registry, the KV-quota push
 * counter, the device id, the remote-apply suppression flags and the per-channel debounce loop.
 *
 * Why this file exists: createSync used to be one ~2100-line closure and every channel reached
 * every other channel's state implicitly through that closure. After the split a channel sees
 * exactly what its {@link SyncContext} parameter carries and nothing else, so the sharing is
 * explicit at every call site. The context owns cross-channel state only; channel-private state
 * (a debounce loop instance, which loop a `markDirty` belongs to) stays inside the channel factory
 * that created it.
 *
 * One non-obvious choice: the remote-apply flags live here as one plain mutable record rather than
 * inside the chat/chars channels. The storage-write router (in sync-lifecycle) has to test both
 * flags for every same-tab write, and giving the router a third-party view of them is what keeps
 * the suppression semantics in exactly one shape.
 *
 * Dead helpers dropped while splitting: `lsGet` and `lsRemove` had no caller (each channel reads
 * `ctx.storage` directly). `requestJson` also has no caller, but its error strings are registered
 * by the i18n coverage baseline, so it moves over verbatim instead of being deleted here; the
 * exclusions registry, the switches and the device id are context-level because the main-blob,
 * chat and chars channels all consult them.
 * @module services/data/sync-context
 */
import type { HttpInit, Json, KvStorage, SyncListener, SyncPorts, TimerPort } from "./sync";
import { arrOf, recOf } from "./sync";

/** Bridge helpers shared by every fragment; `recOf` / `arrOf` stay exported in the host file. */
export function strOf(value: unknown): string {
  return value == null ? "" : String(value);
}

export function numOf(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function isRec(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function keysOf(obj: Json): string[] {
  const out: string[] = [];
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) out.push(keys[i]);
  return out;
}

/** Per-channel write-suppression view; see the module comment for why it is context-level. */
export interface RemoteApplyFlags {
  chat: boolean;
  chars: boolean;
  /** Nesting counter for withRemoteApply: the realtime module may apply inside a running merge. */
  depth: number;
}

/**
 * One channel's push loop: the inflight lock, the at-most-one queued retry and the debounce timer
 * that used to be five copies of the same three closure variables. `run` mirrors the original
 * bodies exactly: an inflight call sets the queued flag and returns `undefined`, the finally block
 * re-queues the channel's own job after {@link REQUEUE_MS}.
 */
export interface ChannelLoop {
  /** Debounce window in ms; 0 marks a channel without a debounce timer (the exclude channel). */
  readonly debounceMs: number;
  /** Schedule the channel's job after the debounce window (no-op when debounceMs is 0). */
  markDirty(): void;
  /** Drop a pending debounce without running it: a cloud wipe must not race a queued push. */
  cancelTimer(): void;
  /** Run `job` under the lock; returns `undefined` when a run was already inflight. */
  run<T>(job: () => Promise<T>): Promise<T | undefined>;
}

/** Shared delay before a queued push retries, uniform across all five channels. */
const REQUEUE_MS = 1500;

/**
 * Build the sync engine's shared context. The returned object is the whole state the channel
 * factories share; everything not on it is private to one fragment.
 */
export function createSyncContext(ports: SyncPorts): SyncContext {
  const storage = ports.storage;
  const timers: TimerPort = ports.timers;
  const now = (): number => ports.now();

  const SYNC_ENABLED_KEY = "cfw_sync_enabled_v1";
  const LAST_PUSH_KEY = "cfw_sync_last_push_v1";
  const LAST_PULL_KEY = "cfw_sync_last_pull_v1";
  const INCLUDE_CHAT_KEY = "cfw_sync_include_chat_v1";
  const PAUSE_KEY = "cfw_sync_paused_v1";
  const PUSH_COUNT_KEY = "cfw_sync_push_count_v1";
  const PUSH_COUNT_DAY_KEY = "cfw_sync_push_count_day_v1";
  /** Cloudflare KV free tier allows 1000 writes/day; warn once at 800. */
  const PUSH_DAILY_WARN = 800;
  const EXCLUDE_KEY = "cfw_sync_exclude_v1";
  /** Legacy character-card store name: this channel reads IndexedDB, never the SQL `chars` table. */
  const CHARS_DB = "tavern_chars_v2";
  const LAST_EXCLUDE_PUSH_KEY = "cfw_sync_last_exclude_push_v1";
  const LAST_EXCLUDE_PULL_KEY = "cfw_sync_last_exclude_pull_v1";
  const CHAT_SLOT_META_KEY = "cfw_chat_slot_meta_v1";
  const CHAT_TOMB_KEY = "cfw_chat_tomb_v1";
  const CHAT_CONV_META_KEY = "cfw_conv_meta_v1";
  const CHAT_SYNCED_KEY = "cfw_chat_synced_v1";
  const CHAT_CONFLICTS_KEY = "cfw_chat_conflicts_v1";
  const LAST_CHAT_PUSH_KEY = "cfw_sync_last_chat_push_v1";
  const LAST_CHAT_PULL_KEY = "cfw_sync_last_chat_pull_v1";
  const CHAT_DEVICE_ID_KEY = "cfw_device_id_v1";
  const CHAT_EVENTS_SEQ_KEY = "cfw_chat_events_seq_v1";
  const CHAT_EVENTS_QUEUE_KEY = "cfw_chat_events_queue_v1";
  const CHAT_REALTIME_KEY = "cfw_chat_realtime_v1";
  const CHARS_SYNCED_KEY = "cfw_chars_synced_v1";
  /** Local-only bookkeeping keys; writing them re-marks a channel dirty instead of the main blob. */
  const CHAT_DIRTY_KEYS = ["cfw_chat_session_v1", "cfw_chat_slot_meta_v1", "cfw_chat_tomb_v1", "cfw_conv_meta_v1"];
  const CHARS_META_KEY = "cfw_chars_meta_v1";
  const CHARS_TOMB_KEY = "cfw_chars_tomb_v1";
  const LAST_CHARS_PUSH_KEY = "cfw_sync_last_chars_push_v1";
  const LAST_CHARS_PULL_KEY = "cfw_sync_last_chars_pull_v1";
  const CHARS_DIRTY_KEYS = ["cfw_chars_meta_v1", "cfw_chars_tomb_v1"];

  const MAIN_BLOB_PATH = "/sync";
  const COST_PATH = "/sync/cost";
  const EXCLUDE_PATH = "/sync/exclude";
  const CHAT_PATH = "/sync/chat";
  const CHARS_PATH = "/sync/chars";
  const CHAT_EVENTS_PATH = "/sync/chat/events";

  const listeners = new Set<SyncListener>();

  const flags: RemoteApplyFlags = { chat: false, chars: false, depth: 0 };

  // ── storage primitives ──

  function lsSet(key: string, value: string): void {
    storage.setItem(key, value);
  }

  /**
   * Write the whole conversation map. Preferred path is the session store, which updates its
   * in-memory mirror and rewrites only the hot windows; the direct blob write is the legacy
   * fallback. A throwing facade must not abort a merge that already happened in memory, so the
   * fallback is taken on any exception.
   */
  function writeChatSessions(sessions: Json, source: string): void {
    try {
      const facade = typeof ports.sessions === "function" ? ports.sessions() : null;
      if (facade && typeof facade.applyRemote === "function") {
        facade.applyRemote(recOf(sessions), { source: source });
        return;
      }
    } catch (e) {
      /* fall through to the legacy write */
    }
    lsSet("cfw_chat_session_v1", JSON.stringify(sessions));
  }

  function lsInt(key: string): number {
    const raw = storage.getItem(key);
    return raw ? parseInt(raw, 10) || 0 : 0;
  }

  function hashStr(input: unknown): string {
    const s = input == null ? "" : String(input);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ("0000000" + h.toString(16)).slice(-8);
  }

  function readJSONArr(key: string): unknown[] {
    try {
      const value = JSON.parse(storage.getItem(key) || "");
      return Array.isArray(value) ? value : [];
    } catch (e) {
      return [];
    }
  }

  function readJSONObj(key: string, fallback: Json): Json {
    try {
      const value = JSON.parse(storage.getItem(key) || "");
      return isRec(value) ? recOf(value) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  // ── auth and switches ──

  function token(): string {
    return ports.token();
  }

  function authHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {};
    if (extra) {
      const keys = Object.keys(extra);
      for (let i = 0; i < keys.length; i++) headers[keys[i]] = extra[keys[i]];
    }
    const t = token();
    if (t) headers.Authorization = "Bearer " + t;
    return headers;
  }

  function syncEnabled(): boolean {
    return storage.getItem(SYNC_ENABLED_KEY) === "1";
  }

  function setSyncEnabled(on: boolean): void {
    storage.setItem(SYNC_ENABLED_KEY, on ? "1" : "0");
  }

  function includeChat(): boolean {
    return storage.getItem(INCLUDE_CHAT_KEY) !== "0";
  }

  function setIncludeChat(on: boolean): void {
    storage.setItem(INCLUDE_CHAT_KEY, on ? "1" : "0");
  }

  function isPaused(): boolean {
    return storage.getItem(PAUSE_KEY) === "1";
  }

  function pause(): void {
    storage.setItem(PAUSE_KEY, "1");
    emit("paused");
  }

  function resume(): void {
    storage.removeItem(PAUSE_KEY);
    emit("resumed");
  }

  // ── status bus ──

  function onStatus(fn: SyncListener): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }

  function emit(status: string, detail?: unknown): void {
    listeners.forEach((fn) => {
      try {
        fn(status, detail);
      } catch (e) {
        /* a UI listener must not break the sync loop */
      }
    });
  }

  // ── channel HTTP: auth-checked verbs shared by all five channels ──

  // No current caller, kept verbatim: its error strings are registered by the i18n coverage gate,
  // and dropping the helper would silently change that contract from a structural cleanup.
  async function requestJson(path: string, init?: HttpInit): Promise<unknown> {
    if (!token()) throw new Error("未启用云同步（缺 token）");
    const res = await ports.http(path, init);
    if (res.status === 401) throw new Error("密码错误");
    if (!res.ok) throw new Error("请求失败: " + res.status);
    return res.json();
  }

  async function getChannel(path: string, label: string): Promise<Json | null> {
    if (!token()) throw new Error("未启用云同步(缺 token)");
    const res = await ports.http(path, { headers: authHeaders() });
    if (res.status === 401) throw new Error("密码错误");
    if (!res.ok) throw new Error("拉取" + label + "失败: " + res.status);
    const text = await res.text();
    if (!text || text === "null") return null;
    try {
      const parsed = JSON.parse(text);
      return isRec(parsed) ? recOf(parsed) : null;
    } catch (e) {
      return null;
    }
  }

  async function putChannel(path: string, body: unknown, label: string): Promise<Json> {
    if (!token()) throw new Error("未启用云同步(缺 token)");
    const res = await ports.http(path, {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (res.status === 401) throw new Error("密码错误");
    if (!res.ok) throw new Error("推送" + label + "失败: " + res.status);
    return recOf(await res.json());
  }

  async function deleteChannel(path: string, label: string): Promise<Json> {
    if (!token()) throw new Error("未启用云同步(缺 token)");
    const res = await ports.http(path, { method: "DELETE", headers: authHeaders() });
    if (res.status === 401) throw new Error("密码错误");
    if (!res.ok) throw new Error("删除" + label + "失败: " + res.status);
    try {
      return recOf(await res.json());
    } catch (e) {
      return {};
    }
  }

  // ── push counter (KV quota watch) ──

  function incrPushCount(): number {
    const today = new Date(now()).toISOString().slice(0, 10);
    const prevDay = storage.getItem(PUSH_COUNT_DAY_KEY);
    let n = parseInt(storage.getItem(PUSH_COUNT_KEY) || "0", 10) || 0;
    if (prevDay !== today) {
      n = 0;
      storage.setItem(PUSH_COUNT_DAY_KEY, today);
    }
    n += 1;
    storage.setItem(PUSH_COUNT_KEY, String(n));
    if (n === PUSH_DAILY_WARN) emit("warn", { reason: "kv-quota", today: today, count: n });
    return n;
  }

  // ── device id (the metering bucket, shared by chat and chars merges) ──

  function chatDeviceId(): string {
    let id = storage.getItem(CHAT_DEVICE_ID_KEY);
    if (!id) {
      id = "dev_" + now().toString(36) + ports.random().toString(36).slice(2, 8);
      try {
        storage.setItem(CHAT_DEVICE_ID_KEY, id);
      } catch (e) {
        /* a per-call id is still usable; it just loses the stable bucket */
      }
    }
    return id;
  }

  // ── remote-apply suppression ──

  /**
   * Run `fn` with writes suppressed from re-marking the chat channel dirty. Nested calls are
   * counted: the realtime module may apply an event inside a merge the sync engine started.
   */
  async function withRemoteApply<T>(fn: () => T | Promise<T>): Promise<T> {
    flags.depth++;
    flags.chat = true;
    try {
      return await fn();
    } finally {
      flags.depth = Math.max(0, flags.depth - 1);
      if (flags.depth === 0) flags.chat = false;
    }
  }

  // ── exclusion registry ( consulted by the main blob, chat and chars channels) ──

  function normKind(kind: string): string {
    return kind === "session" ? "session" : "role";
  }

  function entryId(kind: string, key: string): string {
    return normKind(kind) + ":" + key;
  }

  function getRegistry(): Json {
    const parsed = readJSONObj(EXCLUDE_KEY, {});
    const entries = parsed["entries"];
    if (isRec(entries)) return { entries: recOf(entries) };
    // Legacy flat shape { roles, sessions } migrates to per-entry records stamped ts=1, so any new
    // operation wins the LWW comparison immediately.
    const migrated: Json = {};
    const roles = arrOf(parsed["roles"]);
    for (let i = 0; i < roles.length; i++) {
      const k = roles[i];
      if (typeof k === "string" && k) migrated[entryId("role", k)] = { kind: "role", key: k, state: "excluded", ts: 1 };
    }
    const sessions = arrOf(parsed["sessions"]);
    for (let i = 0; i < sessions.length; i++) {
      const k = sessions[i];
      if (typeof k === "string" && k) migrated[entryId("session", k)] = { kind: "session", key: k, state: "excluded", ts: 1 };
    }
    return { entries: migrated };
  }

  function setRegistry(reg: Json): void {
    storage.setItem(EXCLUDE_KEY, JSON.stringify({ entries: isRec(reg["entries"]) ? recOf(reg["entries"]) : {} }));
  }

  function registryEntries(reg: Json): Json {
    const entries = reg["entries"];
    return isRec(entries) ? recOf(entries) : {};
  }

  /** Downstream callers still consume the flat { roles, sessions } view; only excluded counts. */
  function getExcluded(): { roles: string[]; sessions: string[] } {
    const entries = registryEntries(getRegistry());
    const roles: string[] = [];
    const sessions: string[] = [];
    const ids = keysOf(entries);
    for (let i = 0; i < ids.length; i++) {
      const entry = recOf(entries[ids[i]]);
      if (strOf(entry["state"]) !== "excluded") continue;
      const key = entry["key"];
      if (typeof key !== "string" || !key) continue;
      if (entry["kind"] === "session") sessions.push(key);
      else roles.push(key);
    }
    return { roles: roles, sessions: sessions };
  }

  function addExclusion(kind: string, key: string): void {
    if (!key) return;
    const reg = getRegistry();
    const entries = registryEntries(reg);
    entries[entryId(kind, key)] = { kind: normKind(kind), key: key, state: "excluded", ts: now() };
    setRegistry({ entries: entries });
  }

  function removeExclusion(kind: string, key: string): void {
    if (!key) return;
    const reg = getRegistry();
    const entries = registryEntries(reg);
    // The entry is kept and flipped to "restored" with a fresh timestamp: only that lets a restore
    // override an older exclusion made on another device.
    entries[entryId(kind, key)] = { kind: normKind(kind), key: key, state: "restored", ts: now() };
    setRegistry({ entries: entries });
  }

  function mergeRegistries(a: Json, b: Json): Json {
    const ea = registryEntries(a);
    const eb = registryEntries(b);
    const out: Json = {};
    const ids = new Set<string>();
    keysOf(ea).forEach((k) => ids.add(k));
    keysOf(eb).forEach((k) => ids.add(k));
    ids.forEach((id) => {
      const x = ea[id];
      const y = eb[id];
      const xOk = isRec(x) && typeof recOf(x)["ts"] === "number";
      const yOk = isRec(y) && typeof recOf(y)["ts"] === "number";
      if (xOk && yOk) out[id] = numOf(recOf(y)["ts"]) >= numOf(recOf(x)["ts"]) ? y : x;
      else out[id] = xOk ? x : y;
    });
    return { entries: out };
  }

  // ── per-channel bookkeeping readers (lock-free storage reads shared by merge/conflict/channels) ──

  function getChatSessions(): Json {
    return readJSONObj("cfw_chat_session_v1", {});
  }

  function getChatSlotMeta(): Json {
    return readJSONObj(CHAT_SLOT_META_KEY, {});
  }

  function getChatTomb(): Json {
    return readJSONObj(CHAT_TOMB_KEY, {});
  }

  function getChatSynced(): Json {
    return readJSONObj(CHAT_SYNCED_KEY, {});
  }

  function getConvMetaMap(): Json {
    return readJSONObj(CHAT_CONV_META_KEY, {});
  }

  function getCharsMeta(): Json {
    return readJSONObj(CHARS_META_KEY, {});
  }

  function getCharsTomb(): Json {
    return readJSONObj(CHARS_TOMB_KEY, {});
  }

  function getCharsSynced(): Json {
    return readJSONObj(CHARS_SYNCED_KEY, {});
  }

  // ── the shared-loop factory ──

  function makeChannelLoop(opts: { debounceMs: number; job: () => Promise<unknown> }): ChannelLoop {
    let timer: unknown = null;
    let running = false;
    let queued = false;
    function schedule(job: () => Promise<unknown>): void {
      timer = timers.set(function () {
        timer = null;
        void run(job);
      }, REQUEUE_MS);
    }
    async function run<T>(job: () => Promise<T>): Promise<T | undefined> {
      if (running) {
        queued = true;
        return undefined;
      }
      running = true;
      try {
        return await job();
      } finally {
        running = false;
        if (queued) {
          queued = false;
          schedule(opts.job);
        }
      }
    }
    return {
      debounceMs: opts.debounceMs,
      markDirty(): void {
        if (opts.debounceMs <= 0) return;
        if (timer) timers.clear(timer);
        timer = timers.set(function () {
          timer = null;
          void run(opts.job);
        }, opts.debounceMs);
      },
      cancelTimer(): void {
        if (timer) {
          timers.clear(timer);
          timer = null;
        }
      },
      run: run,
    };
  }

  return {
    ports: ports,
    storage: storage,
    timers: timers,
    now: now,
    SYNC_ENABLED_KEY: SYNC_ENABLED_KEY,
    LAST_PUSH_KEY: LAST_PUSH_KEY,
    LAST_PULL_KEY: LAST_PULL_KEY,
    INCLUDE_CHAT_KEY: INCLUDE_CHAT_KEY,
    PAUSE_KEY: PAUSE_KEY,
    PUSH_COUNT_KEY: PUSH_COUNT_KEY,
    PUSH_COUNT_DAY_KEY: PUSH_COUNT_DAY_KEY,
    PUSH_DAILY_WARN: PUSH_DAILY_WARN,
    EXCLUDE_KEY: EXCLUDE_KEY,
    CHARS_DB: CHARS_DB,
    LAST_EXCLUDE_PUSH_KEY: LAST_EXCLUDE_PUSH_KEY,
    LAST_EXCLUDE_PULL_KEY: LAST_EXCLUDE_PULL_KEY,
    CHAT_SLOT_META_KEY: CHAT_SLOT_META_KEY,
    CHAT_TOMB_KEY: CHAT_TOMB_KEY,
    CHAT_CONV_META_KEY: CHAT_CONV_META_KEY,
    CHAT_SYNCED_KEY: CHAT_SYNCED_KEY,
    CHAT_CONFLICTS_KEY: CHAT_CONFLICTS_KEY,
    LAST_CHAT_PUSH_KEY: LAST_CHAT_PUSH_KEY,
    LAST_CHAT_PULL_KEY: LAST_CHAT_PULL_KEY,
    CHAT_DEVICE_ID_KEY: CHAT_DEVICE_ID_KEY,
    CHAT_EVENTS_SEQ_KEY: CHAT_EVENTS_SEQ_KEY,
    CHAT_EVENTS_QUEUE_KEY: CHAT_EVENTS_QUEUE_KEY,
    CHAT_REALTIME_KEY: CHAT_REALTIME_KEY,
    CHARS_SYNCED_KEY: CHARS_SYNCED_KEY,
    CHAT_DIRTY_KEYS: CHAT_DIRTY_KEYS,
    CHARS_META_KEY: CHARS_META_KEY,
    CHARS_TOMB_KEY: CHARS_TOMB_KEY,
    LAST_CHARS_PUSH_KEY: LAST_CHARS_PUSH_KEY,
    LAST_CHARS_PULL_KEY: LAST_CHARS_PULL_KEY,
    CHARS_DIRTY_KEYS: CHARS_DIRTY_KEYS,
    MAIN_BLOB_PATH: MAIN_BLOB_PATH,
    COST_PATH: COST_PATH,
    EXCLUDE_PATH: EXCLUDE_PATH,
    CHAT_PATH: CHAT_PATH,
    CHARS_PATH: CHARS_PATH,
    CHAT_EVENTS_PATH: CHAT_EVENTS_PATH,
    lsSet: lsSet,
    writeChatSessions: writeChatSessions,
    lsInt: lsInt,
    hashStr: hashStr,
    readJSONArr: readJSONArr,
    readJSONObj: readJSONObj,
    token: token,
    authHeaders: authHeaders,
    syncEnabled: syncEnabled,
    setSyncEnabled: setSyncEnabled,
    includeChat: includeChat,
    setIncludeChat: setIncludeChat,
    isPaused: isPaused,
    pause: pause,
    resume: resume,
    onStatus: onStatus,
    emit: emit,
    getChannel: getChannel,
    putChannel: putChannel,
    deleteChannel: deleteChannel,
    incrPushCount: incrPushCount,
    chatDeviceId: chatDeviceId,
    flags: flags,
    withRemoteApply: withRemoteApply,
    normKind: normKind,
    entryId: entryId,
    getRegistry: getRegistry,
    setRegistry: setRegistry,
    registryEntries: registryEntries,
    getExcluded: getExcluded,
    addExclusion: addExclusion,
    removeExclusion: removeExclusion,
    mergeRegistries: mergeRegistries,
    getChatSessions: getChatSessions,
    getChatSlotMeta: getChatSlotMeta,
    getChatTomb: getChatTomb,
    getChatSynced: getChatSynced,
    getConvMetaMap: getConvMetaMap,
    getCharsMeta: getCharsMeta,
    getCharsTomb: getCharsTomb,
    getCharsSynced: getCharsSynced,
    makeChannelLoop: makeChannelLoop,
  };
}

/** Everything the sync fragments share; each fragment receives this one object. */
export interface SyncContext {
  ports: SyncPorts;
  storage: KvStorage;
  timers: TimerPort;
  now(): number;
  SYNC_ENABLED_KEY: string;
  LAST_PUSH_KEY: string;
  LAST_PULL_KEY: string;
  INCLUDE_CHAT_KEY: string;
  PAUSE_KEY: string;
  PUSH_COUNT_KEY: string;
  PUSH_COUNT_DAY_KEY: string;
  PUSH_DAILY_WARN: number;
  EXCLUDE_KEY: string;
  CHARS_DB: string;
  LAST_EXCLUDE_PUSH_KEY: string;
  LAST_EXCLUDE_PULL_KEY: string;
  CHAT_SLOT_META_KEY: string;
  CHAT_TOMB_KEY: string;
  CHAT_CONV_META_KEY: string;
  CHAT_SYNCED_KEY: string;
  CHAT_CONFLICTS_KEY: string;
  LAST_CHAT_PUSH_KEY: string;
  LAST_CHAT_PULL_KEY: string;
  CHAT_DEVICE_ID_KEY: string;
  CHAT_EVENTS_SEQ_KEY: string;
  CHAT_EVENTS_QUEUE_KEY: string;
  CHAT_REALTIME_KEY: string;
  CHARS_SYNCED_KEY: string;
  CHAT_DIRTY_KEYS: string[];
  CHARS_META_KEY: string;
  CHARS_TOMB_KEY: string;
  LAST_CHARS_PUSH_KEY: string;
  LAST_CHARS_PULL_KEY: string;
  CHARS_DIRTY_KEYS: string[];
  MAIN_BLOB_PATH: string;
  COST_PATH: string;
  EXCLUDE_PATH: string;
  CHAT_PATH: string;
  CHARS_PATH: string;
  CHAT_EVENTS_PATH: string;
  lsSet(key: string, value: string): void;
  writeChatSessions(sessions: Json, source: string): void;
  lsInt(key: string): number;
  hashStr(input: unknown): string;
  readJSONArr(key: string): unknown[];
  readJSONObj(key: string, fallback: Json): Json;
  token(): string;
  authHeaders(extra?: Record<string, string>): Record<string, string>;
  syncEnabled(): boolean;
  setSyncEnabled(on: boolean): void;
  includeChat(): boolean;
  setIncludeChat(on: boolean): void;
  isPaused(): boolean;
  pause(): void;
  resume(): void;
  onStatus(fn: SyncListener): () => void;
  emit(status: string, detail?: unknown): void;
  getChannel(path: string, label: string): Promise<Json | null>;
  putChannel(path: string, body: unknown, label: string): Promise<Json>;
  deleteChannel(path: string, label: string): Promise<Json>;
  incrPushCount(): number;
  chatDeviceId(): string;
  flags: RemoteApplyFlags;
  withRemoteApply<T>(fn: () => T | Promise<T>): Promise<T>;
  normKind(kind: string): string;
  entryId(kind: string, key: string): string;
  getRegistry(): Json;
  setRegistry(reg: Json): void;
  registryEntries(reg: Json): Json;
  getExcluded(): { roles: string[]; sessions: string[] };
  addExclusion(kind: string, key: string): void;
  removeExclusion(kind: string, key: string): void;
  mergeRegistries(a: Json, b: Json): Json;
  getChatSessions(): Json;
  getChatSlotMeta(): Json;
  getChatTomb(): Json;
  getChatSynced(): Json;
  getConvMetaMap(): Json;
  getCharsMeta(): Json;
  getCharsTomb(): Json;
  getCharsSynced(): Json;
  makeChannelLoop(opts: { debounceMs: number; job: () => Promise<unknown> }): ChannelLoop;
}
