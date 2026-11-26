(function () {
/**
 * Image channel registry: the list of endpoints the image flows may talk to, stored as user data
 * rather than as branches in code.
 *
 * A channel is `{ id, name, kind, transport, baseUrl, key, models, model, editModel, capabilities }`
 * plus the ComfyUI sampling knobs. `kind` picks the protocol (OpenAI-compatible or local ComfyUI);
 * `transport` picks the route (`site` goes through the worker's image proxy, `direct` reaches the
 * provider from the browser). Gitee ships as one `site` preset; anything the user adds is `direct`
 * unless it says otherwise.
 *
 * Timestamps are the merge currency. Every save bumps `updatedAt` only when the content actually
 * changed, because the channel card saves on every visit and a browsing pass must not win a
 * cross-device merge. A channel without the field counts as 0, so an empty local preset can never
 * overwrite a copy that has a key in it.
 *
 * `save()` writes without switching; `setActive()` switches. Keeping them apart means adding a
 * channel does not silently steal the current selection. The service is storage-only — the key
 * names and localStorage live in the wiring.
 * @module services/image/channels
 */

                                               
                                                 
                                               

                               
             
               
                    
                              
                  
              
                   
                
                    
                                    
               
                
              
                  
                    
                    
 

                                  
                                      
                                            
                                
 

                                
                           
                                                                       
                
 

                           
                         
                                       
                                   
                     
                                 
                                  
                         
                              
                                             
                                             
                                                        
                              
 

const LS_CHANNELS = "cfw_image_channels_v1";
const LS_ACTIVE = "cfw_image_channel_active_v1";
const LEGACY_KEY = "cfw_image_key_v1";
const MAX_CHANNELS = 40;
const MAX_MODELS = 30;

const DEFAULT_GITEE               = {
  id: "gitee",
  name: "Gitee AI",
  kind: "openai",
  transport: "site",
  baseUrl: "https://ai.gitee.com/v1",
  key: "",
  models: ["z-image-turbo", "Qwen-Image-Edit-2511"],
  model: "z-image-turbo",
  editModel: "Qwen-Image-Edit-2511",
  capabilities: ["t2i", "edit"],
  ckpt: "z-image-turbo-fp8-aio.safetensors",
  steps: 9,
  cfg: 1,
  sampler: "res_multistep",
  scheduler: "simple",
  updatedAt: 0
};

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

function clone   (v   )    {
  try {
    // JSON.parse is `any`, so this returns without an assertion; the shape is asserted by the
    // caller's generic, which is enough for a value this module itself produced.
    return JSON.parse(JSON.stringify(v));
  } catch (e) {
    return v;
  }
}

/** Model list from an array or a comma/newline separated string; trimmed, deduped by omission. */
function normalizeModels(v         )           {
  if (Array.isArray(v)) {
    return v.map((x) => String(x || "").trim()).filter(Boolean).slice(0, MAX_MODELS);
  }
  return String(v || "")
    .split(/[,，\n]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, MAX_MODELS);
}

function clampN(n        , lo        , hi        )         {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Fill every field a channel needs. This runs on the read path as well as on save, so it must be
 * idempotent: a normalized channel fed back in has to come out unchanged.
 */
function normalizeChannel(raw         , now        )               {
  const ch = recOf(raw);
  const id = str(ch.id).trim() || "ch-" + now.toString(36);
  const kind              = ch.kind === "comfyui" ? "comfyui" : "openai";
  const transport                   =
    ch.transport === "site" ? "site" : (ch.transport === "direct" ? "direct" : (id === "gitee" ? "site" : "direct"));
  let models = normalizeModels(ch.models);
  if (!models.length && id === "gitee") models = ["z-image-turbo", "Qwen-Image-Edit-2511"];
  let capabilities                      = Array.isArray(ch.capabilities)
    ? ch.capabilities.filter((x)                         => x === "t2i" || x === "edit")
    : [];
  if (!Array.isArray(ch.capabilities)) {
    capabilities = kind === "openai" && str(ch.editModel) ? ["t2i", "edit"] : ["t2i"];
  }
  // A ComfyUI workflow can always take a reference image, whatever the stored list says.
  if (kind === "comfyui") capabilities = ["t2i", "edit"];
  return {
    id,
    name: String(ch.name || (kind === "comfyui" ? "本地 ComfyUI" : "自定义渠道")).slice(0, 60),
    kind,
    transport,
    baseUrl: str(ch.baseUrl).trim().replace(/\/+$/, ""),
    key: String(ch.key || ""),
    models,
    model: String(ch.model || models[0] || "").trim(),
    editModel: str(ch.editModel).trim(),
    capabilities,
    ckpt: String(ch.ckpt || "z-image-turbo-fp8-aio.safetensors").trim(),
    steps: clampN(parseInt(String(ch.steps), 10) || 9, 1, 80),
    cfg: clampN(parseFloat(String(ch.cfg)) || 1, 0, 30),
    sampler: String(ch.sampler || "res_multistep").trim(),
    scheduler: String(ch.scheduler || "simple").trim(),
    updatedAt: Math.max(0, Number(ch.updatedAt) || 0)
  };
}

/** Field-by-field comparison that ignores the timestamp: same content must keep the old stamp. */
function sameExceptStamp(a              , b              )          {
  const ka = Object.keys(a).filter((k) => k !== "updatedAt").sort();
  const kb = Object.keys(b).filter((k) => k !== "updatedAt").sort();
  if (ka.join("|") !== kb.join("|")) return false;
  for (const k of ka) {
    if (JSON.stringify(recOf(a)[k]) !== JSON.stringify(recOf(b)[k])) return false;
  }
  return true;
}

function createChannels(ports               )           {
  const listeners                                           = [];

  function read()                 {
    try {
      const a = JSON.parse(ports.storage.getItem(LS_CHANNELS) || "[]");
      return Array.isArray(a) ? a.map((x) => normalizeChannel(x, ports.now())) : [];
    } catch (e) {
      return [];
    }
  }

  function write(a                )       {
    try {
      ports.storage.setItem(LS_CHANNELS, JSON.stringify(a.slice(0, MAX_CHANNELS)));
    } catch (e) {
      /* storage full or blocked: the in-memory list is still valid for this session */
    }
  }

  function readActive()         {
    try {
      return ports.storage.getItem(LS_ACTIVE) || "";
    } catch (e) {
      return "";
    }
  }

  /**
   * Normalized list, seeded on first use. The legacy single-key row is folded into the Gitee
   * channel and then removed: keeping the source would refill a key the user just cleared.
   */
  function ensure()                 {
    let a = read();
    if (!a.length) a = [normalizeChannel(clone(DEFAULT_GITEE), ports.now())];
    try {
      const legacy = ports.storage.getItem(LEGACY_KEY) || "";
      if (legacy) {
        const gitee = a.filter((x) => x.id === "gitee")[0];
        if (gitee && !gitee.key) gitee.key = legacy;
        ports.storage.removeItem(LEGACY_KEY);
      }
    } catch (e) {
      /* a blocked storage read only skips the migration */
    }
    write(a);
    return a;
  }

  function list()                 {
    return ensure();
  }

  function get(id        )                      {
    return list().filter((x) => x.id === id)[0] || null;
  }

  function activeId()         {
    const a = list();
    const want = readActive();
    if (want && a.some((x) => x.id === want)) return want;
    return a[0] ? a[0].id : "";
  }

  function emit()       {
    for (const fn of listeners) {
      try {
        fn(getActive());
      } catch (e) {}
    }
  }

  function setActive(id        )          {
    const a = list();
    if (!a.some((x) => x.id === id)) return false;
    try {
      ports.storage.setItem(LS_ACTIVE, id);
    } catch (e) {}
    emit();
    return true;
  }

  function getActive()                      {
    const a = list();
    const id = activeId();
    return a.filter((x) => x.id === id)[0] || a[0] || null;
  }

  function save(ch         )               {
    const n = normalizeChannel(ch, ports.now());
    const a = list();
    const i = a.findIndex((x) => x.id === n.id);
    // Only a real content change earns a new stamp; a re-save of the same channel keeps the old
    // one, otherwise "who edited last" decays into "who browsed last".
    n.updatedAt = i >= 0 && sameExceptStamp(a[i], n) ? a[i].updatedAt || 0 : ports.now();
    if (i >= 0) a[i] = n;
    else a.push(n);
    write(a);
    emit();
    return n;
  }

  function create()               {
    const a = list();
    const ch = normalizeChannel(
      {
        id: "ch-" + ports.now().toString(36),
        name: "新渠道",
        kind: "openai",
        transport: "direct",
        baseUrl: "",
        key: "",
        models: [],
        model: "",
        editModel: "",
        capabilities: ["t2i"],
        updatedAt: ports.now()
      },
      ports.now()
    );
    a.push(ch);
    write(a);
    emit();
    return ch;
  }

  function remove(id        )          {
    let a = list();
    if (a.length <= 1) return false; // one channel always survives
    a = a.filter((x) => x.id !== id);
    write(a);
    try {
      if (readActive() === id) ports.storage.setItem(LS_ACTIVE, a[0].id);
    } catch (e) {}
    emit();
    return true;
  }

  function hasEdit(ch                      )          {
    const c = ch || getActive();
    if (!c) return false;
    if (c.kind === "comfyui") return true;
    return c.kind === "openai" && c.capabilities.indexOf("edit") >= 0;
  }

  function models(ch                      )           {
    const c = ch || getActive();
    return c && c.models ? c.models.slice() : [];
  }

  function onChange(fn                                   )       {
    if (typeof fn === "function") listeners.push(fn);
  }

  return {
    list,
    get,
    getActive,
    activeId,
    setActive,
    save,
    create,
    remove,
    hasEdit,
    models,
    onChange,
    DEFAULT_GITEE: clone(DEFAULT_GITEE)
  };
}

// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/image/channels.ts; this file owns the
// frozen global name, the three localStorage keys and the wall clock.
//
// Must load before image-common: that module reads the active channel while it initialises, so a
// late registration would leave the first generation on the default provider.
(function () {
  if (window.imageChannelsSvc) return;

  var channels = createChannels({
    storage: {
      getItem: function (k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
      setItem: function (k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} },
      removeItem: function (k) { try { window.localStorage.removeItem(k); } catch (e) {} }
    },
    now: function () { return Date.now(); }
  });

  window.imageChannelsSvc = {
    list: channels.list, get: channels.get, getActive: channels.getActive,
    activeId: channels.activeId, setActive: channels.setActive,
    save: channels.save, create: channels.create, remove: channels.remove,
    hasEdit: channels.hasEdit, models: channels.models, onChange: channels.onChange,
    DEFAULT_GITEE: channels.DEFAULT_GITEE
  };
})();

globalThis.LS_CHANNELS = LS_CHANNELS;
globalThis.LS_ACTIVE = LS_ACTIVE;
globalThis.LEGACY_KEY = LEGACY_KEY;
globalThis.DEFAULT_GITEE = DEFAULT_GITEE;
globalThis.normalizeModels = normalizeModels;
globalThis.normalizeChannel = normalizeChannel;
globalThis.sameExceptStamp = sameExceptStamp;
globalThis.createChannels = createChannels;
})();
