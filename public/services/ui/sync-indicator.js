(function () {
/**
 * Cloud-sync indicator formatting and status classification, without DOM or timers. The wiring
 * owns the indicator node, the status subscription, localStorage and the refresh schedule.
 *
 * A status snapshot outranks the localStorage fallback; an unknown status with no last-push
 * timestamp means "waiting", never "synced". Times are formatted from a caller-supplied clock so
 * the boundaries can be asserted offline.
 * @module services/ui/sync-indicator
 */

function siRec(v         )                          {
  const out                          = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

function siNum(v         )         {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

                          
              
              
                
 

/** @returns a relative Chinese label for the elapsed seconds. */
function siFmtAgo(sec        )         {
  if (sec < 60) return sec + "秒前";
  if (sec < 3600) return Math.floor(sec / 60) + "分前";
  if (sec < 86400) return Math.floor(sec / 3600) + "小时前";
  return Math.floor(sec / 86400) + "天前";
}

/** @returns the indicator state derived from a sync status snapshot. */
function siStateOf(status         , now        )          {
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
function siFallback(lastPush        , now        )          {
  if (lastPush > 0) {
    const sec = Math.max(0, Math.floor((now - lastPush) / 1000));
    return { cls: "sync-ok", txt: siFmtAgo(sec), title: "上次推送 " + new Date(lastPush).toLocaleString() };
  }
  return { cls: "sync-idle", txt: "等待中", title: "云同步已启用" };
}

/** @returns the markup and tooltip for a disabled sync. */
function siDisabled()          {
  return {
    cls: "sync-off",
    txt: "未启用",
    title: "云同步未启用(点右上角设置开启)",
  };
}

/** @returns the dot-and-text markup for a state. */
function siHtml(cls        , txt        )         {
  return '<span class="sync-dot ' + cls + '"></span><span class="sync-text">' + txt + '</span>';
}

// Browser adapter, appended by l0/emit.mjs. Engine: services/ui/sync-indicator.ts
// (relative time, status classification and markup); this file owns the indicator
// node, the status subscription, localStorage and the refresh schedule.
(function(){
  function refresh(){
    if (document.hidden) return;
    var ind = document.getElementById('syncStatusIndicator');
    if (!ind) return;
    var sync = window.__sync;
    var enabled = false;
    try {
      if (sync && typeof sync.syncEnabled === 'function') enabled = !!sync.syncEnabled();
      else if (sync && typeof sync.isEnabled === 'function') enabled = !!sync.isEnabled();
      else enabled = localStorage.getItem('cfw_sync_enabled_v1') === '1';
    } catch(e){}
    if (!enabled) {
      var off = siDisabled();
      ind.innerHTML = siHtml(off.cls, off.txt);
      ind.title = off.title;
      return;
    }
    var status = null;
    try { status = (sync && typeof sync.getStatus === 'function' && sync.getStatus()) || null; } catch(e){}
    var st;
    if (status) st = siStateOf(status, Date.now());
    else {
      var lp = parseInt(localStorage.getItem('cfw_sync_last_push_v1') || '0', 10);
      st = siFallback(Number.isFinite(lp) ? lp : 0, Date.now());
    }
    ind.innerHTML = siHtml(st.cls, st.txt);
    ind.title = st.title;
  }
  if (window.__sync && typeof window.__sync.onStatus === 'function') {
    try { window.__sync.onStatus(refresh); } catch(e){}
  }
  window.addEventListener('storage', function(e){ if (e.key && e.key.indexOf('cfw_sync_') === 0) refresh(); });
  setInterval(refresh, 15000);
  document.addEventListener('visibilitychange', function(){ if (!document.hidden) refresh(); });
  setTimeout(refresh, 200);
  setTimeout(refresh, 1500);
  setTimeout(refresh, 4000);
})();

globalThis.siFmtAgo = siFmtAgo;
globalThis.siStateOf = siStateOf;
globalThis.siFallback = siFallback;
globalThis.siDisabled = siDisabled;
globalThis.siHtml = siHtml;
})();
