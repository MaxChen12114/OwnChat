(function () {
/**
 * Checkpoints: one append-only record per saved state, with content-addressed payloads.
 *
 * The `scope` is the only behaviour switch:
 *   - `roleplay`: a conversation's messages + character/affection/scene state;
 *   - `work`: a manifest of agent-workspace file versions (`{path, version}`), no copied text;
 *   - `sandbox`: a deterministic simulation snapshot (tick/entities/RNG), owned by sim-kernel.
 *
 * The store itself never interprets a payload. `kind` is a label (`manual`, `auto`,
 * `pre-restore`, …), not a behaviour; pruning, restore and UI grouping key off `scope`.
 *
 * No DOM, no storage globals: every platform piece arrives as a port, so the tests drive it with
 * maps and a fixed digest. `captureRoleplay` / `applyRoleplay` are the roleplay adapter; `work` and
 * `sandbox` adapters land separately.
 * @module services/data/checkpoints
 */

                                                              

/** The three scopes the product exposes; a new one needs a restore adapter before it may be added. */
const CHECKPOINT_SCOPES                    = ["roleplay", "work", "sandbox"];

/** Per-scope retention defaults. A checkpoint is small; the payload may not be. */
const CHECKPOINT_CAPS                                  = {
  roleplay: 30,
  work: 100,
  sandbox: 20,
};

/** Same shape as the agent workspace's FileStore; classic artifacts cannot share imports. */
                            
                                            
                                                           
                                                   
                                    
                                                                                 
                         
 

                                       
                   
                   
                                                                                         
                                            
                    
                                        
                       
                                                  
 

                                    
                    
                 
                     
                 
 

                                
             
                         
                  
                  
               
             
                          
               
                
                                
 

                                  
                                                                                                      
                                                                            
                                     
                                        
                                                                  
                            
 

function strOf(value         )         {
  return value == null ? "" : String(value);
}

function numOf(value         )         {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function recOf(value         )                          {
  const out                          = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value)) out[k] = v;
  return out;
}

function isScope(value         )                           {
  return value === "roleplay" || value === "work" || value === "sandbox";
}

function rowOf(value         )                       {
  const r = recOf(value);
  const scope = r["scope"];
  if (!isScope(scope)) return null;
  const id = strOf(r["id"]);
  const scopeId = strOf(r["scopeId"]);
  if (!id || !scopeId) return null;
  return {
    id,
    scope,
    scopeId,
    subject: strOf(r["subject"]),
    kind: strOf(r["kind"]) || "manual",
    ts: numOf(r["ts"]),
    parentId: r["parentId"] == null ? null : strOf(r["parentId"]),
    hash: strOf(r["hash"]),
    bytes: numOf(r["bytes"]),
    meta: recOf(r["meta"]),
  };
}

function blobId(scope                 , scopeId        , hash        )         {
  return scope + "::" + scopeId + "::" + hash;
}

function defaultId(ts        )         {
  return "ck_" + ts.toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

/**
 * Build the generic checkpoint store. Every call returns a result object; a storage or digest
 * failure is reported, never thrown at the caller.
 */
function createCheckpointStore(ports                      )                  {
  const caps                                  = {
    roleplay: CHECKPOINT_CAPS.roleplay,
    work: CHECKPOINT_CAPS.work,
    sandbox: CHECKPOINT_CAPS.sandbox,
  };
  for (const scope of CHECKPOINT_SCOPES) {
    const raw = ports.caps && ports.caps[scope];
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) caps[scope] = Math.floor(raw);
  }

  function rows()                           {
    return ports.store.all()
      .then((list) => list.map(rowOf).filter((r)                     => r !== null))
      .catch(() => []);
  }

  function forScope(list                 , scope                 , scopeId        )                  {
    return list
      .filter((r) => r.scope === scope && r.scopeId === scopeId)
      .sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1));
  }

  async function gc(scope                 , scopeId        )                {
    try {
      const remaining = forScope(await rows(), scope, scopeId);
      const used = new Set(remaining.map((r) => r.hash));
      const blobs = await ports.blobs.all().catch(() => []);
      for (const raw of blobs) {
        const b = recOf(raw);
        if (strOf(b["scope"]) !== scope || strOf(b["scopeId"]) !== scopeId) continue;
        const hash = strOf(b["hash"]);
        if (hash && !used.has(hash)) {
          try { await ports.blobs.remove(strOf(b["id"])); } catch (_e) { /* best effort */ }
        }
      }
    } catch (_e) { /* best effort */ }
  }

  async function prune(scope                 , scopeId        )                {
    const list = forScope(await rows(), scope, scopeId);
    const keep = caps[scope];
    for (let i = keep; i < list.length; i++) {
      try { await ports.store.remove(list[i].id); } catch (_e) { /* best effort */ }
    }
    await gc(scope, scopeId);
  }

  async function put(scope         , scopeId         , payload         , opts                    )                   {
    if (!isScope(scope)) return { ok: false, error: "未知 scope（只允许 roleplay/work/sandbox）" };
    const sid = strOf(scopeId);
    if (!sid) return { ok: false, error: "scopeId 不能为空" };
    let text        ;
    try {
      const json = JSON.stringify(payload);
      if (typeof json !== "string") return { ok: false, error: "payload 不可序列化" };
      text = json;
    } catch (_e) {
      return { ok: false, error: "payload 不可序列化" };
    }
    let hash        ;
    try {
      hash = strOf(await ports.digest(text));
      if (!hash) return { ok: false, error: "digest 返回空" };
    } catch (_e) {
      return { ok: false, error: "内容哈希不可用" };
    }
    const o = opts || {};
    const ts = numOf(ports.now()) || Date.now();
    const id = typeof ports.newId === "function" ? strOf(ports.newId()) : defaultId(ts);
    if (!id) return { ok: false, error: "checkpoint id 为空" };
    const row                = {
      id,
      scope,
      scopeId: sid,
      subject: strOf(o.subject),
      kind: strOf(o.kind) || "manual",
      ts,
      parentId: o.parentId == null ? null : strOf(o.parentId),
      hash,
      bytes: text.length,
      meta: recOf(o.meta),
    };
    try {
      const bid = blobId(scope, sid, hash);
      const existing = await ports.blobs.get(bid).catch(() => null);
      if (!existing) {
        await ports.blobs.put({ id: bid, scope, scopeId: sid, hash, content: text, bytes: text.length });
      }
      await ports.store.put({ ...row });
    } catch (_e) {
      return { ok: false, error: "checkpoint 写入失败" };
    }
    await prune(scope, sid);
    return { ok: true, id, hash, scope, scopeId: sid, ts, bytes: text.length };
  }

  async function list(scope         , scopeId         , limit          )                   {
    if (!isScope(scope)) return { ok: false, error: "未知 scope" };
    const sid = strOf(scopeId);
    if (!sid) return { ok: false, error: "scopeId 不能为空" };
    const max = Math.max(1, Math.min(100, numOf(limit) || 20));
    const all = forScope(await rows(), scope, sid);
    return {
      ok: true,
      scope,
      scopeId: sid,
      total: all.length,
      checkpoints: all.slice(0, max).map((r) => ({
        id: r.id,
        subject: r.subject,
        kind: r.kind,
        ts: r.ts,
        parentId: r.parentId,
        bytes: r.bytes,
        meta: r.meta,
      })),
    };
  }

  async function get(id         )                   {
    const cid = strOf(id);
    if (!cid) return { ok: false, error: "checkpoint id 不能为空" };
    const raw = await ports.store.get(cid).catch(() => null);
    const row = raw ? rowOf(raw) : null;
    if (!row) return { ok: false, error: "checkpoint 不存在" };
    const blob = await ports.blobs.get(blobId(row.scope, row.scopeId, row.hash)).catch(() => null);
    if (!blob) return { ok: false, error: "checkpoint 正文已清理" };
    const text = strOf(recOf(blob)["content"]);
    let payload          = null;
    try { payload = JSON.parse(text); } catch (_e) { return { ok: false, error: "checkpoint 正文损坏" }; }
    return { ok: true, checkpoint: { ...row }, payload };
  }

  async function remove(id         )                   {
    const cid = strOf(id);
    if (!cid) return { ok: false, error: "checkpoint id 不能为空" };
    const raw = await ports.store.get(cid).catch(() => null);
    const row = raw ? rowOf(raw) : null;
    if (!row) return { ok: false, error: "checkpoint 不存在" };
    try { await ports.store.remove(cid); } catch (_e) { return { ok: false, error: "checkpoint 删除失败" }; }
    await gc(row.scope, row.scopeId);
    return { ok: true, id: cid };
  }

  async function removeScope(scope         , scopeId         )                   {
    if (!isScope(scope)) return { ok: false, error: "未知 scope" };
    const sid = strOf(scopeId);
    if (!sid) return { ok: false, error: "scopeId 不能为空" };
    let removed = 0;
    try {
      removed = await ports.store.removeWhere((row) => {
        const r = recOf(row);
        return strOf(r["scope"]) === scope && strOf(r["scopeId"]) === sid;
      });
    } catch (_e) { return { ok: false, error: "checkpoint 清理失败" }; }
    try {
      await ports.blobs.removeWhere((row) => {
        const r = recOf(row);
        return strOf(r["scope"]) === scope && strOf(r["scopeId"]) === sid;
      });
    } catch (_e) { /* blob cleanup is best effort */ }
    return { ok: true, removed };
  }

  async function clear()                   {
    try {
      await ports.store.clear();
      await ports.blobs.clear();
      return { ok: true };
    } catch (_e) {
      return { ok: false, error: "checkpoint 全清失败" };
    }
  }

  return { put, list, get, remove, removeScope, clear };
}

                               
                           
                                                                         
                                                                             
                            
                                                                                           
                                                    
                        
                                   
                       
                                  
                                
                                                           
                          
                                   
                            
                                      
 

/** The roleplay payload: messages + the four state-layer sources the user asked for. */
function captureRoleplay(host              )                          {
  const messages = Array.isArray(host.getMessages()) ? host.getMessages().slice() : [];
  const sceneIds = Array.isArray(host.getSceneIds()) ? host.getSceneIds().filter((id) => typeof id === "string" && id) : [];
  const affection = host.getAffection();
  return {
    messages,
    activeCharId: strOf(host.getActiveCharId()),
    relation: strOf(host.getRelation()),
    emotion: strOf(host.getEmotion()),
    affection: typeof affection === "number" && Number.isFinite(affection) ? affection : null,
    sceneIds,
    priorSummary: strOf(host.getPriorSummary()),
  };
}

/**
 * Apply a roleplay payload. Order is deliberate: the active card first (relation/emotion/affection
 * act on it), then the scene in one write, then the summary chip. Returns false on any refusal.
 */
async function applyRoleplay(payload         , host              )                   {
  const p = recOf(payload);
  const messages = Array.isArray(p["messages"]) ? p["messages"] : [];
  try {
    const ok = await host.setMessages(messages);
    if (ok === false) return false;
    // `setActiveId` refreshes the card asynchronously; affection would hit the old card if we
    // wrote it before the refresh settled.
    await host.setActiveCharId(strOf(p["activeCharId"]));
    host.setRelation(strOf(p["relation"]));
    host.setEmotion(strOf(p["emotion"]));
    const rawAffection = p["affection"];
    await host.setAffection(rawAffection == null || rawAffection === "" ? null : numOf(rawAffection));
    const sceneIds = Array.isArray(p["sceneIds"])
      ? p["sceneIds"].filter((id)               => typeof id === "string" && id.length > 0)
      : [];
    host.setSceneIds(sceneIds);
    host.setPriorSummary(strOf(p["priorSummary"]));
    return true;
  } catch (_e) {
    return false;
  }
}

// ── Browser wiring (injected by tooling/l0/emit.mjs): binds the checkpoint store to `window.__checkpoints` ──
// Generic checkpoint storage in its own IndexedDB (`cfw_checkpoints_v1`: checkpoints + blobs), the
// SHA-256 digest, and the live roleplay host. `work` and `sandbox` adapters land separately; they
// share the same store and blob table, not their domain tables.
(function () {
  "use strict";
  if (window.__checkpoints) return;

  var IDB_NAME = "cfw_checkpoints_v1";
  var IDB_STORE = "checkpoints";
  var IDB_BLOBS = "blobs";
  var _db = null;

  function idb() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (resolve) {
      try {
        var req = window.indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = function () {
          var d = req.result;
          if (!d.objectStoreNames.contains(IDB_STORE)) {
            var os = d.createObjectStore(IDB_STORE, { keyPath: "id" });
            try { os.createIndex("scope", "scope", { unique: false }); } catch (e) {}
            try { os.createIndex("scopeId", "scopeId", { unique: false }); } catch (e) {}
          }
          if (!d.objectStoreNames.contains(IDB_BLOBS)) {
            var bs = d.createObjectStore(IDB_BLOBS, { keyPath: "id" });
            try { bs.createIndex("scope", "scope", { unique: false }); } catch (e) {}
            try { bs.createIndex("scopeId", "scopeId", { unique: false }); } catch (e) {}
          }
        };
        req.onsuccess = function () { _db = req.result; resolve(_db); };
        req.onerror = function () { resolve(null); };
        req.onblocked = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
  }

  function tx(storeName, mode) {
    return idb().then(function (db) { return db ? db.transaction(storeName, mode).objectStore(storeName) : null; });
  }

  function reqP(r) {
    return new Promise(function (res) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { res(null); }; });
  }

  function need(os) {
    if (!os) throw new Error("checkpoint 存储不可用(IndexedDB 打不开)");
    return os;
  }

  function makeStore(storeName) {
    return {
      all: function () {
        return tx(storeName, "readonly").then(function (os) { return os ? reqP(os.getAll()) : []; }).then(function (arr) {
          return Array.isArray(arr) ? arr : [];
        });
      },
      get: function (id) {
        return tx(storeName, "readonly").then(function (os) { return os ? reqP(os.get(id)) : null; });
      },
      put: function (row) {
        return tx(storeName, "readwrite").then(function (os) { return reqP(need(os).put(row)); });
      },
      remove: function (id) {
        return tx(storeName, "readwrite").then(function (os) { return reqP(need(os).delete(id)); });
      },
      removeWhere: function (match) {
        return tx(storeName, "readwrite").then(function (os) {
          if (!os) return Promise.reject(new Error("checkpoint 存储不可用(IndexedDB 打不开)"));
          return new Promise(function (res, rej) {
            var n = 0;
            var r = os.openCursor();
            r.onsuccess = function (e) {
              var c = e.target.result;
              if (!c) return res(n);
              if (match(c.value)) { n++; c.delete(); }
              c.continue();
            };
            r.onerror = function () { rej(new Error("checkpoint 游标读取失败")); };
          });
        });
      },
      clear: function () {
        return tx(storeName, "readwrite").then(function (os) { return reqP(need(os).clear()); });
      },
    };
  }

  var store = makeStore(IDB_STORE);
  var blobs = makeStore(IDB_BLOBS);

  /** SHA-256 of UTF-8 text; the same contract as agent-workspace's digest. */
  function digest(text) {
    var c = (typeof window !== "undefined" && window.crypto) || null;
    if (!c || !c.subtle || typeof c.subtle.digest !== "function" || typeof TextEncoder === "undefined") {
      return Promise.reject(new Error("crypto.subtle/TextEncoder 不可用"));
    }
    var bytes = new TextEncoder().encode(String(text == null ? "" : text));
    return c.subtle.digest("SHA-256", bytes).then(function (buf) {
      var arr = new Uint8Array(buf), hex = "";
      for (var i = 0; i < arr.length; i++) hex += (arr[i] < 16 ? "0" : "") + arr[i].toString(16);
      return "sha256:" + hex;
    });
  }

  var checkpoints = createCheckpointStore({
    store: store,
    blobs: blobs,
    digest: digest,
    now: function () { return Date.now(); },
  });

  /**
   * The live roleplay host. The three setters are the host hooks added for rollback:
   * `appSvc.setSessionMessages`, `multiSvc.setSceneIds`, `appSvc.setPriorSummary`.
   * Capture is read-only; apply refuses while a turn is live (setSessionMessages returns false).
   */
  function roleplayHost() {
    var app = (typeof window !== "undefined" && window.appSvc) || null;
    var ch = (typeof window !== "undefined" && window.characterSvc) || null;
    var multi = (typeof window !== "undefined" && window.multiSvc) || null;
    return {
      getMessages: function () {
        try { return (app && app.getSessionMessages) ? app.getSessionMessages() : []; } catch (e) { return []; }
      },
      setMessages: function (messages) {
        try { return (app && app.setSessionMessages) ? app.setSessionMessages(messages) : false; } catch (e) { return false; }
      },
      getActiveCharId: function () {
        try {
          var card = ch && ch.getActiveCard ? ch.getActiveCard() : null;
          return card && card.id ? String(card.id) : "";
        } catch (e) { return ""; }
      },
      setActiveCharId: function (id) {
        try {
          if (ch && ch.setActiveId) ch.setActiveId(String(id || ""));
          // setActiveId refreshes in the background; wait for the new card before affection.
          if (ch && typeof ch.refresh === "function") return ch.refresh();
        } catch (e) {}
        return Promise.resolve();
      },
      getRelation: function () {
        try { return (ch && ch.getActiveRelation) ? String(ch.getActiveRelation() || "") : ""; } catch (e) { return ""; }
      },
      setRelation: function (value) {
        try { if (ch && ch.setActiveRelation) ch.setActiveRelation(String(value || "")); } catch (e) {}
      },
      getEmotion: function () {
        try { return (ch && ch.getActiveEmotion) ? String(ch.getActiveEmotion() || "") : ""; } catch (e) { return ""; }
      },
      setEmotion: function (value) {
        try { if (ch && ch.setActiveEmotion) ch.setActiveEmotion(String(value || "")); } catch (e) {}
      },
      getAffection: function () {
        try {
          var v = ch && ch.getActiveAffection ? ch.getActiveAffection() : null;
          return typeof v === "number" && Number.isFinite(v) ? v : null;
        } catch (e) { return null; }
      },
      setAffection: function (value) {
        try {
          if (ch && ch.setActiveAffection) return ch.setActiveAffection(value);
        } catch (e) {}
        return Promise.resolve();
      },
      getSceneIds: function () {
        try { return (multi && multi.getSceneIds) ? multi.getSceneIds() : []; } catch (e) { return []; }
      },
      setSceneIds: function (ids) {
        try { if (multi && multi.setSceneIds) multi.setSceneIds(ids); } catch (e) {}
      },
      getPriorSummary: function () {
        // Summaries are per conversation now (services/conv/summary.ts); capture the current one.
        try {
          var id = (app && app.getActiveConvId) ? app.getActiveConvId() : "";
          return (window.convSummarySvc && id) ? window.convSummarySvc.load(id) : "";
        } catch (e) { return ""; }
      },
      setPriorSummary: function (text) {
        try { if (app && app.setPriorSummary) app.setPriorSummary(String(text || "")); } catch (e) {}
      },
    };
  }

  window.__checkpoints = {
    put: checkpoints.put,
    list: checkpoints.list,
    get: checkpoints.get,
    remove: checkpoints.remove,
    removeScope: checkpoints.removeScope,
    clear: checkpoints.clear,
    captureRoleplay: captureRoleplay,
    applyRoleplay: applyRoleplay,
    roleplayHost: roleplayHost,
    scopes: CHECKPOINT_SCOPES,
    _idb: { name: IDB_NAME, store: IDB_STORE, blobs: IDB_BLOBS },
  };
})();

globalThis.CHECKPOINT_SCOPES = CHECKPOINT_SCOPES;
globalThis.CHECKPOINT_CAPS = CHECKPOINT_CAPS;
globalThis.createCheckpointStore = createCheckpointStore;
globalThis.captureRoleplay = captureRoleplay;
globalThis.applyRoleplay = applyRoleplay;
})();
