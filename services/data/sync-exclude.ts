/**
 * Exclusion channel (/sync/exclude): pushes the per-entity exclusion registry so other devices
 * honour a "clear the cloud, keep this device" decision.
 *
 * The registry itself (read, migrate, merge, add/remove) lives in the shared context because the
 * main-blob filter and the chat/chars merges consult it on every round; this fragment owns only
 * the network side. There is no debounce timer here — exclusions are rare user actions, so every
 * change pushes immediately.
 * @module services/data/sync-exclude
 */
import type { Json } from "./sync";
import { recOf } from "./sync";
import { isRec, numOf } from "./sync-context";
import type { ChannelLoop, SyncContext } from "./sync-context";

/** Public surface of the exclusion channel; the host facade forwards to these. */
export interface ExcludeChannel {
  pullExcludeOnStartup(): Promise<void>;
  pushExcludeNow(): Promise<void>;
}

export function createExcludeChannel(ctx: SyncContext): ExcludeChannel {
  const storage = ctx.storage;

  // debounceMs 0 = no debounce timer; the loop still provides the inflight lock and the retry.
  const loop: ChannelLoop = ctx.makeChannelLoop({ debounceMs: 0, job: runExcludePush });

  function pullExcludeFromKV(): Promise<Json | null> {
    return ctx.getChannel(ctx.EXCLUDE_PATH, "排除清单");
  }

  function pushExcludeToKV(reg: Json): Promise<Json> {
    return ctx.putChannel(ctx.EXCLUDE_PATH, reg, "排除清单");
  }

  async function pullExcludeOnStartup(): Promise<void> {
    if (!ctx.syncEnabled() || !ctx.token()) return;
    try {
      const remote = await pullExcludeFromKV();
      if (!remote) return;
      ctx.setRegistry(ctx.mergeRegistries(ctx.getRegistry(), remote));
      storage.setItem(ctx.LAST_EXCLUDE_PULL_KEY, String(ctx.now()));
      ctx.emit("exclude-synced", { source: "pull" });
    } catch (e) {
      ctx.emit("exclude-error", e);
    }
  }

  async function runExcludePush(): Promise<void> {
    try {
      const local = ctx.getRegistry();
      const res = await pushExcludeToKV(local);
      const merged = res["merged"];
      if (isRec(merged)) ctx.setRegistry(ctx.mergeRegistries(local, recOf(merged)));
      storage.setItem(ctx.LAST_EXCLUDE_PUSH_KEY, String(numOf(res["savedAt"]) || ctx.now()));
      ctx.incrPushCount();
      ctx.emit("exclude-synced", { source: "push" });
    } catch (e) {
      ctx.emit("exclude-error", e);
    }
  }

  async function pushExcludeNow(): Promise<void> {
    await loop.run(runExcludePush);
  }

  return {
    pullExcludeOnStartup: pullExcludeOnStartup,
    pushExcludeNow: pushExcludeNow,
  };
}
