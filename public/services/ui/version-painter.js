(function () {
/**
 * Version painter: reads the app version from the Tauri shell and paints both version tags.
 *
 * Two shell shapes are supported (plugin API first, raw invoke second), both routed through
 * {@link PainterPorts} so the plan asserts in a vm with fake objects; web builds have no shell
 * object and stay unpainted. The painted text is also handed to the environment port
 * (`documentElement.dataset.appVersion`), which env-context reads without a window global. The
 * shell global itself belongs to services/platform/tauri.ts; this module sees only the raw object.
 * @module services/ui/version-painter
 */

/** Ports: shell access, the two text sinks and the environment version mirror. */
                               
                                                                                   
                      
                                                                                    
                                        
                                                                                          
                                          
                                                                                        
                                 
 

/** Public surface; no frozen contract of its own. */
                             
                                                                                                    
                       
 

/** unknown -> plain-object view (the standard bridge, local copy). */
function recOf(value         )                                 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const out                          = {};
  const entries = Object.entries(value);
  for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  return out;
}

/** The painted text for both tags; single source so the two sinks cannot drift. */
function versionText(v        )         {
  return "OwnChat v" + v;
}

/** Read the shell version: app plugin first, raw invoke second, empty string when neither. */
async function readTauriVersion(tauri         , invoke                                   )                  {
  const rec = recOf(tauri);
  if (rec === null) return "";
  const app = recOf(rec["app"]);
  if (app !== null && typeof app["getVersion"] === "function") {
    const v = await Promise.resolve(app["getVersion"]());
    return typeof v === "string" ? v : "";
  }
  const core = recOf(rec["core"]);
  if (core !== null && typeof core["invoke"] === "function") {
    const v = await Promise.resolve(core["invoke"]("plugin:app|version"));
    return typeof v === "string" ? v : "";
  }
  return "";
}

/** Create the painter. Nothing runs until {@link PainterApi.run}; the wiring calls it once. */
function createVersionPainter(ports              )             {
  async function run()                {
    let v = "";
    try {
      v = await readTauriVersion(ports.getTauri(), ports.invoke);
    } catch (e) {
      v = "";
    }
    if (v === "" || typeof v !== "string") return;
    ports.setEnvVersion(v);
    const text = versionText(v);
    ports.setText("appVersionTag", text);
    ports.setText("appVersionTagHome", text);
  }
  return { run: run };
}

// Browser wiring (injected by tooling/l0/emit.mjs): shell access, text sinks and the environment version
// mirror; no frozen contract of its own — the version goes to dataset.appVersion for env-context.
(function () {
  var api = createVersionPainter({
    getTauri: function () {
      try {
        return window.tauriSvc ? window.tauriSvc.raw() : null;
      } catch (e) {
        return null;
      }
    },
    invoke: function (cmd) {
      try {
        var invoke = window.tauriSvc ? window.tauriSvc.invokeOrNull() : null;
        if (invoke) return Promise.resolve(invoke(cmd));
      } catch (e) {}
      return Promise.resolve("");
    },
    setText: function (id, text) {
      try {
        var el = document.getElementById(id);
        if (el) el.textContent = text;
      } catch (e) {}
    },
    setEnvVersion: function (v) {
      try {
        // env-context reads dataset.appVersion; no window global anymore (G1).
        document.documentElement.dataset.appVersion = v;
      } catch (e) {}
    },
  });
  api.run();
})();

globalThis.versionText = versionText;
globalThis.readTauriVersion = readTauriVersion;
globalThis.createVersionPainter = createVersionPainter;
})();
