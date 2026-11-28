/**
 * Chat channel (/sync/chat): the outbound slot blob, the merge landing path, the debounced push
 * with its in-flight divergence guard, and both pull variants (realtime catch-up first, full
 * snapshot second).
 *
 * Two decisions here carry data-loss risk if diluted, so they stay verbatim: an empty message
 * array is never an upload (deletion travels as a tombstone only), and a push whose local content
 * moved while the request was in flight must not land the response baseline — landing it would
 * fabricate a conflict and drop whatever the user typed meanwhile. Writes performed while landing
 * a remote merge go through the context's suppression flags so they do not re-mark this channel
 * dirty.
 * @module services/data/sync-chat
 */
import type { ChatResult, Json, MergedChat } from "./sync";
import { arrOf, recOf } from "./sync";
import { isRec, keysOf, numOf, strOf } from "./sync-context";
import type { ChannelLoop, SyncContext } from "./sync-context";
import type { MergeEngine } from "./sync-merge";
import type { ConflictEngine } from "./sync-conflict";

/** Public surface of the chat channel; the host facade forwards to these. */
export interface ChatChannel {
  markChatDirty(): void;
  pushChatNow(): Promise<ChatResult>;
  pullChatOnStartup(): Promise<void>;
  pullChatNow(opts?: { full?: boolean }): Promise<ChatResult>;
  isExcludedSession(convId: string): boolean;
  cancelTimer(): void;
}

export function createChatChannel(ctx: SyncContext, merge: MergeEngine, conflict: ConflictEngine): ChatChannel {
  const storage = ctx.storage;
  const ports = ctx.ports;

  const loop: ChannelLoop = ctx.makeChannelLoop({ debounceMs: 30000, job: runChatPush });

  function isExcludedSession(convId: string): boolean {
    try {
      const ex = ctx.getExcluded();
      return ex.sessions.indexOf(convId) >= 0 || ex.roles.indexOf(convId) >= 0;
    } catch (e) {
      return false;
    }
  }

  function buildLocalChatBlob(): Json {
    const sessions = ctx.getChatSessions();
    const slotMeta = ctx.getChatSlotMeta();
    const tomb = ctx.getChatTomb();
    const convMeta = ctx.getConvMetaMap();
    const ex = ctx.getExcluded();
    const excluded = new Set<string>(ex.sessions.concat(ex.roles));
    const slots: Json = {};
    const msgs: Json = {};
    const stamp = ctx.now();
    const ids = keysOf(sessions);
    for (let i = 0; i < ids.length; i++) {
      const k = ids[i];
      if (excluded.has(k)) continue;
      const arr = sessions[k];
      // An empty slot is not a delete signal, and uploading it would wipe a non-empty conversation
      // on the other device. Deletion travels as a tombstone only.
      if (!Array.isArray(arr) || arr.length === 0) continue;
      const meta = recOf(slotMeta[k]);
      const updatedAt = typeof meta["updatedAt"] === "number" ? numOf(meta["updatedAt"]) : stamp;
      slots[k] = { updatedAt: updatedAt, deviceId: strOf(meta["deviceId"]) || ctx.chatDeviceId(), hash: ctx.hashStr(JSON.stringify(arr)) };
      msgs[k] = arr;
    }
    return { slots: slots, msgs: msgs, tombstones: tomb, convMeta: convMeta };
  }

  function applyMergedChatToLocal(m: MergedChat): void {
    const prevSynced = ctx.getChatSynced();
    const prevSig = merge.chatSessionsSig(ctx.getChatSessions());
    ctx.flags.chat = true;
    try {
      ctx.writeChatSessions(m.sessions, "sync-merge");
      storage.setItem(ctx.CHAT_SLOT_META_KEY, JSON.stringify(m.slotMeta));
      storage.setItem(ctx.CHAT_TOMB_KEY, JSON.stringify(m.tomb));
      // Conversation names merge as a union on the server and cannot be deleted there, so a
      // removed conversation leaves a ghost row ("no messages yet") in the sidebar. Dropping any
      // name whose conversation is gone removes exactly the ghosts; local empty slots keep theirs.
      const convMeta = recOf(m.convMeta);
      keysOf(convMeta).forEach((k) => {
        if (!(k in m.sessions)) delete convMeta[k];
      });
      // Every device names its own main conversation c_main_<deviceId>, so a merged foreign one
      // shows up as a second, unexplained row. Renaming it is display-only and reversible.
      const myId = ctx.chatDeviceId();
      keysOf(convMeta).forEach((k) => {
        if (k.indexOf("c_main_") !== 0 || k === "c_main_" + myId) return;
        const meta = recOf(convMeta[k]);
        if (!strOf(meta["name"]) || strOf(meta["name"]) === "主对话") meta["name"] = "主对话 · 其他设备";
        convMeta[k] = meta;
      });
      storage.setItem(ctx.CHAT_CONV_META_KEY, JSON.stringify(convMeta));
      const conflictKeys = new Set<string>();
      (m.conflicts || []).forEach((c) => conflictKeys.add(c.slotKey));
      const synced: Json = {};
      keysOf(m.sessions).forEach((k) => {
        // A conflicted slot keeps its stale base on purpose: refreshing it would make the next push
        // recreate the same conflict, and the panel would pop again every cycle.
        if (conflictKeys.has(k)) {
          if (prevSynced[k]) synced[k] = prevSynced[k];
          return;
        }
        synced[k] = { hash: ctx.hashStr(JSON.stringify(m.sessions[k])), syncedAt: ctx.now() };
      });
      storage.setItem(ctx.CHAT_SYNCED_KEY, JSON.stringify(synced));
      if (m.conflicts && m.conflicts.length) {
        // Conflicts are merged per slot: replacing the whole list dropped unresolved conflicts of
        // other conversations.
        const merged = conflict.getChatConflicts();
        let hasNew = false;
        m.conflicts.forEach((c) => {
          const index = merged.findIndex((p) => strOf(p["slotKey"]) === c.slotKey);
          if (index >= 0) merged[index] = Object.assign({}, c);
          else {
            merged.push(Object.assign({}, c));
            hasNew = true;
          }
        });
        storage.setItem(ctx.CHAT_CONFLICTS_KEY, JSON.stringify(merged));
        if (hasNew) {
          ctx.emit("chat-conflict", { conflicts: m.conflicts });
          return;
        }
        // Every conflict was already known: the user has seen the panel, so do not pop it again.
      } else {
        storage.removeItem(ctx.CHAT_CONFLICTS_KEY);
      }
    } finally {
      ctx.flags.chat = false;
    }
    if (m.conflicts && m.conflicts.length) {
      ctx.emit("chat-conflict", { conflicts: m.conflicts });
      return;
    }
    // A merge that added or updated another device's conversation used to be invisible until the
    // next reload; the change event is what lets the UI offer a refresh.
    if (merge.chatSessionsSig(m.sessions) !== prevSig) ctx.emit("chat-merged", { changed: true });
  }

  function pullChatFromKV(): Promise<Json | null> {
    return ctx.getChannel(ctx.CHAT_PATH, "聊天");
  }

  function pushChatToKV(blob: Json): Promise<Json> {
    return ctx.putChannel(ctx.CHAT_PATH, blob, "聊天");
  }

  async function runChatPush(): Promise<ChatResult> {
    try {
      const blob = buildLocalChatBlob();
      // Remember each slot's hash at push time: if the local content changed while the request was
      // in flight, the response must not be landed. Landing it would make the snapshot we sent a
      // second ago look like a foreign edit, produce a fake conflict, and lose whatever the user
      // typed meanwhile once they pick "keep cloud".
      const slots = recOf(blob["slots"]);
      const pushedHashes: Record<string, string> = {};
      keysOf(slots).forEach((k) => {
        pushedHashes[k] = strOf(recOf(slots[k])["hash"]);
      });
      const res = await pushChatToKV(blob);
      storage.setItem(ctx.LAST_CHAT_PUSH_KEY, String(numOf(res["savedAt"]) || ctx.now()));
      let diverged = false;
      try {
        const current = ctx.getChatSessions();
        const pushedKeys = Object.keys(pushedHashes);
        for (let i = 0; i < pushedKeys.length; i++) {
          const arr = current[pushedKeys[i]];
          const h = Array.isArray(arr) ? ctx.hashStr(JSON.stringify(arr)) : null;
          if (h !== pushedHashes[pushedKeys[i]]) {
            diverged = true;
            break;
          }
        }
        if (!diverged) {
          const currentKeys = keysOf(current);
          for (let i = 0; i < currentKeys.length; i++) {
            const k = currentKeys[i];
            if (!(k in pushedHashes) && Array.isArray(current[k]) && arrOf(current[k]).length) {
              diverged = true;
              break;
            }
          }
        }
      } catch (e) {
        /* a failed divergence probe is treated as "not diverged", same as before */
      }
      // The merged payload in the response is deliberately not landed: conversations are pulled
      // only when the user asks. Only the baseline advances, and only when local did not move.
      if (res["merged"] && diverged) {
        // Diverged: leave the baseline alone; the next debounced push carries the newer snapshot
        // and converges.
      } else {
        ctx.flags.chat = true;
        try {
          const synced = ctx.getChatSynced();
          const msgKeys = keysOf(recOf(blob["msgs"]));
          for (let i = 0; i < msgKeys.length; i++) {
            const k = msgKeys[i];
            synced[k] = { hash: strOf(recOf(slots[k])["hash"]), syncedAt: ctx.now() };
          }
          storage.setItem(ctx.CHAT_SYNCED_KEY, JSON.stringify(synced));
        } finally {
          ctx.flags.chat = false;
        }
      }
      ctx.incrPushCount();
      ctx.emit("chat-synced", { source: "push" });
      return { ok: true, slots: keysOf(slots).length, savedAt: numOf(res["savedAt"]) || null };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      ctx.emit("chat-error", e);
      return { error: message };
    }
  }

  async function doChatPush(): Promise<ChatResult> {
    // Returns a result instead of undefined: the "sync now" button has to tell "pushed" from
    // "pushed nothing", and a silent return once reported a no-op as success.
    if (!ctx.includeChat()) return { skipped: "chat-off" };
    if (!ctx.syncEnabled() || !ctx.token()) return { skipped: "sync-off" };
    const result = await loop.run(runChatPush);
    if (result === undefined) return { skipped: "inflight" };
    return result;
  }

  function markChatDirty(): void {
    if (!ctx.syncEnabled() || !ctx.token() || !ctx.includeChat()) return;
    if (ctx.isPaused() || ctx.flags.chat) return;
    loop.markDirty();
  }

  async function pushChatNow(): Promise<ChatResult> {
    loop.cancelTimer();
    return await doChatPush();
  }

  /** Pull one round without pushing; callable at any time, unlike the startup variant. */
  async function pullChatNow(opts?: { full?: boolean }): Promise<ChatResult> {
    if (!ctx.includeChat()) return { skipped: "chat-off" };
    if (!ctx.syncEnabled() || !ctx.token()) return { skipped: "sync-off" };
    // The realtime channel is the cheap path; the full 3-way snapshot is for resets and explicit
    // full pulls. Falling back matters: if events are unavailable the caller must still get data,
    // not a fake success.
    if (!(opts && opts.full === true)) {
      try {
        const realtime = ports.realtime();
        if (realtime && typeof realtime.catchUp === "function" && realtime.isRunning()) {
          const result = await realtime.catchUp({ force: true });
          if (realtime.isRunning()) return recOf(result);
        }
      } catch (e) {
        /* fall through to the snapshot path */
      }
    }
    try {
      const remote = await pullChatFromKV();
      if (!remote) return { ok: true, empty: true };
      applyMergedChatToLocal(merge.mergeChatSessions(remote));
      storage.setItem(ctx.LAST_CHAT_PULL_KEY, String(ctx.now()));
      ctx.emit("chat-synced", { source: "pull" });
      return { ok: true, pulled: true };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      ctx.emit("chat-error", e);
      return { error: message };
    }
  }

  async function pullChatOnStartup(): Promise<void> {
    if (!ctx.syncEnabled() || !ctx.token() || !ctx.includeChat()) return;
    try {
      const remote = await pullChatFromKV();
      if (!remote) {
        try {
          await pushChatNow();
        } catch (e) {
          /* nothing to seed */
        }
        return;
      }
      applyMergedChatToLocal(merge.mergeChatSessions(remote));
      storage.setItem(ctx.LAST_CHAT_PULL_KEY, String(ctx.now()));
      ctx.emit("chat-synced", { source: "pull" });
      try {
        await pushChatNow();
      } catch (e) {
        /* the push is opportunistic: the merge already landed */
      }
    } catch (e) {
      ctx.emit("chat-error", e);
    }
  }

  return {
    markChatDirty: markChatDirty,
    pushChatNow: pushChatNow,
    pullChatOnStartup: pullChatOnStartup,
    pullChatNow: pullChatNow,
    isExcludedSession: isExcludedSession,
    cancelTimer: loop.cancelTimer,
  };
}
