(function () {
/**
 * Image generation quota: a per-device, per-day estimate of how many images this browser has
 * produced through the site's own proxy.
 *
 * The upstream free tier allows roughly 100 images a day, but the real limit is enforced by the
 * provider, so nothing here blocks a request — it only answers "how am I doing". Counting happens
 * at a single point (the fetch wrapper in the wiring layer), which is why the workshop, the WeChat
 * image sender and the quick-generate button are all covered without touching any of them.
 *
 * Known gap, deliberately not fixed: only calls that leave this device through this site are
 * counted. The standalone `/image/` page, direct calls to the provider and other devices are not.
 *
 * The store is localStorage, so the count is per browser profile and survives reloads; only the
 * last 30 days are kept. `services/image/quota` holds the arithmetic; the wiring layer owns
 * localStorage, the fetch interception, the change event and the settings card.
 * @module services/image/quota
 */

                               
                                      
                                            
 

                                
               
                
                    
               
 

                             
                        
                                                                       
               
                                                                  
                                 
 

                        
                           
                     
                     
                             
                         
                
                                                 
                            
 

const LS_DATA = "cfw_image_quota_v1";
const LS_LIMIT = "cfw_image_quota_limit_v1";
const DEFAULT_LIMIT = 100;
const KEEP_DAYS = 30;
const GEN_PATH = "/img/v1/images/generations";
const EDIT_PATH = "/img/v1/async/images/edits";

function recOf(v         )                          {
  const out                          = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

/** Local calendar day (`YYYY-MM-DD`); the quota resets at local midnight, not UTC. */
function dayKey(d      )         {
  const pad = (n        )         => (n < 10 ? "0" + String(n) : String(n));
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

/**
 * How many images a request is worth, or `0` when the URL is not a generator.
 *
 * A synchronous generation is charged for `body.n` (defaulting to 1 when the body is absent,
 * unparsable or carries a falsy `n`); an async edit is always one image.
 */
function chargeFor(url         , body         )         {
  const u = typeof url === "string" ? url : "";
  if (u.indexOf(GEN_PATH) >= 0) {
    if (typeof body !== "string") return 1;
    try {
      const parsed          = JSON.parse(body);
      const n = parsed ? recOf(parsed).n : null;
      if (!n) return 1;
      return parseInt(String(n), 10) || 1;
    } catch {
      return 1;
    }
  }
  return u.indexOf(EDIT_PATH) >= 0 ? 1 : 0;
}

function createQuota(ports            )        {
  const listeners                                    = [];
  const clock = ports.now || function ()       { return new Date(); };

  function readMap()                          {
    try { return recOf(JSON.parse(ports.storage.getItem(LS_DATA) || "{}")); } catch { return {}; }
  }
  function writeMap(m                         )       {
    try { ports.storage.setItem(LS_DATA, JSON.stringify(m)); } catch { /* quota is advisory: a full disk must not break generation */ }
  }

  function getLimit()         {
    const v = parseInt(String(ports.storage.getItem(LS_LIMIT) || ""), 10);
    return isFinite(v) && v > 0 ? v : DEFAULT_LIMIT;
  }
  function getToday()         {
    return parseInt(String(readMap()[dayKey(clock())] || 0), 10) || 0;
  }
  function getRemaining()         {
    return Math.max(0, getLimit() - getToday());
  }
  function snapshot()                {
    return { used: getToday(), limit: getLimit(), remaining: getRemaining(), date: dayKey(clock()) };
  }

  function emit()       {
    const s = snapshot();
    for (const fn of listeners) { try { fn(s); } catch { /* one bad listener must not starve the rest */ } }
    ports.notify(s);
  }

  function add(n          )         {
    let inc = parseInt(String(n), 10);
    if (!isFinite(inc) || inc === 0) inc = 1;
    const m = readMap();
    const k = dayKey(clock());
    const cur = parseInt(String(m[k] || 0), 10) || 0;
    const next = Math.max(0, cur + inc);
    m[k] = next;
    const keys = Object.keys(m).sort();
    while (keys.length > KEEP_DAYS) {
      const drop = keys.shift();
      if (drop !== undefined) delete m[drop];
    }
    writeMap(m);
    emit();
    return next;
  }

  function setLimit(n         )       {
    const v = parseInt(String(n), 10);
    if (isFinite(v) && v > 0) {
      try { ports.storage.setItem(LS_LIMIT, String(v)); } catch { /* same as above */ }
    }
    emit();
  }

  function reset()       {
    const m = readMap();
    m[dayKey(clock())] = 0;
    writeMap(m);
    emit();
  }

  function onChange(fn                            )       {
    if (typeof fn === "function") listeners.push(fn);
  }

  return { add, getToday, getLimit, setLimit, getRemaining, reset, onChange, snapshot };
}

// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/image/quota.ts; this file owns the
// frozen global name, localStorage, the fetch interception, the change event and the settings card.
//
// Two choices are deliberate:
//  - The fetch wrapper charges only after a 2xx response, so a rejected request costs nothing.
//  - renderCard() is called on every emit instead of the card subscribing to the event, because
//    the card may be mounted (or remounted) long after the count changed.
(function () {
  var G = (typeof window !== "undefined" ? window : globalThis);

  function byId(id) {
    try { return G.document ? G.document.getElementById(id) : null; } catch (e) { return null; }
  }

  function renderCard(snap) {
    var disp = byId("imgQuotaDisplay");
    if (!disp) return;
    var s = snap || quota.snapshot();
    var ratio = s.limit ? s.used / s.limit : 0;
    var color = ratio >= 1 ? "#ff5470" : (ratio >= 0.8 ? "#f80" : "#25c2a0");
    disp.innerHTML =
      '<span style="font-size:22px;font-weight:700;color:' + color + ';">' + s.used + "</span>" +
      '<span style="opacity:.6;"> / ' + s.limit + " 次</span>" +
      '<span style="margin-left:10px;font-size:12px;opacity:.7;">剩余 ' + s.remaining + "</span>";
    var bar = byId("imgQuotaBar");
    if (bar) { bar.style.width = Math.min(100, Math.round(ratio * 100)) + "%"; bar.style.background = color; }
    var lim = byId("imgQuotaLimit");
    if (lim && G.document.activeElement !== lim) lim.value = s.limit;
  }

  var quota = createQuota({
    storage: {
      getItem: function (k) { try { return G.localStorage.getItem(k); } catch (e) { return null; } },
      setItem: function (k, v) { try { G.localStorage.setItem(k, v); } catch (e) {} },
    },
    notify: function (s) {
      try { G.dispatchEvent(new G.CustomEvent("imagequota:changed", { detail: s })); } catch (e) {}
      renderCard(s);
    },
  });

  var rawFetch = G.fetch ? G.fetch.bind(G) : null;
  if (rawFetch) {
    G.fetch = function (input, init) {
      var url = "";
      try { url = (typeof input === "string") ? input : ((input && input.url) || ""); } catch (e) {}
      var charge = 0;
      try { charge = chargeFor(url, init && init.body); } catch (e) { charge = 0; }
      var p = rawFetch(input, init);
      if (charge) {
        p.then(function (res) {
          try { if (res && res.ok) quota.add(charge); } catch (e) {}
        }).catch(function () {});
      }
      return p;
    };
  }

  G.__imageQuota = {
    add: quota.add, getToday: quota.getToday, getLimit: quota.getLimit, setLimit: quota.setLimit,
    getRemaining: quota.getRemaining, reset: quota.reset, onChange: quota.onChange, renderCard: renderCard,
  };

  if (typeof module === "object" && module.exports) {
    module.exports = { chargeFor: chargeFor, dayKey: dayKey, createQuota: createQuota, quota: quota };
  }
})();

globalThis.dayKey = dayKey;
globalThis.chargeFor = chargeFor;
globalThis.createQuota = createQuota;
})();
