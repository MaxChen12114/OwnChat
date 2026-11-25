(function () {
/**
 * Session persistence: the conversation array as it lives in storage, plus the two pieces of
 * sync bookkeeping that must move with it — the per-slot timestamp and the deletion tombstone.
 *
 * Nothing about rendering is here. Restoring a conversation into the DOM, mounting the list and
 * deciding when to switch stay in the app; this file only knows "the array for conversation X"
 * and "when it last changed".
 *
 * The guards are the interesting part:
 *  - The size trim works on a copy. Trimming the live array would silently drop history the model
 *    is still using; only the stored copy is shortened.
 *  - The overshoot is estimated once from the average message size, then corrected in steps. The
 *    previous version re-serialised the whole blob every two messages, which was quadratic.
 *  - The write-back diff needs the array from *before* this write, so it is captured before the
 *    in-memory slot is replaced.
 * @module services/session/store
 */

                            
                                      
                                            
                                
 

/** Message shape is left open: the service only passes through, shallow-copies and counts. */
                                          
                           

                                   
                         
                                
                                         
                        
                            
                                                                   
                                 
                                          
                                                  
                                                                           
                                                     
                                                                        
 

                                    
                     
 

                               
                          
                            
                       
                   
                                             
                                                      
                                      
                                            
                           
                                                           
                                  
 

function createSessionStore(ports                   , host                   )               {
  const h = host || {};
  const storage = ports.storage;
  const LS_CHAT_SESSION = "cfw_chat_session_v1";
  const LS_CHAT_SLOT_META = "cfw_chat_slot_meta_v1";
  const LS_CHAT_TOMB = "cfw_chat_tomb_v1";
  const LS_LIMIT = 2 * 1024 * 1024;

  const getDeviceId = typeof h.getDeviceId === "function" ? h.getDeviceId : function () { return "dev_unknown"; };
  const getHistoryEnabled = typeof h.getHistoryEnabled === "function" ? h.getHistoryEnabled : function () { return true; };
  const getMemSlots = typeof h.getMemSlots === "function" ? h.getMemSlots : function () { return {}; };
  const getSession = typeof h.getSession === "function" ? h.getSession : function () { return []; };
  const currentSlotKey = typeof h.currentSlotKey === "function" ? h.currentSlotKey : function () { return ""; };
  const touchConv = typeof h.touchConv === "function" ? h.touchConv : function () {};
  const isConvId = typeof h.isConvId === "function" ? h.isConvId : function () { return false; };
  const getConvMeta = typeof h.getConvMeta === "function" ? h.getConvMeta : function () { return {}; };
  const saveConvMeta = typeof h.saveConvMeta === "function" ? h.saveConvMeta : function () {};
  const ensureMessageIds = typeof h.ensureMessageIds === "function" ? h.ensureMessageIds : null;
  const getChatSlotMeta = typeof h.getChatSlotMeta === "function" ? h.getChatSlotMeta : null;
  const recordLocal = typeof h.recordLocal === "function" ? h.recordLocal : null;

  function loadAllSessions()                          {
    try {
      const raw = storage.getItem(LS_CHAT_SESSION);
      if (!raw) return {};
      const obj          = JSON.parse(raw);
      if (Array.isArray(obj)) return { __none__: obj };
      return (typeof obj === "object" && obj !== null) ? toRecord(obj) : {};
    } catch { return {}; }
  }
  function saveAllSessions(all                         )       {
    try {
      if (all && Object.keys(all).length) storage.setItem(LS_CHAT_SESSION, JSON.stringify(all));
      else storage.removeItem(LS_CHAT_SESSION);
    } catch {}
  }

  // Sync hooks: per-slot last-modified stamp and the deletion tombstone.
  function bumpSlotMeta(slotKey        )       {
    if (!slotKey) return;
    try {
      const raw          = JSON.parse(storage.getItem(LS_CHAT_SLOT_META) || "{}");
      const m                          = (typeof raw === "object" && raw !== null) ? toRecord(raw) : {};
      m[slotKey] = { updatedAt: Date.now(), deviceId: getDeviceId() };
      storage.setItem(LS_CHAT_SLOT_META, JSON.stringify(m));
    } catch {}
  }
  function writeChatTombstone(slotKey        )       {
    if (!slotKey) return;
    try {
      const raw          = JSON.parse(storage.getItem(LS_CHAT_TOMB) || "{}");
      const t                          = (typeof raw === "object" && raw !== null) ? toRecord(raw) : {};
      t[slotKey] = { deletedAt: Date.now(), deviceId: getDeviceId() };
      storage.setItem(LS_CHAT_TOMB, JSON.stringify(t));
    } catch {}
  }

  // One-shot purge of the pre-2026-09 slot format, whose keys were "<cardId>#<convId>" or a bare
  // card id; the current keys are flat "c_..." ids. Every dropped key gets a tombstone first —
  // without one, sync pulls the old data straight back as orphan slots the list never shows.
  function purgeLegacyConvs()       {
    try {
      if (storage.getItem("cfw_conv_purged_v2") === "1") return;
      const all = loadAllSessions();
      const memSlots = getMemSlots();
      let n = 0;
      for (const k of Object.keys(all)) {
        if (isConvId(k)) continue;
        writeChatTombstone(k);
        delete all[k];
        delete memSlots[k];
        n++;
      }
      saveAllSessions(all);
      // Registry: drop the nested entries, keep only flat ids.
      const meta = getConvMeta();
      const flat                          = {};
      for (const k of Object.keys(meta)) if (isConvId(k)) flat[k] = meta[k];
      saveConvMeta(flat);
      // Stamps for the dropped keys go too; a stale stamp would fight the tombstone.
      try {
        const raw          = JSON.parse(storage.getItem(LS_CHAT_SLOT_META) || "{}");
        const sm                          = (typeof raw === "object" && raw !== null) ? toRecord(raw) : {};
        const sm2                          = {};
        for (const k of Object.keys(sm)) if (isConvId(k)) sm2[k] = sm[k];
        storage.setItem(LS_CHAT_SLOT_META, JSON.stringify(sm2));
      } catch {}
      storage.setItem("cfw_conv_purged_v2", "1");
      console.log("[conv] 已清理旧格式对话槽位:", n, "个");
    } catch {}
  }

  function persistSessionForConv(convId        , arr        )       {
    if (!convId || !Array.isArray(arr)) return;
    const memSlots = getMemSlots();
    // The live-channel diff needs the array as of the previous write, so grab it before the
    // in-memory slot is replaced.
    const prevRaw = memSlots[convId];
    const prev                = Array.isArray(prevRaw) ? prevRaw : null;
    // Stable ids are assigned once and shared by the in-memory slot and the stored copy, so the
    // next diff can only report additions.
    let full = arr;
    try { if (ensureMessageIds) full = ensureMessageIds(arr, convId, getDeviceId()); } catch {}
    // First write of a conversation that has no slot stamp yet: an empty baseline counts as [],
    // otherwise the first user message is never reported as an append. A conversation with no
    // in-memory baseline stays null, so a whole history is not re-sent as one giant append.
    let prevForDiff                = prev;
    try {
      const sm = (getChatSlotMeta && getChatSlotMeta()) || {};
      const cur = sm[convId];
      const hasMeta = !!(cur && typeof cur === "object" && "updatedAt" in cur && cur.updatedAt);
      if (prev === null && !hasMeta) prevForDiff = full.length <= 1 ? [] : null;
    } catch {}
    // The in-memory slot is updated unconditionally, even with history off: that is what lets a
    // background turn resume when the user switches back.
    try { memSlots[convId] = full.map(function (m) { return Object.assign({}, m); }); } catch {}
    if (!getHistoryEnabled()) return;
    try {
      const all = loadAllSessions();
      // Trim a copy, never the live session: cutting the live array made the model forget the
      // start of the conversation. Only the stored copy ends up shortened.
      let trimmed = full.slice();
      all[convId] = trimmed;
      let data = JSON.stringify(all);
      // Over the limit: estimate the cut once from the average message size, then correct in
      // steps. Re-serialising the whole blob every two messages was the old quadratic path.
      if (data.length > LS_LIMIT && trimmed.length > 2) {
        const perMsg = Math.max(1, Math.floor(JSON.stringify(trimmed).length / Math.max(1, trimmed.length)));
        const overshoot = data.length - LS_LIMIT;
        const cut = Math.min(trimmed.length - 2, Math.ceil(overshoot / perMsg / 2) * 2);
        if (cut > 0) trimmed.splice(0, cut);
        all[convId] = trimmed;
        data = JSON.stringify(all);
        while (data.length > LS_LIMIT && trimmed.length > 2) {
          trimmed.splice(0, 100);
          all[convId] = trimmed;
          data = JSON.stringify(all);
        }
      }
      storage.setItem(LS_CHAT_SESSION, data);
      bumpSlotMeta(convId); // last-modified stamp for slot-level merge
      touchConv(convId, {}); // keeps list ordering by real activity, background turns included
      // Hand this write's diff to the live channel (append or full replace).
      try { if (recordLocal) recordLocal(convId, prevForDiff, trimmed); } catch {}
    } catch {}
  }
  function persistSessionIfEnabled()       { persistSessionForConv(currentSlotKey(), getSession()); }

  return {
    LS_CHAT_SESSION, LS_CHAT_SLOT_META, LS_CHAT_TOMB, LS_LIMIT,
    loadAllSessions, saveAllSessions, bumpSlotMeta, writeChatTombstone,
    purgeLegacyConvs, persistSessionForConv, persistSessionIfEnabled,
  };
}

/** object to Record, bridged through Object.entries so no assertion is needed. */
function toRecord(o        )                          {
  const out                          = {};
  for (const [k, v] of Object.entries(o)) out[k] = v;
  return out;
}

// Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name.
(function () {
  var G = (typeof window !== "undefined" ? window : globalThis);
  if (G.__sessionStore) return;
  var LS = G.localStorage;
  var ports = { storage: { getItem: function (k) { return LS.getItem(k); }, setItem: function (k, v) { LS.setItem(k, v); }, removeItem: function (k) { LS.removeItem(k); } } };
  G.__sessionStore = { create: function (host) { return createSessionStore(ports, host); } };
})();

globalThis.createSessionStore = createSessionStore;
})();
