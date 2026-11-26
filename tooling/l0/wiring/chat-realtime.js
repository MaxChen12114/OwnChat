// Browser wiring (injected by tooling/l0/emit.mjs): binds the service to the frozen window contract name.
// The realtime chat channel keeps its state machine in services/data/chat-realtime.ts; this file
// supplies the platform surface only — localStorage, fetch, timers, `document.hidden`, the DOM
// event bus, and the bridges to the three sibling modules (`__chatEvents`, `syncSvc`, `appSvc`).
// The listeners stay here too (online / offline / visibilitychange / cfw:conv-turns / a storage
// toggle flipping): the service layer knows nothing about event names, only what to do once woken.
(function () {
  var storage = {
    getItem: function (k) {
      try { return window.localStorage.getItem(k); } catch (e) { return null; }
    },
    setItem: function (k, v) {
      try { window.localStorage.setItem(k, String(v)); } catch (e) {}
    },
  };

  var timers = {
    set: function (fn, ms) { return window.setTimeout(fn, ms); },
    clear: function (h) { if (h != null) window.clearTimeout(h); },
  };

  function emit(name, detail) {
    try { window.dispatchEvent(new CustomEvent(name, { detail: detail || {} })); } catch (e) {}
  }

  var rt = createRealtime({
    storage: storage,
    http: function (url, init) { return window.fetch(url, init || {}); },
    now: function () { return Date.now(); },
    timers: timers,
    isHidden: function () { return !!document.hidden; },
    emit: emit,
    events: function () { return (typeof window !== "undefined" && window.__chatEvents) || null; },
    sync: function () { return (typeof window !== "undefined" && window.syncSvc) || null; },
    app: function () { return (typeof window !== "undefined" && window.appSvc) || null; },
    // T4-A: the session store instance (created by the chat shell after this script). Without it the
    // channel reads the hot-window key and writes the shortened map back, losing the mirror's prefix.
    sessions: function () { return (typeof window !== "undefined" && window.sessionStoreSvc) || null; },
  });

  window.chatRealtimeSvc = {
    start: rt.start,
    stop: rt.stop,
    isRunning: rt.isRunning,
    status: rt.status,
    recordLocal: rt.recordLocal,
    recordConv: rt.recordConv,
    catchUp: rt.catchUp,
    applyPending: rt.applyPending,
    setEnabled: rt.setEnabled,
    enabled: rt.enabled,
  };

  window.addEventListener("online", function () { rt.wake(); });
  window.addEventListener("offline", function () { rt.sleep(); });
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) rt.wake();
  });
  window.addEventListener("cfw:conv-turns", function () { rt.applyPending().catch(function () {}); });
  // Any change to the sync toggle, the include-chat toggle, the realtime toggle or the auth token
  // re-evaluates whether the channel should be running at all.
  window.addEventListener("storage", function (e) {
    if (!e || !e.key) return;
    if (e.key === "cfw_sync_enabled_v1" || e.key === "cfw_sync_include_chat_v1" || e.key === "cfw_chat_realtime_v1" || e.key === "cfw_auth_token_v1") {
      rt.refreshEnabled();
    }
  });

  // The first evaluation waits for sibling modules: sleep.js sits next to this file in the boot
  // list, but nothing guarantees it has run yet.
  timers.set(function () { rt.refreshEnabled(); }, 1200);
})();
