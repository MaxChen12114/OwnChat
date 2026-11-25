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
