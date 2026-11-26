(function () {
/**
 * Cloud sync engine: one product that owns five independent channels between this browser and the
 * account's KV on the worker — the main blob (/sync), cost (/sync/cost), the exclusion registry
 * (/sync/exclude), chat sessions (/sync/chat) and character cards (/sync/chars).
 *
 * Every platform-shaped thing arrives through {@link SyncPorts}: storage, fetch, timers, the clock,
 * random, IndexedDB, the DOM event bus, page reload, file save and the seven sibling modules this
 * engine reads or nudges (provider merge, provider registry, cost UI, the realtime channel, the
 * character-card merge, the character store and the desktop shell). This file touches no `window`,
 * `document`, `fetch` or `indexedDB`; tooling/l0/wiring/sync.js is the adapter.
 *
 * Why five channels instead of one blob is the architecture decision worth knowing: a single
 * last-writer-wins blob over the whole database loses data whenever two devices write in the same
 * window, and it also means a phone with an empty provider list can erase the desktop's keys. Each
 * channel therefore merges by its own natural key — day×device max for cost, entry timestamp for
 * exclusions, slot hash for chat, card id for characters — and only the residue (settings) stays
 * on the whole-blob path.
 *
 * Three invariants are load-bearing:
 *  - `LS_EXPLICIT` is the *entire* allow-list for the main blob; there is no fallback sweep. A key
 *    that is not listed is silently never synced, so an omission is invisible until someone
 *    reinstalls.
 *  - An empty message array is not a delete signal. Deletion is expressed by tombstones only;
 *    treating `[]` as deletion lets one device wipe another's conversation.
 *  - Every write performed while landing remote data must be suppressed from re-marking the same
 *    channel dirty, or a merge ping-pongs forever between devices.
 * @module services/data/sync
 */

/** JSON object shape used for every untyped payload crossing the network or storage boundary. */
                                              

/** The part of the Storage interface this module uses; the adapter wraps window.localStorage. */
                            
                          
                                    
                                      
                                            
                                
 

                           
                  
                                   
                
 

/** Only the parts of a fetch response this module reads: status, ok, and one of text/json. */
                               
                 
              
                          
                           
 

                                                                               

                            
                                           
                               
 

/** One record plus the object store it came from, so it can be put back verbatim. */
                           
                
             
 

/** IndexedDB port: whole-database dump, whole-store replace, and the two exclusion helpers. */
                          
                                                                                                   
                                           
                                                                                         
                                                   
                                                                             
                                                              
                                                             
 

/** Provider merge rules owned by the provider-merge module (pure functions, lock-tested there). */
                                    
                                                          
                                                              
 

                                
                    
                      
 

                             
                        
                          
 

                               
                       
                        
                                                      
 

/** Character-card conflict merge; throws at the caller when absent, exactly as the old engine did. */
                                
                                     
 

                                
                          
 

                            
                     
                 
                    
                
                   
                                                                          
                  
               
                                                                      
                                                
                                                                                                
                     
                                                                                                      
                                                      
                               
                                            
                                    
                              
                                  
                                    
                                    
     
                                                                                               
                                                                                          
                                                                                            
                                                                     
     
                                   
 

/** The one method this engine needs from services/session/store.ts. */
                               
                                                                                   
 

                                                                      

                            
                  
                       
                        
                         
                          
                     
                      
  

                             
                 
                 
             
                 
                            
 

                              
              
             
                   
             
               
                       
 

/** Merged-cell shape of one chat push/pull; `skipped` explains a no-op without throwing. */
                             
               
                   
                 
                  
                   
                 
                          
                    
 

function recOf(value         )       {
  const out       = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
  const entries = Object.entries(value);
  for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  return out;
}

function arrOf(value         )            {
  const out            = [];
  if (!Array.isArray(value)) return out;
  for (let i = 0; i < value.length; i++) out.push(value[i]);
  return out;
}

function strOf(value         )         {
  return value == null ? "" : String(value);
}

function numOf(value         )         {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function isRec(value         )          {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function keysOf(obj      )           {
  const out           = [];
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) out.push(keys[i]);
  return out;
}

/**
 * Build the sync engine.
 *
 * The returned object is the whole public surface; the wiring layer republishes it under the
 * frozen global name, so every member name here is a contract with existing callers.
 */
function createSync(ports           ) {
  const storage = ports.storage;
  const timers = ports.timers;
  const now = ()         => ports.now();

  const SYNC_ENABLED_KEY = "cfw_sync_enabled_v1";
  const LAST_PUSH_KEY = "cfw_sync_last_push_v1";
  const LAST_PULL_KEY = "cfw_sync_last_pull_v1";
  const INCLUDE_CHAT_KEY = "cfw_sync_include_chat_v1";
  const PAUSE_KEY = "cfw_sync_paused_v1";
  const PUSH_COUNT_KEY = "cfw_sync_push_count_v1";
  const PUSH_COUNT_DAY_KEY = "cfw_sync_push_count_day_v1";
  /** Cloudflare KV free tier allows 1000 writes/day; warn once at 800. */
  const PUSH_DAILY_WARN = 800;
  const EXCLUDE_KEY = "cfw_sync_exclude_v1";
  /** Legacy character-card store name: this channel reads IndexedDB, never the SQL `chars` table. */
  const CHARS_DB = "tavern_chars_v2";
  const LAST_EXCLUDE_PUSH_KEY = "cfw_sync_last_exclude_push_v1";
  const LAST_EXCLUDE_PULL_KEY = "cfw_sync_last_exclude_pull_v1";
  const CHAT_SLOT_META_KEY = "cfw_chat_slot_meta_v1";
  const CHAT_TOMB_KEY = "cfw_chat_tomb_v1";
  const CHAT_CONV_META_KEY = "cfw_conv_meta_v1";
  const CHAT_SYNCED_KEY = "cfw_chat_synced_v1";
  const CHAT_CONFLICTS_KEY = "cfw_chat_conflicts_v1";
  const LAST_CHAT_PUSH_KEY = "cfw_sync_last_chat_push_v1";
  const LAST_CHAT_PULL_KEY = "cfw_sync_last_chat_pull_v1";
  const CHAT_DEVICE_ID_KEY = "cfw_device_id_v1";
  const CHAT_EVENTS_SEQ_KEY = "cfw_chat_events_seq_v1";
  const CHAT_EVENTS_QUEUE_KEY = "cfw_chat_events_queue_v1";
  const CHAT_REALTIME_KEY = "cfw_chat_realtime_v1";
  const CHARS_SYNCED_KEY = "cfw_chars_synced_v1";
  /** Local-only bookkeeping keys; writing them re-marks a channel dirty instead of the main blob. */
  const CHAT_DIRTY_KEYS = ["cfw_chat_session_v1", "cfw_chat_slot_meta_v1", "cfw_chat_tomb_v1", "cfw_conv_meta_v1"];
  const CHARS_META_KEY = "cfw_chars_meta_v1";
  const CHARS_TOMB_KEY = "cfw_chars_tomb_v1";
  const LAST_CHARS_PUSH_KEY = "cfw_sync_last_chars_push_v1";
  const LAST_CHARS_PULL_KEY = "cfw_sync_last_chars_pull_v1";
  const CHARS_DIRTY_KEYS = ["cfw_chars_meta_v1", "cfw_chars_tomb_v1"];

  const MAIN_BLOB_PATH = "/sync";
  const COST_PATH = "/sync/cost";
  const EXCLUDE_PATH = "/sync/exclude";
  const CHAT_PATH = "/sync/chat";
  const CHARS_PATH = "/sync/chars";
  const CHAT_EVENTS_PATH = "/sync/chat/events";

  /**
   * Exact keys carried by the main blob. This list is the whole allow-list: {@link collectLS}
   * takes "listed here" plus "matching a prefix", with no fallback sweep, so a key added nowhere is
   * never synced and nothing reports it.
   */
  const LS_EXPLICIT           = [
    "cfw_thinking",
    "cfw_prior_summary_by_conv_v1", "cfw_summary_enabled", "cfw_summary_trigger", "cfw_summary_keep",
    "tavern_active_scene_v1", "tavern_aff_pending_v1",
    "cfw_prompt_presets_v1", "cfw_skills_v1", "cfw_skills_enabled_v1", "tavern_multi_agent_mode_v1",
    "tavern_lorebook_v1",
    "cfw_mode", "cfw_model", "cfw_use_builtin", "cfw_history_enabled",
    "cfw_prompt_enabled", "cfw_custom_prompt_v1",
    "cfw_byo_provider_public_v1", "cfw_custom_pricing_v1",
    "cfw_providers_public_v3",
    // Channel registries are account-scoped since 2026-11-13: one account, one set of keys. They
    // ride the strongly authenticated main blob, so a key only ever lands in the user's own KV.
    "cfw_providers_v3",
    // Image channels follow the same rule. A channel pointing at a local ComfyUI simply fails to
    // connect on other devices; it does not affect the rest of the list.
    "cfw_image_channels_v1",
    "cfw_char_caps_v1",
    "cfw_ma_delegate_v1", "cfw_ma_meeting_v1", "cfw_ma_invite_v1",
    "cfw_ma_meeting_max_v1", "cfw_ma_meeting_rounds_v1", "cfw_ma_ctx_msgs_v1",
  ];

  /** Prefix families (multi-instance keys), matched after the exact list. */
  const LS_PREFIXES           = ["tavern_aff_triggered_", "cfw_summary_"];

  /**
   * Keys that must never ride the blob. Only the prefix loop and the restore guard consult this at
   * runtime, but the list is also the written record of intent: adding a device-local key here is
   * how you say "this belongs to one machine" before someone adds it to the allow-list above.
   */
  const PROTECTED           = [
    "cfw_auth_token_v1",
    // Appearance is per-device. Listing it here also protects it during restore: older blobs still
    // carry these keys, and removing them from the allow-list alone would not stop a restore from
    // overwriting a hand-picked theme.
    "cfw_theme_v1", "cfw_theme_accent_v1", "cfw_ui_overrides_v1",
    "cfw_chat_protect_v1",
    "cfw_byo_provider_v1",
    "cfw_byo_providers_v2",
    "cfw_app_fx_rich_v1",
    "cfw_mem_idle_release_v1",
    SYNC_ENABLED_KEY, LAST_PUSH_KEY, LAST_PULL_KEY,
    INCLUDE_CHAT_KEY, PAUSE_KEY, PUSH_COUNT_KEY, PUSH_COUNT_DAY_KEY,
    "cfw_cost_log_v1",
    "cfw_sync_last_cost_push_v1",
    "cfw_sync_last_cost_pull_v1",
    // The device id is the metering bucket. Sharing one across devices under-counts every total.
    "cfw_device_id_v1",
    EXCLUDE_KEY,
    LAST_EXCLUDE_PUSH_KEY, LAST_EXCLUDE_PULL_KEY,
    "cfw_dev_mode_v1", "cfw_dev_hud_v1", "cfw_dev_notes_v1", "cfw_dev_overrides_v1",
    "cfw_dev_debug_v1", "cfw_dev_force_comply_v1", "cfw_dev_stream_probe_v1", "cfw_dev_io_record_v1",
    LAST_CHAT_PUSH_KEY, LAST_CHAT_PULL_KEY,
    "cfw_ui_assets_v1",
    "cfw_chat_session_v1",
    "cfw_chat_slot_meta_v1",
    "cfw_chat_tomb_v1",
    "cfw_conv_meta_v1",
    "cfw_chat_synced_v1",
    "cfw_chat_conflicts_v1",
    "cfw_conv_active_v1",
    CHARS_META_KEY, CHARS_TOMB_KEY,
    LAST_CHARS_PUSH_KEY, LAST_CHARS_PULL_KEY,
    CHAT_EVENTS_SEQ_KEY, CHAT_EVENTS_QUEUE_KEY, "cfw_chat_events_pending_v1", CHAT_REALTIME_KEY, CHARS_SYNCED_KEY,
  ];

  /**
   * Databases carried by the main blob. Empty on purpose: cards moved to their own channel and the
   * props database no longer exists. The loops below stay because that is where a future database
   * gets added.
   */
  const IDB_NAMES           = [];

  const listeners = new Set              ();

  let applyingRemoteChat = false;
  let applyingRemoteChars = false;
  let remoteApplyDepth = 0;

  let pushTimer          = null;
  let pushing = false;
  let pendingPush = false;
  let costPushTimer          = null;
  let costPushing = false;
  let pendingCostPush = false;
  let excludePushing = false;
  let pendingExcludePush = false;
  let chatPushTimer          = null;
  let chatPushing = false;
  let pendingChatPush = false;
  let charsPushTimer          = null;
  let charsPushing = false;
  let pendingCharsPush = false;

  // ── storage primitives ──

  function lsGet(key        )                {
    return storage.getItem(key);
  }

  function lsSet(key        , value        )       {
    storage.setItem(key, value);
  }

  function lsRemove(key        )       {
    storage.removeItem(key);
  }

  /**
   * Write the whole conversation map. Preferred path is the session store, which updates its
   * in-memory mirror and rewrites only the hot windows (T3-D); the direct blob write is the
   * legacy fallback. A throwing facade must not abort a merge that already happened in memory, so
   * the fallback is taken on any exception.
   */
  function writeChatSessions(sessions      , source        )       {
    try {
      const facade = typeof ports.sessions === "function" ? ports.sessions() : null;
      if (facade && typeof facade.applyRemote === "function") {
        facade.applyRemote(recOf(sessions), { source: source });
        return;
      }
    } catch (e) {
      /* fall through to the legacy write */
    }
    lsSet("cfw_chat_session_v1", JSON.stringify(sessions));
  }

  function lsInt(key        )         {
    const raw = storage.getItem(key);
    return raw ? parseInt(raw, 10) || 0 : 0;
  }

  function hashStr(input         )         {
    const s = input == null ? "" : String(input);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ("0000000" + h.toString(16)).slice(-8);
  }

  function readJSONArr(key        )            {
    try {
      const value = JSON.parse(storage.getItem(key) || "");
      return Array.isArray(value) ? value : [];
    } catch (e) {
      return [];
    }
  }

  function readJSONObj(key        , fallback      )       {
    try {
      const value = JSON.parse(storage.getItem(key) || "");
      return isRec(value) ? recOf(value) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  // ── auth ──

  function token()         {
    return ports.token();
  }

  function authHeaders(extra                         )                         {
    const headers                         = {};
    if (extra) {
      const keys = Object.keys(extra);
      for (let i = 0; i < keys.length; i++) headers[keys[i]] = extra[keys[i]];
    }
    const t = token();
    if (t) headers.Authorization = "Bearer " + t;
    return headers;
  }

  function syncEnabled()          {
    return storage.getItem(SYNC_ENABLED_KEY) === "1";
  }

  function setSyncEnabled(on         )       {
    storage.setItem(SYNC_ENABLED_KEY, on ? "1" : "0");
  }

  function includeChat()          {
    return storage.getItem(INCLUDE_CHAT_KEY) !== "0";
  }

  function setIncludeChat(on         )       {
    storage.setItem(INCLUDE_CHAT_KEY, on ? "1" : "0");
  }

  function isPaused()          {
    return storage.getItem(PAUSE_KEY) === "1";
  }

  function pause()       {
    storage.setItem(PAUSE_KEY, "1");
    emit("paused");
  }

  function resume()       {
    storage.removeItem(PAUSE_KEY);
    emit("resumed");
  }

  // ── status bus ──

  function onStatus(fn              )             {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }

  function emit(status        , detail          )       {
    listeners.forEach((fn) => {
      try {
        fn(status, detail);
      } catch (e) {
        /* a UI listener must not break the sync loop */
      }
    });
  }

  // ── main blob: localStorage ──

  function collectLS()       {
    const out       = {};
    const seen = new Set        ();
    for (let i = 0; i < LS_EXPLICIT.length; i++) {
      const k = LS_EXPLICIT[i];
      const v = storage.getItem(k);
      if (v !== null) {
        out[k] = v;
        seen.add(k);
      }
    }
    const total = storage.length;
    for (let i = 0; i < total; i++) {
      const k = storage.key(i);
      if (!k || seen.has(k) || PROTECTED.indexOf(k) >= 0) continue;
      let matched = false;
      for (let j = 0; j < LS_PREFIXES.length; j++) {
        if (k.indexOf(LS_PREFIXES[j]) === 0) matched = true;
      }
      if (matched) out[k] = storage.getItem(k);
    }
    return out;
  }

  function restoreLS(ls      )       {
    // The loop below overwrites whole keys, so the two channel registries have to be saved first
    // and merged by id afterwards. Without this a device holding an empty registry (a fresh phone)
    // wipes the other device's channels, keys included — it happened.
    let localProviders                = null;
    let localImageChannels                = null;
    try {
      localProviders = storage.getItem("cfw_providers_v3");
      localImageChannels = storage.getItem("cfw_image_channels_v1");
    } catch (e) {
      /* storage unavailable: nothing to preserve */
    }
    const toRemove           = [];
    const total = storage.length;
    for (let i = 0; i < total; i++) {
      const k = storage.key(i);
      if (!k || PROTECTED.indexOf(k) >= 0) continue;
      let matched = LS_EXPLICIT.indexOf(k) >= 0;
      if (!matched) {
        for (let j = 0; j < LS_PREFIXES.length; j++) {
          if (k.indexOf(LS_PREFIXES[j]) === 0) matched = true;
        }
      }
      if (matched) toRemove.push(k);
    }
    for (let i = 0; i < toRemove.length; i++) storage.removeItem(toRemove[i]);
    const incoming = keysOf(ls);
    for (let i = 0; i < incoming.length; i++) {
      const k = incoming[i];
      if (PROTECTED.indexOf(k) >= 0) continue;
      if (k === "tavern_active_props_v1") continue;
      const v = ls[k];
      if (typeof v === "string") storage.setItem(k, v);
    }

    const merge = ports.providerMerge();
    const parse = (raw               )          => {
      try {
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        return null;
      }
    };
    try {
      const cloudProviders = ls["cfw_providers_v3"];
      if (cloudProviders != null) {
        if (merge) {
          const merged = merge.mergeProviders(parse(localProviders), parse(strOf(cloudProviders)));
          if (isRec(merged)) storage.setItem("cfw_providers_v3", JSON.stringify(merged));
        }
      } else if (localProviders) {
        // The cloud copy predates the key: keep ours rather than dropping the registry.
        storage.setItem("cfw_providers_v3", localProviders);
      }
      const registry = ports.providers();
      if (registry && typeof registry.republish === "function") registry.republish();
      const cloudImage = ls["cfw_image_channels_v1"];
      if (cloudImage != null) {
        if (merge) {
          const mergedImage = merge.mergeImageChannels(parse(localImageChannels), parse(strOf(cloudImage)));
          if (Array.isArray(mergedImage)) storage.setItem("cfw_image_channels_v1", JSON.stringify(mergedImage));
        }
      } else if (localImageChannels) {
        storage.setItem("cfw_image_channels_v1", localImageChannels);
      }
    } catch (e) {
      /* merge is best-effort: a broken cloud registry must not abort the restore */
    }

    // setItem does not fire the storage event in the same tab, and the registries just changed
    // underneath the UI — repaint explicitly.
    try {
      const registry = ports.providers();
      if (registry && typeof registry.mergePublic === "function") registry.mergePublic();
    } catch (e) {
      /* UI refresh is optional */
    }
  }

  // ── exclusion registry ──

  function normKind(kind        )         {
    return kind === "session" ? "session" : "role";
  }

  function entryId(kind        , key        )         {
    return normKind(kind) + ":" + key;
  }

  function getRegistry()       {
    const parsed = readJSONObj(EXCLUDE_KEY, {});
    const entries = parsed["entries"];
    if (isRec(entries)) return { entries: recOf(entries) };
    // Legacy flat shape { roles, sessions } migrates to per-entry records stamped ts=1, so any new
    // operation wins the LWW comparison immediately.
    const migrated       = {};
    const roles = arrOf(parsed["roles"]);
    for (let i = 0; i < roles.length; i++) {
      const k = roles[i];
      if (typeof k === "string" && k) migrated[entryId("role", k)] = { kind: "role", key: k, state: "excluded", ts: 1 };
    }
    const sessions = arrOf(parsed["sessions"]);
    for (let i = 0; i < sessions.length; i++) {
      const k = sessions[i];
      if (typeof k === "string" && k) migrated[entryId("session", k)] = { kind: "session", key: k, state: "excluded", ts: 1 };
    }
    return { entries: migrated };
  }

  function setRegistry(reg      )       {
    storage.setItem(EXCLUDE_KEY, JSON.stringify({ entries: isRec(reg["entries"]) ? recOf(reg["entries"]) : {} }));
  }

  function registryEntries(reg      )       {
    const entries = reg["entries"];
    return isRec(entries) ? recOf(entries) : {};
  }

  /** Downstream callers still consume the flat { roles, sessions } view; only excluded counts. */
  function getExcluded()                                          {
    const entries = registryEntries(getRegistry());
    const roles           = [];
    const sessions           = [];
    const ids = keysOf(entries);
    for (let i = 0; i < ids.length; i++) {
      const entry = recOf(entries[ids[i]]);
      if (strOf(entry["state"]) !== "excluded") continue;
      const key = entry["key"];
      if (typeof key !== "string" || !key) continue;
      if (entry["kind"] === "session") sessions.push(key);
      else roles.push(key);
    }
    return { roles: roles, sessions: sessions };
  }

  function addExclusion(kind        , key        )       {
    if (!key) return;
    const reg = getRegistry();
    const entries = registryEntries(reg);
    entries[entryId(kind, key)] = { kind: normKind(kind), key: key, state: "excluded", ts: now() };
    setRegistry({ entries: entries });
  }

  function removeExclusion(kind        , key        )       {
    if (!key) return;
    const reg = getRegistry();
    const entries = registryEntries(reg);
    // The entry is kept and flipped to "restored" with a fresh timestamp: only that lets a restore
    // override an older exclusion made on another device.
    entries[entryId(kind, key)] = { kind: normKind(kind), key: key, state: "restored", ts: now() };
    setRegistry({ entries: entries });
  }

  function mergeRegistries(a      , b      )       {
    const ea = registryEntries(a);
    const eb = registryEntries(b);
    const out       = {};
    const ids = new Set        ();
    keysOf(ea).forEach((k) => ids.add(k));
    keysOf(eb).forEach((k) => ids.add(k));
    ids.forEach((id) => {
      const x = ea[id];
      const y = eb[id];
      const xOk = isRec(x) && typeof recOf(x)["ts"] === "number";
      const yOk = isRec(y) && typeof recOf(y)["ts"] === "number";
      if (xOk && yOk) out[id] = numOf(recOf(y)["ts"]) >= numOf(recOf(x)["ts"]) ? y : x;
      else out[id] = xOk ? x : y;
    });
    return { entries: out };
  }

  // ── main blob: dump / restore ──

  async function dumpAll(opts                             )                {
    const ls = collectLS();
    const idb       = {};
    for (let i = 0; i < IDB_NAMES.length; i++) idb[IDB_NAMES[i]] = await ports.idb.dump(IDB_NAMES[i]);
    // Cards stay out of the blob by default; a local backup must not lose them, hence the opt-in.
    if (opts && opts.includeChars) idb[CHARS_DB] = await ports.idb.dump(CHARS_DB);
    return applyExclusionsToBlob({ version: 1, savedAt: now(), localStorage: ls, indexedDB: idb });
  }

  async function restoreAll(blob         , opts                           )                   {
    if (!isRec(blob)) return false;
    const data = recOf(blob);
    // Cards and chat left the blob when their channels landed. An older cloud blob still carries
    // them, so restoring must skip both: otherwise the stale whole-blob copy overwrites the merged
    // per-id result.
    const allowChars = !!(opts && opts.allowChars);
    const ex = getExcluded();
    let keepRoles             = [];
    const keepSlots       = {};
    const keepAffLS       = {};
    if (ex.roles.length) {
      try {
        keepRoles = await ports.idb.readByIds(CHARS_DB, ex.roles);
      } catch (e) {
        /* nothing to preserve */
      }
      for (let i = 0; i < ex.roles.length; i++) {
        const k = "tavern_aff_triggered_" + ex.roles[i];
        const v = storage.getItem(k);
        if (v !== null) keepAffLS[k] = v;
      }
    }
    const slotKeys = Array.from(new Set        (ex.sessions.concat(ex.roles)));
    if (slotKeys.length) {
      try {
        const sessions = readJSONObj("cfw_chat_session_v1", {});
        for (let i = 0; i < slotKeys.length; i++) {
          const k = slotKeys[i];
          if (Object.prototype.hasOwnProperty.call(sessions, k)) keepSlots[k] = sessions[k];
        }
      } catch (e) {
        /* nothing to preserve */
      }
    }
    const ls = data["localStorage"];
    if (isRec(ls)) restoreLS(recOf(ls));
    const idb = data["indexedDB"];
    if (isRec(idb)) {
      const cloudIdb = recOf(idb);
      const names = keysOf(cloudIdb);
      for (let i = 0; i < names.length; i++) {
        const n = names[i];
        if (n === CHARS_DB && !allowChars) continue;
        // The props database was deleted from the product. Old blobs still contain it, and
        // restoring would recreate it — deleted data coming back to life.
        if (n === "tavern_props_v1") continue;
        await ports.idb.restore(n, recOf(cloudIdb[n]));
      }
    }
    if (keepRoles.length) {
      try {
        await ports.idb.putItems(CHARS_DB, keepRoles);
      } catch (e) {
        /* best-effort: an excluded card that cannot be re-put is still excluded from the cloud */
      }
    }
    const keptSlotKeys = keysOf(keepSlots);
    if (keptSlotKeys.length) {
      try {
        const sessions = readJSONObj("cfw_chat_session_v1", {});
        for (let i = 0; i < keptSlotKeys.length; i++) sessions[keptSlotKeys[i]] = keepSlots[keptSlotKeys[i]];
        storage.setItem("cfw_chat_session_v1", JSON.stringify(sessions));
      } catch (e) {
        /* best-effort */
      }
    }
    const affKeys = keysOf(keepAffLS);
    for (let i = 0; i < affKeys.length; i++) {
      try {
        storage.setItem(affKeys[i], strOf(keepAffLS[affKeys[i]]));
      } catch (e) {
        /* best-effort */
      }
    }
    return true;
  }

  /**
   * Strip excluded entities from an outbound blob. Exclusion means "clear the cloud, keep this
   * device", so the filter runs on the push side only; the local copy is untouched.
   */
  function applyExclusionsToBlob(blob      )       {
    const ex = getExcluded();
    if (!ex.roles.length && !ex.sessions.length) return blob;
    // recOf returns a copy, so every mutation below is written back onto the blob. Mutating the
    // copy and dropping it silently uploads the excluded entity — the filter is the only thing
    // standing between "clear the cloud" and "nothing happened".
    const idbRaw = blob["indexedDB"];
    if (ex.roles.length && isRec(idbRaw)) {
      const idbOut = recOf(idbRaw);
      const dbObj = recOf(idbOut[CHARS_DB]);
      const stores = keysOf(dbObj);
      for (let i = 0; i < stores.length; i++) {
        const sn = stores[i];
        const items = arrOf(dbObj[sn]);
        // The chars store is keyed by id, the affections store by cardId; both belong to the role,
        // so both are cleared from the cloud.
        dbObj[sn] = items.filter((it) => {
          const rec = recOf(it);
          return !(ex.roles.indexOf(strOf(rec["id"])) >= 0 || ex.roles.indexOf(strOf(rec["cardId"])) >= 0);
        });
      }
      idbOut[CHARS_DB] = dbObj;
      blob["indexedDB"] = idbOut;
    }
    const lsRaw = blob["localStorage"];
    if (isRec(lsRaw)) {
      const lsOut = recOf(lsRaw);
      for (let i = 0; i < ex.roles.length; i++) delete lsOut["tavern_aff_triggered_" + ex.roles[i]];
      const slotKeys = Array.from(new Set        (ex.sessions.concat(ex.roles)));
      const raw = lsOut["cfw_chat_session_v1"];
      if (slotKeys.length && typeof raw === "string") {
        try {
          const sessions = recOf(JSON.parse(raw));
          let changed = false;
          for (let i = 0; i < slotKeys.length; i++) {
            if (Object.prototype.hasOwnProperty.call(sessions, slotKeys[i])) {
              delete sessions[slotKeys[i]];
              changed = true;
            }
          }
          if (changed) lsOut["cfw_chat_session_v1"] = JSON.stringify(sessions);
        } catch (e) {
          /* a malformed local value is left as-is */
        }
      }
      blob["localStorage"] = lsOut;
    }
    return blob;
  }

  // ── HTTP ──

  async function requestJson(path        , init           )                   {
    if (!token()) throw new Error("未启用云同步（缺 token）");
    const res = await ports.http(path, init);
    if (res.status === 401) throw new Error("密码错误");
    if (!res.ok) throw new Error("请求失败: " + res.status);
    return res.json();
  }

  async function getChannel(path        , label        )                       {
    if (!token()) throw new Error("未启用云同步(缺 token)");
    const res = await ports.http(path, { headers: authHeaders() });
    if (res.status === 401) throw new Error("密码错误");
    if (!res.ok) throw new Error("拉取" + label + "失败: " + res.status);
    const text = await res.text();
    if (!text || text === "null") return null;
    try {
      const parsed = JSON.parse(text);
      return isRec(parsed) ? recOf(parsed) : null;
    } catch (e) {
      return null;
    }
  }

  async function putChannel(path        , body         , label        )                {
    if (!token()) throw new Error("未启用云同步(缺 token)");
    const res = await ports.http(path, {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (res.status === 401) throw new Error("密码错误");
    if (!res.ok) throw new Error("推送" + label + "失败: " + res.status);
    return recOf(await res.json());
  }

  async function deleteChannel(path        , label        )                {
    if (!token()) throw new Error("未启用云同步(缺 token)");
    const res = await ports.http(path, { method: "DELETE", headers: authHeaders() });
    if (res.status === 401) throw new Error("密码错误");
    if (!res.ok) throw new Error("删除" + label + "失败: " + res.status);
    try {
      return recOf(await res.json());
    } catch (e) {
      return {};
    }
  }

  function pullFromKV()                       {
    return getChannel(MAIN_BLOB_PATH, "");
  }

  function pushToKV(blob      )                {
    return putChannel(MAIN_BLOB_PATH, blob, "");
  }

  // ── push counter (KV quota watch) ──

  function incrPushCount()         {
    const today = new Date(now()).toISOString().slice(0, 10);
    const prevDay = storage.getItem(PUSH_COUNT_DAY_KEY);
    let n = parseInt(storage.getItem(PUSH_COUNT_KEY) || "0", 10) || 0;
    if (prevDay !== today) {
      n = 0;
      storage.setItem(PUSH_COUNT_DAY_KEY, today);
    }
    n += 1;
    storage.setItem(PUSH_COUNT_KEY, String(n));
    if (n === PUSH_DAILY_WARN) emit("warn", { reason: "kv-quota", today: today, count: n });
    return n;
  }

  // ── main blob: debounced push ──

  async function doPush()                {
    if (pushing) {
      pendingPush = true;
      return;
    }
    pushing = true;
    emit("syncing");
    try {
      const blob = await dumpAll();
      const res = await pushToKV(blob);
      const savedAt = numOf(res["savedAt"]) || now();
      storage.setItem(LAST_PUSH_KEY, String(savedAt));
      // Advance the pull stamp too, or the next startup drags back what was just pushed.
      storage.setItem(LAST_PULL_KEY, String(savedAt));
      const pushN = incrPushCount();
      emit("synced", Object.assign({}, res, { pushCount: pushN }));
    } catch (e) {
      emit("error", e);
    } finally {
      pushing = false;
      if (pendingPush) {
        pendingPush = false;
        timers.set(() => {
          doPush();
        }, 1500);
      }
    }
  }

  function markDirty()       {
    if (!syncEnabled() || !token()) return;
    if (isPaused()) return;
    if (pushTimer) timers.clear(pushTimer);
    // 30s, not 3s: the whole blob is one KV write and the free tier allows 1000/day.
    pushTimer = timers.set(() => {
      pushTimer = null;
      doPush();
    }, 30000);
  }

  async function pushNow()                {
    if (pushTimer) {
      timers.clear(pushTimer);
      pushTimer = null;
    }
    await doPush();
  }

  // ── cost channel (/sync/cost) ──

  function getLocalCostLog()       {
    try {
      const raw = storage.getItem("cfw_cost_log_v1");
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return isRec(parsed) ? recOf(parsed) : {};
    } catch (e) {
      return {};
    }
  }

  function setLocalCostLog(log      )       {
    try {
      storage.setItem("cfw_cost_log_v1", JSON.stringify(log));
    } catch (e) {
      /* quota: the next message re-marks the channel dirty */
    }
  }

  /**
   * Normalise one day. Days used to be flat `{cost, requests, prompt, completion}`; they are now
   * bucketed per device, and the flat shape is treated as the "legacy" bucket so old logs still
   * merge instead of being dropped.
   */
  function normCostDay(entry         )       {
    if (!isRec(entry)) return {};
    const rec = recOf(entry);
    if (
      typeof rec["cost"] === "number" ||
      typeof rec["requests"] === "number" ||
      typeof rec["prompt"] === "number" ||
      typeof rec["completion"] === "number"
    ) {
      return { legacy: entry };
    }
    return rec;
  }

  function mergeCostModels(a      , b      )       {
    const out       = {};
    const names = new Set        ();
    keysOf(a).forEach((n) => names.add(n));
    keysOf(b).forEach((n) => names.add(n));
    names.forEach((name) => {
      const x = recOf(a[name]);
      const y = recOf(b[name]);
      out[name] = {
        cost: Math.max(numOf(x["cost"]), numOf(y["cost"])),
        prompt: Math.max(numOf(x["prompt"]), numOf(y["prompt"])),
        completion: Math.max(numOf(x["completion"]), numOf(y["completion"])),
        requests: Math.max(numOf(x["requests"]), numOf(y["requests"])),
        estimated: Math.max(numOf(x["estimated"]), numOf(y["estimated"])),
      };
    });
    return out;
  }

  /**
   * Merge by day × device, taking the max of every counter. Max rather than sum is what makes the
   * operation idempotent: a device that pushes the same day twice must not double its own usage,
   * while two devices contributing different buckets still add up.
   */
  function mergeCostLogs(a      , b      )       {
    const out       = {};
    const days = new Set        ();
    keysOf(a).forEach((d) => days.add(d));
    keysOf(b).forEach((d) => days.add(d));
    days.forEach((day) => {
      const da = normCostDay(a[day]);
      const db = normCostDay(b[day]);
      const devs = new Set        ();
      keysOf(da).forEach((d) => devs.add(d));
      keysOf(db).forEach((d) => devs.add(d));
      const merged       = {};
      devs.forEach((dev) => {
        const ea = recOf(da[dev]);
        const eb = recOf(db[dev]);
        merged[dev] = {
          cost: Math.max(numOf(ea["cost"]), numOf(eb["cost"])),
          prompt: Math.max(numOf(ea["prompt"]), numOf(eb["prompt"])),
          completion: Math.max(numOf(ea["completion"]), numOf(eb["completion"])),
          requests: Math.max(numOf(ea["requests"]), numOf(eb["requests"])),
          estimated: Math.max(numOf(ea["estimated"]), numOf(eb["estimated"])),
          models: mergeCostModels(recOf(ea["models"]), recOf(eb["models"])),
        };
      });
      out[day] = merged;
    });
    return out;
  }

  function pullCostFromKV()                       {
    return getChannel(COST_PATH, "费用");
  }

  function pushCostToKV(log      )                {
    return putChannel(COST_PATH, log, "费用");
  }

  function refreshCostUi()       {
    const ui = ports.costUi();
    if (!ui) return;
    try {
      if (typeof ui.refreshTopbar === "function") ui.refreshTopbar();
      if (typeof ui.refreshSettings === "function") ui.refreshSettings();
    } catch (e) {
      /* UI refresh is optional */
    }
  }

  /** Cost syncs whenever a token exists: money is not a per-device preference. */
  async function pullCostOnStartup()                {
    if (!token()) return;
    try {
      const remote = await pullCostFromKV();
      if (!remote) return;
      const merged = mergeCostLogs(getLocalCostLog(), remote);
      setLocalCostLog(merged);
      storage.setItem("cfw_sync_last_cost_pull_v1", String(now()));
      refreshCostUi();
      emit("cost-synced", { source: "pull" });
    } catch (e) {
      emit("cost-error", e);
    }
  }

  async function doCostPush()                {
    if (costPushing) {
      pendingCostPush = true;
      return;
    }
    costPushing = true;
    try {
      const local = getLocalCostLog();
      const res = await pushCostToKV(local);
      storage.setItem("cfw_sync_last_cost_push_v1", String(numOf(res["savedAt"]) || now()));
      // The worker answers with the merged whole log, including buckets pushed by other devices
      // moments earlier; landing it here is what makes the local view converge without a pull.
      const mergedRemote = res["merged"];
      if (isRec(mergedRemote)) {
        setLocalCostLog(mergeCostLogs(local, recOf(mergedRemote)));
        refreshCostUi();
      }
      incrPushCount();
      emit("cost-synced", Object.assign({}, res, { source: "push" }));
    } catch (e) {
      emit("cost-error", e);
    } finally {
      costPushing = false;
      if (pendingCostPush) {
        pendingCostPush = false;
        timers.set(() => {
          doCostPush();
        }, 1500);
      }
    }
  }

  function markCostDirty()       {
    if (!token()) return;
    if (isPaused()) return;
    if (costPushTimer) timers.clear(costPushTimer);
    // 10s, half the main blob's window: a cost row is small and the user expects the number to
    // settle quickly, but each push still costs a KV write.
    costPushTimer = timers.set(() => {
      costPushTimer = null;
      doCostPush();
    }, 10000);
  }

  async function pushCostNow()                {
    if (costPushTimer) {
      timers.clear(costPushTimer);
      costPushTimer = null;
    }
    await doCostPush();
  }

  // ── exclusion channel (/sync/exclude) ──

  function pullExcludeFromKV()                       {
    return getChannel(EXCLUDE_PATH, "排除清单");
  }

  function pushExcludeToKV(reg      )                {
    return putChannel(EXCLUDE_PATH, reg, "排除清单");
  }

  async function pullExcludeOnStartup()                {
    if (!syncEnabled() || !token()) return;
    try {
      const remote = await pullExcludeFromKV();
      if (!remote) return;
      setRegistry(mergeRegistries(getRegistry(), remote));
      storage.setItem(LAST_EXCLUDE_PULL_KEY, String(now()));
      emit("exclude-synced", { source: "pull" });
    } catch (e) {
      emit("exclude-error", e);
    }
  }

  async function doExcludePush()                {
    if (excludePushing) {
      pendingExcludePush = true;
      return;
    }
    excludePushing = true;
    try {
      const local = getRegistry();
      const res = await pushExcludeToKV(local);
      const merged = res["merged"];
      if (isRec(merged)) setRegistry(mergeRegistries(local, recOf(merged)));
      storage.setItem(LAST_EXCLUDE_PUSH_KEY, String(numOf(res["savedAt"]) || now()));
      incrPushCount();
      emit("exclude-synced", { source: "push" });
    } catch (e) {
      emit("exclude-error", e);
    } finally {
      excludePushing = false;
      if (pendingExcludePush) {
        pendingExcludePush = false;
        timers.set(() => {
          doExcludePush();
        }, 1500);
      }
    }
  }

  async function pushExcludeNow()                {
    await doExcludePush();
  }

  // ── chat channel (/sync/chat) ──

  /**
   * Per-slot merge with a three-way baseline. Each slot carries updatedAt + deviceId, and
   * `cfw_chat_synced_v1` holds the hash each slot had at the last successful sync:
   *  - local hash still equals the base → the remote moved → fast-forward to remote;
   *  - remote hash equals the base → the local moved → keep local;
   *  - neither matches → a real conflict, handed to the panel for the user to judge.
   * Deletion is a tombstone, resolved by deletedAt against updatedAt, so an edit after a delete
   * resurrects the conversation.
   */
  function chatDeviceId()         {
    let id = storage.getItem(CHAT_DEVICE_ID_KEY);
    if (!id) {
      id = "dev_" + now().toString(36) + ports.random().toString(36).slice(2, 8);
      try {
        storage.setItem(CHAT_DEVICE_ID_KEY, id);
      } catch (e) {
        /* a per-call id is still usable; it just loses the stable bucket */
      }
    }
    return id;
  }

  function getChatSessions()       {
    return readJSONObj("cfw_chat_session_v1", {});
  }

  function getChatSlotMeta()       {
    return readJSONObj(CHAT_SLOT_META_KEY, {});
  }

  function getChatTomb()       {
    return readJSONObj(CHAT_TOMB_KEY, {});
  }

  function getChatSynced()       {
    return readJSONObj(CHAT_SYNCED_KEY, {});
  }

  function getConvMetaMap()       {
    return readJSONObj(CHAT_CONV_META_KEY, {});
  }

  function getChatConflicts()         {
    return readJSONArr(CHAT_CONFLICTS_KEY).map((entry) => recOf(entry));
  }

  /**
   * Run `fn` with writes suppressed from re-marking the chat channel dirty. Nested calls are
   * counted: the realtime module may apply an event inside a merge the sync engine started.
   */
  async function withRemoteApply   (fn                      )             {
    remoteApplyDepth++;
    applyingRemoteChat = true;
    try {
      return await fn();
    } finally {
      remoteApplyDepth = Math.max(0, remoteApplyDepth - 1);
      if (remoteApplyDepth === 0) applyingRemoteChat = false;
    }
  }

  function isExcludedSession(convId        )          {
    try {
      const ex = getExcluded();
      return ex.sessions.indexOf(convId) >= 0 || ex.roles.indexOf(convId) >= 0;
    } catch (e) {
      return false;
    }
  }

  /**
   * Record a conflict the realtime channel stumbled on. Same storage shape as the merge path, so
   * the panel needs only one reader; an existing entry for the slot is replaced, not appended.
   */
  function setChatConflict(slotKey        , localMsgs           , remoteMsgs           , remoteUpdatedAt         )       {
    const localArr = Array.isArray(localMsgs) ? localMsgs : [];
    const remoteArr = Array.isArray(remoteMsgs) ? remoteMsgs : [];
    const conflict       = {
      slotKey: slotKey,
      localMsgs: localArr,
      remoteMsgs: remoteArr,
      localUpdatedAt: now(),
      remoteUpdatedAt: numOf(remoteUpdatedAt) || now(),
      localCount: localArr.length,
      remoteCount: remoteArr.length,
    };
    const merged = getChatConflicts();
    const index = merged.findIndex((p) => strOf(p["slotKey"]) === slotKey);
    if (index >= 0) merged[index] = conflict;
    else merged.push(conflict);
    storage.setItem(CHAT_CONFLICTS_KEY, JSON.stringify(merged));
    emit("chat-conflict", { conflicts: [conflict] });
    ports.dispatch("chat-conflict", { conflicts: [conflict] });
    return conflict;
  }

  function buildLocalChatBlob()       {
    const sessions = getChatSessions();
    const slotMeta = getChatSlotMeta();
    const tomb = getChatTomb();
    const convMeta = getConvMetaMap();
    const ex = getExcluded();
    const excluded = new Set        (ex.sessions.concat(ex.roles));
    const slots       = {};
    const msgs       = {};
    const stamp = now();
    const ids = keysOf(sessions);
    for (let i = 0; i < ids.length; i++) {
      const k = ids[i];
      if (excluded.has(k)) continue;
      const arr = sessions[k];
      // An empty slot is not a delete signal, and uploading it would wipe a non-empty conversation
      // on the other device. Deletion travels as a tombstone only.
      if (!Array.isArray(arr) || arr.length === 0) continue;
      const meta = recOf(slotMeta[k]);
      const updatedAt = typeof meta["updatedAt"] === "number" ? numOf(meta["updatedAt"]) : stamp;
      slots[k] = { updatedAt: updatedAt, deviceId: strOf(meta["deviceId"]) || chatDeviceId(), hash: hashStr(JSON.stringify(arr)) };
      msgs[k] = arr;
    }
    return { slots: slots, msgs: msgs, tombstones: tomb, convMeta: convMeta };
  }

  function slotMetaOf(meta      , updatedAt        )       {
    return {
      updatedAt: typeof updatedAt === "number" && updatedAt >= 0 ? updatedAt : now(),
      deviceId: strOf(meta["deviceId"]) || chatDeviceId(),
    };
  }

  function mergeChatSessions(remote         )             {
    const localSessions = getChatSessions();
    const localMeta = getChatSlotMeta();
    const localTomb = getChatTomb();
    const localConv = getConvMetaMap();
    const synced = getChatSynced();
    const r = recOf(remote);
    const rSlots = recOf(r["slots"]);
    const rMsgs = recOf(r["msgs"]);
    const rTomb = recOf(r["tombstones"]);
    const rConv = recOf(r["convMeta"]);

    const outTomb       = {};
    const tombKeys = new Set        ();
    keysOf(localTomb).forEach((k) => tombKeys.add(k));
    keysOf(rTomb).forEach((k) => tombKeys.add(k));
    tombKeys.forEach((k) => {
      const la = numOf(recOf(localTomb[k])["deletedAt"]) || -1;
      const ra = numOf(recOf(rTomb[k])["deletedAt"]) || -1;
      outTomb[k] = ra >= la ? rTomb[k] : localTomb[k];
    });

    const outSessions       = {};
    const outMeta       = {};
    const conflicts                 = [];
    // An excluded slot neither merges nor uploads: "clear the cloud, keep this device" depends on
    // both halves.
    const excluded = new Set        (getExcluded().sessions);
    const slotKeys = new Set        ();
    keysOf(localSessions).forEach((k) => slotKeys.add(k));
    keysOf(rSlots).forEach((k) => slotKeys.add(k));

    slotKeys.forEach((k) => {
      if (excluded.has(k)) return;
      const localArr = Array.isArray(localSessions[k]) ? arrOf(localSessions[k]) : null;
      const remoteArr = Array.isArray(rMsgs[k]) ? arrOf(rMsgs[k]) : null;
      const lMeta = recOf(localMeta[k]);
      const rMeta = recOf(rSlots[k]);
      const lUpd = typeof lMeta["updatedAt"] === "number" ? numOf(lMeta["updatedAt"]) : localArr ? 0 : -1;
      const rUpd = typeof rMeta["updatedAt"] === "number" ? numOf(rMeta["updatedAt"]) : remoteArr ? 0 : -1;
      const baseRaw = recOf(synced[k])["hash"];
      const base = typeof baseRaw === "string" ? baseRaw : null;
      const lHash = localArr ? hashStr(JSON.stringify(localArr)) : null;
      const rHash = remoteArr ? hashStr(JSON.stringify(remoteArr)) : strOf(rMeta["hash"]) || null;

      const tomb = outTomb[k];
      if (isRec(tomb)) {
        const deletedAt = numOf(recOf(tomb)["deletedAt"]);
        if (typeof recOf(tomb)["deletedAt"] === "number" && deletedAt >= lUpd && deletedAt >= rUpd) return;
        if (lUpd > deletedAt || rUpd > deletedAt) delete outTomb[k];
      }

      // An empty array is not a delete signal: whichever side still has messages wins. Only a
      // tombstone removes a conversation.
      const lEmpty = localArr !== null && localArr.length === 0;
      const rEmpty = remoteArr !== null && remoteArr.length === 0;
      if (lEmpty && remoteArr && !rEmpty) {
        outSessions[k] = remoteArr;
        outMeta[k] = { updatedAt: rUpd >= 0 ? rUpd : now(), deviceId: strOf(rMeta["deviceId"]) };
        return;
      }
      if (rEmpty && localArr && !lEmpty) {
        outSessions[k] = localArr;
        outMeta[k] = slotMetaOf(lMeta, lUpd);
        return;
      }
      if (localArr && !remoteArr) {
        outSessions[k] = localArr;
        outMeta[k] = slotMetaOf(lMeta, lUpd);
        return;
      }
      if (!localArr && remoteArr) {
        outSessions[k] = remoteArr;
        outMeta[k] = { updatedAt: rUpd >= 0 ? rUpd : now(), deviceId: strOf(rMeta["deviceId"]) };
        return;
      }
      if (!localArr || !remoteArr) return;

      if (lHash === rHash) {
        outSessions[k] = localArr;
        outMeta[k] = lUpd >= rUpd ? slotMetaOf(lMeta, lUpd) : { updatedAt: rUpd, deviceId: strOf(rMeta["deviceId"]) };
        return;
      }
      if (base && lHash === base) {
        // updatedAt comes from each device's own clock, and the server's LWW trusts it. A local
        // slot untouched since the last sync may fast-forward only when the remote meta is
        // genuinely newer: otherwise a device with a skewed clock can park stale content in the
        // cloud and have it silently poured back here, losing messages.
        if (rUpd > lUpd) {
          outSessions[k] = remoteArr;
          outMeta[k] = { updatedAt: rUpd >= 0 ? rUpd : now(), deviceId: strOf(rMeta["deviceId"]) };
          return;
        }
        outSessions[k] = localArr;
        outMeta[k] = slotMetaOf(lMeta, lUpd);
        return;
      }
      if (base && rHash === base) {
        outSessions[k] = localArr;
        outMeta[k] = slotMetaOf(lMeta, lUpd);
        return;
      }
      conflicts.push({
        slotKey: k,
        localMsgs: localArr,
        remoteMsgs: remoteArr,
        localUpdatedAt: lUpd,
        remoteUpdatedAt: rUpd,
        localCount: localArr.length,
        remoteCount: remoteArr.length,
      });
      outSessions[k] = localArr;
      outMeta[k] = slotMetaOf(lMeta, lUpd);
    });

    const outConv       = {};
    const convBases = new Set        ();
    keysOf(rConv).forEach((b) => convBases.add(b));
    keysOf(localConv).forEach((b) => convBases.add(b));
    convBases.forEach((b) => {
      outConv[b] = Object.assign({}, recOf(rConv[b]), recOf(localConv[b]));
    });
    return { sessions: outSessions, slotMeta: outMeta, tomb: outTomb, convMeta: outConv, conflicts: conflicts };
  }

  /** Order-independent fingerprint of the whole slot set; detects "did the merge change anything". */
  function chatSessionsSig(sessions      )         {
    const keys = keysOf(sessions).sort();
    return keys.map((k) => k + ":" + hashStr(JSON.stringify(sessions[k]))).join("|");
  }

  function applyMergedChatToLocal(m            )       {
    const prevSynced = getChatSynced();
    const prevSig = chatSessionsSig(getChatSessions());
    applyingRemoteChat = true;
    try {
      writeChatSessions(m.sessions, "sync-merge");
      storage.setItem(CHAT_SLOT_META_KEY, JSON.stringify(m.slotMeta));
      storage.setItem(CHAT_TOMB_KEY, JSON.stringify(m.tomb));
      // Conversation names merge as a union on the server and cannot be deleted there, so a
      // removed conversation leaves a ghost row ("no messages yet") in the sidebar. Dropping any
      // name whose conversation is gone removes exactly the ghosts; local empty slots keep theirs.
      const convMeta = recOf(m.convMeta);
      keysOf(convMeta).forEach((k) => {
        if (!(k in m.sessions)) delete convMeta[k];
      });
      // Every device names its own main conversation c_main_<deviceId>, so a merged foreign one
      // shows up as a second, unexplained row. Renaming it is display-only and reversible.
      const myId = chatDeviceId();
      keysOf(convMeta).forEach((k) => {
        if (k.indexOf("c_main_") !== 0 || k === "c_main_" + myId) return;
        const meta = recOf(convMeta[k]);
        if (!strOf(meta["name"]) || strOf(meta["name"]) === "主对话") meta["name"] = "主对话 · 其他设备";
        convMeta[k] = meta;
      });
      storage.setItem(CHAT_CONV_META_KEY, JSON.stringify(convMeta));
      const conflictKeys = new Set        ();
      (m.conflicts || []).forEach((c) => conflictKeys.add(c.slotKey));
      const synced       = {};
      keysOf(m.sessions).forEach((k) => {
        // A conflicted slot keeps its stale base on purpose: refreshing it would make the next push
        // recreate the same conflict, and the panel would pop again every cycle.
        if (conflictKeys.has(k)) {
          if (prevSynced[k]) synced[k] = prevSynced[k];
          return;
        }
        synced[k] = { hash: hashStr(JSON.stringify(m.sessions[k])), syncedAt: now() };
      });
      storage.setItem(CHAT_SYNCED_KEY, JSON.stringify(synced));
      if (m.conflicts && m.conflicts.length) {
        // Conflicts are merged per slot: replacing the whole list dropped unresolved conflicts of
        // other conversations.
        const merged = getChatConflicts();
        let hasNew = false;
        m.conflicts.forEach((c) => {
          const index = merged.findIndex((p) => strOf(p["slotKey"]) === c.slotKey);
          if (index >= 0) merged[index] = Object.assign({}, c);
          else {
            merged.push(Object.assign({}, c));
            hasNew = true;
          }
        });
        storage.setItem(CHAT_CONFLICTS_KEY, JSON.stringify(merged));
        if (hasNew) {
          emit("chat-conflict", { conflicts: m.conflicts });
          return;
        }
        // Every conflict was already known: the user has seen the panel, so do not pop it again.
      } else {
        storage.removeItem(CHAT_CONFLICTS_KEY);
      }
    } finally {
      applyingRemoteChat = false;
    }
    if (m.conflicts && m.conflicts.length) {
      emit("chat-conflict", { conflicts: m.conflicts });
      return;
    }
    // A merge that added or updated another device's conversation used to be invisible until the
    // next reload; the change event is what lets the UI offer a refresh.
    if (chatSessionsSig(m.sessions) !== prevSig) emit("chat-merged", { changed: true });
  }

  function pullChatFromKV()                       {
    return getChannel(CHAT_PATH, "聊天");
  }

  function pushChatToKV(blob      )                {
    return putChannel(CHAT_PATH, blob, "聊天");
  }

  async function doChatPush()                      {
    // Returns a result instead of undefined: the "sync now" button has to tell "pushed" from
    // "pushed nothing", and a silent return once reported a no-op as success.
    if (!includeChat()) return { skipped: "chat-off" };
    if (!syncEnabled() || !token()) return { skipped: "sync-off" };
    if (chatPushing) {
      pendingChatPush = true;
      return { skipped: "inflight" };
    }
    chatPushing = true;
    try {
      const blob = buildLocalChatBlob();
      // Remember each slot's hash at push time: if the local content changed while the request was
      // in flight, the response must not be landed. Landing it would make the snapshot we sent a
      // second ago look like a foreign edit, produce a fake conflict, and lose whatever the user
      // typed meanwhile once they pick "keep cloud".
      const slots = recOf(blob["slots"]);
      const pushedHashes                         = {};
      keysOf(slots).forEach((k) => {
        pushedHashes[k] = strOf(recOf(slots[k])["hash"]);
      });
      const res = await pushChatToKV(blob);
      storage.setItem(LAST_CHAT_PUSH_KEY, String(numOf(res["savedAt"]) || now()));
      let diverged = false;
      try {
        const current = getChatSessions();
        const pushedKeys = Object.keys(pushedHashes);
        for (let i = 0; i < pushedKeys.length; i++) {
          const arr = current[pushedKeys[i]];
          const h = Array.isArray(arr) ? hashStr(JSON.stringify(arr)) : null;
          if (h !== pushedHashes[pushedKeys[i]]) {
            diverged = true;
            break;
          }
        }
        if (!diverged) {
          const currentKeys = keysOf(current);
          for (let i = 0; i < currentKeys.length; i++) {
            const k = currentKeys[i];
            if (!(k in pushedHashes) && Array.isArray(current[k]) && arrOf(current[k]).length) {
              diverged = true;
              break;
            }
          }
        }
      } catch (e) {
        /* a failed divergence probe is treated as "not diverged", same as before */
      }
      // The merged payload in the response is deliberately not landed: conversations are pulled
      // only when the user asks. Only the baseline advances, and only when local did not move.
      if (res["merged"] && diverged) {
        // Diverged: leave the baseline alone; the next debounced push carries the newer snapshot
        // and converges.
      } else {
        applyingRemoteChat = true;
        try {
          const synced = getChatSynced();
          const msgKeys = keysOf(recOf(blob["msgs"]));
          for (let i = 0; i < msgKeys.length; i++) {
            const k = msgKeys[i];
            synced[k] = { hash: strOf(recOf(slots[k])["hash"]), syncedAt: now() };
          }
          storage.setItem(CHAT_SYNCED_KEY, JSON.stringify(synced));
        } finally {
          applyingRemoteChat = false;
        }
      }
      incrPushCount();
      emit("chat-synced", { source: "push" });
      return { ok: true, slots: keysOf(slots).length, savedAt: numOf(res["savedAt"]) || null };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      emit("chat-error", e);
      return { error: message };
    } finally {
      chatPushing = false;
      if (pendingChatPush) {
        pendingChatPush = false;
        timers.set(() => {
          doChatPush();
        }, 1500);
      }
    }
  }

  function markChatDirty()       {
    if (!syncEnabled() || !token() || !includeChat()) return;
    if (isPaused() || applyingRemoteChat) return;
    if (chatPushTimer) timers.clear(chatPushTimer);
    chatPushTimer = timers.set(() => {
      chatPushTimer = null;
      doChatPush();
    }, 30000);
  }

  async function pushChatNow()                      {
    if (chatPushTimer) {
      timers.clear(chatPushTimer);
      chatPushTimer = null;
    }
    return await doChatPush();
  }

  /** Pull one round without pushing; callable at any time, unlike the startup variant. */
  async function pullChatNow(opts                     )                      {
    if (!includeChat()) return { skipped: "chat-off" };
    if (!syncEnabled() || !token()) return { skipped: "sync-off" };
    // The realtime channel is the cheap path; the full 3-way snapshot is for resets and explicit
    // full pulls. Falling back matters: if events are unavailable the caller must still get data,
    // not a fake success.
    if (!(opts && opts.full === true)) {
      try {
        const realtime = ports.realtime();
        if (realtime && typeof realtime.catchUp === "function" && realtime.isRunning()) {
          const result = await realtime.catchUp({ force: true });
          if (realtime.isRunning()) return recOf(result);
        }
      } catch (e) {
        /* fall through to the snapshot path */
      }
    }
    try {
      const remote = await pullChatFromKV();
      if (!remote) return { ok: true, empty: true };
      applyMergedChatToLocal(mergeChatSessions(remote));
      storage.setItem(LAST_CHAT_PULL_KEY, String(now()));
      emit("chat-synced", { source: "pull" });
      return { ok: true, pulled: true };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      emit("chat-error", e);
      return { error: message };
    }
  }

  async function pullChatOnStartup()                {
    if (!syncEnabled() || !token() || !includeChat()) return;
    try {
      const remote = await pullChatFromKV();
      if (!remote) {
        try {
          await pushChatNow();
        } catch (e) {
          /* nothing to seed */
        }
        return;
      }
      applyMergedChatToLocal(mergeChatSessions(remote));
      storage.setItem(LAST_CHAT_PULL_KEY, String(now()));
      emit("chat-synced", { source: "pull" });
      try {
        await pushChatNow();
      } catch (e) {
        /* the push is opportunistic: the merge already landed */
      }
    } catch (e) {
      emit("chat-error", e);
    }
  }

  /** resolution = "local" | "remote" | "fork"; returns false when the slot has no open conflict. */
  function resolveChatConflict(slotKey        , resolution        )          {
    const conflicts = getChatConflicts();
    const conflict = conflicts.find((x) => strOf(x["slotKey"]) === slotKey);
    if (!conflict) return false;
    applyingRemoteChat = true;
    try {
      const sessions = getChatSessions();
      const meta = getChatSlotMeta();
      const stamp = now();
      const remoteMsgs = arrOf(conflict["remoteMsgs"]);
      const localMsgs = arrOf(conflict["localMsgs"]);
      if (resolution === "remote") {
        sessions[slotKey] = remoteMsgs;
        meta[slotKey] = { updatedAt: stamp, deviceId: chatDeviceId() };
      } else if (resolution === "fork") {
        // Slot keys are flat conversation ids with no prefix, and a fork must be a legal one too:
        // anything not starting with c_ is invisible to the sidebar.
        const forkKey = "c_" + stamp.toString(36) + "_" + ports.random().toString(36).slice(2, 6);
        sessions[slotKey] = localMsgs;
        sessions[forkKey] = remoteMsgs;
        meta[slotKey] = { updatedAt: stamp, deviceId: chatDeviceId() };
        meta[forkKey] = { updatedAt: stamp, deviceId: chatDeviceId() };
        const convMeta = getConvMetaMap();
        convMeta[forkKey] = {
          name: "云端版本 " + new Date(stamp).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }),
          createdAt: stamp,
        };
        storage.setItem(CHAT_CONV_META_KEY, JSON.stringify(convMeta));
      } else {
        sessions[slotKey] = localMsgs;
        meta[slotKey] = { updatedAt: stamp, deviceId: chatDeviceId() };
      }
      // Direct write on purpose: this map came from the hot-window read above, so replacing the
      // whole mirror with it would drop the archived prefix. The facade path is for maps that are
      // already complete (the merge snapshot).
      storage.setItem("cfw_chat_session_v1", JSON.stringify(sessions));
      storage.setItem(CHAT_SLOT_META_KEY, JSON.stringify(meta));
      const synced = getChatSynced();
      synced[slotKey] = { hash: hashStr(JSON.stringify(sessions[slotKey])), syncedAt: stamp };
      storage.setItem(CHAT_SYNCED_KEY, JSON.stringify(synced));
      const rest = conflicts.filter((x) => strOf(x["slotKey"]) !== slotKey);
      if (rest.length) storage.setItem(CHAT_CONFLICTS_KEY, JSON.stringify(rest));
      else storage.removeItem(CHAT_CONFLICTS_KEY);
    } finally {
      applyingRemoteChat = false;
    }
    const push = pushChatNow();
    if (push && typeof push.then === "function") push.catch(() => {});
    emit("chat-conflict-resolved", { slotKey: slotKey, resolution: resolution });
    return true;
  }

  // ── character channel (/sync/chars) ──
  //
  // Decision 2026-11-28 (unified storage): the character cards moved to the D1 `chars` table, so a
  // client that reads and writes through the data plane no longer needs this channel — D1 *is* the
  // sync. The endpoint stays live anyway: clients shipped before the move only know the
  // IndexedDB-plus-KV-blob path, and their cards must keep travelling until they upgrade. Nothing
  // here is fed by the new path (the character wiring no longer marks the channel dirty), so the
  // blob only ever holds what those legacy clients put there. Retire the whole channel — endpoint,
  // the two settings buttons and the main blob's `indexedDB.tavern_chars_v2` exclusion — once no
  // pre-2026-11-28 client is expected to sync; half-retiring it would strand those cards silently.

  /** Calls arrive from the legacy character store only; the SQL path does not use them. */
  function getCharsMeta()       {
    return readJSONObj(CHARS_META_KEY, {});
  }

  function getCharsTomb()       {
    return readJSONObj(CHARS_TOMB_KEY, {});
  }

  function getCharsSynced()       {
    return readJSONObj(CHARS_SYNCED_KEY, {});
  }

  /** Called by the character store after every save; the write itself marks the channel dirty. */
  function bumpCharMeta(id        )       {
    if (!id) return;
    const meta = getCharsMeta();
    meta[id] = { updatedAt: now(), deviceId: chatDeviceId() };
    const tomb = getCharsTomb();
    if (tomb[id]) {
      delete tomb[id];
      storage.setItem(CHARS_TOMB_KEY, JSON.stringify(tomb));
    }
    storage.setItem(CHARS_META_KEY, JSON.stringify(meta));
  }

  function tombChar(id        )       {
    if (!id) return;
    const tomb = getCharsTomb();
    tomb[id] = { deletedAt: now(), deviceId: chatDeviceId() };
    const meta = getCharsMeta();
    if (meta[id]) {
      delete meta[id];
      storage.setItem(CHARS_META_KEY, JSON.stringify(meta));
    }
    storage.setItem(CHARS_TOMB_KEY, JSON.stringify(tomb));
  }

  async function readLocalChars()                                                       {
    const dumped = await ports.idb.dump(CHARS_DB);
    const data = recOf(dumped);
    return { chars: arrOf(data["chars"]), affections: arrOf(data["affections"]) };
  }

  async function buildLocalCharsBlob()                {
    const local = await readLocalChars();
    const meta = getCharsMeta();
    const tomb = getCharsTomb();
    const excluded = new Set        (getExcluded().roles);
    const stamp = now();
    const cards       = {};
    const outMeta       = {};
    const affections       = {};
    for (let i = 0; i < local.chars.length; i++) {
      const card = recOf(local.chars[i]);
      const id = strOf(card["id"]);
      if (!id || excluded.has(id)) continue;
      const m = recOf(meta[id]);
      cards[id] = local.chars[i];
      outMeta[id] = {
        updatedAt: typeof m["updatedAt"] === "number" ? numOf(m["updatedAt"]) : stamp,
        deviceId: strOf(m["deviceId"]) || chatDeviceId(),
        hash: hashStr(JSON.stringify(card)),
      };
    }
    for (let i = 0; i < local.affections.length; i++) {
      const aff = recOf(local.affections[i]);
      const cardId = strOf(aff["cardId"]);
      if (!cardId || excluded.has(cardId)) continue;
      affections[cardId] = {
        value: aff["value"],
        updatedAt: typeof aff["updatedAt"] === "number" ? numOf(aff["updatedAt"]) : stamp,
      };
    }
    return { cards: cards, meta: outMeta, affections: affections, tombstones: tomb };
  }

  async function mergeChars(remote         )                       {
    const local = await readLocalChars();
    const merge = ports.charMerge();
    if (!merge || typeof merge.mergeCharsState !== "function") throw new Error("角色卡合并模块未加载");
    const merged = recOf(
      merge.mergeCharsState({
        localCards: local.chars,
        localAffections: local.affections,
        localMeta: getCharsMeta(),
        localTomb: getCharsTomb(),
        remote: remote,
        synced: getCharsSynced(),
        excluded: new Set        (getExcluded().roles),
        deviceId: chatDeviceId(),
        hashFn: hashStr,
        now: now(),
      })
    );
    return {
      cards: recOf(merged["cards"]),
      meta: recOf(merged["meta"]),
      affections: recOf(merged["affections"]),
      tomb: recOf(merged["tomb"]),
      synced: recOf(merged["synced"]),
      conflicts: arrOf(merged["conflicts"]),
    };
  }

  async function applyMergedCharsToLocal(m             )                {
    applyingRemoteChars = true;
    try {
      const cardIds = keysOf(m.cards);
      const cards            = [];
      for (let i = 0; i < cardIds.length; i++) cards.push(m.cards[cardIds[i]]);
      const affIds = keysOf(m.affections);
      const affections            = [];
      for (let i = 0; i < affIds.length; i++) {
        const aff = recOf(m.affections[affIds[i]]);
        affections.push({ cardId: affIds[i], value: aff["value"], updatedAt: aff["updatedAt"] });
      }
      // Both stores are replaced wholesale, which is what keeps deletions propagated: a card absent
      // from the merged set must disappear locally too.
      await ports.idb.restore(CHARS_DB, { chars: cards, affections: affections });
      storage.setItem(CHARS_META_KEY, JSON.stringify(m.meta));
      storage.setItem(CHARS_TOMB_KEY, JSON.stringify(m.tomb));
      storage.setItem(CHARS_SYNCED_KEY, JSON.stringify(m.synced));
    } finally {
      applyingRemoteChars = false;
    }
    try {
      const store = ports.character();
      if (store && typeof store.reload === "function") await store.reload();
    } catch (e) {
      /* the panel refreshes on its own next open */
    }
    if (m.conflicts.length) {
      emit("chars-conflict", { conflicts: m.conflicts });
      ports.dispatch("chars-conflict", { conflicts: m.conflicts });
    }
  }

  function pullCharsFromKV()                       {
    return getChannel(CHARS_PATH, "角色卡");
  }

  function pushCharsToKV(blob      )                {
    return putChannel(CHARS_PATH, blob, "角色卡");
  }

  async function doCharsPush()                {
    if (charsPushing) {
      pendingCharsPush = true;
      return;
    }
    charsPushing = true;
    try {
      const blob = await buildLocalCharsBlob();
      const res = await pushCharsToKV(blob);
      storage.setItem(LAST_CHARS_PUSH_KEY, String(numOf(res["savedAt"]) || now()));
      const mergedRemote = res["merged"];
      if (isRec(mergedRemote)) {
        const merged = await mergeChars(mergedRemote);
        await applyMergedCharsToLocal(merged);
        // A conflict copy was just written locally; pushing again publishes it as a normal card
        // instead of leaving the user with data only this device can see.
        if (merged.conflicts.length) {
          timers.set(() => {
            const next = pushCharsNow();
            if (next && typeof next.then === "function") next.catch(() => {});
          }, 1200);
        }
      }
      incrPushCount();
      emit("chars-synced", { source: "push" });
    } catch (e) {
      emit("chars-error", e);
    } finally {
      charsPushing = false;
      if (pendingCharsPush) {
        pendingCharsPush = false;
        timers.set(() => {
          doCharsPush();
        }, 1500);
      }
    }
  }

  function markCharsDirty()       {
    if (!syncEnabled() || !token()) return;
    if (isPaused() || applyingRemoteChars) return;
    if (charsPushTimer) timers.clear(charsPushTimer);
    charsPushTimer = timers.set(() => {
      charsPushTimer = null;
      doCharsPush();
    }, 30000);
  }

  async function pushCharsNow()                {
    if (charsPushTimer) {
      timers.clear(charsPushTimer);
      charsPushTimer = null;
    }
    await doCharsPush();
  }

  async function pullCharsOnStartup()                {
    if (!syncEnabled() || !token()) return;
    try {
      const remote = await pullCharsFromKV();
      if (!remote) {
        try {
          await pushCharsNow();
        } catch (e) {
          /* nothing to seed */
        }
        return;
      }
      const merged = await mergeChars(remote);
      await applyMergedCharsToLocal(merged);
      storage.setItem(LAST_CHARS_PULL_KEY, String(now()));
      emit("chars-synced", { source: "pull" });
      if (merged.conflicts.length) {
        timers.set(() => {
          const next = pushCharsNow();
          if (next && typeof next.then === "function") next.catch(() => {});
        }, 1200);
      } else {
        try {
          await pushCharsNow();
        } catch (e) {
          /* the merge already landed */
        }
      }
    } catch (e) {
      emit("chars-error", e);
    }
  }

  // ── cloud deletion ──

  function deleteMainFromKV()                {
    return deleteChannel(MAIN_BLOB_PATH, "");
  }

  function deleteCostFromKV()                {
    return deleteChannel(COST_PATH, "费用");
  }

  function deleteChatFromKV()                {
    return deleteChannel(CHAT_PATH, "聊天");
  }

  function deleteCharsFromKV()                {
    return deleteChannel(CHARS_PATH, "角色卡");
  }

  function deleteChatEventsFromKV()                {
    return deleteChannel(CHAT_EVENTS_PATH, "实时事件");
  }

  function deleteExcludeFromKV()                {
    return deleteChannel(EXCLUDE_PATH, "排除清单");
  }

  /**
   * Clear every cloud key, then immediately re-push this device's data ("overwrite the cloud").
   * Clearing without the re-push is pointless: the next local edit would push everything back
   * anyway, so the button would have done nothing.
   */
  async function wipeCloud()                {
    if (!syncEnabled() || !token()) throw new Error("未启用云同步");
    // Cancel pending pushes first, or a timer fires right after the wipe and restores the cloud.
    if (pushTimer) {
      timers.clear(pushTimer);
      pushTimer = null;
    }
    if (costPushTimer) {
      timers.clear(costPushTimer);
      costPushTimer = null;
    }
    if (chatPushTimer) {
      timers.clear(chatPushTimer);
      chatPushTimer = null;
    }
    if (charsPushTimer) {
      timers.clear(charsPushTimer);
      charsPushTimer = null;
    }
    emit("syncing");
    const main = await deleteMainFromKV();
    // Each channel is a separate KV key; one failure must not block the rest.
    let cost              = null;
    let chat              = null;
    let chars              = null;
    let exclude              = null;
    let events              = null;
    try {
      cost = await deleteCostFromKV();
    } catch (e) {
      /* reported as null */
    }
    try {
      chat = await deleteChatFromKV();
    } catch (e) {
      /* reported as null */
    }
    try {
      chars = await deleteCharsFromKV();
    } catch (e) {
      /* reported as null */
    }
    try {
      exclude = await deleteExcludeFromKV();
    } catch (e) {
      /* reported as null */
    }
    try {
      events = await deleteChatEventsFromKV();
    } catch (e) {
      /* reported as null */
    }
    storage.removeItem(LAST_PUSH_KEY);
    storage.removeItem(LAST_PULL_KEY);
    storage.removeItem("cfw_sync_last_cost_push_v1");
    storage.removeItem("cfw_sync_last_cost_pull_v1");
    storage.removeItem(LAST_CHAT_PUSH_KEY);
    storage.removeItem(LAST_CHAT_PULL_KEY);
    storage.removeItem(LAST_CHARS_PUSH_KEY);
    storage.removeItem(LAST_CHARS_PULL_KEY);
    storage.removeItem(LAST_EXCLUDE_PUSH_KEY);
    storage.removeItem(LAST_EXCLUDE_PULL_KEY);
    storage.removeItem(CHAT_EVENTS_SEQ_KEY);
    storage.removeItem(CHAT_EVENTS_QUEUE_KEY);
    const pushed = { main: false, cost: false, chat: false, chars: false };
    try {
      await pushNow();
      pushed.main = true;
    } catch (e) {
      /* left false */
    }
    try {
      await pushCostNow();
      pushed.cost = true;
    } catch (e) {
      /* left false */
    }
    try {
      await pushChatNow();
      pushed.chat = true;
    } catch (e) {
      /* left false */
    }
    try {
      await pushCharsNow();
      pushed.chars = true;
    } catch (e) {
      /* left false */
    }
    emit("wiped", { main: main, cost: cost, chat: chat, chars: chars, exclude: exclude, events: events, overwritten: true });
    return { main: main, cost: cost, chat: chat, chars: chars, exclude: exclude, events: events, pushed: pushed };
  }

  /**
   * "Clear the cloud for this one entity, keep it here": register the exclusion, push the registry
   * (so other devices honour it), then push the owning channel with the entity filtered out.
   * Pushing only the main blob used to leave the entity untouched in the per-id channels until the
   * next merge brought it back.
   */
  async function wipeCloudEntity(kind        , key        )                {
    if (!syncEnabled() || !token()) throw new Error("未启用云同步");
    addExclusion(kind, key);
    await pushExcludeNow();
    await pushNow();
    if (kind === "session") await pushChatNow();
    else await pushCharsNow();
    emit("entity-wiped", { kind: kind, key: key });
    return { kind: kind, key: key };
  }

  async function restoreCloudEntity(kind        , key        )                {
    if (!syncEnabled() || !token()) throw new Error("未启用云同步");
    removeExclusion(kind, key);
    await pushExcludeNow();
    await pushNow();
    if (kind === "session") await pushChatNow();
    else await pushCharsNow();
    emit("entity-restored", { kind: kind, key: key });
    return { kind: kind, key: key };
  }

  // ── startup ──

  async function pullOnStartup()                {
    if (!syncEnabled() || !token()) return;
    emit("syncing");
    try {
      const remote = await pullFromKV();
      if (!remote) {
        // Empty cloud means first enablement: seed it from this device rather than starting blank.
        emit("synced", { firstPush: true });
        await pushNow();
        return;
      }
      const lastPull = parseInt(storage.getItem(LAST_PULL_KEY) || "0", 10) || 0;
      const remoteAt = numOf(remote["savedAt"]);
      if (remoteAt > lastPull) {
        await restoreAll(remote);
        storage.setItem(LAST_PULL_KEY, String(remoteAt));
        emit("restored", { savedAt: remoteAt });
        // A reload is the only reliable way to make the app re-read state it already loaded.
        timers.set(() => {
          ports.reloadPage();
        }, 600);
      } else {
        emit("synced");
      }
    } catch (e) {
      emit("error", e);
    }
  }

  // ── local file backup ──

  async function exportJSON()                {
    const blob = await dumpAll({ includeChars: true });
    const text = JSON.stringify(blob, null, 2);
    const name = "tavern-backup-" + new Date(now()).toISOString().slice(0, 10) + ".json";
    const result = await ports.saveText(text, name);
    if (!result["ok"]) ports.toast(strOf(result["error"]) || "未写盘");
    return result;
  }

  /** Resolves with the parsed blob; restores cards too, because a local import is a full backup. */
  async function importJSONText(text        )                {
    const blob = JSON.parse(text);
    await restoreAll(blob, { allowChars: true });
    return recOf(blob);
  }

  // ── status ──

  function getStatus()       {
    const lastPush = lsInt(LAST_PUSH_KEY);
    const lastPull = lsInt(LAST_PULL_KEY);
    const lastChatPush = lsInt(LAST_CHAT_PUSH_KEY);
    const lastChatPull = lsInt(LAST_CHAT_PULL_KEY);
    const lastSyncAt = Math.max(lastPush, lastPull, lastChatPush, lastChatPull);
    let realtimeStatus              = null;
    try {
      const realtime = ports.realtime();
      realtimeStatus = realtime && typeof realtime.status === "function" ? realtime.status() : null;
    } catch (e) {
      realtimeStatus = null;
    }
    const rtState = realtimeStatus ? strOf(realtimeStatus["state"]) : "";
    const state = rtState === "reconnecting" ? "syncing" : rtState === "error" ? "error" : "synced";
    return {
      enabled: syncEnabled(),
      hasToken: !!token(),
      paused: isPaused(),
      includeChat: includeChat(),
      lastPush: lastPush,
      lastPull: lastPull,
      lastPushAt: lastChatPush || lastPush || 0,
      lastSyncAt: lastSyncAt,
      lastAt: lastSyncAt,
      state: state,
      busy: false,
      error: realtimeStatus ? strOf(realtimeStatus["error"]) : "",
      realtime: realtimeStatus,
      pushCount: lsInt(PUSH_COUNT_KEY),
      pushCountDay: storage.getItem(PUSH_COUNT_DAY_KEY) || "",
    };
  }

  // ── startup composition ──

  /**
   * Startup order matters: the exclusion registry merges first so the main pull already knows what
   * to protect. Cost runs outside the sync switch — money syncs for any signed-in user — and pushes
   * right after its pull so other devices see this machine's buckets.
   */
  async function bootstrap()                {
    if (!token()) return;
    if (syncEnabled()) {
      await pullExcludeOnStartup();
      pullOnStartup();
      pullCharsOnStartup();
    }
    pullCostOnStartup().then(() => {
      const next = pushCostNow();
      if (next && typeof next.then === "function") next.catch(() => {});
    });
  }

  /** Desktop shell exit hook: flush every channel before the process goes away. */
  function flushAll()       {
    const pushes = [pushNow(), pushChatNow(), pushCharsNow()];
    for (let i = 0; i < pushes.length; i++) {
      const p = pushes[i];
      if (p && typeof p.then === "function") p.catch(() => {});
    }
  }

  // ── dirty classification (called by the storage monkey-patch) ──

  function isListedKey(key        )          {
    if (PROTECTED.indexOf(key) >= 0) return false;
    if (LS_EXPLICIT.indexOf(key) >= 0) return true;
    for (let i = 0; i < LS_PREFIXES.length; i++) {
      if (key.indexOf(LS_PREFIXES[i]) === 0) return true;
    }
    return false;
  }

  /**
   * Route one same-tab storage write to the channel that owns it. Chat and character bookkeeping
   * keys belong to their own channels; everything on the main allow-list schedules the blob; the
   * rest is ignored, so a new device-local key cannot accidentally cause writes.
   */
  function noteStorageWrite(key        )       {
    if (CHAT_DIRTY_KEYS.indexOf(key) >= 0) {
      if (!applyingRemoteChat) markChatDirty();
      return;
    }
    if (CHARS_DIRTY_KEYS.indexOf(key) >= 0) {
      if (!applyingRemoteChars) markCharsDirty();
      return;
    }
    if (isListedKey(key)) markDirty();
  }

  function noteStorageRemove(key        )       {
    noteStorageWrite(key);
  }

  /** Another tab wrote: the storage event carries no payload, so any non-protected key counts. */
  function noteStorageEvent(key               )       {
    if (!key || PROTECTED.indexOf(key) >= 0) return;
    markDirty();
  }

  function getDeviceId()         {
    return chatDeviceId();
  }

  function migrateSyncFlagsV2()       {
    try {
      if (storage.getItem("cfw_sync_flags_v2") === "1") return;
      // Both switches were removed from the UI; chat now follows the master switch. Users who once
      // turned them off are set back to "sync everything" once, which can only add pulls.
      if (storage.getItem(INCLUDE_CHAT_KEY) === "0") storage.setItem(INCLUDE_CHAT_KEY, "1");
      if (storage.getItem(CHAT_REALTIME_KEY) === "0") storage.setItem(CHAT_REALTIME_KEY, "1");
      storage.setItem("cfw_sync_flags_v2", "1");
    } catch (e) {
      /* storage unavailable: the migration simply runs again next session */
    }
  }

  migrateSyncFlagsV2();

  return {
    // main blob
    markDirty: markDirty,
    pushNow: pushNow,
    pullFromKV: pullFromKV,
    pullOnStartup: pullOnStartup,
    dumpAll: dumpAll,
    restoreAll: restoreAll,
    // cost channel
    markCostDirty: markCostDirty,
    pushCostNow: pushCostNow,
    pullCostOnStartup: pullCostOnStartup,
    // cloud deletion
    wipeCloud: wipeCloud,
    deleteMainFromKV: deleteMainFromKV,
    deleteCostFromKV: deleteCostFromKV,
    deleteChatFromKV: deleteChatFromKV,
    deleteCharsFromKV: deleteCharsFromKV,
    deleteExcludeFromKV: deleteExcludeFromKV,
    deleteChatEventsFromKV: deleteChatEventsFromKV,
    // per-entity exclusion
    wipeCloudEntity: wipeCloudEntity,
    restoreCloudEntity: restoreCloudEntity,
    getExcluded: getExcluded,
    addExclusion: addExclusion,
    removeExclusion: removeExclusion,
    // exclusion channel
    pullExcludeOnStartup: pullExcludeOnStartup,
    pushExcludeNow: pushExcludeNow,
    getRegistry: getRegistry,
    // chat channel
    markChatDirty: markChatDirty,
    pushChatNow: pushChatNow,
    pullChatOnStartup: pullChatOnStartup,
    pullChatNow: pullChatNow,
    mergeChatSessions: mergeChatSessions,
    getChatConflicts: getChatConflicts,
    resolveChatConflict: resolveChatConflict,
    withRemoteApply: withRemoteApply,
    isExcludedSession: isExcludedSession,
    setChatConflict: setChatConflict,
    getChatSlotMeta: getChatSlotMeta,
    getChatTomb: getChatTomb,
    getConvMetaMap: getConvMetaMap,
    getChatSynced: getChatSynced,
    getDeviceId: getDeviceId,
    authHeaders: authHeaders,
    hashChat: hashStr,
    // character channel
    markCharsDirty: markCharsDirty,
    pushCharsNow: pushCharsNow,
    pullCharsOnStartup: pullCharsOnStartup,
    bumpCharMeta: bumpCharMeta,
    tombChar: tombChar,
    // backup
    exportJSON: exportJSON,
    importJSONText: importJSONText,
    // switches
    syncEnabled: syncEnabled,
    setSyncEnabled: setSyncEnabled,
    includeChat: includeChat,
    setIncludeChat: setIncludeChat,
    isPaused: isPaused,
    pause: pause,
    resume: resume,
    // status
    onStatus: onStatus,
    getStatus: getStatus,
    // lifecycle
    bootstrap: bootstrap,
    flushAll: flushAll,
    noteStorageWrite: noteStorageWrite,
    noteStorageRemove: noteStorageRemove,
    noteStorageEvent: noteStorageEvent,
  };
}

// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/data/sync.ts; this file owns the
// frozen global name, the platform surface (localStorage, fetch, timers, IndexedDB, the DOM event
// bus, page reload, file save) and the seven sibling modules the engine calls back into.
//
// T4-A: the adapter is a runtime plugin injecting `transport` and `db`. Two consequences:
//  - HTTP goes through the transport port (core/ports.ts) instead of a bare `fetch`; the port
//    answers status + text, so this adapter rebuilds the `json()` shape the engine's port declares.
//  - Every timer and listener this file creates is tracked here and its inverse is returned to the
//    container, so `unmount` leaves no patch, no listener and no pending debounce behind.
//
// Two things here are not obvious and must stay here rather than in the engine:
//  - The same-tab storage monkey-patch. A storage event only crosses tabs, so a write made by this
//    tab is invisible to the engine otherwise. Every write is forwarded to the engine, which alone
//    knows which channel a key belongs to.
//  - The desktop-shell flush hook. The Rust side emits it and then waits ~1.2s before quitting;
//    the wiring is the only place that knows the event name.
(function () {
  "use strict";
  var HOST = (typeof window !== "undefined" && window.runtimeCore && window.runtimeCore.host) || null;

  // Opening a database can block on an upgrade (another tab holds an older version). The engine
  // must never wait forever, so a blocked or upgrading open resolves to null and the caller skips
  // that database this round.
  function openDB(name) {
    return new Promise(function (resolve) {
      var upgrading = false;
      var req = window.indexedDB.open(name);
      req.onsuccess = function () {
        resolve(upgrading ? null : req.result);
      };
      req.onerror = function () {
        resolve(null);
      };
      req.onupgradeneeded = function (e) {
        upgrading = true;
        try {
          e.target.transaction.abort();
        } catch (err) {
          /* already aborted */
        }
      };
      req.onblocked = function () {
        resolve(null);
      };
    });
  }

  function storeNames(db) {
    var out = [];
    var names = db.objectStoreNames;
    for (var i = 0; i < names.length; i++) out.push(names[i]);
    return out;
  }

  function apply(ctx) {
    if (window.syncSvc) return function () {};
    var transport = ctx && typeof ctx.get === "function" ? ctx.get("transport") : null;
    var timersSeen = new Set();
    var listeners = [];

    var storage = {
      get length() {
        try {
          return window.localStorage.length;
        } catch (e) {
          return 0;
        }
      },
      key: function (i) {
        try {
          return window.localStorage.key(i);
        } catch (e) {
          return null;
        }
      },
      getItem: function (k) {
        try {
          return window.localStorage.getItem(k);
        } catch (e) {
          return null;
        }
      },
      setItem: function (k, v) {
        try {
          window.localStorage.setItem(k, String(v));
        } catch (e) {
          /* quota or private mode: the next write retries */
        }
      },
      removeItem: function (k) {
        try {
          window.localStorage.removeItem(k);
        } catch (e) {
          /* nothing to recover */
        }
      },
    };

    var idb = {
      dump: function (name) {
        return openDB(name).then(function (db) {
          if (!db) return null;
          var names = storeNames(db);
          var out = {};
          var chain = Promise.resolve();
          names.forEach(function (storeName) {
            chain = chain.then(function () {
              return new Promise(function (resolve) {
                var tx = db.transaction(storeName, "readonly");
                var req = tx.objectStore(storeName).getAll();
                req.onsuccess = function () {
                  resolve(req.result || []);
                };
                req.onerror = function () {
                  resolve([]);
                };
              }).then(function (items) {
                out[storeName] = items;
              });
            });
          });
          return chain.then(function () {
            try {
              db.close();
            } catch (e) {
              /* already closed */
            }
            return out;
          });
        });
      },
      restore: function (name, data) {
        return openDB(name).then(function (db) {
          if (!db) return undefined;
          var names = storeNames(db);
          var chain = Promise.resolve();
          names.forEach(function (storeName) {
            var items = data && data[storeName];
            if (!Array.isArray(items)) return;
            chain = chain.then(function () {
              return new Promise(function (resolve) {
                var tx = db.transaction(storeName, "readwrite");
                var store = tx.objectStore(storeName);
                store.clear();
                for (var i = 0; i < items.length; i++) {
                  try {
                    store.put(items[i]);
                  } catch (e) {
                    /* one bad record must not abort the whole store */
                  }
                }
                tx.oncomplete = function () {
                  resolve();
                };
                tx.onerror = function () {
                  resolve();
                };
                tx.onabort = function () {
                  resolve();
                };
              });
            });
          });
          return chain.then(function () {
            try {
              db.close();
            } catch (e) {
              /* already closed */
            }
          });
        });
      },
      readByIds: function (name, ids) {
        if (!ids || !ids.length) return Promise.resolve([]);
        return openDB(name).then(function (db) {
          if (!db) return [];
          var names = storeNames(db);
          var out = [];
          var chain = Promise.resolve();
          names.forEach(function (storeName) {
            chain = chain.then(function () {
              return new Promise(function (resolve) {
                var tx = db.transaction(storeName, "readonly");
                var req = tx.objectStore(storeName).getAll();
                req.onsuccess = function () {
                  resolve(req.result || []);
                };
                req.onerror = function () {
                  resolve([]);
                };
              }).then(function (items) {
                for (var i = 0; i < items.length; i++) {
                  var it = items[i];
                  if (!it) continue;
                  // The cards store is keyed by id, the affections store by cardId; both are matched
                  // against the same role id.
                  if (ids.indexOf(it.id) >= 0 || ids.indexOf(it.cardId) >= 0) out.push({ store: storeName, item: it });
                }
              });
            });
          });
          return chain.then(function () {
            try {
              db.close();
            } catch (e) {
              /* already closed */
            }
            return out;
          });
        });
      },
      putItems: function (name, entries) {
        if (!entries || !entries.length) return Promise.resolve();
        return openDB(name).then(function (db) {
          if (!db) return undefined;
          var byStore = {};
          for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            if (!byStore[e.store]) byStore[e.store] = [];
            byStore[e.store].push(e.item);
          }
          var chain = Promise.resolve();
          Object.keys(byStore).forEach(function (storeName) {
            chain = chain.then(function () {
              if (!db.objectStoreNames.contains(storeName)) return undefined;
              return new Promise(function (resolve) {
                var tx = db.transaction(storeName, "readwrite");
                var store = tx.objectStore(storeName);
                for (var j = 0; j < byStore[storeName].length; j++) {
                  try {
                    store.put(byStore[storeName][j]);
                  } catch (e) {
                    /* one bad record must not abort the store */
                  }
                }
                tx.oncomplete = function () {
                  resolve();
                };
                tx.onerror = function () {
                  resolve();
                };
                tx.onabort = function () {
                  resolve();
                };
              });
            });
          });
          return chain.then(function () {
            try {
              db.close();
            } catch (e) {
              /* already closed */
            }
          });
        });
      },
    };

    // One timer port, tracked: the engine's debounces are the only thing that would outlive an
    // unmounted sync channel, and a pending push firing after teardown would write into a page that
    // no longer owns it.
    var timers = {
      set: function (fn, ms) {
        var handle = window.setTimeout(function () {
          timersSeen.delete(handle);
          try {
            fn();
          } catch (e) {
            /* the engine's callback owns its own failures */
          }
        }, ms);
        timersSeen.add(handle);
        return handle;
      },
      clear: function (handle) {
        if (handle != null) {
          timersSeen.delete(handle);
          window.clearTimeout(handle);
        }
      },
    };

    // TransportPort answers text only; the engine's HttpPort also promises json(). One read of the
    // body feeds whichever the caller asks for — the engine never asks for both.
    function transportHttp(req) {
      return transport.send(req).then(function (res) {
        var body = null;
        return {
          status: res.status,
          ok: !!res.ok,
          text: function () {
            if (body === null) body = res.text();
            return body;
          },
          json: function () {
            if (body === null) body = res.text();
            return body.then(function (text) {
              try {
                return JSON.parse(text);
              } catch (e) {
                return null;
              }
            });
          },
        };
      });
    }

    var sync = createSync({
      storage: storage,
      http: transport && typeof transport.send === "function"
        ? function (url, init) {
          var i = init || {};
          return transportHttp({ method: i.method || "GET", url: url, headers: i.headers, body: i.body });
        }
        : function (url, init) {
          return window.fetch(url, init || {});
        },
      timers: timers,
      now: function () {
        return Date.now();
      },
      random: function () {
        return Math.random();
      },
      token: function () {
        var auth = window.authSvc;
        return (auth && auth.getToken && auth.getToken()) || "";
      },
      idb: idb,
      dispatch: function (name, detail) {
        try {
          window.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
        } catch (e) {
          /* no listener, no harm */
        }
      },
      reloadPage: function () {
        try {
          window.location.reload();
        } catch (e) {
          /* nothing else to try */
        }
      },
      saveText: function (text, name) {
        var shell = window.saveFileSvc;
        // The desktop/mobile shell writes the file itself: an Android WebView ignores <a download>,
        // so the browser path silently did nothing there.
        if (shell && typeof shell.saveTextFile === "function") {
          return shell.saveTextFile(text, name).then(
            function (r) {
              return r || { ok: false };
            },
            function (e) {
              return { ok: false, error: String((e && e.message) || e) };
            }
          );
        }
        try {
          var file = new Blob([text], { type: "application/json" });
          var url = URL.createObjectURL(file);
          var a = document.createElement("a");
          a.href = url;
          a.download = name;
          a.click();
          window.setTimeout(function () {
            URL.revokeObjectURL(url);
          }, 1000);
          return Promise.resolve({ ok: true, mode: "browser", filename: name });
        } catch (e) {
          return Promise.resolve({ ok: false, error: String((e && e.message) || e) });
        }
      },
      toast: function (message) {
        try {
          var feedback = window.feedbackSvc;
          if (feedback && feedback.toast) feedback.toast(message, 2600);
        } catch (e) {
          /* feedback is a nicety */
        }
      },
      providerMerge: function () {
        return window.__providerMerge || null;
      },
      providers: function () {
        return window.providersSvc || null;
      },
      costUi: function () {
        var api = window.hostApi;
        return (api && api.cost) || null;
      },
      realtime: function () {
        return window.chatRealtimeSvc || null;
      },
      charMerge: function () {
        return window.charSyncMerge || null;
      },
      character: function () {
        return window.characterSvc || null;
      },
      // T4-A: the chat merge/pull applies its whole-map result through the session store, so the
      // in-memory full-array mirror and the hot window move together. Late-bound: the store is
      // created by the chat shell, which loads after this file.
      sessions: function () {
        return window.sessionStoreSvc || null;
      },
    });

    // Local file import needs a FileReader, which the engine deliberately cannot reach.
    function importFile(file) {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () {
          sync.importJSONText(String(reader.result)).then(resolve, reject);
        };
        reader.onerror = function () {
          reject(reader.error);
        };
        reader.readAsText(file);
      });
    }

    var api = {
      markDirty: sync.markDirty,
      pushNow: sync.pushNow,
      pullFromKV: sync.pullFromKV,
      pullOnStartup: sync.pullOnStartup,
      markCostDirty: sync.markCostDirty,
      pushCostNow: sync.pushCostNow,
      pullCostOnStartup: sync.pullCostOnStartup,
      wipeCloud: sync.wipeCloud,
      deleteMainFromKV: sync.deleteMainFromKV,
      deleteCostFromKV: sync.deleteCostFromKV,
      deleteChatFromKV: sync.deleteChatFromKV,
      deleteCharsFromKV: sync.deleteCharsFromKV,
      deleteExcludeFromKV: sync.deleteExcludeFromKV,
      deleteChatEventsFromKV: sync.deleteChatEventsFromKV,
      wipeCloudEntity: sync.wipeCloudEntity,
      restoreCloudEntity: sync.restoreCloudEntity,
      getExcluded: sync.getExcluded,
      addExclusion: sync.addExclusion,
      removeExclusion: sync.removeExclusion,
      pullExcludeOnStartup: sync.pullExcludeOnStartup,
      pushExcludeNow: sync.pushExcludeNow,
      getRegistry: sync.getRegistry,
      markChatDirty: sync.markChatDirty,
      pushChatNow: sync.pushChatNow,
      pullChatOnStartup: sync.pullChatOnStartup,
      pullChatNow: sync.pullChatNow,
      mergeChatSessions: sync.mergeChatSessions,
      getChatConflicts: sync.getChatConflicts,
      resolveChatConflict: sync.resolveChatConflict,
      withRemoteApply: sync.withRemoteApply,
      isExcludedSession: sync.isExcludedSession,
      setChatConflict: sync.setChatConflict,
      getChatSlotMeta: sync.getChatSlotMeta,
      getChatTomb: sync.getChatTomb,
      getConvMetaMap: sync.getConvMetaMap,
      getChatSynced: sync.getChatSynced,
      getDeviceId: sync.getDeviceId,
      authHeaders: sync.authHeaders,
      hashChat: sync.hashChat,
      markCharsDirty: sync.markCharsDirty,
      pushCharsNow: sync.pushCharsNow,
      pullCharsOnStartup: sync.pullCharsOnStartup,
      bumpCharMeta: sync.bumpCharMeta,
      tombChar: sync.tombChar,
      exportJSON: sync.exportJSON,
      importJSON: importFile,
      syncEnabled: sync.syncEnabled,
      setSyncEnabled: sync.setSyncEnabled,
      includeChat: sync.includeChat,
      setIncludeChat: sync.setIncludeChat,
      isPaused: sync.isPaused,
      pause: sync.pause,
      resume: sync.resume,
      dumpAll: sync.dumpAll,
      restoreAll: sync.restoreAll,
      onStatus: sync.onStatus,
      getStatus: sync.getStatus,
    };
    window.syncSvc = api;

    // Same-tab writes: the storage event only crosses tabs, so monkey-patch the two mutators. This
    // is what lets cards, presets, history and cost sync without touching any other file. The
    // originals are captured once and restored verbatim on teardown.
    var realSetItem = null;
    var realRemoveItem = null;
    try {
      realSetItem = Storage.prototype.setItem;
      realRemoveItem = Storage.prototype.removeItem;
      Storage.prototype.setItem = function (k, v) {
        realSetItem.call(this, k, v);
        if (this === window.localStorage) sync.noteStorageWrite(String(k));
      };
      Storage.prototype.removeItem = function (k) {
        realRemoveItem.call(this, k);
        if (this === window.localStorage) sync.noteStorageRemove(String(k));
      };
    } catch (e) {
      /* a frozen Storage prototype leaves the cross-tab path working; same-tab auto-sync degrades */
    }

    function on(target, type, fn) {
      if (!target || typeof target.addEventListener !== "function") return;
      target.addEventListener(type, fn);
      listeners.push(function () {
        try {
          target.removeEventListener(type, fn);
        } catch (e) {
          /* target gone */
        }
      });
    }

    on(window, "storage", function (e) {
      sync.noteStorageEvent(e ? e.key : null);
    });

    // The desktop shell emits this from the tray "quit" and window-close paths, then waits ~1.2s.
    var unlisten = null;
    try {
      var listen = window.tauriSvc ? window.tauriSvc.listen : null;
      if (listen) {
        var ret = listen("app-flush-now", function () {
          sync.flushAll();
        });
        // Tauri v2 resolves an unlisten function; an older bridge may return null.
        if (ret && typeof ret.then === "function") {
          ret.then(function (fn) {
            if (typeof fn === "function") unlisten = fn;
          }, function () {});
        }
      }
    } catch (e) {
      /* plain web: the event never fires */
    }

    sync.bootstrap();

    return function dispose() {
      for (var i = listeners.length - 1; i >= 0; i--) {
        try { listeners[i](); } catch (e) { /* one listener failing must not stop teardown */ }
      }
      listeners.length = 0;
      var pending = Array.from(timersSeen);
      timersSeen.clear();
      for (var t = 0; t < pending.length; t++) {
        try { window.clearTimeout(pending[t]); } catch (e) { /* already fired */ }
      }
      if (realSetItem) {
        try { Storage.prototype.setItem = realSetItem; } catch (e) { /* frozen again */ }
      }
      if (realRemoveItem) {
        try { Storage.prototype.removeItem = realRemoveItem; } catch (e) { /* frozen again */ }
      }
      if (typeof unlisten === "function") {
        try { unlisten(); } catch (e) { /* shell already closed */ }
        unlisten = null;
      }
      if (window.syncSvc === api) {
        try { delete window.syncSvc; } catch (e) { window.syncSvc = undefined; }
      }
    };
  }

  var mod = { name: "sync", inject: ["transport", "db"], apply: apply };
  if (HOST) {
    HOST.define("sync", mod);
    HOST.start("sync");
    return;
  }
  apply({ get: function () { return null; } });
})();

globalThis.recOf = recOf;
globalThis.arrOf = arrOf;
globalThis.createSync = createSync;
})();
