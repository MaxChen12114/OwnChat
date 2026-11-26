(function () {
/**
 * Model catalog: which models the picker offers, which one is selected, where an empty list is
 * refilled from, and how a dead model is healed.
 *
 * The catalog owns no storage: every source arrives through {@link ModelCatalogPorts} and is read
 * at call time, except the `/config.js` pool, which is snapshotted at create time as a fallback.
 * That split is deliberate — the picker must see a model switched on in settings without a reload,
 * while the snapshot keeps the first paint from flashing empty.
 *
 * `create(host)` keeps the historical host contract (`getMode` / `refreshModels` / `toast` /
 * `lsModelKey`) so call sites in app.js stay untouched; the browser adapter and the frozen global
 * live in l0/wiring/model-catalog.js.
 * @module services/model-router/model-catalog
 */

/** Key-value storage port: localStorage in the browser, a Map in the Node tests. */
                            
                                      
                                            
 

/** Read surface of the provider registry. A missing member means "not wired", not "empty". */
                                       
                                       
                                   
                                                                         
                                              
                             
 

/** Minimal auth surface; only the token is consulted. */
                           
                                         
 

/** DOM surface the reselect button needs: created elements plus the target bubble. */
                               
                              
                     
                       
                
                                                    
                                    
 

                             
                                           
 

                               
                                                                                             
 

/** Environment ports, injected by the wiring layer. */
                                    
                     
                                           
                          
                           
                           
                                 
                                 
                                     
                           
                              
 

/** Host hooks from the historical `create(host)` contract; every field is optional. */
                                   
                     
                         
                                         
                      
 

/**
 * Group picker entries by vendor prefix: `vendor/model` lands under `vendor`, a bare id stays flat
 * with an empty vendor. Group order follows first appearance, so the list does not reshuffle as the
 * catalog grows.
 */
function groupModelsForSelect(models         )                                          {
  const list = Array.isArray(models) ? models : [];
  const vendorOf = function (id         )         {
    return (String(id).indexOf("/") >= 0 ? String(id).split("/")[0] : "");
  };
  const groups = new Map                   ();
  for (const m of list) {
    const v = vendorOf((m && typeof m === "object") ? toRec(m).id : undefined);
    if (!groups.has(v)) groups.set(v, []);
    groups.get(v).push(m);
  }
  const out                                          = [];
  for (const [v, arr] of groups) out.push({ vendor: v, models: arr });
  return out;
}

function toRec(o        )                          {
  const out                          = {};
  for (const [k, v] of Object.entries(o)) out[k] = v;
  return out;
}

function createModelCatalog(ports                   , host                                     ) {
  host = host || {};
  const getMode = typeof host.getMode === "function" ? host.getMode : function () { return "free"; };
  const refreshModels = typeof host.refreshModels === "function" ? host.refreshModels : function () {};
  const toast = typeof host.toast === "function" ? host.toast : function () {};
  const lsModelKey = host.lsModelKey || "cfw_model";

  // The worker's /config.js is the only source; the snapshot below is a fallback, never a seed.
  const MODELS_FREE = ports.appModelsFree() || [];
  const MODELS_FAST = ports.appModelsFast() || [];
  const MODEL_PLACEHOLDERS                          = { "__free_placeholder__": 1, "__fast_placeholder__": 1 };
  function isPlaceholderModel(id         )          {
    return !!MODEL_PLACEHOLDERS[String(id || "").trim()];
  }
  function modelPoolKey(mode        )         {
    return mode === "fast" ? "cfw_models_fast_v1" : "cfw_models_free_v1";
  }
  // Strings become {id,label}; objects pass through untouched so extra fields (recommended,
  // description) reach the picker. Placeholders are dropped here, not at render time.
  function normalizeModelList(list         )           {
    return (Array.isArray(list) ? list : []).map(function (m) {
      if (typeof m === "string") {
        return { id: m, label: (m.indexOf("/") >= 0 ? m.split("/").pop() : m) };
      }
      return m;
    }).filter(function (m) {
      const id = (m && typeof m === "object") ? toRec(m).id : (typeof m === "string" ? m : undefined);
      return m && id && !isPlaceholderModel(id);
    });
  }
  function getRuntimeModels(mode        )           {
    // Active channel wins: its enabled models beat the mode pool. If the channel did return a
    // list but every model is switched off, only the channel default survives — falling back to
    // the mode pool here would silently override an all-off decision.
    try {
      const pv = ports.providers();
      if (pv && typeof pv.effectiveKey === "function" && typeof pv.modelsAll === "function") {
        const key = pv.effectiveKey(mode);
        const allRaw = key ? pv.modelsAll(String(key)) : [];
        const all = Array.isArray(allRaw) ? allRaw : [];
        if (all.length) {
          const enabled = all.filter(function (m) { return (m && typeof m === "object") ? !!toRec(m).enabled : false; });
          if (enabled.length) return normalizeModelList(enabled);
          const meta = ((typeof key === "string" && String(key).indexOf("preset:") === 0) && typeof pv.presetMeta === "function")
            ? pv.presetMeta(String(key).slice(7)) : null;
          const dm = (meta && typeof meta === "object") ? meta.defaultModel : null;
          return dm ? [{ id: String(dm), label: String(dm) }] : [];
        }
      }
    } catch (e) {}
    const base = normalizeModelList(mode === "fast" ? (ports.appModelsFast() || MODELS_FAST) : (ports.appModelsFree() || MODELS_FREE));
    try {
      const saved = normalizeModelList(JSON.parse(ports.storage.getItem(modelPoolKey(mode)) || "[]"));
      if (saved.length) return saved;
    } catch (e) {}
    return base;
  }
  function runtimeDefaultModel(mode        , models         )         {
    // Precedence: channel default (preset metadata) > /config.js value > first entry. A channel
    // default that is absent from the current list is ignored rather than forced into the picker.
    try {
      const pv = ports.providers();
      if (pv && typeof pv.effectiveKey === "function" && typeof pv.presetMeta === "function") {
        const key = pv.effectiveKey(mode);
        if (key && String(key).indexOf("preset:") === 0) {
          const meta = pv.presetMeta(String(key).slice(7));
          const dm = (meta && typeof meta === "object") ? meta.defaultModel : null;
          const mArr = Array.isArray(models) ? models : [];
          if (dm && mArr.some(function (m) { return (m && typeof m === "object") ? toRec(m).id === dm : false; })) return String(dm);
        }
      }
    } catch (e) {}
    const configured = mode === "fast" ? ports.appDefaultModelFast() : ports.appDefaultModelFree();
    const modelsArr = Array.isArray(models) ? models : [];
    if (configured && !isPlaceholderModel(configured) && modelsArr.some(function (m) { return (m && typeof m === "object") ? toRec(m).id === configured : false; })) return String(configured);
    const first = modelsArr[0];
    return (first && typeof first === "object" && toRec(first).id) ? String(toRec(first).id) : "";
  }
  async function autoFetchModelsForMode(mode        )                   {
    // Channel fetch first (per-model switches live in the v3 registry); on failure or when the
    // registry is absent, fall back to the mode endpoint. Returns whether anything was written.
    try {
      const pv = ports.providers();
      if (pv && typeof pv.effectiveKey === "function" && typeof pv.fetchModels === "function") {
        const key = pv.effectiveKey(mode);
        if (key) {
          const res = await pv.fetchModels(String(key));
          if (res && typeof res === "object" && toRec(res).ok) { if (mode === getMode()) refreshModels(); return true; }
        }
      }
    } catch (e) {}
    try {
      const headers                         = {};
      try {
        const au = ports.auth();
        const tk = (au && typeof au.getToken === "function") ? au.getToken() : null;
        if (tk) headers.Authorization = "Bearer " + tk;
      } catch (e) {}
      const r = await fetch("/api/models?mode=" + encodeURIComponent(mode), { headers: headers });
      const d = await r.json().catch(function () { return null; });
      const models = normalizeModelList(d && typeof d === "object" ? toRec(d).models : null);
      if (!r.ok || !models.length) return false;
      ports.storage.setItem(modelPoolKey(mode), JSON.stringify(models));
      const cur = ports.storage.getItem(lsModelKey);
      if (!cur || isPlaceholderModel(cur) || !models.some(function (m) { return (m && typeof m === "object") ? toRec(m).id === cur : false; })) {
        const first = models[0];
        ports.storage.setItem(lsModelKey, (first && typeof first === "object") ? String(toRec(first).id) : "");
      }
      if (mode === getMode()) refreshModels();
      return true;
    } catch (e) { return false; }
  }
  function ensureUsableModelBeforeSend(mode        , model         , customProvider         )          {
    try {
      const au = ports.auth();
      const noToken = au && typeof au.getToken === "function" && !au.getToken();
      if (au && typeof au.getToken === "function" && noToken) {
        const cp = (customProvider && typeof customProvider === "object") ? toRec(customProvider) : {};
        if (cp.endpoint && cp.model) return true;
        ports.alertMsg("访客模式：请先在 设置 → 模型 API 新增自己的渠道并填写 Key。");
        return false;
      }
    } catch (e) {}
    const cp = (customProvider && typeof customProvider === "object") ? toRec(customProvider) : {};
    if (cp.endpoint && cp.model) return true;
    if (model && !isPlaceholderModel(model)) return true;
    setTimeout(function () { autoFetchModelsForMode(mode); }, 0);
    ports.alertMsg("当前还是模型占位符。已尝试自动拉取模型列表；如果下拉仍为空，请到「设置 → 模型 API → 渠道管理」拉取并勾选模型，或配置「自定义直连」。");
    return false;
  }

  // providerId rides along only for an explicit preset choice: no registry, no selection, or a
  // custom endpoint means omit it and let the worker resolve the mode alias.
  function activeProviderIdPayload()                          {
    try {
      const pv = ports.providers();
      const pid = (pv && typeof pv.activePresetId === "function") ? pv.activePresetId() : null;
      return pid ? { providerId: pid } : {};
    } catch (e) { return {}; }
  }
  // Dead-model healing: when the upstream or the worker reports the model as unknown or as not
  // belonging to the active channel, the bubble gets a "pick another model" button that opens
  // settings and refreshes the channel list. Actionable worker errors arrive as {"error":...};
  // formatChatErrorBody unwraps that so the bubble shows the sentence, not the raw JSON.
  function formatChatErrorBody(t         )         {
    const s = String(t || "");
    try {
      const d = JSON.parse(s);
      if (d && typeof d === "object") {
        const rec = toRec(d);
        if (typeof rec.error === "string" && rec.error) return rec.error;
      }
    } catch (e) {}
    return s.slice(0, 400);
  }
  function looksLikeInvalidModel(status         , text         )          {
    const t = String(text || "");
    const st = Number(status || 0);
    if (/不属于当前渠道/.test(t)) return true; // the worker's own channel-gate error
    if (st !== 400 && st !== 404 && st !== 422) return false;
    // Chinese wording: the worker's classification text, and Chinese upstream messages.
    if (/模型/.test(t) && /(不存在|已下线|下线|无效|未找到|已删除)/.test(t)) return true;
    // English wording: the upstream's own phrasing.
    return /\bmodel\b/i.test(t) && /(not\s+found|not\s+exist|does\s+not\s+exist|doesn'?t\s+exist|unknown|invalid|unsupported|decommission|deprecat)/i.test(t);
  }
  function attachModelReselectButton(aiRow                                 )       {
    try {
      const doc = ports.doc();
      const bubble = (aiRow && aiRow.bubble) ? aiRow.bubble : null;
      if (!doc || !bubble || bubble.querySelector(".model-reselect-btn")) return;
      const wrap = doc.createElement("div");
      wrap.style.cssText = "margin-top:6px;";
      const btn = doc.createElement("button");
      btn.type = "button"; btn.className = "smallbtn model-reselect-btn"; btn.textContent = "选择新模型";
      btn.addEventListener("click", async function () {
        try { ports.openSettingsCat("modelapi"); } catch (e) {}
        try {
          const pv = ports.providers();
          const key = (pv && typeof pv.effectiveKey === "function") ? pv.effectiveKey(getMode()) : null;
          if (key && typeof pv.fetchModels === "function") await pv.fetchModels(String(key));
        } catch (e) {}
        toast("已刷新当前渠道的模型列表 · 在「渠道管理」里勾选新模型", 3600);
      });
      wrap.appendChild(btn);
      const hint = doc.createElement("div");
      hint.style.cssText = "font-size:11px;color:var(--muted);margin-top:4px;";
      hint.textContent = "这个模型在当前渠道里可能已下线/改名。";
      wrap.appendChild(hint);
      bubble.appendChild(doc.createElement("br"));
      bubble.appendChild(wrap);
    } catch (e) {}
  }

  return {
    isPlaceholderModel, modelPoolKey, normalizeModelList, getRuntimeModels, runtimeDefaultModel,
    autoFetchModelsForMode, ensureUsableModelBeforeSend,
    activeProviderIdPayload, formatChatErrorBody, looksLikeInvalidModel, attachModelReselectButton,
  };
}

// Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name.
// The implementation lives in services/model-router/model-catalog.ts. Every window bridge is
// resolved per call (APP_* / providersSvc / authSvc / __openSettingsCat), exactly as the old code
// read them.
// `document` and `alert` are probed with typeof and reached as bare globals: the vm test puts them
// on the context object, and in a browser the global scope is the same thing.
//
// T4-A: mounted as a runtime plugin. It injects `transport` and `key` — the catalog is where the
// first real "who supplies the network / who supplies the token" question is asked, and the answer
// must come from the container instead of a second `fetch` + `authSvc` lookup. The injected ports
// are used as fallbacks behind the existing bridges, so a page without them keeps its old path.
(function () {
  "use strict";
  var HOST = (typeof window !== "undefined" && window.runtimeCore && window.runtimeCore.host) || null;

  function apply(ctx) {
    if (window.__modelCatalog) return function () {};
    var transport = ctx && typeof ctx.get === "function" ? ctx.get("transport") : null;
    var key = ctx && typeof ctx.get === "function" ? ctx.get("key") : null;
    var ports = {
      storage: {
        getItem: function (key) { return window.localStorage.getItem(key); },
        setItem: function (key, value) { window.localStorage.setItem(key, value); },
      },
      providers: function () { return window.providersSvc || null; },
      // The secret port answers the session token; authSvc stays first so a shell that mounts it
      // late still wins (its getToken reflects sign-in/out immediately).
      auth: function () {
        if (window.authSvc) return window.authSvc;
        if (!key || typeof key.get !== "function") return null;
        return { getToken: function () { return key.get("auth-token"); } };
      },
      appModelsFree: function () { return window.APP_MODELS_FREE; },
      appModelsFast: function () { return window.APP_MODELS_FAST; },
      appDefaultModelFree: function () { return window.APP_DEFAULT_MODEL_FREE; },
      appDefaultModelFast: function () { return window.APP_DEFAULT_MODEL_FAST; },
      openSettingsCat: function (cat) {
        try { if (window.__openSettingsCat) window.__openSettingsCat(cat); } catch (e) {}
      },
      doc: function () { return (typeof document !== "undefined") ? document : null; },
      alertMsg: function (msg) { if (typeof alert === "function") alert(msg); },
    };
    var api = {
      v: 1,
      groupModelsForSelect: groupModelsForSelect,
      create: function (host) { return createModelCatalog(ports, host); },
    };
    window.__modelCatalog = api;
    if (ctx && typeof ctx.provide === "function") {
      ctx.provide("modelCatalog", {
        v: 1,
        create: api.create,
        groupModelsForSelect: groupModelsForSelect,
        transport: transport,
        key: key,
      });
    }
    return function dispose() {
      if (window.__modelCatalog === api) {
        try { delete window.__modelCatalog; } catch (e) { window.__modelCatalog = undefined; }
      }
    };
  }

  var mod = { name: "model-catalog", inject: ["transport", "key"], apply: apply };
  if (HOST) {
    HOST.define("model-catalog", mod);
    HOST.start("model-catalog");
    return;
  }
  apply({ get: function () { return null; }, provide: function () {} });
})();

globalThis.groupModelsForSelect = groupModelsForSelect;
globalThis.createModelCatalog = createModelCatalog;
})();
