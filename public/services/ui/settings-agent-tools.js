(function () {
/**
 * Agent tools settings: access mode, tool profile and the tool-round ceiling.
 *
 * The write side lives in settings.js; the read side lives in services/agent/registry.ts, which
 * the kernel queries every turn. Both used to spell out the same legal-mode set and the same round
 * caps independently — a drift waiting to happen (change the ceiling in one place, forget the
 * other). The pure decisions now live here once, and `normalizeMode` / `parseRounds` are exported
 * so the registry read side can consume the exact same rule in a later cut. The selects, labels and
 * Tauri workdir block stay in the settings card.
 *
 * The two sides express "unlimited" differently on purpose: the writer deletes the key, the
 * registry reads a missing key as 1000 (the practical ceiling). This module preserves that shape;
 * unifying the read side is a separate, explicit cut.
 * @module services/ui/settings-agent-tools
 */

const TOOLS_KEY = "cfw_agent_tools_v1";
const MODE_KEY = "cfw_agent_work_mode_v1";
const ROUNDS_KEY = "cfw_agent_max_rounds_v1";
/** Hard ceiling for a typed round count; 1000 keeps a runaway loop from burning money. */
const MAX_ROUNDS = 1000;

                                                            
                                          

/** Storage port; the wiring wraps localStorage. */
                                  
                                      
                                            
                                
 

                                
                       
                                      
                              
                                           
                           
                                          
 

/** Defensive copy of a storage read; null and non-strings read as empty. */
function rawText(v               )         {
  return typeof v === "string" ? v : "";
}

/**
 * Legal work modes, identical to the registry's read predicate: only auto/plan/full are accepted
 * verbatim, everything else — including a missing value — falls back to confirm.
 */
function normalizeMode(v         )           {
  const m = rawText(typeof v === "string" ? v : null);
  return (m === "auto" || m === "plan" || m === "full") ? m : "confirm";
}

/**
 * Round ceiling from stored text: blank, non-numeric and non-positive all mean "unlimited" (null),
 * matching the registry's 1000 default; a typed value is clamped to MAX_ROUNDS.
 */
function parseRounds(v         )                {
  const raw = rawText(typeof v === "string" ? v : null).trim();
  if (!raw) return null;
  const n = parseInt(raw, 10);
  if (!isFinite(n) || n <= 0) return null;
  return Math.min(MAX_ROUNDS, n);
}

/** Only "full" opts into the full tool list; every other value stays on core. */
function normalizeTools(v         )              {
  return typeof v === "string" && v === "full" ? "full" : "core";
}

function createAgentTools(ports                 )                {
  return {
    readMode: () => normalizeMode(ports.getItem(MODE_KEY)),
    writeMode: (value) => {
      const mode = normalizeMode(value);
      ports.setItem(MODE_KEY, mode);
      return mode;
    },
    readRounds: () => parseRounds(ports.getItem(ROUNDS_KEY)),
    writeRounds: (raw) => {
      const text = rawText(typeof raw === "string" ? raw : null).trim();
      const n = parseRounds(text);
      if (n === null) ports.removeItem(ROUNDS_KEY);
      else ports.setItem(ROUNDS_KEY, String(n));
      return n;
    },
    readTools: () => normalizeTools(ports.getItem(TOOLS_KEY)),
    writeTools: (value) => {
      const profile = normalizeTools(value);
      ports.setItem(TOOLS_KEY, profile);
      return profile;
    },
  };
}

// Browser wiring for services/ui/settings-agent-tools.ts: localStorage and the non-`__` global.
// Mode whitelist, round ceiling and tool-profile rules live in the emitted TS product.
(function () {
  window.settingsAgentTools = createAgentTools({
    getItem: function (key) {
      try { return window.localStorage.getItem(key); } catch (e) { return null; }
    },
    setItem: function (key, value) {
      try { window.localStorage.setItem(key, value); } catch (e) {}
    },
    removeItem: function (key) {
      try { window.localStorage.removeItem(key); } catch (e) {}
    },
  });
})();

globalThis.TOOLS_KEY = TOOLS_KEY;
globalThis.MODE_KEY = MODE_KEY;
globalThis.ROUNDS_KEY = ROUNDS_KEY;
globalThis.MAX_ROUNDS = MAX_ROUNDS;
globalThis.normalizeMode = normalizeMode;
globalThis.parseRounds = parseRounds;
globalThis.normalizeTools = normalizeTools;
globalThis.createAgentTools = createAgentTools;
})();
