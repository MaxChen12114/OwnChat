(function () {
/**
 * Prompt cache for image generation: an identical prompt asked again within the TTL is answered
 * from the previous result, so it neither reaches the upstream nor burns a daily quota slot.
 *
 * Only synchronous text-to-image calls are considered, only `n === 1` (a batch would need one
 * entry per image), and only `http(s)` URLs are stored — a `data:` URL would put a base64 payload
 * into localStorage and blow its quota. Entries expire after six hours because the upstream links
 * they hold are themselves short-lived.
 *
 * This module is the arithmetic: hashing, the TTL/LRU trim, the on/off flag. The wiring layer owns
 * localStorage, the fetch interception, the change event and the Response object handed back on a
 * hit. `cacheRequest` deliberately returns the prompt alongside the key so the wiring layer can
 * record a result without re-parsing the request body.
 * @module services/image/cache
 */

                               
                                      
                                            
 

                             
                
                
 

                             
                        
                                                                                  
                 
                                                                                 
                              
 

                             
                                   
                                                         
                    
                
                      
                       
                               
 

/** A cacheable request: the entry key plus the prompt to store with a fresh result. */
                               
              
                 
 

                      
                                                                                         
                                
                                   
                
 

const LS_CACHE = "cfw_image_cache_v1";
const LS_ON = "cfw_image_cache_enabled_v1";
const MAX_ENTRIES = 80;
const TTL_MS = 6 * 3600 * 1000;
const GEN_MARK = "images/generations";
const ASYNC_MARK = "async/";

function recOf(v         )                          {
  const out                          = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

function str(v         )         {
  return typeof v === "string" ? v : "";
}

function num(v         )         {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

/** djb2-xor over UTF-16 code units, backwards. Short keys keep the stored JSON small. */
function hashKey(s        )         {
  let h = 5381;
  let i = s.length;
  while (i) {
    h = (h * 33) ^ s.charCodeAt(--i);
  }
  return "k" + (h >>> 0).toString(36);
}

/**
 * Key for a generation body, or `null` when it cannot be cached (no prompt). Defaults must stay
 * in step with the upstream's own defaults: a request that omits `model`/`size` is the same
 * request as one naming them explicitly.
 */
function keyFromBody(body         )                {
  const o = recOf(body);
  const model = str(o.model) || "z-image-turbo";
  const size = str(o.size) || "1024x1024";
  const prompt = str(o.prompt).trim();
  if (!prompt) return null;
  return hashKey(model + "|" + size + "|" + prompt);
}

/**
 * Decides whether a request is eligible for the cache, and with which key.
 *
 * `async/` is excluded on purpose: those requests return a job handle, not an image URL, and
 * caching the handle would hand back a stale job. `method` is passed in already resolved
 * (init first, then the Request object, then GET) because this module never sees either object.
 */
function cacheRequest(url         , method         , body         )                      {
  const u = str(url);
  const m = (str(method) || "GET").toUpperCase();
  if (m !== "POST") return null;
  if (u.indexOf(GEN_MARK) < 0 || u.indexOf(ASYNC_MARK) >= 0) return null;
  if (typeof body !== "string") return null;
  let parsed          = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed) return null;
  const n = recOf(parsed).n;
  // Loose on null/undefined, strict on the number: "1" as a string is a batch of unknown size.
  if (!(n === null || n === undefined || n === 1)) return null;
  const key = keyFromBody(parsed);
  if (!key) return null;
  return { key, prompt: str(recOf(parsed).prompt) };
}

/** Response body handed back on a hit; `_cached` lets callers tell a replay from a real result. */
function cachedBody(url        )         {
  return JSON.stringify({ data: [{ url: url }], _cached: true });
}

function createCache(ports            )             {
  const clock = ports.now || function ()         { return Date.now(); };

  function load()             {
    try {
      return stateOf(JSON.parse(ports.storage.getItem(LS_CACHE) || "{}"));
    } catch {
      return stateOf({});
    }
  }

  function stateOf(raw         )             {
    const root = recOf(raw);
    const entries = recOf(root.entries);
    root.entries = entries;
    const saved = typeof root.saved === "number" ? root.saved : 0;
    root.saved = saved;
    return { root: root, entries: entries, saved: saved };
  }

  function save(s            )       {
    try {
      ports.storage.setItem(LS_CACHE, JSON.stringify(s.root));
    } catch { /* the cache is an optimisation: a full disk must not break generation */ }
  }

  function statsOf(s            )             {
    return { count: Object.keys(s.entries).length, saved: s.saved };
  }

  function emit(s            )       {
    ports.notify(statsOf(s));
  }

  function get(key         )                {
    const k = str(key);
    if (!k) return null;
    const s = load();
    if (!s.entries[k]) return null;
    const e = recOf(s.entries[k]);
    if (clock() - num(e.ts) > TTL_MS) {
      delete s.entries[k];
      save(s);
      return null;
    }
    return str(e.url) || null;
  }

  function put(key         , url         , prompt         )       {
    const k = str(key);
    const u = str(url);
    if (!k || !u || u.indexOf("data:") === 0) return;
    const s = load();
    s.entries[k] = { url: u, ts: clock(), prompt: str(prompt).slice(0, 120) };
    const keys = Object.keys(s.entries);
    if (keys.length > MAX_ENTRIES) {
      const rows = keys.map(function (kk        )                            {
        return { k: kk, ts: num(recOf(s.entries[kk]).ts) };
      });
      rows.sort(function (a, b)         { return a.ts - b.ts; });
      for (const row of rows.slice(0, keys.length - MAX_ENTRIES)) delete s.entries[row.k];
    }
    save(s);
    emit(s);
  }

  function bumpSaved()       {
    const s = load();
    s.root.saved = s.saved + 1;
    s.saved = s.saved + 1;
    save(s);
    emit(s);
  }

  function clear()       {
    const s = stateOf({});
    save(s);
    emit(s);
  }

  function isEnabled()          {
    try {
      return ports.storage.getItem(LS_ON) !== "0";
    } catch {
      return true;
    }
  }

  function setEnabled(v         )       {
    try {
      ports.storage.setItem(LS_ON, v ? "1" : "0");
    } catch { /* same as save() */ }
    emit(load());
  }

  return {
    get: get,
    put: put,
    bumpSaved: bumpSaved,
    clear: clear,
    stats: function ()             { return statsOf(load()); },
    isEnabled: isEnabled,
    setEnabled: setEnabled
  };
}

// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/image/cache.ts; this file owns the
// frozen global name, localStorage, the fetch interception and the change event.
//
// The wrapper has to sit between image-quota and image-album (album is the outermost), so a hit
// never reaches the quota counter and an album write never sees a replay.
(function () {
  var G = (typeof window !== "undefined" ? window : globalThis);

  var cache = createCache({
    storage: {
      getItem: function (k) { try { return G.localStorage.getItem(k); } catch (e) { return null; } },
      setItem: function (k, v) { try { G.localStorage.setItem(k, v); } catch (e) {} }
    },
    notify: function () {
      try { G.dispatchEvent(new G.CustomEvent("imagecache:changed")); } catch (e) {}
    }
  });

  var rawFetch = G.fetch ? G.fetch.bind(G) : null;
  if (rawFetch) {
    G.fetch = function (input, init) {
      try {
        if (cache.isEnabled()) {
          var url = typeof input === "string" ? input : ((input && input.url) || "");
          var method = (init && init.method) || (input && input.method) || "GET";
          var req = cacheRequest(url, method, init && init.body);
          if (req) {
            var hit = cache.get(req.key);
            if (hit) {
              cache.bumpSaved();
              return Promise.resolve(new G.Response(cachedBody(hit), {
                status: 200,
                headers: { "Content-Type": "application/json" }
              }));
            }
            return rawFetch(input, init).then(function (res) {
              try {
                if (res && res.ok) {
                  res.clone().json().then(function (j) {
                    var first = (j && j.data && j.data[0]) || null;
                    var u = first && first.url;
                    if (u) cache.put(req.key, u, req.prompt);
                  }).catch(function () {});
                }
              } catch (e) {}
              return res;
            });
          }
        }
      } catch (e) {}
      return rawFetch(input, init);
    };
  }

  G.__imageCache = {
    get: cache.get, put: cache.put, clear: cache.clear, stats: cache.stats,
    isEnabled: cache.isEnabled, setEnabled: cache.setEnabled, hashKey: hashKey
  };

  if (typeof module === "object" && module.exports) {
    module.exports = { cache: cache, cacheRequest: cacheRequest, hashKey: hashKey };
  }
})();

globalThis.hashKey = hashKey;
globalThis.keyFromBody = keyFromBody;
globalThis.cacheRequest = cacheRequest;
globalThis.cachedBody = cachedBody;
globalThis.createCache = createCache;
})();
