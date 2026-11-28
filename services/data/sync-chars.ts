/**
 * Character channel (/sync/chars): the legacy IndexedDB-plus-KV path for character cards.
 *
 * Decision 2026-11-28 (unified storage): the character cards moved to the D1 `chars` table, so a
 * client that reads and writes through the data plane no longer needs this channel — D1 *is* the
 * sync. The endpoint stays live anyway: clients shipped before the move only know this path, and
 * their cards must keep travelling until they upgrade. Nothing here is fed by the new path (the
 * character wiring no longer marks the channel dirty), so the blob only ever holds what those
 * legacy clients put there. Retire the whole channel — endpoint, the two settings buttons and the
 * main blob's `indexedDB.tavern_chars_v2` exclusion — once no pre-2026-11-28 client is expected to
 * sync; half-retiring it would strand those cards silently.
 *
 * The merge itself is delegated (char-sync-merge module, invoked by the merge engine); landing the
 * merged result replaces both IndexedDB stores wholesale, which is what keeps deletions propagated:
 * a card absent from the merged set must disappear locally too.
 * @module services/data/sync-chars
 */
import type { Json, MergedChars } from "./sync";
import { recOf } from "./sync";
import { isRec, keysOf, numOf, strOf } from "./sync-context";
import type { ChannelLoop, SyncContext } from "./sync-context";
import type { MergeEngine } from "./sync-merge";

/** Public surface of the chars channel; the host facade forwards to these. */
export interface CharsChannel {
  markCharsDirty(): void;
  pushCharsNow(): Promise<void>;
  pullCharsOnStartup(): Promise<void>;
  cancelTimer(): void;
}

export function createCharsChannel(ctx: SyncContext, merge: MergeEngine): CharsChannel {
  const storage = ctx.storage;
  const ports = ctx.ports;
  const timers = ctx.timers;

  const loop: ChannelLoop = ctx.makeChannelLoop({ debounceMs: 30000, job: runCharsPush });

  async function buildLocalCharsBlob(): Promise<Json> {
    const local = await merge.readLocalChars();
    const meta = ctx.getCharsMeta();
    const tomb = ctx.getCharsTomb();
    const excluded = new Set<string>(ctx.getExcluded().roles);
    const stamp = ctx.now();
    const cards: Json = {};
    const outMeta: Json = {};
    const affections: Json = {};
    for (let i = 0; i < local.chars.length; i++) {
      const card = recOf(local.chars[i]);
      const id = strOf(card["id"]);
      if (!id || excluded.has(id)) continue;
      const m = recOf(meta[id]);
      cards[id] = local.chars[i];
      outMeta[id] = {
        updatedAt: typeof m["updatedAt"] === "number" ? numOf(m["updatedAt"]) : stamp,
        deviceId: strOf(m["deviceId"]) || ctx.chatDeviceId(),
        hash: ctx.hashStr(JSON.stringify(card)),
      };
    }
    for (let i = 0; i < local.affections.length; i++) {
      const aff = recOf(local.affections[i]);
      const cardId = strOf(aff["cardId"]);
      if (!cardId || excluded.has(cardId)) continue;
      affections[cardId] = {
        value: aff["value"],
        updatedAt: typeof aff["updatedAt"] === "number" ? numOf(aff["updatedAt"]) : stamp,
      };
    }
    return { cards: cards, meta: outMeta, affections: affections, tombstones: tomb };
  }

  async function applyMergedCharsToLocal(m: MergedChars): Promise<void> {
    ctx.flags.chars = true;
    try {
      const cardIds = keysOf(m.cards);
      const cards: unknown[] = [];
      for (let i = 0; i < cardIds.length; i++) cards.push(m.cards[cardIds[i]]);
      const affIds = keysOf(m.affections);
      const affections: unknown[] = [];
      for (let i = 0; i < affIds.length; i++) {
        const aff = recOf(m.affections[affIds[i]]);
        affections.push({ cardId: affIds[i], value: aff["value"], updatedAt: aff["updatedAt"] });
      }
      // Both stores are replaced wholesale, which is what keeps deletions propagated: a card absent
      // from the merged set must disappear locally too.
      await ports.idb.restore(ctx.CHARS_DB, { chars: cards, affections: affections });
      storage.setItem(ctx.CHARS_META_KEY, JSON.stringify(m.meta));
      storage.setItem(ctx.CHARS_TOMB_KEY, JSON.stringify(m.tomb));
      storage.setItem(ctx.CHARS_SYNCED_KEY, JSON.stringify(m.synced));
    } finally {
      ctx.flags.chars = false;
    }
    try {
      const store = ports.character();
      if (store && typeof store.reload === "function") await store.reload();
    } catch (e) {
      /* the panel refreshes on its own next open */
    }
    if (m.conflicts.length) {
      ctx.emit("chars-conflict", { conflicts: m.conflicts });
      ports.dispatch("chars-conflict", { conflicts: m.conflicts });
    }
  }

  function pullCharsFromKV(): Promise<Json | null> {
    return ctx.getChannel(ctx.CHARS_PATH, "角色卡");
  }

  function pushCharsToKV(blob: Json): Promise<Json> {
    return ctx.putChannel(ctx.CHARS_PATH, blob, "角色卡");
  }

  async function runCharsPush(): Promise<void> {
    try {
      const blob = await buildLocalCharsBlob();
      const res = await pushCharsToKV(blob);
      storage.setItem(ctx.LAST_CHARS_PUSH_KEY, String(numOf(res["savedAt"]) || ctx.now()));
      const mergedRemote = res["merged"];
      if (isRec(mergedRemote)) {
        const merged = await merge.mergeChars(mergedRemote);
        await applyMergedCharsToLocal(merged);
        // A conflict copy was just written locally; pushing again publishes it as a normal card
        // instead of leaving the user with data only this device can see.
        if (merged.conflicts.length) {
          timers.set(() => {
            const next = pushCharsNow();
            if (next && typeof next.then === "function") next.catch(function () {});
          }, 1200);
        }
      }
      ctx.incrPushCount();
      ctx.emit("chars-synced", { source: "push" });
    } catch (e) {
      ctx.emit("chars-error", e);
    }
  }

  function markCharsDirty(): void {
    if (!ctx.syncEnabled() || !ctx.token()) return;
    if (ctx.isPaused() || ctx.flags.chars) return;
    loop.markDirty();
  }

  async function pushCharsNow(): Promise<void> {
    loop.cancelTimer();
    await loop.run(runCharsPush);
  }

  async function pullCharsOnStartup(): Promise<void> {
    if (!ctx.syncEnabled() || !ctx.token()) return;
    try {
      const remote = await pullCharsFromKV();
      if (!remote) {
        try {
          await pushCharsNow();
        } catch (e) {
          /* nothing to seed */
        }
        return;
      }
      const merged = await merge.mergeChars(remote);
      await applyMergedCharsToLocal(merged);
      storage.setItem(ctx.LAST_CHARS_PULL_KEY, String(ctx.now()));
      ctx.emit("chars-synced", { source: "pull" });
      if (merged.conflicts.length) {
        timers.set(() => {
          const next = pushCharsNow();
          if (next && typeof next.then === "function") next.catch(function () {});
        }, 1200);
      } else {
        try {
          await pushCharsNow();
        } catch (e) {
          /* the merge already landed */
        }
      }
    } catch (e) {
      ctx.emit("chars-error", e);
    }
  }

  return {
    markCharsDirty: markCharsDirty,
    pushCharsNow: pushCharsNow,
    pullCharsOnStartup: pullCharsOnStartup,
    cancelTimer: loop.cancelTimer,
  };
}
