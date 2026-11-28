/**
 * Cloud sync engine: one product that owns five independent channels between this browser and the
 * account's KV on the worker — the main blob (/sync), cost (/sync/cost), the exclusion registry
 * (/sync/exclude), chat sessions (/sync/chat) and character cards (/sync/chars).
 *
 * Every platform-shaped thing arrives through {@link SyncPorts}: storage, fetch, timers, the clock,
 * random, IndexedDB, the DOM event bus, page reload, file save and the seven sibling modules this
 * engine reads or nudges (provider merge, provider registry, cost UI, the realtime channel, the
 * character-card merge, the character store and the desktop shell). This file touches no `window`,
 * `document`, `fetch` or `indexedDB`; tooling/l0/wiring/sync.js is the adapter.
 *
 * Why five channels instead of one blob is the architecture decision worth knowing: a single
 * last-writer-wins blob over the whole database loses data whenever two devices write in the same
 * window, and it also means a phone with an empty provider list can erase the desktop's keys. Each
 * channel therefore merges by its own natural key — day×device max for cost, entry timestamp for
 * exclusions, slot hash for chat, card id for characters — and only the residue (settings) stays
 * on the whole-blob path.
 *
 * Three invariants are load-bearing:
 *  - `LS_EXPLICIT` is the *entire* allow-list for the main blob; there is no fallback sweep. A key
 *    that is not listed is silently never synced, so an omission is invisible until someone
 *    reinstalls.
 *  - An empty message array is not a delete signal. Deletion is expressed by tombstones only;
 *    treating `[]` as deletion lets one device wipe another's conversation.
 *  - Every write performed while landing remote data must be suppressed from re-marking the same
 *    channel dirty, or a merge ping-pongs forever between devices.
 *
 * The engine is assembled from sibling fragments (tooling/l0/emit.mjs SOURCE_PARTS stitches them
 * into this one artifact, so the IIFE and its export surface stay identical): `sync-context` owns
 * the shared state every fragment sees explicitly (constants, primitives, status bus, switches,
 * exclusion registry, remote-apply flags, the per-channel debounce loop), `sync-upload` is the main
 * blob, `sync-cost` / `sync-exclude` / `sync-chat` / `sync-chars` are their channels, `sync-merge`
 * holds the merge algorithms, `sync-conflict` the conflict lifecycle, `sync-tombstone` the
 * character tombstone writes and `sync-lifecycle` the cross-channel orchestration. createSync below
 * is assembly only — no business logic lives here. The public members of the returned object are a
 * frozen contract with existing callers and must not change shape.
 * @module services/data/sync
 */
import type { ChatChannel } from "./sync-chat";
import { createChatChannel } from "./sync-chat";
import { createCharsChannel } from "./sync-chars";
import { createConflictEngine } from "./sync-conflict";
import { createSyncContext } from "./sync-context";
import { createCostChannel } from "./sync-cost";
import { createExcludeChannel } from "./sync-exclude";
import { createLifecycle } from "./sync-lifecycle";
import { createMergeEngine } from "./sync-merge";
import { createTombstoneEngine } from "./sync-tombstone";
import { createUploadChannel } from "./sync-upload";

/** JSON object shape used for every untyped payload crossing the network or storage boundary. */
export type Json = { [key: string]: unknown };

/** The part of the Storage interface this module uses; the adapter wraps window.localStorage. */
export interface KvStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface HttpInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** Only the parts of a fetch response this module reads: status, ok, and one of text/json. */
export interface HttpResponse {
  status: number;
  ok: boolean;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export type HttpPort = (url: string, init?: HttpInit) => Promise<HttpResponse>;

export interface TimerPort {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** One record plus the object store it came from, so it can be put back verbatim. */
export interface IdbEntry {
  store: string;
  item: Json;
}

/** IndexedDB port: whole-database dump, whole-store replace, and the two exclusion helpers. */
export interface IdbPort {
  /** Every store of the named database mapped to its records; null when the database is absent. */
  dump(name: string): Promise<Json | null>;
  /** Clear and refill each store present in `data`; absent stores are left untouched. */
  restore(name: string, data: Json): Promise<void>;
  /** Records whose `id` or `cardId` is in `ids`, tagged with their store. */
  readByIds(name: string, ids: string[]): Promise<IdbEntry[]>;
  putItems(name: string, entries: IdbEntry[]): Promise<void>;
}

/** Provider merge rules owned by the provider-merge module (pure functions, lock-tested there). */
export interface ProviderMergePort {
  mergeProviders(local: unknown, cloud: unknown): unknown;
  mergeImageChannels(local: unknown, cloud: unknown): unknown;
}

export interface ProvidersPort {
  republish(): void;
  mergePublic(): void;
}

export interface CostUiPort {
  refreshTopbar(): void;
  refreshSettings(): void;
}

export interface RealtimePort {
  isRunning(): boolean;
  status(): Json | null;
  catchUp(opts: { force: boolean }): Promise<unknown>;
}

/** Character-card conflict merge; throws at the caller when absent, exactly as the old engine did. */
export interface CharMergePort {
  mergeCharsState(input: Json): Json;
}

export interface CharacterPort {
  reload(): Promise<void>;
}

export interface SyncPorts {
  storage: KvStorage;
  http: HttpPort;
  timers: TimerPort;
  now(): number;
  random(): number;
  /** Bearer token of the signed-in user; empty string when signed out. */
  token(): string;
  idb: IdbPort;
  /** Fire a DOM CustomEvent so UI panels can react across modules. */
  dispatch(name: string, detail: unknown): void;
  /** Hard reload. The startup pull needs it: half the app already read the pre-restore data. */
  reloadPage(): void;
  /** Persist a text file (desktop shell) or trigger a download; resolves with what the shell says. */
  saveText(text: string, name: string): Promise<Json>;
  toast(message: string): void;
  providerMerge(): ProviderMergePort | null;
  providers(): ProvidersPort | null;
  costUi(): CostUiPort | null;
  realtime(): RealtimePort | null;
  charMerge(): CharMergePort | null;
  character(): CharacterPort | null;
  /**
   * Late-bound session-store facade (created by the chat shell after this script). A whole-map
   * chat apply goes through it so the in-memory full-array mirror and the hot window move
   * together; the sync engine still owns the merge decision and the other chat keys. Absent
   * (old shell build, tests) = the legacy direct localStorage write.
   */
  sessions?(): SessionsPort | null;
}

/** The one method this engine needs from services/session/store.ts. */
export interface SessionsPort {
  applyRemote(sessions: Record<string, unknown>, opts?: { source?: string }): void;
}

export type SyncListener = (status: string, detail?: unknown) => void;

export type ChatConflict = {
  slotKey: string;
  localMsgs: unknown[];
  remoteMsgs: unknown[];
  localUpdatedAt: number;
  remoteUpdatedAt: number;
  localCount: number;
  remoteCount: number;
};

export interface MergedChat {
  sessions: Json;
  slotMeta: Json;
  tomb: Json;
  convMeta: Json;
  conflicts: ChatConflict[];
}

export interface MergedChars {
  cards: Json;
  meta: Json;
  affections: Json;
  tomb: Json;
  synced: Json;
  conflicts: unknown[];
}

/** Merged-cell shape of one chat push/pull; `skipped` explains a no-op without throwing. */
export interface ChatResult {
  ok?: boolean;
  skipped?: string;
  error?: string;
  empty?: boolean;
  pulled?: boolean;
  slots?: number;
  savedAt?: number | null;
  changed?: boolean;
}

export function recOf(value: unknown): Json {
  const out: Json = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
  const entries = Object.entries(value);
  for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  return out;
}

export function arrOf(value: unknown): unknown[] {
  const out: unknown[] = [];
  if (!Array.isArray(value)) return out;
  for (let i = 0; i < value.length; i++) out.push(value[i]);
  return out;
}

/**
 * Build the sync engine.
 *
 * The returned object is the whole public surface; the wiring layer republishes it under the
 * frozen global name, so every member name here is a contract with existing callers. Assembly
 * order follows the dependency direction: context → merge → tombstone → conflict (with the chat
 * push wired late) → chat → chars/cost/exclude → upload → lifecycle.
 */
export function createSync(ports: SyncPorts) {
  const ctx = createSyncContext(ports);
  const merge = createMergeEngine(ctx);
  const tombstone = createTombstoneEngine(ctx);
  // The chat channel does not exist yet when the conflict engine is built. The late slot keeps the
  // dependency one-directional (conflict knows nothing of chat); a resolution schedules its push
  // through the same fire-and-forget wrapper the inline code used before the split.
  const lateChat: { chat: ChatChannel | null } = { chat: null };
  const conflict = createConflictEngine(ctx, {
    scheduleChatPush(): void {
      const push = lateChat.chat ? lateChat.chat.pushChatNow() : undefined;
      if (push && typeof push.then === "function") push.catch(() => {});
    },
  });
  const chat = createChatChannel(ctx, merge, conflict);
  lateChat.chat = chat;
  const chars = createCharsChannel(ctx, merge);
  const cost = createCostChannel(ctx, merge);
  const exclude = createExcludeChannel(ctx);
  const upload = createUploadChannel(ctx);
  const lifecycle = createLifecycle(ctx, { upload: upload, cost: cost, exclude: exclude, chat: chat, chars: chars });

  return {
    // main blob
    markDirty: upload.markDirty,
    pushNow: upload.pushNow,
    pullFromKV: upload.pullFromKV,
    pullOnStartup: upload.pullOnStartup,
    dumpAll: upload.dumpAll,
    restoreAll: upload.restoreAll,
    // cost channel
    markCostDirty: cost.markCostDirty,
    pushCostNow: cost.pushCostNow,
    pullCostOnStartup: cost.pullCostOnStartup,
    // cloud deletion
    wipeCloud: lifecycle.wipeCloud,
    deleteMainFromKV: lifecycle.deleteMainFromKV,
    deleteCostFromKV: lifecycle.deleteCostFromKV,
    deleteChatFromKV: lifecycle.deleteChatFromKV,
    deleteCharsFromKV: lifecycle.deleteCharsFromKV,
    deleteExcludeFromKV: lifecycle.deleteExcludeFromKV,
    deleteChatEventsFromKV: lifecycle.deleteChatEventsFromKV,
    // per-entity exclusion
    wipeCloudEntity: lifecycle.wipeCloudEntity,
    restoreCloudEntity: lifecycle.restoreCloudEntity,
    getExcluded: ctx.getExcluded,
    addExclusion: ctx.addExclusion,
    removeExclusion: ctx.removeExclusion,
    // exclusion channel
    pullExcludeOnStartup: exclude.pullExcludeOnStartup,
    pushExcludeNow: exclude.pushExcludeNow,
    getRegistry: ctx.getRegistry,
    // chat channel
    markChatDirty: chat.markChatDirty,
    pushChatNow: chat.pushChatNow,
    pullChatOnStartup: chat.pullChatOnStartup,
    pullChatNow: chat.pullChatNow,
    mergeChatSessions: merge.mergeChatSessions,
    getChatConflicts: conflict.getChatConflicts,
    resolveChatConflict: conflict.resolveChatConflict,
    withRemoteApply: ctx.withRemoteApply,
    isExcludedSession: chat.isExcludedSession,
    setChatConflict: conflict.setChatConflict,
    getChatSlotMeta: ctx.getChatSlotMeta,
    getChatTomb: ctx.getChatTomb,
    getConvMetaMap: ctx.getConvMetaMap,
    getChatSynced: ctx.getChatSynced,
    getDeviceId: lifecycle.getDeviceId,
    authHeaders: ctx.authHeaders,
    hashChat: ctx.hashStr,
    // character channel
    markCharsDirty: chars.markCharsDirty,
    pushCharsNow: chars.pushCharsNow,
    pullCharsOnStartup: chars.pullCharsOnStartup,
    bumpCharMeta: tombstone.bumpCharMeta,
    tombChar: tombstone.tombChar,
    // backup
    exportJSON: upload.exportJSON,
    importJSONText: upload.importJSONText,
    // switches
    syncEnabled: ctx.syncEnabled,
    setSyncEnabled: ctx.setSyncEnabled,
    includeChat: ctx.includeChat,
    setIncludeChat: ctx.setIncludeChat,
    isPaused: ctx.isPaused,
    pause: ctx.pause,
    resume: ctx.resume,
    // status
    onStatus: ctx.onStatus,
    getStatus: lifecycle.getStatus,
    // lifecycle
    bootstrap: lifecycle.bootstrap,
    flushAll: lifecycle.flushAll,
    noteStorageWrite: lifecycle.noteStorageWrite,
    noteStorageRemove: lifecycle.noteStorageRemove,
    noteStorageEvent: lifecycle.noteStorageEvent,
  };
}

export type Sync = ReturnType<typeof createSync>;
