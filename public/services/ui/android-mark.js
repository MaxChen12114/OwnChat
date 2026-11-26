(function () {
/**
 * Android shell marker: tags the document element so CSS can branch app-only behaviour.
 *
 * `?shell=android` plants the sticky flag; from then on the classes survive reloads and re-apply
 * on every pageshow / focus / visibilitychange. Full effects stay opt-in (same rule as the head
 * FOUC script). The engine returns the class plan from three reads; storage, classes and the
 * rebind subscriptions arrive through {@link AndroidMarkPorts}, so the plan asserts in a vm.
 * @module services/ui/android-mark
 */

/** Sticky flag: once planted, the classes apply even without the query param. */
const LS_SHELL = "cfw_android_app_shell_v1";
/** Full-effects opt-in; shared with the head FOUC script. */
const LS_FX = "cfw_app_fx_rich_v1";

/** Ports: query-param read, the two storage keys, class flips and the rebind subscriptions. */
                                   
                                                                
                              
                                    
                                          
                                                                                              
                             
                                                                     
                                 
 

/** Public surface; no frozen contract — the wiring runs it once at boot. */
                                 
                                                                                             
              
                                                           
               
 

/**
 * Pure plan: given the three reads, which classes land on `document.documentElement`.
 * Empty array means "no marker" — the caller then does nothing at all.
 */
function markPlan(shellParam               , lsShell               , lsFx               )           {
  const classes           = [];
  if (shellParam === "android" || lsShell === "1") classes.push("android-app");
  if (classes.length > 0 && lsFx === "1") classes.push("fx-rich");
  return classes;
}

/** Create the marker. Nothing runs until {@link AndroidMarkApi.run} / {@link AndroidMarkApi.auto}. */
function createAndroidMark(ports                  )                 {
  function run()       {
    const param = ports.shellParam();
    if (param === "android") ports.lsSet(LS_SHELL, "1");
    const classes = markPlan(param, ports.lsGet(LS_SHELL), ports.lsGet(LS_FX));
    for (let i = 0; i < classes.length; i++) ports.rootAdd(classes[i]);
  }
  function auto()       {
    run();
    ports.onRebind(run);
  }
  return { run: run, auto: auto };
}

// Browser wiring (injected by tooling/l0/emit.mjs): storage, classes and the three rebind events;
// no frozen contract, the old inline script was an anonymous IIFE with no window surface.
(function () {
  var api = createAndroidMark({
    shellParam: function () {
      try {
        var sp = new URLSearchParams(location.search || "");
        return sp.get("shell");
      } catch (e) {
        return null;
      }
    },
    lsGet: function (key) {
      try {
        return localStorage.getItem(key);
      } catch (e) {
        return null;
      }
    },
    lsSet: function (key, value) {
      try {
        localStorage.setItem(key, value);
      } catch (e) {}
    },
    rootAdd: function (cls) {
      try {
        document.documentElement.classList.add(cls);
      } catch (e) {}
    },
    onRebind: function (cb) {
      try {
        window.addEventListener("pageshow", cb);
        window.addEventListener("focus", cb);
        document.addEventListener("visibilitychange", cb);
      } catch (e) {}
    },
  });
  api.auto();
})();

globalThis.LS_SHELL = LS_SHELL;
globalThis.LS_FX = LS_FX;
globalThis.markPlan = markPlan;
globalThis.createAndroidMark = createAndroidMark;
})();
