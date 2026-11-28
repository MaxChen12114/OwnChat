/**
 * Tombstone writes for the character channel: saving a card bumps its meta and clears any
 * tombstone, deleting a card writes the tombstone and withdraws the meta.
 *
 * Kept as its own fragment because the meta/tombstone exclusion is a semantic pair, not two
 * incidental writes: a delete has to travel to other devices (a stale copy must not resurrect the
 * card), and a save must retract a pending tombstone or the merge would weigh "deleted here" against
 * "updated there" instead of trusting the newer intent. The chat channel's tombstone *resolution*
 * (deletedAt versus updatedAt, with resurrection) lives in the merge engine's decision tree; only
 * the writes belong here.
 * @module services/data/sync-tombstone
 */
import type { Json } from "./sync";
import type { SyncContext } from "./sync-context";

/** Public surface of the tombstone engine; the host facade forwards to these. */
export interface TombstoneEngine {
  bumpCharMeta(id: string): void;
  tombChar(id: string): void;
}

export function createTombstoneEngine(ctx: SyncContext): TombstoneEngine {
  const storage = ctx.storage;

  /** Called by the character store after every save; the write itself marks the channel dirty. */
  function bumpCharMeta(id: string): void {
    if (!id) return;
    const meta = ctx.getCharsMeta();
    meta[id] = { updatedAt: ctx.now(), deviceId: ctx.chatDeviceId() };
    const tomb = ctx.getCharsTomb();
    if (tomb[id]) {
      delete tomb[id];
      storage.setItem(ctx.CHARS_TOMB_KEY, JSON.stringify(tomb));
    }
    storage.setItem(ctx.CHARS_META_KEY, JSON.stringify(meta));
  }

  function tombChar(id: string): void {
    if (!id) return;
    const tomb = ctx.getCharsTomb();
    tomb[id] = { deletedAt: ctx.now(), deviceId: ctx.chatDeviceId() };
    const meta = ctx.getCharsMeta();
    if (meta[id]) {
      delete meta[id];
      storage.setItem(ctx.CHARS_META_KEY, JSON.stringify(meta));
    }
    storage.setItem(ctx.CHARS_TOMB_KEY, JSON.stringify(tomb));
  }

  return {
    bumpCharMeta: bumpCharMeta,
    tombChar: tombChar,
  };
}
