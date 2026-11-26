/**
 * Realtime chat channel: local message changes become events posted to /sync/chat/events, and a
 * 1.5s poll pulls other devices' events back into localStorage.
 *
 * Everything platform-shaped arrives through {@link RealtimePorts} — storage, fetch, timers, the
 * visibility flag, the DOM event bus, and the three sibling modules (`__chatEvents` for message
 * diffs, `syncSvc` for auth and the snapshot channel, `appSvc` for the active conversation). This file
 * touches no `window`, `document` or `fetch`; l0/wiring/chat-realtime.js is the adapter.
 *
 * Three behaviours are load-bearing and easy to break:
 *  - Events for a conversation with an active turn wait in `pending`. Applying them mid-stream
 *    would replace the message array the running turn is appending to. `cfw:conv-turns` drains it.
 *  - A tombstone older than an incoming event suppresses that event. Without the comparison, a
 *    late event for a deleted conversation resurrects it and the cloud copy merges into a new one.
 *  - The read cursor advances only to the highest `seq` actually applied, never straight to
 *    `latestSeq`, because a capped response leaves the rest of the batch for the next poll.
 *
 * When the channel is unavailable (D1 unbound, older deploy, 404) the client stops itself and falls
 * back to the full-pull path once per page load, so the user never has to press anything.
 * @module services/data/chat-realtime
 */

/** Key-value storage port; the adapter wraps window.localStorage and swallows quota errors. */
export interface KvStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface HttpInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** Only the parts of a fetch response this module reads. */
export interface HttpResponse {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
}

export type HttpPort = (url: string, init?: HttpInit) => Promise<HttpResponse>;

export interface TimerPort {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** Message diffing and event shaping, owned by the chat-events module. */
export interface ChatEventPort {
  newEventId(deviceId: string): string;
  isValidMessage(msg: unknown): boolean;
  applyAppend(arr: unknown[], msg: unknown): { changed: boolean; messages: unknown[] };
  applyReplace(arr: unknown[], ev: unknown, prev: unknown): { changed: boolean; messages: unknown[] };
  diffMessages(prev: unknown[], next: unknown[]): { mode: string; added?: unknown[]; messages?: unknown[] };
  ensureMessageIds(msgs: unknown[], convId: string, deviceId: string): unknown[];
  eventFitsLimit(ev: unknown): boolean;
}

/** Cloud-sync surface the channel depends on. */
export interface SyncPort {
  authHeaders(extra?: Record<string, string>): Record<string, string>;
  syncEnabled(): boolean;
  includeChat(): boolean;
  isExcludedSession(convId: string): boolean;
  withRemoteApply<T>(fn: () => T | Promise<T>): Promise<T>;
  hashChat(text: string): string;
  pullChatNow(opts: { full?: boolean }): Promise<unknown>;
  pushChatNow(): Promise<unknown>;
  setChatConflict(convId: string, local: unknown[], remote: unknown[], createdAt: unknown): void;
  pullChatOnStartup(): void;
  getDeviceId(): string;
}

/** The parts of the app shell the channel calls back into. */
export interface AppPort {
  hasActiveTurn(convId: string): boolean;
  getActiveConvId(): string;
  applyRemoteChat(convId: string): void;
  handleRemoteConvDeleted(convId: string): void;
}

export interface RealtimePorts {
  storage: KvStorage;
  http: HttpPort;
  now(): number;
  timers: TimerPort;
  /** `document.hidden`: polling pauses in a background tab. */
  isHidden(): boolean;
  /** Dispatch a DOM event; the settings panel and the sidebar listen on these. */
  emit(name: string, detail: unknown): void;
  /** Read per call: the sibling module may finish loading after this one. */
  events(): ChatEventPort | null;
  sync(): SyncPort | null;
  app(): AppPort | null;
  /**
   * Late-bound session store. Reading the raw hot-window key would hand this channel only the last
   * ten messages and then write that shortened map back — the mirror (and the conversation on
   * screen) would lose its archived prefix on the first remote append. Absent → legacy behaviour.
   */
  sessions?(): SessionsPort | null;
}

/** The session-store surface this channel needs. */
export interface SessionsPort {
  loadAll(): Record<string, unknown>;
  applyRemote(sessions: Record<string, unknown>, opts?: { source?: string }): void;
  /** Hot-window length, so the sync hash stays over the same slice the push channel sends. */
  HOT_KEEP?: number;
}

export interface RealtimeStatus {
  state: string;
  error: string;
  lastEventAt: number;
}

const SEQ_KEY = "cfw_chat_events_seq_v1";
const QUEUE_KEY = "cfw_chat_events_queue_v1";
const PENDING_KEY = "cfw_chat_events_pending_v1";
const REALTIME_KEY = "cfw_chat_realtime_v1";
const SESSION_KEY = "cfw_chat_session_v1";
const SLOT_META_KEY = "cfw_chat_slot_meta_v1";
const TOMB_KEY = "cfw_chat_tomb_v1";
const CONV_META_KEY = "cfw_conv_meta_v1";
const SYNCED_KEY = "cfw_chat_synced_v1";
const TOKEN_KEY = "cfw_auth_token_v1";

const POLL_MS = 1500;
const FLUSH_MS = 300;
const MAX_QUEUE = 500;
const MAX_BATCH = 50;
/** The server caps a body at 1.5MB; keep headroom. */
const MAX_BODY_BYTES = 1200 * 1024;
/** A full page of events means there is probably more waiting; poll again immediately. */
const PAGE_LIMIT = 500;

type Json = Record<string, unknown>;
type Event = Json;

function recOf(value: unknown): Json {
  const out: Json = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
  const entries = Object.entries(value);
  for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  return out;
}

function arrOf(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  const out: unknown[] = [];
  for (let i = 0; i < value.length; i++) out.push(value[i]);
  return out;
}

function strOf(v: unknown): string {
  return v == null ? "" : String(v);
}

function numOf(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** `Error.message` is not enumerable, so it cannot come through {@link recOf}. */
function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : strOf(e);
}

/**
 * Build the realtime client. Nothing starts until {@link Realtime.start} is called: the wiring layer
 * decides when (on load, and again when the sync switches change).
 */
export function createRealtime(ports: RealtimePorts) {
  const storage = ports.storage;

  let running = false;
  let polling = false;
  let flushing = false;
  let pollHandle: unknown = null;
  let flushHandle: unknown = null;
  let backupHandle: unknown = null;
  let queue: Event[] = readQueue();
  let pending: Event[] = readPending();
  let lastSeq = readSeq();
  let deviceId = "";
  let status: RealtimeStatus = { state: "manual", error: "", lastEventAt: 0 };
  let fellBackToPull = false;

  function readJson(key: string): Json {
    try {
      const v = recOf(JSON.parse(storage.getItem(key) || "null"));
      return v;
    } catch (e) {
      return {};
    }
  }

  /** The conversation map as the UI sees it: the store's full-array mirror when one is mounted. */
  function readSessionMap(): Json {
    try {
      const store = typeof ports.sessions === "function" ? ports.sessions() : null;
      if (store && typeof store.loadAll === "function") return recOf(store.loadAll());
    } catch (e) {
      /* stale facade: fall back to the raw key */
    }
    return readJson(SESSION_KEY);
  }

  /** The tail the push channel serialises; the synced hash must cover the same slice. */
  function hotSlice(arr: unknown[]): unknown[] {
    let keep = 10;
    try {
      const store = typeof ports.sessions === "function" ? ports.sessions() : null;
      if (store && typeof store.HOT_KEEP === "number" && store.HOT_KEEP > 0) keep = store.HOT_KEEP;
    } catch (e) {
      /* stale facade: keep the documented default */
    }
    return arr.length > keep ? arr.slice(arr.length - keep) : arr;
  }

  /** Publish a mutated map back through the store so the mirror and the hot window stay in step. */
  function writeSessionMap(all: Json): void {
    try {
      const store = typeof ports.sessions === "function" ? ports.sessions() : null;
      if (store && typeof store.applyRemote === "function") {
        store.applyRemote(all, { source: "realtime" });
        return;
      }
    } catch (e) {
      /* fall through to the legacy write */
    }
    storage.setItem(SESSION_KEY, JSON.stringify(all));
  }

  function readSeq(): number {
    const n = parseInt(storage.getItem(SEQ_KEY) || "0", 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function writeSeq(n: unknown): void {
    lastSeq = Math.max(0, numOf(n));
    try {
      storage.setItem(SEQ_KEY, String(lastSeq));
    } catch (e) {
      /* quota: the in-memory cursor still advances for this page */
    }
  }

  function readList(key: string): Event[] {
    const raw = storage.getItem(key);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      const list = arrOf(parsed);
      return list.slice(-MAX_QUEUE).map((e) => recOf(e));
    } catch (e) {
      return [];
    }
  }

  function readQueue(): Event[] {
    return readList(QUEUE_KEY);
  }

  function readPending(): Event[] {
    return readList(PENDING_KEY);
  }

  function writeQueue(): void {
    try {
      storage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-MAX_QUEUE)));
    } catch (e) {
      /* quota: keep going, the queue also lives in memory */
    }
  }

  function writePending(): void {
    try {
      storage.setItem(PENDING_KEY, JSON.stringify(pending.slice(-MAX_QUEUE)));
    } catch (e) {
      /* same as writeQueue */
    }
  }

  function authHeaders(extra?: Record<string, string>): Record<string, string> {
    const sync = ports.sync();
    try {
      if (sync) return sync.authHeaders(extra || {});
    } catch (e) {
      /* fall through to the plain headers */
    }
    const out: Record<string, string> = {};
    const src = extra || {};
    for (const k of Object.keys(src)) out[k] = src[k];
    return out;
  }

  /**
   * Whether the channel may run at all. The token is read directly from storage instead of asking
   * `syncSvc.getStatus`, because that path calls back into `enabled` and would recurse forever.
   */
  function enabled(): boolean {
    const sync = ports.sync();
    if (!sync) return false;
    try {
      if (typeof sync.syncEnabled === "function" && !sync.syncEnabled()) return false;
      if (typeof sync.includeChat === "function" && !sync.includeChat()) return false;
      if (!storage.getItem(TOKEN_KEY)) return false;
      return storage.getItem(REALTIME_KEY) !== "0";
    } catch (e) {
      return false;
    }
  }

  function realtimeOn(): boolean {
    return storage.getItem(REALTIME_KEY) !== "0";
  }

  function setStatus(state: string, error?: unknown): void {
    status = { state, error: error ? strOf(error) : "", lastEventAt: status.lastEventAt };
    try {
      ports.emit("chat-realtime-status", status);
    } catch (e) {
      /* nobody listening */
    }
  }

  function emitDom(name: string, detail?: unknown): void {
    try {
      ports.emit(name, detail || {});
    } catch (e) {
      /* same */
    }
  }

  function hasActiveTurn(convId: string): boolean {
    const app = ports.app();
    try {
      if (app && typeof app.hasActiveTurn === "function") return !!app.hasActiveTurn(convId);
    } catch (e) {
      /* treat as idle */
    }
    return false;
  }

  function currentConvId(): string {
    const app = ports.app();
    try {
      if (app && typeof app.getActiveConvId === "function") return strOf(app.getActiveConvId());
    } catch (e) {
      /* no active conversation */
    }
    return "";
  }

  function newEvent(convId: string, type: string, payload: Json): Event {
    const events = ports.events();
    return {
      convId,
      eventId: events ? events.newEventId(deviceId) : "",
      type,
      deviceId,
      payload: payload || {},
      ts: ports.now(),
    };
  }

  function queueEvent(ev: Event): void {
    if (!ev) return;
    queue.push(ev);
    if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
    writeQueue();
    scheduleFlush();
  }

  function scheduleFlush(): void {
    if (flushHandle !== null) return;
    flushHandle = ports.timers.set(() => {
      flushHandle = null;
      flush().catch(() => {});
    }, FLUSH_MS);
  }

  /**
   * Push queued events in batches. A 400/413 drops the offending batch and keeps going: one
   * oversized or malformed event must not wedge the queue forever.
   */
  async function flush(): Promise<void> {
    if (!running || flushing || !queue.length || !enabled()) return;
    flushing = true;
    try {
      while (queue.length) {
        const batch: Event[] = [];
        let bytes = 0;
        for (const e of queue) {
          let n = MAX_BODY_BYTES;
          try {
            n = JSON.stringify(e).length;
          } catch (err) {
            n = MAX_BODY_BYTES;
          }
          if (batch.length && (batch.length >= MAX_BATCH || bytes + n > MAX_BODY_BYTES)) break;
          batch.push(e);
          bytes += n;
        }
        if (!batch.length) batch.push(queue[0]);
        const res = await ports.http("/sync/chat/events", {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ events: batch }),
        });
        if (res.status === 401) {
          setStatus("error", "密码错误");
          stop();
          return;
        }
        if (res.status === 503 || res.status === 404) {
          setStatus("manual", "实时同步不可用");
          stop();
          fallbackFullPull();
          return;
        }
        if (res.status === 400 || res.status === 413) {
          const done = idSet(batch);
          queue = queue.filter((e) => !done.has(strOf(e["eventId"])));
          writeQueue();
          setStatus("error", "事件被服务端拒绝：" + res.status);
          continue;
        }
        if (!res.ok) throw new Error("flush " + res.status);
        const done = idSet(batch);
        queue = queue.filter((e) => !done.has(strOf(e["eventId"])));
        writeQueue();
      }
    } catch (e) {
      setStatus("reconnecting", errMessage(e));
    } finally {
      flushing = false;
      if (queue.length) scheduleFlush();
    }
  }

  function idSet(batch: Event[]): Set<string> {
    const s = new Set<string>();
    for (const e of batch) s.add(strOf(e["eventId"]));
    return s;
  }

  function schedulePoll(delay?: number): void {
    if (pollHandle !== null) ports.timers.clear(pollHandle);
    pollHandle = ports.timers.set(() => {
      pollHandle = null;
      poll().catch(() => {});
    }, typeof delay === "number" ? delay : POLL_MS);
  }

  async function poll(): Promise<void> {
    if (!running) return;
    if (ports.isHidden()) {
      schedulePoll();
      return;
    }
    if (polling) return;
    if (!enabled()) {
      setStatus("manual");
      stop();
      return;
    }
    polling = true;
    let more = false;
    try {
      const url = lastSeq > 0 ? "/sync/chat/events?since=" + encodeURIComponent(String(lastSeq)) : "/sync/chat/events";
      const res = await ports.http(url, { headers: authHeaders() });
      if (res.status === 401) {
        setStatus("error", "密码错误");
        stop();
        return;
      }
      if (res.status === 503 || res.status === 404) {
        setStatus("manual", "实时同步不可用");
        stop();
        fallbackFullPull();
        return;
      }
      if (!res.ok) throw new Error("poll " + res.status);
      const data = recOf(await res.json());
      if (data["reset"]) {
        await fullResync();
        return;
      }
      if (data["bootstrap"]) {
        writeSeq(numOf(data["latestSeq"]));
        setStatus("connected");
        return;
      }
      const events = arrOf(data["events"]).map((e) => recOf(e));
      if (events.length) {
        await applyEvents(events, false);
        status.lastEventAt = ports.now();
        // Advance only to the last seq of this batch: a capped page must not skip the remainder.
        let maxSeq = lastSeq;
        for (const ev of events) maxSeq = Math.max(maxSeq, numOf(ev["seq"]));
        writeSeq(maxSeq);
      } else if (numOf(data["latestSeq"]) > lastSeq) {
        writeSeq(numOf(data["latestSeq"]));
      }
      setStatus("connected");
      more = events.length >= PAGE_LIMIT;
    } catch (e) {
      setStatus("reconnecting", errMessage(e));
    } finally {
      polling = false;
      schedulePoll(more ? 100 : POLL_MS);
    }
  }

  /**
   * Discard the local cursor and pull everything again. The baseline is read *before* the full pull
   * so events arriving in between stay for the next poll instead of being skipped.
   */
  async function fullResync(): Promise<void> {
    let latest = lastSeq;
    try {
      const res = await ports.http("/sync/chat/events", { headers: authHeaders() });
      if (res.ok) {
        const data = recOf(await res.json());
        latest = numOf(data["latestSeq"]);
      }
    } catch (e) {
      /* keep the old cursor; the pull below is still worth doing */
    }
    const sync = ports.sync();
    try {
      if (sync) await sync.pullChatNow({ full: true });
    } catch (e) {
      /* the next poll retries */
    }
    writeSeq(latest);
    setStatus("connected");
    emitDom("chat-merged", { reason: "reset" });
  }

  /** One remote event's stamp for the slot meta; server time, so clock skew cannot mark it stale. */
  function syncStatusForConv(ev: Event): Json {
    return { updatedAt: numOf(ev["createdAt"]) || ports.now(), deviceId: strOf(ev["deviceId"]) };
  }

  async function applyEvents(events: unknown[], fromPending: boolean): Promise<void> {
    if (!Array.isArray(events) || !events.length) return;
    const eventsPort = ports.events();
    const sync = ports.sync();
    const all = readSessionMap();
    const slotMeta = readJson(SLOT_META_KEY);
    const tomb = readJson(TOMB_KEY);
    const convMeta = readJson(CONV_META_KEY);
    const touched = new Set<string>();
    const deleted = new Set<string>();
    let changed = false;
    let needFullPull = false;

    for (const raw of events) {
      const ev = recOf(raw);
      const convId = strOf(ev["convId"]);
      const type = strOf(ev["type"]);
      if (!convId || !type) continue;
      if (sync && typeof sync.isExcludedSession === "function" && sync.isExcludedSession(convId)) continue;
      if (!fromPending && hasActiveTurn(convId) && type !== "conv.create" && type !== "conv.meta") {
        pending.push(ev);
        writePending();
        continue;
      }
      const payload = recOf(ev["payload"]);
      const createdAt = numOf(ev["createdAt"]) || ports.now();
      const tombOf = recOf(tomb[convId]);
      // An event older than the tombstone is a late delivery from before the delete.
      const beforeTombstone = tomb[convId] && createdAt <= numOf(tombOf["deletedAt"]);

      if (type === "msg.append") {
        if (beforeTombstone) continue;
        const msg = payload["message"];
        if (!eventsPort || !eventsPort.isValidMessage(msg)) continue;
        const arr = Array.isArray(all[convId]) ? arrOf(all[convId]) : [];
        const res = eventsPort.applyAppend(arr, msg);
        if (res.changed) {
          all[convId] = res.messages;
          touched.add(convId);
          changed = true;
        }
        if (!convMeta[convId]) {
          const meta = recOf(payload["convMeta"]);
          convMeta[convId] = Object.keys(meta).length
            ? meta
            : { name: "新对话", createdAt, updatedAt: createdAt };
          touched.add(convId);
          changed = true;
        } else if (payload["convMeta"]) {
          const cur = recOf(convMeta[convId]);
          const patch = recOf(payload["convMeta"]);
          for (const k of Object.keys(patch)) cur[k] = patch[k];
          cur["updatedAt"] = createdAt;
          convMeta[convId] = cur;
          touched.add(convId);
          changed = true;
        }
        slotMeta[convId] = syncStatusForConv(ev);
        if (tomb[convId]) {
          delete tomb[convId];
          changed = true;
        }
        changed = true;
        continue;
      }

      if (type === "conv.create") {
        const meta = recOf(payload["meta"]);
        const cur = recOf(convMeta[convId]);
        for (const k of Object.keys(meta)) cur[k] = meta[k];
        cur["updatedAt"] = createdAt;
        convMeta[convId] = cur;
        if (!Array.isArray(all[convId])) all[convId] = [];
        if (tomb[convId]) {
          delete tomb[convId];
          changed = true;
        }
        touched.add(convId);
        changed = true;
        continue;
      }

      if (type === "conv.meta") {
        const patch = recOf(payload["patch"]);
        const cur = recOf(convMeta[convId]);
        for (const k of Object.keys(patch)) cur[k] = patch[k];
        cur["updatedAt"] = createdAt;
        convMeta[convId] = cur;
        touched.add(convId);
        changed = true;
        continue;
      }

      if (type === "conv.delete") {
        tomb[convId] = { deletedAt: createdAt, deviceId: strOf(ev["deviceId"]) };
        delete all[convId];
        delete convMeta[convId];
        delete slotMeta[convId];
        deleted.add(convId);
        touched.add(convId);
        changed = true;
        continue;
      }

      if (type === "session.replace") {
        if (beforeTombstone) continue;
        const msgs = Array.isArray(payload["messages"]) ? arrOf(payload["messages"]) : null;
        if (!msgs) continue;
        const hasLocalPending = queue.some((q) => {
          const qc = strOf(q["convId"]);
          const qt = strOf(q["type"]);
          return qc === convId && (qt === "msg.append" || qt === "session.replace");
        });
        if (hasLocalPending) {
          try {
            if (sync) sync.setChatConflict(convId, Array.isArray(all[convId]) ? arrOf(all[convId]) : [], msgs, createdAt);
          } catch (e) {
            /* the next pull reconciles */
          }
          continue;
        }
        // Events arrive in seq order, so with nothing local outstanding this is the authoritative copy.
        const res = eventsPort
          ? eventsPort.applyReplace(Array.isArray(all[convId]) ? arrOf(all[convId]) : [], ev, null)
          : { changed: false, messages: [] };
        if (res.changed) {
          all[convId] = res.messages;
          slotMeta[convId] = { updatedAt: createdAt, deviceId: strOf(ev["deviceId"]) };
          if (tomb[convId]) {
            delete tomb[convId];
            changed = true;
          }
          touched.add(convId);
          changed = true;
        }
        continue;
      }

      if (type === "conv.invalidate") {
        needFullPull = true;
        continue;
      }
    }

    if (changed) {
      try {
        if (sync) {
          await sync.withRemoteApply(() => {
            writeSessionMap(all);
            storage.setItem(SLOT_META_KEY, JSON.stringify(slotMeta));
            storage.setItem(TOMB_KEY, JSON.stringify(tomb));
            storage.setItem(CONV_META_KEY, JSON.stringify(convMeta));
            const synced = readJson(SYNCED_KEY);
            for (const id of touched) {
              if (Array.isArray(all[id])) {
                // Hash the hot tail (what gets pushed), not the full mirror: a full-array hash would
                // never match the push channel and every remote apply would schedule a redundant push.
                synced[id] = { hash: sync.hashChat(JSON.stringify(hotSlice(all[id]))), syncedAt: ports.now() };
              } else {
                delete synced[id];
              }
            }
            storage.setItem(SYNCED_KEY, JSON.stringify(synced));
          });
        }
      } catch (e) {
        /* the write is best-effort; the next pull re-applies */
      }
      const cur = currentConvId();
      const app = ports.app();
      if (cur && deleted.has(cur)) {
        try {
          if (app && typeof app.handleRemoteConvDeleted === "function") app.handleRemoteConvDeleted(cur);
        } catch (e) {
          /* the shell redraws on the event below */
        }
      } else if (cur && touched.has(cur)) {
        try {
          if (app && typeof app.applyRemoteChat === "function") app.applyRemoteChat(cur);
        } catch (e) {
          /* same */
        }
      }
      emitDom("chat-merged", { reason: "realtime", touched: Array.from(touched), deleted: Array.from(deleted) });
      scheduleBackupPush();
    }
    // A big snapshot: give the sender 800ms to push the full copy before pulling it back.
    if (needFullPull) {
      ports.timers.set(() => {
        fullResync().catch(() => {});
      }, 800);
    }
  }

  function applyPending(): Promise<void> {
    if (!pending.length) return Promise.resolve();
    const list = pending.slice();
    pending = [];
    writePending();
    // Not marked as draining: a turn that started in the meantime re-queues its events.
    return applyEvents(list, false);
  }

  function scheduleBackupPush(): void {
    if (backupHandle !== null) return;
    backupHandle = ports.timers.set(() => {
      backupHandle = null;
      const sync = ports.sync();
      try {
        if (sync) sync.pushChatNow().catch(() => {});
      } catch (e) {
        /* offline; the periodic backup owns the retry */
      }
    }, 5000);
  }

  /**
   * Record a local message change as events. A message too large for one event becomes an
   * `invalidate` plus a full snapshot push, because the receiver cannot apply it incrementally.
   */
  function recordLocal(convId: string, prev: unknown, next: unknown): void {
    const eventsPort = ports.events();
    const sync = ports.sync();
    if (!enabled() || !eventsPort) return;
    if (!convId || !Array.isArray(next)) return;
    if (sync && typeof sync.isExcludedSession === "function" && sync.isExcludedSession(convId)) return;
    const diff = eventsPort.diffMessages(arrOf(prev), arrOf(next));
    if (!diff || diff.mode === "none") return;
    const convMeta = recOf(readJson(CONV_META_KEY)[convId]);
    if (diff.mode === "append") {
      const added = eventsPort.ensureMessageIds(arrOf(diff.added), convId, deviceId);
      for (const msg of added) {
        const ev = newEvent(convId, "msg.append", { message: msg, convMeta: Object.keys(convMeta).length ? convMeta : undefined });
        if (!eventsPort.eventFitsLimit(ev)) {
          queueEvent(newEvent(convId, "conv.invalidate", { reason: "message-too-large" }));
          ports.timers.set(() => {
            if (sync) sync.pushChatNow().catch(() => {});
          }, 300);
          break;
        }
        queueEvent(ev);
      }
      return;
    }
    if (diff.mode === "replace") {
      const messages = eventsPort.ensureMessageIds(arrOf(diff.messages), convId, deviceId);
      const ev = newEvent(convId, "session.replace", { rev: ports.now(), reason: "replace", messages });
      if (eventsPort.eventFitsLimit(ev)) {
        queueEvent(ev);
      } else {
        queueEvent(newEvent(convId, "conv.invalidate", { reason: "snapshot-too-large" }));
        ports.timers.set(() => {
          if (sync) sync.pushChatNow().catch(() => {});
        }, 300);
      }
    }
  }

  /** Record a conversation-level change: create, delete or metadata patch. */
  function recordConv(convId: string, meta: unknown, kind: string): void {
    const sync = ports.sync();
    if (!enabled() || !convId) return;
    if (sync && typeof sync.isExcludedSession === "function" && sync.isExcludedSession(convId)) return;
    if (kind === "create") queueEvent(newEvent(convId, "conv.create", { meta: recOf(meta) }));
    else if (kind === "delete") queueEvent(newEvent(convId, "conv.delete", { deletedAt: ports.now() }));
    else queueEvent(newEvent(convId, "conv.meta", { patch: recOf(meta) }));
  }

  async function bootstrap(): Promise<void> {
    if (lastSeq <= 0) {
      // Baseline first, snapshot second: events landing in between are covered by the next poll,
      // while the reverse order would skip everything between the snapshot and the baseline read.
      const res = await ports.http("/sync/chat/events", { headers: authHeaders() });
      if (res.status === 503 || res.status === 404) {
        setStatus("manual", "实时同步不可用");
        stop();
        fallbackFullPull();
        return;
      }
      if (!res.ok) throw new Error("bootstrap " + res.status);
      const data = recOf(await res.json());
      writeSeq(numOf(data["latestSeq"]));
      const sync = ports.sync();
      try {
        if (sync) await sync.pullChatNow({ full: true });
      } catch (e) {
        /* the next poll fills the gap */
      }
    }
    setStatus("connected");
    schedulePoll(0);
    flush().catch(() => {});
    // Events held back by an active turn before the reload: no turn survives a reload.
    if (pending.length) {
      ports.timers.set(() => {
        applyPending().catch(() => {});
      }, 0);
    }
  }

  function start(): void {
    if (running) return;
    if (!realtimeOn() || !enabled()) {
      setStatus("manual");
      return;
    }
    running = true;
    const sync = ports.sync();
    try {
      deviceId = sync && sync.getDeviceId ? strOf(sync.getDeviceId()) : "dev";
    } catch (e) {
      deviceId = "dev";
    }
    setStatus("reconnecting");
    bootstrap().catch((e) => setStatus("reconnecting", errMessage(e)));
  }

  function stop(): void {
    running = false;
    if (pollHandle !== null) {
      ports.timers.clear(pollHandle);
      pollHandle = null;
    }
    if (flushHandle !== null) {
      ports.timers.clear(flushHandle);
      flushHandle = null;
    }
    if (backupHandle !== null) {
      ports.timers.clear(backupHandle);
      backupHandle = null;
    }
    setStatus("manual");
  }

  async function catchUp(): Promise<Json> {
    if (!running) return { skipped: "off" };
    await poll();
    return { ok: true, seq: lastSeq };
  }

  /**
   * The channel is unusable (D1 unbound, older deploy, 404): fall back to the whole-snapshot pull the
   * product had before. Once per page load, so a broken endpoint cannot turn into a request storm.
   */
  function fallbackFullPull(): void {
    if (fellBackToPull) return;
    fellBackToPull = true;
    const sync = ports.sync();
    try {
      if (sync && typeof sync.pullChatOnStartup === "function") sync.pullChatOnStartup();
    } catch (e) {
      /* nothing else to try */
    }
  }

  /** Called by the wiring layer when the tab becomes visible or the network returns. */
  function wake(): void {
    if (!running) return;
    setStatus("reconnecting");
    schedulePoll(0);
  }

  function sleep(): void {
    if (running) setStatus("offline");
  }

  /** Re-evaluate the switches (sync on/off, chat included, realtime toggle, token). */
  function refreshEnabled(): void {
    if (enabled()) start();
    else stop();
  }

  function setEnabled(on: boolean): void {
    storage.setItem(REALTIME_KEY, on ? "1" : "0");
    if (on) start();
    else stop();
  }

  return {
    start,
    stop,
    isRunning: () => running,
    status: () => ({
      state: status.state,
      error: status.error,
      lastEventAt: status.lastEventAt,
      lastSeq,
      queued: queue.length,
      pending: pending.length,
      enabled: enabled(),
    }),
    recordLocal,
    recordConv,
    catchUp,
    applyPending,
    setEnabled,
    enabled: realtimeOn,
    wake,
    sleep,
    refreshEnabled,
  };
}

export type Realtime = ReturnType<typeof createRealtime>;
