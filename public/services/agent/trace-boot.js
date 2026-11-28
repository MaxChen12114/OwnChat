(function () {
/**
 * Agent trace boot: installs the kernel trace decorator once both sides are alive.
 *
 * The kernel is an ES module that lands on `window.AgentKernel` after every classic script, so
 * the boot polls instead of racing load order: up to {@link MAX_TRIES} attempts
 * {@link RETRY_MS} apart, then an `installed: false` state so Console diagnostics can tell
 * "gave up" from "not yet". Idempotence lives in the wiring (an installed flag gates re-entry).
 * @module services/agent/trace-boot
 */

/** Diagnostics snapshot written for Console self-checks; never read by business logic. */
                                 
                     
                  
                 
             
 

/** Ports: the two sides, the state sink, the retry scheduler, DOM-readiness and the clock. */
                                 
                       
                      
                                            
                                             
                
 

/** Public surface; the retired diagnostics sink is the wiring's job. */
                               
                                                                                            
                  
 

/** Upper bound of poll attempts before giving up (40 × 100ms = 4s of grace). */
const MAX_TRIES = 40;
/** Delay between attempts. */
const RETRY_MS = 100;

/** unknown -> plain-object view (the standard bridge, local copy). */
function viewOf(value         )                                 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const out                          = {};
  const entries = Object.entries(value);
  for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  return out;
}

/** Both sides present and the trace actually exposes the installer. */
function installReady(kernel         , trace         )          {
  if (kernel === null || kernel === undefined) return false;
  const view = viewOf(trace);
  return view !== null && typeof view["installKernelTrace"] === "function";
}

/** Create the booter. Nothing runs until {@link TraceBootApi.install}; the wiring schedules it. */
function createTraceBoot(ports                )               {
  let tries = 0;
  function install()       {
    tries++;
    const kernel = ports.getKernel();
    const trace = ports.getTrace();
    if (installReady(kernel, trace)) {
      const view = viewOf(trace);
      const installer = view === null ? null : view["installKernelTrace"];
      if (typeof installer === "function") installer.call(trace, kernel);
      ports.setBootState({ installed: true, kernel: true, trace: true, at: ports.now() });
      return;
    }
    if (tries < MAX_TRIES) {
      ports.schedule(install, RETRY_MS);
      return;
    }
    ports.setBootState({
      installed: false,
      kernel: kernel !== null && kernel !== undefined,
      trace: trace !== null && trace !== undefined,
      at: ports.now(),
    });
  }
  return { install: install };
}

// Browser wiring (injected by tooling/l0/emit.mjs): window reads and the DOM-ready hand-off.
// Idempotence used to ride on a diagnostics global; the boot now relies on its own retry budget.
(function () {
  "use strict";
  var api = createTraceBoot({
    getKernel: function () {
      return window.AgentKernel;
    },
    getTrace: function () {
      return window.__agentTrace;
    },
    setBootState: function (state) {
      // Diagnostics sink retired with the frozen global; the port stays for factory equivalence.
      void state;
    },
    schedule: function (fn, ms) {
      setTimeout(fn, ms);
    },
    onReady: function (cb) {
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", cb);
      else cb();
    },
    now: function () {
      return Date.now();
    },
  });
  // DOM 就绪后再开始轮询（与旧内联一致）
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { api.install(); });
  else api.install();
})();

globalThis.MAX_TRIES = MAX_TRIES;
globalThis.RETRY_MS = RETRY_MS;
globalThis.installReady = installReady;
globalThis.createTraceBoot = createTraceBoot;
})();
