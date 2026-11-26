(function () {
/**
 * Settings orphan sweeper: anything appended to the settings root instead of a proper slot gets
 * adopted into the image slot instead of silently landing at the panel bottom.
 *
 * Today nothing depends on it (the avatar and expression-pack cards gained explicit slots), so it
 * is a guard, not a feature: the engine answers "is this node an orphan" and "sweep now"; the
 * root observation, the click re-sweep and the DOM writes arrive through {@link OrphanPorts}.
 * The header, the version tag and the footer live at the root on purpose — they are skipped.
 * @module services/ui/settings-orphan-observer
 */

/** Root-level nodes that belong there; ids must stay in step with the footer keeper's targets. */
function skipIds()                         {
  return { settingsHeader: 1, appVersionTag: 1, settingsFooter: 1 };
}

/** Ports: element lookup, the shell-subtree probe, children enumeration, adoption and events. */
                              
                                               
                           
                                                                                               
                                                                                 
                                        
                                                                  
                                           
                                             
                             
                                                                                                 
                                                             
                                             
                                        
                                                                               
                                             
 

/** Public surface; no frozen contract — the wiring runs it once at boot. */
                            
                                                                                           
              
                                                               
                  
 

/** unknown -> plain-object view (the standard bridge, local copy). */
function recOf(value         )                                 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const out                          = {};
  const entries = Object.entries(value);
  for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  return out;
}

/** Create the sweeper. Nothing runs until {@link OrphanApi.run}; the wiring calls it once. */
function createOrphanObserver(ports             )            {
  function isOrphan(node         )          {
    const rec = recOf(node);
    if (rec === null) return false;
    if (rec["nodeType"] !== 1) return false;
    const skip = skipIds();
    if (typeof rec["id"] === "string" && skip[rec["id"]] === 1) return false;
    const settings = ports.get("settings");
    if (rec["parentNode"] !== settings) return false;
    if (ports.shellContains(node)) return false;
    return true;
  }

  function sweep()         {
    const settings = ports.get("settings");
    if (settings === null || settings === undefined) return 0;
    let moved = 0;
    const children = ports.childrenOf(settings);
    for (let i = 0; i < children.length; i++) {
      if (isOrphan(children[i])) {
        ports.adopt(children[i]);
        moved++;
      }
    }
    return moved;
  }

  function run()       {
    sweep();
    ports.observeSettings(function (nodes) {
      for (let i = 0; i < nodes.length; i++) {
        if (isOrphan(nodes[i])) ports.adopt(nodes[i]);
      }
    });
    ports.onSettingsClick(function () {
      ports.schedule(sweep, 120);
    });
  }

  return { run: run, sweep: sweep };
}

// Browser wiring (injected by l0/emit.mjs): element lookups, the MutationObserver and the
// click re-sweep; no frozen contract, the old inline script was an anonymous IIFE.
(function () {
  var settings = document.getElementById("settings");
  var slot = document.getElementById("settingsImageSlot");
  if (!settings || !slot) return;
  var shell = settings.querySelector(".settings-shell");
  var api = createOrphanObserver({
    get: function (id) {
      try {
        return document.getElementById(id);
      } catch (e) {
        return null;
      }
    },
    shellContains: function (node) {
      try {
        return !!shell && shell.contains(node);
      } catch (e) {
        return false;
      }
    },
    childrenOf: function (root) {
      return Array.prototype.slice.call(root.children);
    },
    adopt: function (node) {
      try {
        slot.appendChild(node);
      } catch (e) {}
    },
    observeSettings: function (onAdded) {
      try {
        var ob = new MutationObserver(function (muts) {
          var added = [];
          muts.forEach(function (m) {
            m.addedNodes.forEach(function (n) {
              added.push(n);
            });
          });
          if (added.length) onAdded(added);
        });
        ob.observe(settings, { childList: true });
      } catch (e) {}
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
  api.run();
})();

globalThis.skipIds = skipIds;
globalThis.createOrphanObserver = createOrphanObserver;
})();
