(function () {
/**
 * DevTools settings: the three storage keys behind the source / artifact tool group.
 *
 * The write side used to live in `public/js/text/ui/settings.js` (mountDevToolsCard) and the read
 * side in `services/agent/source-tools.ts`, each spelling the same literals and the same switch rule
 * independently. Store an on value with spaces in one place and the card shows one state while the
 * agent sees another, with no error anywhere. The keys, the switch polarity and the URL rules now
 * live here once; both sides consume this module.
 *
 * Notably the old card read URLs raw (`getItem(key) || ''`) while source-tools trimmed them, so a
 * manually stored trailing space rendered differently on the two sides. This module trims on both
 * reads and writes, and keeps `sourceToolsState` ('1' / '0' / '') for the card's three-way status
 * text alongside `sourceToolsOn`, the normalized boolean source-tools actually uses.
 *
 * Zero window, zero any: storage and hostname arrive as ports; the wiring wraps localStorage.
 * @module services/ui/settings-dev-tools
 */

const SOURCE_ON_KEY = "cfw_source_tools_on_v1";
const SOURCE_URL_KEY = "cfw_source_url_v1";
const ARTIFACT_URL_KEY = "cfw_artifact_url_v1";

const DEFAULT_SOURCE_URL = "http://127.0.0.1:8797";
const DEFAULT_ARTIFACT_URL = "http://127.0.0.1:8796/artifacts";

/** Storage port; the wiring wraps localStorage so quota errors never reach this module. */
                            
                                      
                                            
 

/** Injected environment: storage plus the page hostname for the unset-switch default. */
                                
                     
                     
 

/** `text()` in source-tools.ts: null reads as empty, strings pass through, the rest stringify. */
function text(value         )         {
  return value == null ? "" : typeof value === "string" ? value : String(value);
}

/** `ls()` in source-tools.ts: defensive read + trim; a throwing storage reads as empty. */
function ls(storage           , key        )         {
  try {
    return text(storage.getItem(key)).trim();
  } catch (e) {
    return "";
  }
}

/**
 * The switch rule, byte-for-byte `enabled()` in source-tools.ts: an explicit '1' / '0' wins,
 * otherwise loopback hostnames default on and every other host defaults off.
 */
function normalizeSourceToolsOn(raw               , hostname        )          {
  const on = text(raw).trim();
  if (on === "1") return true;
  if (on === "0") return false;
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

/** `base()` / `artBase()` in source-tools.ts: trim, strip trailing slashes, else the default. */
function normalizeUrl(raw               , fallback        )         {
  return text(raw).trim().replace(/\/+$/, "") || fallback;
}

                                   
                                                                                    
                           
                                                                          
                         
                                                                                   
                    
                      
                                                                                                     
                     
                       
 

                                
                         
                    
                      
 

                                      
                           
                                   
                                                         
                                                             
 

function createSettingsDevTools(ports               )                      {
  /** A throwing hostname() means "not loopback" — the same fail-closed shape as source-tools.ts. */
  function hostnameSafe()         {
    try {
      return text(ports.hostname());
    } catch (e) {
      return "";
    }
  }

  function read()                   {
    const on = ls(ports.storage, SOURCE_ON_KEY);
    const sourceUrl = ls(ports.storage, SOURCE_URL_KEY);
    const artifactUrl = ls(ports.storage, ARTIFACT_URL_KEY);
    return {
      sourceToolsState: on,
      sourceToolsOn: normalizeSourceToolsOn(on, hostnameSafe()),
      sourceUrl: sourceUrl,
      artifactUrl: artifactUrl,
      sourceBase: normalizeUrl(sourceUrl, DEFAULT_SOURCE_URL),
      artifactBase: normalizeUrl(artifactUrl, DEFAULT_ARTIFACT_URL),
    };
  }

  function write(next               )       {
    ports.storage.setItem(SOURCE_URL_KEY, text(next.sourceUrl).trim());
    ports.storage.setItem(ARTIFACT_URL_KEY, text(next.artifactUrl).trim());
    ports.storage.setItem(SOURCE_ON_KEY, next.sourceToolsOn ? "1" : "0");
  }

  return {
    read: read,
    write: write,
    keys: { ON_KEY: SOURCE_ON_KEY, URL_KEY: SOURCE_URL_KEY, ART_KEY: ARTIFACT_URL_KEY },
  };
}

// Browser wiring for services/ui/settings-dev-tools.ts: localStorage and hostname as injected
// ports, plus the non-`__` global. On/off normalization (explicit flag wins, else loopback default)
// lives in the emitted TS product and is shared with source-tools.ts via an equivalence lock.
(function () {
  window.settingsDevTools = createSettingsDevTools({
    storage: {
      getItem: function (key) {
        try { return window.localStorage.getItem(key); } catch (e) { return null; }
      },
      setItem: function (key, value) {
        try { window.localStorage.setItem(key, value); } catch (e) {}
      },
    },
    hostname: function () {
      try { return window.location.hostname; } catch (e) { return ""; }
    },
  });
})();

globalThis.SOURCE_ON_KEY = SOURCE_ON_KEY;
globalThis.SOURCE_URL_KEY = SOURCE_URL_KEY;
globalThis.ARTIFACT_URL_KEY = ARTIFACT_URL_KEY;
globalThis.DEFAULT_SOURCE_URL = DEFAULT_SOURCE_URL;
globalThis.DEFAULT_ARTIFACT_URL = DEFAULT_ARTIFACT_URL;
globalThis.normalizeSourceToolsOn = normalizeSourceToolsOn;
globalThis.normalizeUrl = normalizeUrl;
globalThis.createSettingsDevTools = createSettingsDevTools;
})();
