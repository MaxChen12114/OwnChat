(function () {
/**
 * Runtime manifest: the server's answer to "which profile is this host, what may this client do,
 * and which numbers does the server enforce", plus the capability kernel that turns that answer
 * into started/stopped provider ports.
 *
 * Why this is not `core/capability.ts`: that file is the *tool* capability snapshot (what this
 * environment can do for the agent, with its two-way lock). A profile manifest is a *host*
 * contract: the server says guest/account/desktop/selfhost, and the client starts the ports that
 * profile needs. Merging the two would make "the user turned a tool off" and "this host has no
 * database" the same bit.
 *
 * Kernel semantics: applying a manifest forks ONE child scope and starts every provider module a
 * enabled capability needs, through `inject`; applying a different manifest disposes that child
 * first. Switching profiles therefore only swaps the capability/provider set — it never touches
 * the data path, the root context or any captured port. Unknown capabilities, unknown profiles and
 * malformed numbers degrade (reported, never thrown): a server that grows a field ahead of the
 * client must not stop the app from booting. A known provider that is not registered leaves its
 * capability PENDING and explainable, the same story `core/runtime.ts` tells.
 *
 * First-connect planning lives here because it is the same question asked at boot ("which host is
 * this, and what does the user want to keep"), and its answer is data, not a dialog. The dialog,
 * the storage reads and the backup/sync calls belong to the settings wiring.
 *
 * Boundary: no DOM, no storage, no network, no environment probe. Limits are advisory to the
 * client and authoritative on the server; the client uses the server's numbers verbatim (it never
 * enlarges them) and falls back to {@link DEFAULT_RUNTIME_LIMITS} only when the response omits one.
 * @module core/runtime-manifest
 */

                                                                         

/** The four profiles the matrix in the plan commits to. */
                                                                          

/** Declaration order; the UI groups by it and the profile switcher iterates it. */
const RUNTIME_PROFILES                            = ["guest", "account", "desktop", "selfhost"];

/** Capabilities this client understands. Anything else in a response is ignored with a report. */
                                 
          
          
          
             
            
         
           
        
             

/**
 * Capability registry: one row per capability and the provider services it needs. Providers are
 * named after the port they publish (`transport` / `secret` / `storage` / `db`), never after a
 * concrete adapter — "D1" is a choice the db provider makes, not a capability.
 */
                                        
                                   
                                        
 

const RUNTIME_CAPABILITIES                                   = [
  { id: "chat", providers: ["transport", "storage"] },
  { id: "sync", providers: ["transport", "secret"] },
  { id: "data", providers: ["db"] },
  { id: "presets", providers: ["transport", "secret"] },
  { id: "search", providers: ["transport"] },
  { id: "tts", providers: ["transport"] },
  { id: "image", providers: ["transport"] },
  { id: "pc", providers: ["transport", "secret"] },
  { id: "deploy", providers: ["transport", "secret"] },
];

/** Runtime id list derived from the registry, never a second copy of the literals. */
const RUNTIME_CAPABILITY_IDS                                 = RUNTIME_CAPABILITIES.map((s) => s.id);

/** Wire limits, one member per endpoint family the Worker caps today. */
                                                                                                                         

                                
                                                   
                                                       
                                                          
                                                       
                                                        
                  
                                  
                                 
                                     
                                    
                                   
    
                        
                                  
                                   
                           
                          
    
 

/**
 * Mirrors the literals the Worker and `src/data-api.js` enforce (5MB sync blobs, 12MiB data-body
 * cap, 100k SQL chars, 200 tx statements, 50 search hits, 1.5MB event batch, 256KiB per event).
 * `test/runtime-manifest.test.mjs` compares this table with a live `/api/runtime` response, so a
 * raised/dropped server cap turns the lock red instead of leaving the client believing a stale
 * number. Kept as a table (not constants inline in the kernel) so the fallback manifest and the
 * comparison share one source.
 */
const DEFAULT_RUNTIME_LIMITS                = {
  sync: { maxBodyBytes: 5 * 1024 * 1024 },
  syncCost: { maxBodyBytes: 512 * 1024 },
  syncExclude: { maxBodyBytes: 256 * 1024 },
  syncChat: { maxBodyBytes: 5 * 1024 * 1024 },
  syncChars: { maxBodyBytes: 5 * 1024 * 1024 },
  data: {
    maxBodyBytes: 12 * 1024 * 1024,
    maxSqlChars: 100000,
    maxTxStatements: 200,
    maxSearchLimit: 50,
    maxQueryChars: 200,
  },
  chatEvents: {
    maxBodyBytes: Math.floor(1.5 * 1024 * 1024),
    maxEventBytes: 256 * 1024,
    batch: 50,
    keep: 2000,
  },
};

/** Normalised manifest. `capabilities` contains known ids only; `issues` explains every dropped field. */
                                  
                      
                                   
                                                           
                                 
                                                                                                
                          
                                     
 

                                      
                                     
                                     
 

/** unknown JSON → plain-object view; null, arrays and scalars become an empty object. */
function recOf(value         )                          {
  const out                          = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value);
    for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  }
  return out;
}

/** Whether a string is one of the four profiles (used by parsers and the wiring's fallback). */
function isRuntimeProfile(value         )                          {
  if (typeof value !== "string") return false;
  for (let i = 0; i < RUNTIME_PROFILES.length; i++) if (RUNTIME_PROFILES[i] === value) return true;
  return false;
}

/** Whether a string is a capability this client knows. */
function isRuntimeCapability(value         )                               {
  if (typeof value !== "string") return false;
  for (let i = 0; i < RUNTIME_CAPABILITY_IDS.length; i++) if (RUNTIME_CAPABILITY_IDS[i] === value) return true;
  return false;
}

/**
 * A fresh capability table for a profile. `guest` keeps only chat: a page with no account must
 * still be able to talk (that is the "无配置 guest 可聊" rule), while cloud/admin surfaces stay
 * off until the server grants them. The three privileged profiles default to everything on and
 * are then overridden by the server's explicit booleans.
 */
function profileCapabilities(profile                )                                       {
  const out                                       = {
    chat: false,
    sync: false,
    data: false,
    presets: false,
    search: false,
    tts: false,
    image: false,
    pc: false,
    deploy: false,
  };
  if (profile === "guest") {
    out.chat = true;
    return out;
  }
  for (let i = 0; i < RUNTIME_CAPABILITY_IDS.length; i++) out[RUNTIME_CAPABILITY_IDS[i]] = true;
  return out;
}

/** Deep copy so a caller mutating the returned table cannot poison later manifests. */
function copyLimits(source               )                {
  return {
    sync: { maxBodyBytes: source.sync.maxBodyBytes },
    syncCost: { maxBodyBytes: source.syncCost.maxBodyBytes },
    syncExclude: { maxBodyBytes: source.syncExclude.maxBodyBytes },
    syncChat: { maxBodyBytes: source.syncChat.maxBodyBytes },
    syncChars: { maxBodyBytes: source.syncChars.maxBodyBytes },
    data: {
      maxBodyBytes: source.data.maxBodyBytes,
      maxSqlChars: source.data.maxSqlChars,
      maxTxStatements: source.data.maxTxStatements,
      maxSearchLimit: source.data.maxSearchLimit,
      maxQueryChars: source.data.maxQueryChars,
    },
    chatEvents: {
      maxBodyBytes: source.chatEvents.maxBodyBytes,
      maxEventBytes: source.chatEvents.maxEventBytes,
      batch: source.chatEvents.batch,
      keep: source.chatEvents.keep,
    },
  };
}

/** Read one non-negative integer; anything else is reported and replaced by the fallback. */
function limitAt(raw                         , key        , fallback        , label        , issues          )         {
  if (!Object.prototype.hasOwnProperty.call(raw, key)) return fallback;
  const value = raw[key];
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  issues.push("limits." + label + " 不是非负有限数字，已用默认值 " + fallback);
  return fallback;
}

/** Parse the wire shape; never throws, always answers a usable manifest. */
function parseRuntimeManifest(raw         )                      {
  const issues           = [];
  const root = recOf(raw);
  if (Object.prototype.hasOwnProperty.call(root, "version") && root.version !== 1) {
    issues.push("manifest.version 不是 1（收到 " + String(root.version) + "），按 1 解析");
  }

  let profile                 = "guest";
  if (isRuntimeProfile(root.profile)) profile = root.profile;
  else issues.push("未知 profile「" + String(root.profile) + "」，已按 guest 处理");

  const capabilities                          = profileCapabilities(profile);
  const capsRaw = recOf(root.capabilities);
  const capKeys = Object.keys(capsRaw);
  for (let i = 0; i < capKeys.length; i++) {
    const key = capKeys[i];
    if (!isRuntimeCapability(key)) {
      issues.push("未知能力「" + key + "」已忽略（降级，不阻塞 boot）");
      continue;
    }
    const value = capsRaw[key];
    if (typeof value === "boolean") capabilities[key] = value;
    else issues.push("能力「" + key + "」不是布尔值，已保留默认值");
  }

  const limitsRaw = recOf(root.limits);
  const syncRaw = recOf(limitsRaw.sync);
  const syncCostRaw = recOf(limitsRaw.syncCost);
  const syncExcludeRaw = recOf(limitsRaw.syncExclude);
  const syncChatRaw = recOf(limitsRaw.syncChat);
  const syncCharsRaw = recOf(limitsRaw.syncChars);
  const dataRaw = recOf(limitsRaw.data);
  const eventsRaw = recOf(limitsRaw.chatEvents);
  const limits                = {
    sync: { maxBodyBytes: limitAt(syncRaw, "maxBodyBytes", DEFAULT_RUNTIME_LIMITS.sync.maxBodyBytes, "sync.maxBodyBytes", issues) },
    syncCost: { maxBodyBytes: limitAt(syncCostRaw, "maxBodyBytes", DEFAULT_RUNTIME_LIMITS.syncCost.maxBodyBytes, "syncCost.maxBodyBytes", issues) },
    syncExclude: { maxBodyBytes: limitAt(syncExcludeRaw, "maxBodyBytes", DEFAULT_RUNTIME_LIMITS.syncExclude.maxBodyBytes, "syncExclude.maxBodyBytes", issues) },
    syncChat: { maxBodyBytes: limitAt(syncChatRaw, "maxBodyBytes", DEFAULT_RUNTIME_LIMITS.syncChat.maxBodyBytes, "syncChat.maxBodyBytes", issues) },
    syncChars: { maxBodyBytes: limitAt(syncCharsRaw, "maxBodyBytes", DEFAULT_RUNTIME_LIMITS.syncChars.maxBodyBytes, "syncChars.maxBodyBytes", issues) },
    data: {
      maxBodyBytes: limitAt(dataRaw, "maxBodyBytes", DEFAULT_RUNTIME_LIMITS.data.maxBodyBytes, "data.maxBodyBytes", issues),
      maxSqlChars: limitAt(dataRaw, "maxSqlChars", DEFAULT_RUNTIME_LIMITS.data.maxSqlChars, "data.maxSqlChars", issues),
      maxTxStatements: limitAt(dataRaw, "maxTxStatements", DEFAULT_RUNTIME_LIMITS.data.maxTxStatements, "data.maxTxStatements", issues),
      maxSearchLimit: limitAt(dataRaw, "maxSearchLimit", DEFAULT_RUNTIME_LIMITS.data.maxSearchLimit, "data.maxSearchLimit", issues),
      maxQueryChars: limitAt(dataRaw, "maxQueryChars", DEFAULT_RUNTIME_LIMITS.data.maxQueryChars, "data.maxQueryChars", issues),
    },
    chatEvents: {
      maxBodyBytes: limitAt(eventsRaw, "maxBodyBytes", DEFAULT_RUNTIME_LIMITS.chatEvents.maxBodyBytes, "chatEvents.maxBodyBytes", issues),
      maxEventBytes: limitAt(eventsRaw, "maxEventBytes", DEFAULT_RUNTIME_LIMITS.chatEvents.maxEventBytes, "chatEvents.maxEventBytes", issues),
      batch: limitAt(eventsRaw, "batch", DEFAULT_RUNTIME_LIMITS.chatEvents.batch, "chatEvents.batch", issues),
      keep: limitAt(eventsRaw, "keep", DEFAULT_RUNTIME_LIMITS.chatEvents.keep, "chatEvents.keep", issues),
    },
  };

  return {
    manifest: {
      version: 1,
      profile: profile,
      capabilities: capabilities,
      limits: limits,
      source: typeof root.source === "string" && root.source ? root.source : "unknown",
      issues: issues,
    },
    issues: issues,
  };
}

/**
 * The manifest used before the first fetch or after a failed one. A desktop shell can answer
 * `desktop` locally; everything else is `guest`, which still grants chat — boot never blocks on
 * `/api/runtime`.
 */
function localRuntimeManifest(profile                , issue         )                  {
  const issues           = [];
  if (typeof issue === "string" && issue) issues.push(issue);
  return {
    version: 1,
    profile: profile,
    capabilities: profileCapabilities(profile),
    limits: copyLimits(DEFAULT_RUNTIME_LIMITS),
    source: "fallback",
    issues: issues,
  };
}

                                      
                       
                           
                        
                         
                          
 

/**
 * Compare a payload size against the manifest's limit. `bytes` is expected to be a UTF-8 byte
 * count (TextEncoder); the Worker itself compares UTF-16 length, which is never larger for the
 * same string, so a client that passes here cannot be rejected for size by the server.
 */
function checkRuntimeLimit(limits               , surface         , bytes         )                      {
  const name = typeof surface === "string" ? surface : "";
  const size = typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0 ? bytes : -1;
  if (!name || !Object.prototype.hasOwnProperty.call(limits, name)) {
    return { ok: false, surface: name, size: size, limit: 0, error: "未知限额面：" + name };
  }
  const entry = recOf(Reflect.get(limits, name));
  const limit = typeof entry.maxBodyBytes === "number" ? entry.maxBodyBytes : 0;
  if (size < 0) return { ok: false, surface: name, size: size, limit: limit, error: "大小不是非负有限数字" };
  if (!limit) return { ok: false, surface: name, size: size, limit: 0, error: "该面没有 maxBodyBytes 限额" };
  return { ok: size <= limit, surface: name, size: size, limit: limit };
}

/** One provider module the kernel may start. `apply` publishes its port via `ctx.provide`. */
                                      
                                     
                                             
                            
 

                                 
                        
                                                     
                            
                                                                             
                                      
     
                                                                                              
                                                                                                  
                                                
     
                                                                                       
 

                              
                        
                              
                             
                           
                                       
 

                                    
                                   
                                                                                      
                            
                                      
                                           
                                          
                                      
                                     
                                                           
                                 
 

                                   
                
                                                                                          
                                         
                                
                                
                                            
                              
                                     
                                                                    
                  
 

                                          
                                   
                                                
                                                                         
                                                           
 

function messageOf(error         )         {
  if (error && typeof error === "object") {
    const message = recOf(error).message;
    if (typeof message === "string" && message) return message;
  }
  return String(error);
}

/** A stable string for "same manifest": profile + capability row + limits, in registry order. */
function fingerprintOf(manifest                 , registry                                  )         {
  const caps           = [];
  for (let i = 0; i < registry.length; i++) caps.push(registry[i].id + "=" + (manifest.capabilities[registry[i].id] === true ? "1" : "0"));
  return JSON.stringify([manifest.profile, caps, manifest.limits]);
}

/** Empty result used by `status()` before the first apply. */
function idleResult()                    {
  return {
    profile: "guest",
    changed: false,
    started: [],
    pending: [],
    errors: [],
    ignored: [],
    issues: ["manifest 尚未应用"],
    capabilities: profileCapabilities("guest"),
    limits: copyLimits(DEFAULT_RUNTIME_LIMITS),
  };
}

/**
 * Build the capability kernel over an existing runtime context. The kernel never owns the root
 * context: it forks a child per apply and disposes that child on the next apply or on `dispose()`,
 * so the host's services (the db facade's forwarding port in particular) survive every profile
 * switch. `get()` reads the nearest service in that child: an unstarted provider therefore falls
 * through to a root service of the same name, which is why callers gate on `capabilities()` when
 * "this profile does not run provider X" must be enforced.
 */
function createCapabilityKernel(options                         )                   {
  if (!options || !options.context || typeof options.context.fork !== "function") {
    throw new Error("runtime-manifest: 需要一个 runtime context");
  }
  const root = options.context;
  const registry = options.capabilities && options.capabilities.length ? options.capabilities : RUNTIME_CAPABILITIES;
  const providerMap = new Map                        ();
  for (let i = 0; i < options.providers.length; i++) {
    const provider = options.providers[i];
    if (!provider || typeof provider.name !== "string" || !provider.name) continue;
    if (typeof provider.apply !== "function") continue;
    providerMap.set(provider.name, provider);
  }

  let scope                        = null;
  let lastPrint = "";
  let lastResult                           = null;

  function apply(raw         )                    {
    const parsed = parseRuntimeManifest(raw);
    const manifest = parsed.manifest;
    const print = fingerprintOf(manifest, registry);
    if (scope !== null && lastResult !== null && print === lastPrint) {
      return {
        profile: lastResult.profile,
        changed: false,
        started: lastResult.started,
        pending: lastResult.pending,
        errors: lastResult.errors,
        ignored: lastResult.ignored,
        issues: parsed.issues,
        capabilities: lastResult.capabilities,
        limits: lastResult.limits,
      };
    }

    if (scope !== null) {
      scope.dispose();
      scope = null;
    }
    const next = root.fork();
    scope = next;
    const started           = [];
    const pending                = [];
    const errors                = [];
    // Unknown capabilities are dropped by the parser (so the table stays closed), but the kernel
    // still reports them: "the server grew a capability this client does not know" is exactly the
    // kind of skew the status panel must be able to explain.
    const ignored           = [];
    const rawCapKeys = Object.keys(recOf(recOf(raw).capabilities));
    for (let i = 0; i < rawCapKeys.length; i++) {
      if (!isRuntimeCapability(rawCapKeys[i])) ignored.push(rawCapKeys[i]);
    }

    for (let i = 0; i < registry.length; i++) {
      const capability = registry[i];
      if (manifest.capabilities[capability.id] !== true) continue;

      const missingProviders           = [];
      for (let p = 0; p < capability.providers.length; p++) {
        if (!providerMap.has(capability.providers[p])) missingProviders.push(capability.providers[p]);
      }
      if (missingProviders.length) {
        pending.push({
          code: "missing_provider",
          capability: capability.id,
          message: "provider 未注册：" + missingProviders.join(", "),
          missing: missingProviders,
        });
        continue;
      }

      for (let p = 0; p < capability.providers.length; p++) {
        const providerName = capability.providers[p];
        if (started.indexOf(providerName) >= 0) continue;
        const provider = providerMap.get(providerName);
        if (!provider) continue;
        started.push(providerName);
        const service = provider.service || provider.name;
        try {
          const handle = next.inject(
            provider.inject || [],
            function (ctx                )                  {
              return provider.apply(ctx, { manifest: manifest, capability: capability, provider: providerName });
            },
            "capability:" + capability.id + "/" + providerName,
          );
          if (handle.status === "pending") {
            pending.push({
              code: "provider_pending",
              capability: capability.id,
              provider: providerName,
              message: "provider「" + providerName + "」依赖未就绪：" + service,
              missing: handle.missing,
            });
          } else if (handle.status === "error") {
            errors.push({
              code: "provider_error",
              capability: capability.id,
              provider: providerName,
              message: "provider「" + providerName + "」启动失败：" + messageOf(handle.error),
            });
          }
        } catch (e) {
          // A provide() duplicate or a broken module must not abort the rest of the manifest.
          errors.push({
            code: "provider_error",
            capability: capability.id,
            provider: providerName,
            message: "provider「" + providerName + "」挂载异常：" + messageOf(e),
          });
        }
      }
    }

    const result                    = {
      profile: manifest.profile,
      changed: true,
      started: started,
      pending: pending,
      errors: errors,
      ignored: ignored,
      issues: parsed.issues,
      capabilities: manifest.capabilities,
      limits: manifest.limits,
    };
    lastPrint = print;
    lastResult = result;
    return result;
  }

  return {
    v: 1,
    apply: apply,
    get: function (service        )          {
      return scope === null ? undefined : scope.get(service);
    },
    has: function (service        )          {
      return scope !== null && scope.has(service);
    },
    explain: function (id        )                       {
      return scope === null ? null : scope.explain(id);
    },
    status: function ()                    {
      return lastResult === null ? idleResult() : lastResult;
    },
    providerNames: function ()                    {
      return Array.from(providerMap.keys());
    },
    checkLimit: function (surface         , bytes         )                      {
      const limits = lastResult === null ? DEFAULT_RUNTIME_LIMITS : lastResult.limits;
      return checkRuntimeLimit(limits, surface, bytes);
    },
    dispose: function ()       {
      if (scope !== null) {
        scope.dispose();
        scope = null;
      }
      lastPrint = "";
      lastResult = null;
    },
  };
}

/** Host identity inputs: origin is the page's origin, adapter is the selected DbPort name. */
                               
                          
                           
 

/**
 * Stable host key (`origin|adapter`). Profile is deliberately NOT part of it: logging in flips
 * guest→account and must not look like "a new host, choose what to keep".
 */
function hostKey(input         )         {
  const o = recOf(input);
  const origin = typeof o.origin === "string" ? o.origin.trim().replace(/\/+$/, "").toLowerCase() : "";
  const adapter = typeof o.adapter === "string" ? o.adapter.trim().toLowerCase() : "";
  if (!origin) return "";
  return origin + "|" + (adapter || "unknown");
}

                                                            

                                     
                                  
                                                                                      
                                   
                                                                   
                                
 

/** Warning codes instead of sentences: the dialog owns the wording (and the i18n dictionary). */
                                                                         

                                   
                              
                            
                           
                                    
                                        
                                                  
 

const FIRST_CONNECT_OPTIONS                                = [
  { id: "local", requiresBackup: true, destructive: true },
  { id: "host", requiresBackup: true, destructive: true },
  { id: "merge", requiresBackup: true, destructive: false },
];

/**
 * Decide whether this is a first connection to a different host and which three choices apply.
 * Every choice asks for a backup first (the requirement is "merge backs up first"; taking the
 * backup before the destructive two as well is the only safe reading). A missing `backupSvc` does
 * not block the choice — it produces `warning: "backup_missing"` so the dialog can say plainly
 * that continuing will not back anything up. An empty current key means the page cannot identify
 * its host; the plan then refuses to claim "new host" instead of inventing one.
 */
function planFirstConnect(currentRaw         , previousRaw         , backupAvailable         )                   {
  const current = typeof currentRaw === "string" ? currentRaw.trim() : "";
  const previous = typeof previousRaw === "string" ? previousRaw.trim() : "";
  const backup = backupAvailable === true;
  if (!current) {
    return {
      isNewHost: false,
      previous: previous,
      current: "",
      backupAvailable: backup,
      warning: "host_unknown",
      options: FIRST_CONNECT_OPTIONS,
    };
  }
  const isNewHost = !!previous && previous !== current;
  return {
    isNewHost: isNewHost,
    previous: previous,
    current: current,
    backupAvailable: backup,
    warning: isNewHost && !backup ? "backup_missing" : "",
    options: FIRST_CONNECT_OPTIONS,
  };
}

// Browser wiring for core/runtime-manifest.ts: the web provider set, the `/api/runtime` fetch,
// and the non-`__` facade `window.runtimeManifest`.
//
// Why the fetch waits for DOMContentLoaded: auth.js patches window.fetch to attach the access
// token, and it loads after this file. Fetching at parse time would ask /api/runtime without the
// token and read a guest manifest on an account host. All classic scripts have run by
// DOMContentLoaded, so that is the first moment the answer is trustworthy.
//
// Why the providers are plain objects with `apply`: they are mounted through the runtime kernel's
// `inject`, exactly like a plugin, and each one publishes its port with `ctx.provide`. The kernel
// owns the scope; this file owns the IO. T4-B's native host can register further providers through
// `runtimeManifest.registerProvider()` before boot without editing this file.
//
// Failure posture: an unreachable or 401 manifest applies the local fallback (desktop when the
// shell can invoke, otherwise guest) and records the reason in `manifest().issues`; boot never
// waits for the network. The guest fallback keeps chat on.
(function (g) {
  "use strict";
  if (g.runtimeManifest) return;

  var listeners = [];
  var kernel = null;
  var current = null;
  var booting = null;
  var started = false;

  function nowIssue(issues, text) {
    if (text) issues.push(text);
    return issues;
  }

  function dbAdapter() {
    try {
      if (g.dbSvc) {
        // Select the adapter before reading its name. `adapter()` is empty until the first get(),
        // and an empty name would turn the host key from `origin|unknown` into `origin|d1` once a
        // data-capable profile starts — a false "new host" on the very next boot.
        if (typeof g.dbSvc.get === "function") g.dbSvc.get();
        if (typeof g.dbSvc.adapter === "function") return String(g.dbSvc.adapter() || "");
      }
    } catch (e) {
      // A broken facade must read as "no adapter", not crash the manifest.
    }
    return "";
  }

  function fallbackProfile() {
    try {
      if (g.tauriSvc && typeof g.tauriSvc.available === "function" && g.tauriSvc.available()) return "desktop";
    } catch (e) {
      // No shell is a valid answer.
    }
    return "guest";
  }

  // The secrets adapter reads the same three keys core/capability.ts owns. The mapping lives here
  // because this is the IO boundary; capability.ts stays the one place that says what a token is.
  var SECRET_KEYS = {
    unlock: ["cfw_unlock_token_v1"],
    pcBridge: ["cfw_pc_bridge_token_v1", "cfw_auth_token_v1"],
    localExec: ["cfw_local_exec_token"],
  };

  function readStorage(key) {
    try {
      var value = g.localStorage.getItem(key);
      return value == null ? "" : String(value);
    } catch (e) {
      return "";
    }
  }

  function makeTransportProvider() {
    return {
      name: "transport",
      apply: function (ctx) {
        ctx.provide("transport", {
          send: function (req) {
            var r = req || {};
            var init = {
              method: typeof r.method === "string" && r.method ? r.method : "GET",
              headers: r.headers || {},
              cache: "no-store",
            };
            if (r.body != null) init.body = String(r.body);
            return g.fetch(r.url, init).then(function (res) {
              return {
                ok: !!res.ok,
                status: res.status,
                text: function () { return res.text(); },
              };
            });
          },
        });
      },
    };
  }

  function makeSecretProvider() {
    return {
      name: "secret",
      apply: function (ctx) {
        function readSecret(id) {
          var keys = SECRET_KEYS[id];
          if (!keys) return "";
          for (var i = 0; i < keys.length; i++) {
            var value = readStorage(keys[i]);
            if (value) return value;
          }
          return "";
        }
        ctx.provide("secret", {
          get: readSecret,
          has: function (id) { return !!readSecret(id); },
        });
      },
    };
  }

  function makeStorageProvider() {
    return {
      name: "storage",
      apply: function (ctx) {
        ctx.provide("storage", {
          get: function (key) {
            try { return g.localStorage.getItem(key); } catch (e) { return null; }
          },
          set: function (key, value) {
            try { g.localStorage.setItem(key, String(value)); } catch (e) { /* quota/private mode: hot window only */ }
          },
          remove: function (key) {
            try { g.localStorage.removeItem(key); } catch (e) { /* nothing to undo */ }
          },
        });
      },
    };
  }

  function makeDbProvider() {
    return {
      name: "db",
      apply: function (ctx) {
        var svc = g.dbSvc;
        if (!svc || !svc.context || typeof svc.context.get !== "function") throw new Error("dbSvc 未加载");
        // Select the concrete adapter now (first get()), but hand the stable forwarding port to
        // consumers: switching hosts later must not invalidate a captured reference.
        svc.get();
        var port = svc.context.get("db");
        if (!port) throw new Error("db 服务未提供");
        ctx.provide("db", port);
      },
    };
  }

  function providerList() {
    var list = [makeTransportProvider(), makeSecretProvider(), makeStorageProvider()];
    if (g.dbSvc) list.push(makeDbProvider());
    return list;
  }

  function withSource(manifest, source) {
    return {
      version: 1,
      profile: manifest.profile,
      capabilities: manifest.capabilities,
      limits: manifest.limits,
      source: source,
      issues: manifest.issues,
    };
  }

  function notify(detail) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](detail); } catch (e) { /* one observer must not stop the others */ }
    }
    try {
      if (typeof g.CustomEvent === "function") g.dispatchEvent(new g.CustomEvent("runtime-manifest", { detail: detail }));
    } catch (e) {
      // Older shells without CustomEvent simply do not get the broadcast.
    }
  }

  function applyParsed(manifest, source) {
    var finalManifest = withSource(manifest, source);
    var result = kernel.apply(finalManifest);
    current = { manifest: finalManifest, result: result };
    notify({ manifest: finalManifest, result: result });
    return { manifest: finalManifest, result: result };
  }

  function fetchManifest() {
    return g.fetch("/api/runtime", {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    }).then(function (res) {
      if (res.status === 401) return { error: "unauthorized", status: 401 };
      return res.text().then(function (text) {
        if (!res.ok) return { error: "http_" + res.status, status: res.status };
        try {
          return { json: JSON.parse(text) };
        } catch (e) {
          return { error: "bad_json", status: res.status };
        }
      });
    }).catch(function () {
      return { error: "network", status: 0 };
    });
  }

  function bootOnce() {
    if (booting) return booting;
    booting = fetchManifest().then(function (out) {
      if (out && out.json) {
        var parsed = parseRuntimeManifest(out.json);
        return applyParsed(parsed.manifest, "worker");
      }
      var reasons = {
        unauthorized: "manifest 401：访问码无效或未配置，按 guest 启动",
        bad_json: "/api/runtime 返回的不是 JSON，按本地 profile 启动",
        network: "/api/runtime 不可达，按本地 profile 启动",
      };
      var reason = reasons[out && out.error] || ("/api/runtime 失败（" + String(out && out.error) + "），按本地 profile 启动");
      var manifest = localRuntimeManifest(fallbackProfile(), reason);
      return applyParsed(manifest, "fallback");
    }).catch(function (e) {
      var manifest = localRuntimeManifest(fallbackProfile(), "manifest 应用失败：" + String(e && e.message || e));
      return applyParsed(manifest, "fallback");
    }).then(function (value) {
      booting = null;
      return value;
    });
    return booting;
  }

  var facade = {
    v: 1,
    ready: function () { return started === true; },
    profile: function () { return current ? current.manifest.profile : "guest"; },
    capabilities: function () { return current ? current.manifest.capabilities : {}; },
    limits: function () { return current ? current.manifest.limits : null; },
    manifest: function () { return current ? current.manifest : null; },
    status: function () { return kernel ? kernel.status() : null; },
    get: function (service) { return kernel ? kernel.get(service) : undefined; },
    has: function (service) { return kernel ? kernel.has(service) : false; },
    explain: function (id) { return kernel ? kernel.explain(id) : null; },
    checkLimit: function (surface, bytes) {
      if (kernel) return kernel.checkLimit(surface, bytes);
      return { ok: false, surface: String(surface || ""), size: Number(bytes) || 0, limit: 0, error: "manifest 尚未应用" };
    },
    apply: function (raw) {
      if (!kernel) return { manifest: null, result: null };
      var parsed = parseRuntimeManifest(raw);
      return applyParsed(parsed.manifest, "external");
    },
    refresh: function () { return started ? bootOnce() : Promise.resolve(null); },
    onChange: function (fn) {
      if (typeof fn !== "function") return function () {};
      listeners.push(fn);
      return function () {
        var i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    hostKey: function () {
      if (!g.location || !g.location.origin) return "";
      return hostKey({ origin: g.location.origin, adapter: dbAdapter() });
    },
    registerProvider: function (provider) {
      if (!provider || typeof provider.name !== "string" || typeof provider.apply !== "function") return false;
      // Registered before boot only: the kernel copies its provider list at construction.
      if (started) return false;
      pendingProviders.push(provider);
      return true;
    },
    dispose: function () {
      if (kernel) kernel.dispose();
      kernel = null;
      current = null;
      started = false;
      booting = null;
    },
  };
  var pendingProviders = [];
  g.runtimeManifest = facade;

  function start() {
    if (started) return bootOnce();
    if (!g.runtimeCore || typeof g.runtimeCore.createContext !== "function") {
      var issue = "runtime.js 未加载：capability kernel 不可用，按无 manifest 启动";
      current = { manifest: localRuntimeManifest("guest", issue), result: null };
      notify({ manifest: current.manifest, result: null });
      return Promise.resolve(current);
    }
    var root = g.dbSvc && g.dbSvc.context ? g.dbSvc.context : g.runtimeCore.createContext();
    var providers = providerList().concat(pendingProviders);
    pendingProviders = [];
    try {
      kernel = createCapabilityKernel({ context: root, providers: providers });
    } catch (e) {
      var failed = localRuntimeManifest("guest", "capability kernel 创建失败：" + String(e && e.message || e));
      current = { manifest: failed, result: null };
      notify({ manifest: failed, result: null });
      started = true;
      return Promise.resolve(current);
    }
    started = true;
    return bootOnce();
  }

  if (typeof document === "undefined") {
    // Node test realm: no boot. The exports are driven directly by the locks.
  } else if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { start(); });
  } else {
    start();
  }
})(window);

globalThis.RUNTIME_PROFILES = RUNTIME_PROFILES;
globalThis.RUNTIME_CAPABILITIES = RUNTIME_CAPABILITIES;
globalThis.RUNTIME_CAPABILITY_IDS = RUNTIME_CAPABILITY_IDS;
globalThis.DEFAULT_RUNTIME_LIMITS = DEFAULT_RUNTIME_LIMITS;
globalThis.isRuntimeProfile = isRuntimeProfile;
globalThis.isRuntimeCapability = isRuntimeCapability;
globalThis.profileCapabilities = profileCapabilities;
globalThis.parseRuntimeManifest = parseRuntimeManifest;
globalThis.localRuntimeManifest = localRuntimeManifest;
globalThis.checkRuntimeLimit = checkRuntimeLimit;
globalThis.createCapabilityKernel = createCapabilityKernel;
globalThis.hostKey = hostKey;
globalThis.planFirstConnect = planFirstConnect;
})();
