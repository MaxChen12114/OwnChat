// Browser wiring, appended by l0/emit.mjs. Engine: services/platform/tauri.ts (presence bits,
// bound invoke and event listener over an unknown window). This file is the only place allowed to
// hold the shell global; consumers use `tauriSvc` and never name `__TAURI__` themselves.
//
// Public API: has() / available() / presence() / raw() / invokeOrNull() / invoke(cmd,args) /
// listen(event,cb).
(function (g) {
  "use strict";
  if (g.tauriSvc) return;

  function raw() {
    try { return shellRaw(g); } catch (e) { return null; }
  }
  function invokeOrNull() {
    try { return shellInvoke(g); } catch (e) { return null; }
  }

  g.tauriSvc = {
    raw: raw,
    has: function () { return raw() != null; },
    available: function () { return invokeOrNull() != null; },
    presence: function () {
      try { return shellPresence(g); } catch (e) { return { tauri: false, internals: false, metadata: false, isTauri: false }; }
    },
    invokeOrNull: invokeOrNull,
    invoke: function (cmd, args) {
      var fn = invokeOrNull();
      if (!fn) return Promise.reject(new Error("Tauri shell is not available"));
      return fn(cmd, args);
    },
    listen: function (event, cb) {
      try {
        var fn = shellListen(g);
        return fn ? fn(event, cb) : null;
      } catch (e) {
        return null;
      }
    },
  };
})(window);
