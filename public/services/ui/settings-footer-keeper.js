(function () {
/**
 * Settings-footer keeper: keeps the version tag and the footer pinned to the end of the settings
 * page, re-appending them after the settings panel repaints.
 *
 * The engine only decides *what to move and when*; every DOM access, the settings-button
 * subscription and the delayed re-runs arrive through {@link FooterKeeperPorts}, so the plan is
 * assertable in a vm without a document. Idempotent by construction: an appendChild of a node that
 * is already the last child is a no-op.
 * @module services/ui/settings-footer-keeper
 */

/** Elements the keeper needs; all lookups happen per call, never cached. */
                                  
                    
               
                  
 

/** Ports: element lookup, the settings-button click subscription and the timer source. */
                                    
                                                                               
                           
                                                                                   
                                        
                                                                  
                                             
 

/** Public surface; no frozen contract — the wiring runs it once at boot. */
                                  
                                                                                                   
                    
                                                                         
               
 

/** unknown -> plain-object view; arrays, null and scalars all become null (the standard bridge). */
function recOf(value         )                                 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const out                          = {};
  const entries = Object.entries(value);
  for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  return out;
}

function parentOf(el         )          {
  const rec = recOf(el);
  return rec === null ? null : rec["parentNode"];
}

function isSame(a         , b         )          {
  return a !== null && a !== undefined && a === b;
}

/**
 * Create the keeper. Nothing runs until {@link FooterKeeperApi.auto}; a missing settings node
 * makes every pass a no-op (the panel simply is not mounted).
 * @param ports - element lookup, click subscription and timer source from the wiring.
 * @returns The keeper with `moveToEnd` and `auto`.
 */
function createFooterKeeper(ports                   )                  {
  function moveToEnd()       {
    const settings = ports.get("settings");
    if (settings === null || settings === undefined) return;
    const settingsRec = recOf(settings);
    const append = settingsRec === null ? null : settingsRec["appendChild"];
    if (typeof append !== "function") return;
    const tag = ports.get("appVersionTag");
    const footer = ports.get("settingsFooter");
    if (isSame(parentOf(tag), settings)) append.call(settings, tag);
    if (isSame(parentOf(footer), settings)) append.call(settings, footer);
  }

  function auto()       {
    ports.onSettingsClick(function () {
      ports.schedule(moveToEnd, 80);
    });
    ports.schedule(moveToEnd, 1500);
    ports.schedule(moveToEnd, 3000);
  }

  return { moveToEnd: moveToEnd, auto: auto };
}

// Browser wiring (injected by l0/emit.mjs): runs the keeper once at boot — no frozen contract,
// the old inline script was an anonymous IIFE with no window surface.
(function () {
  var api = createFooterKeeper({
    get: function (id) {
      try {
        return document.getElementById(id);
      } catch (e) {
        return null;
      }
    },
    onSettingsClick: function (cb) {
      try {
        var sb = document.getElementById("settingsBtn");
        if (sb) sb.addEventListener("click", function () { cb(); });
      } catch (e) {}
    },
    schedule: function (fn, ms) {
      setTimeout(fn, ms);
    },
  });
  api.auto();
})();

globalThis.createFooterKeeper = createFooterKeeper;
})();
