/**
 * Cost channel (/sync/cost): the per-device usage ledger and its push loop.
 *
 * This is the one channel that ignores the master sync switch — money is not a per-device
 * preference, so cost syncs for any signed-in user. Merging happens on the worker (the push
 * response carries the whole merged log) and locally through the day×device max merge owned by the
 * merge engine; landing that response is what makes the local view converge without a pull.
 * @module services/data/sync-cost
 */
import type { Json } from "./sync";
import { recOf } from "./sync";
import { isRec, numOf } from "./sync-context";
import type { ChannelLoop, SyncContext } from "./sync-context";
import type { MergeEngine } from "./sync-merge";

/** Public surface of the cost channel; the host facade forwards to these. */
export interface CostChannel {
  markCostDirty(): void;
  pushCostNow(): Promise<void>;
  pullCostOnStartup(): Promise<void>;
  cancelTimer(): void;
}

export function createCostChannel(ctx: SyncContext, merge: MergeEngine): CostChannel {
  const storage = ctx.storage;
  const ports = ctx.ports;

  const loop: ChannelLoop = ctx.makeChannelLoop({ debounceMs: 10000, job: runCostPush });

  function getLocalCostLog(): Json {
    try {
      const raw = storage.getItem("cfw_cost_log_v1");
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return isRec(parsed) ? recOf(parsed) : {};
    } catch (e) {
      return {};
    }
  }

  function setLocalCostLog(log: Json): void {
    try {
      storage.setItem("cfw_cost_log_v1", JSON.stringify(log));
    } catch (e) {
      /* quota: the next message re-marks the channel dirty */
    }
  }

  function pullCostFromKV(): Promise<Json | null> {
    return ctx.getChannel(ctx.COST_PATH, "费用");
  }

  function pushCostToKV(log: Json): Promise<Json> {
    return ctx.putChannel(ctx.COST_PATH, log, "费用");
  }

  function refreshCostUi(): void {
    const ui = ports.costUi();
    if (!ui) return;
    try {
      if (typeof ui.refreshTopbar === "function") ui.refreshTopbar();
      if (typeof ui.refreshSettings === "function") ui.refreshSettings();
    } catch (e) {
      /* UI refresh is optional */
    }
  }

  /** Cost syncs whenever a token exists: money is not a per-device preference. */
  async function pullCostOnStartup(): Promise<void> {
    if (!ctx.token()) return;
    try {
      const remote = await pullCostFromKV();
      if (!remote) return;
      const merged = merge.mergeCostLogs(getLocalCostLog(), remote);
      setLocalCostLog(merged);
      storage.setItem("cfw_sync_last_cost_pull_v1", String(ctx.now()));
      refreshCostUi();
      ctx.emit("cost-synced", { source: "pull" });
    } catch (e) {
      ctx.emit("cost-error", e);
    }
  }

  async function runCostPush(): Promise<void> {
    try {
      const local = getLocalCostLog();
      const res = await pushCostToKV(local);
      storage.setItem("cfw_sync_last_cost_push_v1", String(numOf(res["savedAt"]) || ctx.now()));
      // The worker answers with the merged whole log, including buckets pushed by other devices
      // moments earlier; landing it here is what makes the local view converge without a pull.
      const mergedRemote = res["merged"];
      if (isRec(mergedRemote)) {
        setLocalCostLog(merge.mergeCostLogs(local, recOf(mergedRemote)));
        refreshCostUi();
      }
      ctx.incrPushCount();
      ctx.emit("cost-synced", Object.assign({}, res, { source: "push" }));
    } catch (e) {
      ctx.emit("cost-error", e);
    }
  }

  function markCostDirty(): void {
    if (!ctx.token()) return;
    if (ctx.isPaused()) return;
    // 10s, half the main blob's window: a cost row is small and the user expects the number to
    // settle quickly, but each push still costs a KV write.
    loop.markDirty();
  }

  async function pushCostNow(): Promise<void> {
    loop.cancelTimer();
    await loop.run(runCostPush);
  }

  return {
    markCostDirty: markCostDirty,
    pushCostNow: pushCostNow,
    pullCostOnStartup: pullCostOnStartup,
    cancelTimer: loop.cancelTimer,
  };
}
