(function () {
/**
 * Boolean settings switches: the storage key, the default polarity and the class side effect each
 * one carries. The keys are the contract — the chat path reads several of them back — so they live
 * here once instead of being re-spelled at every checkbox.
 *
 * Two polarities exist in the wild and are easy to mix up: `defaultOn` switches store `'0'` only
 * when turned off (missing key means on), while `defaultOff` ones store `'1'` only when turned on.
 * {@link readToggle} owns that rule; the DOM wiring only reflects it.
 * @module services/ui/settings-toggles
 */

/** One switch: where it is stored, what "on" means, and which class it toggles (if any). */
                             
                       
                                                                                                      
                              
                                                                                           
                             
                                                                                                    
                                   
 

/** The switch table. Adding a switch = one line here plus its wiring; keys must not be re-spelled. */
const SETTINGS_TOGGLES                             = {
  stateLayer: { key: "cfw_state_layer_v1", defaultOn: true, className: "", classWhen: "on" },
  topbarCost: { key: "cfw_show_topbar_cost_v1", defaultOn: true, className: "hide-topbar-cost", classWhen: "off" },
  hideMsgActions: { key: "cfw_hide_msg_actions_v1", defaultOn: false, className: "hide-msg-actions", classWhen: "on" },
  hideStats: { key: "cfw_hide_stats_v1", defaultOn: false, className: "hide-stats", classWhen: "on" },
};

/** Storage port; the wiring wraps localStorage so quota errors never reach this module. */
                              
                                      
                                            
 

/**
 * Read one switch under its declared polarity.
 * @param spec - the table entry.
 * @param raw - the stored string, `null` when absent.
 * @returns The effective boolean; a corrupt value falls back to the default.
 */
function readToggle(spec            , raw               )          {
  if (spec.defaultOn) return raw !== "0";
  return raw === "1";
}

/**
 * Which class to add or remove for this switch state.
 * @returns `{ className, add }`; `className` is empty when the switch has no visual side effect.
 */
function planToggleClass(spec            , on         )                                      {
  if (spec.className === "") return { className: "", add: false };
  const add = spec.classWhen === "on" ? on : !on;
  return { className: spec.className, add: add };
}

/** Public surface; the wiring assigns it to a non-`__` global. */
                                     
                            
                                       
                                                                                     
                                                                          
                                                                       
                            
 

/** Create the API. An unknown id reads as off and writes nothing (fail-safe, not fail-loud: a
 * stale DOM id must not break the whole settings panel). */
function createSettingsToggles(ports             )                     {
  function specOf(id        )                    {
    const spec = SETTINGS_TOGGLES[id];
    return spec === undefined ? null : spec;
  }
  function read(id        )          {
    const spec = specOf(id);
    if (spec === null) return false;
    return readToggle(spec, ports.getItem(spec.key));
  }
  function write(id        , on         )       {
    const spec = specOf(id);
    if (spec === null) return;
    ports.setItem(spec.key, on ? "1" : "0");
  }
  function planClass(id        , on         )                                      {
    const spec = specOf(id);
    if (spec === null) return { className: "", add: false };
    return planToggleClass(spec, on);
  }
  function keyOf(id        )         {
    const spec = specOf(id);
    return spec === null ? "" : spec.key;
  }
  return { read: read, write: write, planClass: planClass, keyOf: keyOf };
}

// Browser wiring for services/ui/settings-toggles.ts: localStorage side plus the non-`__` global.
(function () {
  window.settingsToggles = createSettingsToggles({
    getItem: function (key) {
      try {
        return window.localStorage.getItem(key);
      } catch (e) {
        return null;
      }
    },
    setItem: function (key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch (e) {}
    },
  });
})();

globalThis.SETTINGS_TOGGLES = SETTINGS_TOGGLES;
globalThis.readToggle = readToggle;
globalThis.planToggleClass = planToggleClass;
globalThis.createSettingsToggles = createSettingsToggles;
})();
