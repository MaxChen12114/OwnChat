// public/shared/providers.js — 前端渠道注册表（批 E1b：不写死 DeepSeek/NVIDIA）
// ═══════════════════════════════════════════════════════════════════════
// window.__providers：统一「预设渠道(服务端注册表) + 自定义渠道(本机 LS)」的
// 读写 / 活跃选择 / 模型清单(含每模型启用开关) / 拉取模型。
//
// 存储：cfw_providers_v3（含 apiKey，本机私密，永不同步）
//       cfw_providers_public_v3（剥掉 apiKey 的公开副本，进云同步白名单）
// 迁移：cfw_byo_providers_v2(→ custom 数组 + activeId) → v1 单槽 → 空。v2/v1 原键保留不动，可回滚。
//
// 语义修正（相对 v2，重要）：自定义渠道**只在显式激活时**接管聊天。
//   v2 的 get() 只要列表里有任何服务商就回第一个 → 之前那次"BYO 占位符残留在列表里劫持全部请求"
//   的 403 事故即源于此。v3: activeId=null 时一律跟随免费/快速预设(mode)，自定义需点选才算数。
//
// 活跃渠道 activeId 取值：
//   null                  → 跟随顶栏免费/快速 pill（兼容旧行为；迁移默认值）
//   "preset:<pid>"        → 固定走某个预设（deepseek / nvidia，服务端 env key）
//   "custom:<id>"         → 固定走某个自定义直连（本机 endpoint/apiKey）
(() => {
  if (window.__providers) return;

  const K3 = "cfw_providers_v3";
  const K3PUB = "cfw_providers_public_v3";
  const K2 = "cfw_byo_providers_v2";
  const K1 = "cfw_byo_provider_v1";
  const K1PUB = "cfw_byo_provider_public_v1";
  const LS_MODEL = "cfw_model";

  const MODE_TO_PRESET = { fast: "deepseek", free: "nvidia" };
  const PRESET_TO_MODE = { deepseek: "fast", nvidia: "free" };
  // 服务端注册表拉不到时的兜底（老 Worker / 离线）—— id 与 worker PRESET_PROVIDERS 对齐
  const PRESET_FALLBACK = [
    { id: "deepseek", label: "deepseek-official", title: "DeepSeek 官方", endpoint: "https://api.deepseek.com/v1/chat/completions", keyEnv: "DEEPSEEK_API_KEY", configured: null, supportsThinking: true, defaultModel: "deepseek-flash" },
    { id: "nvidia", label: "nvidia-nim", title: "NVIDIA 免费档", endpoint: "https://integrate.api.nvidia.com/v1/chat/completions", keyEnv: "NVIDIA_API_KEY", configured: null, supportsThinking: true, defaultModel: "deepseek-ai/deepseek-v4.1-flash" },
  ];

  function nowMs() { return Date.now(); }
  function blank() { return { v: 3, activeId: null, custom: [], presets: {}, presetsMeta: {}, updatedAt: 0 }; }
  function normModelList(list) {
    return (Array.isArray(list) ? list : []).map(function (m) {
      if (!m) return null;
      var id = typeof m === "string" ? m : String(m.id || "");
      id = id.trim();
      if (!id) return null;
      return { id: id, label: String((m && m.label) || id) };
    }).filter(Boolean);
  }
  function normalizeCustom(p) {
    if (!p || typeof p !== "object") return null;
    var id = String(p.id || "").trim();
    if (!id) return null;
    return {
      id: id,
      name: String(p.name || "未命名服务商"),
      endpoint: String(p.endpoint || "").trim(),
      apiKey: typeof p.apiKey === "string" ? p.apiKey : "",
      model: String(p.model || "").trim(),
      supportsThinking: !!p.supportsThinking,
      needsReasoningHistory: !!p.needsReasoningHistory,
      models: normModelList(p.models),
      disabled: (p.disabled && typeof p.disabled === "object") ? p.disabled : {},
    };
  }

  // ── 读取 + 迁移（幂等）──
  function readRaw() {
    try {
      var o = JSON.parse(localStorage.getItem(K3) || "null");
      if (o && o.v === 3 && Array.isArray(o.custom)) return o;
    } catch (e) {}
    return null;
  }
  function migrate() {
    var st = blank();
    try {
      var v2 = JSON.parse(localStorage.getItem(K2) || "null");
      if (v2 && Array.isArray(v2.providers) && v2.providers.length) {
        st.custom = v2.providers.map(normalizeCustom).filter(Boolean);
        // 只在 v2 明确记过 activeId 时才把自定义设为活跃；否则跟随预设（防"列表里有就劫持"旧病）
        if (v2.activeId) st.activeId = "custom:" + v2.activeId;
        st.updatedAt = nowMs();
        return st;
      }
      // v1 单槽：用户当年主动填过 endpoint+model 才算配置过，迁移为活跃自定义
      var priv = JSON.parse(localStorage.getItem(K1) || "{}") || {};
      var pub = JSON.parse(localStorage.getItem(K1PUB) || "{}") || {};
      var o1 = Object.assign({}, pub, priv);
      if (priv && typeof priv.apiKey === "string") o1.apiKey = priv.apiKey;
      if (o1 && o1.endpoint && o1.model) {
        var p1 = normalizeCustom({
          id: "p_" + nowMs().toString(36), name: "自定义直连（迁移）",
          endpoint: o1.endpoint, apiKey: o1.apiKey || "", model: o1.model,
          supportsThinking: !!o1.supportsThinking, needsReasoningHistory: !!o1.needsReasoningHistory,
          models: Array.isArray(o1.models) ? o1.models : [],
        });
        if (p1) { st.custom = [p1]; st.activeId = "custom:" + p1.id; }
      }
    } catch (e) {}
    st.updatedAt = nowMs();
    return st;
  }
  function read() {
    var st = readRaw();
    if (!st) { st = migrate(); write(st); }
    return st;
  }
  function publicCopy(st) {
    return {
      v: 3, activeId: st.activeId, presetsMeta: st.presetsMeta || {},
      presets: st.presets || [],
      custom: (st.custom || []).map(function (p) { var c = JSON.parse(JSON.stringify(p)); delete c.apiKey; return c; }),
      updatedAt: st.updatedAt || 0,
    };
  }
  function write(st) {
    st.updatedAt = nowMs();
    try { localStorage.setItem(K3, JSON.stringify(st)); } catch (e) {}
    try { localStorage.setItem(K3PUB, JSON.stringify(publicCopy(st))); } catch (e) {}
    emit("save");
  }
  // 云端公开副本 → 本机合并（保留本机 apiKey；按 id 对齐，新增/覆盖非敏感字段）
  function mergePublic() {
    try {
      var pub = JSON.parse(localStorage.getItem(K3PUB) || "null");
      if (!pub || pub.v !== 3) return;
      var st = read();
      if ((pub.updatedAt || 0) > (st.updatedAt || 0)) {
        st.activeId = pub.activeId || null;
        st.presetsMeta = pub.presetsMeta || st.presetsMeta;
        st.presets = pub.presets || st.presets;
        var byId = {};
        (st.custom || []).forEach(function (p) { byId[p.id] = p; });
        st.custom = (pub.custom || []).map(function (pc) {
          var local = byId[pc.id];
          var merged = normalizeCustom(pc);
          if (merged && local && local.apiKey) merged.apiKey = local.apiKey; // Key 只认本机
          return merged;
        }).filter(Boolean);
        write(st);
        emit("external");
      }
    } catch (e) {}
  }

  // ── 事件 ──
  const subs = [];
  function on(cb) { if (typeof cb === "function") subs.push(cb); }
  function emit(reason) {
    var detail = { reason: reason || "" };
    for (var i = 0; i < subs.length; i++) { try { subs[i](detail); } catch (e) {} }
    try { window.dispatchEvent(new CustomEvent("cfw:providers-changed", { detail: detail })); } catch (e) {}
  }
  try {
    window.addEventListener("storage", function (e) {
      if (!e || e.key === K3PUB || e.key === K3) { if (e && e.key === K3PUB) mergePublic(); else emit("external"); }
    });
  } catch (e) {}

  // ── 预设元数据（GET /api/providers，失败用内置兜底）──
  function presetMeta(pid) {
    var st = read();
    var m = (st.presetsMeta || {})[pid];
    if (m && m.id) return m;
    for (var i = 0; i < PRESET_FALLBACK.length; i++) if (PRESET_FALLBACK[i].id === pid) return PRESET_FALLBACK[i];
    return { id: pid, label: pid, title: pid, keyEnv: "", configured: null, defaultModel: "" };
  }
  function authHeaders(extra) {
    var h = Object.assign({}, extra || {});
    try { var tk = window.__auth && window.__auth.getToken && window.__auth.getToken(); if (tk && !h.Authorization) h.Authorization = "Bearer " + tk; } catch (e) {}
    return h;
  }
  async function refreshPresets() {
    try {
      var r = await fetch("/api/providers", { headers: authHeaders() });
      var d = await r.json().catch(function () { return null; });
      if (d && d.ok && Array.isArray(d.presets) && d.presets.length) {
        var st = read(), meta = {};
        d.presets.forEach(function (p) { if (p && p.id) meta[p.id] = p; });
        st.presetsMeta = meta;
        write(st);
        return true;
      }
    } catch (e) {}
    return false;
  }

  // ── 渠道键 ──
  function presetKey(pid) { return "preset:" + String(pid || "").trim(); }
  function customKey(id) { return "custom:" + String(id || "").trim(); }
  function parseKey(key) {
    var s = String(key || "");
    if (s.indexOf("preset:") === 0) return { kind: "preset", id: s.slice(7) };
    if (s.indexOf("custom:") === 0) return { kind: "custom", id: s.slice(7) };
    return null;
  }
  function presetIdForMode(mode) { return MODE_TO_PRESET[mode === "fast" ? "fast" : "free"]; }
  function modeForPreset(pid) { return PRESET_TO_MODE[pid] || null; }
  function getCustom(st, id) { for (var i = 0; i < st.custom.length; i++) if (st.custom[i].id === id) return st.custom[i]; return null; }
  // 活跃键：显式选择优先；未选择 → 跟随 mode（免费/快速 pill）
  function effectiveKey(mode) {
    var st = read();
    if (st.activeId) return st.activeId;
    return presetKey(presetIdForMode(mode));
  }
  function activePresetId() {
    var k = parseKey(read().activeId);
    return (k && k.kind === "preset") ? k.id : null;
  }
  function modeForActive() {
    var k = parseKey(read().activeId);
    return (k && k.kind === "preset") ? modeForPreset(k.id) : null;
  }
  // 旧契约：返回活跃自定义渠道快照；预设活跃/未选择时返回 null（app.js 回落内置路径）
  function byoSnapshot() {
    var st = read();
    var k = parseKey(st.activeId);
    if (!k || k.kind !== "custom") return null;
    var p = getCustom(st, k.id);
    if (!p || !p.endpoint || !p.model) return null;
    var out = { id: p.id, name: p.name, endpoint: p.endpoint, model: p.model, supportsThinking: !!p.supportsThinking, needsReasoningHistory: !!p.needsReasoningHistory, models: Array.isArray(p.models) ? p.models : [] };
    if (typeof p.apiKey === "string" && p.apiKey) out.apiKey = p.apiKey;
    return out;
  }

  // ── 渠道列表（UI 左栏）──
  function channels() {
    var st = read();
    var out = [];
    var pids = Object.keys(st.presetsMeta || {});
    PRESET_FALLBACK.forEach(function (f) { if (pids.indexOf(f.id) < 0) pids.push(f.id); });
    pids.forEach(function (pid) {
      var m = presetMeta(pid);
      out.push({ key: presetKey(pid), kind: "preset", id: pid, name: m.title || m.label || pid, sub: m.label || "", detail: m, models: (st.presets[pid] || {}).models || [] });
    });
    (st.custom || []).forEach(function (p) {
      out.push({ key: customKey(p.id), kind: "custom", id: p.id, name: p.name || p.id, sub: p.endpoint || "未填端点", detail: p, models: p.models || [] });
    });
    return out;
  }

  // ── 模型清单 / 每模型开关 ──
  function channelState(st, key) {
    var k = parseKey(key);
    if (!k) return null;
    if (k.kind === "preset") {
      if (!st.presets[k.id]) st.presets[k.id] = { models: [], disabled: {}, fetchedAt: 0 };
      var ps = st.presets[k.id];
      if (!ps.disabled || typeof ps.disabled !== "object") ps.disabled = {};
      return ps;
    }
    return getCustom(st, k.id); // custom 的 models/disabled 挂在 provider 对象上
  }
  function modelsAll(key) {
    var st = read();
    var cs = channelState(st, key);
    if (!cs) return [];
    var dis = (cs.disabled && typeof cs.disabled === "object") ? cs.disabled : {};
    return normModelList(cs.models).map(function (m) { return { id: m.id, label: m.label, enabled: !dis[m.id] }; });
  }
  function enabledModels(key) {
    return modelsAll(key).filter(function (m) { return m.enabled; });
  }
  function toggleModel(key, modelId, enabled) {
    var st = read();
    var cs = channelState(st, key);
    if (!cs || !modelId) return;
    if (!cs.disabled || typeof cs.disabled !== "object") cs.disabled = {};
    if (enabled) delete cs.disabled[modelId];
    else cs.disabled[modelId] = 1;
    // 自定义渠道：禁用掉的恰是当前选中模型 → 换到第一个启用模型
    if (enabled === false && cs.model === modelId) {
      var next = enabledModels(key)[0];
      cs.model = next ? next.id : "";
    }
    write(st);
  }
  function setSelectedModel(key, modelId) {
    var st = read();
    var cs = channelState(st, key);
    if (!cs) return;
    cs.model = String(modelId || "").trim();
    write(st);
  }
  // 存量迁移（2026-10-13 E1b 合并旧「候选池」卡）：预设渠道第一次拉到清单时，
  // 若本机旧池（cfw_models_free_v1 / fast_v1）有勾选，按它对齐启用开关 —— 用户当年的选择不丢。
  // 只迁一次（legacyMigrated 标记），之后用户怎么勾都以 v3 为准。
  function migrateLegacyPool(cs, pid) {
    var mode = modeForPreset(pid);
    if (!mode) return;
    var leg = [];
    try { leg = JSON.parse(localStorage.getItem("cfw_models_" + mode + "_v1") || "[]") || []; } catch (e) {}
    if (!Array.isArray(leg) || !leg.length) return;
    var on = {};
    leg.forEach(function (m) { var id = (m && m.id) || m; if (id) on[String(id)] = 1; });
    cs.disabled = {};
    (cs.models || []).forEach(function (m) { if (!on[m.id]) cs.disabled[m.id] = 1; });
  }
  // 保存拉取到的模型清单（保留已有开关；新模型默认启用；预设首拉时迁移旧池选择）
  function setChannelModels(key, models) {
    var st = read();
    var cs = channelState(st, key);
    if (!cs) return;
    cs.models = normModelList(models);
    var k = parseKey(key);
    if (k.kind === "preset") {
      cs.fetchedAt = nowMs();
      if (!cs.legacyMigrated) { migrateLegacyPool(cs, k.id); cs.legacyMigrated = true; }
    }
    write(st);
  }
  function selectedModel(key) {
    var st = read();
    var cs = channelState(st, key);
    if (!cs) return "";
    if (String(key).indexOf("custom:") === 0) return cs.model || "";
    try { return localStorage.getItem(LS_MODEL) || ""; } catch (e) { return ""; }
  }

  // ── 拉取模型（预设走 /api/models?provider=；自定义走 /api/custom-endpoint/models 代理）──
  async function fetchModels(key, opts) {
    var st = read();
    var k = parseKey(key);
    if (!k) return { ok: false, error: "未知渠道" };
    try {
      if (k.kind === "preset") {
        var r = await fetch("/api/models?provider=" + encodeURIComponent(k.id), { headers: authHeaders() });
        var d = await r.json().catch(function () { return null; });
        if ((!d || !d.ok) && r.status === 404) return { ok: false, error: "服务端未升级（/api/models 无 provider 参数）" };
        var models = normModelList(d && d.models);
        if (d && d.ok && models.length) { setChannelModels(key, models); return { ok: true, count: models.length, title: d.sourceTitle || "" }; }
        return { ok: false, error: (d && d.error) || ("HTTP " + r.status) };
      }
      var cs = channelState(st, k.id);
      var endpoint = (opts && opts.endpoint) || (cs && cs.endpoint) || "";
      var apiKey = (opts && opts.apiKey != null) ? opts.apiKey : ((cs && cs.apiKey) || "");
      if (!endpoint) return { ok: false, error: "先填 Endpoint" };
      var r2 = await fetch("/api/custom-endpoint/models", {
        method: "POST", headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ endpoint: endpoint, apiKey: apiKey }),
      });
      var d2 = await r2.json().catch(function () { return null; });
      var models2 = normModelList(d2 && d2.models);
      if (d2 && d2.ok && models2.length) { setChannelModels(key, models2); return { ok: true, count: models2.length }; }
      return { ok: false, error: (d2 && d2.error) || ("HTTP " + r2.status) };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  // ── 自定义渠道 CRUD ──
  function newCustom(patch) {
    var st = read();
    var p = normalizeCustom(Object.assign({ id: "p_" + nowMs().toString(36) + "_" + Math.random().toString(36).slice(2, 6), name: "新服务商" }, patch || {}));
    st.custom.push(p);
    write(st);
    return p.id;
  }
  function saveCustom(id, fields) {
    var st = read();
    var p = getCustom(st, id);
    if (!p) return false;
    Object.assign(p, normalizeCustom(Object.assign({}, p, fields || {}, { id: p.id })));
    write(st);
    return true;
  }
  function deleteCustom(id) {
    var st = read();
    st.custom = st.custom.filter(function (p) { return p.id !== id; });
    if (st.activeId === customKey(id)) st.activeId = null;
    write(st);
  }

  // ── 活跃切换 ──
  function setActive(key) {
    var st = read();
    var next = key || null;
    // 校验存在性（防止指向已删渠道的悬挂 activeId）
    if (next) {
      var k = parseKey(next);
      if (!k) next = null;
      else if (k.kind === "custom" && !getCustom(st, k.id)) next = null;
    }
    if (st.activeId === next) return; // 无变化不触发事件（防重入循环）
    st.activeId = next;
    write(st);
    // 切到没有模型缓存的预设渠道 → 顺手拉一次（异步；拉完 emit 触达 UI）
    try {
      var kk = parseKey(next);
      if (kk && kk.kind === "preset" && !modelsAll(next).length) { fetchModels(next); }
    } catch (e) {}
  }

  // 启动对账（每页一次）：v3 里已有模型清单但还没对齐过旧池选择 → 补一次迁移。
  // （用户可能在上一个版本里已经拉过清单——迁移若只挂在"拉取"动作上就永远不会触发。）
  var _legacyReconciled = false;
  function reconcileLegacyOnce() {
    if (_legacyReconciled) return;
    _legacyReconciled = true;
    try {
      var st = read(), changed = false;
      Object.keys(st.presets || {}).forEach(function (pid) {
        var cs = st.presets[pid];
        if (cs && cs.models && cs.models.length && !cs.legacyMigrated) {
          migrateLegacyPool(cs, pid);
          cs.legacyMigrated = true;
          changed = true;
        }
      });
      if (changed) write(st);
    } catch (e) {}
  }

  window.__providers = {
    // 状态
    read: read, save: write, mergePublic: mergePublic,
    // 元数据
    refreshPresets: refreshPresets, presetMeta: presetMeta, channels: channels,
    // 活跃
    effectiveKey: effectiveKey, activePresetId: activePresetId, modeForActive: modeForActive,
    byoSnapshot: byoSnapshot, setActive: setActive,
    // 模型清单
    modelsAll: modelsAll, enabledModels: enabledModels, toggleModel: toggleModel,
    setChannelModels: setChannelModels, selectedModel: selectedModel, setSelectedModel: setSelectedModel,
    fetchModels: fetchModels,
    // 自定义 CRUD
    newCustom: newCustom, saveCustom: saveCustom, deleteCustom: deleteCustom,
    // 事件
    on: on,
    keys: { K3: K3, K3PUB: K3PUB, PRESET_TO_MODE: PRESET_TO_MODE, MODE_TO_PRESET: MODE_TO_PRESET },
  };

  // 启动时：合并云端公开副本 + 旧池对账 + 拉一次服务端注册表（都失败也不阻塞）
  try { mergePublic(); } catch (e) {}
  try { reconcileLegacyOnce(); } catch (e) {}
  setTimeout(function () { refreshPresets(); }, 0);
})();
