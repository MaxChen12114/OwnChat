/**
 * Chat conflict lifecycle: the one conflict table both merge paths write, the realtime hook that
 * records a conflict it stumbled on, and the three-way user resolution (local / remote / fork).
 *
 * Same storage shape for both writers is the invariant: the panel has exactly one reader. A
 * resolution ends by scheduling a chat push so the chosen version reaches the other devices; the
 * push dependency arrives as an injected callback because the chat channel is built after this
 * engine and must not depend on it in the other direction.
 * @module services/data/sync-conflict
 */
import type { Json } from "./sync";
import { arrOf, recOf } from "./sync";
import { numOf, strOf } from "./sync-context";
import type { SyncContext } from "./sync-context";

/** Injected dependency: fire-and-forget chat push, wired by the host after the chat channel exists. */
export interface ConflictDeps {
  scheduleChatPush(): void;
}

/** Public surface of the conflict engine; the host facade forwards to these. */
export interface ConflictEngine {
  getChatConflicts(): Json[];
  setChatConflict(slotKey: string, localMsgs: unknown[], remoteMsgs: unknown[], remoteUpdatedAt: unknown): Json;
  resolveChatConflict(slotKey: string, resolution: string): boolean;
}

export function createConflictEngine(ctx: SyncContext, deps: ConflictDeps): ConflictEngine {
  const storage = ctx.storage;
  const ports = ctx.ports;

  function getChatConflicts(): Json[] {
    return ctx.readJSONArr(ctx.CHAT_CONFLICTS_KEY).map((entry) => recOf(entry));
  }

  /**
   * Record a conflict the realtime channel stumbled on. Same storage shape as the merge path, so
   * the panel needs only one reader; an existing entry for the slot is replaced, not appended.
   */
  function setChatConflict(slotKey: string, localMsgs: unknown[], remoteMsgs: unknown[], remoteUpdatedAt: unknown): Json {
    const localArr = Array.isArray(localMsgs) ? localMsgs : [];
    const remoteArr = Array.isArray(remoteMsgs) ? remoteMsgs : [];
    const conflict: Json = {
      slotKey: slotKey,
      localMsgs: localArr,
      remoteMsgs: remoteArr,
      localUpdatedAt: ctx.now(),
      remoteUpdatedAt: numOf(remoteUpdatedAt) || ctx.now(),
      localCount: localArr.length,
      remoteCount: remoteArr.length,
    };
    const merged = getChatConflicts();
    const index = merged.findIndex((p) => strOf(p["slotKey"]) === slotKey);
    if (index >= 0) merged[index] = conflict;
    else merged.push(conflict);
    storage.setItem(ctx.CHAT_CONFLICTS_KEY, JSON.stringify(merged));
    ctx.emit("chat-conflict", { conflicts: [conflict] });
    ports.dispatch("chat-conflict", { conflicts: [conflict] });
    return conflict;
  }

  /** resolution = "local" | "remote" | "fork"; returns false when the slot has no open conflict. */
  function resolveChatConflict(slotKey: string, resolution: string): boolean {
    const conflicts = getChatConflicts();
    const conflict = conflicts.find((x) => strOf(x["slotKey"]) === slotKey);
    if (!conflict) return false;
    ctx.flags.chat = true;
    try {
      const sessions = ctx.getChatSessions();
      const meta = ctx.getChatSlotMeta();
      const stamp = ctx.now();
      const remoteMsgs = arrOf(conflict["remoteMsgs"]);
      const localMsgs = arrOf(conflict["localMsgs"]);
      if (resolution === "remote") {
        sessions[slotKey] = remoteMsgs;
        meta[slotKey] = { updatedAt: stamp, deviceId: ctx.chatDeviceId() };
      } else if (resolution === "fork") {
        // Slot keys are flat conversation ids with no prefix, and a fork must be a legal one too:
        // anything not starting with c_ is invisible to the sidebar.
        const forkKey = "c_" + stamp.toString(36) + "_" + ports.random().toString(36).slice(2, 6);
        sessions[slotKey] = localMsgs;
        sessions[forkKey] = remoteMsgs;
        meta[slotKey] = { updatedAt: stamp, deviceId: ctx.chatDeviceId() };
        meta[forkKey] = { updatedAt: stamp, deviceId: ctx.chatDeviceId() };
        const convMeta = ctx.getConvMetaMap();
        convMeta[forkKey] = {
          name: "云端版本 " + new Date(stamp).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }),
          createdAt: stamp,
        };
        storage.setItem(ctx.CHAT_CONV_META_KEY, JSON.stringify(convMeta));
      } else {
        sessions[slotKey] = localMsgs;
        meta[slotKey] = { updatedAt: stamp, deviceId: ctx.chatDeviceId() };
      }
      // Direct write on purpose: this map came from the hot-window read above, so replacing the
      // whole mirror with it would drop the archived prefix. The facade path is for maps that are
      // already complete (the merge snapshot).
      storage.setItem("cfw_chat_session_v1", JSON.stringify(sessions));
      storage.setItem(ctx.CHAT_SLOT_META_KEY, JSON.stringify(meta));
      const synced = ctx.getChatSynced();
      synced[slotKey] = { hash: ctx.hashStr(JSON.stringify(sessions[slotKey])), syncedAt: stamp };
      storage.setItem(ctx.CHAT_SYNCED_KEY, JSON.stringify(synced));
      const rest = conflicts.filter((x) => strOf(x["slotKey"]) !== slotKey);
      if (rest.length) storage.setItem(ctx.CHAT_CONFLICTS_KEY, JSON.stringify(rest));
      else storage.removeItem(ctx.CHAT_CONFLICTS_KEY);
    } finally {
      ctx.flags.chat = false;
    }
    deps.scheduleChatPush();
    ctx.emit("chat-conflict-resolved", { slotKey: slotKey, resolution: resolution });
    return true;
  }

  return {
    getChatConflicts: getChatConflicts,
    setChatConflict: setChatConflict,
    resolveChatConflict: resolveChatConflict,
  };
}
