/**
 * Cross-channel orchestration of the sync engine: the status snapshot, the cloud-wipe sequence,
 * the per-entity wipe/restore, the startup composition, the desktop flush hook, the storage-write
 * router and the one-shot flag migration.
 *
 * This fragment owns nothing persistent; every operation routes into the channel factories built
 * before it. The routing (`noteStorageWrite`) is the seam the storage monkey-patch in the wiring
 * drives: chat and chars bookkeeping keys belong to their own channels (suppressed while a remote
 * merge is landing), listed keys schedule the main blob, and everything else is ignored so a new
 * device-local key cannot accidentally cause writes.
 * @module services/data/sync-lifecycle
 */
import type { Json } from "./sync";
import { strOf } from "./sync-context";
import type { SyncContext } from "./sync-context";
import type { UploadChannel } from "./sync-upload";
import type { CostChannel } from "./sync-cost";
import type { ExcludeChannel } from "./sync-exclude";
import type { ChatChannel } from "./sync-chat";
import type { CharsChannel } from "./sync-chars";

/** The channels the orchestrator routes into; built by the host before this factory runs. */
export interface SyncChannels {
  upload: UploadChannel;
  cost: CostChannel;
  exclude: ExcludeChannel;
  chat: ChatChannel;
  chars: CharsChannel;
}

/** Public surface of the orchestrator; the host facade forwards to these. */
export interface LifecycleChannel {
  wipeCloud(): Promise<Json>;
  deleteMainFromKV(): Promise<Json>;
  deleteCostFromKV(): Promise<Json>;
  deleteChatFromKV(): Promise<Json>;
  deleteCharsFromKV(): Promise<Json>;
  deleteExcludeFromKV(): Promise<Json>;
  deleteChatEventsFromKV(): Promise<Json>;
  wipeCloudEntity(kind: string, key: string): Promise<Json>;
  restoreCloudEntity(kind: string, key: string): Promise<Json>;
  getStatus(): Json;
  bootstrap(): Promise<void>;
  flushAll(): void;
  noteStorageWrite(key: string): void;
  noteStorageRemove(key: string): void;
  noteStorageEvent(key: string | null): void;
  getDeviceId(): string;
}

export function createLifecycle(ctx: SyncContext, channels: SyncChannels): LifecycleChannel {
  const storage = ctx.storage;
  const ports = ctx.ports;

  // ── cloud deletion ──

  function deleteMainFromKV(): Promise<Json> {
    return ctx.deleteChannel(ctx.MAIN_BLOB_PATH, "");
  }

  function deleteCostFromKV(): Promise<Json> {
    return ctx.deleteChannel(ctx.COST_PATH, "费用");
  }

  function deleteChatFromKV(): Promise<Json> {
    return ctx.deleteChannel(ctx.CHAT_PATH, "聊天");
  }

  function deleteCharsFromKV(): Promise<Json> {
    return ctx.deleteChannel(ctx.CHARS_PATH, "角色卡");
  }

  function deleteChatEventsFromKV(): Promise<Json> {
    return ctx.deleteChannel(ctx.CHAT_EVENTS_PATH, "实时事件");
  }

  function deleteExcludeFromKV(): Promise<Json> {
    return ctx.deleteChannel(ctx.EXCLUDE_PATH, "排除清单");
  }

  /**
   * Clear every cloud key, then immediately re-push this device's data ("overwrite the cloud").
   * Clearing without the re-push is pointless: the next local edit would push everything back
   * anyway, so the button would have done nothing.
   */
  async function wipeCloud(): Promise<Json> {
    if (!ctx.syncEnabled() || !ctx.token()) throw new Error("未启用云同步");
    // Cancel pending pushes first, or a timer fires right after the wipe and restores the cloud.
    channels.upload.cancelTimer();
    channels.cost.cancelTimer();
    channels.chat.cancelTimer();
    channels.chars.cancelTimer();
    ctx.emit("syncing");
    const main = await deleteMainFromKV();
    // Each channel is a separate KV key; one failure must not block the rest.
    let cost: Json | null = null;
    let chat: Json | null = null;
    let chars: Json | null = null;
    let exclude: Json | null = null;
    let events: Json | null = null;
    try {
      cost = await deleteCostFromKV();
    } catch (e) {
      /* reported as null */
    }
    try {
      chat = await deleteChatFromKV();
    } catch (e) {
      /* reported as null */
    }
    try {
      chars = await deleteCharsFromKV();
    } catch (e) {
      /* reported as null */
    }
    try {
      exclude = await deleteExcludeFromKV();
    } catch (e) {
      /* reported as null */
    }
    try {
      events = await deleteChatEventsFromKV();
    } catch (e) {
      /* reported as null */
    }
    storage.removeItem(ctx.LAST_PUSH_KEY);
    storage.removeItem(ctx.LAST_PULL_KEY);
    storage.removeItem("cfw_sync_last_cost_push_v1");
    storage.removeItem("cfw_sync_last_cost_pull_v1");
    storage.removeItem(ctx.LAST_CHAT_PUSH_KEY);
    storage.removeItem(ctx.LAST_CHAT_PULL_KEY);
    storage.removeItem(ctx.LAST_CHARS_PUSH_KEY);
    storage.removeItem(ctx.LAST_CHARS_PULL_KEY);
    storage.removeItem(ctx.LAST_EXCLUDE_PUSH_KEY);
    storage.removeItem(ctx.LAST_EXCLUDE_PULL_KEY);
    storage.removeItem(ctx.CHAT_EVENTS_SEQ_KEY);
    storage.removeItem(ctx.CHAT_EVENTS_QUEUE_KEY);
    const pushed = { main: false, cost: false, chat: false, chars: false };
    try {
      await channels.upload.pushNow();
      pushed.main = true;
    } catch (e) {
      /* left false */
    }
    try {
      await channels.cost.pushCostNow();
      pushed.cost = true;
    } catch (e) {
      /* left false */
    }
    try {
      await channels.chat.pushChatNow();
      pushed.chat = true;
    } catch (e) {
      /* left false */
    }
    try {
      await channels.chars.pushCharsNow();
      pushed.chars = true;
    } catch (e) {
      /* left false */
    }
    ctx.emit("wiped", { main: main, cost: cost, chat: chat, chars: chars, exclude: exclude, events: events, overwritten: true });
    return { main: main, cost: cost, chat: chat, chars: chars, exclude: exclude, events: events, pushed: pushed };
  }

  /**
   * "Clear the cloud for this one entity, keep it here": register the exclusion, push the registry
   * (so other devices honour it), then push the owning channel with the entity filtered out.
   * Pushing only the main blob used to leave the entity untouched in the per-id channels until the
   * next merge brought it back.
   */
  async function wipeCloudEntity(kind: string, key: string): Promise<Json> {
    if (!ctx.syncEnabled() || !ctx.token()) throw new Error("未启用云同步");
    ctx.addExclusion(kind, key);
    await channels.exclude.pushExcludeNow();
    await channels.upload.pushNow();
    if (kind === "session") await channels.chat.pushChatNow();
    else await channels.chars.pushCharsNow();
    ctx.emit("entity-wiped", { kind: kind, key: key });
    return { kind: kind, key: key };
  }

  async function restoreCloudEntity(kind: string, key: string): Promise<Json> {
    if (!ctx.syncEnabled() || !ctx.token()) throw new Error("未启用云同步");
    ctx.removeExclusion(kind, key);
    await channels.exclude.pushExcludeNow();
    await channels.upload.pushNow();
    if (kind === "session") await channels.chat.pushChatNow();
    else await channels.chars.pushCharsNow();
    ctx.emit("entity-restored", { kind: kind, key: key });
    return { kind: kind, key: key };
  }

  // ── status ──

  function getStatus(): Json {
    const lastPush = ctx.lsInt(ctx.LAST_PUSH_KEY);
    const lastPull = ctx.lsInt(ctx.LAST_PULL_KEY);
    const lastChatPush = ctx.lsInt(ctx.LAST_CHAT_PUSH_KEY);
    const lastChatPull = ctx.lsInt(ctx.LAST_CHAT_PULL_KEY);
    const lastSyncAt = Math.max(lastPush, lastPull, lastChatPush, lastChatPull);
    let realtimeStatus: Json | null = null;
    try {
      const realtime = ports.realtime();
      realtimeStatus = realtime && typeof realtime.status === "function" ? realtime.status() : null;
    } catch (e) {
      realtimeStatus = null;
    }
    const rtState = realtimeStatus ? strOf(realtimeStatus["state"]) : "";
    const state = rtState === "reconnecting" ? "syncing" : rtState === "error" ? "error" : "synced";
    return {
      enabled: ctx.syncEnabled(),
      hasToken: !!ctx.token(),
      paused: ctx.isPaused(),
      includeChat: ctx.includeChat(),
      lastPush: lastPush,
      lastPull: lastPull,
      lastPushAt: lastChatPush || lastPush || 0,
      lastSyncAt: lastSyncAt,
      lastAt: lastSyncAt,
      state: state,
      busy: false,
      error: realtimeStatus ? strOf(realtimeStatus["error"]) : "",
      realtime: realtimeStatus,
      pushCount: ctx.lsInt(ctx.PUSH_COUNT_KEY),
      pushCountDay: storage.getItem(ctx.PUSH_COUNT_DAY_KEY) || "",
    };
  }

  // ── startup composition ──

  /**
   * Startup order matters: the exclusion registry merges first so the main pull already knows what
   * to protect. Cost runs outside the sync switch — money syncs for any signed-in user — and pushes
   * right after its pull so other devices see this machine's buckets.
   */
  async function bootstrap(): Promise<void> {
    if (!ctx.token()) return;
    if (ctx.syncEnabled()) {
      await channels.exclude.pullExcludeOnStartup();
      channels.upload.pullOnStartup();
      channels.chars.pullCharsOnStartup();
    }
    channels.cost.pullCostOnStartup().then(() => {
      const next = channels.cost.pushCostNow();
      if (next && typeof next.then === "function") next.catch(function () {});
    });
  }

  /** Desktop shell exit hook: flush every channel before the process goes away. */
  function flushAll(): void {
    const pushes = [channels.upload.pushNow(), channels.chat.pushChatNow(), channels.chars.pushCharsNow()];
    for (let i = 0; i < pushes.length; i++) {
      const p = pushes[i];
      if (p && typeof p.then === "function") p.catch(function () {});
    }
  }

  // ── storage-write routing (driven by the wiring's same-tab monkey-patch) ──

  /**
   * Route one same-tab storage write to the channel that owns it. Chat and character bookkeeping
   * keys belong to their own channels; everything on the main allow-list schedules the blob; the
   * rest is ignored, so a new device-local key cannot accidentally cause writes.
   */
  function noteStorageWrite(key: string): void {
    if (ctx.CHAT_DIRTY_KEYS.indexOf(key) >= 0) {
      if (!ctx.flags.chat) channels.chat.markChatDirty();
      return;
    }
    if (ctx.CHARS_DIRTY_KEYS.indexOf(key) >= 0) {
      if (!ctx.flags.chars) channels.chars.markCharsDirty();
      return;
    }
    if (channels.upload.isListedKey(key)) channels.upload.markDirty();
  }

  function noteStorageRemove(key: string): void {
    noteStorageWrite(key);
  }

  /** Another tab wrote: the storage event carries no payload, so any non-protected key counts. */
  function noteStorageEvent(key: string | null): void {
    if (!key || channels.upload.isProtected(key)) return;
    channels.upload.markDirty();
  }

  function getDeviceId(): string {
    return ctx.chatDeviceId();
  }

  function migrateSyncFlagsV2(): void {
    try {
      if (storage.getItem("cfw_sync_flags_v2") === "1") return;
      // Both switches were removed from the UI; chat now follows the master switch. Users who once
      // turned them off are set back to "sync everything" once, which can only add pulls.
      if (storage.getItem(ctx.INCLUDE_CHAT_KEY) === "0") storage.setItem(ctx.INCLUDE_CHAT_KEY, "1");
      if (storage.getItem(ctx.CHAT_REALTIME_KEY) === "0") storage.setItem(ctx.CHAT_REALTIME_KEY, "1");
      storage.setItem("cfw_sync_flags_v2", "1");
    } catch (e) {
      /* storage unavailable: the migration simply runs again next session */
    }
  }

  // Runs once at createSync time, exactly where the pre-split engine called it.
  migrateSyncFlagsV2();

  return {
    wipeCloud: wipeCloud,
    deleteMainFromKV: deleteMainFromKV,
    deleteCostFromKV: deleteCostFromKV,
    deleteChatFromKV: deleteChatFromKV,
    deleteCharsFromKV: deleteCharsFromKV,
    deleteExcludeFromKV: deleteExcludeFromKV,
    deleteChatEventsFromKV: deleteChatEventsFromKV,
    wipeCloudEntity: wipeCloudEntity,
    restoreCloudEntity: restoreCloudEntity,
    getStatus: getStatus,
    bootstrap: bootstrap,
    flushAll: flushAll,
    noteStorageWrite: noteStorageWrite,
    noteStorageRemove: noteStorageRemove,
    noteStorageEvent: noteStorageEvent,
    getDeviceId: getDeviceId,
  };
}
