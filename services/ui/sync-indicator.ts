/**
 * Cloud-sync indicator formatting and status classification, without DOM or timers. The wiring
 * owns the indicator node, the status subscription, localStorage and the refresh schedule.
 *
 * A status snapshot outranks the localStorage fallback; an unknown status with no last-push
 * timestamp means "waiting", never "synced". Times are formatted from a caller-supplied clock so
 * the boundaries can be asserted offline.
 * @module services/ui/sync-indicator
 */

function siRec(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

function siNum(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export interface SiState {
  cls: string;
  txt: string;
  title: string;
}

/** @returns a relative Chinese label for the elapsed seconds. */
export function siFmtAgo(sec: number): string {
  if (sec < 60) return sec + "秒前";
  if (sec < 3600) return Math.floor(sec / 60) + "分前";
  if (sec < 86400) return Math.floor(sec / 3600) + "小时前";
  return Math.floor(sec / 86400) + "天前";
}

/** @returns the indicator state derived from a sync status snapshot. */
export function siStateOf(status: unknown, now: number): SiState {
  const s = siRec(status);
  const state = typeof s.state === "string" ? s.state : "";
  if (state === "pushing" || state === "pulling" || state === "syncing" || s.busy) {
    return { cls: "sync-active", txt: "同步中", title: "云同步已启用" };
  }
  if (state === "error" || s.error) {
    return { cls: "sync-error", txt: "错误", title: String(s.error || s.message || "同步错误") };
  }
  const ts = siNum(s.lastPushAt) || siNum(s.lastSyncAt) || siNum(s.lastAt) || 0;
  if (ts) {
    const sec = Math.max(0, Math.floor((now - ts) / 1000));
    return { cls: "sync-ok", txt: siFmtAgo(sec), title: "上次同步 " + new Date(ts).toLocaleString() };
  }
  return { cls: "sync-ok", txt: "已同步", title: "云同步已启用" };
}

/** @returns the state used when no status snapshot is available. */
export function siFallback(lastPush: number, now: number): SiState {
  if (lastPush > 0) {
    const sec = Math.max(0, Math.floor((now - lastPush) / 1000));
    return { cls: "sync-ok", txt: siFmtAgo(sec), title: "上次推送 " + new Date(lastPush).toLocaleString() };
  }
  return { cls: "sync-idle", txt: "等待中", title: "云同步已启用" };
}

/** @returns the markup and tooltip for a disabled sync. */
export function siDisabled(): SiState {
  return {
    cls: "sync-off",
    txt: "未启用",
    title: "云同步未启用(点右上角设置开启)",
  };
}

/** @returns the dot-and-text markup for a state. */
export function siHtml(cls: string, txt: string): string {
  return '<span class="sync-dot ' + cls + '"></span><span class="sync-text">' + txt + '</span>';
}
