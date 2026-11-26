/**
 * Session persistence: the hot window in localStorage plus the cold projection behind it.
 *
 * localStorage is no longer the history: it holds the last {@link HOT_KEEP} messages of each
 * conversation (and the summary lives in its own per-conversation key). Everything older is the
 * cold projection of `session_events` (see services/session/events.ts for the truth/projection
 * split). The synchronous API is unchanged on purpose — the engine reads `loadAllSessions()` at
 * page init — so this module keeps a page-lifetime `mirror` of full arrays:
 *
 *   · `prime()` seeds the mirror from localStorage and the pending-archive spill at creation;
 *   · `boot()` migrates the legacy full localStorage blob into events once, then hydrates the
 *     cold projection into the mirror; `onHydrated` lets the host repaint the active conversation;
 *   · `persistSessionForConv` writes the hot window, queues everything that fell out of it for
 *     archival and flushes the queue in the background. A failed archive stays in the spill key
 *     (`cfw_chat_cold_pending_v1`), so a reload merges it back instead of losing it.
 *
 * The guards that must not regress:
 *  - The size trim works on a copy. Trimming the live array would silently drop history the model
 *    is still using; only the stored copy is shortened.
 *  - The overshoot is estimated once from the average message size, then corrected in steps. The
 *    previous version re-serialised the whole blob every two messages, which was quadratic.
 *  - The write-back diff needs the array from *before* this write, so it is captured before the
 *    in-memory slot is replaced. It still receives the full array: the realtime channel diffs what
 *    the conversation is, not what the hot window is.
 *  - Migration only trims after the archive transaction succeeded; a failure keeps the original
 *    blob untouched for the next boot.
 * @module services/session/store
 */

export interface KvStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Message shape is left open: the service only passes through, shallow-copies and counts. */
export type Msg = Record<string, unknown>;
export type MsgArr = Msg[];

/** Messages kept in localStorage per conversation; the rest is the cold projection. */
const HOT_KEEP = 10;

/** Spill for messages already evicted from the hot window but not yet archived. */
const LS_CHAT_COLD_PENDING = "cfw_chat_cold_pending_v1";

/** One-shot marker: conversation id → epoch ms. A marked conversation is already archived. */
const LS_SESSION_EVENTS_MIGRATED = "cfw_session_events_migrated_v1";

/** The cold side of the store: the projection loader and the archive writer. */
export interface SessionColdPort {
  load(convId: string): Promise<MsgArr>;
  archive(convId: string, messages: MsgArr): Promise<{ ok: boolean; known?: string[]; appended?: number; error?: string }>;
  remove?(convId: string): Promise<unknown>;
  clearAll?(): Promise<unknown>;
}

export interface SessionStoreHost {
  getDeviceId?(): string;
  getHistoryEnabled?(): boolean;
  getMemSlots?(): Record<string, MsgArr>;
  getSession?(): MsgArr;
  currentSlotKey?(): string;
  touchConv?(convId: string, patch: Record<string, unknown>): void;
  isConvId?(id: string): boolean;
  getConvMeta?(): Record<string, unknown>;
  saveConvMeta?(m: Record<string, unknown>): void;
  ensureMessageIds?(arr: MsgArr, convId: string, deviceId: string): MsgArr;
  getChatSlotMeta?(): Record<string, unknown> | null;
  recordLocal?(convId: string, prev: MsgArr | null, next: MsgArr): void;
  /** Late lookup: the events service is loaded but its DbPort resolves on first use. */
  cold?(): SessionColdPort | null;
  /** Called after a conversation's cold projection was merged into the mirror. */
  onHydrated?(convId: string, full: MsgArr): void;
  warn?(message: string, error?: unknown): void;
}

export interface SessionStorePorts {
  storage: KvStorage;
}

export interface SessionStore {
  LS_CHAT_SESSION: string;
  LS_CHAT_SLOT_META: string;
  LS_CHAT_TOMB: string;
  LS_CHAT_COLD_PENDING: string;
  LS_SESSION_EVENTS_MIGRATED: string;
  LS_LIMIT: number;
  HOT_KEEP: number;
  loadAllSessions(): Record<string, unknown>;
  saveAllSessions(all: Record<string, unknown>): void;
  bumpSlotMeta(slotKey: string): void;
  writeChatTombstone(slotKey: string): void;
  purgeLegacyConvs(): void;
  persistSessionForConv(convId: string, arr: MsgArr): void;
  persistSessionIfEnabled(): void;
  /** Replace the stored blob with the caller's JSON (hot windows; full arrays update the mirror). */
  writeSessionBlob(json: string): void;
  /**
   * Whole-map apply coming from outside this page (remote sync / realtime events). The incoming
   * arrays are hot tails: they are merged onto the mirror by message id, then the hot window is
   * rewritten, so `loadAllSessions()` and the conversation the UI renders see the same messages.
   * A direct localStorage write would leave the mirror stale and let the next persist resurrect the
   * pre-merge tail; a blind replace would drop the page's archived prefix from the mirror.
   * Conversations absent from the map are removals.
   */
  applyRemote(sessions: Record<string, unknown>, opts?: { source?: string }): void;
  /** Stamp of the last `applyRemote` call (null before the first one). */
  lastRemote(): { at: number; source: string; keys: number } | null;
  /** Drop the stored blob and every in-memory copy (last conversation deleted). */
  removeSessionBlob(): void;
  /** Clear-all: same as removing the blob, used by the settings "clear history" cascade. */
  reset(): void;
  /** Legacy full blob → events, once per conversation; then hydrate the cold projection. */
  boot(): Promise<void>;
  hydrate(): Promise<void>;
  migrateLegacy(): Promise<void>;
  /** Await every in-flight archive queue (tests and shutdown). */
  flush(): Promise<void>;
}

export function createSessionStore(ports: SessionStorePorts, host?: SessionStoreHost): SessionStore {
  const h = host || {};
  const storage = ports.storage;
  const LS_CHAT_SESSION = "cfw_chat_session_v1";
  const LS_CHAT_SLOT_META = "cfw_chat_slot_meta_v1";
  const LS_CHAT_TOMB = "cfw_chat_tomb_v1";
  const LS_LIMIT = 2 * 1024 * 1024;

  const getDeviceId = typeof h.getDeviceId === "function" ? h.getDeviceId : function () { return "dev_unknown"; };
  const getHistoryEnabled = typeof h.getHistoryEnabled === "function" ? h.getHistoryEnabled : function () { return true; };
  const getMemSlots = typeof h.getMemSlots === "function" ? h.getMemSlots : function () { return {}; };
  const getSession = typeof h.getSession === "function" ? h.getSession : function () { return []; };
  const currentSlotKey = typeof h.currentSlotKey === "function" ? h.currentSlotKey : function () { return ""; };
  const touchConv = typeof h.touchConv === "function" ? h.touchConv : function () {};
  const isConvId = typeof h.isConvId === "function" ? h.isConvId : function () { return false; };
  const getConvMeta = typeof h.getConvMeta === "function" ? h.getConvMeta : function () { return {}; };
  const saveConvMeta = typeof h.saveConvMeta === "function" ? h.saveConvMeta : function () {};
  const ensureMessageIds = typeof h.ensureMessageIds === "function" ? h.ensureMessageIds : null;
  const getChatSlotMeta = typeof h.getChatSlotMeta === "function" ? h.getChatSlotMeta : null;
  const recordLocal = typeof h.recordLocal === "function" ? h.recordLocal : null;
  const cold = typeof h.cold === "function" ? h.cold : function () { return null; };
  const onHydrated = typeof h.onHydrated === "function" ? h.onHydrated : null;
  const warn = typeof h.warn === "function" ? h.warn : function () {};

  /** Full arrays for every conversation the page has touched; localStorage holds only hot tails. */
  const mirror: Record<string, MsgArr> = {};
  /** Evicted-but-not-archived messages per conversation (also persisted in the spill key). */
  const pending: Record<string, MsgArr> = {};
  /** Message ids confirmed present in the projection; prevents requeueing on every persist. */
  const archived: Record<string, Record<string, 1>> = {};
  /** One in-flight archive per conversation. */
  const queue: Record<string, Promise<void>> = {};
  let bootPromise: Promise<void> | null = null;
  /** Diagnostics for the last whole-map apply (source and conversation count). */
  let lastRemoteApply: { at: number; source: string; keys: number } | null = null;

  function readLsSessions(): Record<string, unknown> {
    try {
      const raw = storage.getItem(LS_CHAT_SESSION);
      if (!raw) return {};
      const obj: unknown = JSON.parse(raw);
      if (Array.isArray(obj)) return { __none__: obj };
      return (typeof obj === "object" && obj !== null) ? toRecord(obj) : {};
    } catch (e) { return {}; }
  }

  function writeLsSessions(all: Record<string, unknown>): void {
    try {
      if (all && Object.keys(all).length) storage.setItem(LS_CHAT_SESSION, JSON.stringify(all));
      else storage.removeItem(LS_CHAT_SESSION);
    } catch (e) {}
  }

  function readJsonRecord(key: string): Record<string, unknown> {
    try {
      const raw = storage.getItem(key);
      if (!raw) return {};
      const obj: unknown = JSON.parse(raw);
      return (typeof obj === "object" && obj !== null && !Array.isArray(obj)) ? toRecord(obj) : {};
    } catch (e) { return {}; }
  }

  function readPending(): Record<string, MsgArr> {
    const raw = readJsonRecord(LS_CHAT_COLD_PENDING);
    const out: Record<string, MsgArr> = {};
    for (const key of Object.keys(raw)) {
      const arr = raw[key];
      if (!Array.isArray(arr)) continue;
      const clean: MsgArr = [];
      for (let i = 0; i < arr.length; i++) {
        const m = arr[i];
        if (m && typeof m === "object" && !Array.isArray(m)) clean.push(m);
      }
      if (clean.length) out[key] = clean;
    }
    return out;
  }

  function writePending(): void {
    try {
      const out: Record<string, MsgArr> = {};
      let any = false;
      for (const key of Object.keys(pending)) {
        const arr = pending[key];
        if (Array.isArray(arr) && arr.length) { out[key] = arr; any = true; }
      }
      if (any) storage.setItem(LS_CHAT_COLD_PENDING, JSON.stringify(out));
      else storage.removeItem(LS_CHAT_COLD_PENDING);
    } catch (e) {}
  }

  function readMigrated(): Record<string, unknown> {
    return readJsonRecord(LS_SESSION_EVENTS_MIGRATED);
  }

  function writeMigrated(marker: Record<string, unknown>): void {
    try {
      if (Object.keys(marker).length) storage.setItem(LS_SESSION_EVENTS_MIGRATED, JSON.stringify(marker));
      else storage.removeItem(LS_SESSION_EVENTS_MIGRATED);
    } catch (e) {}
  }

  function copyMsg(m: unknown): Msg {
    const out: Msg = {};
    if (m && typeof m === "object" && !Array.isArray(m)) {
      for (const [k, v] of Object.entries(m)) out[k] = v;
    }
    return out;
  }

  function copyArr(arr: MsgArr): MsgArr {
    const out: MsgArr = [];
    for (let i = 0; i < arr.length; i++) out.push(copyMsg(arr[i]));
    return out;
  }

  function idOf(m: unknown): string {
    if (!m || typeof m !== "object" || Array.isArray(m)) return "";
    const id = Reflect.get(m, "id");
    return typeof id === "string" ? id : "";
  }

  /**
   * Give hot-tail messages their stable ids before they go back to storage or into the mirror.
   * The device argument is deliberately blank: the legacy id derivation is conv+index+content and
   * ignores it, while reading the host device id here would throw during the first fragment of the
   * boot script (the id minter lives in a later fragment) and leave an id-less tail behind.
   */
  function withIds(convId: string, arr: MsgArr): MsgArr {
    if (!ensureMessageIds) return arr;
    try { return ensureMessageIds(arr, convId, ""); } catch (e) { return arr; }
  }

  /**
   * Merge a cold prefix with the hot tail. Ids win: a hot message replaces the cold copy in place
   * and messages without ids are appended as-is (legacy rows the caller did not normalise).
   */
  function mergeColdHot(coldArr: MsgArr, hotArr: MsgArr): MsgArr {
    const out: MsgArr = [];
    const at = new Map<string, number>();
    for (let i = 0; i < coldArr.length; i++) {
      const m = coldArr[i];
      if (!m || typeof m !== "object") continue;
      const id = idOf(m);
      if (id) {
        if (at.has(id)) continue;
        at.set(id, out.length);
      }
      out.push(m);
    }
    for (let j = 0; j < hotArr.length; j++) {
      const m = hotArr[j];
      if (!m || typeof m !== "object") continue;
      const id = idOf(m);
      if (id && at.has(id)) {
        const index = at.get(id);
        if (index !== undefined) out[index] = m;
      } else {
        out.push(m);
      }
    }
    return out;
  }

  function hotOf(arr: MsgArr): MsgArr {
    const start = Math.max(0, arr.length - HOT_KEEP);
    return arr.slice(start).map(copyMsg);
  }

  /** Seed the mirror with what storage and the spill already hold; synchronous by design. */
  function prime(): void {
    const ls = readLsSessions();
    const spill = readPending();
    for (const key of Object.keys(spill)) pending[key] = spill[key];
    const keys = new Set<string>(Object.keys(ls));
    for (const key of Object.keys(pending)) keys.add(key);
    for (const key of keys) {
      const hotRaw = ls[key];
      const hot: MsgArr = [];
      if (Array.isArray(hotRaw)) {
        for (let i = 0; i < hotRaw.length; i++) {
          const m = hotRaw[i];
          if (m && typeof m === "object" && !Array.isArray(m)) hot.push(m);
        }
      }
      mirror[key] = mergeColdHot(pending[key] || [], withIds(key, hot));
    }
  }

  function loadAllSessions(): Record<string, unknown> {
    // A corrupt blob is not "no data": the old contract (and the store lock) answers {} instead of
    // silently overlaying the in-memory mirror over a broken storage read.
    try {
      const raw = storage.getItem(LS_CHAT_SESSION);
      if (raw) JSON.parse(raw);
    } catch (e) {
      return {};
    }
    const all = readLsSessions();
    for (const key of Object.keys(mirror)) {
      const arr = mirror[key];
      if (Array.isArray(arr)) all[key] = copyArr(arr);
    }
    for (const key of Object.keys(pending)) {
      if (Array.isArray(all[key])) continue;
      all[key] = copyArr(pending[key]);
    }
    return all;
  }

  /** Queue cold messages, skipping ids already archived or already queued. */
  function queueCold(convId: string, arr: MsgArr): void {
    if (!convId || !Array.isArray(arr) || !arr.length) return;
    const seen = archived[convId] || (archived[convId] = {});
    const bucket = pending[convId] || (pending[convId] = []);
    const queued: Record<string, 1> = {};
    for (let i = 0; i < bucket.length; i++) {
      const id = idOf(bucket[i]);
      if (id) queued[id] = 1;
    }
    let added = 0;
    for (let j = 0; j < arr.length; j++) {
      const m = arr[j];
      if (!m || typeof m !== "object" || Array.isArray(m)) continue;
      const id = idOf(m);
      if (!id || seen[id] || queued[id]) continue;
      queued[id] = 1;
      bucket.push(copyMsg(m));
      added++;
    }
    if (added) writePending();
  }

  /** Drain one conversation's archive queue; a failure leaves the spill intact for the next try. */
  function kickArchive(convId: string): void {
    if (queue[convId]) return;
    const bucket = pending[convId];
    if (!Array.isArray(bucket) || !bucket.length) return;
    let port: SessionColdPort | null = null;
    try { port = cold(); } catch (e) { port = null; }
    if (!port || typeof port.archive !== "function") return;
    const p = port;
    const batch = bucket.slice();
    const run: Promise<void> = Promise.resolve()
      .then(function () { return p.archive(convId, batch); })
      .then(function (res) {
        if (!res || res.ok !== true) {
          warn("[session] 冷归档暂未成功（原文保留在待归档区）", res && res.error);
          return;
        }
        const seen = archived[convId] || (archived[convId] = {});
        const known = Array.isArray(res.known) && res.known.length
          ? res.known
          : batch.map(function (m) { return idOf(m); });
        for (let i = 0; i < known.length; i++) {
          if (known[i]) seen[known[i]] = 1;
        }
        const rest = (pending[convId] || []).filter(function (m) { return !seen[idOf(m)]; });
        if (rest.length) pending[convId] = rest;
        else delete pending[convId];
        writePending();
      })
      .catch(function (e) {
        warn("[session] 冷归档失败（原文保留在待归档区）", e);
      })
      .then(function () {
        delete queue[convId];
        if (pending[convId] && pending[convId].length) kickArchive(convId);
      });
    queue[convId] = run;
  }

  async function flush(): Promise<void> {
    for (let round = 0; round < 3; round++) {
      for (const convId of Object.keys(pending)) {
        if (pending[convId] && pending[convId].length) kickArchive(convId);
      }
      const jobs = Object.keys(queue).map(function (k) { return queue[k]; });
      if (!jobs.length) break;
      await Promise.all(jobs);
    }
  }

  function saveAllSessions(all: Record<string, unknown>): void {
    try {
      if (!all || typeof all !== "object" || !Object.keys(all).length) {
        clearAllLocal();
        return;
      }
      const ls: Record<string, unknown> = {};
      const keep: Record<string, 1> = {};
      for (const key of Object.keys(all)) {
        const value = all[key];
        const arr: MsgArr = Array.isArray(value)
          ? value.filter(function (m): m is Msg { return !!m && typeof m === "object"; })
          : [];
        keep[key] = 1;
        mirror[key] = copyArr(arr);
        const hot = hotOf(withIds(key, arr));
        ls[key] = hot;
        const cut = arr.length - hot.length;
        if (cut > 0) queueCold(key, arr.slice(0, cut));
      }
      for (const key of Object.keys(mirror)) {
        if (keep[key]) continue;
        delete mirror[key];
        delete pending[key];
        delete archived[key];
      }
      writeLsSessions(ls);
      writePending();
      for (const key of Object.keys(keep)) kickArchive(key);
    } catch (e) {
      warn("[session] 保存会话窗口失败（旧值保持不变）", e);
    }
  }

  function clearAllLocal(): void {
    try { storage.removeItem(LS_CHAT_SESSION); } catch (e) {}
    try { storage.removeItem(LS_CHAT_COLD_PENDING); } catch (e) {}
    for (const key of Object.keys(mirror)) delete mirror[key];
    for (const key of Object.keys(pending)) delete pending[key];
    for (const key of Object.keys(archived)) delete archived[key];
  }

  // Sync hooks: per-slot last-modified stamp and the deletion tombstone.
  function bumpSlotMeta(slotKey: string): void {
    if (!slotKey) return;
    try {
      const raw: unknown = JSON.parse(storage.getItem(LS_CHAT_SLOT_META) || "{}");
      const m: Record<string, unknown> = (typeof raw === "object" && raw !== null) ? toRecord(raw) : {};
      m[slotKey] = { updatedAt: Date.now(), deviceId: getDeviceId() };
      storage.setItem(LS_CHAT_SLOT_META, JSON.stringify(m));
    } catch (e) {}
  }
  function writeChatTombstone(slotKey: string): void {
    if (!slotKey) return;
    try {
      const raw: unknown = JSON.parse(storage.getItem(LS_CHAT_TOMB) || "{}");
      const t: Record<string, unknown> = (typeof raw === "object" && raw !== null) ? toRecord(raw) : {};
      t[slotKey] = { deletedAt: Date.now(), deviceId: getDeviceId() };
      storage.setItem(LS_CHAT_TOMB, JSON.stringify(t));
    } catch (e) {}
  }

  // One-shot purge of the pre-2026-09 slot format, whose keys were "<cardId>#<convId>" or a bare
  // card id; the current keys are flat "c_..." ids. Every dropped key gets a tombstone first —
  // without one, sync pulls the old data straight back as orphan slots the list never shows.
  function purgeLegacyConvs(): void {
    try {
      if (storage.getItem("cfw_conv_purged_v2") === "1") return;
      const all = loadAllSessions();
      const memSlots = getMemSlots();
      let n = 0;
      for (const k of Object.keys(all)) {
        if (isConvId(k)) continue;
        writeChatTombstone(k);
        delete all[k];
        delete memSlots[k];
        n++;
      }
      saveAllSessions(all);
      // Registry: drop the nested entries, keep only flat ids.
      const meta = getConvMeta();
      const flat: Record<string, unknown> = {};
      for (const k of Object.keys(meta)) if (isConvId(k)) flat[k] = meta[k];
      saveConvMeta(flat);
      // Stamps for the dropped keys go too; a stale stamp would fight the tombstone.
      try {
        const raw: unknown = JSON.parse(storage.getItem(LS_CHAT_SLOT_META) || "{}");
        const sm: Record<string, unknown> = (typeof raw === "object" && raw !== null) ? toRecord(raw) : {};
        const sm2: Record<string, unknown> = {};
        for (const k of Object.keys(sm)) if (isConvId(k)) sm2[k] = sm[k];
        storage.setItem(LS_CHAT_SLOT_META, JSON.stringify(sm2));
      } catch (e) {}
      storage.setItem("cfw_conv_purged_v2", "1");
      console.log("[conv] 已清理旧格式对话槽位:", n, "个");
    } catch (e) {}
  }

  function persistSessionForConv(convId: string, arr: MsgArr): void {
    if (!convId || !Array.isArray(arr)) return;
    const memSlots = getMemSlots();
    // The live-channel diff needs the array as of the previous write, so grab it before the
    // in-memory slot is replaced.
    const prevRaw = memSlots[convId];
    const prev: MsgArr | null = Array.isArray(prevRaw) ? prevRaw : null;
    // Stable ids are assigned once and shared by the in-memory slot and the stored copy, so the
    // next diff can only report additions.
    let full = arr;
    try { if (ensureMessageIds) full = ensureMessageIds(arr, convId, getDeviceId()); } catch (e) {}
    // First write of a conversation that has no slot stamp yet: an empty baseline counts as [],
    // otherwise the first user message is never reported as an append. A conversation with no
    // in-memory baseline stays null, so a whole history is not re-sent as one giant append.
    let prevForDiff: MsgArr | null = prev;
    try {
      const sm = (getChatSlotMeta && getChatSlotMeta()) || {};
      const cur = sm[convId];
      const hasMeta = !!(cur && typeof cur === "object" && "updatedAt" in cur && cur.updatedAt);
      if (prev === null && !hasMeta) prevForDiff = full.length <= 1 ? [] : null;
    } catch (e) {}
    // The in-memory slot is updated unconditionally, even with history off: that is what lets a
    // background turn resume when the user switches back.
    try { memSlots[convId] = full.map(function (m) { return Object.assign({}, m); }); } catch (e) {}
    if (!getHistoryEnabled()) return;
    mirror[convId] = copyArr(full);
    const coldCut = Math.max(0, full.length - HOT_KEEP);
    const coldExtra: MsgArr = coldCut > 0 ? full.slice(0, coldCut) : [];
    try {
      const all = readLsSessions();
      // The stored copy is the hot tail (never the live array). Under the 2MB cap the oldest hot
      // messages move to the cold queue instead of being dropped.
      let hot = full.slice(coldCut).map(copyMsg);
      all[convId] = hot;
      let data = JSON.stringify(all);
      if (data.length > LS_LIMIT && hot.length > 2) {
        const perMsg = Math.max(1, Math.floor(JSON.stringify(hot).length / Math.max(1, hot.length)));
        const overshoot = data.length - LS_LIMIT;
        const cut = Math.min(hot.length - 2, Math.ceil(overshoot / perMsg / 2) * 2);
        if (cut > 0) {
          coldExtra.push.apply(coldExtra, hot.slice(0, cut));
          hot = hot.slice(cut);
          all[convId] = hot;
          data = JSON.stringify(all);
        }
        while (data.length > LS_LIMIT && hot.length > 2) {
          const step = Math.min(100, hot.length - 2);
          coldExtra.push.apply(coldExtra, hot.slice(0, step));
          hot = hot.slice(step);
          all[convId] = hot;
          data = JSON.stringify(all);
        }
      }
      storage.setItem(LS_CHAT_SESSION, data);
      bumpSlotMeta(convId); // last-modified stamp for slot-level merge
      touchConv(convId, {}); // keeps list ordering by real activity, background turns included
      // Hand this write's diff to the live channel (append or full replace).
      try { if (recordLocal) recordLocal(convId, prevForDiff, full); } catch (e) {}
      queueCold(convId, coldExtra);
      kickArchive(convId);
    } catch (e) {
      warn("[session] 写入热窗口失败（原数据保持不变）", e);
    }
  }

  function persistSessionIfEnabled(): void { persistSessionForConv(currentSlotKey(), getSession()); }

  function writeSessionBlob(json: string): void {
    let parsed: unknown = null;
    try { parsed = JSON.parse(json); } catch (e) { return; }
    if (Array.isArray(parsed)) saveAllSessions({ __none__: parsed });
    else if (parsed && typeof parsed === "object") saveAllSessions(toRecord(parsed));
  }

  function asMsgArr(value: unknown): MsgArr {
    if (!Array.isArray(value)) return [];
    const out: MsgArr = [];
    for (let i = 0; i < value.length; i++) {
      const m = value[i];
      if (m && typeof m === "object" && !Array.isArray(m)) out.push(copyMsg(m));
    }
    return out;
  }

  /**
   * Remote apply. Incoming arrays are *hot tails* (both sync and realtime only ever carry the hot
   * window), so they are merged onto the in-memory full array by message id instead of replacing it:
   * a blind replace would drop the page's archived prefix from the mirror and the conversation on
   * screen would visibly lose its history. A conversation absent from the incoming map is a deletion
   * and is removed. `saveAllSessions` then does the mirror/hot-window/eviction work as usual.
   */
  function applyRemote(sessions: Record<string, unknown>, opts?: { source?: string }): void {
    if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) return;
    const keys = Object.keys(sessions);
    lastRemoteApply = { at: Date.now(), source: opts && opts.source ? String(opts.source) : "remote", keys: keys.length };
    const merged: Record<string, unknown> = {};
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      merged[key] = mergeColdHot(asMsgArr(mirror[key]), asMsgArr(sessions[key]));
    }
    saveAllSessions(merged);
  }

  /** Read-only view for diagnostics (status panel / tests); never used by the write paths. */
  function lastRemote(): { at: number; source: string; keys: number } | null {
    return lastRemoteApply === null ? null : { at: lastRemoteApply.at, source: lastRemoteApply.source, keys: lastRemoteApply.keys };
  }

  function removeSessionBlob(): void { clearAllLocal(); }

  function reset(): void {
    clearAllLocal();
    try { storage.removeItem(LS_CHAT_SLOT_META); } catch (e) {}
  }

  /** Archive a batch for one conversation and fold the confirmed ids into the skip set. */
  async function archiveNow(port: SessionColdPort, convId: string, arr: MsgArr): Promise<{ ok: boolean; error?: string }> {
    if (!arr.length) return { ok: true };
    try {
      const res = await port.archive(convId, arr);
      if (!res || res.ok !== true) {
        warn("[session] 迁移归档失败（原数据完整保留）", res && res.error);
        return { ok: false, error: res && res.error ? res.error : "archive failed" };
      }
      const seen = archived[convId] || (archived[convId] = {});
      const known = Array.isArray(res.known) ? res.known : arr.map(function (m) { return idOf(m); });
      for (let i = 0; i < known.length; i++) if (known[i]) seen[known[i]] = 1;
      return { ok: true };
    } catch (e) {
      warn("[session] 迁移归档异常（原数据完整保留）", e);
      return { ok: false, error: "archive threw" };
    }
  }

  /** Write the hot tail for one conversation without touching the other slots. */
  function writeHotOf(convId: string, full: MsgArr): boolean {
    try {
      const all = readLsSessions();
      // A persist may have landed while the boot migration was reading its snapshot; keep the
      // newer tail instead of overwriting it with the stale one.
      const currentRaw = all[convId];
      const current: MsgArr = [];
      if (Array.isArray(currentRaw)) {
        for (let i = 0; i < currentRaw.length; i++) {
          const m = currentRaw[i];
          if (m && typeof m === "object" && !Array.isArray(m)) current.push(m);
        }
      }
      all[convId] = hotOf(mergeColdHot(hotOf(full), current));
      storage.setItem(LS_CHAT_SESSION, JSON.stringify(all));
      return true;
    } catch (e) {
      warn("[session] 裁剪热窗口失败（下次启动重试，归档幂等）", e);
      return false;
    }
  }

  /**
   * One-shot migration of the legacy full localStorage blob into events. A conversation is marked
   * only after its archive AND its hot-window write succeeded; any failure leaves the original
   * blob untouched so the next boot retries (the archive dedupes by message id, so retries are safe).
   */
  async function migrateLegacy(): Promise<void> {
    let port: SessionColdPort | null = null;
    try { port = cold(); } catch (e) { port = null; }
    if (!port || typeof port.archive !== "function") return;
    const marker = readMigrated();
    const ls = readLsSessions();
    let changed = false;
    for (const convId of Object.keys(ls)) {
      if (!convId || convId === "__none__") continue;
      const raw = ls[convId];
      if (!Array.isArray(raw) || !raw.length) continue;
      const full = withIds(convId, raw.map(copyMsg));
      if (marker[convId]) {
        // Marked but the stored copy is still full (a previous trim write failed): archive the
        // overflow and trim again. The archive skips ids that are already projected.
        const hotLen = Math.min(HOT_KEEP, full.length);
        const overflow = full.slice(0, full.length - hotLen);
        if (overflow.length) {
          const res = await archiveNow(port, convId, overflow);
          if (!res.ok) continue;
        }
        if (full.length > hotLen) writeHotOf(convId, full);
        continue;
      }
      const res = await archiveNow(port, convId, full);
      if (!res.ok) continue;
      marker[convId] = Date.now();
      changed = true;
      mirror[convId] = copyArr(full);
      // Pending entries covered by this archive are gone from the spill.
      const seen = archived[convId] || {};
      if (pending[convId]) {
        pending[convId] = pending[convId].filter(function (m) { return !seen[idOf(m)]; });
        if (!pending[convId].length) delete pending[convId];
        writePending();
      }
      writeHotOf(convId, full);
    }
    if (changed) writeMigrated(marker);
  }

  /** Merge each conversation's cold live projection into the mirror, then tell the host. */
  async function hydrate(): Promise<void> {
    let port: SessionColdPort | null = null;
    try { port = cold(); } catch (e) { port = null; }
    if (!port || typeof port.load !== "function") return;
    const ls = readLsSessions();
    const keys = new Set<string>(Object.keys(ls));
    for (const key of Object.keys(mirror)) keys.add(key);
    for (const key of Object.keys(pending)) keys.add(key);
    try {
      const meta = getConvMeta();
      for (const key of Object.keys(meta)) keys.add(key);
    } catch (e) {}
    for (const convId of keys) {
      if (!convId || convId === "__none__") continue;
      let coldMsgs: MsgArr;
      try { coldMsgs = await port.load(convId); } catch (e) { continue; }
      if (!Array.isArray(coldMsgs) || !coldMsgs.length) continue;
      const hotRaw = ls[convId];
      let hot: MsgArr = [];
      if (Array.isArray(hotRaw)) {
        for (let i = 0; i < hotRaw.length; i++) {
          const m = hotRaw[i];
          if (m && typeof m === "object" && !Array.isArray(m)) hot.push(m);
        }
        hot = withIds(convId, hot);
      }
      const baseRaw = Array.isArray(mirror[convId]) && mirror[convId].length ? mirror[convId] : hot;
      // `prime()` runs before the host's id minter is initialised (fragment load order), so the
      // mirror may still hold id-less messages here; normalise before deduping against cold rows.
      const base = withIds(convId, baseRaw);
      const merged = mergeColdHot(coldMsgs.concat(pending[convId] || []), base);
      mirror[convId] = merged;
      if (onHydrated && merged.length > base.length) {
        try { onHydrated(convId, copyArr(merged)); } catch (e) {}
      }
    }
  }

  function boot(): Promise<void> {
    if (!bootPromise) {
      bootPromise = migrateLegacy()
        .then(function () { return hydrate(); })
        .then(function () {
          // A previous run may have died between "hot window written" and "archive committed".
          // The spill key survived; drain it now that the cold port exists.
          for (const convId of Object.keys(pending)) {
            if (pending[convId] && pending[convId].length) kickArchive(convId);
          }
        })
        .catch(function (e) { warn("[session] 启动水合失败（热窗口仍可用）", e); });
    }
    return bootPromise;
  }

  prime();

  return {
    LS_CHAT_SESSION, LS_CHAT_SLOT_META, LS_CHAT_TOMB,
    LS_CHAT_COLD_PENDING, LS_SESSION_EVENTS_MIGRATED,
    LS_LIMIT, HOT_KEEP,
    loadAllSessions, saveAllSessions, bumpSlotMeta, writeChatTombstone,
    purgeLegacyConvs, persistSessionForConv, persistSessionIfEnabled,
    writeSessionBlob, applyRemote, lastRemote, removeSessionBlob, reset,
    boot, hydrate, migrateLegacy, flush,
  };
}

/** object to Record, bridged through Object.entries so no assertion is needed. */
function toRecord(o: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) out[k] = v;
  return out;
}
