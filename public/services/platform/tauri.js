(function () {
/**
 * Tauri shell port: the only module that names the platform-injected globals.
 *
 * `__TAURI__` / `__TAURI_INTERNALS__` / `__TAURI_METADATA__` are injected by the desktop shell, not
 * by this repo: they cannot be renamed, and every direct dot-read spread across the wiring kept them
 * in the contract ledger forever. This module reads them through a parameterised window view, and
 * `tooling/l0/wiring/tauri.js` publishes one plain service global. Consumers never touch the shell names.
 *
 * Boundary: shapes only over an `unknown` window; a hostile getter returns "no shell" instead of
 * throwing during boot (the old inline probes were individually try/catch'd for the same reason).
 * Reflection instead of casts: the type ratchet counts `as`/`any` as escapes, and this boundary is
 * exactly where a cast would be tempting.
 * @module services/platform/tauri
 */

/** Platform-injected globals this port owns. Kept as strings so no consumer needs a dot-read. */
const SHELL_GLOBAL_KEYS                    = ["__TAURI__", "__TAURI_INTERNALS__", "__TAURI_METADATA__"];

/** Four presence bits, mirroring the probes that used to be copied into each wiring file. */
                                
                          
                              
                             
                            
 

/** Read one global without letting a hostile getter break boot. */
function readGlobal(win         , key        )          {
  if (win === null || typeof win !== "object") return undefined;
  try {
    return Reflect.get(win, key);
  } catch (e) {
    return undefined;
  }
}

/** The raw `__TAURI__` object, or null on the web. */
function shellRaw(win         )          {
  return readGlobal(win, "__TAURI__") ?? null;
}

/** Presence bits used by the app/desktop probes (`isTauri` is only true for an explicit boolean). */
function shellPresence(win         )                {
  return {
    tauri: readGlobal(win, "__TAURI__") != null,
    internals: readGlobal(win, "__TAURI_INTERNALS__") != null,
    metadata: readGlobal(win, "__TAURI_METADATA__") != null,
    isTauri: readGlobal(win, "isTauri") === true,
  };
}

/** Bound `core.invoke`, or null when the shell is absent or shaped differently. */
function shellInvoke(win         )                                                             {
  const shell = shellRaw(win);
  if (shell === null || typeof shell !== "object") return null;
  const core = Reflect.get(shell, "core");
  if (core === null || typeof core !== "object") return null;
  const invoke = Reflect.get(core, "invoke");
  if (typeof invoke !== "function") return null;
  return function (cmd        , args          )                   {
    return Promise.resolve(Reflect.apply(invoke, core, [cmd, args]));
  };
}

/** Bound `event.listen`, or null when the shell has no event bridge. */
function shellListen(win         )                                                                      {
  const shell = shellRaw(win);
  if (shell === null || typeof shell !== "object") return null;
  const events = Reflect.get(shell, "event");
  if (events === null || typeof events !== "object") return null;
  const listen = Reflect.get(events, "listen");
  if (typeof listen !== "function") return null;
  return function (event        , cb                            )          {
    return Reflect.apply(listen, events, [event, cb]);
  };
}

// Browser wiring, appended by tooling/l0/emit.mjs. Engine: services/platform/tauri.ts (presence bits,
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

globalThis.SHELL_GLOBAL_KEYS = SHELL_GLOBAL_KEYS;
globalThis.shellRaw = shellRaw;
globalThis.shellPresence = shellPresence;
globalThis.shellInvoke = shellInvoke;
globalThis.shellListen = shellListen;
})();
