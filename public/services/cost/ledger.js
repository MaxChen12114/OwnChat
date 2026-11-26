(function () {
/**
 * Cost accounting: pricing lookup, token-to-money arithmetic, and the per-day cost log.
 *
 * Pricing is provider aware and matched from the most specific key to the least —
 * `byo:endpoint:model` → `provider:model` → `model` — with a custom entry beating the built-in
 * table, which beats the default row. The same model can be priced differently per channel, so a
 * channel-scoped entry must never be shadowed by a bare model name.
 *
 * The log is bucketed per day *and* per device. Several devices writing the same day are merged
 * upstream with a per-field max, so one flat entry per day would lose the other device's tokens.
 * Only the last 400 days are kept: the whole blob is parsed on every write, so unbounded growth
 * would slow down the hot path.
 *
 * Every environment dependency arrives through {@link LedgerPorts} — storage, the injected pricing
 * table (read per call, so a config reload is picked up), and the "a cost landed" notification
 * whose debounce lives on the sync side. That keeps `window` out of this file, which is what the
 * type checker (no DOM lib here, on purpose) enforces, and lets the Node tests run the whole
 * ledger on a Map.
 * @module services/cost/ledger
 */

/** Key-value storage: localStorage in the browser, a Map in the Node tests. */
                            
                                      
                                            
 

/** One normalized pricing row, in CNY per million tokens. */
                          
                
                 
                    
 

/** A pricing hit: the key that matched, the row, and which layer it came from. */
                             
              
                   
                 
 

/** Service ports: every environment dependency enters here. */
                              
                     
                                                                                      
                                            
                                                            
                            
                                                                                              
                       
 

/** Host hooks: the work mode used when the caller does not name one. */
                             
                     
 

/** Stats for one request: measured when usage came back, estimated otherwise. */
                               
              
                 
                
                        
                            
                       
                          
              
               
                       
 

                                  
                    
                             
 

/** Aggregated per-model totals inside one day bucket. */
                           
               
                 
                     
                   
                    
 

                         
               
                 
                     
                   
                                                                      
                    
                                                                   
                                   
 

                            
                
               
                
                
 

/** The ledger facade. */
                             
                                              
                                               
                                                
                                               
                                                     
                                                                                                  
                                                                                                               
                                                                                                                                 
                     
                        
                                       
                                        
                                         
                                                  
                                                                                                                           
                            
                     
                                 
 

/** object to record without an assertion: an Object.entries copy. Nothing here relies on identity. */
function toRecord(o        )                          {
  const out                          = {};
  for (const [k, v] of Object.entries(o)) out[k] = v;
  return out;
}

/** unknown to number; anything non-numeric counts as 0. */
function numOf(v         )         {
  return typeof v === "number" ? v : 0;
}

// Stats line for the end of an agent turn. Unlike a single chat turn this accumulates across
// rounds (n model calls, no speed figure); without usage it reports the estimate. The accumulator
// and the bookkeeping stay with the caller.
function formatAgentRoundStats(o    
                                                 
                  
                            
 )         {
  const a = o || {};
  const usage = a.usage;
  if (usage && usage.n && usage.n > 0) {
    const p = usage.p || 0, c = usage.c || 0, n = usage.n;
    return "Prompt: " + p + " | Completion: " + c + " | Total: " + (p + c) + " | " + n + " 次模型调用";
  }
  const outEst = a.outEst || 0;
  return "Output(估算): ≈" + outEst + " | Total Out(估算): ≈" + (a.totalOutEstimate || 0);
}

// Stats line and panel snapshot for one chat turn. It neither mutates the accumulator nor records
// anything: both paths — measured usage and estimate — are formatted here, and the caller passes
// the elapsed time.
function formatTurnStats(o    
                   
                                                                                                                          
                 
                     
                         
                   
              
                 
                
              
                  
                            
 )                  {
  const a = o || {};
  const usage = a.usage;
  const seconds = Math.max(0.001, a.seconds || 0.001);
  if (usage && typeof usage.completion_tokens === "number") {
    const p = usage.prompt_tokens || 0;
    const c = usage.completion_tokens || 0;
    const t = usage.total_tokens || (p + c);
    const cached = usage.prompt_cache_hit_tokens || 0;
    const tps = c / seconds;
    let statsText = "Prompt: " + p + " | Completion: " + c + " | Total: " + t + " | Speed: " + tps.toFixed(2) + " tok/s"
      + " | CumPrompt: " + (a.cumPrompt || 0) + " | CumCompletion: " + (a.cumCompletion || 0);
    // Only fast mode is billed. What is shown is cumulative tokens and cumulative CNY — a single
    // request would round to 0.0000 at these token counts.
    if (a.fast) {
      const cumTok = (a.cumPrompt || 0) + (a.cumCompletion || 0);
      statsText += " | 累计 " + cumTok + " tok / ¥" + (a.cumCost || 0).toFixed(4);
    }
    return {
      statsText: statsText,
      lastReqStats: { at: a.at, model: a.model, mode: a.mode, prompt: p, completion: c, total: t, cacheHit: cached, ms: a.ms, est: false },
    };
  }
  const outEst = a.outEst || 0;
  const tps = outEst / seconds;
  return {
    statsText: "Output(估算): ≈" + outEst + " | Total Out(估算): ≈" + (a.totalOutEstimate || 0)
      + " | Speed(估算): " + tps.toFixed(2) + " tok/s | (usage未返回)",
    lastReqStats: { at: a.at, model: a.model, mode: a.mode, prompt: null, completion: null, total: null, cacheHit: null, ms: a.ms, est: true, outEstimate: outEst },
  };
}

function createLedger(ports             , host             )             {
  const h = host || {};
  const getMode = typeof h.getMode === "function" ? h.getMode : function () { return "free"; };
  const storage = ports.storage;

  // Provider-aware pricing, most specific key first: `byo:endpoint:model` → `provider:model` →
  // `model`. A custom entry beats the built-in table. The custom table is part of the sync
  // whitelist and never carries an API key.
  const LS_CUSTOM_PRICING = "cfw_custom_pricing_v1";
  function getCustomPricing()                          {
    try {
      const raw          = JSON.parse(storage.getItem(LS_CUSTOM_PRICING) || "{}");
      if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) return toRecord(raw);
      return {};
    } catch { return {}; }
  }
  function canonicalEndpoint(endpoint         )         {
    try {
      const u = new URL(String(endpoint || "").trim());
      u.hash = ""; u.search = "";
      u.pathname = u.pathname.replace(/\/chat\/completions\/?$/, "").replace(/\/models\/?$/, "").replace(/\/+$/, "");
      if (!u.pathname) u.pathname = "/v1";
      return u.origin + u.pathname;
    } catch { return ""; }
  }
  function pricingKeysFor(ctxOrModel         )           {
    const ctx                          = (typeof ctxOrModel === "object" && ctxOrModel !== null)
      ? toRecord(ctxOrModel)
      : { model: ctxOrModel };
    const model = String(ctx.model || "").trim();
    const provider = String(ctx.provider || ctx.mode || "").trim();
    const endpoint = canonicalEndpoint(ctx.endpoint);
    const keys           = [];
    if (!model) return keys;
    if (endpoint) keys.push("byo:" + endpoint + ":" + model);
    if (provider) keys.push(provider + ":" + model);
    keys.push(model);
    return keys;
  }
  function normalizePricing(p         )                 {
    if (typeof p !== "object" || p === null) return null;
    const rec = toRecord(p);
    // Loose Number() coercion is deliberate ("5" becomes 5, null becomes 0); a test pins it.
    const input = Number(rec.input);
    const output = Number(rec.output);
    const cache_hit = Number(rec.cache_hit == null ? rec.input : rec.cache_hit);
    if (!(input >= 0) || !(output >= 0) || !(cache_hit >= 0)) return null;
    return { input, output, cache_hit };
  }
  function getPricing(ctxOrModel         )                    {
    const custom = getCustomPricing();
    const builtin = ports.builtinPricing();
    const keys = pricingKeysFor(ctxOrModel);
    for (const k of keys) {
      const p = normalizePricing(custom[k]) || normalizePricing(builtin[k]);
      if (p) return { key: k, pricing: p, source: custom[k] ? "custom" : "builtin" };
    }
    const fallback = normalizePricing(ports.defaultPricing());
    return fallback ? { key: "__default__", pricing: fallback, source: "default" } : null;
  }
  function setCustomPricing(keyOrModel         , pricing         , ctx          )                          {
    const all = getCustomPricing();
    let key = String(keyOrModel || "").trim();
    if (ctx && typeof ctx === "object") {
      const first = pricingKeysFor(Object.assign({}, toRecord(ctx), { model: keyOrModel }))[0];
      key = first || key;
    }
    if (!key) return all;
    if (pricing == null) { delete all[key]; }
    else {
      const p = normalizePricing(pricing);
      if (p) all[key] = p;
    }
    try { storage.setItem(LS_CUSTOM_PRICING, JSON.stringify(all)); } catch {}
    return all;
  }

  // Running total, fast mode only.
  let totalCostCNY = 0;
  function getTotal()         { return totalCostCNY; }
  function addTotal(cost        )         { totalCostCNY += cost; return totalCostCNY; }

  function calcCost(modelOrCtx         , promptTokens        , completionTokens        , cachedTokens = 0)         {
    const hit = getPricing(modelOrCtx);
    if (!hit || !hit.pricing) return 0;
    const p = hit.pricing;
    const normalInput = Math.max(0, promptTokens - cachedTokens);
    const cost =
      (cachedTokens * p.cache_hit +
        normalInput * p.input +
        completionTokens * p.output) / 1_000_000;
    return cost;
  }
  function pricingContext(mode         , model         , customProvider                                        )                          {
    if (customProvider && customProvider.endpoint && customProvider.model) {
      return { provider: "byo", mode: mode || getMode(), endpoint: customProvider.endpoint, model: customProvider.model };
    }
    return { provider: mode === "fast" ? "deepseek" : "nvidia", mode: mode || getMode(), model };
  }

  // Per-day cost log, kept apart from the chat history.
  function todayStr()         {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  // Bucketed per device so two devices writing the same day merge instead of overwriting;
  // { [day]: { [deviceId]: {cost,prompt,completion,requests} } }. The device id stays local.
  const LS_DEVICE_ID = "cfw_device_id_v1";
  const LS_COST_LOG = "cfw_cost_log_v1";
  function getDeviceId()         {
    let id = storage.getItem(LS_DEVICE_ID);
    if (!id) {
      id = "dev_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      try { storage.setItem(LS_DEVICE_ID, id); } catch {}
    }
    return id;
  }
  function isFlatCostEntry(e         )          {
    if (typeof e !== "object" || e === null || Array.isArray(e)) return false;
    return ("cost" in e && typeof e.cost === "number")
      || ("requests" in e && typeof e.requests === "number")
      || ("prompt" in e && typeof e.prompt === "number")
      || ("completion" in e && typeof e.completion === "number");
  }
  function sumCostDay(dayEntry         )         {
    const out         = { cost: 0, prompt: 0, completion: 0, requests: 0, estimated: 0, models: {} };
    if (typeof dayEntry !== "object" || dayEntry === null) return out;
    const buckets            = isFlatCostEntry(dayEntry) ? [dayEntry] : Object.values(dayEntry);
    for (const e of buckets) {
      if (typeof e !== "object" || e === null) continue;
      const r = toRecord(e);
      out.cost += numOf(r.cost); out.prompt += numOf(r.prompt);
      out.completion += numOf(r.completion); out.requests += numOf(r.requests);
      out.estimated += numOf(r.estimated);
      if (typeof r.models !== "object" || r.models === null) continue;
      for (const [name, m] of Object.entries(toRecord(r.models))) {
        if (typeof m !== "object" || m === null) continue;
        const mr = toRecord(m);
        const t           = out.models[name] || (out.models[name] = { cost: 0, prompt: 0, completion: 0, requests: 0, estimated: 0 });
        t.cost += numOf(mr.cost); t.prompt += numOf(mr.prompt);
        t.completion += numOf(mr.completion); t.requests += numOf(mr.requests);
        t.estimated += numOf(mr.estimated);
      }
    }
    return out;
  }
  function loadCostLog()                          {
    try {
      const raw = storage.getItem(LS_COST_LOG);
      if (!raw) return {};
      const obj          = JSON.parse(raw);
      if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return {};
      const log = toRecord(obj);
      let migrated = false;
      for (const day in log) {
        if (isFlatCostEntry(log[day])) { log[day] = { legacy: log[day] }; migrated = true; }
      }
      if (migrated) { try { storage.setItem(LS_COST_LOG, JSON.stringify(log)); } catch {} }
      return log;
    } catch { return {}; }
  }
  function saveCostLog(log                         )       {
    try { storage.setItem(LS_COST_LOG, JSON.stringify(log)); } catch {}
  }
  function addCostToToday(cost        , promptTok         , completionTok         , model         , opts                    )       {
    // All modes book usage: cost may be 0 on the free tier, but tokens/requests must still land
    // so the per-model stats stay complete. Only a fully empty entry is skipped.
    const costN = Number(cost) || 0;
    const pN = Math.max(0, Number(promptTok) || 0);
    const cN = Math.max(0, Number(completionTok) || 0);
    if (!costN && !pN && !cN) return;
    const log = loadCostLog();
    const day = todayStr();
    const dev = getDeviceId();
    let dayObj                         ;
    if (isFlatCostEntry(log[day])) dayObj = { legacy: log[day] };
    else if (typeof log[day] === "object" && log[day] !== null) dayObj = toRecord(log[day]);
    else dayObj = {};
    const prev                          = (typeof dayObj[dev] === "object" && dayObj[dev] !== null) ? toRecord(dayObj[dev]) : {};
    const est = !!(opts && opts.est);
    const prevEst = numOf(prev.estimated);
    const e                                                   = {
      cost: numOf(prev.cost) + costN,
      prompt: numOf(prev.prompt) + pN,
      completion: numOf(prev.completion) + cN,
      requests: numOf(prev.requests) + 1,
    };
    // The estimate counter is cumulative across mixed calls: a measured call keeps the bucket's
    // prior estimate count (the original mutated in place; the copy must carry it forward).
    e.estimated = prevEst + (est ? 1 : 0);
    // Per-model buckets; cross-device totals are merged by the stats layer.
    const mk = String(model || "未知模型").trim().slice(0, 120) || "未知模型";
    const prevModels = (typeof prev.models === "object" && prev.models !== null) ? toRecord(prev.models) : {};
    const mp                          = (typeof prevModels[mk] === "object" && prevModels[mk] !== null) ? toRecord(prevModels[mk]) : {};
    const me                         = {
      cost: numOf(mp.cost) + costN,
      prompt: numOf(mp.prompt) + pN,
      completion: numOf(mp.completion) + cN,
      requests: numOf(mp.requests) + 1,
    };
    me.estimated = numOf(mp.estimated) + (est ? 1 : 0);
    e.models = { ...prevModels, [mk]: me };
    dayObj[dev] = e;
    log[day] = dayObj;
    // Keep the last 400 days: the log is parsed in full on every write, so it must not grow forever.
    const MAX_DAYS = 400;
    const dayKeys = Object.keys(log).sort();
    if (dayKeys.length > MAX_DAYS) {
      for (const d of dayKeys.slice(0, dayKeys.length - MAX_DAYS)) delete log[d];
    }
    saveCostLog(log);
    // Cost syncs on its own: any completed request queues a push (debounced upstream), and the
    // server merges per day with a max, so devices cannot clobber each other.
    if (ports.onCostAdded) {
      try { ports.onCostAdded(); } catch {}
    }
  }
  function getCostStats()            {
    const log = loadCostLog();
    const today = todayStr();
    const monthPrefix = today.slice(0, 7);
    const wk = new Date(Date.now() - 6 * 86400000);
    const weekStr = wk.getFullYear() + "-" + String(wk.getMonth() + 1).padStart(2, "0") + "-" + String(wk.getDate()).padStart(2, "0");
    let todayC = 0, weekC = 0, monthC = 0, totalC = 0;
    for (const d in log) {
      const c = sumCostDay(log[d]).cost;
      totalC += c;
      if (d === today) todayC += c;
      if (d >= weekStr) weekC += c;
      if (d.startsWith(monthPrefix)) monthC += c;
    }
    return { today: todayC, week: weekC, month: monthC, total: totalC };
  }

  return {
    getCustomPricing, canonicalEndpoint, pricingKeysFor, normalizePricing, getPricing, setCustomPricing,
    calcCost, pricingContext, todayStr, getDeviceId, isFlatCostEntry, sumCostDay,
    loadCostLog, saveCostLog, addCostToToday, getCostStats,
    getTotal, addTotal,
  };
}

// Browser wiring (injected by tooling/l0/emit.mjs): binds the service to the frozen window contract name.
//
// T4-A: mounted as a runtime plugin (`ctx.plugin`) so the ledger's provider has a lifecycle. The
// plugin injects `db` — the ledger writes through localStorage today, but the cost aggregates are
// the first thing a host wants to read from the unified store, and declaring the dependency now is
// what keeps that switch a provider change instead of a call-site sweep. The frozen
// `window.__costLedger` stays a façade over the same object; `dispose` clears it unless someone
// replaced it (a remount owns the name, not this instance).
(function () {
  "use strict";
  var HOST = (typeof window !== "undefined" && window.runtimeCore && window.runtimeCore.host) || null;

  function apply(ctx) {
    if (window.__costLedger) return function () {};
    var db = ctx && typeof ctx.get === "function" ? ctx.get("db") : null;
    var ports = {
      storage: {
        getItem: function (key) { return window.localStorage.getItem(key); },
        setItem: function (key, value) { window.localStorage.setItem(key, value); },
      },
      builtinPricing: function () { return window.DEEPSEEK_PRICING || {}; },
      defaultPricing: function () { return window.DEEPSEEK_PRICING_DEFAULT || null; },
      onCostAdded: function () {
        if (window.syncSvc && window.syncSvc.markCostDirty) { try { window.syncSvc.markCostDirty(); } catch (e) {} }
      },
    };
    var api = {
      v: 1,
      formatTurnStats: formatTurnStats,
      formatAgentRoundStats: formatAgentRoundStats,
      create: function (host) { return createLedger(ports, host); },
    };
    window.__costLedger = api;
    // The service half: other plugins inject the factory, never the window name.
    if (ctx && typeof ctx.provide === "function") {
      ctx.provide("cost", {
        v: 1,
        db: db,
        create: api.create,
        formatTurnStats: formatTurnStats,
        formatAgentRoundStats: formatAgentRoundStats,
      });
    }
    return function dispose() {
      if (window.__costLedger === api) {
        try { delete window.__costLedger; } catch (e) { window.__costLedger = undefined; }
      }
    };
  }

  var mod = { name: "cost", inject: ["db"], apply: apply };
  if (HOST) {
    HOST.define("cost", mod);
    HOST.start("cost");
    return;
  }
  // No runtime host (a stripped build): mount exactly as before and keep the façade.
  apply({ get: function () { return null; }, provide: function () {} });
})();

globalThis.formatAgentRoundStats = formatAgentRoundStats;
globalThis.formatTurnStats = formatTurnStats;
globalThis.createLedger = createLedger;
})();
