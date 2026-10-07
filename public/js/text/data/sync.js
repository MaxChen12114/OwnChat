// public/js/text/data/sync.js
// 云同步引擎：
// - dumpAll()      → 打包全部 localStorage + IndexedDB 为 JSON blob
// - restoreAll()   → 从 JSON blob 还原本地数据
// - pullFromKV()   → GET /sync
// - pushToKV(blob) → PUT /sync
// - markDirty()    → debounce 30s 后 push
// - pullOnStartup()→ 启动时拉一次，远端 newer 则 restore + reload
// - exportJSON / importJSON → 本地文件备份
//
// localStorage 一变动 (storage 事件) 或 app.js 调 __sync.markDirty() 都会触发 push
(() => {
  const SYNC_ENABLED_KEY = "cfw_sync_enabled_v1";
  const LAST_PUSH_KEY    = "cfw_sync_last_push_v1";
  const LAST_PULL_KEY    = "cfw_sync_last_pull_v1";
  // 4.17 新增: 同步聊天历史 toggle(默认 OFF) / 暂停同步 / push 计数(KV 配额监控)
  const INCLUDE_CHAT_KEY   = "cfw_sync_include_chat_v1";
  const PAUSE_KEY          = "cfw_sync_paused_v1";
  const PUSH_COUNT_KEY     = "cfw_sync_push_count_v1";
  const PUSH_COUNT_DAY_KEY = "cfw_sync_push_count_day_v1";
  const PUSH_DAILY_WARN    = 800; // Cloudflare KV 免费层 1000 writes/day,到 800 触发告警
  // 4.21: 同步排除清单(tombstone) - 设备本地,不参与同步。{ roles:[charId], sessions:[slotKey] }
  // push 时从 blob 剔除(只清云端);pull restore 时保护本地副本(保留本地)
  const EXCLUDE_KEY = "cfw_sync_exclude_v1";
  const CHARS_DB    = "tavern_chars_v2"; // 角色卡所在 IDB(按角色排除时过滤)
  // 4.21-F: 排除清单跨设备同步(独立通道 /sync/exclude, 服务端按条目 ts LWW 合并;清单本身仍不进 main blob)
  const LAST_EXCLUDE_PUSH_KEY = "cfw_sync_last_exclude_push_v1";
  const LAST_EXCLUDE_PULL_KEY = "cfw_sync_last_exclude_pull_v1";
  // 4.76: 聊天会话独立同步通道 (/sync/chat) - slot 级合并 + 3-way 冲突检测 + tombstone,取代 main blob 整段 LWW
  const CHAT_SLOT_META_KEY = "cfw_chat_slot_meta_v1"; // { slotKey:{updatedAt,deviceId} } 同步(走 chat 通道)
  const CHAT_TOMB_KEY      = "cfw_chat_tomb_v1";       // { slotKey:{deletedAt,deviceId} } 同步(走 chat 通道)
  const CHAT_CONV_META_KEY = "cfw_conv_meta_v1";       // { base:{convId:{name,createdAt}} } 同步(会话名)
  const CHAT_SYNCED_KEY    = "cfw_chat_synced_v1";     // { slotKey:{hash,syncedAt} } 仅本机(3-way base)
  const CHAT_CONFLICTS_KEY = "cfw_chat_conflicts_v1";  // 待用户裁决的冲突,仅本机
  const LAST_CHAT_PUSH_KEY = "cfw_sync_last_chat_push_v1";
  const LAST_CHAT_PULL_KEY = "cfw_sync_last_chat_pull_v1";
  const CHAT_DEVICE_ID_KEY = "cfw_device_id_v1";
  // 命中即触发 markChatDirty(而非 main markDirty);applyMergedChatToLocal 期间用 _applyingRemoteChat 抑制回环
  const CHAT_DIRTY_KEYS = ["cfw_chat_session_v1", "cfw_chat_slot_meta_v1", "cfw_chat_tomb_v1", "cfw_conv_meta_v1"];
  let _applyingRemoteChat = false;
  // 4.78: 角色卡独立同步通道 (/sync/chars) - 按卡 id LWW 合并 + tombstone,取代 main blob 整段 LWW
  const CHARS_META_KEY = "cfw_chars_meta_v1"; // { [id]:{updatedAt,deviceId} } 同步(走 chars 通道)
  const CHARS_TOMB_KEY = "cfw_chars_tomb_v1"; // { [id]:{deletedAt,deviceId} } 同步(走 chars 通道)
  const LAST_CHARS_PUSH_KEY = "cfw_sync_last_chars_push_v1";
  const LAST_CHARS_PULL_KEY = "cfw_sync_last_chars_pull_v1";
  // 命中即触发 markCharsDirty(而非 main markDirty);applyMergedCharsToLocal 期间用 _applyingRemoteChars 抑制回环
  const CHARS_DIRTY_KEYS = ["cfw_chars_meta_v1", "cfw_chars_tomb_v1"];
  let _applyingRemoteChars = false;

  // 需同步的精确 LS key。注意:实际同步以 collectLS() 的"PROTECTED 反向排除 + 前缀 + 全量兜底"为准,
  // 这份白名单主要起文档作用(标明哪些 key 预期上云),新增 key 不加进来也会被全量兜底带走。
  const LS_EXPLICIT = [
    "cfw_theme_v1", "cfw_theme_accent_v1", "cfw_thinking",
    "cfw_prior_summary_v1", "cfw_summary_enabled", "cfw_summary_trigger", "cfw_summary_keep",
    "tavern_active_scene_v1", "tavern_aff_pending_v1",
    "cfw_prompt_presets_v1", "cfw_skills_v1", "cfw_skills_enabled_v1", "tavern_multi_agent_mode_v1",
    // 4.49 P2 世界书:纯文本条目,跨设备同步(文件云端)
    "tavern_lorebook_v1",
    // 4.22 → 2026-10-06: 现在只剩「聊天背景图」(设置·外观);颜色/圆角/背景音等覆盖页已删
    "cfw_ui_overrides_v1",
    // 4.20: cfw_cost_log_v1 移出 main blob → 独立 /sync/cost KV (per-day per-field max merge),跨设备不丢数据
    "cfw_mode", "cfw_model", "cfw_use_builtin", "cfw_history_enabled",
    "cfw_prompt_enabled", "cfw_custom_prompt_v1",
    // 2026-09-12 / 4.70 API 云端化:同步自定义直连的非敏感配置与自定义定价。
    // API Key 仍留在 cfw_byo_provider_v1(受保护本地私密),跨端只带 endpoint/model/models/thinking。
    "cfw_byo_provider_public_v1", "cfw_custom_pricing_v1",
    // 4.17: cfw_chat_session_v1 已移出默认白名单,改由 includeChat() toggle 控制(默认 OFF 避免跨设备覆盖)
  ];
  // 前缀匹配（多实例）
  const LS_PREFIXES = [
    "tavern_aff_triggered_",
    "cfw_summary_",  // 领域预留
  ];
  // 受保护不同步的 LS key（同步状态本身 + auth token）
  const PROTECTED = [
    "cfw_auth_token_v1",
    "cfw_chat_protect_v1",
    "cfw_byo_provider_v1", // 自定义 API 私密配置:含 apiKey,永不同步;公开副本走 cfw_byo_provider_public_v1
    SYNC_ENABLED_KEY, LAST_PUSH_KEY, LAST_PULL_KEY,
    INCLUDE_CHAT_KEY, PAUSE_KEY, PUSH_COUNT_KEY, PUSH_COUNT_DAY_KEY, // 4.17 同步控制开关本身不进同步
    // 4.20: 费用独立同步 - 不进 main blob;monkey-patch setItem 看到这些 key 跳过 main markDirty
    "cfw_cost_log_v1",
    "cfw_sync_last_cost_push_v1",
    "cfw_sync_last_cost_pull_v1",
    // 4.50: 设备 id 仅本机,永不同步(同步了所有设备会共用一个桶 → 又退化成少算)
    "cfw_device_id_v1",
    EXCLUDE_KEY, // 4.21: 排除清单不进 main blob(改走 4.21-F 独立 /sync/exclude 通道)
    LAST_EXCLUDE_PUSH_KEY, LAST_EXCLUDE_PULL_KEY, // 4.21-F: 排除清单同步时间戳
    // 4.22 → 2026-10-06: 背景图上传的 base64 仅本机,永不进同步包(只同步 URL)
    "cfw_ui_assets_v1",
    // 4.76: 聊天会话改走独立 /sync/chat 通道(slot 级合并),不进 main blob;以下 setItem 转触发 markChatDirty
    "cfw_chat_session_v1",   // 移出 main blob —— 改 /sync/chat slot 级合并
    "cfw_chat_slot_meta_v1", // slot 修改元数据(走 chat 通道)
    "cfw_chat_tomb_v1",      // 删除墓碑(走 chat 通道)
    "cfw_conv_meta_v1",      // 会话名(走 chat 通道)
    "cfw_chat_synced_v1",    // 仅本机:3-way base hash
    "cfw_chat_conflicts_v1", // 仅本机:待裁决冲突
    "cfw_conv_active_v1",    // 仅本机:当前活跃会话
    // 4.78: 角色卡改走独立 /sync/chars 通道;meta/tomb 的 setItem 转触发 markCharsDirty,其余时间戳仅本机
    CHARS_META_KEY, CHARS_TOMB_KEY,
    LAST_CHARS_PUSH_KEY, LAST_CHARS_PULL_KEY,
  ];
  // IndexedDB 数据库名列表
  // 4.78: tavern_chars_v2(角色卡)移出 main blob → 独立 /sync/chars 通道(按卡 id LWW 合并),避免整段 LWW 跨设备互相覆盖。
  // 2026-10-06: 道具卡整条删掉后,main blob **不再携带任何 IDB**(角色卡走独立通道;道具已不存在)——
  //   列表留空而不是删变量:dumpAll/restoreAll 的循环与语义都还在,将来要加 DB 只改这里。
  const IDB_NAMES = [];

  function token() { return (window.__auth && window.__auth.getToken && window.__auth.getToken()) || ""; }
  function syncAuthHeaders(extra) {
    const h = Object.assign({}, extra || {});
    const t = token();
    if (t) h.Authorization = "Bearer " + t;
    return h;
  }
  function syncEnabled() { return localStorage.getItem(SYNC_ENABLED_KEY) === "1"; }
  function setSyncEnabled(on) { localStorage.setItem(SYNC_ENABLED_KEY, on ? "1" : "0"); }

  // ─── localStorage dump/restore ───
  function collectLS() {
    const out = {};
    const seen = new Set();
    for (const k of LS_EXPLICIT) {
      const v = localStorage.getItem(k);
      if (v !== null) { out[k] = v; seen.add(k); }
    }
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || seen.has(k) || PROTECTED.includes(k)) continue;
      if (LS_PREFIXES.some(p => k.startsWith(p))) out[k] = localStorage.getItem(k);
    }
    // 4.76: 聊天历史已移出 main blob,改走独立 /sync/chat 通道(slot 级合并 + 冲突裁决);此处不再收集
    return out;
  }
  function restoreLS(ls) {
    if (!ls || typeof ls !== "object") return;
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || PROTECTED.includes(k)) continue;
      const explicit = LS_EXPLICIT.includes(k);
      const prefix = LS_PREFIXES.some(p => k.startsWith(p));
      if (explicit || prefix) toRemove.push(k);
    }
    for (const k of toRemove) localStorage.removeItem(k);
    for (const k in ls) {
      if (PROTECTED.includes(k)) continue;
      // 2026-10-06: 同上,旧云包里的 localStorage.tavern_active_props_v1 也不再还原(道具卡已删)。
      if (k === "tavern_active_props_v1") continue;
      // 4.17: 远端有聊天 session 但本地未开 includeChat,跳过(避免另一台设备的聊天覆盖本地)
      if (k === "cfw_chat_session_v1" && !includeChat()) continue;
      if (typeof ls[k] === "string") localStorage.setItem(k, ls[k]);
    }
  }

  // ─── IndexedDB dump/restore（按 store 全量）───
  function openDB(name) {
    return new Promise((res) => {
      let upgrading = false;
      const req = indexedDB.open(name);
      req.onsuccess = () => res(upgrading ? null : req.result);
      req.onerror = () => res(null);
      req.onupgradeneeded = (e) => {
        upgrading = true;
        try { e.target.transaction.abort(); } catch {}
      };
      req.onblocked = () => res(null);
    });
  }
  async function dumpDB(name) {
    const db = await openDB(name);
    if (!db) return null;
    const out = {};
    try {
      const stores = Array.from(db.objectStoreNames);
      for (const sn of stores) {
        out[sn] = await new Promise((res) => {
          const tx = db.transaction(sn, "readonly");
          const store = tx.objectStore(sn);
          const r = store.getAll();
          r.onsuccess = () => res(r.result || []);
          r.onerror = () => res([]);
        });
      }
    } finally { try { db.close(); } catch {} }
    return out;
  }
  async function restoreDB(name, data) {
    if (!data || typeof data !== "object") return;
    const db = await openDB(name);
    if (!db) return;
    try {
      const stores = Array.from(db.objectStoreNames);
      for (const sn of stores) {
        const items = data[sn];
        if (!Array.isArray(items)) continue;
        await new Promise((res) => {
          const tx = db.transaction(sn, "readwrite");
          const store = tx.objectStore(sn);
          store.clear();
          for (const it of items) { try { store.put(it); } catch {} }
          tx.oncomplete = () => res();
          tx.onerror = () => res();
          tx.onabort = () => res();
        });
      }
    } finally { try { db.close(); } catch {} }
  }

  // ─── 4.21: 同步排除清单读写 (按角色/会话 只清云端、保留本地) ───
  // 4.21-F: 内部存为带时间戳的逐条登记表,支持跨设备 LWW 合并(谁后操作谁生效)
  //   registry = { entries: { "<kind>:<key>": { kind:"role"|"session", key, state:"excluded"|"restored", ts } } }
  //   getExcluded() 仍对下游返回 { roles, sessions }(只含 state==="excluded"),4.21-D/E 逻辑零改动
  function normKind(kind) { return kind === "session" ? "session" : "role"; }
  function entryId(kind, key) { return normKind(kind) + ":" + key; }
  function getRegistry() {
    try {
      const o = JSON.parse(localStorage.getItem(EXCLUDE_KEY) || "{}");
      if (o && o.entries && typeof o.entries === "object") return { entries: o.entries };
      // 旧格式 { roles, sessions } 迁移 → 逐条登记(ts=1 低优先,任何新操作都能覆盖)
      const entries = {};
      if (o && Array.isArray(o.roles)) for (const k of o.roles) if (typeof k === "string" && k) entries[entryId("role", k)] = { kind: "role", key: k, state: "excluded", ts: 1 };
      if (o && Array.isArray(o.sessions)) for (const k of o.sessions) if (typeof k === "string" && k) entries[entryId("session", k)] = { kind: "session", key: k, state: "excluded", ts: 1 };
      return { entries };
    } catch { return { entries: {} }; }
  }
  function setRegistry(reg) {
    localStorage.setItem(EXCLUDE_KEY, JSON.stringify({ entries: (reg && reg.entries) || {} }));
  }
  function getExcluded() {
    const reg = getRegistry();
    const roles = [], sessions = [];
    for (const id in reg.entries) {
      const e = reg.entries[id];
      if (!e || e.state !== "excluded" || typeof e.key !== "string" || !e.key) continue;
      if (e.kind === "session") sessions.push(e.key); else roles.push(e.key);
    }
    return { roles, sessions };
  }
  function addExclusion(kind, key) {
    if (!key) return;
    const reg = getRegistry();
    reg.entries[entryId(kind, key)] = { kind: normKind(kind), key, state: "excluded", ts: Date.now() };
    setRegistry(reg);
  }
  function removeExclusion(kind, key) {
    if (!key) return;
    const reg = getRegistry();
    // 保留条目并标记 restored(带新时间戳),让"恢复"也能跨设备覆盖更早的 excluded
    reg.entries[entryId(kind, key)] = { kind: normKind(kind), key, state: "restored", ts: Date.now() };
    setRegistry(reg);
  }
  // 4.21-F: 登记表逐条 LWW 合并(ts 大者胜)
  function mergeRegistries(a, b) {
    const ea = (a && a.entries) || {}, eb = (b && b.entries) || {};
    const out = {};
    const ids = new Set([...Object.keys(ea), ...Object.keys(eb)]);
    for (const id of ids) {
      const x = ea[id], y = eb[id];
      const xok = x && typeof x.ts === "number";
      const yok = y && typeof y.ts === "number";
      if (xok && yok) out[id] = y.ts >= x.ts ? y : x;
      else out[id] = xok ? x : y;
    }
    return { entries: out };
  }

  // ─── 打包 / 还原 全量 ───
  async function dumpAll(opts) {
    const ls = collectLS();
    const idb = {};
    for (const n of IDB_NAMES) idb[n] = await dumpDB(n);
    // 4.78: 角色卡默认不进 main blob(改走 /sync/chars);仅本地备份导出时 includeChars 一并打包,保证 exportJSON 不丢角色卡
    if (opts && opts.includeChars) idb[CHARS_DB] = await dumpDB(CHARS_DB);
    return applyExclusionsToBlob({ version: 1, savedAt: Date.now(), localStorage: ls, indexedDB: idb });
  }
  async function restoreAll(blob, opts) {
    if (!blob || typeof blob !== "object") return false;
    // 4.78: main blob 不再携带角色卡(改走 /sync/chars)。旧版云端 main blob 可能仍含 tavern_chars_v2,
    //   还原时必须跳过,否则旧整段数据会覆盖 chars 通道的合并结果。仅本地导入(allowChars)时才还原角色卡。
    const allowChars = !!(opts && opts.allowChars);
    // 4.21 保护:先抓本地被排除实体,还原后注回 —— 防止云端(已无该实体)覆盖本地(保留本地)
    const ex = getExcluded();
    let keepRoles = [];
    const keepSlots = {};
    const keepAffLS = {}; // 4.21-E: 被排除角色的 tavern_aff_triggered_<id> LS 残留,还原后注回(保留本地)
    if (ex.roles.length) {
      try { keepRoles = await readDBItemsByIds(CHARS_DB, ex.roles); } catch {}
      for (const id of ex.roles) { const k = "tavern_aff_triggered_" + id; const v = localStorage.getItem(k); if (v !== null) keepAffLS[k] = v; }
    }
    const slotKeys = Array.from(new Set([...ex.sessions, ...ex.roles]));
    if (slotKeys.length) {
      try {
        const m = JSON.parse(localStorage.getItem("cfw_chat_session_v1") || "{}");
        for (const k of slotKeys) if (m && Object.prototype.hasOwnProperty.call(m, k)) keepSlots[k] = m[k];
      } catch {}
    }
    if (blob.localStorage) restoreLS(blob.localStorage);
    if (blob.indexedDB) {
      for (const n in blob.indexedDB) {
        if (n === CHARS_DB && !allowChars) continue; // 4.78: 跳过 main blob 里的角色卡,交给 /sync/chars 通道
        // 2026-10-06: 道具卡已删。**必须显式跳过**:旧云包里还带着 indexedDB.tavern_props_v1,
        // 不跳过的话一次「从云端还原」就会把已删的库重新建出来(数据复活)。
        if (n === "tavern_props_v1") continue;
        await restoreDB(n, blob.indexedDB[n]);
      }
    }
    if (keepRoles.length) { try { await putDBItems(CHARS_DB, keepRoles); } catch {} }
    if (Object.keys(keepSlots).length) {
      try {
        const m = JSON.parse(localStorage.getItem("cfw_chat_session_v1") || "{}");
        Object.assign(m, keepSlots);
        localStorage.setItem("cfw_chat_session_v1", JSON.stringify(m));
      } catch {}
    }
    for (const k in keepAffLS) { try { localStorage.setItem(k, keepAffLS[k]); } catch {} } // 4.21-E: 注回好感度阈值残留键
    return true;
  }

  // ─── 4.21: 排除清单用到的 IDB 工具 + push 侧过滤 ───
  // 按 id 从某 IDB 读出匹配项(含所在 store,便于原样 put 回)
  async function readDBItemsByIds(name, ids) {
    if (!ids || !ids.length) return [];
    const db = await openDB(name); if (!db) return [];
    const out = [];
    try {
      for (const sn of Array.from(db.objectStoreNames)) {
        const items = await new Promise((res) => {
          const tx = db.transaction(sn, "readonly");
          const r = tx.objectStore(sn).getAll();
          r.onsuccess = () => res(r.result || []);
          r.onerror = () => res([]);
        });
        for (const it of items) if (it && (ids.includes(it.id) || ids.includes(it.cardId))) out.push({ store: sn, item: it }); // 4.21-E: affections store 用 cardId
      }
    } finally { try { db.close(); } catch {} }
    return out;
  }
  async function putDBItems(name, entries) {
    if (!entries || !entries.length) return;
    const db = await openDB(name); if (!db) return;
    try {
      const byStore = {};
      for (const e of entries) (byStore[e.store] = byStore[e.store] || []).push(e.item);
      for (const sn in byStore) {
        if (!db.objectStoreNames.contains(sn)) continue;
        await new Promise((res) => {
          const tx = db.transaction(sn, "readwrite");
          const st = tx.objectStore(sn);
          for (const it of byStore[sn]) { try { st.put(it); } catch {} }
          tx.oncomplete = () => res();
          tx.onerror = () => res();
          tx.onabort = () => res();
        });
      }
    } finally { try { db.close(); } catch {} }
  }
  // push 侧:从打包好的 blob 剔除被排除的角色 + 会话槽(只清云端)
  function applyExclusionsToBlob(blob) {
    const ex = getExcluded();
    if (!ex.roles.length && !ex.sessions.length) return blob;
    if (ex.roles.length && blob.indexedDB && blob.indexedDB[CHARS_DB]) {
      const dbobj = blob.indexedDB[CHARS_DB];
      for (const sn in dbobj) {
        // 4.21-E: chars store keyPath "id" / affections store keyPath "cardId" → 两者都按 roleId 命中剔除(好感度记录一并清云端)
        if (Array.isArray(dbobj[sn])) dbobj[sn] = dbobj[sn].filter(it => !(it && (ex.roles.includes(it.id) || ex.roles.includes(it.cardId))));
      }
    }
    // 4.21-E: 角色的 LS 残留键(已触发阈值记录 tavern_aff_triggered_<id>)也随角色一并从云端剔除
    if (ex.roles.length && blob.localStorage) {
      for (const id of ex.roles) delete blob.localStorage["tavern_aff_triggered_" + id];
    }
    const slotKeys = Array.from(new Set([...ex.sessions, ...ex.roles]));
    if (slotKeys.length && blob.localStorage && blob.localStorage["cfw_chat_session_v1"]) {
      try {
        const m = JSON.parse(blob.localStorage["cfw_chat_session_v1"]);
        let changed = false;
        for (const k of slotKeys) if (m && Object.prototype.hasOwnProperty.call(m, k)) { delete m[k]; changed = true; }
        if (changed) blob.localStorage["cfw_chat_session_v1"] = JSON.stringify(m);
      } catch {}
    }
    return blob;
  }

  // ─── 网络 ───
  async function pullFromKV() {
    if (!token()) throw new Error("\u672a\u542f\u7528\u4e91\u540c\u6b65\uff08\u7f3a token\uff09");
    const r = await fetch("/sync", { headers: syncAuthHeaders() });
    if (r.status === 401) throw new Error("\u5bc6\u7801\u9519\u8bef");
    if (!r.ok) throw new Error("\u62c9\u53d6\u5931\u8d25: " + r.status);
    const text = await r.text();
    if (!text || text === "null") return null;
    try { return JSON.parse(text); } catch { return null; }
  }
  async function pushToKV(blob) {
    if (!token()) throw new Error("\u672a\u542f\u7528\u4e91\u540c\u6b65\uff08\u7f3a token\uff09");
    const r = await fetch("/sync", {
      method: "PUT",
      headers: syncAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(blob),
    });
    if (r.status === 401) throw new Error("\u5bc6\u7801\u9519\u8bef");
    if (!r.ok) throw new Error("\u63a8\u9001\u5931\u8d25: " + r.status);
    return r.json();
  }

  // ─── 状态 + 事件 ───
  const listeners = new Set();
  function onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function emit(status, detail) { for (const fn of listeners) { try { fn(status, detail); } catch {} } }

  // 4.17: 同步聊天历史 toggle - 默认 OFF。配置类资产(角色卡/preset/费用)总是同步,聊天单独控制
  function includeChat() { return localStorage.getItem(INCLUDE_CHAT_KEY) === "1"; }
  function setIncludeChat(on) { localStorage.setItem(INCLUDE_CHAT_KEY, on ? "1" : "0"); }
  // 4.17: 临时暂停 - markDirty 静默丢弃(已 schedule 的 timer 不取消,跑完即止)
  function isPaused() { return localStorage.getItem(PAUSE_KEY) === "1"; }
  function pause() { localStorage.setItem(PAUSE_KEY, "1"); emit("paused"); }
  function resume() { localStorage.removeItem(PAUSE_KEY); emit("resumed"); }
  // 4.17: KV 配额监控 - 当日累计到 800 次触发 warn 事件
  function incrPushCount() {
    const today = new Date().toISOString().slice(0, 10);
    const prevDay = localStorage.getItem(PUSH_COUNT_DAY_KEY);
    let n = parseInt(localStorage.getItem(PUSH_COUNT_KEY) || "0", 10);
    if (prevDay !== today) { n = 0; localStorage.setItem(PUSH_COUNT_DAY_KEY, today); }
    n += 1;
    localStorage.setItem(PUSH_COUNT_KEY, String(n));
    if (n === PUSH_DAILY_WARN) emit("warn", { reason: "kv-quota", today, count: n });
    return n;
  }

  // ─── debounce push ───
  let pushTimer = null;
  let pushing = false;
  let pendingPush = false;

  async function doPush() {
    if (pushing) { pendingPush = true; return; }
    pushing = true;
    emit("syncing");
    try {
      const blob = await dumpAll();
      const res = await pushToKV(blob);
      localStorage.setItem(LAST_PUSH_KEY, String(res.savedAt || Date.now()));
      // 拉取时间也同步推进，避免下次启动倒拽自己刚 push 的数据
      localStorage.setItem(LAST_PULL_KEY, String(res.savedAt || Date.now()));
      const pushN = incrPushCount(); // 4.17: KV 配额监控
      emit("synced", Object.assign({}, res, { pushCount: pushN }));
    } catch (e) {
      emit("error", e);
    } finally {
      pushing = false;
      if (pendingPush) { pendingPush = false; setTimeout(doPush, 1500); }
    }
  }
  function markDirty() {
    if (!syncEnabled() || !token()) return;
    if (isPaused()) return; // 4.17: 暂停中静默丢弃,不开计时器
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => { pushTimer = null; doPush(); }, 30000); // 4.17: 3s → 30s 节省 KV 配额
  }
  async function pushNow() {
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    await doPush();
  }

  // ─── 4.20: 费用独立同步通道 (/sync/cost) ───
  // 设计:cfw_cost_log_v1 独立于 main blob,任何设备发完一条消息排队 push (10s debounce,比 main 的 30s 短)
  // 合并策略:per-day per-field max (本地 vs 云端 vs 服务端 prev) - 简单稳定,设备并发也不丢
  // 服务端 /sync/cost PUT 内部再做一次 max merge,即使两台设备同秒 PUT 也不会覆盖
  const LAST_COST_PUSH_KEY = "cfw_sync_last_cost_push_v1";
  const LAST_COST_PULL_KEY = "cfw_sync_last_cost_pull_v1";
  function getLocalCostLog() {
    try {
      const raw = localStorage.getItem("cfw_cost_log_v1");
      if (!raw) return {};
      const obj = JSON.parse(raw);
      return (obj && typeof obj === "object" && !Array.isArray(obj)) ? obj : {};
    } catch { return {}; }
  }
  function setLocalCostLog(log) {
    try { localStorage.setItem("cfw_cost_log_v1", JSON.stringify(log)); } catch {}
  }
  // 4.50: 按设备分桶后,合并按 day×device 取 max,跨设备桶并集 → 总额求和不再少算
  // 归一:旧扁平 {cost,...} → {legacy:{cost,...}};新 {dev:{...}} 原样
  function normCostDay(e) {
    if (!e || typeof e !== "object" || Array.isArray(e)) return {};
    if (typeof e.cost === "number" || typeof e.requests === "number" ||
        typeof e.prompt === "number" || typeof e.completion === "number") return { legacy: e };
    return e;
  }
  function mergeCostLogs(a, b) {
    const out = {};
    const days = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const day of days) {
      const da = normCostDay(a && a[day]);
      const db = normCostDay(b && b[day]);
      const devs = new Set([...Object.keys(da), ...Object.keys(db)]);
      const m = {};
      for (const dev of devs) {
        const ea = da[dev] || {};
        const eb = db[dev] || {};
        m[dev] = {
          cost: Math.max(ea.cost || 0, eb.cost || 0),
          prompt: Math.max(ea.prompt || 0, eb.prompt || 0),
          completion: Math.max(ea.completion || 0, eb.completion || 0),
          requests: Math.max(ea.requests || 0, eb.requests || 0),
        };
      }
      out[day] = m;
    }
    return out;
  }
  async function pullCostFromKV() {
    if (!token()) throw new Error("未启用云同步(缺 token)");
    const r = await fetch("/sync/cost", { headers: syncAuthHeaders() });
    if (r.status === 401) throw new Error("密码错误");
    if (!r.ok) throw new Error("拉取费用失败: " + r.status);
    const text = await r.text();
    if (!text || text === "null") return null;
    try { return JSON.parse(text); } catch { return null; }
  }
  async function pushCostToKV(log) {
    if (!token()) throw new Error("未启用云同步(缺 token)");
    const r = await fetch("/sync/cost", {
      method: "PUT",
      headers: syncAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(log),
    });
    if (r.status === 401) throw new Error("密码错误");
    if (!r.ok) throw new Error("推送费用失败: " + r.status);
    return r.json();
  }
  async function pullCostOnStartup() {
    // 4.51: 资金同步独立于云同步总开关 - 只要有 token 就拉取合并
    if (!token()) return;
    try {
      const remote = await pullCostFromKV();
      if (!remote) return;
      const local = getLocalCostLog();
      const merged = mergeCostLogs(local, remote);
      setLocalCostLog(merged);
      localStorage.setItem(LAST_COST_PULL_KEY, String(Date.now()));
      // 通知 cost UI 刷新 (顶栏 + Settings 面板)
      try {
        if (window.__cost && window.__cost.refreshTopbar) window.__cost.refreshTopbar();
        if (window.__cost && window.__cost.refreshSettings) window.__cost.refreshSettings();
      } catch {}
      emit("cost-synced", { source: "pull" });
    } catch (e) {
      emit("cost-error", e);
    }
  }
  let costPushTimer = null;
  let costPushing = false;
  let pendingCostPush = false;
  async function doCostPush() {
    if (costPushing) { pendingCostPush = true; return; }
    costPushing = true;
    try {
      const local = getLocalCostLog();
      const res = await pushCostToKV(local);
      localStorage.setItem(LAST_COST_PUSH_KEY, String(res.savedAt || Date.now()));
      // 服务端返回 merged 全量 (含其他设备先 push 过的更高数字),本地再次 merge 落地
      if (res && res.merged && typeof res.merged === "object") {
        const merged = mergeCostLogs(local, res.merged);
        setLocalCostLog(merged);
        try {
          if (window.__cost && window.__cost.refreshTopbar) window.__cost.refreshTopbar();
          if (window.__cost && window.__cost.refreshSettings) window.__cost.refreshSettings();
        } catch {}
      }
      incrPushCount();
      emit("cost-synced", Object.assign({}, res, { source: "push" }));
    } catch (e) {
      emit("cost-error", e);
    } finally {
      costPushing = false;
      if (pendingCostPush) { pendingCostPush = false; setTimeout(doCostPush, 1500); }
    }
  }
  function markCostDirty() {
    // 4.51: 资金同步独立于云同步总开关 - 只要有 token(已登录) 就同步,不需手动开「云同步」
    if (!token()) return;
    if (isPaused()) return;
    if (costPushTimer) clearTimeout(costPushTimer);
    costPushTimer = setTimeout(() => { costPushTimer = null; doCostPush(); }, 10000);
  }
  async function pushCostNow() {
    if (costPushTimer) { clearTimeout(costPushTimer); costPushTimer = null; }
    await doCostPush();
  }

  // ─── 4.21-F: 排除清单独立同步通道 (/sync/exclude) ───
  // 让「只清云端 / 恢复同步」跨设备生效:登记表按条目 ts LWW 合并,独立于 main blob
  async function pullExcludeFromKV() {
    if (!token()) throw new Error("未启用云同步(缺 token)");
    const r = await fetch("/sync/exclude", { headers: syncAuthHeaders() });
    if (r.status === 401) throw new Error("密码错误");
    if (!r.ok) throw new Error("拉取排除清单失败: " + r.status);
    const text = await r.text();
    if (!text || text === "null") return null;
    try { return JSON.parse(text); } catch { return null; }
  }
  async function pushExcludeToKV(reg) {
    if (!token()) throw new Error("未启用云同步(缺 token)");
    const r = await fetch("/sync/exclude", {
      method: "PUT",
      headers: syncAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(reg),
    });
    if (r.status === 401) throw new Error("密码错误");
    if (!r.ok) throw new Error("推送排除清单失败: " + r.status);
    return r.json();
  }
  async function pullExcludeOnStartup() {
    if (!syncEnabled() || !token()) return;
    try {
      const remote = await pullExcludeFromKV();
      if (!remote) return;
      setRegistry(mergeRegistries(getRegistry(), remote));
      localStorage.setItem(LAST_EXCLUDE_PULL_KEY, String(Date.now()));
      emit("exclude-synced", { source: "pull" });
    } catch (e) {
      emit("exclude-error", e);
    }
  }

  // 4.21-F: 排除清单推送驱动(用户操作触发,事件稀少,直接 push 不做 debounce)
  let excludePushing = false;
  let pendingExcludePush = false;
  async function doExcludePush() {
    if (excludePushing) { pendingExcludePush = true; return; }
    excludePushing = true;
    try {
      const local = getRegistry();
      const res = await pushExcludeToKV(local);
      // 服务端返回 merged 全量(含其他设备更晚的操作),本地再合并落地
      if (res && res.merged) setRegistry(mergeRegistries(local, res.merged));
      localStorage.setItem(LAST_EXCLUDE_PUSH_KEY, String((res && res.savedAt) || Date.now()));
      incrPushCount();
      emit("exclude-synced", { source: "push" });
    } catch (e) {
      emit("exclude-error", e);
    } finally {
      excludePushing = false;
      if (pendingExcludePush) { pendingExcludePush = false; setTimeout(doExcludePush, 1500); }
    }
  }
  async function pushExcludeNow() { await doExcludePush(); }

  // ─── 4.76: 聊天会话独立同步通道 (/sync/chat) ───────────────────────────
  // 设计(与用户敲定):不同设备各自的会话 = 不同 convId → 自然并集;同一 slot 两端都改 = 真冲突 → 弹面板让用户选。
  //   • slot 级合并(非 main blob 整段 LWW):每 slot 带 updatedAt+deviceId;
  //   • 3-way 冲突检测:cfw_chat_synced_v1 记录上次同步各 slot 的 hash 作为 base;
  //       本地 hash===base → 远端改了 → 取远端(快进);远端 hash===base → 本地改了 → 取本地;两边都≠base → 真冲突;
  //   • 删除用 tombstone(cfw_chat_tomb_v1),按 deletedAt vs updatedAt 裁决生死(改得比删晚 → 复活);
  //   • 会话名 cfw_conv_meta_v1 一并同步(union);active/synced/conflicts 仅本机;
  //   • 仅 includeChat() 开时启用(默认 OFF,行为同旧版「不同步聊天」);排除清单(4.21)对会话 slot 同样生效(push 前剔除)。
  function chatDeviceId() {
    let id = localStorage.getItem(CHAT_DEVICE_ID_KEY);
    if (!id) { id = "dev_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); try { localStorage.setItem(CHAT_DEVICE_ID_KEY, id); } catch {} }
    return id;
  }
  // 稳定字符串 hash(FNV-1a 32bit 十六进制)—— slot 内容指纹比对
  function hashStr(s) {
    s = String(s == null ? "" : s);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
    return ("0000000" + h.toString(16)).slice(-8);
  }
  function readJSONObj(key, fallback) { try { const v = JSON.parse(localStorage.getItem(key) || ""); return (v && typeof v === "object") ? v : fallback; } catch { return fallback; } }
  function getChatSessions() { return readJSONObj("cfw_chat_session_v1", {}); }
  function getChatSlotMeta() { return readJSONObj(CHAT_SLOT_META_KEY, {}); }
  function getChatTomb() { return readJSONObj(CHAT_TOMB_KEY, {}); }
  function getChatSynced() { return readJSONObj(CHAT_SYNCED_KEY, {}); }
  function getConvMetaMap() { return readJSONObj(CHAT_CONV_META_KEY, {}); }

  // 打包本地 chat blob 上传(排除清单的会话 slot 不上传,保留本地)
  function buildLocalChatBlob() {
    const sessions = getChatSessions();
    const slotMeta = getChatSlotMeta();
    const tomb = getChatTomb();
    const convMeta = getConvMetaMap();
    const ex = getExcluded();
    const exSet = new Set([...(ex.sessions || []), ...(ex.roles || [])]);
    const slots = {}, msgs = {};
    const now = Date.now();
    for (const k in sessions) {
      if (exSet.has(k)) continue;
      const arr = sessions[k];
      // 4.79 Bug A: 空 slot 不上传(空数组不是删除信号,删除走 tombstone);否则会把另一端的非空会话冲掉
      if (!Array.isArray(arr) || arr.length === 0) continue;
      const meta = slotMeta[k] || {};
      slots[k] = { updatedAt: typeof meta.updatedAt === "number" ? meta.updatedAt : now, deviceId: meta.deviceId || chatDeviceId(), hash: hashStr(JSON.stringify(arr)) };
      msgs[k] = arr;
    }
    return { slots, msgs, tombstones: tomb, convMeta };
  }

  function normSlotMeta(meta, upd) {
    return { updatedAt: (typeof upd === "number" && upd >= 0) ? upd : Date.now(), deviceId: (meta && meta.deviceId) || chatDeviceId() };
  }
  // 3-way slot 级合并:返回 { sessions, slotMeta, tomb, convMeta, conflicts:[{slotKey,localMsgs,remoteMsgs,...] }
  function mergeChatSessions(remote) {
    const localSessions = getChatSessions();
    const localMeta = getChatSlotMeta();
    const localTomb = getChatTomb();
    const localConv = getConvMetaMap();
    const synced = getChatSynced();
    remote = (remote && typeof remote === "object") ? remote : {};
    const rSlots = (remote.slots && typeof remote.slots === "object") ? remote.slots : {};
    const rMsgs  = (remote.msgs && typeof remote.msgs === "object") ? remote.msgs : {};
    const rTomb  = (remote.tombstones && typeof remote.tombstones === "object") ? remote.tombstones : {};
    const rConv  = (remote.convMeta && typeof remote.convMeta === "object") ? remote.convMeta : {};

    const outTomb = {};
    for (const k of new Set([...Object.keys(localTomb), ...Object.keys(rTomb)])) {
      const la = (localTomb[k] && localTomb[k].deletedAt) || -1;
      const ra = (rTomb[k] && rTomb[k].deletedAt) || -1;
      outTomb[k] = ra >= la ? rTomb[k] : localTomb[k];
    }

    const outSessions = {}, outMeta = {};
    const conflicts = [];
    for (const k of new Set([...Object.keys(localSessions), ...Object.keys(rSlots)])) {
      const lArr = Array.isArray(localSessions[k]) ? localSessions[k] : null;
      const rArr = Array.isArray(rMsgs[k]) ? rMsgs[k] : null;
      const lMeta = localMeta[k] || {};
      const rMeta = rSlots[k] || {};
      const lUpd = typeof lMeta.updatedAt === "number" ? lMeta.updatedAt : (lArr ? 0 : -1);
      const rUpd = typeof rMeta.updatedAt === "number" ? rMeta.updatedAt : (rArr ? 0 : -1);
      const base = (synced[k] && synced[k].hash) || null;
      const lHash = lArr ? hashStr(JSON.stringify(lArr)) : null;
      const rHash = rArr ? hashStr(JSON.stringify(rArr)) : ((rMeta && rMeta.hash) || null);

      const tomb = outTomb[k];
      if (tomb && typeof tomb.deletedAt === "number" && tomb.deletedAt >= lUpd && tomb.deletedAt >= rUpd) continue;
      if (tomb && (lUpd > tomb.deletedAt || rUpd > tomb.deletedAt)) delete outTomb[k];

      // 4.79 Bug A: 空数组不是删除信号 —— 一端为空、另一端非空时,永远保留非空一方(删除只认 tombstone)
      const lEmpty = lArr && lArr.length === 0;
      const rEmpty = rArr && rArr.length === 0;
      if (lEmpty && rArr && !rEmpty) { outSessions[k] = rArr; outMeta[k] = { updatedAt: rUpd >= 0 ? rUpd : Date.now(), deviceId: rMeta.deviceId || "" }; continue; }
      if (rEmpty && lArr && !lEmpty) { outSessions[k] = lArr; outMeta[k] = normSlotMeta(lMeta, lUpd); continue; }

      if (lArr && !rArr) { outSessions[k] = lArr; outMeta[k] = normSlotMeta(lMeta, lUpd); continue; }
      if (!lArr && rArr) { outSessions[k] = rArr; outMeta[k] = { updatedAt: rUpd >= 0 ? rUpd : Date.now(), deviceId: rMeta.deviceId || "" }; continue; }
      if (!lArr && !rArr) continue;
      if (lHash === rHash) { outSessions[k] = lArr; outMeta[k] = lUpd >= rUpd ? normSlotMeta(lMeta, lUpd) : { updatedAt: rUpd, deviceId: rMeta.deviceId || "" }; continue; }
      if (base && lHash === base) {
        // 4.83 时钟护栏: updatedAt 全是各设备本地 Date.now()(服务端 LWW 也只信它)。
        // 本地自上次同步后没改时才允许整槽快进取远端,且要求远端 meta 确实更新 ——
        // 防止时钟偏差设备的陈旧推送占据云端后,在这里静默回灌覆盖本地(消息丢失)。
        if (rUpd > lUpd) { outSessions[k] = rArr; outMeta[k] = { updatedAt: rUpd >= 0 ? rUpd : Date.now(), deviceId: rMeta.deviceId || "" }; continue; }
        outSessions[k] = lArr; outMeta[k] = normSlotMeta(lMeta, lUpd); continue;
      }
      if (base && rHash === base) { outSessions[k] = lArr; outMeta[k] = normSlotMeta(lMeta, lUpd); continue; }
      conflicts.push({ slotKey: k, localMsgs: lArr, remoteMsgs: rArr, localUpdatedAt: lUpd, remoteUpdatedAt: rUpd, localCount: lArr.length, remoteCount: rArr.length });
      outSessions[k] = lArr; outMeta[k] = normSlotMeta(lMeta, lUpd);
    }

    const outConv = {};
    for (const b of new Set([...Object.keys(rConv), ...Object.keys(localConv)])) {
      outConv[b] = Object.assign({}, rConv[b] || {}, localConv[b] || {});
    }
    return { sessions: outSessions, slotMeta: outMeta, tomb: outTomb, convMeta: outConv, conflicts };
  }

  // 落地合并结果(抑制再触发 chat dirty),刷新 syncedHash 基线;有冲突存起来并 emit 让 UI 裁决
  // 稳定签名:槽键排序 + 每槽内容 hash,用于判断合并落地后本地会话是否真的发生变化(新增/更新)
  function chatSessionsSig(sessions) {
    if (!sessions || typeof sessions !== "object") return "";
    return Object.keys(sessions).sort().map(function (k) { return k + ":" + hashStr(JSON.stringify(sessions[k])); }).join("|");
  }
  function applyMergedChatToLocal(m) {
    const prevSynced = getChatSynced();
    const prevSig = chatSessionsSig(getChatSessions()); // 4.77: 落地前本地会话签名,用于判断合并是否带来其他设备的新/更新会话
    _applyingRemoteChat = true;
    try {
      localStorage.setItem("cfw_chat_session_v1", JSON.stringify(m.sessions));
      localStorage.setItem(CHAT_SLOT_META_KEY, JSON.stringify(m.slotMeta));
      localStorage.setItem(CHAT_TOMB_KEY, JSON.stringify(m.tomb));
      localStorage.setItem(CHAT_CONV_META_KEY, JSON.stringify(m.convMeta));
      const conflictKeys = new Set((m.conflicts || []).map(c => c.slotKey));
      const synced = {};
      for (const k in m.sessions) {
        if (conflictKeys.has(k)) { if (prevSynced[k]) synced[k] = prevSynced[k]; continue; }
        synced[k] = { hash: hashStr(JSON.stringify(m.sessions[k])), syncedAt: Date.now() };
      }
      localStorage.setItem(CHAT_SYNCED_KEY, JSON.stringify(synced));
      if (m.conflicts && m.conflicts.length) {
        // 4.83 冲突去重: 同一 slot 已有未决冲突时只更新记录、不重复弹窗 ——
        // 冲突槽的 base 保持陈旧(synced 不刷新),否则每次 push 响应都会再造同一冲突 → 面板反复弹。
        // 另: 旧版整包替换冲突存储,会丢掉其它 slot 的未决冲突 —— 改为按 slot 合并。
        const prev = getChatConflicts();
        const merged = prev.slice();
        let hasNew = false;
        (m.conflicts || []).forEach(c => {
          const i = merged.findIndex(p => p.slotKey === c.slotKey);
          if (i >= 0) merged[i] = c; else { merged.push(c); hasNew = true; }
        });
        localStorage.setItem(CHAT_CONFLICTS_KEY, JSON.stringify(merged));
        if (hasNew) { emit("chat-conflict", { conflicts: m.conflicts }); return; }
        // 全是已见过的冲突 → 不再弹(本地已按⑪保留),继续走下方 chat-merged 检查
      } else {
        localStorage.removeItem(CHAT_CONFLICTS_KEY);
      }
    } finally { _applyingRemoteChat = false; }
    if (m.conflicts && m.conflicts.length) { emit("chat-conflict", { conflicts: m.conflicts }); return; }
    // 4.77 修「其他设备新对话不显示、没提示也没弹窗」:旧版合并后只写 LS,从不通知 UI。
    // 无冲突但本地会话集发生变化(新增/更新会话)时发出 chat-merged,由 chat-extras 提示并提供刷新。
    if (chatSessionsSig(m.sessions) !== prevSig) emit("chat-merged", { changed: true });
  }

  async function pullChatFromKV() {
    if (!token()) throw new Error("未启用云同步(缺 token)");
    const r = await fetch("/sync/chat", { headers: syncAuthHeaders() });
    if (r.status === 401) throw new Error("密码错误");
    if (!r.ok) throw new Error("拉取聊天失败: " + r.status);
    const text = await r.text();
    if (!text || text === "null") return null;
    try { return JSON.parse(text); } catch { return null; }
  }
  async function pushChatToKV(blob) {
    if (!token()) throw new Error("未启用云同步(缺 token)");
    const r = await fetch("/sync/chat", { method: "PUT", headers: syncAuthHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(blob) });
    if (r.status === 401) throw new Error("密码错误");
    if (!r.ok) throw new Error("推送聊天失败: " + r.status);
    return r.json();
  }
  let chatPushTimer = null, chatPushing = false, pendingChatPush = false;
  async function doChatPush() {
    if (!includeChat()) return;
    if (chatPushing) { pendingChatPush = true; return; }
    chatPushing = true;
    try {
      const blob = buildLocalChatBlob();
      // 4.83 回灌护栏: 记录本次推送的各 slot 内容 hash —— 响应回来时若本地已变(飞行期间
      // 用户继续打字/切会话),跳过响应合并落地。否则"自己几秒前推的旧快照"会以远端身份
      // 和自己更新的本地跑出假冲突,一旦裁决「保留云端」+自动刷新,飞行期间的新消息永久丢失
      // (且冲突槽基线不更新 → 之后每次 push 反复弹同一冲突)。
      const pushedHashes = {};
      for (const k in blob.slots) pushedHashes[k] = blob.slots[k].hash;
      const res = await pushChatToKV(blob);
      localStorage.setItem(LAST_CHAT_PUSH_KEY, String((res && res.savedAt) || Date.now()));
      let diverged = false;
      try {
        const cur = getChatSessions();
        for (const k in pushedHashes) {
          const arr = cur[k];
          const h = Array.isArray(arr) ? hashStr(JSON.stringify(arr)) : null;
          if (h !== pushedHashes[k]) { diverged = true; break; }
        }
        if (!diverged) {
          for (const k in cur) {
            if (!(k in pushedHashes) && Array.isArray(cur[k]) && cur[k].length) { diverged = true; break; }
          }
        }
      } catch (_) {}
      if (res && res.merged && !diverged) { applyMergedChatToLocal(mergeChatSessions(res.merged)); }
      else if (res && res.merged && diverged) {
        // 分叉时不落地、不动 synced 基线 —— 本地更新,下一轮 debounce push 会带最新快照并收敛
      }
      else {
        _applyingRemoteChat = true;
        try { const synced = getChatSynced(); for (const k in blob.msgs) synced[k] = { hash: blob.slots[k].hash, syncedAt: Date.now() }; localStorage.setItem(CHAT_SYNCED_KEY, JSON.stringify(synced)); }
        finally { _applyingRemoteChat = false; }
      }
      incrPushCount();
      emit("chat-synced", { source: "push" });
    } catch (e) { emit("chat-error", e); }
    finally { chatPushing = false; if (pendingChatPush) { pendingChatPush = false; setTimeout(doChatPush, 1500); } }
  }
  function markChatDirty() {
    if (!syncEnabled() || !token() || !includeChat()) return;
    if (isPaused() || _applyingRemoteChat) return;
    if (chatPushTimer) clearTimeout(chatPushTimer);
    chatPushTimer = setTimeout(() => { chatPushTimer = null; doChatPush(); }, 30000);
  }
  async function pushChatNow() { if (chatPushTimer) { clearTimeout(chatPushTimer); chatPushTimer = null; } await doChatPush(); }
  async function pullChatOnStartup() {
    if (!syncEnabled() || !token() || !includeChat()) return;
    try {
      const remote = await pullChatFromKV();
      if (!remote) { try { await pushChatNow(); } catch (e) {} return; }
      applyMergedChatToLocal(mergeChatSessions(remote));
      localStorage.setItem(LAST_CHAT_PULL_KEY, String(Date.now()));
      emit("chat-synced", { source: "pull" });
      try { await pushChatNow(); } catch (e) {}
    } catch (e) { emit("chat-error", e); }
  }

  // 冲突裁决(chat-extras.js 面板调用):resolution = "local" | "remote" | "fork"
  function getChatConflicts() { const v = readJSONObj(CHAT_CONFLICTS_KEY, []); return Array.isArray(v) ? v : []; }
  function resolveChatConflict(slotKey, resolution) {
    const conflicts = getChatConflicts();
    const c = conflicts.find(x => x && x.slotKey === slotKey);
    if (!c) return false;
    _applyingRemoteChat = true;
    try {
      const sessions = getChatSessions();
      const meta = getChatSlotMeta();
      const now = Date.now();
      if (resolution === "remote") {
        sessions[slotKey] = c.remoteMsgs; meta[slotKey] = { updatedAt: now, deviceId: chatDeviceId() };
      } else if (resolution === "fork") {
        // 2026-09-14 会话系统重做:槽位键已改为平铺 convId(不再有 "角色卡#" 前缀),故不再切 "#" 取 base。
        // 分叉出的会话也必须是合法的平铺 id(以 c_ 开头)——否则 app.js 的 isConvId 认不出、左栏列表里看不到。
        const fid = "c_" + now.toString(36) + "_" + Math.random().toString(36).slice(2, 6);
        const forkKey = fid;
        sessions[slotKey] = c.localMsgs;
        sessions[forkKey] = c.remoteMsgs;
        meta[slotKey] = { updatedAt: now, deviceId: chatDeviceId() };
        meta[forkKey] = { updatedAt: now, deviceId: chatDeviceId() };
        const cm = getConvMetaMap();
        cm[forkKey] = { name: "云端版本 " + new Date(now).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }), createdAt: now };
        localStorage.setItem(CHAT_CONV_META_KEY, JSON.stringify(cm));
      } else {
        sessions[slotKey] = c.localMsgs; meta[slotKey] = { updatedAt: now, deviceId: chatDeviceId() };
      }
      localStorage.setItem("cfw_chat_session_v1", JSON.stringify(sessions));
      localStorage.setItem(CHAT_SLOT_META_KEY, JSON.stringify(meta));
      const synced = getChatSynced();
      synced[slotKey] = { hash: hashStr(JSON.stringify(sessions[slotKey])), syncedAt: now };
      localStorage.setItem(CHAT_SYNCED_KEY, JSON.stringify(synced));
      const rest = conflicts.filter(x => x && x.slotKey !== slotKey);
      if (rest.length) localStorage.setItem(CHAT_CONFLICTS_KEY, JSON.stringify(rest));
      else localStorage.removeItem(CHAT_CONFLICTS_KEY);
    } finally { _applyingRemoteChat = false; }
    pushChatNow().catch(() => {});
    emit("chat-conflict-resolved", { slotKey, resolution });
    return true;
  }

  // ─── 4.78: 角色卡独立同步通道 (/sync/chars) ───────────────────────────
  // 设计(同 4.76 chat 思路): 角色卡(IndexedDB tavern_chars_v2: chars + affections)不再随 main blob 整段 LWW,
  //   改按卡 id 独立合并 —— 不同设备各自新建的卡 = 不同 id → 自然并集;同一卡两端都改 = 按 meta.updatedAt 取较新;
  //   删除用 tombstone(cfw_chars_tomb_v1),按 deletedAt vs updatedAt 裁决生死(改得比删晚 → 复活)。
  //   好感度(affections store)按 cardId 的 updatedAt 取较新。受 syncEnabled() 总开关门控(与旧 main blob 行为一致,不受 includeChat 影响)。
  function getCharsMeta() { return readJSONObj(CHARS_META_KEY, {}); }
  function getCharsTomb() { return readJSONObj(CHARS_TOMB_KEY, {}); }
  // character.js 在每次存卡后调用(写 meta 触发 markCharsDirty);删卡调用 tombChar
  function bumpCharMeta(id) {
    if (!id) return;
    const m = getCharsMeta();
    m[id] = { updatedAt: Date.now(), deviceId: chatDeviceId() };
    const t = getCharsTomb();
    if (t[id]) { delete t[id]; localStorage.setItem(CHARS_TOMB_KEY, JSON.stringify(t)); }
    localStorage.setItem(CHARS_META_KEY, JSON.stringify(m)); // setItem → markCharsDirty
  }
  function tombChar(id) {
    if (!id) return;
    const t = getCharsTomb();
    t[id] = { deletedAt: Date.now(), deviceId: chatDeviceId() };
    const m = getCharsMeta();
    if (m[id]) { delete m[id]; localStorage.setItem(CHARS_META_KEY, JSON.stringify(m)); }
    localStorage.setItem(CHARS_TOMB_KEY, JSON.stringify(t)); // setItem → markCharsDirty
  }
  // 读本地角色卡 IDB(chars + affections 两个 store)
  async function readLocalChars() {
    const d = await dumpDB(CHARS_DB);
    return { chars: (d && Array.isArray(d.chars)) ? d.chars : [], affections: (d && Array.isArray(d.affections)) ? d.affections : [] };
  }
  // 落地合并后的角色卡到 IDB(整库 clear + put,在 _applyingRemoteChars 抑制回环下进行)
  async function writeCharsToIDB(cards, affs) {
    const db = await openDB(CHARS_DB);
    if (!db) return;
    try {
      if (db.objectStoreNames.contains("chars")) {
        await new Promise((res) => {
          const tx = db.transaction("chars", "readwrite");
          const st = tx.objectStore("chars");
          st.clear();
          for (const c of cards) { try { st.put(c); } catch {} }
          tx.oncomplete = () => res(); tx.onerror = () => res(); tx.onabort = () => res();
        });
      }
      if (db.objectStoreNames.contains("affections")) {
        await new Promise((res) => {
          const tx = db.transaction("affections", "readwrite");
          const st = tx.objectStore("affections");
          st.clear();
          for (const a of affs) { try { st.put(a); } catch {} }
          tx.oncomplete = () => res(); tx.onerror = () => res(); tx.onabort = () => res();
        });
      }
    } finally { try { db.close(); } catch {} }
  }
  // 打包本地角色卡 blob 上传(排除清单的角色不上传,保留本地)
  async function buildLocalCharsBlob() {
    const { chars, affections } = await readLocalChars();
    const meta = getCharsMeta();
    const tomb = getCharsTomb();
    const ex = getExcluded();
    const exSet = new Set(ex.roles || []);
    const now = Date.now();
    const outCards = {}, outMeta = {}, outAff = {};
    for (const c of chars) {
      if (!c || !c.id || exSet.has(c.id)) continue;
      const m = meta[c.id] || {};
      outCards[c.id] = c;
      outMeta[c.id] = { updatedAt: typeof m.updatedAt === "number" ? m.updatedAt : now, deviceId: m.deviceId || chatDeviceId(), hash: hashStr(JSON.stringify(c)) };
    }
    for (const a of affections) {
      if (!a || !a.cardId || exSet.has(a.cardId)) continue;
      outAff[a.cardId] = { value: a.value, updatedAt: typeof a.updatedAt === "number" ? a.updatedAt : now };
    }
    return { cards: outCards, meta: outMeta, affections: outAff, tombstones: tomb };
  }
  // 按卡 id LWW 合并(本地 IDB vs 远端);tombstone 按 deletedAt 裁决生死。排除清单角色强制保留本地、忽略远端删除。
  async function mergeChars(remote) {
    const { chars: localChars, affections: localAffs } = await readLocalChars();
    const localMeta = getCharsMeta();
    const localTomb = getCharsTomb();
    const ex = getExcluded();
    const exSet = new Set(ex.roles || []);
    remote = (remote && typeof remote === "object") ? remote : {};
    const rCards = (remote.cards && typeof remote.cards === "object") ? remote.cards : {};
    const rMeta = (remote.meta && typeof remote.meta === "object") ? remote.meta : {};
    const rAff = (remote.affections && typeof remote.affections === "object") ? remote.affections : {};
    const rTomb = (remote.tombstones && typeof remote.tombstones === "object") ? remote.tombstones : {};
    const localCardMap = {}; for (const c of localChars) if (c && c.id) localCardMap[c.id] = c;
    const localAffMap = {}; for (const a of localAffs) if (a && a.cardId) localAffMap[a.cardId] = a;
    const outTomb = {};
    for (const k of new Set([...Object.keys(localTomb), ...Object.keys(rTomb)])) {
      const la = (localTomb[k] && localTomb[k].deletedAt) || -1;
      const ra = (rTomb[k] && rTomb[k].deletedAt) || -1;
      outTomb[k] = ra >= la ? rTomb[k] : localTomb[k];
    }
    const outCards = {}, outMeta = {};
    for (const k of new Set([...Object.keys(localCardMap), ...Object.keys(rCards)])) {
      const lCard = localCardMap[k] || null;
      const rCard = rCards[k] || null;
      const lUpd = (localMeta[k] && typeof localMeta[k].updatedAt === "number") ? localMeta[k].updatedAt : (lCard ? 0 : -1);
      const rUpd = (rMeta[k] && typeof rMeta[k].updatedAt === "number") ? rMeta[k].updatedAt : (rCard ? 0 : -1);
      if (exSet.has(k)) { if (lCard) { outCards[k] = lCard; outMeta[k] = { updatedAt: Math.max(lUpd, 0), deviceId: (localMeta[k] && localMeta[k].deviceId) || chatDeviceId() }; } continue; }
      const tomb = outTomb[k];
      if (tomb && typeof tomb.deletedAt === "number" && tomb.deletedAt >= lUpd && tomb.deletedAt >= rUpd) continue;
      if (tomb && (lUpd > tomb.deletedAt || rUpd > tomb.deletedAt)) delete outTomb[k];
      if (lCard && !rCard) { outCards[k] = lCard; outMeta[k] = { updatedAt: lUpd >= 0 ? lUpd : Date.now(), deviceId: (localMeta[k] && localMeta[k].deviceId) || chatDeviceId() }; continue; }
      if (!lCard && rCard) { outCards[k] = rCard; outMeta[k] = { updatedAt: rUpd >= 0 ? rUpd : Date.now(), deviceId: (rMeta[k] && rMeta[k].deviceId) || "" }; continue; }
      if (!lCard && !rCard) continue;
      if (rUpd > lUpd) { outCards[k] = rCard; outMeta[k] = { updatedAt: rUpd, deviceId: (rMeta[k] && rMeta[k].deviceId) || "" }; }
      else { outCards[k] = lCard; outMeta[k] = { updatedAt: lUpd >= 0 ? lUpd : Date.now(), deviceId: (localMeta[k] && localMeta[k].deviceId) || chatDeviceId() }; }
    }
    const outAff = {};
    for (const k of new Set([...Object.keys(localAffMap), ...Object.keys(rAff)])) {
      if (!outCards[k]) continue;
      const la = localAffMap[k] ? { value: localAffMap[k].value, updatedAt: localAffMap[k].updatedAt || 0 } : null;
      const ra = rAff[k] ? { value: rAff[k].value, updatedAt: rAff[k].updatedAt || 0 } : null;
      if (la && ra) outAff[k] = (ra.updatedAt >= la.updatedAt ? ra : la);
      else outAff[k] = la || ra;
    }
    return { cards: outCards, meta: outMeta, affections: outAff, tomb: outTomb };
  }
  async function applyMergedCharsToLocal(m) {
    _applyingRemoteChars = true;
    try {
      const cardsArr = Object.keys(m.cards).map((id) => m.cards[id]);
      const affsArr = Object.keys(m.affections).map((id) => ({ cardId: id, value: m.affections[id].value, updatedAt: m.affections[id].updatedAt }));
      await writeCharsToIDB(cardsArr, affsArr);
      localStorage.setItem(CHARS_META_KEY, JSON.stringify(m.meta));
      localStorage.setItem(CHARS_TOMB_KEY, JSON.stringify(m.tomb));
    } finally { _applyingRemoteChars = false; }
    try { if (window.__character && typeof window.__character.reload === "function") await window.__character.reload(); } catch {}
  }
  async function pullCharsFromKV() {
    if (!token()) throw new Error("未启用云同步(缺 token)");
    const r = await fetch("/sync/chars", { headers: syncAuthHeaders() });
    if (r.status === 401) throw new Error("密码错误");
    if (!r.ok) throw new Error("拉取角色卡失败: " + r.status);
    const text = await r.text();
    if (!text || text === "null") return null;
    try { return JSON.parse(text); } catch { return null; }
  }
  async function pushCharsToKV(blob) {
    if (!token()) throw new Error("未启用云同步(缺 token)");
    const r = await fetch("/sync/chars", { method: "PUT", headers: syncAuthHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(blob) });
    if (r.status === 401) throw new Error("密码错误");
    if (!r.ok) throw new Error("推送角色卡失败: " + r.status);
    return r.json();
  }
  let charsPushTimer = null, charsPushing = false, pendingCharsPush = false;
  async function doCharsPush() {
    if (charsPushing) { pendingCharsPush = true; return; }
    charsPushing = true;
    try {
      const blob = await buildLocalCharsBlob();
      const res = await pushCharsToKV(blob);
      localStorage.setItem(LAST_CHARS_PUSH_KEY, String((res && res.savedAt) || Date.now()));
      if (res && res.merged) { await applyMergedCharsToLocal(await mergeChars(res.merged)); }
      incrPushCount();
      emit("chars-synced", { source: "push" });
    } catch (e) { emit("chars-error", e); }
    finally { charsPushing = false; if (pendingCharsPush) { pendingCharsPush = false; setTimeout(doCharsPush, 1500); } }
  }
  function markCharsDirty() {
    if (!syncEnabled() || !token()) return;
    if (isPaused() || _applyingRemoteChars) return;
    if (charsPushTimer) clearTimeout(charsPushTimer);
    charsPushTimer = setTimeout(() => { charsPushTimer = null; doCharsPush(); }, 30000);
  }
  async function pushCharsNow() { if (charsPushTimer) { clearTimeout(charsPushTimer); charsPushTimer = null; } await doCharsPush(); }
  async function pullCharsOnStartup() {
    if (!syncEnabled() || !token()) return;
    try {
      const remote = await pullCharsFromKV();
      if (!remote) { try { await pushCharsNow(); } catch (e) {} return; }
      await applyMergedCharsToLocal(await mergeChars(remote));
      localStorage.setItem(LAST_CHARS_PULL_KEY, String(Date.now()));
      emit("chars-synced", { source: "pull" });
      try { await pushCharsNow(); } catch (e) {}
    } catch (e) { emit("chars-error", e); }
  }

  // ─── 4.21 P2: 删云端 (全局清空) ───
  // 全局清空 = DELETE 两个 KV key (main blob + cost)。本地数据保留。
  // 注意: 同步仍开启时,下次本地任何改动会经 markDirty 把本地重新 push 回云端;
  // 想让云端保持空,清空后请关闭云同步。
  async function deleteMainFromKV() {
    if (!token()) throw new Error("未启用云同步(缺 token)");
    const r = await fetch("/sync", { method: "DELETE", headers: syncAuthHeaders() });
    if (r.status === 401) throw new Error("密码错误");
    if (!r.ok) throw new Error("删除失败: " + r.status);
    return r.json().catch(() => ({}));
  }
  async function deleteCostFromKV() {
    if (!token()) throw new Error("未启用云同步(缺 token)");
    const r = await fetch("/sync/cost", { method: "DELETE", headers: syncAuthHeaders() });
    if (r.status === 401) throw new Error("密码错误");
    if (!r.ok) throw new Error("删除费用失败: " + r.status);
    return r.json().catch(() => ({}));
  }
  // 4.79 Bug B: 聊天/角色卡/排除清单各自独立 KV key,wipeCloud 必须一并 DELETE,
  //   否则"清空云端"只删了 main+cost,/sync/chat 等通道下次启动仍把旧聊天拉回 → 表现为"清过云端还是返回之前的已同步"
  async function deleteChatFromKV() {
    if (!token()) throw new Error("未启用云同步(缺 token)");
    const r = await fetch("/sync/chat", { method: "DELETE", headers: syncAuthHeaders() });
    if (r.status === 401) throw new Error("密码错误");
    if (!r.ok) throw new Error("删除聊天失败: " + r.status);
    return r.json().catch(() => ({}));
  }
  async function deleteCharsFromKV() {
    if (!token()) throw new Error("未启用云同步(缺 token)");
    const r = await fetch("/sync/chars", { method: "DELETE", headers: syncAuthHeaders() });
    if (r.status === 401) throw new Error("密码错误");
    if (!r.ok) throw new Error("删除角色卡失败: " + r.status);
    return r.json().catch(() => ({}));
  }
  async function deleteExcludeFromKV() {
    if (!token()) throw new Error("未启用云同步(缺 token)");
    const r = await fetch("/sync/exclude", { method: "DELETE", headers: syncAuthHeaders() });
    if (r.status === 401) throw new Error("密码错误");
    if (!r.ok) throw new Error("删除排除清单失败: " + r.status);
    return r.json().catch(() => ({}));
  }
  async function wipeCloud() {
    if (!syncEnabled() || !token()) throw new Error("未启用云同步");
    // 取消任何 pending push,避免删完又被自动推回(4.79: 含 chat/chars 通道)
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    if (costPushTimer) { clearTimeout(costPushTimer); costPushTimer = null; }
    if (chatPushTimer) { clearTimeout(chatPushTimer); chatPushTimer = null; }
    if (charsPushTimer) { clearTimeout(charsPushTimer); charsPushTimer = null; }
    emit("syncing");
    const main = await deleteMainFromKV();
    // 4.79 Bug B: cost/chat/chars/exclude 都是独立 KV key,逐一删除(单个失败不阻断其余)
    let cost = null, chat = null, chars = null, exclude = null;
    try { cost = await deleteCostFromKV(); } catch (e) {}
    try { chat = await deleteChatFromKV(); } catch (e) {}
    try { chars = await deleteCharsFromKV(); } catch (e) {}
    try { exclude = await deleteExcludeFromKV(); } catch (e) {}
    // 清掉本地同步时间戳:空云端 pull 返回 null 本就不会 restore,这里稳妥重置(4.79: 含 chat/chars/exclude)
    localStorage.removeItem(LAST_PUSH_KEY);
    localStorage.removeItem(LAST_PULL_KEY);
    localStorage.removeItem(LAST_COST_PUSH_KEY);
    localStorage.removeItem(LAST_COST_PULL_KEY);
    localStorage.removeItem(LAST_CHAT_PUSH_KEY);
    localStorage.removeItem(LAST_CHAT_PULL_KEY);
    localStorage.removeItem(LAST_CHARS_PUSH_KEY);
    localStorage.removeItem(LAST_CHARS_PULL_KEY);
    localStorage.removeItem(LAST_EXCLUDE_PUSH_KEY);
    localStorage.removeItem(LAST_EXCLUDE_PULL_KEY);
    emit("wiped", { main, cost, chat, chars, exclude });
    return { main, cost, chat, chars, exclude };
  }

  // ─── 4.21: 按角色/会话 只清云端、保留本地 ───
  // 清云端 = 加排除 + pushNow(PUT 整包,该实体已被 applyExclusionsToBlob 剔除 → 云端抹掉)
  // 恢复同步 = 移除排除 + pushNow(本地副本重新进 blob → 云端回填)
  async function wipeCloudEntity(kind, key) {
    if (!syncEnabled() || !token()) throw new Error("未启用云同步");
    addExclusion(kind, key);
    await pushExcludeNow(); // 4.21-F: 先把排除登记推上云(跨设备生效)
    await pushNow();        // 再推 main blob(该实体已被剔除 → 云端抹掉)
    emit("entity-wiped", { kind, key });
    return { kind, key };
  }
  async function restoreCloudEntity(kind, key) {
    if (!syncEnabled() || !token()) throw new Error("未启用云同步");
    removeExclusion(kind, key);
    await pushExcludeNow(); // 4.21-F: 恢复登记推上云(跨设备生效)
    await pushNow();        // 本地副本重新进 blob → 云端回填
    emit("entity-restored", { kind, key });
    return { kind, key };
  }

  // ─── 启动时拉取 ───
  async function pullOnStartup() {
    if (!syncEnabled() || !token()) return;
    emit("syncing");
    try {
      const remote = await pullFromKV();
      if (!remote) {
        // KV 为空（首次启用）→ 把本地作为初始现有数据推上去
        emit("synced", { firstPush: true });
        await pushNow();
        return;
      }
      const lastPull = parseInt(localStorage.getItem(LAST_PULL_KEY) || "0", 10);
      const remoteAt = remote.savedAt || 0;
      if (remoteAt > lastPull) {
        await restoreAll(remote);
        localStorage.setItem(LAST_PULL_KEY, String(remoteAt));
        emit("restored", { savedAt: remoteAt });
        // 让 app.js 重新初始化：刷新页面最可靠
        setTimeout(() => location.reload(), 600);
      } else {
        emit("synced");
      }
    } catch (e) {
      emit("error", e);
    }
  }

  // ─── 本地文件备份 ───
  async function exportJSON() {
    const blob = await dumpAll({ includeChars: true }); // 4.78: 本地备份含角色卡
    const text = JSON.stringify(blob, null, 2);
    const file = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = "tavern-backup-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function importJSON(file) {
    return new Promise((res, rej) => {
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const blob = JSON.parse(reader.result);
          await restoreAll(blob, { allowChars: true }); // 4.78: 本地导入恢复角色卡
          res(blob);
        } catch (e) { rej(e); }
      };
      reader.onerror = () => rej(reader.error);
      reader.readAsText(file);
    });
  }

  // ─── 暴露 ───
  window.__sync = {
    markDirty, pushNow, pullFromKV, pullOnStartup,
    // 4.20: 费用独立同步通道 (app.js addCostToToday 调 markCostDirty)
    markCostDirty, pushCostNow, pullCostOnStartup,
    // 4.21 P2 / 4.79 Bug B: 全局清空云端 (删全部 KV key: main+cost+chat+chars+exclude)
    wipeCloud, deleteMainFromKV, deleteCostFromKV, deleteChatFromKV, deleteCharsFromKV, deleteExcludeFromKV,
    // 4.21: 按角色/会话 只清云端、保留本地 (排除清单 tombstone)
    wipeCloudEntity, restoreCloudEntity, getExcluded, addExclusion, removeExclusion,
    // 4.21-F: 排除清单跨设备同步通道
    pullExcludeOnStartup, pushExcludeNow, getRegistry,
    // 4.76: 聊天会话独立同步通道(slot 级合并 + 3-way 冲突裁决 + tombstone)
    markChatDirty, pushChatNow, pullChatOnStartup, mergeChatSessions, getChatConflicts, resolveChatConflict,
    // 4.78: 角色卡独立同步通道(按卡 id LWW 合并 + tombstone);character.js 存/删卡后调 bumpCharMeta/tombChar
    markCharsDirty, pushCharsNow, pullCharsOnStartup, bumpCharMeta, tombChar,
    exportJSON, importJSON,
    syncEnabled, setSyncEnabled,
    includeChat, setIncludeChat, // 4.17: 同步聊天历史 toggle
    isPaused, pause, resume,     // 4.17: 暂停/恢复
    dumpAll, restoreAll,
    onStatus,
    getStatus: () => ({
      enabled: syncEnabled(),
      hasToken: !!token(),
      paused: isPaused(),
      includeChat: includeChat(),
      lastPush: parseInt(localStorage.getItem(LAST_PUSH_KEY) || "0", 10),
      lastPull: parseInt(localStorage.getItem(LAST_PULL_KEY) || "0", 10),
      pushCount: parseInt(localStorage.getItem(PUSH_COUNT_KEY) || "0", 10),
      pushCountDay: localStorage.getItem(PUSH_COUNT_DAY_KEY) || "",
    }),
  };

  // 启动自动拉 (4.21-F 先拉排除清单 → 再 main blob + 4.20 独立 cost log)
  // 4.51: 资金独立于云同步总开关 - 只要有 token 就拉取;排除清单/主数据仍受总开关控制
  if (token()) {
    (async () => {
      if (syncEnabled()) {
        await pullExcludeOnStartup(); // 4.21-F: 先合并跨设备排除登记,确保 main pull/push 正确过滤与保护
        pullOnStartup();
        pullChatOnStartup(); // 4.76: 聊天会话独立通道 slot 级合并(仅 includeChat 开时)
        pullCharsOnStartup(); // 4.78: 角色卡独立通道 按卡 id LWW 合并
      }
      pullCostOnStartup().then(() => { try { pushCostNow(); } catch (e) {} }); // 4.52: 拉取合并后再把本机费用桶推上云,让其他设备下次能拉到本机费用(修"费用只显示在本机")
    })();
  }

  // 多 tab 互同：另一个 tab 改了 LS 也触发 push
  window.addEventListener("storage", (e) => {
    if (!e.key || PROTECTED.includes(e.key)) return;
    markDirty();
  });

  // 同 tab 内 LS 改动 monkey-patch（storage 事件只跨 tab 触发，本 tab 改自身收不到）
  // 这样角色卡/指令模块/历史/费用 任何 setItem 都会自动触发同步，无需改其他文件
  const realSetItem = Storage.prototype.setItem;
  const realRemoveItem = Storage.prototype.removeItem;
  Storage.prototype.setItem = function (k, v) {
    realSetItem.call(this, k, v);
    if (this === localStorage) {
      // 4.76/4.78: 聊天 key 走 /sync/chat、角色卡 meta/tomb 走 /sync/chars(除非正在落地远端合并);其余走 main blob
      if (CHAT_DIRTY_KEYS.indexOf(k) >= 0) { if (!_applyingRemoteChat) markChatDirty(); }
      else if (CHARS_DIRTY_KEYS.indexOf(k) >= 0) { if (!_applyingRemoteChars) markCharsDirty(); }
      else if (!PROTECTED.includes(k)) markDirty();
    }
  };
  Storage.prototype.removeItem = function (k) {
    realRemoveItem.call(this, k);
    if (this === localStorage) {
      if (CHAT_DIRTY_KEYS.indexOf(k) >= 0) { if (!_applyingRemoteChat) markChatDirty(); }
      else if (CHARS_DIRTY_KEYS.indexOf(k) >= 0) { if (!_applyingRemoteChars) markCharsDirty(); }
      else if (!PROTECTED.includes(k)) markDirty();
    }
  };
})();