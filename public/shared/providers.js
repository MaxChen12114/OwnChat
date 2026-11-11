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
  // 2026-11-11(A): 模型清单保质期。上游免费档隔三差五上新,而清单原本被写进本地存储后
  // 就永久冻死(fetchedAt 只写不读)—— 这就是"build.nvidia.com 上新好多,我这儿下拉还是那几个"
  // 的直接原因。3 天:够新,又不会每次开页面都打上游。
  const MODELS_TTL_MS = 3 * 24 * 60 * 60 * 1000;
  // 默认勾选策略版本。升到 2 时,把"推荐家族"(服务端 /api/models 带 recommended:true)补勾一次。
  // 只加不减:不会把你手动取消的模型勾回来(推荐家族除外 —— 它们是开箱默认,必须看得见)。
  const DEFAULTS_V = 2;
  // 服务端注册表拉不到时的兜底（老 Worker / 离线）—— id 与 worker PRESET_PROVIDERS 对齐
  const PRESET_FALLBACK = [
    { id: "deepseek", label: "deepseek-official", title: "DeepSeek 官方", endpoint: "https://api.deepseek.com/v1/chat/completions", keyEnv: "DEEPSEEK_API_KEY", configured: null, supportsThinking: true, thinkingStyle: "deepseek", defaultModel: "deepseek-flash" },
    { id: "nvidia", label: "nvidia-nim", title: "NVIDIA 免费档", endpoint: "https://integrate.api.nvidia.com/v1/chat/completions", keyEnv: "NVIDIA_API_KEY", configured: null, supportsThinking: true, thinkingStyle: "vllm", defaultModel: "deepseek-ai/deepseek-v4.1-flash" },
  ];

  function nowMs() { return Date.now(); }
  function blank() { return { v: 3, activeId: null, custom: [], presets: {}, presetsMeta: {}, updatedAt: 0 }; }
  function normModelList(list) {
    return (Array.isArray(list) ? list : []).map(function (m) {
      if (!m) return null;
      var id = typeof m === "string" ? m : String(m.id || "");
      id = id.trim();
      if (!id) return null;
      var out = { id: id, label: String((m && m.label) || id) };
      // recommended: 服务端算好的"默认勾选家族"(免费档 = DeepSeek/Nemotron)。
      // 前端只认这个布尔,不自己再维护一份厂商规则 —— 两边各抄一份必然漂移。
      if (m && typeof m === "object" && m.recommended) out.recommended = true;
      return out;
    }).filter(Boolean);
  }
  function normalizeCustom(p) {
    if (!p || typeof p !== "object") return null;
    var id = String(p.id || "").trim();
    if (!id) return null;
    // 2026-11-11: 思考能力从布尔升级为「形态」—— none / vllm（只有开/关）/ deepseek（低中高三档）。
    // 旧数据 supportsThinking=true 且无 thinkingStyle → 仍按 deepseek 形态，行为不变。
    var _thinkStyle = p.supportsThinking
      ? (p.thinkingStyle === "vllm" ? "vllm" : "deepseek")
      : "none";
    return {
      id: id,
      name: String(p.name || "未命名服务商"),
      endpoint: String(p.endpoint || "").trim(),
      apiKey: typeof p.apiKey === "string" ? p.apiKey : "",
      model: String(p.model || "").trim(),
      supportsThinking: _thinkStyle !== "none",
      thinkingStyle: _thinkStyle,
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
    return { id: pid, label: pid, title: pid, keyEnv: "", configured: null, supportsThinking: true, thinkingStyle: "deepseek", defaultModel: "" };
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
  // 2026-11-10: 访客 = 没有本地访问码。访客只能用自定义渠道；预设（免费/快速）属于站主 Key，直接关闭。
  function guest() {
    try { return !!(window.__auth && window.__auth.getToken && !window.__auth.getToken()); } catch (e) { return false; }
  }
  // 活跃键：显式选择优先；未选择 → 跟随 mode（免费/快速 pill）
  function effectiveKey(mode) {
    var st = read();
    if (guest()) {
      return (st.activeId && String(st.activeId).indexOf("custom:") === 0) ? st.activeId : null;
    }
    if (st.activeId) return st.activeId;
    return presetKey(presetIdForMode(mode));
  }
  function activePresetId() {
    if (guest()) return null;
    var k = parseKey(read().activeId);
    return (k && k.kind === "preset") ? k.id : null;
  }
  function modeForActive() {
    if (guest()) return null;
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
    var out = { id: p.id, name: p.name, endpoint: p.endpoint, model: p.model, supportsThinking: !!p.supportsThinking, thinkingStyle: p.thinkingStyle || "deepseek", needsReasoningHistory: !!p.needsReasoningHistory, models: Array.isArray(p.models) ? p.models : [] };
    if (typeof p.apiKey === "string" && p.apiKey) out.apiKey = p.apiKey;
    return out;
  }

  // ── 渠道列表（UI 左栏）──
  function channels() {
    var st = read();
    var out = [];
    if (!guest()) {
      var pids = Object.keys(st.presetsMeta || {});
      PRESET_FALLBACK.forEach(function (f) { if (pids.indexOf(f.id) < 0) pids.push(f.id); });
      pids.forEach(function (pid) {
        var m = presetMeta(pid);
        out.push({ key: presetKey(pid), kind: "preset", id: pid, name: m.title || m.label || pid, sub: m.label || "", detail: m, models: (st.presets[pid] || {}).models || [] });
      });
    }
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
    return normModelList(cs.models).map(function (m) {
      var out = { id: m.id, label: m.label, enabled: !dis[m.id] };
      if (m.recommended) out.recommended = true; // UI「恢复推荐」要用
      return out;
    });
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
  // 批量勾选（2026-11-11 C）：勾选面板的「全选 / 清空 / 恢复推荐」共用这一个入口。
  // 一次性写盘 + 只发一次事件 —— 逐条 toggleModel 会把列表重渲染 N 次（50 个模型卡成幻灯片）。
  // enabled=true 时，onlyRecommended 表示"只勾推荐家族，其余取消"（= 恢复推荐默认）。
  function setAllModels(key, enabled, opts) {
    var st = read();
    var cs = channelState(st, key);
    if (!cs) return 0;
    if (!cs.disabled || typeof cs.disabled !== "object") cs.disabled = {};
    var onlyRec = !!(opts && opts.onlyRecommended);
    var all = normModelList(cs.models), n = 0;
    all.forEach(function (m) {
      if (onlyRec && !m.recommended) { cs.disabled[m.id] = 1; return; }
      if (enabled) delete cs.disabled[m.id]; else cs.disabled[m.id] = 1;
      n++;
    });
    // 预设渠道的"当前模型"记在 LS_MODEL，不在这里改；自定义渠道同理只在 toggleModel 里换。
    write(st);
    return n;
  }
  // 存量迁移（2026-10-13 E1b 合并旧「候选池」卡）：预设渠道第一次拉到清单时，
  // 若本机旧池（cfw_models_free_v1 / fast_v1）有勾选，就把这些模型补勾上 —— 用户当年的选择不丢。
  // 2026-11-11 修复：旧版这里是「先把 disabled 清空，再把旧池之外的全部关掉」，
  // 结果老用户升级后下拉只剩旧池那几个 —— 正是"上游上新了、我这儿只有几个"的元凶之一。
  // 现在改成**只加不减**：只补勾旧池里存在且当前清单也有的模型，绝不批量关别人的勾。
  function migrateLegacyPool(cs, pid) {
    var mode = modeForPreset(pid);
    if (!mode) return;
    var leg = [];
    try { leg = JSON.parse(localStorage.getItem("cfw_models_" + mode + "_v1") || "[]") || []; } catch (e) {}
    if (!Array.isArray(leg) || !leg.length) return;
    if (!cs.disabled || typeof cs.disabled !== "object") cs.disabled = {};
    // 旧池如果几乎就是全量清单（≥80%），说明它是当年"自动拉取"留下的全量快照，不是人工挑选。
    // 这种情况不迁移 —— 否则访客态自动拉过一次的用户，一登录就被全勾 50 个，正好违背默认策略。
    if (leg.length >= (cs.models || []).length * 0.8) return;
    var have = {};
    (cs.models || []).forEach(function (m) { have[m.id] = 1; });
    leg.forEach(function (m) {
      var id = String((m && m.id) || m || "").trim();
      if (id && have[id]) delete cs.disabled[id]; // 只补勾
    });
  }
  // 新面孔的默认勾选：服务端标了 recommended 的勾上，其余不勾。
  // 但**整个渠道都没有推荐标记**时（如 DeepSeek 官方只有 2 个模型、或老 Worker 不下发标记），
  // 不做任何关停 —— 没策略就等于全放行，免得升级后下拉突然被清空。
  function seedDefaultSelection(cs, fresh) {
    if (!fresh.length) return;
    var hasRec = (cs.models || []).some(function (m) { return m.recommended; });
    if (!hasRec) return;
    fresh.forEach(function (m) {
      if (m.recommended) delete cs.disabled[m.id];
      else cs.disabled[m.id] = 1;
    });
  }
  // 保存拉取到的模型清单（保留已有开关；新模型按推荐策略默认勾选；旧池只补不删）
  function setChannelModels(key, models) {
    var st = read();
    var cs = channelState(st, key);
    if (!cs) return;
    var norm = normModelList(models);
    if (!norm.length) return; // 空清单不覆盖既有（上游抽风一次不该把用户勾选清空）
    var k = parseKey(key);
    if (k.kind === "preset") {
      if (!cs.disabled || typeof cs.disabled !== "object") cs.disabled = {};
      var prev = {};
      (cs.models || []).forEach(function (m) { prev[m.id] = 1; });
      cs.models = norm;
      cs.fetchedAt = nowMs();
      cs.recEra = 1; // 这份清单来自"会下发 recommended 标记"的服务端（旧清单没有这个标记）
      // ① 新面孔：推荐家族勾上，其余不勾；老模型保持用户既有开关不动
      seedDefaultSelection(cs, norm.filter(function (m) { return !prev[m.id]; }));
      // ② 旧候选池：只补勾，不关人
      if (!cs.legacyMigrated) { migrateLegacyPool(cs, k.id); cs.legacyMigrated = true; }
      // ③ 默认策略升级（幂等）：老用户至少把推荐家族补勾回来 —— 修"只剩旧池几个"的死局
      if ((cs.defaultsV || 1) < DEFAULTS_V) {
        norm.forEach(function (m) { if (m.recommended) delete cs.disabled[m.id]; });
        cs.defaultsV = DEFAULTS_V;
      }
      // ④ 清掉上游已下线模型的残留下标，避免 disabled 无限膨胀
      var alive = {};
      norm.forEach(function (m) { alive[m.id] = 1; });
      Object.keys(cs.disabled).forEach(function (id) { if (!alive[id]) delete cs.disabled[id]; });
    } else {
      cs.models = norm;
    }
    write(st);
  }
  // 清单是否过期（预设渠道才自动重拉；自定义渠道的端点/计费在用户手里，不替他打）
  function modelsStale(key) {
    var st = read();
    var cs = channelState(st, key);
    if (!cs) return false;
    var k = parseKey(key);
    if (!k || k.kind !== "preset") return false;
    if (!cs.models || !cs.models.length) return true;
    // 旧版清单（没有 recEra）不含 recommended 标记 → 视为过期，重拉一次拿到推荐信息。
    // 重拉后 recEra=1，之后只按时间判断，不会再无谓地打上游。
    if (!cs.recEra) return true;
    return (nowMs() - (cs.fetchedAt || 0)) > MODELS_TTL_MS;
  }
  function selectedModel(key) {
    var st = read();
    var cs = channelState(st, key);
    if (!cs) return "";
    if (String(key).indexOf("custom:") === 0) return cs.model || "";
    try { return localStorage.getItem(LS_MODEL) || ""; } catch (e) { return ""; }
  }

  // ── 拉取模型（预设走 /api/models?provider=；自定义走 /api/custom-endpoint/models 代理）──
  // 2026-11-11: 预设渠道做"同一时刻只打一次上游"的去重 —— 启动静默刷新与设置页首屏
  // 会在同一秒内各触发一次，不去重就是白打两次上游（免费档限流本来就紧）。
  var _fetching = {};
  function fetchModels(key, opts) {
    var k0 = String(key || "");
    var kk0 = parseKey(k0);
    if (!kk0 || kk0.kind !== "preset") return fetchModelsInner(key, opts);
    if (_fetching[k0]) return _fetching[k0];
    var p = fetchModelsInner(key, opts).then(
      function (v) { delete _fetching[k0]; return v; },
      function (e) { delete _fetching[k0]; throw e; }
    );
    _fetching[k0] = p;
    return p;
  }
  async function fetchModelsInner(key, opts) {
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
    // 切到「没有清单 / 清单过期 / 清单来自旧版（没带推荐标记）」的预设渠道 → 顺手拉一次
    try {
      var kk = parseKey(next);
      if (kk && kk.kind === "preset" && modelsStale(next)) { fetchModels(next); }
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

  // 启动静默刷新（每页一次，2026-11-11 A）：把已缓存的预设渠道清单按 TTL 对账一次。
  // 为什么必须有这一步：清单只靠「点拉取」更新的话，上游上新永远等不到人手去点。
  // 只遍历"本地已有清单"的渠道 —— 从没拉过的渠道不在这里打上游（那是用户主动动作）。
  var _staleRefreshed = false;
  function refreshStalePresetsOnce() {
    if (_staleRefreshed) return;
    _staleRefreshed = true;
    try {
      var st = read();
      Object.keys(st.presets || {}).forEach(function (pid) {
        var key = presetKey(pid);
        if (modelsStale(key)) fetchModels(key); // 失败静默：拿不到就继续用旧清单
      });
    } catch (e) {}
  }

  window.__providers = {
    // 状态
    read: read, save: write, mergePublic: mergePublic,
    // 元数据
    refreshPresets: refreshPresets, presetMeta: presetMeta, channels: channels,
    // 活跃
    effectiveKey: effectiveKey, activePresetId: activePresetId, modeForActive: modeForActive,
    parseKey: parseKey,
    byoSnapshot: byoSnapshot, setActive: setActive,
    // 模型清单
    modelsAll: modelsAll, enabledModels: enabledModels, toggleModel: toggleModel, setAllModels: setAllModels,
    setChannelModels: setChannelModels, selectedModel: selectedModel, setSelectedModel: setSelectedModel,
    fetchModels: fetchModels, modelsStale: modelsStale,
    // 自定义 CRUD
    newCustom: newCustom, saveCustom: saveCustom, deleteCustom: deleteCustom,
    // 事件
    on: on,
    keys: { K3: K3, K3PUB: K3PUB, PRESET_TO_MODE: PRESET_TO_MODE, MODE_TO_PRESET: MODE_TO_PRESET },
  };

  // 启动时：合并云端公开副本 + 旧池对账 + 拉一次服务端注册表 + 过期清单静默刷新（都失败也不阻塞）
  try { mergePublic(); } catch (e) {}
  try { reconcileLegacyOnce(); } catch (e) {}
  setTimeout(function () { refreshPresets(); }, 0);
  // 延后 1.2s：让首屏渲染先完成，别跟聊天列表抢网络
  setTimeout(function () { try { refreshStalePresetsOnce(); } catch (e) {} }, 1200);
})();
