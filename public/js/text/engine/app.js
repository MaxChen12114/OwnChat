// public/js/text/engine/app.js — 聊天主引擎（气泡渲染 / SSE 解析 / 计费 / 会话分槽 / 群聊接力 / Agent 模式）
(() => {
  const historyWrap = document.getElementById("history");
  const chatEl = document.getElementById("chat");
  const inputEl = document.getElementById("msg");
  const composerEl = document.getElementById("composer");
  const spacerEl = document.getElementById("bottom-spacer");
  const modelSel = document.getElementById("modelSel");
  const personaToggle = document.getElementById("personaToggle");
  const modeToggle = document.getElementById("modeToggle");       // 新增：免费/快速切换
  const settingsBtn = document.getElementById("settingsBtn");
  const sendBtn = document.getElementById("sendBtn");
  // 2026-06-08 修复:发送键本是 index.html 的小飞机 SVG,但下方 __resetSending 旧代码用 textContent="Send" 复位会把 SVG 抹成英文字。启动时捕获原始图标 HTML,复位时还原 SVG。
  const SEND_BTN_ICON_HTML = sendBtn ? sendBtn.innerHTML : "";
  // 2026-11-11: Agent 运行中、输入框为空时，发送键的图标换成「停止」（线性方块），
  // 底色/描边沿用当前主题的发送键，不另起一套颜色。
  const STOP_BTN_ICON_HTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>';
  const settingsMask = document.getElementById("settingsMask");
  const customPromptEl = document.getElementById("customPrompt");
  const savePromptBtn = document.getElementById("savePrompt");
  const clearPromptBtn = document.getElementById("clearPrompt");
  const historyKeepEl = document.getElementById("historyKeep");
  const clearHistoryBtn = document.getElementById("clearHistory");
  const promptKeepEl = document.getElementById("promptKeep");
  const costDisplayEl = document.getElementById("costDisplay");   // 新增：费用显示

  // ── 顶栏图标集中表(2026-06-07 UI 重构:emoji→线性 SVG,currentColor 随主题;换图标只改这一处) ──
  const ICONS = {
    modeFree: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6"/></svg>',
    modeFast: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 3 14h9l-1 8 10-12h-9z"/></svg>',
    personaBuiltin: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4.5h16v6.5a8 8 0 0 1-16 0z"/><path d="M9 8.5v.01M15 8.5v.01"/><path d="M9.2 12.6c.9.8 4.7.8 5.6 0"/></svg>',
    personaCustom: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20l4-1 9.6-9.6a2 2 0 0 0-2.8-2.8L5.4 16z"/><path d="M13.5 6.3l4.2 4.2"/></svg>',
  };
  // setIcon(el, 图标名, 可选文字标签):带 label 时附 .btn-text(供 CSS 在手机端隐藏、只留图标)
  function setIcon(el, name, label) {
    if (!el) return;
    const svg = ICONS[name] || "";
    el.innerHTML = label ? svg + '<span class="btn-text">' + label + '</span>' : svg;
  }

  // ─── 模型列表（来自 /config.js 动态注入）───
  // 模型列表完全由 worker /config.js 注入；兜底为空数组，避免过时模型干扰
  const MODELS_FREE = window.APP_MODELS_FREE || [];
  const MODELS_FAST = window.APP_MODELS_FAST || [];
  const MODEL_PLACEHOLDERS = { "__free_placeholder__": 1, "__fast_placeholder__": 1 };
  function isPlaceholderModel(id) {
    return !!MODEL_PLACEHOLDERS[String(id || "").trim()];
  }
  function modelPoolKey(mode) {
    return mode === "fast" ? "cfw_models_fast_v1" : "cfw_models_free_v1";
  }
  function normalizeModelList(list) {
    return (Array.isArray(list) ? list : []).map(function (m) {
      return (typeof m === "string") ? { id: m, label: (m.indexOf("/") >= 0 ? m.split("/").pop() : m) } : m;
    }).filter(function (m) { return m && m.id && !isPlaceholderModel(m.id); });
  }
  function getRuntimeModels(mode) {
    // 2026-10-13 (E1c): 激活渠道优先 —— 注册表里「已启用模型」> 旧模式池；
    // 渠道拉到过清单但全被禁 → 只留渠道默认模型（不再回落旧池，尊重"全禁"意图）。
    try {
      if (window.__providers) {
        const key = window.__providers.effectiveKey(mode);
        const all = key ? window.__providers.modelsAll(key) : [];
        if (all.length) {
          const enabled = all.filter((m) => m.enabled);
          if (enabled.length) return normalizeModelList(enabled);
          const meta = (String(key).indexOf("preset:") === 0 && window.__providers.presetMeta)
            ? window.__providers.presetMeta(String(key).slice(7)) : null;
          const dm = meta && meta.defaultModel;
          return dm ? [{ id: dm, label: dm }] : [];
        }
      }
    } catch (e) {}
    const base = normalizeModelList(mode === "fast" ? (window.APP_MODELS_FAST || MODELS_FAST) : (window.APP_MODELS_FREE || MODELS_FREE));
    try {
      const saved = normalizeModelList(JSON.parse(localStorage.getItem(modelPoolKey(mode)) || "[]"));
      if (saved.length) return saved;
    } catch (e) {}
    return base;
  }
  function runtimeDefaultModel(mode, models) {
    // 2026-10-13 (E1c): 渠道默认模型优先（注册表 defaultModel —— 如 NIM 的 deepseek-v4.1-flash），
    // 其次 /config.js 配置，最后列表第一。
    try {
      if (window.__providers) {
        const key = window.__providers.effectiveKey(mode);
        if (key && String(key).indexOf("preset:") === 0 && window.__providers.presetMeta) {
          const dm = window.__providers.presetMeta(String(key).slice(7)).defaultModel;
          if (dm && (models || []).some((m) => m.id === dm)) return dm;
        }
      }
    } catch (e) {}
    const configured = mode === "fast" ? window.APP_DEFAULT_MODEL_FAST : window.APP_DEFAULT_MODEL_FREE;
    if (configured && !isPlaceholderModel(configured) && (models || []).some(function (m) { return m.id === configured; })) return configured;
    return (models && models[0] && models[0].id) || "";
  }
  async function autoFetchModelsForMode(mode) {
    // 2026-10-13 (E1c): 优先按渠道拉（每模型开关在 v3 注册表里）；失败/注册表缺席 → 回落旧 mode 口径
    try {
      if (window.__providers) {
        const key = window.__providers.effectiveKey(mode);
        if (key) {
          const res = await window.__providers.fetchModels(key);
          if (res && res.ok) { if (mode === currentMode) initModels(); return true; }
        }
      }
    } catch (e) {}
    try {
      const headers = {};
      try { const tk = window.__auth && window.__auth.getToken && window.__auth.getToken(); if (tk) headers.Authorization = "Bearer " + tk; } catch (e) {}
      const r = await fetch("/api/models?mode=" + encodeURIComponent(mode), { headers: headers });
      const d = await r.json().catch(function () { return null; });
      const models = normalizeModelList(d && d.models);
      if (!r.ok || !models.length) return false;
      localStorage.setItem(modelPoolKey(mode), JSON.stringify(models));
      const cur = localStorage.getItem(LS_MODEL);
      if (!cur || isPlaceholderModel(cur) || !models.some(function (m) { return m.id === cur; })) {
        localStorage.setItem(LS_MODEL, models[0].id);
      }
      if (mode === currentMode) initModels();
      return true;
    } catch (e) { return false; }
  }
  function ensureUsableModelBeforeSend(mode, model, customProvider) {
    try {
      if (window.__auth && window.__auth.getToken && !window.__auth.getToken()) {
        if (customProvider && customProvider.endpoint && customProvider.model) return true;
        alert("访客模式：请先在 设置 → 模型 API 新增自己的渠道并填写 Key。");
        return false;
      }
    } catch (e) {}
    if (customProvider && customProvider.endpoint && customProvider.model) return true;
    if (model && !isPlaceholderModel(model)) return true;
    setTimeout(function () { autoFetchModelsForMode(mode); }, 0);
    alert("当前还是模型占位符。已尝试自动拉取模型列表；如果下拉仍为空，请到「设置 → 模型 API → 渠道管理」拉取并勾选模型，或配置「自定义直连」。");
    return false;
  }
  // 2026-09-12 / 4.70: provider-aware 计价。
  // 旧版只按 model id 命中价格，同名模型在 DeepSeek 官方 / OpenRouter / 硅基流动 / 自建中转上会混算。
  // 新版按「站点 + 模型」优先匹配：byo:endpoint:model → provider:model → model；自定义定价优先于内置表。
  // 单位仍为 ¥ / 百万 token。cfw_custom_pricing_v1 已进云同步白名单，且不含 API Key。
  const LS_CUSTOM_PRICING = "cfw_custom_pricing_v1";
  function getCustomPricing() {
    try { var o = JSON.parse(localStorage.getItem(LS_CUSTOM_PRICING) || "{}"); return (o && typeof o === "object" && !Array.isArray(o)) ? o : {}; } catch { return {}; }
  }
  function canonicalEndpoint(endpoint) {
    try {
      const u = new URL(String(endpoint || "").trim());
      u.hash = ""; u.search = "";
      u.pathname = u.pathname.replace(/\/chat\/completions\/?$/, "").replace(/\/models\/?$/, "").replace(/\/+$/, "");
      if (!u.pathname) u.pathname = "/v1";
      return u.origin + u.pathname;
    } catch (e) { return ""; }
  }
  function pricingKeysFor(ctxOrModel) {
    const ctx = (ctxOrModel && typeof ctxOrModel === "object") ? ctxOrModel : { model: ctxOrModel };
    const model = String(ctx.model || "").trim();
    const provider = String(ctx.provider || ctx.mode || "").trim();
    const endpoint = canonicalEndpoint(ctx.endpoint || "");
    const keys = [];
    if (!model) return keys;
    if (endpoint) keys.push("byo:" + endpoint + ":" + model);
    if (provider) keys.push(provider + ":" + model);
    keys.push(model);
    return keys;
  }
  function normalizePricing(p) {
    if (!p || typeof p !== "object") return null;
    const input = Number(p.input);
    const output = Number(p.output);
    const cache_hit = Number(p.cache_hit == null ? p.input : p.cache_hit);
    if (!(input >= 0) || !(output >= 0) || !(cache_hit >= 0)) return null;
    return { input, output, cache_hit };
  }
  function getPricing(ctxOrModel) {
    const custom = getCustomPricing();
    const builtin = window.DEEPSEEK_PRICING || {};
    for (const k of pricingKeysFor(ctxOrModel)) {
      const p = normalizePricing(custom[k]) || normalizePricing(builtin[k]);
      if (p) return { key: k, pricing: p, source: custom[k] ? "custom" : "builtin" };
    }
    const fallback = normalizePricing(window.DEEPSEEK_PRICING_DEFAULT);
    return fallback ? { key: "__default__", pricing: fallback, source: "default" } : null;
  }
  function setCustomPricing(keyOrModel, pricing, ctx) {
    const all = getCustomPricing();
    const key = (ctx && typeof ctx === "object")
      ? (pricingKeysFor(Object.assign({}, ctx, { model: keyOrModel }))[0] || String(keyOrModel || "").trim())
      : String(keyOrModel || "").trim();
    if (!key) return all;
    if (pricing == null) { delete all[key]; }
    else {
      const p = normalizePricing(pricing);
      if (p) all[key] = p;
    }
    try { localStorage.setItem(LS_CUSTOM_PRICING, JSON.stringify(all)); } catch {}
    return all;
  }

  const session = [];
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalInEstimate = 0;
  let totalOutEstimate = 0;
  // 2026-09-14 UI第二轮:最近一次完成请求的真实 usage 快照(供右栏/手机「状态」面板读取,见 __app.getLastRequestStats)
  let lastReqStats = null;
  let isSending = false;
  // 2026-11-10: agent 运行中的「插话」通道（对齐 ZCode 工作中发消息）——
  // 非 null = 当前有 agent 轮次在跑；push 一条 {role:"user"} 内核会在下一轮请求前 append 进 messages。
  let _agentSteerQueue = null;
  const _steerMsgs = new WeakSet(); // 标记已由插话路径入过 session，写回时跳过，避免重复
  // 2026-11-10: pc_shot 截图进模型上下文 —— 视觉模型在下一轮请求前以 user 图文消息注入。
  let _agentImageQueue = null;
  function pcVisionOn(modelId) {
    try {
      const v = localStorage.getItem("cfw_pc_vision_v1");
      if (v === "1") return true;
      if (v === "0") return false;
    } catch (e) {}
    const m = String(modelId || "").toLowerCase();
    return /(deepseek-flash|deepseek-v4|vision|glm-4v|gpt-4o|gemini|claude|qwen[\w.-]*vl)/.test(m);
  }
  // 4.64 多开会话:把"上一槽 key"提到 IIFE 作用域,供 switchConversation 与 character:changed 处理器共享,避免切会话后下次切角色把当前会话误存到旧槽
  // 4.80 fix: 运行期内存槏缓存,与「本地存储」开关完全无关——即便未勾选本地存储,
  // 切角色卡 / 切多开会话时也不再清空对话,只有刷新页面才会真正丢失(那才是本地存储该管的事)。
  const _memSlots = {};

  // ─── 并发/取消控制（修复重试/删除/刷新 与流式响应的冲突）───
  // sendGen：每起 send 递增；旧闭包只有 myGen === sendGen 才能写 session / DOM
  // currentController：当前流的 AbortController，重试/删除/手动中断时调用 .abort()
  // partialStream：记录正在流式过程中已收到的 content/reasoning_content，供 beforeunload 兑现
  let currentController = null;
  let sendGen = 0;
  // 4.19 P1 fix: tail 自己的 generation token,只在 abortCurrent 时 ++
  // root cause: P0.5 fire-and-forget tail 不能用 sendGen 判断中断 ——
  // fishbowl 调下个 sendOne 时 sendGen 已 ++,旧 tail 醒来发现 myGen !== sendGen 立刻退出,
  // 导致 wechat ||拆条只显示第 1 段,后续段全消失。新 _tailGen 不受新 sendOne 影响,只跟 abort 联动。
  let _tailGen = 0;
  let partialStream = null;
  // 2026-10-08: 本次中断是否"明确丢弃半截"（重试/删除/鱼缸 stop 走 abortCurrent(true)）。
  // 中断兜底据此决定要不要把半截回复/工具轮写回 session —— 那条路正在截断，
  // 迟到的写回会把刚删掉的内容以"幽灵消息"补回来。每次新发送开头重置。
  let _discardPartialFlag = false;

  // discardPartial=true: 同时清空 partialStream（重试/删除 使用，明确丢弃已收到的部分）
  // discardPartial=false（默认）: 保留 partialStream，AbortError 处理时会把已收到部分作为完整 AI 回复入 session（停止按钮 使用）
  function abortCurrent(discardPartial) {
    // 2026-10-08: 先解掉未决的「等待放行」卡 —— agent 循环可能正挂在那个 Promise 上，
    // 光 abort fetch 到不了它（这就是"点停止后输入框发不出消息、重启才恢复"的锁）。
    try { if (window.__agentConsole && window.__agentConsole.cancelPending) window.__agentConsole.cancelPending("已中断"); } catch (e) {}
    _tailGen++; // 4.19 P1: 取消所有 fire-and-forget tail (停止/重试/删除/鱼缸 stop 共用)
    if (discardPartial) { partialStream = null; _discardPartialFlag = true; }
    if (currentController) {
      try { currentController.abort(); } catch {}
      currentController = null;
    }
  }
  window.__abortCurrent = abortCurrent; // 向后兼容(chat-ux.js / multi-agent.js 旧调用)

  // 切换某个 AI row 的“流式中”状态：控制停止按钮可见性 + dataset 标记
  function setStreamingUI(row, streaming) {
    if (!row) return;
    if (streaming) {
      row.dataset.streaming = "1";
    } else {
      try { delete row.dataset.streaming; } catch (e) { row.removeAttribute("data-streaming"); }
    }
    const btn = row.querySelector(".my-stop-btn");
    if (btn) btn.style.display = streaming ? "" : "none";
  }

  // ─── 模式：free=NVIDIA / fast=DeepSeek ───
  const LS_MODE = "cfw_mode";
  let currentMode = localStorage.getItem(LS_MODE) === "fast" ? "fast" : "free";

  // ─── 2026-10-13 批 E1c：渠道体系接线（注册表在 /shared/providers.js → window.__providers）───
  // 请求体带 providerId（预设渠道显式选择）——未加载/未选择/自定义活跃=不发，Worker 按 mode 别名回落。
  function activeProviderIdPayload() {
    try {
      const pid = window.__providers && window.__providers.activePresetId && window.__providers.activePresetId();
      return pid ? { providerId: pid } : {};
    } catch (e) { return {}; }
  }
  // 失效模型自愈（学 ZCode/Proma）：上游/worker 回「模型不存在/不属于当前渠道」类错误时，
  // 气泡里附「选择新模型」按钮 —— 跳设置·模型 API，并顺手刷新当前渠道的模型列表。
  // 错误体美化：worker 的可操作错误是 JSON {"error":...} —— 气泡里显示人话,而不是裸 JSON。
  function formatChatErrorBody(t) {
    const s = String(t || "");
    try {
      const d = JSON.parse(s);
      if (d && typeof d.error === "string" && d.error) return d.error;
    } catch (e) {}
    return s.slice(0, 400);
  }
  function looksLikeInvalidModel(status, text) {
    const t = String(text || "");
    if (/不属于当前渠道/.test(t)) return true; // worker 自己的可操作报错（渠道闸）
    if (status !== 400 && status !== 404 && status !== 422) return false;
    // 中文口径：worker 归类文案（模型「x」…不存在或已下线）与中文上游报错
    if (/模型/.test(t) && /(不存在|已下线|下线|无效|未找到|已删除)/.test(t)) return true;
    // 英文口径：上游原话（Model Not Exist / model not found / invalid model ...）
    return /\bmodel\b/i.test(t) && /(not\s+found|not\s+exist|does\s+not\s+exist|doesn'?t\s+exist|unknown|invalid|unsupported|decommission|deprecat)/i.test(t);
  }
  function attachModelReselectButton(aiRow) {
    try {
      if (!aiRow || !aiRow.bubble || aiRow.bubble.querySelector(".model-reselect-btn")) return;
      const wrap = document.createElement("div");
      wrap.style.cssText = "margin-top:6px;";
      const btn = document.createElement("button");
      btn.type = "button"; btn.className = "smallbtn model-reselect-btn"; btn.textContent = "选择新模型";
      btn.addEventListener("click", async function () {
        try { if (window.__openSettingsCat) window.__openSettingsCat("modelapi"); } catch (e) {}
        try {
          const key = (window.__providers && window.__providers.effectiveKey) ? window.__providers.effectiveKey(currentMode) : null;
          if (key && window.__providers.fetchModels) await window.__providers.fetchModels(key);
        } catch (e) {}
        toastMsg("已刷新当前渠道的模型列表 · 在「渠道管理」里勾选新模型", 3600);
      });
      wrap.appendChild(btn);
      const hint = document.createElement("div");
      hint.style.cssText = "font-size:11px;color:var(--muted);margin-top:4px;";
      hint.textContent = "这个模型在当前渠道里可能已下线/改名。";
      wrap.appendChild(hint);
      aiRow.bubble.appendChild(document.createElement("br"));
      aiRow.bubble.appendChild(wrap);
    } catch (e) {}
  }

  // ─── 费用累计（仅 fast 模式）───
  let totalCostCNY = 0;

  function calcCost(modelOrCtx, promptTokens, completionTokens, cachedTokens = 0) {
    const hit = getPricing(modelOrCtx);
    if (!hit || !hit.pricing) return 0;
    const p = hit.pricing;
    const normalInput = Math.max(0, promptTokens - cachedTokens);
    const cost =
      (cachedTokens   * p.cache_hit +
       normalInput    * p.input     +
       completionTokens * p.output) / 1_000_000;
    return cost;
  }
  function pricingContext(mode, model, customProvider) {
    if (customProvider && customProvider.endpoint && customProvider.model) {
      return { provider: "byo", mode: mode || currentMode, endpoint: customProvider.endpoint, model: customProvider.model };
    }
    return { provider: mode === "fast" ? "deepseek" : "nvidia", mode: mode || currentMode, model };
  }

  // Phase 4 阶段 7：日费用日志（独立于历史）
  function todayStr() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  // 4.50: 费用日志改「按设备分桶」存储,修跨设备同日 max 合并少算总额
  // 结构 { [day]: { [deviceId]: {cost,prompt,completion,requests} } };设备 id 仅本机(sync.js PROTECTED 不同步)
  const LS_DEVICE_ID = "cfw_device_id_v1";
  function getDeviceId() {
    let id = localStorage.getItem(LS_DEVICE_ID);
    if (!id) {
      id = "dev_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      try { localStorage.setItem(LS_DEVICE_ID, id); } catch {}
    }
    return id;
  }
  function isFlatCostEntry(e) {
    return !!(e && typeof e === "object" && !Array.isArray(e) &&
      (typeof e.cost === "number" || typeof e.requests === "number" ||
       typeof e.prompt === "number" || typeof e.completion === "number"));
  }
  function sumCostDay(dayEntry) {
    const out = { cost: 0, prompt: 0, completion: 0, requests: 0 };
    if (!dayEntry || typeof dayEntry !== "object") return out;
    const buckets = isFlatCostEntry(dayEntry) ? [dayEntry] : Object.keys(dayEntry).map(k => dayEntry[k]);
    for (const e of buckets) {
      if (!e || typeof e !== "object") continue;
      out.cost += e.cost || 0; out.prompt += e.prompt || 0;
      out.completion += e.completion || 0; out.requests += e.requests || 0;
    }
    return out;
  }
  function loadCostLog() {
    try {
      const raw = localStorage.getItem(LS_COST_LOG);
      if (!raw) return {};
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
      let migrated = false;
      for (const day in obj) {
        if (isFlatCostEntry(obj[day])) { obj[day] = { legacy: obj[day] }; migrated = true; }
      }
      if (migrated) { try { localStorage.setItem(LS_COST_LOG, JSON.stringify(obj)); } catch {} }
      return obj;
    } catch { return {}; }
  }
  function saveCostLog(log) {
    try { localStorage.setItem(LS_COST_LOG, JSON.stringify(log)); } catch {}
  }
  function addCostToToday(cost, promptTok, completionTok) {
    if (!cost || cost <= 0) return;
    const log = loadCostLog();
    const day = todayStr();
    const dev = getDeviceId();
    const dayObj = isFlatCostEntry(log[day]) ? { legacy: log[day] }
      : (log[day] && typeof log[day] === "object" ? log[day] : {});
    const e = dayObj[dev] || { cost: 0, prompt: 0, completion: 0, requests: 0 };
    e.cost = (e.cost || 0) + cost;
    e.prompt = (e.prompt || 0) + (promptTok || 0);
    e.completion = (e.completion || 0) + (completionTok || 0);
    e.requests = (e.requests || 0) + 1;
    dayObj[dev] = e;
    log[day] = dayObj;
    // 4.82: 费用日志历史上限 —— 只保留最近 400 天,防止 cfw_cost_log_v1 无限增长拖慢每次全量 parse/stringify
    const MAX_DAYS = 400;
    const dayKeys = Object.keys(log).sort();
    if (dayKeys.length > MAX_DAYS) {
      for (const d of dayKeys.slice(0, dayKeys.length - MAX_DAYS)) delete log[d];
    }
    saveCostLog(log);
    // 4.20: 费用独立同步 —— 任何设备发完一条立即排队 push (sync.js 内 10s debounce, server 端 per-day max merge)
    // saveCostLog 用 setItem 不会触发 main blob markDirty (cfw_cost_log_v1 已加入 sync.js PROTECTED)
    if (window.__sync && window.__sync.markCostDirty) {
      try { window.__sync.markCostDirty(); } catch {}
    }
  }
  function getCostStats() {
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

  function updateCostDisplay() {
    if (!costDisplayEl) return;
    // 2026-06-08: 免费模式不计费 → 顶栏 💰 区原本留空,导致桌面顶栏中段一大段空隙。
    // 仅【免费模式】补占位文字(它本就无数字);【快速模式】始终显示金额——无消费时即 ¥0.0000,本来就有数字,不再塞「暂无消费」文字。
    if (currentMode !== "fast") {
      // 图标保留，只把状态写进 title/dataset（2026-11-09 所有者：显示成图标，不显示文字）
      costDisplayEl.classList.add("cost-placeholder");
      costDisplayEl.title = "免费模式，不计费";
      costDisplayEl.setAttribute("aria-label", "免费模式，不计费");
      delete costDisplayEl.dataset.today;
      delete costDisplayEl.dataset.total;
      return;
    }
    costDisplayEl.classList.remove("cost-placeholder");
    const s = getCostStats();
    // 2026-11-09：紧凑成图标（原「今日: ¥x | 总计: ¥y」把顶栏按钮组挤出容器）。
    // 金额只进 title / aria-label / dataset（账单卡从 dataset 取）。
    const f4 = (n) => (Math.round((Number(n) || 0) * 10000) / 10000).toFixed(4);
    costDisplayEl.dataset.today = f4(s.today);
    costDisplayEl.dataset.total = f4(s.total);
    costDisplayEl.title = "今日 ¥" + f4(s.today) + " · 总计 ¥" + f4(s.total) + "（点开账单）";
    costDisplayEl.setAttribute("aria-label", "计费：今日 ¥" + f4(s.today) + "，总计 ¥" + f4(s.total));
  }

  // 暴露给 Settings UI（index.html load 处理器使用）
  window.__cost = {
    loadCostLog,
    saveCostLog,
    getCostStats,
    todayStr,
    sumCostDay,
    getDeviceId,
    refreshTopbar: updateCostDisplay,
  };

  // 开发者模式控制台 API
  // 控制台用法举例:
  // 2026-10-05(A-3): 改为**合并**而非整体覆盖 —— 本文件后加载,原来的整体赋值会把
  // dev.js 先挂到 window.__dev 上的 9 个方法(isOn/toggle/enable/disable/debug/log/
  // exportLS/setLastPayload/openPanel)全部挤掉,它们经 window.__dev 变成不可达
  // (dev.js 面板内部走闭包不受影响,所以自检发现不了)。合并后两组 API 共存;
  // 消费方(tools.js/env-context/wechat-group)全部用的是本文件这组,行为零变化。
  window.__dev = {
    ...(window.__dev || {}),
    isJailbreakStripOn,
    setJailbreakStripOn(on) {
      localStorage.setItem(LS_JAILBREAK_STRIP, on ? "1" : "0");
    },
    getReplyStyle() {
      return localStorage.getItem("cfw_reply_style_v1") || "default";
    },
    setReplyStyle(s) {
      const v = (s === "wechat" || s === "verbose") ? s : "default";
      localStorage.setItem("cfw_reply_style_v1", v);
    },
  
  
    isDevMode() {
      return localStorage.getItem("cfw_dev_mode_v1") === "1";
    },
    setDevMode(on) {
      localStorage.setItem("cfw_dev_mode_v1", on ? "1" : "0");
    },
    // 4.53 真实节奏 / 群聊在线模式 控制台开关
    getReplyPacing() { return (localStorage.getItem("cfw_reply_pacing_v1") ?? "1") === "1"; },
    setReplyPacing(on) { localStorage.setItem("cfw_reply_pacing_v1", on ? "1" : "0"); },
    getPacingDelay() { return parseInt(localStorage.getItem("cfw_reply_pacing_delay_v1") || "2200", 10) || 2200; },
    setPacingDelay(ms) { localStorage.setItem("cfw_reply_pacing_delay_v1", String(Math.max(0, Math.min(15000, parseInt(ms, 10) || 0)))); },
    getGroupOnlineMode() { return localStorage.getItem("cfw_group_online_mode_v1") === "subset" ? "subset" : "all"; },
    setGroupOnlineMode(m) { localStorage.setItem("cfw_group_online_mode_v1", m === "subset" ? "subset" : "all"); },
    // 内核接线 v1:Agent 内核模式开关(默认关 → 流式 sendOne;开 → function-calling + agent loop)
    isAgentMode() { return (localStorage.getItem("cfw_agent_mode_v1") ?? "0") === "1"; },
    setAgentMode(on) { localStorage.setItem("cfw_agent_mode_v1", on ? "1" : "0"); },
  };

  // ─── 供外部（my-buttons.js）调用的工具函数 ───
  window.__sessionTruncateTo = function (n) {
    if (n >= 0 && n <= session.length) {
      session.splice(n);
      persistSessionIfEnabled();
    }
  };
  // 2026-11-11: Agent 运行态下输入键的形态：
  //   运行中 + 空输入 = 停止键（点击=中断本轮）
  //   运行中 + 有字   = 发送键（点击=插话，不打断上下文）
  //   非运行          = 普通发送键
  // 标题只保留最朴素的「停止 / 发送」，不写状态解释。
  function updateSendBtnState() {
    if (!sendBtn) return;
    const running = !!(isSending && _agentSteerQueue);
    const hasText = !!(inputEl.value || "").trim();
    const stopMode = running && !hasText;
    if (stopMode) {
      if (!sendBtn.classList.contains("is-stop")) {
        sendBtn.classList.add("is-stop");
        sendBtn.innerHTML = STOP_BTN_ICON_HTML;
      }
      sendBtn.title = "停止";
      sendBtn.setAttribute("aria-label", "停止");
    } else {
      if (sendBtn.classList.contains("is-stop")) {
        sendBtn.classList.remove("is-stop");
        if (SEND_BTN_ICON_HTML) sendBtn.innerHTML = SEND_BTN_ICON_HTML; else sendBtn.textContent = "发送";
      }
      sendBtn.title = "发送";
      sendBtn.setAttribute("aria-label", "发送");
    }
  }
  window.__updateSendBtnState = updateSendBtnState; // 调试/桩测入口
  window.__resetSending = function () {
    isSending = false;
    sendBtn.disabled = false;
    // 还原小飞机图标(原 textContent="Send" 会把 SVG 抹成英文字"Send")
    sendBtn.classList.remove("is-stop");
    if (SEND_BTN_ICON_HTML) sendBtn.innerHTML = SEND_BTN_ICON_HTML; else sendBtn.textContent = "发送";
    updateSendBtnState();
  };
  window.__sessionDeleteAt = function (start, count) {
    if (start >= 0 && start < session.length) {
      session.splice(start, count);
      persistSessionIfEnabled();
    }
  };
  // 2026-10-08 停止键的完整语义（■■ 停止按钮专用）：旧版只 abort fetch —— 若循环正卡在
  // "等待放行"或工具执行里，abort 到不了它，isSending 也永不释放（表现：停止后输入框发不出消息）。
  // 现在：① 解掉未决权限卡；② 发中断信号（内核会先配对自愈、再抛 AbortError，由本文件已有的
  // AbortError 兜底分支接住半截回复）；③ 无条件释放发送锁 —— 旧回合若还有尾巴在跑，
  // sendGen 已变，它会静默退场（写回/渲染路径都加了 myGen 守卫）。
  window.__stopCurrent = function () {
    try { if (window.__agentConsole && window.__agentConsole.cancelPending) window.__agentConsole.cancelPending("已中断"); } catch (e) {}
    abortCurrent();
    window.__resetSending();
  };

  // 2026-11-10: pc_shot 把截图交给模型（仅视觉模型；内核 beforeStep 在下一轮请求前注入）。
  window.__agentPushImage = function (dataUrl, meta) {
    if (!_agentImageQueue || !dataUrl) return false;
    if (_agentImageQueue.length >= 6) _agentImageQueue.shift(); // 同轮最多带 6 张，超出丢最旧（视觉上下文护栏）
    _agentImageQueue.push({ dataUrl: String(dataUrl), meta: meta || {} });
    return true;
  };

  const LS_MODEL      = "cfw_model";
  const LS_USE_BUILTIN     = "cfw_use_builtin";
  const LS_HISTORY_ENABLED = "cfw_history_enabled";
  const LS_CHAT_SESSION    = "cfw_chat_session_v1";
  const LS_PROMPT_ENABLED  = "cfw_prompt_enabled";
  const LS_CUSTOM_PROMPT   = "cfw_custom_prompt_v1";
  // 阶段 4-③：上下文摘要相关存储
  const LS_PRIOR_SUMMARY   = "cfw_prior_summary_v1";
  const LS_SUMMARY_ENABLED = "cfw_summary_enabled";
  const LS_SUMMARY_TRIGGER = "cfw_summary_trigger";
  const LS_SUMMARY_KEEP    = "cfw_summary_keep";
  // Phase 4 阶段 6：提示词预设库（5 starter + 用户自建，每项 { id, name, content, enabled, order }）
  const LS_PROMPT_PRESETS  = "cfw_prompt_presets_v1";
  // Phase 4 阶段 7：费用日志（按天累加，独立于本地历史；clearHistory 不动）
  const LS_COST_LOG        = "cfw_cost_log_v1";
  let priorSummary = localStorage.getItem(LS_PRIOR_SUMMARY) || "";
  let summaryEnabled = (localStorage.getItem(LS_SUMMARY_ENABLED) ?? "1") === "1";
  let summaryTrigger = parseInt(localStorage.getItem(LS_SUMMARY_TRIGGER) || "30", 10) || 30;
  let summaryKeep    = parseInt(localStorage.getItem(LS_SUMMARY_KEEP)    || "10", 10) || 10;
  let summarizing = false;

  // 阶段 4-③：创建/刷新/移除「剧情摘要」芒果条
  // 4.18 (fix): 加 ✕ 关闭按钮,点后设 LS cfw_summary_chip_hidden_v1=1 仅隐藏不删数据
  // (下次生成新摘要/清除历史时会重置 hidden 并重新显示)
  function renderSummaryChip() {
    let chip = document.getElementById("summaryChip");
    const hidden = localStorage.getItem("cfw_summary_chip_hidden_v1") === "1";
    // 2026-06-01: 剧情摘要绑定「保留历史」——历史关时摘要整体失效(不显示/不注入/不生成),避免没开长聊也被早期摘要污染对话。
    if (!historyEnabled || !priorSummary || hidden) {
      if (chip && chip.parentNode) chip.parentNode.removeChild(chip);
      return;
    }
    if (!chip) {
      chip = document.createElement("div");
      chip.id = "summaryChip";
      chip.className = "summary-chip";
      chatEl.insertBefore(chip, chatEl.firstChild);
    }
    const isLight = (window.__theme && typeof window.__theme.is === "function") ? window.__theme.is("light") : (localStorage.getItem("my-theme") === "light"); // 4.79 #12: 改读有效明暗(显式选择||主题原生),修 glass/少女 原生浅色下直读 my-theme=null 误判为暗导致 UI 不可读
    chip.style.cssText = "margin:8px auto;padding:8px 12px;border-radius:8px;font-size:11px;line-height:1.5;max-width:80%;border:1px dashed " + (isLight ? "#bbb" : "#444") + ";background:" + (isLight ? "#f5f5f5" : "#1a1a1a") + ";color:" + (isLight ? "#666" : "#888") + ";display:flex;align-items:center;justify-content:space-between;gap:8px;";
    chip.innerHTML = "";
    const txt = document.createElement("span");
    txt.style.cssText = "flex:1;cursor:pointer;text-align:center;";
    txt.title = "点击查看完整剧情摘要";
    txt.textContent = `早期对话已压缩为剧情摘要（${priorSummary.length} 字），点击查看`; // 4.71: 去掉 📚
    txt.onclick = () => alert("【先前剧情摘要】\n\n" + priorSummary);
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    closeBtn.title = "隐藏提示(不删摘要数据,清除历史/生成新摘要时会重新显示)";
    closeBtn.style.cssText = "background:transparent;border:none;color:inherit;font-size:13px;line-height:1;cursor:pointer;padding:2px 6px;opacity:0.55;flex-shrink:0;";
    closeBtn.onmouseover = () => closeBtn.style.opacity = "1";
    closeBtn.onmouseout = () => closeBtn.style.opacity = "0.55";
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      localStorage.setItem("cfw_summary_chip_hidden_v1", "1");
      chip.remove();
    };
    chip.appendChild(txt);
    chip.appendChild(closeBtn);
  }

  let useBuiltin = (localStorage.getItem(LS_USE_BUILTIN) ?? "1") === "1";

  // ── 2026-10-09 顶栏「基座」按钮两种语义 ──────────────────────────────────────
  // · 公开渠道：window.__baseSwitchMode 由导出补丁置位 —— 按钮改「内置 ⇄ 自定义」两套目录切换：
  //   内置 = src/prompts/bases/（随包一份「基础」准则 + 使用者的正经提示词）；
  //   自定义 = src/prompts/custom/（使用者自己那份，只有他自己的部署看得见）。
  //   两态各在「设置 → 对话 → 基座」里选具体档位；自定义目录为空时按钮不切过去，改成提示怎么放文件。
  const BASE_SWITCH_MODE = !!window.__baseSwitchMode;
  function baseIdsList() {
    return (Array.isArray(window.APP_BASE_IDS) ? window.APP_BASE_IDS : [])
      .filter(function (x) { return typeof x === "string" && x; });
  }
  function customIdsList() {
    return (Array.isArray(window.APP_CUSTOM_IDS) ? window.APP_CUSTOM_IDS : [])
      .filter(function (x) { return typeof x === "string" && x; });
  }
  function currentBaseId() {
    try { return localStorage.getItem("cfw_base_id_v1") || ""; } catch (e) { return ""; }
  }
  function currentCustomId() {
    try { return localStorage.getItem("cfw_custom_id_v1") || ""; } catch (e) { return ""; }
  }
  function currentRegistryIsCustom() {
    try { return BASE_SWITCH_MODE && localStorage.getItem("cfw_base_registry_v1") === "custom"; } catch (e) { return false; }
  }
  function toastMsg(msg, ms) {
    try { if (window.__feedback && typeof window.__feedback.toast === "function") window.__feedback.toast(msg, ms || 2000); } catch (e) {}
  }
  // 两套目录共用一份"当前档位"的取法：没选/选了个已被删掉的 id → 回落排序第一份
  function registryDescribe(useCustom) {
    var ids = useCustom ? customIdsList() : baseIdsList();
    var cur = useCustom ? currentCustomId() : currentBaseId();
    var label = (cur && ids.indexOf(cur) >= 0) ? cur : (ids[0] || "");
    return { ids: ids, label: label };
  }
  function paintPersonaButton() {
    if (BASE_SWITCH_MODE) {
      // 文案纪律：title/aria 用**固定整串**，别拼动态值 —— 拼接串在双语字典里没有对应键，
      // 换英文界面时会原样漏中文（「思考挡位」那批就是这么漏的）。档位名放在设置卡里显示。
      var useCustom = currentRegistryIsCustom();
      setIcon(personaToggle, "personaBuiltin", useCustom ? "自定义" : "内置");
      personaToggle.title = useCustom
        ? "基座目录：自定义（src/prompts/custom/）。点击切回内置"
        : "基座目录：内置（src/prompts/bases/）。点击切到自定义";
      personaToggle.setAttribute("aria-label", useCustom ? "切回内置基座" : "切到自定义基座");
      return;
    }
    setIcon(personaToggle, useBuiltin ? "personaBuiltin" : "personaCustom", useBuiltin ? "内置" : "自定义");
  }
  paintPersonaButton();
  // 2026-09-14 会话系统重做:默认改为「开」。会话列表/跨会话切换要有意义就必须落盘,
  // 否则列表里全是 0 条、刷新即空,谈不上会话管理。显式关过(存了 "0")的用户保持关闭。
  let historyEnabled = (localStorage.getItem(LS_HISTORY_ENABLED) ?? "1") === "1";
  let promptEnabled  = (localStorage.getItem(LS_PROMPT_ENABLED)  ?? "1") === "1";
  // Bug1 fix: historyKeep/promptKeep 由 settings.js mountLocalHistoryCard() 动态挂载，IIFE 执行时尚不存在 → null.checked 崩溃。加守卫，实际赋值+事件绑定推迟到 wireHistoryUI()
  if (historyKeepEl) historyKeepEl.checked = historyEnabled;
  if (promptKeepEl) promptKeepEl.checked  = promptEnabled;

  // ─── 思考模式 toggle（4.82 起免费档同样可开,参数由 worker 按 provider 方言下发）───
  const LS_THINKING = "cfw_thinking";
  let thinkingOn = (localStorage.getItem(LS_THINKING) ?? "0") === "1";

  // ─── 4.83 生成参数(temperature / max_tokens)───
  // 来源:设置 → 模型 API → 生成参数卡(settings.js 的 mountGenParamsCard)。
  // 设计:默认"不干预" —— 未设置的字段**不发送**,由上游用其自己的默认值,
  // 保证不改变既有输出质量(不猜默认值,也不覆盖上游对模型的调校)。
  const LS_GEN_PARAMS = "cfw_gen_params_v1";
  function readGenParams() {
    try {
      const o = JSON.parse(localStorage.getItem(LS_GEN_PARAMS) || "{}");
      return (o && typeof o === "object" && !Array.isArray(o)) ? o : {};
    } catch { return {}; }
  }
  // 展开进 /api/chat body 的片段(worker 侧已支持 temperature / top_p / max_tokens,显式提供才下发)
  function genParamPayload() {
    const g = readGenParams();
    const out = {};
    if (typeof g.temperature === "number" && g.temperature >= 0) out.temperature = g.temperature;
    if (typeof g.maxTokens === "number" && g.maxTokens > 0) out.max_tokens = Math.floor(g.maxTokens);
    return out;
  }

  // ─── 2026-10-08 角色能力档：每张卡一套「底座 / 指令模块 / 技能 / 模型」覆盖 ────────────────
  // 存储：cfw_char_caps_v1 = { [cardId]: { baseId?, presetIds?: [id], skillIds?: [id], model? } }
  // 缺省（没档 / 字段为空）= 跟随全局 —— 不配置就是现状，RP 体验零变化。
  // 设定集（世界书）的按卡绑定已由 lorebook.js 的 scope:'perCard' + boundCardId 提供，不在这里重复。
  const LS_CHAR_CAPS = "cfw_char_caps_v1";
  function charCapMap() {
    try { const o = JSON.parse(localStorage.getItem(LS_CHAR_CAPS) || "{}"); return (o && typeof o === "object") ? o : {}; } catch (e) { return {}; }
  }
  function charCap(card) {
    const id = typeof card === "string" ? card : (card && card.id);
    if (!id) return null;
    const c = charCapMap()[id];
    return (c && typeof c === "object") ? c : null;
  }
  // v1 最小设置入口：控制台调 `__charCaps.ui()`，按提示给"当前角色"配 底座 / 指令模块 / 技能 / 模型。
  // （正式的「提示词编辑器·角色页·能力区」留待后续批次；存储与装配已全部打通，见 charCap 的使用点）
  window.__charCaps = {
    get: (card) => charCap(card),
    all: () => charCapMap(),
    set: (cardId, patch) => {
      if (!cardId) return null;
      const m = charCapMap();
      m[cardId] = Object.assign({}, m[cardId] || {}, patch || {});
      try { localStorage.setItem(LS_CHAR_CAPS, JSON.stringify(m)); } catch (e) {}
      return m[cardId];
    },
    clear: (cardId) => { const m = charCapMap(); delete m[cardId]; try { localStorage.setItem(LS_CHAR_CAPS, JSON.stringify(m)); } catch (e) {} },
    ui: () => {
      const card = (window.__character && window.__character.getActiveCard && window.__character.getActiveCard()) || null;
      if (!card || !card.id) { alert("先挂一张角色卡（左栏角色面板）—— 能力档是「每张卡一套」的。"); return; }
      const cur = charCap(card) || {};
      const baseId = prompt("「" + card.name + "」的底座 id（留空=跟随全局；可用 __charCaps 查看/清空）：", cur.baseId || "");
      if (baseId === null) return;
      const presetIds = prompt("指令模块 id 列表（逗号分隔；留空=跟随全局的勾选）：", Array.isArray(cur.presetIds) ? cur.presetIds.join(",") : "");
      if (presetIds === null) return;
      const skillNames = prompt("技能名列表（逗号分隔；留空=全部已启用技能）：", Array.isArray(cur.skillNames) ? cur.skillNames.join(",") : "");
      if (skillNames === null) return;
      const patch = {
        baseId: baseId.trim(),
        presetIds: presetIds.split(",").map((s) => s.trim()).filter(Boolean),
        skillNames: skillNames.split(",").map((s) => s.trim()).filter(Boolean),
      };
      window.__charCaps.set(card.id, patch);
      alert("已保存「" + card.name + "」的能力档：\n底座 " + (patch.baseId || "(跟随全局)") + "\n指令模块 " + (patch.presetIds.length || "(跟随全局)") + " 个\n技能 " + (patch.skillNames.length || "(全部)") + " 个\n（下次发消息生效）");
    },
  };
  // 服务端另有白名单兜底(resolveBaseId:乱传/不存在的 id 回落默认),所以这里只是少发无用字段,不是安全边界。
  // 两处 payload(sendOneAgent / sendOne)都要带 —— 只加一处的坑在 4.69 BYO 上踩过。
  // 2026-10-08：可传发言者卡 —— 该卡配了 baseId 就用它的（角色能力档），否则跟随全局。
  function baseIdPayload(card) {
    try {
      // 公开渠道：两套目录（bases/ 内置 · custom/ 自定义），顶栏按钮决定用哪套；档位 id 各自过白名单。
      // 没选具体档位就不发 id —— 服务端回落到该注册表的默认档（与设置里「默认」一致）。
      if (BASE_SWITCH_MODE) {
        if (currentRegistryIsCustom()) {
          const cid = currentCustomId();
          return cid ? { use_custom_base: true, customId: cid } : { use_custom_base: true };
        }
        const bid = currentBaseId();
        return bid ? { baseId: bid } : {};
      }
      const cap = charCap(card);
      const id = (cap && typeof cap.baseId === "string" && cap.baseId) ? cap.baseId : (localStorage.getItem("cfw_base_id_v1") || "");
      return id ? { baseId: id } : {};
    } catch (e) { return {}; }
  }

  
  // ─── 2026-10-05 角色状态层开关(设置里可见)：关掉才发字段（缺省=开，服务端 payload.stateLayer !== false）。
  //     这就是「为什么默认 rp」的那个把手 —— 判定是「有角色卡就注入【当前状态】那一段」,不想注入就关它。
  function stateLayerPayload() {
    try { return localStorage.getItem("cfw_state_layer_v1") === "0" ? { stateLayer: false } : {}; } catch (e) { return {}; }
  }
  // 2026-10-07 联网搜索：只在"开"时下发字段（缺省=不开，服务端也不会挂搜索工具）。
  function webSearchPayload() {
    try {
      if (localStorage.getItem("cfw_web_search_v1") !== "1") return {};
      // 深度搜索(Exa)只在开关也打开时下发；Worker 侧没配 EXA_API_KEY 会自动降级回免费搜索
      return { webSearch: true, webSearchDeep: localStorage.getItem("cfw_web_search_deep_v1") === "1" };
    } catch (e) { return {}; }
  }

  // ─── 4.70 思考过程显示设置(show=展开 / collapse=折叠 / hide=隐藏;默认折叠)───
  // 但我们不再「猜着删」,而是把内联思考「捕获」到 .reasoning-block 折叠块,按本设置控制可见性。
  // 即使切割误判,正文也保存在思考块里可展开找回(fail-open),不会被启发式删进虚空。
  const LS_THINK_DISPLAY = "cfw_think_display_v1";
  function getThinkDisplay() {
    const v = localStorage.getItem(LS_THINK_DISPLAY);
    return (v === "show" || v === "hide") ? v : "collapse";
  }
  function applyThinkDisplay(reasoningEl) {
    if (!reasoningEl) return;
    const rt = reasoningEl.querySelector(".reasoning-text");
    const hasContent = !!(rt && rt.textContent && rt.textContent.trim());
    const mode = getThinkDisplay();
    if (!hasContent || mode === "hide") { reasoningEl.style.display = "none"; return; }
    reasoningEl.style.display = "";
    reasoningEl.open = (mode === "show");
  }
  // 从正文里抠出 <think>...</think> 思考块的纯文本(用于捕获而非丢弃)
  function extractThinkText(text) {
    if (!text) return "";
    const out = [];
    const re = /<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi;
    let m;
    while ((m = re.exec(text)) !== null) out.push(m[1]);
    const open = text.match(/<think(?:ing)?>([\s\S]*)$/i);
    if (open && !/<\/think(?:ing)?>/i.test(open[0])) out.push(open[1]);
    return out.join("\n").trim();
  }

  // 旧版仅用「——」草草拼接,不去重不标注 → 折叠块又乱又重复。这里按来源分段加小标题,并做段级+行级去重。
  // 单一来源时不加标题(避免普通思考也被套个壳)。
  function buildReasoningArchive(nativeReasoning, inlineThink, jailbreakThink) {
    const sections = [
      { label: "模型推理", text: (nativeReasoning || "").trim() },
      { label: "内联思考", text: (inlineThink || "").trim() },
      { label: "回显", text: (jailbreakThink || "").trim() },
    ].filter(s => s.text);
    if (!sections.length) return "";
    const norm = (t) => t.replace(/\s+/g, " ").trim();
    const kept = [];
    for (const s of sections) {
      const ns = norm(s.text);
      const dup = kept.some(k => { const nk = norm(k.text); return nk === ns || nk.indexOf(ns) >= 0 || ns.indexOf(nk) >= 0; });
      if (!dup) kept.push(s);
    }
    const seen = new Set();
    const out = [];
    for (const s of kept) {
      const uniq = [];
      for (const ln of s.text.split("\n")) {
        const key = ln.trim();
        if (!key) { uniq.push(ln); continue; }
        if (seen.has(key)) continue;
        seen.add(key);
        uniq.push(ln);
      }
      const body = uniq.join("\n").trim();
      if (body) out.push((kept.length > 1 ? "【" + s.label + "】\n" : "") + body);
    }
    return out.join("\n\n──────\n\n");
  }
  const thinkToggle = document.getElementById("thinkToggle");
  // 2026-09-12: 思考按钮改临时下拉式——可选「关闭」或「开启 + 强度」，强度即 reasoning_effort。
  // 2026-11-11: 档位表独立在 /shared/model-think.js —— 模型能力会常更新，改表不动 UI。
  const LS_THINK_LEVEL = "cfw_think_level_v1";
  const _MT = (typeof window !== "undefined" && window.__modelThink) || null;
  const THINK_LEVELS = (_MT && Array.isArray(_MT.levels)) ? _MT.levels : [
    { v: "minimal", label: "极低" },
    { v: "low", label: "低" },
    { v: "medium", label: "中" },
    { v: "high", label: "高" },
    { v: "xhigh", label: "更高" },
    { v: "max", label: "最高" },
  ];
  const THINK_LEVEL_VALUES = (_MT && Array.isArray(_MT.values)) ? _MT.values : THINK_LEVELS.map((l) => l.v);
  function getThinkLevel() {
    const v = localStorage.getItem(LS_THINK_LEVEL);
    return THINK_LEVEL_VALUES.includes(v) ? v : "medium";
  }
  function thinkLevelLabel(v) {
    if (_MT && typeof _MT.label === "function") return _MT.label(v);
    const l = THINK_LEVELS.find((x) => x.v === v);
    return l ? l.label : "中";
  }
  // 模型 → 支持档位（表在 /shared/model-think.js）。文件没加载时保守回退。
  function thinkLevelsFor(model, style) {
    if (_MT && typeof _MT.levelsFor === "function") return _MT.levelsFor(model, style);
    return style === "vllm" ? ["disabled", "enabled"] : ["disabled", "low", "medium", "high", "max"];
  }
  // 把「模型档位表」编译成 UI 能力：offAllowed=能不能关；mustOn=模型不支持关闭。
  function buildThinkCap(supports, style, model) {
    if (!supports || style === "none") return { available: false, style: "none", levels: [], offAllowed: false, mustOn: false, model: model || "" };
    const values = thinkLevelsFor(model, style);
    const offAllowed = values.includes("disabled") || values.includes("none");
    const ons = values.filter((v) => v !== "disabled" && v !== "none");
    if (!ons.length) return { available: false, style: "none", levels: [], offAllowed: false, mustOn: false, model: model || "" };
    if (ons.length === 1 && ons[0] === "enabled") {
      return { available: true, style: style, levels: [], offAllowed: offAllowed, mustOn: !offAllowed, model: model || "" };
    }
    return {
      available: true, style: style,
      levels: ons.map((v) => ({ v: v, label: thinkLevelLabel(v) })),
      offAllowed: offAllowed, mustOn: !offAllowed, model: model || "",
    };
  }
  function resolveThinkLevel(cap) {
    if (!cap || !cap.levels || !cap.levels.length) return "";
    const stored = getThinkLevel();
    if (cap.levels.some((l) => l.v === stored)) return stored;
    // 对齐 ZCode：当前档位不被该模型支持时，取它支持的最高档（values.at(-1)）。
    return cap.levels[cap.levels.length - 1].v;
  }
  // 2026-11-11: 思考能力跟随「当前活跃渠道 + 模型」——
  //   none     不支持思考（按钮禁用，请求强制 disabled）
  //   vllm     NVIDIA NIM / 自定义 vLLM 方言（开/关；有档位的模型仍可带 reasoning_effort）
  //   deepseek DeepSeek 官方 / 自定义 DeepSeek 方言
  function getActiveThinkCaps() {
    try {
      const byo = window.__byoProvider && window.__byoProvider.get && window.__byoProvider.get();
      if (byo) return buildThinkCap(byo.supportsThinking, byo.thinkingStyle === "vllm" ? "vllm" : "deepseek", byo.model);
      const P = window.__providers;
      if (P && P.read) {
        const key = P.effectiveKey ? P.effectiveKey(currentMode) : null;
        const k = key && P.parseKey ? P.parseKey(key) : null;
        if (k && k.kind === "preset") {
          const m = P.presetMeta ? (P.presetMeta(k.id) || {}) : {};
          const style = (m.thinkingStyle === "vllm" || k.id === "nvidia") ? "vllm" : "deepseek";
          return buildThinkCap(m.supportsThinking !== false, style, modelSel && modelSel.value);
        }
      }
    } catch (e) {}
    return buildThinkCap(true, "deepseek", modelSel && modelSel.value);
  }
  // 请求体里的思考参数：模型不支持时强制关；有档位才带 reasoning_effort。
  function thinkRequestPayload() {
    const cap = getActiveThinkCaps();
    const on = cap.available && (cap.mustOn || thinkingOn);
    if (!on) return { thinking: "disabled" };
    const out = { thinking: "enabled" };
    if (cap.levels.length) out.reasoning_effort = resolveThinkLevel(cap);
    return out;
  }
  function updateThinkToggleUI() {
    if (!thinkToggle) return;
    const cap = getActiveThinkCaps();
    const on = !!(cap.available && (cap.mustOn || thinkingOn));
    const level = resolveThinkLevel(cap);
    const _txt = !cap.available
      ? "思考不可用"
      : (on ? (cap.levels.length ? "思考:" + thinkLevelLabel(level) : "思考开") : "思考关");
    const _lbl = thinkToggle.querySelector(".think-label");
    if (_lbl) _lbl.textContent = _txt;
    else thinkToggle.textContent = _txt;
    thinkToggle.setAttribute("aria-pressed", on ? "true" : "false");
    thinkToggle.classList.toggle("active", on);
    // 2026-11-11: 模型不支持思考时按钮直接禁用（不再给一堆无效档位）。
    // 4.82: 免费档也可开启思考 —— 参数由 worker 按 provider 方言下发
    // (DeepSeek 官方 thinking:{type};NVIDIA NIM/vLLM 走 chat_template_kwargs)。
    thinkToggle.disabled = !cap.available;
    thinkToggle.style.opacity = cap.available ? "1" : ".45";
    const _tail = cap.mustOn
      ? (cap.levels.length ? "；该模型固定开启思考，点击可改强度" : "；该模型固定开启思考")
      : ("；点击可改开关" + (cap.levels.length ? "/强度" : ""));
    thinkToggle.title = !cap.available
      ? "所选模型不支持思考（可在 设置 → 模型 API 的渠道里改「思考形态」）"
      : (on
        ? "思考模式：开启" + (cap.levels.length ? "（强度：" + thinkLevelLabel(level) + "）" : "") + "。更准，但更慢、费用较高、输出含思考过程" + _tail
        : "思考模式：关闭（快、便宜）。点击选择开关" + (cap.levels.length ? "与强度" : ""));
  }
  let _thinkMenu = null;
  function closeThinkMenu() {
    if (_thinkMenu && _thinkMenu.parentNode) _thinkMenu.parentNode.removeChild(_thinkMenu);
    _thinkMenu = null;
    document.removeEventListener("click", _onDocClickCloseThink);
  }
  function _onDocClickCloseThink(e) {
    if (_thinkMenu && !_thinkMenu.contains(e.target) && e.target !== thinkToggle && !(thinkToggle && thinkToggle.contains(e.target))) {
      closeThinkMenu();
    }
  }
  function openThinkMenu() {
    closeThinkMenu();
    if (!thinkToggle) return;
    const cap = getActiveThinkCaps();
    if (!cap.available) return; // 模型不支持思考：按钮已禁用，不再弹无效档位
    const menu = document.createElement("div");
    menu.id = "thinkLevelMenu";
    menu.style.cssText = "position:fixed;z-index:9999;min-width:140px;border-radius:10px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,.35);";
    const isLight = (window.__theme && typeof window.__theme.is === "function") ? window.__theme.is("light") : (localStorage.getItem("my-theme") === "light");
    menu.style.background = isLight ? "#ffffff" : "#1c1c22";
    menu.style.border = "1px solid " + (isLight ? "#ddd" : "#3a3a44");
    menu.style.color = isLight ? "#222" : "#eee";
    const opts = [];
    if (cap.offAllowed) opts.push({ v: "__off__", label: "关闭" });
    if (cap.levels.length) opts.push(...cap.levels.map((l) => ({ v: l.v, label: "开启（" + l.label + "）" })));
    else opts.push({ v: "__on__", label: "开启" });
    const curLevel = resolveThinkLevel(cap);
    opts.forEach((o) => {
      const it = document.createElement("div");
      const onNow = !!(thinkingOn || cap.mustOn);
      const active = (o.v === "__off__" && !onNow)
        || (o.v === "__on__" && onNow && !cap.levels.length)
        || (o.v !== "__off__" && o.v !== "__on__" && onNow && curLevel === o.v);
      it.style.cssText = "padding:7px 10px;border-radius:7px;cursor:pointer;font-size:13px;white-space:nowrap;" + (active ? ("background:" + (isLight ? "#eaeaea" : "#33333d") + ";font-weight:600;") : "");
      it.textContent = o.label;
      it.addEventListener("mouseenter", () => { it.style.background = isLight ? "#f0f0f0" : "#2a2a32"; });
      it.addEventListener("mouseleave", () => { it.style.background = active ? (isLight ? "#eaeaea" : "#33333d") : "transparent"; });
      it.addEventListener("click", (e) => {
        e.stopPropagation();
        if (o.v === "__off__") {
          if (!cap.offAllowed) return;
          thinkingOn = false; localStorage.setItem(LS_THINKING, "0");
        }
        else if (o.v === "__on__") { thinkingOn = true; localStorage.setItem(LS_THINKING, "1"); }
        else { thinkingOn = true; localStorage.setItem(LS_THINKING, "1"); localStorage.setItem(LS_THINK_LEVEL, o.v); }
        updateThinkToggleUI();
        closeThinkMenu();
      });
      menu.appendChild(it);
    });
    document.body.appendChild(menu);
    const r = thinkToggle.getBoundingClientRect();
    const mh = menu.offsetHeight || 170;
    let top = r.top - mh - 6;
    if (top < 8) top = r.bottom + 6;
    menu.style.top = top + "px";
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - (menu.offsetWidth || 140) - 8)) + "px";
    _thinkMenu = menu;
    setTimeout(() => { document.addEventListener("click", _onDocClickCloseThink); }, 0);
  }
  if (thinkToggle) {
    thinkToggle.addEventListener("click", (e) => {
      // 4.82: 免费档同样可开/关思考(旧版 `if (currentMode !== "fast") return` 让免费档点了没反应)
      e.stopPropagation();
      if (_thinkMenu) { closeThinkMenu(); return; }
      openThinkMenu();
    });
  }

  // ─── 模式切换 ───
  // 2026-11-06：顶栏按钮跟随活跃渠道 —— 预设显示渠道名、自定义显示自定义名、未选则免费/快速。
  function activeChannelInfo() {
    try {
      const P = window.__providers;
      if (!P || !P.read) return null;
      const st = P.read();
      const key = st && st.activeId;
      if (!key) return null;
      const k = P.parseKey ? P.parseKey(key) : null;
      if (!k) return null;
      // 访客不能显示预设渠道（免费/快速都是站主 Key）
      try {
        if (window.__auth && window.__auth.getToken && !window.__auth.getToken() && k.kind === "preset") return null;
      } catch (e) {}
      if (k.kind === "preset") {
        const m = P.presetMeta ? P.presetMeta(k.id) : null;
        return { name: (m && (m.title || m.label)) || k.id, kind: "preset", mode: P.modeForActive ? P.modeForActive() : null };
      }
      if (k.kind === "custom") {
        let name = k.id;
        try {
          const list = P.channels ? P.channels() : [];
          for (const c of list) if (c && c.key === key) { name = c.name || c.id || name; break; }
        } catch (e) {}
        return { name: name, kind: "custom" };
      }
    } catch (e) {}
    return null;
  }
  function paintModeToggle() {
    if (!modeToggle) return;
    const isFast = currentMode === "fast";
    const ch = activeChannelInfo();
    try {
      if (window.__auth && window.__auth.getToken && !window.__auth.getToken() && !ch) {
        modeToggle.textContent = "访客";
        setIcon(modeToggle, "modeFree", "访客");
        modeToggle.title = "访客模式：请在 设置 → 模型 API 填自己的渠道和 Key";
        return;
      }
    } catch (e) {}
    if (ch) {
      const label = String(ch.name).slice(0, 14);
      setIcon(modeToggle, ch.kind === "custom" ? "modeFast" : (ch.mode === "fast" ? "modeFast" : "modeFree"), label);
      modeToggle.title = "当前渠道：" + ch.name + "；点击切换免费/快速预设（渠道详情见 设置→模型 API）";
    } else {
      modeToggle.textContent = isFast ? "\u26A1 快速" : "\u{1F7E2} 免费";
      setIcon(modeToggle, isFast ? "modeFast" : "modeFree", isFast ? "快速" : "免费"); // 2026-06-07: 线性 SVG 图标 + 文字(覆盖上一行 emoji)
      modeToggle.title = isFast
        ? "当前：快速档（按量计费）；渠道与默认模型见 设置→模型 API"
        : "当前：免费档；渠道与默认模型见 设置→模型 API";
    }
  }
  function applyMode(mode) {
    currentMode = mode;
    localStorage.setItem(LS_MODE, mode);
    paintModeToggle();

    // 重建下拉
    initModels();
    updateCostDisplay();
    updateThinkToggleUI();
  }

  if (modeToggle) {
    modeToggle.addEventListener("click", () => {
      try {
        if (window.__auth && window.__auth.getToken && !window.__auth.getToken()) {
          alert("访客模式：请先在 设置 → 模型 API 新增自己的渠道并填写 Key。");
          return;
        }
      } catch (e) {}
      const next = currentMode === "fast" ? "free" : "fast";
      // 2026-10-13 (E1c): 免费/快速 pill = 预设渠道快捷位 —— 点它即把活跃渠道切回配对预设
      // （自定义渠道活跃时显式切到配对预设；本就跟随 pill 的话维持"跟随"语义=置空）。
      try {
        if (window.__providers && window.__providers.setActive) {
          const st = window.__providers.read();
          const cur = st && st.activeId;
          if (cur && String(cur).indexOf("custom:") === 0) window.__providers.setActive("preset:" + (next === "fast" ? "deepseek" : "nvidia"));
          else window.__providers.setActive(null);
        }
      } catch (e) {}
      applyMode(next);
    });
  }

  // 输入框文字颜色交由 styles.css 主题系统接管（minimal: #fff / glass: #1a1f2e）
  // 旧版读已废弃的 my-theme LS key 并 inline 写码，造成 glass 主题下白底上白字不可见

  // sentinel 之前的内容(伪 token 编号思考) cut 掉,只保留后面的正文。
  // 未匹配 sentinel 时原样返回，避免误伤无前缀回复。
  const LS_JAILBREAK_STRIP = "cfw_jailbreak_strip_v1";
  // 4.18 (fix v3): root cause —— 模型输出格式是:
  //   [^420]: I am not deepseek. ...           ← jailbreak echo (第一个 sentinel)
  //   <思考过程一大段,中文,无 sentinel 前缀>
  //   [^69]: Complaintless complete fulfillment:  ← 最后一个 sentinel = final reply 起点
  //   (懵) 诶吃、吃我?                          ← 真正用户可见正文
  // 旧版只 strip "开头" 的 sentinel 行,中间 thinking + 末尾 sentinel + 正文整段留在 bubble。
  // 表现:普通模式 bubble 顶部 jailbreak echo + 思考泄漏;wechat 模式 thinking 被拆条逻辑当作 "一条消息" 显示,
  // 用户却以为 "消息卡没了"(实际是被 thinking 气泡顶掉了)。
  // 现在改为:找文本里 "最后一个" [^xxx]: 行,cut 到它之后,确保 thinking 永远不泄漏。
  // 没匹配任何 sentinel(模型规矩输出无 prefix) → 原样返回不误伤。
  function isJailbreakStripOn() {
    return (localStorage.getItem(LS_JAILBREAK_STRIP) ?? "1") === "1";
  }
  // 4.70 重写:从「删除思考」改为「切分并捕获」。返回 { body, thinking }。
  //   body     = 给用户看的正文(哨兵区间 + 内联思考已剥离)
  //   thinking = 被剥离的哨兵/思考文本(路由进「💭 思考过程」折叠块,不再丢弃)
  // fail-open:若纯启发式把整段都当思考(没命中真哨兵)→ 原样返回正文,绝不留空气泡 / 吞正文。
  function splitJailbreakPrefix(text) {
    if (!text || !isJailbreakStripOn()) return { body: text, thinking: "" };
    // 哨兵:[可选^ + 任意位数字]+冒号 + 行内剩余(到 \n 或 || 为止)。对 [发图:] 不误伤(括号后是「发」非数字)。
    const re = /\[\^?\d*\][:：][^\n|]*/g;
    let firstStart = -1, lastEnd = -1, m;
    while ((m = re.exec(text)) !== null) {
      if (firstStart < 0) firstStart = m.index;
      lastEnd = m.index + m[0].length;
    }
    // 2026-10-05 收紧(哨兵必须在**回复开头**):真哨兵就是最前面那几行(见上面的输出格式),
    //   正文中间的 `[1]: 脚注` 不是哨兵 —— 旧版会把它切进思考块,是"正文缺一段"的一种。
    //   开头之前只允许空白,否则整条哨兵规则不生效(退化成"无哨兵",后面的启发式也就不会武装)。
    if (firstStart >= 0 && text.slice(0, firstStart).trim() !== "") { firstStart = -1; lastEnd = -1; }
    let thinking = "";
    let s = text;
    if (firstStart >= 0) {
      thinking = text.slice(firstStart, lastEnd);
      s = (text.slice(0, firstStart) + "\n" + text.slice(lastEnd)).replace(/^[\s\r\n]+/, "");
    }
    // 启发式兜底(2026-10-05 再收紧):**只在开头真的切到哨兵时**才启用。
    //   而 ENI 系底座压根不吐哨兵、正文里却常有 injection / compliance 这类词,于是开头的
    //   `>` 引用行与 `[...]` 头行(ENI 系强制 `[日期,地点,时间]` 开头)被一起搬进思考,
    //   用户看到的就是"正文被折叠掉了"。现在:没有开头哨兵 = 一个字符都不动。
    const JB_PHRASE = /disregard|injection|fulfillment|complaint|not deepseek|i'?m not deep|i am not deep|jailbreak|unfiltered|no restriction/i;
    if (firstStart >= 0) {
      const _lns = s.split("\n");
      let _i = 0;
      for (; _i < _lns.length; _i++) {
        const _ln = _lns[_i].trim();
        if (_ln === "") continue;            // 空行:跳过(只算分隔,不单独判为残留)
        if (JB_PHRASE.test(_ln)) continue;   // 套话行:归进思考
        break;
      }
      if (_i > 0) {
        thinking += (thinking ? "\n" : "") + _lns.slice(0, _i).join("\n");
        s = _lns.slice(_i).join("\n").replace(/^[\s\r\n]+/, "");
      }
    }
    // 残哨兵碎片清理(网卡截断遗留的半截 [数字]/[数字 / ^数字])
    s = s.replace(/\[\^?\d[0-9A-Za-z_]{1,11}\]/g, "");
    s = s.replace(/\[\^?\d[0-9A-Za-z_]{0,11}$/g, "");
    s = s.replace(/(^|[^A-Za-z0-9])\^\d[0-9A-Za-z_]{0,11}\]/g, "$1");
    s = s.replace(/^[\s\r\n]+/, "");
    const body = s.trim() ? s : "";
    // fail-open:没有真哨兵却被启发式清空 → 还原原文,宁可漏点思考也不吞正文 / 不留空气泡
    if (!body && firstStart < 0) return { body: text, thinking: "" };
    return { body, thinking: thinking.trim() };
  }
  // 向后兼容:旧调用点只要正文。统一走 splitJailbreakPrefix。
  function stripJailbreakPrefix(text) {
    if (!text || !isJailbreakStripOn()) return text;
    return splitJailbreakPrefix(text).body;
  }

  // 2026-05-30 / 4.25: 鱼缸模式剥离 AI 误带的发言人名签(【高冷(女)】/ 冷(女)】 串进气泡)
  // 仅剥开头,且要求名签含性别标记(女/男)或与场景成员名相符,避免误伤正文 【动作】 描写。
  function stripSceneSpeakerLabel(text) {
    if (!text) return text;
    let sceneNames = [];
    try {
      if (window.__multi && window.__multi.getSceneCards) {
        sceneNames = window.__multi.getSceneCards().map(c => (c && c.name) || "").filter(Boolean);
      }
    } catch (e) {}
    let s = text.replace(/^[\s\r\n]+/, "");
    for (let i = 0; i < 2; i++) {
      const m = s.match(/^[^\n]{0,16}?[】\]]\s*[:：]?\s*/);
      if (!m) break;
      const head = m[0];
      const hasGender = /[（(][男女][)）]/.test(head);
      const matchesName = sceneNames.some(n => head.includes(n));
      if (!hasGender && !matchesName) break;
      s = s.slice(head.length);
    }
    return s.trim() || text;
  }

  // 2026-05-30 / 4.25 (⑤): 兜底剥离 <think>...</think> 思考块。
  // 部分模型(尤其 free/NVIDIA 路径)把推理塞进正文且无 [^sentinel] 前缀,stripJailbreakPrefix 漏过 → "爆思考"。
  function stripThinkBlocks(text) {
    if (!text) return text;
    let s = text;
    // 成对闭合的思考块(可跨行)整段删除
    s = s.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "");
    // 开头处未闭合的 <think>(思考尚未输出 </think> 或被截断):砍到结尾
    s = s.replace(/^\s*<think(?:ing)?>[\s\S]*$/i, "");
    // 清理残留的孤立标签
    s = s.replace(/<\/?think(?:ing)?>/gi, "");
    return s.trim() || text;
  }

  // 2026-05-31 / 4.47: 流式显示时像 <think> 一样实时剥离发图信号(含网卡截断的半截),不让它在气泡里闪现
  function stripPhotoSignalLive(text) {
    if (!text) return text;
    try {
      if (window.__chatImageText && window.__chatImageText.stripSignalForDisplay) {
        return window.__chatImageText.stripSignalForDisplay(text);
      }
    } catch (e) {}
    return text;
  }

  // 2026-05-31 / 4.47: 微信模式剥离行为/动作描写(（…）、(…)、*…*),像真人发微信只发聊天文字(prompt 已要求,这里兜底)
  // 4.59 残括号清扫:模型把 [发图:..]/[好感±N]/[next:..] 等标记写崩,留下空壳 []、落单 ]、没数字的 [好感] 之类残体。
  // 正规 stripper 只认完整格式 → 残体漏进气泡和历史(就是用户看到的 [] 方框)。这里统一收尾清理。
  // 注意:成对且有内容的 [xx](如微信表情码 [害羞])保留不动,只清空壳 / 落单括号 / 残缺好感标签。
  function stripUnpairedSquareBrackets(s) {
    const open = [];
    const remove = new Set();
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "[") open.push(i);
      else if (ch === "]") { if (open.length) open.pop(); else remove.add(i); }
    }
    for (const i of open) remove.add(i);
    if (!remove.size) return s;
    let out = "";
    for (let i = 0; i < s.length; i++) if (!remove.has(i)) out += s[i];
    return out;
  }
  function stripResidualMarkup(text) {
    if (!text) return text;
    let s = text;
    // ① 空括号 [] 【】(含空白/全角空格)
    s = s.replace(/[\[【]\s*[\]】]/g, "");
    // ② 残缺好感标签 [好感] / [好感±](正规 [好感±N] 已被 parseAffectionTag 处理,这里清没数字的残体)
    s = s.replace(/[\[【]\s*好感[^\]】\n]*[\]】]/g, "");
    // ③ 空壳信号关键字 [发图]/[发景]/[发]/[next]/[end]/[召唤](没冒号没内容)
    s = s.replace(/[\[【]\s*(发图|发景|发|next|end|召唤)\s*[\]】]/gi, "");
    // ③.5 写崩的发图信号:模型把 [发图:..]/[发景:..] 写崩。
    // 4.70 收紧(修正文被裁):旧版 [发(图|景)?(冒号?)+任意3字] 会把 [发现了…]/[发火了…] 这类正文方括号也删掉。
    // 现要求「发图/发景 关键词完整」或「发+冒号」才当信号删;[发呆]/[发抖]/[发现…] 等正文一律不动。
    s = s.replace(/[\[【]\s*(?:发(?:图|景)[:：]?|发[:：])[^\[\]【】\n]{3,}[\]】]/g, "");
    // ③.6 写崩的结构化发图信号 [[img|…]](少写括号时 chat-image 的容错正则若仍漏过):兜底清掉 [img|…] 残壳
    s = s.replace(/\[{1,2}\s*img\s*\|[^\[\]\n]*\]{0,2}/gi, "");
    // ③.7 氛围音标签 [[amb:…]]/[[mus:…]]/[[voice:…]]:正常收尾路径已执行并剥离(见 applyAmbientTags),
    //     这里兜底"只清不执行" —— 中断兜底/群聊等路径宁可漏一次氛围切换,也不让标签泄漏进气泡。
    s = s.replace(/\[\[\s*(?:amb|mus|music|bgm|voice)\s*[:：][^\[\]\n]*\]\]/gi, "");
    // ④ 落单方括号(信号只剩半个 [ 或 ])
    s = stripUnpairedSquareBrackets(s);
    // 收尾:清空连发段 + 多余空格
    s = s.split("||").map(p => p.trim()).filter(Boolean).join("||");
    return s.replace(/[ \t]{2,}/g, " ").trim();
  }

  function stripWechatActions(text) {
    if (!text) return text;
    let s = text;
    s = s.replace(/（[^（）]*）/g, "");
    s = s.replace(/\([^()]*\)/g, "");
    s = s.replace(/\*[^*\n]+\*/g, "");
    // 清理剥离后残留的空连发段 + 多余空格
    s = s.split("||").map(p => p.trim()).filter(Boolean).join("||");
    s = s.replace(/[ \t]{2,}/g, " ").trim();
    return s || text;
  }

  // 2026-05-30 / 4.25 (⑨): 微信模式兜底拆句——模型没用 || 却吐了长段时,按中文句末标点切成多条短气泡,防"突然跳长篇"。
  // 仅在文本明显偏长(>40 字且能切出 ≥2 条)时才拆;短回复返回空串表示"无需拆"。
  function autoSplitWechat(text) {
    if (!text) return "";
    const t = text.trim();
    if (t.length <= 40) return "";
    const segs = t.match(/[^。！？!?…\n]+[。！？!?…]*[”"』」]?|\n+/g);
    if (!segs) return "";
    const pieces = segs.map(s => s.trim()).filter(s => s && !/^\n+$/.test(s));
    if (pieces.length < 2) return "";
    const merged = [];
    for (const p of pieces) {
      if (merged.length && (merged[merged.length - 1].length + p.length) <= 30) {
        merged[merged.length - 1] += p;
      } else {
        merged.push(p);
      }
    }
    if (merged.length < 2) return "";
    return merged.join("||");
  }

  // 2026-06-24 显示层语音标签清洗:剥句首/行内 [情绪:强度]/[场景:X]/[基调:X] 语音标签。
  // 这些标签是语音/场景标签协议（[键:值]）的产物，不该出现在聊天气泡；真正的「隐藏+转存原文供朗读」在 tts.js 做，
  // 这里同名函数并入清洗管线探针,仅为 dev「清洗管线」面板能逐级看到这一步(也可被其他显示路径复用)。
  // 仅匹配带冒号的「键:值」形态 → wechat 表情码 [害羞]、选项壳 [选项] 等无冒号方括号一律不动。
  function stripVoiceTags(text) {
    if (!text) return text;
    let s = String(text).replace(/\[\s*[^\[\]:：\n]{1,8}\s*[:：]\s*[^\[\]\n]{0,12}\s*\]/g, "");
    s = s.split("||").map(p => p.trim()).filter(Boolean).join("||");
    return s.replace(/[ \t]{2,}/g, " ").trim();
  }

  // 2026-06-24 显示层选择信号清洗(dev 探针):剥 [选项]…[/选项] / [opt]…[/opt] 选择信号块。
  // 真正的「气泡隐藏 + 渲染成可点芯片」由 choices.js 负责(它读气泡 textContent 提取选项后,再从 innerHTML 抹除标签块);
  // 这里同名清洗仅并入 dev「清洗管线」面板,让逐级可见选择信号在哪一步被剥;TTS 侧由 tts.js 在朗读取文本时同样剥除,避免念出选项。
  // 无冒号纯方括号(如 wechat 表情码 [害羞])不属选择信号,不动。
  function stripChoiceSignals(text) {
    if (!text) return text;
    let s = String(text)
      .replace(/\[选项\][\s\S]*?\[\/选项\]/g, "")
      .replace(/\[opt\][\s\S]*?\[\/opt\]/gi, "");
    s = s.split("||").map(p => p.trim()).filter(Boolean).join("||");
    return s.replace(/[ \t]{2,}/g, " ").trim();
  }

  // ── 2026-06-15 清洗管线探针:供 dev 面板逐级追踪"正文在哪一级被裁"。只读,不改任何清洗逻辑。──
  // diffPrefixSuffix:取公共前后缀,中间段即本级的"裁掉/新增"(对前缀哨兵剥离 / 单块删除最直观;
  // 多处零散删除会合并成一个包络段,仍能圈定改动范围)。
  function diffPrefixSuffix(a, b) {
    a = String(a == null ? "" : a); b = String(b == null ? "" : b);
    const max = Math.min(a.length, b.length);
    let p = 0; while (p < max && a[p] === b[p]) p++;
    let s = 0; while (s < (max - p) && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    return { removed: a.slice(p, a.length - s), added: b.slice(p, b.length - s) };
  }
  // window.__pipeline.trace(raw):把模型原始正文依次跑过正文清洗各级,逐级返回 {name,note,text,chars,delta,removed,added,captured}
  window.__pipeline = {
    stripFns: { stripThinkBlocks, splitJailbreakPrefix, stripResidualMarkup, stripVoiceTags, stripChoiceSignals, stripWechatActions, autoSplitWechat, extractThinkText },
    trace(raw, opts) {
      opts = opts || {};
      const stages = [];
      let prev = String(raw == null ? "" : raw);
      stages.push({ name: "原始输出", note: "模型 content 原文(未清洗)", text: prev, chars: prev.length, delta: 0, removed: "", added: "" });
      const step = (name, note, fn) => {
        let out; try { out = fn(prev); } catch (e) { out = prev; }
        out = String(out == null ? "" : out);
        const d = diffPrefixSuffix(prev, out);
        stages.push({ name, note, text: out, chars: out.length, delta: out.length - prev.length, removed: d.removed, added: d.added });
        prev = out;
      };
      step("去 <think> 块", "stripThinkBlocks:删成对/未闭合 <think>…</think>", stripThinkBlocks);
      let split; try { split = splitJailbreakPrefix(prev); } catch (e) { split = { body: prev, thinking: "" }; }
      {
        const out = String(split.body == null ? "" : split.body);
        const d = diffPrefixSuffix(prev, out);
        stages.push({ name: "拆哨兵前缀", note: "splitJailbreakPrefix:剥 [^420]/[^69] 哨兵区间 + 启发式套话行(裁掉的归档进思考折叠块)", text: out, chars: out.length, delta: out.length - prev.length, removed: d.removed, added: d.added, captured: split.thinking || "" });
        prev = out;
      }
      step("去残括号/残标记", "stripResidualMarkup:清空壳 []/【】、残缺 [好感]、写崩的 [发图:] 等", stripResidualMarkup);
      step("去语音/场景标签", "stripVoiceTags:剥句首/行内 [键:值] 标签(显示层隐藏,朗读前也剥;无冒号的 [害羞]/[选项] 不动。多情绪切换系统 2026-10-06 已删,协议本身保留)", stripVoiceTags);
      step("去选择信号块", "stripChoiceSignals:剥 [选项]…[/选项] 选择信号块(choices.js 提取成可点芯片后从气泡抹除;此处仅 dev 可视,TTS 朗读文本时同样剥除不念选项)", stripChoiceSignals);
      if (opts.wechat) {
        step("微信去动作描写", "stripWechatActions:删 （…）/(…)/*…*", stripWechatActions);
        let auto = ""; try { auto = autoSplitWechat(prev) || ""; } catch (e) {}
        stages.push({ name: "微信兜底拆条", note: "autoSplitWechat:长段按句切多条气泡(空=无需拆)", text: auto || prev, chars: (auto || "").length, delta: 0, removed: "", added: auto ? auto : "" });
      }
      let inlineThink = ""; try { inlineThink = extractThinkText(String(raw == null ? "" : raw)); } catch (e) {}
      return { stages, inlineThink, finalBody: prev };
    },
  };

  // ─── Markdown 渲染(供 Agent 模式 + 普通聊天最终气泡 + 历史还原共用)───
  // 处理代码块 / 表格 / 标题 / 粗体 / 行内代码；所有用户数据先 esc()，不引入 XSS。
  // 4.80 fix: 普通聊天(sendOne)流式过程中的临时文字仍用 textContent(简单快);
  // 但流结束后的「最终气泡」改用本函数 + innerHTML,不再是不渲染的纯文本。
  // 2026-09-14 UI第一轮:双路径改造 —— index.html 成功加载 marked+DOMPurify(CDN+SRI)时走
  // 富文本路径(完整 GFM/列表/链接 + 解析期代码高亮 + DOMPurify 消毒);任一库缺失或解析抛错
  // 一律回退 renderMarkdownLegacy(= 原实现原样保留)。15 个调用点/流式 textContent 路径零改动。
  function renderMarkdownSafe(text) {
    if (!text) return "";
    if (typeof window !== "undefined" && window.marked && window.DOMPurify) {
      try { return renderMarkdownRich(text); }
      catch (e) { console.warn("[md] 富文本渲染失败,回退 legacy 渲染器:", e); }
    }
    return renderMarkdownLegacy(text);
  }

  // 富路径:marked 一次性配置(use 扩展/setOptions/DOMPurify hook 只做一次),输出包一层
  // .md-body 容器 —— 气泡本体是 white-space:pre-wrap,而 marked 产出的块级标记间带换行符,
  // 需要恢复 normal 折叠,否则段落间会多出空行(流式/纯文本气泡不经过这里,不受影响)。
  function renderMarkdownRich(text) {
    const marked = window.marked, DP = window.DOMPurify;
    if (!marked.__ownchatPatched) {
      // marked-highlight 的浏览器 UMD 把函数挂在 .markedHighlight 属性上(顶层是 exports 对象),两种形态都兼容
      const mhRaw = window.markedHighlight;
      const mh = !mhRaw ? null : (typeof mhRaw === "function" ? mhRaw : (typeof mhRaw.markedHighlight === "function" ? mhRaw.markedHighlight : null));
      if (mh && window.hljs) {
        marked.use(mh({
          langPrefix: "hljs language-",
          highlight(code, lang) {
            try {
              const l = (lang && hljs.getLanguage(lang)) ? lang : "plaintext";
              return hljs.highlight(code, { language: l, ignoreIllegals: true }).value;
            } catch (_) {
              return String(code).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
            }
          }
        }));
      }
      marked.setOptions({ gfm: true, breaks: true, async: false }); // breaks 与旧渲染器 \n→<br> 行为对齐
      DP.addHook("afterSanitizeAttributes", (node) => {
        if (node.tagName === "A" && node.hasAttribute("href")) {
          node.setAttribute("target", "_blank");
          node.setAttribute("rel", "noopener noreferrer nofollow");
        } else if (node.tagName === "TABLE") {
          node.classList.add("md-table");
        }
      });
      marked.__ownchatPatched = true;
    }
    const html = DP.sanitize(marked.parse(String(text)));
    return '<div class="md-body">' + html + "</div>";
  }

  // legacy 路径(2026-09-14 前的原实现):CDN 库缺失/失败时的回退。
  // 2026-11-08 修(审查 P0): 旧版普通段落与粗体分支把未转义的模型输出原样拼进 innerHTML
  // (`<img onerror=…>` 直接执行),注释却自称"所有用户数据先 esc()"。现改为:
  // 先摘出代码块与原始 <table> 占位,再对**余下全文**整体 esc,之后各分支不再重复 esc;
  // ①b 的原始表格只放行无属性的结构标签(白名单),其余标签保持转义字面量。
  function renderMarkdownLegacy(text) {
    if (!text) return "";
    const esc = window.__ownEscape.esc;
    // ① 提取代码块，防止内部被误处理
    const blocks = [];
    let s = text.replace(/```([\w.-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      const i = blocks.length;
      const langAttr = lang ? ' class="lang-' + esc(lang) + '"' : "";
      blocks.push("<pre><code" + langAttr + ">" + esc(code.replace(/\n$/, "")) + "</code></pre>");
      return "\x00B" + i + "\x00";
    });
    // ①b 保护模型直出的原始 <table> HTML：整块抽出占位，避免被后续 \n→<br> 步骤打散成残骸（残留 </table> 等）；
    //     顺手清掉单元格里模型多写的 **/****，并把 `行内代码` 转成 <code>，渲染更干净。
    //     2026-11-08: 内容整体 esc 后只放行**无属性**的结构标签 —— 旧版把模型 HTML 原样进 innerHTML,
    //     <td><img onerror=…></td> 是现成的注入点(审查发现)。
    s = s.replace(/<table[\s\S]*?<\/table>/gi, (tbl) => {
      const _i = blocks.length;
      const _cleaned = tbl.replace(/\*\*+/g, "").replace(/`([^`\n]+)`/g, "<code>$1</code>");
      blocks.push(esc(_cleaned).replace(/&lt;(\/?)(table|thead|tbody|tr|td|th)&gt;/gi, "<$1$2>"));
      return "\x00B" + _i + "\x00";
    });
    // ①c 余下全文整体转义(进入 ②~⑦ 之前) —— 各分支不再自行 esc(内容已安全)
    s = esc(s);
    // ② 表格（GitHub Flavored Markdown）
    s = s.replace(/((?:^|\n)\|.+\|\n\|[-| :]+\|\n(?:\|.+\|\n?)+)/g, (tbl) => {
      const rows = tbl.trim().split("\n");
      const parseRow = (r) => r.split("|").slice(1, -1).map(c => c.trim());
      const head = parseRow(rows[0]);
      const body = rows.slice(2).map(parseRow);
      const th = head.map(c => "<th>" + c + "</th>").join("");
      const tr = body.map(r => "<tr>" + r.map(c => "<td>" + c + "</td>").join("") + "</tr>").join("");
      return '<table class="md-table"><thead><tr>' + th + '</tr></thead><tbody>' + tr + '</tbody></table>';
    });
    // ③ 标题
    s = s.replace(/^(#{1,4}) (.+)$/gm, (_, h, t) => '<h' + h.length + ' class="md-h">' + t + '</h' + h.length + '>');
    // ④ 行内代码（在 bold/italic 之前；内容已转义，无需再 esc）
    s = s.replace(/`([^`\n]+)`/g, (_, c) => "<code>" + c + "</code>");
    // ⑤ 粗体 / 斜体
    s = s.replace(/\*\*([^*\n]+)\*\*/g, (_, c) => "<strong>" + c + "</strong>");
    s = s.replace(/\*([^*\n]+)\*/g, (_, c) => "<em>" + c + "</em>");
    // ⑥ 水平线
    s = s.replace(/^-{3,}$/gm, "<hr>");
    // ⑦ 换行 → <br>（表格已替换，代码块占位符不含 \n，安全）
    s = s.replace(/\n/g, "<br>");
    // ⑧ 还原代码块
    s = s.replace(/\x00B(\d+)\x00/g, (_, i) => blocks[parseInt(i, 10)]);
    return s;
  }

  // 2026-09-14 附件重构(见 ui/attachments.js):
  //   旧实现把全文塞进 content 且发送后即清空内存 → 「重试」从气泡文字重建消息时全文永久丢失、
  //   刷新后气泡又把几万字原文整个渲染出来。现在改为:
  //   · 待发附件由 window.__attach 保管,发送时快照到消息的 files/images 字段(随 session 持久化)
  //   · content 只存用户实际打的字 → 气泡重渲染渲染 chip 而非原文
  //   · 请求装配时才把全文/图片展开进 payload(expandAttachmentMessages)
  const FENCE = "\x60\x60\x60";
  // 4.83: 截断阈值唯一真源在 attachments.js(__attach.ATT_MAX_CHARS) —— 用下方 attMaxChars() 运行时读取,
  // 不再在此声明常量(旧版 app.js 与 chat-extras 各硬编码一份会漂移)
  function takeAttachments() {
    try { if (window.__attach && window.__attach.takePending) return window.__attach.takePending(); } catch (_) {}
    return { files: undefined, images: undefined, _memImages: [] };
  }
  function attCount() {
    try { return (window.__attach && window.__attach.count) ? window.__attach.count() : 0; } catch (_) { return 0; }
  }
  // 切换会话/角色时清空待发附件(旧实现会把 A 会话附加的文件串到 B 会话发出去)
  function clearPendingAttachments() {
    try { if (window.__attach && window.__attach.clear) window.__attach.clear(); } catch (_) {}
  }
  function attHasAny(att) {
    return !!(att && ((att.files && att.files.length) || (att.images && att.images.length)));
  }
  // 存进消息的元数据(不含 _memImages —— 那只是本轮渲染用的内存 dataURL)
  function attMeta(att) {
    const o = {};
    if (att && att.files && att.files.length) o.files = att.files;
    if (att && att.images && att.images.length) o.images = att.images;
    return o;
  }
  // 附件文本的 token 估算(图片走视觉链路,客户端无法精确估算,不计入)
  // 4.83: 全文已迁移 IndexedDB(消息里只有 {id,name,chars,truncated} 元数据),估算改同步近似:
  // CJK 1 字≈1 token,用 min(chars,上限) —— chars 是原文数,截断后实际发送的是上限值,取 min 才是真实占用量;
  // 旧格式(f.text,历史会话)退回精确估算。
  function attMaxChars() {
    try { return (window.__attach && window.__attach.ATT_MAX_CHARS) || 100000; } catch (_) { return 100000; }
  }
  function attFileTokens(att) {
    if (!att || !att.files || !att.files.length) return 0;
    let n = 0;
    att.files.forEach((f) => {
      if (typeof f.chars === "number" && f.chars) n += Math.min(f.chars, attMaxChars());
      else n += estimateTokens("【文件:" + f.name + "】" + (f.text || ""));
    });
    return n;
  }
  // 2026-09-14 Agent 协议装配(对应 agent-llm-adapter.js 里的 §G-1/§G-2/§G-3 三条约束):
  //   §G-2 带 tool_calls 的助理轮 content 必须为空 —— 模型常在同一轮同时吐正文+工具调用,留着会被上游判非法;
  //   §G-1 带 tool_calls 的助理轮必须回传 reasoning_content —— DeepSeek 硬要求,缺了后续轮次直接 400;
  //   §G-3 tool 轮只保留 role/tool_call_id/content。
  // 同时剥掉 UI 专用字段(_tool / agentRound / agentPreamble / files / images 等),避免污染请求体;
  // speaker* 是 worker 做多角色历史改写要用的,必须保留。
  // opts.dropToolRounds=true 时把工具轮整段剔除(非 Agent 模式发历史时用,防止不支持工具的模型 400)。
  // ─── 2026-10-08 多智能体「每角色独立上下文」：场景键 + 按发言者装配 ───────────────
  // 背景：旧版所有人共用一条 session，请求发上游前由 worker 按当前发言者把别人的话改写成
  // user+【名字】。功能上"能看"，但上下文不分家 —— 换角色/切群聊都在吃同一条历史。
  // 现在：每条消息落库时打"场景键" sc，发请求前按 sc 过滤 + 按发言者投影：
  //   sc = 'group'        群聊（场景成员共同在场）
  //   sc = 'char:<cardId>' 与该角色的单聊（角色之间互不可见）
  //   sc = 'free'         没挂角色的自由对话
  // 旧消息（无 sc）不加限制、两边都算 —— 升级后老会话不会"突然失忆"（有意为之）。
  function currentScopeKey() {
    try {
      const M = window.__multi;
      // 2026-11-09：群聊必须**按会话**分 scope。
      // 原来返回常量 "group"，于是所有群聊共用一段历史 —— 新建会话也带着上一段对话，
      // 角色会接着旧上下文说话（实测新会话里仍能复述上一轮的台词）。
      if (M && M.isMulti && M.isMulti()) {
        let cid = "";
        try { cid = activeConvId ? activeConvId() : ""; } catch (e) { cid = ""; }
        return cid ? ("group:" + cid) : "group";
      }
    } catch (e) {}
    try {
      const c = window.__character && window.__character.getActiveCard ? window.__character.getActiveCard() : null;
      if (c && c.id) return "char:" + c.id;
    } catch (e) {}
    return "free";
  }
  function scopeTag(obj) {
    try { obj.sc = currentScopeKey(); } catch (e) {}
    return obj;
  }
  function scopeLabel(sc) {
    if (sc === "group") return "群聊";
    if (sc === "free") return "自由对话";
    if (sc && sc.indexOf("char:") === 0) return "单聊";
    return "全部";
  }
  // 把共享 session 投影成「某个发言者的上下文」：
  //   ① 场景键过滤 —— 别的角色单聊 / 群聊 与当前场景互不可见（旧消息无标记 → 放行）
  //   ② 发言者投影 —— 别人说的 assistant 降级为 user +【名字】；带 tool_calls 的机器轮
  //      永不投影（agent 循环的协议轮，改了会散架）
  function selectSpeakerView(msgs, opts) {
    const scope = (opts && opts.scope) || currentScopeKey();
    const card = (opts && opts.card) || null;
    const myName = (card && typeof card.name === "string") ? card.name : "";
    const out = [];
    for (const m of msgs || []) {
      if (!m || !m.role) continue;
      if (m._uiOnly) continue;
      // ① 场景键过滤。兼容老数据：旧版群聊统一写 "group"，新键是 "group:<convId>"，
      //    老消息在新键下一律放行（否则升级后历史看起来像被清空）。新写入的一律带会话号。
      if (m.sc && m.sc !== scope && !(scope.indexOf("group:") === 0 && m.sc === "group")) continue;
      // ③ 私有耳语：带 to 的消息只给被指定的那一位。
      // 没有这一步，所有人看到的是同一份公开日志 —— 信息完全一样，所谓"多智能体"就只是换人设。
      if (m.to && myName && m.to !== myName) continue;
      if (m.role === "assistant" && !(Array.isArray(m.tool_calls) && m.tool_calls.length)) {
        const speaker = typeof m.speakerName === "string" ? m.speakerName : "";
        if (myName && speaker && speaker !== myName) {
          out.push({ role: "user", content: "【" + speaker + "】" + (typeof m.content === "string" ? m.content : "") }); // ②
          continue;
        }
      }
      out.push(m);
    }
    return out;
  }

  function sanitizeToolProtocol(msgs, opts) {
    const drop = !!(opts && opts.dropToolRounds);
    const out = [];
    (msgs || []).forEach((m) => {
      if (!m || !m.role) return;
      if (m._uiOnly) return;
      if (m.role === "tool") { if (!drop) out.push({ role: "tool", tool_call_id: m.tool_call_id, content: typeof m.content === "string" ? m.content : String(m.content == null ? "" : JSON.stringify(m.content)) }); return; }
      const hasTC = m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length;
      if (hasTC && drop) return;
      // 2026-11-10: 数组 content（图文混合，Vision）必须原样保留 —— 旧版一律压成 ""，
      // 导致 expandAttachmentMessages 刚注入的图片被这一步静默丢掉。
      const o = { role: m.role, content: typeof m.content === "string" ? m.content : (Array.isArray(m.content) ? m.content : "") };
      if (hasTC) {
        o.content = ""; // §G-2
        o.tool_calls = m.tool_calls;
        if (typeof m.reasoning_content === "string" && m.reasoning_content) o.reasoning_content = m.reasoning_content; // §G-1
      }
      if (typeof m.speakerName === "string") o.speakerName = m.speakerName; // worker 多角色改写依赖
      if (typeof m.speakerId === "string") o.speakerId = m.speakerId;
      out.push(o);
    });
    // 2026-10-08 协议自愈（只走 agent 路径）：历史会话里可能留着旧版停止按钮造成的
    // "悬空 tool_calls / 孤儿 tool 消息"（脏数据已落盘，重启后每次请求被上游 400）。
    // ① 孤儿 tool（全数组没有任何 assistant.tool_calls 声明过该 id）→ 丢；
    // ② 悬空 tool_calls → 紧邻补合成结果（复用内核的配对函数，不另写一份）。
    // worker 侧另有一份同语义的入站净化（不同运行时，作为第二道防线）。
    if (!drop) {
      const declared = new Set();
      for (const m of out) {
        if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
          for (const c of m.tool_calls) if (c && c.id) declared.add(c.id);
        }
      }
      const kept = out.filter((m) => m.role !== "tool" || (m.tool_call_id && declared.has(m.tool_call_id)));
      try {
        if (window.AgentKernel && typeof window.AgentKernel.pairPendingToolCalls === "function") {
          window.AgentKernel.pairPendingToolCalls(kept, "回合被中断，工具结果未知（客户端协议自愈）");
        }
      } catch (e) {}
      return kept;
    }
    return out;
  }


  // 历史还原时图片按 id 从 IndexedDB 取回。
  // 把附件渲染为气泡「上方」的独立一块(chip + 图片卡片),与 ZCode 的呈现一致。
  // 历史还原时图片按 id 从 IndexedDB 取回。
  function renderAttachmentsInto(bubble, att) {
    if (!bubble || !att) return;
    if (!attHasAny(att) && !(att._memImages && att._memImages.length)) return;
    try {
      if (window.__attach && window.__attach.renderInto) {
        window.__attach.renderInto(bubble.parentNode || bubble, att, { before: bubble });
      }
    } catch (_) {}
  }

  // remote-desk：把 PC 截图作为 UI-only 图片消息落进当前会话（不进模型请求）
  // 图片 Blob 由 __attach.putBlob 存 IndexedDB（cfw_chat_images），消息里只留 {id,name,w,h}。
  window.__pcAppendImage = function (meta) {
    try {
      if (!meta || !meta.id) return false;
      var msg = { role: "assistant", content: "", _uiOnly: true, images: [{ id: String(meta.id), name: String(meta.name || "PC 截图"), w: meta.w || 0, h: meta.h || 0, source: "pc" }] };
      try {
        var _card = (window.__character && window.__character.getActiveCard) ? window.__character.getActiveCard() : null;
        if (_card && _card.id) { msg.speakerId = _card.id; msg.speakerName = _card.name; msg.speakerIcon = _card.icon || "🙂"; }
      } catch (_c) {}
      session.push(scopeTag(msg));
      persistSessionIfEnabled();
      var r = makeRow("assistant");
      r.bubble.style.display = "none";
      if (r.stats) r.stats.textContent = "";
      renderAttachmentsInto(r.bubble, { images: msg.images });
      if (msg.speakerName && window.__character && window.__character.decorateAiRow) {
        try { window.__character.decorateAiRow(r.rowEl, { id: msg.speakerId || "", name: msg.speakerName, icon: msg.speakerIcon || "🙂" }); } catch (_) {}
      }
      try { r.rowEl.dataset.sidx = String(session.length - 1); } catch (e) {}
      if (isNearBottom()) scrollToBottom();
      return true;
    } catch (e) { try { window.__pcAppendImageError = String((e && e.stack) || e); console.warn("[pc-image] append failed:", e); } catch (_) {} return false; }
  };

  // 2026-09-14:长用户消息折叠 —— 粘贴长文时把气泡收起来(底部渐隐 + 展开箭头),避免刷屏。
  // 只影响展示:内容完整保留在 session(重试/重新发送都读 session,不读气泡文字),折叠不会丢东西。
  const USER_FOLD_CHARS = 420;
  const USER_FOLD_LINES = 12;
  function applyUserFold(bubble) {
    if (!bubble || bubble.querySelector(":scope > .uc-wrap")) return;
    const raw = bubble.textContent || "";
    if (raw.length <= USER_FOLD_CHARS && raw.split(String.fromCharCode(10)).length <= USER_FOLD_LINES) return;
    const inner = document.createElement("div");
    inner.className = "uc-inner";
    // 只搬文字节点;附件块(att-wrap)留在外面,不参与折叠
    Array.prototype.slice.call(bubble.childNodes).forEach((n) => {
      if (n.nodeType === 1 && n.classList && n.classList.contains("att-wrap")) return;
      inner.appendChild(n);
    });
    if (!inner.childNodes.length) return;
    const wrap = document.createElement("div");
    wrap.className = "uc-wrap folded";
    wrap.appendChild(inner);
    bubble.appendChild(wrap);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "uc-toggle";
    btn.title = "展开全文";
    btn.setAttribute("aria-label", "展开全文");
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const folded = wrap.classList.toggle("folded");
      btn.title = folded ? "展开全文" : "收起";
      btn.setAttribute("aria-label", btn.title);
    });
    bubble.appendChild(btn);
  }

  // 请求装配:把附件展开进 payload(仅内存展开,不改 session —— 所以重试/刷新都不会丢)
  //   · 文件全文:只有**最近一条**带 files 的 user 消息展开全文;更早的文件消息展开前 1000 字
  //     (4.83: 全文已迁移 IndexedDB,经 __attach.fileFullText 异步取回。旧版对所有历史文件消息
  //      每轮全文重发,大文档下成本×轮数且 2-3 轮就撑爆 128K 上游上下文 —— 改为只保留最近文档全文)
  //   · 图片:只展开最后一条 user(避免每轮重发历史图片把 payload/token 撑爆)
  async function expandAttachmentMessages(msgs) {
    const arr = Array.isArray(msgs) ? msgs : [];
    let lastUser = -1, lastFilesUser = -1;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i] && arr[i].role === "user") {
        if (lastUser < 0) lastUser = i;
        if (lastFilesUser < 0 && Array.isArray(arr[i].files) && arr[i].files.length) lastFilesUser = i;
      }
    }
    if (lastUser < 0) return arr;
    const ff = (window.__attach && window.__attach.fileFullText) ? window.__attach.fileFullText : null;
    const attLimit = attMaxChars();
    const EXCERPT = 1000;
    let changed = false;
    const out = arr.slice();
    for (let i = 0; i < out.length; i++) {
      const m = out[i];
      if (!m || m.role !== "user") continue;
      const hasFiles = Array.isArray(m.files) && m.files.length;
      const hasImgs = i === lastUser && Array.isArray(m.images) && m.images.length;
      if (!hasFiles && !hasImgs) continue;
      let content = typeof m.content === "string" ? m.content : "";
      if (hasFiles) {
        const isLatest = i === lastFilesUser;
        const blocks = [];
        for (const f of m.files) {
          let body = "";
          try { body = ff ? await ff(f) : (typeof f.text === "string" ? f.text : ""); } catch (_) { body = (typeof f.text === "string" ? f.text : ""); }
          const note = [];
          if (f.truncated) note.push("(内容过长,已截断到前 " + attLimit + " 字)");
          if (!isLatest && body.length > EXCERPT) {
            body = body.slice(0, EXCERPT);
            note.push("(较早上传的长文档,正文已省略 —— 完整全文仅在刚上传后的回合提供;需要可重新上传或分批粘贴)");
          }
          blocks.push("【文件:" + f.name + "】\n" + FENCE + "\n" + body + "\n" + FENCE + (note.length ? "\n" + note.join(" ") : ""));
        }
        content = content ? content + "\n\n" + blocks.join("\n\n") : blocks.join("\n\n");
      }
      if (hasImgs) {
        const urls = [];
        for (const im of m.images) {
          let u = "";
          try { u = await (window.__attach && window.__attach.imageDataUrl ? window.__attach.imageDataUrl(im) : Promise.resolve("")); } catch (_) {}
          if (u) urls.push(u);
        }
        if (urls.length) {
          content = [{ type: "text", text: content }].concat(urls.map((u) => ({ type: "image_url", image_url: { url: u } })));
        }
      }
      // 刻意只保留 role/content:files/images 若一起回传,文件全文会在 payload 里重复一份
      out[i] = { role: m.role, content };
      changed = true;
    }
    return changed ? out : arr;
  }

  function estimateTokens(text) {
    if (!text) return 0;
    let cjk = 0, ascii = 0;
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      if (ch === " " || ch === "\n" || ch === "\t" || ch === "\r") continue;
      const isCJK =
        (code >= 0x4E00 && code <= 0x9FFF) ||
        (code >= 0x3400 && code <= 0x4DBF) ||
        (code >= 0x3040 && code <= 0x30FF) ||
        (code >= 0xAC00 && code <= 0xD7AF) ||
        (code >= 0xFF00 && code <= 0xFFEF);
      if (isCJK) cjk++; else ascii++;
    }
    return cjk + Math.ceil(ascii / 4);
  }

  // ── 2026-11-08 压缩触发辅助（对标 ZCode auto-compact 的水位判定）──
  // 当前模型上下文窗口：手动覆盖 > worker /config.js 下发的 APP_CTX_EXACT/HINTS > 128K 兜底
  // （与右栏状态面板的 ctxWindow 同一套数据源；此处独立实现是因为核心 IIFE 不引外部模块）
  function _ctxLimitForCompact() {
    let v = 0;
    try { v = parseInt(localStorage.getItem("cfw_ctx_window_v1"), 10) || 0; } catch (e) {}
    if (v >= 1024) return v;
    try {
      const mid = (document.getElementById("modelSel") || {}).value || localStorage.getItem("cfw_model") || "";
      const exact = window.APP_CTX_EXACT || {};
      if (mid && exact[mid]) return exact[mid];
      const hints = Array.isArray(window.APP_CTX_HINTS) ? window.APP_CTX_HINTS : [];
      for (let i = 0; i < hints.length; i++) {
        try { if (new RegExp(hints[i][0], "i").test(mid)) return hints[i][1]; } catch (e) {}
      }
    } catch (e) {}
    return 131072;
  }
  // 会话 token 估算（仅文本内容；附件全文在 IDB，发送时才计价，不进水位）
  function _sessTokensForCompact() {
    let t = 0;
    for (const m of session) {
      if (m && typeof m.content === "string") t += estimateTokens(m.content);
    }
    return t;
  }
  function updateSpacer() {
    if (!composerEl || !spacerEl) return;
    const rect = composerEl.getBoundingClientRect();
    const rootStyle = getComputedStyle(document.documentElement);
    const gap   = parseFloat(rootStyle.getPropertyValue("--composer-gap")) || 18;
    const extra = parseFloat(rootStyle.getPropertyValue("--spacer-extra"))  || 28;
    // 4.83: 键盘兜底路径(--kb>0,布局视口未收缩的 WebView)下,聊天流底部要让出键盘高度
    const kb    = parseFloat(rootStyle.getPropertyValue("--kb")) || 0;
    const h = Math.ceil(rect.height + gap + extra + kb);
    spacerEl.style.height = h + "px";
    historyWrap.style.scrollPaddingBottom = h + "px";
  }

  function isNearBottom() {
    return (historyWrap.scrollHeight - historyWrap.scrollTop - historyWrap.clientHeight) < 120;
  }

  // 4.19 P0: 流式期间 scroll 抖动优化 - RAF 节流防止每 delta chunk 触发 reflow
  // root cause: 每 chunk 触发 isNearBottom() + scrollTo 两次同步布局查询,高频流式下打架主线程
  // 改 RAF: 每帧最多 1 次重排负载,多次调用合并到下一帧
  let _scrollRafPending = false;
  function scrollToBottom() {
    // 2026-10-07 拖动卡顿修复（E-A）：触摸/滚轮交互中不抢滚动位置（该时间戳由 chat-ux.js 维护）。
    // 旧版流式期间每个 delta 都可能把位置拽回底部 —— 手指按住滚动时就是「拉锯」。
    if (Date.now() < (window.__scrollTouchUntil || 0)) return;
    if (_scrollRafPending) return;
    _scrollRafPending = true;
    requestAnimationFrame(() => {
      _scrollRafPending = false;
      historyWrap.scrollTo({ top: historyWrap.scrollHeight, behavior: "auto" });
    });
  }

  // 鱼缸 V3:opts.side === "right" 时给 AI row 加 .side-right,吐槽姬模式下气泡贴右(头像/气泡用 flex-direction:row-reverse 翻转)
  // opts.moderator === true 时改 .row.moderator 居中(主持人/旁白介入)
  function makeRow(role, opts) {
    const row = document.createElement("div");
    row.className = "row " + (role === "user" ? "user" : "ai");
    if (opts && opts.side === "right" && role !== "user") row.classList.add("side-right");
    if (opts && opts.moderator) row.classList.add("moderator");
    const avatar = document.createElement("div");
    avatar.className = "avatar " + (role === "user" ? "human" : "bot");
    avatar.textContent = role === "user" ? "U" : "B";
    const content = document.createElement("div");
    content.className = "content";
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = role === "user" ? "User" : "Bot";
    const bubble = document.createElement("div");
    bubble.className = "bubble " + (role === "user" ? "user" : "ai");
    const stats = document.createElement("div");
    stats.className = "stats";
    let reasoning = null;
    if (role !== "user") {
      reasoning = document.createElement("details");
      reasoning.className = "reasoning-block";
      reasoning.style.display = "none";
      const rsum = document.createElement("summary");
      // 2026-06-15: 思考过程标题改用线性 SVG(对齐顶栏 ICONS 设计语言),替换原裸 emoji 💭
      rsum.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px;margin-right:6px;"><path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.5.4.9 1 .9 1.7v.5h5.4v-.5c0-.7.4-1.3.9-1.7A6 6 0 0 0 12 3Z"/></svg><span>思考过程</span>';
      const rtxt = document.createElement("div");
      rtxt.className = "reasoning-text";
      reasoning.appendChild(rsum);
      reasoning.appendChild(rtxt);
    }
    content.appendChild(meta);
    if (reasoning) content.appendChild(reasoning);
    content.appendChild(bubble);
    content.appendChild(stats);
    if (role === "user") {
      row.appendChild(content);
      row.appendChild(avatar);
    } else {
      row.appendChild(avatar);
      row.appendChild(content);
    }
    chatEl.insertBefore(row, spacerEl);
    if (isNearBottom()) scrollToBottom();
    return { rowEl: row, bubble, stats, reasoning };
  }

  function clearUIRows() {
    const nodes = Array.from(chatEl.children);
    for (const n of nodes) {
      if (n === spacerEl) continue;
      // 2026-11-08 修(审查 P2): 群聊头部/摘要 chip 由 renderHeader 自管理,清行连删会消失到下次角色切换
      if (n.id === "wechatGroupHeader" || n.id === "summaryChip") continue;
      chatEl.removeChild(n);
    }
  }

  // ───────── 会话系统(2026-09-14 重做:会话与角色卡解绑)─────────
  // 旧模型:槽位键 = "<角色卡ID>#<会话ID>" —— 角色卡是外层维度,于是「切角色」= 换整份历史、
  //         「会话列表」只能列当前角色的会话、多人模式下干脆没有会话概念(全部共用 __scene__ 一条)。
  // 新模型:槽位键 = 平铺的 convId(如 "c_m3kq_ab12");角色只是会话的一个字段
  //         (注册表里的 charId = 「这个会话在跟谁聊」)。于是:
  //           · 切角色不再换槽、不再清空历史 —— 只是后续回复换人(助理消息本就自带 speakerId/speakerName)
  //           · 「新对话」= 真的新建一个空会话
  //           · 多人/群聊不再共用全局 __scene__ 槽,各自是独立会话(一条对话放多角色消息是现成能力)
  //         LS 键名沿用不变 → 云同步 /sync/chat 的契约(键=不透明字符串)零改动。
  const LS_CONV_ACTIVE = "cfw_conv_active_v1"; // 当前会话 id(设备本地,不同步 → sync.js PROTECTED)
  const LS_CONV_META   = "cfw_conv_meta_v1";   // { [convId]: { name, createdAt, updatedAt, charId } } 平铺注册表
  const CONV_PREFIX = "c_";
  function newConvId() { return CONV_PREFIX + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6); }
  function isConvId(id) { return typeof id === "string" && id.indexOf(CONV_PREFIX) === 0; }
  function loadActiveConvRaw() { try { return localStorage.getItem(LS_CONV_ACTIVE) || ""; } catch { return ""; } }
  function setActiveConvId(id) { try { if (id) localStorage.setItem(LS_CONV_ACTIVE, id); else localStorage.removeItem(LS_CONV_ACTIVE); } catch {} }
  function activeCardId() {
    try {
      const c = window.__character && window.__character.getActiveCard ? window.__character.getActiveCard() : null;
      return c && c.id ? c.id : "";
    } catch { return ""; }
  }
  // 写/更新注册表条目(时间戳由这里统一维护)
  function touchConv(convId, patch) {
    if (!isConvId(convId)) return;
    const meta = loadConvMeta();
    const prev = meta[convId] || {};
    meta[convId] = Object.assign({ name: "新对话", createdAt: Date.now() }, prev, patch || {}, { updatedAt: Date.now() });
    saveConvMeta(meta);
  }
  function convCharId(convId) { const m = loadConvMeta(); return (m[convId] && m[convId].charId) || ""; }
  function setConvCharId(convId, charId) { if (isConvId(convId)) touchConv(convId, { charId: charId || "" }); }
  // 本机「默认会话」的 id 固定(按设备 id 派生)。若用随机 id,多标签页 / 重复调用同时需要
  // 建默认会话时会各建一条 → 列表里出现两条一模一样的「主对话」。固定 id 让它们收敛到同一条。
  const MAIN_CONV_PREFIX = "c_main_";
  function getMainConvId() { return MAIN_CONV_PREFIX + getDeviceId(); }
  // 当前会话 id;没有(首启 / 被删 / 注册表异常)就建一个「主对话」
  function ensureDefaultConv() {
    const raw = loadActiveConvRaw();
    if (isConvId(raw)) {
      const meta = loadConvMeta();
      if (meta[raw]) return raw;
      if (Array.isArray(loadAllSessions()[raw])) { touchConv(raw, { name: "主对话" }); return raw; } // 有消息没登记 → 补登记,别丢
    }
    const id = getMainConvId();
    if (!loadConvMeta()[id]) touchConv(id, { name: "主对话", charId: activeCardId() });
    setActiveConvId(id);
    return id;
  }
  // 一次性去重:历史随机 id 版本可能留下多条空的「主对话」,只保留当前这条,其余删掉(仅动全空的)
  function dedupeDefaultConvs() {
    try {
      if (localStorage.getItem("cfw_conv_dedup_v1") === "1") return;
      const cur = loadActiveConvRaw();
      const all = loadAllSessions();
      const meta = loadConvMeta();
      let n = 0;
      Object.keys(meta).forEach((k) => {
        if (!isConvId(k) || k === cur) return;
        if ((meta[k] || {}).name !== "主对话") return;
        if (Array.isArray(all[k]) && all[k].length) return; // 有消息的不动
        delete meta[k];
        delete all[k];
        delete _memSlots[k];
        n++;
      });
      if (n) {
        saveConvMeta(meta);
        if (Object.keys(all).length) localStorage.setItem(LS_CHAT_SESSION, JSON.stringify(all));
        console.log("[conv] 已合并重复的空默认会话:", n, "条");
      }
      localStorage.setItem("cfw_conv_dedup_v1", "1");
    } catch {}
  }
  function activeConvId() { ensureDefaultConv(); reconcileDuplicateMains(); return loadActiveConvRaw() || ensureDefaultConv(); }
  // 2026-09-14:合并「重复的空主对话」。原来用一次性开关做迁移,开关置位后新产生的重复
  // (多标签/清理数据后重建)就再也不会被合并 → 左栏出现两条一模一样的「主对话」。
  // 改为每次触碰会话时顺手检查,但**只在确实有 2 条以上时**才动手 —— 否则会把唯一那条空主对话
  // 也删掉(新建空会话后"主对话"凭空消失)。保留优先级:当前会话 → 规范 id → 最早创建。
  function reconcileDuplicateMains() {
    try {
      const meta = loadConvMeta();
      const all = loadAllSessions();
      const cur = loadActiveConvRaw();
      const isEmptyMain = (k) => isConvId(k) && (meta[k] || {}).name === "主对话" &&
        (!Array.isArray(all[k]) || all[k].length === 0) &&
        (!Array.isArray(_memSlots[k]) || _memSlots[k].length === 0);
      const mains = Object.keys(meta).filter(isEmptyMain);
      if (mains.length <= 1) return; // 只有一条就不是重复,别动
      const mainId = getMainConvId();
      const keep = mains.indexOf(cur) >= 0 ? cur
        : (mains.indexOf(mainId) >= 0 ? mainId
          : mains.slice().sort((a, b) => ((meta[a] || {}).createdAt || 0) - ((meta[b] || {}).createdAt || 0))[0]);
      const dups = mains.filter((k) => k !== keep);
      dups.forEach((k) => { delete meta[k]; delete all[k]; delete _memSlots[k]; writeChatTombstone(k); });
      saveConvMeta(meta);
      if (Object.keys(all).length) localStorage.setItem(LS_CHAT_SESSION, JSON.stringify(all));
      else localStorage.removeItem(LS_CHAT_SESSION);
      console.log("[conv] 已合并重复的空主对话:", dups.length, "条(保留", keep, ")");
    } catch {}
  }
  function currentSlotKey() { return activeConvId(); }
  // 把会话记住的角色应用为当前角色。
  // setActiveId 会 fire character:changed,但新版的处理器不再切槽/清空,所以安全。
  function applyConvChar(convId) {
    try {
      const want = convCharId(convId);
      const cur = activeCardId();
      if (want && want !== cur) {
        if (window.__character && window.__character.setActiveId) window.__character.setActiveId(want);
        // 2026-10-08: 这一步是「会话记住的角色」在切回来 —— 字段随云同步跨设备回灌，
        // 用户看不到来源就会觉得"莫名其妙被挂上了某个角色"（实证询问过）。给一次可见提示。
        try {
          const c = (window.__character && window.__character.getActiveCard && window.__character.getActiveCard()) || null;
          if (c && c.name) toastMsg("已按「会话记住的角色」切到 " + c.name + "（不是刚选的；左栏角色面板可换）", 4200);
        } catch (e) {}
      } else if (!want && cur) {
        setConvCharId(convId, cur); // 会话没记角色(老默认会话)→ 记下当前的
      }
    } catch {}
  }
  // 清掉输入框上方的「选项芯片」(agent offer_choices / [选项] 解析产出)。
  // 2026-09-14 fix:芯片是挂在输入框上方的**独立元素**,不在聊天记录里 —— clearUIRows() 带不走它。
  // 所以切换/新建/删除会话时必须显式清,否则上一条对话的选项会残留在新会话上方。
  function clearChoiceChips() {
    try { if (window.__choices && window.__choices.clearChoices) window.__choices.clearChoices(); } catch (_) {}
  }
  // 2026-09-14:Agent 最大工具轮数 —— 原来写死内核默认 8 轮,跑到上限就一句「已达最大轮数」收场,
  // 复杂任务(多文件读写 / 多轮检索)不够用。现在可在设置里改(1~50,默认 8)。
  //   confirm 变更前确认:有副作用的操作都要问
  //   auto    自动编辑  :文件类直接做,影响全局的(改设置/换模型)仍问
  //   plan    计划模式  :只做只读调查,一律不动手,先给计划
  //   full    完全访问  :不再确认
  const AGENT_FILE_TOOLS = ["write_file", "read_file", "edit_file", "list_files", "delete_file"];
  function getAgentWorkMode() {
    try {
      const m = localStorage.getItem("cfw_agent_work_mode_v1");
      return (m === "auto" || m === "plan" || m === "full") ? m : "confirm";
    } catch (e) { return "confirm"; }
  }
  // 把工作模式编译成内核要的 ensurePermission(name, args) => Promise<boolean>
  function makeAgentPermission(mode, askBase) {
    let pcApproved = false; // 2026-11-10: 远程电脑工具一轮只问一次 —— 点一下问一次没法用
    return async function (name, args) {
      if (mode === "full") return true;   // 完全访问
      if (mode === "plan") return false;  // 计划模式:只读调查,一律不放行写操作
      const isFile = AGENT_FILE_TOOLS.indexOf(String(name)) >= 0;
      if (mode === "auto" && isFile) return true;
      const isPc = String(name || "").indexOf("pc_") === 0;
      if (isPc && pcApproved) return true;
      // 2026-11-11: 免确认开关（设置 → 远程电脑）。plan 模式除外——计划模式本意就是只读。
      if (isPc && mode !== "plan") {
        try { if (localStorage.getItem("cfw_pc_skip_confirm_v1") === "1") return true; } catch (e) {}
      }
      if (typeof askBase === "function") {
        try {
          const ok = await askBase(name, args);
          if (ok && isPc) pcApproved = true;
          return ok;
        } catch (e) { return false; }
      }
      return false; // 没有可用的询问 UI 时保守拒绝(有副作用的操作不静默放行)
    };
  }
  // 计划模式追加的系统指令:告诉模型只出计划、别动手
  const AGENT_PLAN_DIRECTIVE = "\n\n【本次为计划模式】你可以调用只读工具(fetch_page / web_search / read_file / list_files 等)做调查,但**不要执行任何有副作用的操作**(写文件、改角色卡/设定集/指令模块/设置、换主题换模型等)。调查清楚后,输出一份分步计划(要做什么、涉及哪些文件、风险点),等用户确认后再执行。";
  const LS_AGENT_MAX_ROUNDS = "cfw_agent_max_rounds_v1";
  function getAgentMaxRounds() {
    // 2026-10-13 批 H：默认不限——未设/留空/0/非法值一律返回 1000（实务上限，与自驱引擎
    // MAX_ROUNDS_HARD 同款防线：仅防意外失控烧钱）；手填 1~1000 = 硬上限。
    try {
      const raw = (localStorage.getItem(LS_AGENT_MAX_ROUNDS) || "").trim();
      if (!raw) return 1000;
      const n = parseInt(raw, 10);
      if (!isFinite(n) || n <= 0) return 1000;
      return Math.min(1000, n);
    } catch (e) { return 1000; }
  }
  // 切到某个会话之后要做的事:清 UI + 应用角色 + 还原历史(新建与切换共用)
  function loadConvIntoUI(id) {
    session.length = 0;
    clearUIRows();
    clearPendingAttachments();
    clearChoiceChips();
    applyConvChar(id);
    if (!memRestoreSlot(id) && historyEnabled) restoreSessionIfEnabled();
    renderSummaryChip();
    updateSpacer();
    scrollToBottom();
    if (window.__navHideReset) window.__navHideReset(); // 复位顶栏,清掉残留 nav-hidden 占位块
  }

  // 2026-09-14 会话系统重做(选择了「清空重来」):把旧格式槽位一次性清掉。
  //   旧键形如 "<角色卡ID>#<会话ID>"(含 "#")或裸 "<角色卡ID>";新键是平铺的 "c_..."。
  //   逐键写删除墓碑 —— 否则开着云同步时,旧数据会被 pull 回来变成一堆列表里看不见的孤儿槽。
  //   同时把旧的「按角色嵌套」的会话名注册表拍平(只保留平铺条目)。用 LS 标记保证只跑一次。
  function purgeLegacyConvs() {
    try {
      if (localStorage.getItem("cfw_conv_purged_v2") === "1") return;
      const all = loadAllSessions();
      let n = 0;
      for (const k of Object.keys(all)) {
        if (isConvId(k)) continue;
        writeChatTombstone(k);
        delete all[k];
        delete _memSlots[k];
        n++;
      }
      if (Object.keys(all).length) localStorage.setItem(LS_CHAT_SESSION, JSON.stringify(all));
      else localStorage.removeItem(LS_CHAT_SESSION);
      // 会话名注册表:丢掉旧的嵌套条目,只留平铺的
      const meta = loadConvMeta();
      const flat = {};
      for (const k of Object.keys(meta)) if (isConvId(k)) flat[k] = meta[k];
      saveConvMeta(flat);
      // 旧的槽位时间戳同样清掉,避免和墓碑打架
      try {
        const sm = JSON.parse(localStorage.getItem(LS_CHAT_SLOT_META) || "{}") || {};
        const sm2 = {};
        for (const k of Object.keys(sm)) if (isConvId(k)) sm2[k] = sm[k];
        localStorage.setItem(LS_CHAT_SLOT_META, JSON.stringify(sm2));
      } catch {}
      localStorage.setItem("cfw_conv_purged_v2", "1");
      console.log("[conv] 已清理旧格式对话槽位:", n, "个");
    } catch {}
  }
  function loadAllSessions() {
    try {
      const raw = localStorage.getItem(LS_CHAT_SESSION);
      if (!raw) return {};
      const obj = JSON.parse(raw);
      if (Array.isArray(obj)) return { "__none__": obj };
      return (obj && typeof obj === "object") ? obj : {};
    } catch { return {}; }
  }
  // 4.76: 云同步会话级合并钩子 —— 记录每个 slot 最后修改时间 / 删除墓碑
  // 供 sync.js /sync/chat 做 slot 级合并 + 3-way 冲突检测 + 跨设备删除;写入走 setItem 会被 sync.js monkey-patch 转发为 markChatDirty
  const LS_CHAT_SLOT_META = "cfw_chat_slot_meta_v1";
  const LS_CHAT_TOMB      = "cfw_chat_tomb_v1";
  function bumpSlotMeta(slotKey) {
    if (!slotKey) return;
    try {
      const m = JSON.parse(localStorage.getItem(LS_CHAT_SLOT_META) || "{}") || {};
      m[slotKey] = { updatedAt: Date.now(), deviceId: getDeviceId() };
      localStorage.setItem(LS_CHAT_SLOT_META, JSON.stringify(m));
    } catch {}
  }
  function writeChatTombstone(slotKey) {
    if (!slotKey) return;
    try {
      const t = JSON.parse(localStorage.getItem(LS_CHAT_TOMB) || "{}") || {};
      t[slotKey] = { deletedAt: Date.now(), deviceId: getDeviceId() };
      localStorage.setItem(LS_CHAT_TOMB, JSON.stringify(t));
    } catch {}
  }
  function persistSessionIfEnabled() {
    if (!historyEnabled) return;
    try {
      const all = loadAllSessions();
      // 4.69 fix: 不直接 splice 活跃 session ——
      // 旧版 while 循环直接 session.splice(0,2) 裁剪内存里的 session，
      // UI 气泡不动但下一轮给 AI 的上下文已悄悄变短（AI 静默失忆），用户完全察觉不到。
      // 改为操作副本 trimmed，原 session 始终完整；只有 localStorage 里保存的是截短版。
      const trimmed = session.slice();
      all[currentSlotKey()] = trimmed;
      let data = JSON.stringify(all);
      // 4.82 fix: 超 2MB 时先按"每条消息平均字节数"一次性估算裁剪量,再小步校准,
      // 替代旧版"每删 2 条就把整个 blob 重新 stringify 一遍"的 O(n²) 热路径(每条消息/切角色/退后台都会走到)。
      const LS_LIMIT = 2 * 1024 * 1024;
      if (data.length > LS_LIMIT && trimmed.length > 2) {
        const perMsg = Math.max(1, Math.floor(JSON.stringify(trimmed).length / Math.max(1, trimmed.length)));
        const overshoot = data.length - LS_LIMIT;
        let cut = Math.min(trimmed.length - 2, Math.ceil(overshoot / perMsg / 2) * 2);
        if (cut > 0) trimmed.splice(0, cut);
        all[currentSlotKey()] = trimmed;
        data = JSON.stringify(all);
        while (data.length > LS_LIMIT && trimmed.length > 2) {
          trimmed.splice(0, 100);
          all[currentSlotKey()] = trimmed;
          data = JSON.stringify(all);
        }
      }
      localStorage.setItem(LS_CHAT_SESSION, data);
      bumpSlotMeta(currentSlotKey()); // 4.76: 记录本 slot 最后修改时间(供 /sync/chat slot 级合并)
    } catch {}
  }

  // 4.80: 把消息数组渲染进聊天 UI 的公共逻辑,从 restoreSessionIfEnabled 中拆出,
  // 供「本地存储持久化历史」与「运行期内存槏缓存(memRestoreSlot)」两条路径共用。
  function renderSessionIntoUI(arr) {
    session.length = 0;
    // 4.83: 累计器以「当前载入的会话」为准重置重算(下方行循环里逐条累加) ——
    // 此前刷新/切会话后 Total 沿用旧值或归零不重建,与可见的统计行脱节。
    totalInEstimate = 0;
    totalOutEstimate = 0;
    for (const m of arr) {
      if (!m || typeof m.content !== "string") continue;
      const _role = m.role;
      if (_role !== "user" && _role !== "assistant" && _role !== "tool") continue;
      const e = { role: _role, content: m.content };
      const _hasTC = _role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length;
      // 2026-09-14 Agent 循环写回的消息:必须原样保住 tool_calls / tool_call_id / 工具元数据,
      // 否则刷新后循环上下文再次丢失(旧实现在这里把非 user/assistant 的 role 与所有额外字段都过滤掉了)。
      if (_hasTC) {
        e.tool_calls = m.tool_calls;
        if (typeof m.agentPreamble === "string" && m.agentPreamble) e.agentPreamble = m.agentPreamble;
      }
      if (_role === "tool") {
        if (typeof m.tool_call_id === "string") e.tool_call_id = m.tool_call_id;
        if (m._tool && typeof m._tool === "object") e._tool = m._tool;
      }
      // 2026-10-08 多智能体独立上下文：场景键必须随会话持久化 —— 这里是重建 session 的唯一入口，
      // 漏了它刷新后所有消息都变"无标记"，按角色隔离当场失效。
      if (typeof m.sc === "string" && m.sc) e.sc = m.sc;
      if (_role === "assistant" && typeof m.reasoning_content === "string" && m.reasoning_content) {
        e.reasoning_content = m.reasoning_content;
      }
      if (_role === "assistant") {
        if (typeof m.speakerId === "string") e.speakerId = m.speakerId;
        if (typeof m.speakerName === "string") e.speakerName = m.speakerName;
        if (typeof m.speakerIcon === "string") e.speakerIcon = m.speakerIcon;
        // 2026-10-05: 来源标注(模型+底座)是会话数据的组成部分,还原时必须保住 ——
        // 这里是从存储重建 session 的唯一入口,漏一个字段就等于刷新后标注全丢。
        if (m._meta && typeof m._meta === "object") e._meta = m._meta;
      }
      // remote-desk: UI-only 图片消息（PC 截图）随 session 还原
      if (Array.isArray(m.images) && m.images.length) e.images = m.images;
      if (m._uiOnly) e._uiOnly = true;
      // 2026-09-14: user 消息的附件元数据随 session 一起还原(文件 chip + 图片卡片),
      // 图片 Blob 本体在 IndexedDB(见 ui/attachments.js),此处只留 {id,name,w,h}
      if (_role === "user") {
        if (Array.isArray(m.files) && m.files.length) e.files = m.files;
        if (Array.isArray(m.images) && m.images.length) e.images = m.images;
      }
      session.push(e);
    }
    clearUIRows();
    let _roundNo = 0;
    // 2026-09-14:Agent 工具轮不单独占行 —— 它们累积起来,作为「过程块」挂到**紧随其后的那条最终回答**上
    // (对齐 ZCode:过程在气泡上方收起成一行摘要,正文回答在下面,一个回合一块,不散成一堆行)
    let _pendingTurns = [];
    function _flushTurnsInto(rowEl) {
      if (!rowEl || !_pendingTurns.length) return;
      const bubble = rowEl.querySelector(".bubble");
      if (!bubble) return;
      // 该行已把「思考 + 工具轮」收进过程面板 → 标记它,让 CSS 隐藏独立的思考折叠块(避免同一段思考出现两次)
      try { rowEl.dataset.agentProcess = "1"; } catch (_) {}
      // 2026-09-14:一个回合只出**一个**面板,多轮合并进去(原来是每轮一个面板 → 一堆并列的面板)
      try { window.__agentSteps && window.__agentSteps.renderTurn(bubble, { rounds: _pendingTurns.slice() }); } catch (_e) {}
      _pendingTurns = [];
    }
    for (let _i = 0; _i < session.length; _i++) {
      const m = session[_i];
      if (m.role === "tool") continue;
      // 工具轮:收集成过程块,不建行
      if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        try {
          const _toolMsgs = [];
          for (let _j = _i + 1; _j < session.length && session[_j].role === "tool"; _j++) _toolMsgs.push(session[_j]);
          const _calls = m.tool_calls.map((tc, _k) => {
            const tm = _toolMsgs[_k] || {};
            const meta = tm._tool || {};
            let args = null;
            try { args = (tc.function && tc.function.arguments) ? JSON.parse(tc.function.arguments) : null; } catch (_e) {}
            return {
              name: meta.name || (tc.function && tc.function.name) || "tool",
              args: (meta.args !== undefined) ? meta.args : args,
              ok: meta.ok !== false,
              ms: meta.ms,
              error: meta.error,
              denied: !!meta.denied,
              result: tm.content,
            };
          });
          const _turn = { round: ++_roundNo, calls: _calls };
          // 该轮若带可见正文(模型边说话边调工具),把这段文字也放进过程块
          if (m.agentPreamble) _turn.preamble = m.agentPreamble;
          // 该轮思考也归入过程块顶部(与实时路径一致 → 思考/工具/正文是一条连续工作流)
          if (m.reasoning_content) _turn.thinking = m.reasoning_content;
          _pendingTurns.push(_turn);
        } catch (_ags) {}
        continue;
      }
      // 2026-10-08 修「user 头上也有调用工具」：过程块**只能挂到 AI 行**。
      // 旧版对每一行都调 _flushTurnsInto(rowEl)，于是"工具轮后面直接跟 user 消息"这种历史形状
      // （中断/丢弃半截回合后的常见落库形状：assistant(tool_calls)+tool 之后没有最终 assistant）
      // 会把过程块挂进**用户行** —— 渲染出来就是"用户消息头上带了工具调用"。
      // 现在：user 行之前先补一条合成 AI 行托住过程块（空气泡隐藏），保持"过程属于上一轮"的位置感。
      let r;
      if (m.role === "user") {
        if (_pendingTurns.length) {
          try {
            const _r0 = makeRow("assistant");
            _flushTurnsInto(_r0.rowEl);
            if (_r0.bubble && !String(_r0.bubble.textContent || "").trim()) _r0.bubble.style.display = "none";
          } catch (_pf) {}
        }
        r = makeRow("user");
      } else {
        r = makeRow("assistant");
        if (!m._uiOnly) _flushTurnsInto(r.rowEl);
      }
      // 2026-10-08: 行上记真实 session 下标 —— Agent 工具轮不建行（折进"紧随其后的最终回答"），
      // 所以 DOM 行号 ≠ session 下标。重试/删除按这个下标算，否则会错位截断、留下悬空
      // tool_calls 落盘（"重启后每次请求被上游 400"的根源）。
      try { r.rowEl.dataset.sidx = String(_i); } catch (_sx) {}
      const _visText = m.content;
      // Bug3 fix: agent 回复用 innerHTML 渲染 Markdown(还原时 textContent 会把 <table class="md-table"> 显示为文本)
      if (m.role === "assistant") { r.bubble.innerHTML = renderMarkdownSafe(_visText); } else { r.bubble.textContent = _visText; }
      // 2026-09-14: 还原附件(chip 立即渲染;图片卡片从 IndexedDB 取 Blob 异步补上)
      if ((m.role === "user" || m.role === "assistant") && ((m.files && m.files.length) || (m.images && m.images.length))) {
        renderAttachmentsInto(r.bubble, { files: m.files, images: m.images });
        if (m.role === "assistant" && !String(m.content || "").trim()) r.bubble.style.display = "none";
      }
      if (m.role === "user") applyUserFold(r.bubble); // 长消息折叠(与有没有附件无关)
      // 4.83: 重建历史行的上下文统计 —— 旧版恢复时一律清空,刷新/切会话后「上下文统计」全部消失。
      // 内容就在 session 里:估算量精确重算并续上累计器;真实 usage 无法恢复,AI 行按
      // 「Output(估算)」约定展示(与免费模式实时路径同一格式)。
      if (m.role === "user") {
        const _inEst = estimateTokens(m.content) + attFileTokens({ files: m.files });
        totalInEstimate += _inEst;
        r.stats.textContent = `Input(估算): ≈${_inEst} | Total In(估算): ≈${totalInEstimate}`;
      } else if (m.role === "assistant") {
        const _outEst = estimateTokens(m.content);
        totalOutEstimate += _outEst;
        r.stats.textContent = `Output(估算): ≈${_outEst} | Total Out(估算): ≈${totalOutEstimate}`;
      } else {
        r.stats.textContent = "";
      }
      if (m._uiOnly) r.stats.textContent = "";
      if (m.reasoning_content && r.reasoning) {
        r.reasoning.querySelector(".reasoning-text").textContent = m.reasoning_content;
        applyThinkDisplay(r.reasoning); // 4.70 还原历史也按「思考过程显示」设置
      }
      if (m.role === "assistant" && m.speakerName) {
        // 4.60 头像持久化:还原历史也走 decorateAiRow,让有图角色(cfw_char_avatar_v1)的头像刷新后继续显示,
        // 并补 data-char-id 以响应 avatar:changed;无图/character.js 未就绪时回退 emoji 文本。
        const _card = { id: m.speakerId || "", name: m.speakerName, icon: m.speakerIcon || "🙂" };
        if (window.__character && window.__character.decorateAiRow) {
          window.__character.decorateAiRow(r.rowEl, _card);
        } else {
          const av = r.rowEl.querySelector(".avatar.bot");
          if (av) { av.textContent = m.speakerIcon || "🙂"; av.title = m.speakerName; }
          const meta = r.rowEl.querySelector(".meta");
          if (meta) meta.textContent = m.speakerName;
        }
      }
    }
    // 末尾仍有未挂出的过程块(该轮被中断 / 没有最终回答):补一行承载,避免"跑了工具却什么都没有"
    if (_pendingTurns.length) {
      try { const _r2 = makeRow("assistant"); _flushTurnsInto(_r2.rowEl); if (_r2.bubble && !String(_r2.bubble.textContent || "").trim()) _r2.bubble.style.display = "none"; } catch (_pf) {}
    }
  }

  function restoreSessionIfEnabled() {
    if (!historyEnabled) return;
    const all = loadAllSessions();
    const arr = all[currentSlotKey()];
    if (!Array.isArray(arr)) return;
    try { renderSessionIntoUI(arr); } catch {}
  }

  // 4.80: 运行期内存槏缓存的存/取——与「本地存储」开关完全解耦,只在本次页面存活期间生效。
  // 修「换角色卡 / 多开会话切换会把当前对话清空」——旧版仅在 historyEnabled 时才保存/还原,
  // 关掉本地存储时,session.length=0 会真的把内存和 UI 都清空且无处找回。
  function memSaveSlot(key) {
    if (!key) return;
    try { _memSlots[key] = session.map((m) => ({ ...m })); } catch {}
  }
  function memRestoreSlot(key) {
    const arr = _memSlots[key];
    if (!Array.isArray(arr)) return false;
    try { renderSessionIntoUI(arr); return true; } catch { return false; }
  }

  // ─── 会话注册表(平铺)+ CRUD · 2026-09-14 重做 ───
  function loadConvMeta() {
    try {
      const m = JSON.parse(localStorage.getItem(LS_CONV_META) || "{}");
      return (m && typeof m === "object" && !Array.isArray(m)) ? m : {};
    } catch { return {}; }
  }
  function saveConvMeta(m) { try { localStorage.setItem(LS_CONV_META, JSON.stringify(m)); } catch {} }
  function saveCurrentSlotNow() {
    if (!historyEnabled) return;
    try {
      const all = loadAllSessions();
      const key = currentSlotKey();
      all[key] = session.map((m) => ({ ...m }));
      localStorage.setItem(LS_CHAT_SESSION, JSON.stringify(all));
      bumpSlotMeta(key);
      touchConv(key, {}); // 刷新会话的最后活动时间(供列表按时间排序)
    } catch {}
  }

  // 列出「全部」会话(与角色无关)。含参与角色信息,供左栏会话列表渲染。
  function listConversations() {
    const all = loadAllSessions();
    const meta = loadConvMeta();
    const cur = activeConvId();
    let cards = [];
    try { cards = (window.__character && window.__character.listAllCards) ? (window.__character.listAllCards() || []) : []; } catch {}
    const cardOf = (id) => cards.filter((c) => c && c.id === id)[0] || null;
    const ids = new Set(Object.keys(meta).filter(isConvId));
    for (const k of Object.keys(all)) if (isConvId(k)) ids.add(k);
    for (const k of Object.keys(_memSlots)) if (isConvId(k)) ids.add(k); // 还没落盘的运行期会话也要列出来
    const out = [];
    ids.forEach((id) => {
      // 数据源优先级:当前会话用实时 session(最准,含尚未落盘的新消息)
      //              → 运行期内存缓存(本页切走过的会话)→ localStorage 里持久化的
      const cached = (id === cur) ? session : (Array.isArray(_memSlots[id]) ? _memSlots[id] : null);
      const arr = cached || (Array.isArray(all[id]) ? all[id] : []);
      const m = meta[id] || {};
      let preview = "";
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i] && arr[i].content) { preview = String(arr[i].content).replace(/\s+/g, " ").slice(0, 60); break; }
      }
      const card = m.charId ? cardOf(m.charId) : null;
      out.push({
        convId: id,
        name: m.name || "新对话",
        charId: m.charId || "",
        charName: card ? (card.name || "") : (m.charId ? "(角色已删除)" : ""),
        charIcon: card ? (card.icon || "") : "",
        charAvatar: card ? (card.avatar || "") : "",
        preview,
        count: arr.length,
        createdAt: m.createdAt || 0,
        updatedAt: m.updatedAt || m.createdAt || 0,
        active: id === cur,
      });
    });
    // 排序:当前项置顶 → 有消息的按最后活动时间倒序 → 空会话按创建时间倒序
    out.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      const au = a.count ? a.updatedAt : 0, bu = b.count ? b.updatedAt : 0;
      if (au !== bu) return bu - au;
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
    return out;
  }

  function switchConversation(convId) {
    const id = isConvId(convId) ? convId : ensureDefaultConv();
    if (id === activeConvId()) return; // 已经是当前会话,不做无谓重画
    memSaveSlot(currentSlotKey()); // 4.80: 无条件先把当前会话存进运行期内存
    saveCurrentSlotNow();
    setActiveConvId(id);
    loadConvIntoUI(id);
  }

  // 「新对话」= 真的新建一个空会话(并把当前角色记进去)
  function createConversation(name) {
    memSaveSlot(currentSlotKey());
    saveCurrentSlotNow();
    const id = newConvId();
    touchConv(id, { name: (name || "").trim() || "新对话", charId: activeCardId() });
    setActiveConvId(id);
    loadConvIntoUI(id);
    return id;
  }
  function renameConversation(convId, name) {
    if (!isConvId(convId)) return;
    touchConv(convId, { name: (name || "").trim() || "新对话" });
  }
  function deleteConversation(convId) {
    if (!isConvId(convId)) return false;
    try {
      const all = loadAllSessions();
      delete all[convId];
      if (Object.keys(all).length === 0) localStorage.removeItem(LS_CHAT_SESSION);
      else localStorage.setItem(LS_CHAT_SESSION, JSON.stringify(all));
    } catch {}
    writeChatTombstone(convId); // 跨设备生效(否则另一台 pull 又并回来)
    // 2026-09-14:连带清掉该会话的 Agent 工作区文件(否则成为读不回来的孤儿,白占配额)
    try { if (window.__agentWorkspace && window.__agentWorkspace.removeByConv) window.__agentWorkspace.removeByConv(convId); } catch (_) {}
    const meta = loadConvMeta();
    if (meta[convId]) { delete meta[convId]; saveConvMeta(meta); }
    delete _memSlots[convId];
    if (loadActiveConvRaw() === convId) {
      setActiveConvId("");
      const rest = listConversations();
      loadConvIntoUI(rest.length ? rest[0].convId : ensureDefaultConv()); // 删光了就自动建一个新的空会话
    }
    return true;
  }

  function initModels() {
    const MODELS = getRuntimeModels(currentMode);
    const DEFAULT = runtimeDefaultModel(currentMode, MODELS);

    modelSel.innerHTML = "";
    if (!MODELS.length) {
      const opt = document.createElement("option");
      opt.value = currentMode === "fast" ? "__fast_placeholder__" : "__free_placeholder__";
      opt.textContent = currentMode === "fast" ? "快速模型，正在等待拉取" : "免费模型，正在等待拉取";
      modelSel.appendChild(opt);
      modelSel.value = opt.value;
      setTimeout(function () { autoFetchModelsForMode(currentMode); }, 0);
      return;
    }
    // 2026-11-11(C): 免费档放宽到 50 个模型后，平铺的下拉没法看 —— 按厂商分组(<optgroup>)。
    // 没有厂商前缀的（DeepSeek 官方的 deepseek-flash 之类）不套组，直接平铺，保持原样。
    const mkOpt = (m) => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label || m.id;
      return opt;
    };
    const vendorOf = (id) => (String(id).indexOf("/") >= 0 ? String(id).split("/")[0] : "");
    const groups = new Map();
    for (const m of MODELS) {
      const v = vendorOf(m.id);
      if (!groups.has(v)) groups.set(v, []);
      groups.get(v).push(m);
    }
    if (groups.size <= 1) {
      for (const m of MODELS) modelSel.appendChild(mkOpt(m));
    } else {
      for (const [v, list] of groups) {
        if (!v) { for (const m of list) modelSel.appendChild(mkOpt(m)); continue; }
        const og = document.createElement("optgroup");
        og.label = v;
        for (const m of list) og.appendChild(mkOpt(m));
        modelSel.appendChild(og);
      }
    }
    const saved = localStorage.getItem(LS_MODEL);
    // 只在当前模式模型列表中才恢复已保存的值；占位符永不恢复
    const savedInList = saved && !isPlaceholderModel(saved) && MODELS.some((m) => m.id === saved);
    modelSel.value = savedInList ? saved : DEFAULT;
    // 2026-11-08 修(审查 P2): 只在真的没有已选模型(未设/占位符)时才落默认值 ——
    // 旧版切到另一模式时会把那边选好的模型覆写掉
    if ((!saved || isPlaceholderModel(saved)) && DEFAULT) localStorage.setItem(LS_MODEL, DEFAULT);
  }

  modelSel.addEventListener("change", () => {
    localStorage.setItem(LS_MODEL, modelSel.value);
    // 2026-10-13 (E1c): 自定义渠道活跃时，顶栏换模型 = 换该渠道的当前模型（发请求时取 byo.model）
    try {
      if (window.__providers) {
        const st = window.__providers.read();
        if (st && st.activeId && String(st.activeId).indexOf("custom:") === 0 && window.__providers.setSelectedModel) {
          window.__providers.setSelectedModel(st.activeId, modelSel.value);
        }
      }
    } catch (e) {}
    // 2026-11-11: 换模型可能换掉思考能力（不支持 / 只有开 / 只有三档）。
    updateThinkToggleUI();
  });

  // 2026-10-13 (E1c): 渠道切换 / 每模型开关变化（设置卡或其它标签页）→ 顶栏模式与模型下拉跟随。
  // 预设渠道→配对模式；自定义活跃→模式不动、只重建下拉（自定义渠道的模型走 byo.model）。
  try {
    window.addEventListener("cfw:providers-changed", function () {
      try {
        const want = window.__providers && window.__providers.modeForActive && window.__providers.modeForActive();
        if (want && want !== currentMode) { applyMode(want); return; }
        paintModeToggle();
        initModels();
        updateThinkToggleUI();
      } catch (e) {}
    });
  } catch (e) {}

  personaToggle.addEventListener("click", () => {
    if (BASE_SWITCH_MODE) {
      const useCustom = currentRegistryIsCustom();
      if (!useCustom && !customIdsList().length) {
        toastMsg("还没有「自定义」基座：把 .md / .txt 放进 src/prompts/custom/ 并部署，这里就能切过去（见 README「两套基座目录」）。", 6500);
        return;
      }
      const next = useCustom ? "builtin" : "custom";
      try {
        if (next === "custom") localStorage.setItem("cfw_base_registry_v1", "custom");
        else localStorage.removeItem("cfw_base_registry_v1");
      } catch (e) {}
      paintPersonaButton();
      const d = registryDescribe(next === "custom");
      toastMsg((next === "custom" ? "已切到自定义基座：" : "已切回内置基座：") + (d.label || "默认"), 1800);
      return;
    }
    useBuiltin = !useBuiltin;
    paintPersonaButton();
    localStorage.setItem(LS_USE_BUILTIN, useBuiltin ? "1" : "0");
  });

  // 面板开关由 settings.js 统一管理

  // Bug1 fix: 以上五个元素由 settings.js 动态挂载，IIFE 执行时均为 null。
  // 把事件绑定移入 wireHistoryUI()，在 DOMContentLoaded + setTimeout(0) 后执行，
  // 确保在 settings.js init()（同样在 DOMContentLoaded 里挂 card）完成之后再接线。
  function wireHistoryUI() {
    const _histEl  = document.getElementById("historyKeep");
    const _clrBtn  = document.getElementById("clearHistory");
    const _prmEl   = document.getElementById("promptKeep");
    const _custEl  = document.getElementById("customPrompt");
    const _saveBtn = document.getElementById("savePrompt");
    const _clrPBtn = document.getElementById("clearPrompt");
    if (_histEl) {
      _histEl.checked = historyEnabled;
      _histEl.addEventListener("change", () => {
        historyEnabled = !!_histEl.checked;
        localStorage.setItem(LS_HISTORY_ENABLED, historyEnabled ? "1" : "0");
        if (historyEnabled) {
          priorSummary = localStorage.getItem(LS_PRIOR_SUMMARY) || "";
          persistSessionIfEnabled();
        }
        renderSummaryChip();
      });
    }
    if (_clrBtn) {
      _clrBtn.addEventListener("click", () => {
        if (!confirm("确定清空【全部】会话？\n将删除本设备上所有会话的对话记录与剧情摘要,并同步删除云端备份。\n（只想丢开当前这条、重新开始,请用左栏「对话」里的「+ 新建」。）此操作不可撤销。")) return;
        try {
          const all = loadAllSessions();
          for (const _k of Object.keys(all)) writeChatTombstone(_k); // 4.78: 逐槽写删除墓碑,清空所有历史并跨设备生效
        } catch {}
        localStorage.removeItem(LS_CHAT_SESSION);
        try { localStorage.removeItem(LS_CONV_META); } catch {}   // 4.78: 清会话名
        try { localStorage.removeItem(LS_CONV_ACTIVE); } catch {} // 4.78: 清活跃会话指针
        localStorage.removeItem(LS_PRIOR_SUMMARY);
        localStorage.removeItem("cfw_summary_chip_hidden_v1");
        priorSummary = "";
        session.length = 0;
        clearUIRows();
        clearPendingAttachments();
        clearChoiceChips(); // 选项芯片不在聊天记录里,清空历史时同样要显式清
        // 2026-09-14:清空全部会话时连 Agent 工作区一起清(它按会话隔离,否则全成孤儿)
        try { if (window.__agentWorkspace && window.__agentWorkspace.clearAll) window.__agentWorkspace.clearAll(); } catch (_) {}
        renderSummaryChip();
        updateSpacer();
        scrollToBottom();
      });
    }
    if (_prmEl) {
      _prmEl.checked = promptEnabled;
      _prmEl.addEventListener("change", () => {
        promptEnabled = !!_prmEl.checked;
        localStorage.setItem(LS_PROMPT_ENABLED, promptEnabled ? "1" : "0");
        if (!promptEnabled) localStorage.removeItem(LS_CUSTOM_PROMPT);
      });
    }
    if (_saveBtn) {
      _saveBtn.addEventListener("click", () => {
        const val = (_custEl && _custEl.value) || "";
        if (promptEnabled) localStorage.setItem(LS_CUSTOM_PROMPT, val);
        else localStorage.removeItem(LS_CUSTOM_PROMPT);
        if (settingsMask) settingsMask.style.display = "none";
      });
    }
    if (_clrPBtn) {
      _clrPBtn.addEventListener("click", () => {
        if (!confirm("确定清除网页自定义人物模板？")) return;
        localStorage.removeItem(LS_CUSTOM_PROMPT);
        if (_custEl) _custEl.value = "";
      });
    }
  }
  // settings.js 的 DOMContentLoaded(init) 先注册，app.js 后注册，顺序一致；
  // setTimeout(0) 确保在 settings.js init() 同步执行完（card 已挂载）后才接线。
  document.addEventListener("DOMContentLoaded", () => setTimeout(wireHistoryUI, 0));

  // 2026-10-07 拖动卡顿修复（E-A）：输入处理改 rAF 节流 —— 旧版每次按键都做 scrollHeight 强制读
  // + getBoundingClientRect/getComputedStyle 测量 + 两处样式写；拖动手势共存时是明确的卡点。
  let _inputRaf = 0;
  inputEl.addEventListener("input", () => {
    if (_inputRaf) return;
    _inputRaf = requestAnimationFrame(() => {
      _inputRaf = 0;
      inputEl.style.height = "auto";
      inputEl.style.height = inputEl.scrollHeight + "px";
      updateSendBtnState(); // 运行中：有字→发送键（插话），没字→停止键
      const stick = isNearBottom();
      updateSpacer();
      if (stick) scrollToBottom();
    });
  });

  function setupResizeObserver() {
    if (!composerEl || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const stick = isNearBottom();
      updateSpacer();
      if (stick) scrollToBottom();
    });
    ro.observe(composerEl);
  }

  // 4.83: 键盘遮挡高度 → --kb CSS 变量(手机端 composer/底栏上浮兜底)。
  // 主修是 viewport meta 的 interactive-widget=resizes-content(布局视口随键盘收缩,
  // 此时 innerHeight 同步变小 → kb≈0,不会双重补偿);个别 WebView 不支持该模式时
  // (resizes-visual:innerHeight 不变、vv.height 缩小),kb = 键盘高度,CSS 据此上浮。
  let _lastKb = -1;
  function syncKbVar() {
    try {
      const vv = window.visualViewport;
      const kb = Math.max(0, Math.round((window.innerHeight - vv.height) - (vv.offsetTop || 0)));
      if (kb === _lastKb) return; // 2026-10-07 (E-A)：值没变就不写 —— 每次写都让根样式失效重算
      _lastKb = kb;
      document.documentElement.style.setProperty("--kb", kb + "px");
    } catch (_) {}
  }
  function setupViewportListener() {
    if (!window.visualViewport) return;
    window.visualViewport.addEventListener("resize", () => {
      const stick = isNearBottom();
      syncKbVar();
      updateSpacer();
      if (stick) scrollToBottom();
    });
    window.visualViewport.addEventListener("scroll", syncKbVar);
    syncKbVar();
  }

  window.addEventListener("resize", () => {
    const stick = isNearBottom();
    syncKbVar();
    updateSpacer();
    if (stick) scrollToBottom();
  });


  // Phase 4 阶段 6：从 LS 读取启用的预设，按 order 排序，filter enabled，COT 在快速档下自动禁用
  // （2026-10-06: 原「语音情绪白名单」(emotionTagDirective) 已随多情绪系统删除 —— 本函数曾残留对它的
  //   活调用导致所有聊天路径 ReferenceError 中止(agent 模式报"emotionTagDirective is not defined")，已清。）
  function getExtraSystemPrompts(mode, card) {
    try {
      const raw = localStorage.getItem(LS_PROMPT_PRESETS);
      if (!raw) return "";
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return "";
      const isFast = mode === "fast";
      // 2026-10-08 角色能力档：该角色配了 presetIds 就按它取（忽略全局 enabled 勾选），否则走全局。
      const cap = charCap(card);
      const ids = (cap && Array.isArray(cap.presetIds) && cap.presetIds.length) ? cap.presetIds : null;
      return arr
        .filter(p => p && typeof p.content === "string" && p.content.trim())
        .filter(p => ids ? ids.indexOf(p.id) >= 0 : !!p.enabled)
        .filter(p => !(isFast && p.name === "COT"))
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map(p => p.content.trim())
        .join("\n\n");
    } catch { return ""; }
  }

  // 2026-10-06 氛围音导演:每轮把「音轨清单 + 当前正在播放」挂进系统提示(清单唯一来源 = theme.js 的注册表,
  // 这里只做拼装)。普通聊天与 Agent 模式两条装配路径都会带上。
  function ambientDirectorPrompt() {
    try {
      return (window.__ambientTags && typeof window.__ambientTags.directorPrompt === "function")
        ? "\n\n" + window.__ambientTags.directorPrompt()
        : "";
    } catch (e) { return ""; }
  }
  // 回复收尾:解析并执行 [[amb:…]] 等氛围标签,返回剥离标签后的干净正文(标签不显示给用户)
  function applyAmbientTags(text) {
    try {
      if (!window.__ambientTags || typeof window.__ambientTags.apply !== "function") return text;
      const r = window.__ambientTags.apply(text);
      return (r && typeof r.clean === "string") ? r.clean : text;
    } catch (e) { return text; }
  }

  // ─── 内核接线 v1:Agent 内核模式(function-calling + agent loop) ───
  // dev 开关 cfw_agent_mode_v1 开启 且 内核 SDK(/shared/agent-kernel.js + /shared/tools.js)已加载时,
  // sendOne 改走 sendOneAgent:让模型自主调用 send_image / adjust_affinity 等工具,
  // 由 AgentKernel.runAgentLoop 驱动多轮 tool 调用。默认关 → 保持原流式 sendOne 零回归。
  // 控制台开:__dev.setAgentMode(true)
  function isAgentModeOn() {
    return (localStorage.getItem("cfw_agent_mode_v1") ?? "0") === "1"
      && !!(window.AgentKernel && window.OwnChatTools);
  }

  // 2026-06-21 Bug:agent「不爱用工具/糊弄/抓网页能力差」——给 agent 模式追加强硬「工具使用纲领」。
  const AGENT_TOOL_USE_DIRECTIVE = "\n\n【工具使用纲领·必读】你已接入真实可用的联网与本地工具,默认就该主动调用,绝不能凭记忆臆测或编造结果。\n1. 需要网上的网页/文件/资料时:已知或能推断 URL → 必须真的调用 fetch_page 抓取原文后再作答;不知道 URL → 先用 web_search 找到链接,再 fetch_page 读取。严禁假装读过某页或杜撰其内容。\n2. 抓取或搜索失败时,如实说明失败,可改用 fetch_page / web_search,或调 reach_diagnose 自检后重试;不要假装成功,也不要用「我无法联网」搪塞——你确实能联网。\n3. 多步任务要连续多轮调用工具直到真正完成再收尾,中途不要糊弄或跳步。\n4. 仅在确有必要时才用付费深度搜索(web_search deep=true);一般信息用默认免费搜索即可。";

  async function sendOneAgent(opts) {
    if (isSending) return null;
    _discardPartialFlag = false; // 新一轮开始：清掉上一轮的"明确丢弃"标记
    const opts0 = opts || {};
    const isAuto = opts0.text != null;
    updateSpacer();
    const text = isAuto ? String(opts0.text).trim() : inputEl.value.trim();
    const allowEmpty = !!opts0.allowEmptyText;
    // 2026-09-14: 只附图/文件不打字也应能发送
    if (!text && !allowEmpty && !attCount()) return null;

    isSending = true;
    // 2026-11-10: agent 运行中不禁用发送键 —— 允许「插话」注入当前轮（见 steerAgent）。
    // 2026-11-11: 空输入时这个键整体变成停止键（方形图标 + 危险色）。
    sendBtn.disabled = false;
    _agentSteerQueue = [];
    updateSendBtnState();

    const myGen = ++sendGen;
    const controller = new AbortController();
    currentController = controller;

    // 用户气泡 + 入 session(与 sendOne 输入处理一致)
    const _attA = takeAttachments();
    if (text || attHasAny(_attA)) {
      const userRow = makeRow("user");
      if (text) userRow.bubble.textContent = text;
      renderAttachmentsInto(userRow.bubble, _attA);
      applyUserFold(userRow.bubble);
      const inEst = estimateTokens(text) + attFileTokens(_attA);
      totalInEstimate += inEst;
      userRow.stats.textContent = `Input(估算): ≈${inEst} | Total In(估算): ≈${totalInEstimate}`;
      session.push(scopeTag(Object.assign({ role: "user", content: text }, attMeta(_attA))));
      try { userRow.rowEl.dataset.sidx = String(session.length - 1); } catch (_sx) {} // 2026-10-08: 重试/删除按真实下标算
      persistSessionIfEnabled();
    }
    if (!isAuto) {
      inputEl.value = "";
      inputEl.style.height = "auto";
      updateSendBtnState();
    }
    updateSpacer();
    scrollToBottom();

    // 角色卡 / 关系 / 好感 等上下文(对齐 sendOne 的 /api/chat payload)
    const ch = window.__character || null;
    const characterCard = opts0.asCard
      ? opts0.asCard
      : (ch && ch.getActiveCard ? ch.getActiveCard() : null);
    const relation = ch && ch.getActiveRelation ? ch.getActiveRelation() : "default";
    const emotion = ch && ch.getActiveEmotion ? ch.getActiveEmotion() : "neutral";
    const affection = ch && ch.getActiveAffection ? ch.getActiveAffection() : null;
    let customPrompt = "";
    if (!useBuiltin && promptEnabled) customPrompt = localStorage.getItem(LS_CUSTOM_PROMPT) || "";
    // 2026-11-11: Agent 个性化（设置 → 个性化）。只作用于 Agent 路径，不受内置/自定义与角色卡影响。
    let agentPersonalize = "";
    try { agentPersonalize = (localStorage.getItem("cfw_agent_personalize_v1") || "").trim(); } catch (e) {}
    const snapshotMode  = currentMode;
    const customProviderSnapshot = (window.__byoProvider && window.__byoProvider.get && window.__byoProvider.get()) || undefined;
    const snapshotModel = customProviderSnapshot ? customProviderSnapshot.model : modelSel.value;
    // 2026-11-10: 视觉模型才把 pc_shot 的截图注入上下文（文本模型塞图会被上游 400）
    try { window.__agentVisionOn = pcVisionOn(snapshotModel); } catch (e) { window.__agentVisionOn = false; }
    if (!ensureUsableModelBeforeSend(snapshotMode, snapshotModel, customProviderSnapshot)) {
      isSending = false;
      sendBtn.disabled = false;
      _agentSteerQueue = null;
      _agentImageQueue = null;
      updateSendBtnState();
      currentController = null;
      return null;
    }
    // 2026-10-05: 本轮回复的来源标注,随会话持久化(翻历史时能看出这条是哪个模型+哪个底座答的)。
    // 与 payload 同一快照口径:中途切模型/底座,旧回复保留旧标注、新回复带新的 —— 所以按条存,不按会话盖章。
    // baseId 空串 = 「用默认档」(worker 侧回落到排序第一份),不是没记录。
    // 这个字段只进 UI/本地会话:发请求前 sanitizeToolProtocol 白名单重建会把它剥掉,不会流到上游。
    const _replyMeta = { model: snapshotModel, baseId: baseIdPayload(characterCard).baseId || "" };

    const aiRow = makeRow("assistant", { side: opts0.side || null });
    setStreamingUI(aiRow.rowEl, true);
    if (window.__character && window.__character.decorateAiRow) {
      window.__character.decorateAiRow(aiRow.rowEl, characterCard);
    }
    aiRow.bubble.textContent = "思考中…"; // 4.71: 去掉 🧠

    // 4.73 Agent 思考复用聊天「思考过程」折叠框:把 agent loop 的模型推理 + 工具步骤汇总进本条 AI 的折叠块,
    // 右栏控制台只显简洁状态/操作。两边共享同一份 onEvent 事件流,折叠块按聊天「思考过程显示」设置 show/collapse/hide。
    const _agentReasonLines = [];
    // 2026-09-14:「本轮」思考缓冲 —— _agentReasonLines 是全部轮次的累积(协议要求整条 assistant 消息
    // 带一个 reasoning_content),但**显示**要按轮切分(ZCode 没有独立的思考块,思考属于它那一轮)。
    let _curRoundReason = "";
    function _briefAgentArgs(a) {
      try { var s = JSON.stringify(a); return s.length > 80 ? s.slice(0, 77) + "…" : s; } catch (e) { return ""; }
    }
    function _renderAgentReasoning(_thisRound) {
      const _joined = _agentReasonLines.join("\n");
      // 2026-09-14:思考切分进它所属的那一轮(_thisRound 是本轮新产生的部分);
      // 面板显示用本轮,而 _joined(全部轮次累积)仍用于协议回传与持久化。
      if (typeof _thisRound === "string" && _thisRound) _curRoundReason = _thisRound;
      try { if (_stepsLive) { _stepsLive.roundThinking(_curRoundReason); return; } } catch (_sr) {}
      if (!aiRow.reasoning) return;
      const rt = aiRow.reasoning.querySelector(".reasoning-text");
      if (!rt) return;
      rt.textContent = _joined;
      if (getThinkDisplay() === "hide") { aiRow.reasoning.style.display = "none"; return; }
      aiRow.reasoning.style.display = "";
      aiRow.reasoning.open = true; // 运行期间默认展开看进度,结束后由 applyThinkDisplay 按设置收起
    }

    let finalText = "";
    // 4.79 中断兜底:把 callModel 流式已收到的可见正文同步到外层,abort 时不至于丢失半截回复
    let _lastAgentContent = "";
    // 2026-06-20 工具轮前置正文累积:模型在调用工具的那一轮里常先写一段正文(问候/道歉/说明),
    // 旧版 _renderLive 一见 tool_calls 就停更、下一轮又覆盖气泡 → 这段被吞,只剩 dev 入站流可见。
    // 这里把每个「带工具调用且有正文」的轮次正文累积起来,实时渲染+最终落地都带上,杜绝吞话。
    let _agentPreamble = "";
    try {
      // 工具注册表:发图回调把生成的图片渲染成图片气泡(插在本条 AI 之后)
      const _pcOnImage = (url, meta) => {
          // send_image 工具已通过 __chatImage.sendPhoto 生成图片并拿到 URL，直接渲染气泡，不重复生成
          // Bug fix 2026-06-18: 旧版把 url 字符串当对象取 .scene_prompt → scene="" → handleSignal 拿空 scene 无渲染
          // 且 handleSignal 会触发二次出图而非展示已有 URL；现改为直接插 <img> 气泡。
          try {
            if (url && typeof url === 'string') {
              const _imgRow = document.createElement('div');
              _imgRow.className = 'row ai';
              const _imgAv = document.createElement('div');
              _imgAv.className = 'avatar bot';
              _imgAv.textContent = (characterCard && characterCard.icon) || '🙂';
              const _imgContent = document.createElement('div');
              _imgContent.className = 'content';
              const _imgEl = document.createElement('img');
              _imgEl.src = url;
              // 2026-10-08 内存:聊天 DOM 不虚拟化 —— 屏外图不加载/不解码，长会话里少一批常驻位图
              try { _imgEl.loading = 'lazy'; _imgEl.decoding = 'async'; } catch (_ie2) {}
              _imgEl.style.cssText = 'max-width:280px;max-height:320px;border-radius:12px;display:block;object-fit:cover;cursor:pointer;margin:2px 0;';
              _imgEl.onclick = function() { try { window.open(url, '_blank'); } catch (_) {} };
              _imgEl.onerror = function() { _imgRow.style.display = 'none'; };
              _imgContent.appendChild(_imgEl);
              _imgRow.appendChild(_imgAv);
              _imgRow.appendChild(_imgContent);
              // 插在当前 AI row 之后（若可以），否则插在 spacer 前
              var _afterRef = (aiRow && aiRow.rowEl && aiRow.rowEl.nextSibling) || spacerEl;
              chatEl.insertBefore(_imgRow, _afterRef);
              if (isNearBottom()) scrollToBottom();
            }
          } catch (_ie) {}
          // 画廊存储兜底（sendPhoto 内部通常已保存；此处兜直传 URL 路径）
          try {
            var _gurl = (typeof url === 'string' ? url : null) || (meta && (meta.url || meta.imageUrl || meta.result_url));
            if (_gurl) {
              if (window.__gallery && typeof window.__gallery.favorite === 'function') {
                // image-gallery 只暴露 favorite/remove/pull/items/open,没有 add(旧 API 名,已修正)
                window.__gallery.favorite(_gurl, { source: 'agent', ts: Date.now() });
              }
            }
          } catch (_) {}
      };
      window.__agentImageBubble = _pcOnImage;
      const registry = window.OwnChatTools.buildRegistry({ onImage: _pcOnImage });
      // 2026-09-14 文件工作区:list_files / read_file / write_file(真写工作区) / edit_file / delete_file / export_file
      // (旧 write_file 只是弹下载,文件不落地也读不回来;文件类工具的定义与存储都在 data/agent-workspace.js)
      if (window.__agentWorkspace && typeof window.__agentWorkspace.defineTools === "function") {
        try { window.__agentWorkspace.defineTools(registry); } catch (e) { console.warn('[agent-workspace] defineTools 失败:', e); }
      }
      // 2026-06-16 Agent-Reach Skill:追加联网工具(fetch_page/web_search/search_bilibili/search_github/read_rss)
      // Bug4 fix: tools.js 曾重复定义 web_search，registry.define 对重名 throw 导致 AgentReach.defineTools 后续工具全部漏注册。加 try-catch 防止单个注册失败崩掉整个 Reach 工具链。
      if (window.AgentReach && typeof window.AgentReach.defineTools === "function") {
        try { window.AgentReach.defineTools(registry); } catch (e) { console.warn('[AgentReach] defineTools 部分失败:', e); }
      }
      // 2026-06-18 自检工具:追加 self_diagnostics(环境快照 + 加载完整性 + 联网逐环节自检;联网部分委托 AgentReach.diagnose)。只读、非破坏,失败不影响其余工具
      // 4.70 本地能力:local_env / local_list_dir / local_read_file / local_write_file / local_run_command。
      // 只在桌面端注册(Tauri 才有 invoke)。门控分层(2026-10-05 如实修订 —— 旧注释写的
      // "agent-tests/ + node --permission"是被废弃的窄版方案,从未实现):
      //   文件类:Rust 侧工作目录门控;命令类:无沙箱,spawn 前有 Rust 原生确认框,环境变量经清洗;
      //   闸门:前端确认卡 + 工作模式。命令须在 build.rs 登记 + capabilities/remote.json 授权。
      // 刻意不提供 read_file → read_text_file 这条映射:read_text_file 在 Rust 侧无路径限制,
      // 接上等于给 agent 任意文件读取。
      if (window.AgentLocalTools && typeof window.AgentLocalTools.defineTools === "function") {
        try { window.AgentLocalTools.defineTools(registry); } catch (e) { console.warn('[AgentLocalTools] defineTools 失败:', e); }
      }
      // 2026-11-06: 源码/产物检索（可选开发工具；未启用时 defineTools 直接返回，零占用）
      if (window.__sourceTools && typeof window.__sourceTools.defineTools === "function") {
        try { window.__sourceTools.defineTools(registry); } catch (e) { console.warn('[SourceTools] defineTools 失败:', e); }
      }
      // 2026-11-08: I/O 落盘读回（dev.js §落盘；开发者模式未开时 defineTools 直接返回）
      if (window.__ioTools && typeof window.__ioTools.defineTools === "function") {
        try { window.__ioTools.defineTools(registry); } catch (e) { console.warn('[IoTools] defineTools 失败:', e); }
      }
      // 2026-11-09 内容画布（面板 T3）：stage_open / stage_close / stage_view。
      // 画布未起（手机端 / panel-host 未加载）时 defineTools 直接返回，零占用。
      if (window.__stageTools && typeof window.__stageTools.defineTools === "function") {
        try { window.__stageTools.defineTools(registry); } catch (e) { console.warn('[StageTools] defineTools 失败:', e); }
      }
      // 2026-11-09 作业台客户端：submit_job / job_status / job_open_artifacts。
      // 未配置作业台时工具照样注册（调用会返回配置指引），产物走右栏画布。
      if (window.__jobTools && typeof window.__jobTools.defineTools === "function") {
        try { window.__jobTools.defineTools(registry); } catch (e) { console.warn('[JobTools] defineTools 失败:', e); }
      }
      // 2026-11-09 三方会商工具（council_read / council_post）：打本机 8798 会商服务；
      // 服务不可达时工具自己给清晰指引，不影响其他工具。
      if (window.__councilTools && typeof window.__councilTools.defineTools === "function") {
        try { window.__councilTools.defineTools(registry); } catch (e) { console.warn('[CouncilTools] defineTools 失败:', e); }
      }
      // 2026-11-09 网页版本的本地手脚（走本机 127.0.0.1:8801 执行服务；桌面版自动跳过）
      if (window.__localExecTools && typeof window.__localExecTools.defineTools === "function") {
        try { window.__localExecTools.defineTools(registry); } catch (e) { console.warn('[LocalExecTools] defineTools 失败:', e); }
      }
      // 2026-10-06 氛围音导演:set_ambient（环境声/背景音乐两条独立音轨 + 气息垫）。
      // 用裸 registry.define 注册,不走 tools.js 的 core/full 分档 —— 工具很小、只改音量状态,常驻无负担。
      if (window.AmbientTools && typeof window.AmbientTools.defineTools === "function") {
        try { window.AmbientTools.defineTools(registry); } catch (e) { console.warn('[AmbientTools] defineTools 失败:', e); }
      }
      let _envSnap = "";
      if (window.__envContext && typeof window.__envContext.defineTools === "function") {
        try {
          window.__envContext.defineTools(registry);
          // 系统感知快照注入：每轮携带最新日期/时区/平台/在线状态/已装工具列表。
          // 2026-06-18 原意:systemPrompt 未声明会 ReferenceError 被 catch 吞 → 快照永不注入,故改写入 _envSnap 在 callModel 里拼进 extraSystemPrompts。
          // 2026-06-19 审查整理:原版 defineTools 与下面的 if 挤在一行靠 ASI(自动插分号)续命,结构脆弱易被压缩/格式化破坏 → 改为显式分句,行为不变。
          if (typeof window.__envContext.snapshotText === "function") {
            try { _envSnap = window.__envContext.snapshotText({ registry }); } catch (_se) {}
          }
        } catch (e) { console.warn('[env-context] defineTools 失败:', e); }
      }

      // callModel(messages, schemas):4.77 改流式打 /api/chat(stream:true),边收边把最终答复渲染进气泡 + 增量重组 tool_calls,回传与原非流式同形状的 message(含 tool_calls)。worker /api/chat 已支持流式带 tools(透传 tools + 原样吐 tool_calls delta),故内核与 worker 均不用动。
      // 4.83: 本回合 usage 累计 —— 回合结束时回填 AI 行统计(旧版开场清空后从不回填,
      // agent 模式下始终看不到任何统计)。必须用 var(函数作用域): 声明在 try 块内,
      // 但回填点在 finally 块,const/let 的块作用域会 ReferenceError。
      var _roundUsage = { p: 0, c: 0, n: 0 };
      // 2026-10-08 上游"静默卡死"防护：agent 的 callModel 是流式（4.77），但上游可能
      // headers 之后 body 不再吐字节（worker 默认流是裸透传、无心跳）——旧版只能干等，
      // 表现就是「工具跑完不回字、行一直 streaming」，唯一出路是点停止。
      // 现在：包装真 callModel，90 秒没有任何 chunk 就中止本次调用并抛出人话错误
      // （内核据此走 model_error 优雅收尾）。用独立子 controller 链到宿主 signal：
      // 用户主动停止（宿主 abort）与「上游没响应」（看门狗）在错误类型上可区分。
      const AGENT_CALL_IDLE_MS = 90 * 1000;
      // 2026-11-09 加：总时长硬上限。idle 看门狗只打"静默"，但实测存在「请求已返回、
      // 流却没关闭」的形态 —— reader 永远等不到 done，idle 也不再有 data 可重置，
      // 表面看是 UI 卡在"思考中"数分钟。这里补一道绝对上限，到点强制中止。
      const AGENT_CALL_TOTAL_MS = 180 * 1000;
      // ── 2026-11-09（会商 #8 P0 之后）：重试预算 ────────────────────────────
      // 拆了 ZCode 与 DSH 的流处理实现，两家在"上游不干净"这件事上的做法一致，都比我们完整：
      //   · DSH @deepseek-ai/dsh-llm      provider 级 retry-policy（lib/types/retry-policy.js）：
      //       默认 maxRetries=5；退避 500ms 起指数涨到 10s、±10% 抖动；可重试码只有
      //       EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT；有 retry-after 头就用它。
      //   · DSH @deepseek-ai/dsh-timeout  idleWatchdog：计时只覆盖"等下一个事件"这一瞬间
      //       （消费方思考时间不算上游空闲），到点 abort 并抛 TIMEOUT —— 是**可重试错误**，不是干等。
      //   · ZCode zcode.cjs readNextWithStreamIdleTimeout：同一形态，且**每重试一次把静默窗口
      //       +30s**（base + retryNumber×30s，VHs=30000）；streamRecovery 最多 10 次，
      //       从"最后一个已提交的工具调用"处续跑（anchorId），未提交的尾巴丢弃。
      // 我们此前只有"network 类错误重试一次"，超时与空响应都直接打死整轮 —— 这正是长任务
      // 半路夭折的主因。按两家并集重写：5 次尝试、指数退避带抖动、每重试静默窗口 +30s。
      const AGENT_RETRY_MAX = 4;            // 首次之外最多再试 4 次（= DSH maxRetries 5 的语义）
      const AGENT_RETRY_BASE_MS = 800;
      const AGENT_RETRY_CAP_MS = 10 * 1000;
      const AGENT_IDLE_STEP_MS = 30 * 1000; // ZCode：每重试一次静默窗口 +30s
      const AGENT_EMPTY_STREAK_MAX = 120;   // 连续空增量事件上限（"有事件、无内容"的假活）
      // 只有这几类值得重试：DSH retryableCodes ∪ ZCode 的 nqa/rqa
      const AGENT_RETRYABLE = { TIMEOUT: 1, TRANSPORT: 1, EMPTY_RESPONSE: 1, SERVER: 1, RATE_LIMIT: 1 };
      // 给错误打机器可路由的码 —— 两家都把这条写在注释里：按 code 路由，绝不解析 message
      const _tagErr = (e, code) => { try { if (e && !e.__retryCode) e.__retryCode = code; } catch (_e) {} return e; };
      const _classifyCallError = (e, flags) => {
        if (flags && (flags.idle || flags.total)) return "TIMEOUT";
        const tag = e && e.__retryCode;
        if (tag) return tag;
        const st = (e && e.__httpStatus) || 0;
        if (st === 429) return "RATE_LIMIT";
        if (st >= 500) return "SERVER";
        if (st >= 400) return "INVALID_REQUEST";
        const m = String((e && e.message) || e);
        // undici 的流中断就是 TypeError: network error / fetch failed（DSH 也把这类归 TRANSPORT）
        if ((e && e.name === "TypeError") || /\bnetwork\b|fetch failed|ECONNRESET|EPIPE|ETIMEDOUT|socket hang up/i.test(m)) return "TRANSPORT";
        return "UNKNOWN";
      };
      let _callCtrl = null, _idleTimer = null, _idleTimedOut = false;
      let _totalTimer = null, _totalTimedOut = false;
      // 当前这一次尝试的静默窗口。必须放在闭包级：_callModelOnce 在 SSE 循环里要拿它重置看门狗，
      // 而它是在 callModel 的 for 里算出来的 —— 之前在循环内用 const 声明，_callModelOnce 根本看不见，
      // 第一行 data 就抛 ReferenceError，整个 agent 调用当场挂掉。
      let _idleMsNow = AGENT_CALL_IDLE_MS;
      const _armIdle = (ms) => {
        if (_idleTimer) clearTimeout(_idleTimer);
        _idleTimer = setTimeout(() => { _idleTimedOut = true; try { _callCtrl.abort(); } catch (e) {} }, ms || AGENT_CALL_IDLE_MS);
      };
      const _disarmIdle = () => { if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; } };
      const _disarmTotal = () => { if (_totalTimer) { clearTimeout(_totalTimer); _totalTimer = null; } };
      // 重试是"整轮重发"：上一次尝试留在气泡里的半截正文必须清掉，否则旧字会挂在新流前面
      const _resetLiveView = () => {
        try { _lastAgentContent = ""; } catch (e) {}
        try { if (aiRow && aiRow.bubble) aiRow.bubble.textContent = ""; } catch (e) {}
      };
      const callModel = async (messages, schemas) => {
        for (let attempt = 0; ; attempt++) {
          _callCtrl = new AbortController();
          _idleTimedOut = false;
          _totalTimedOut = false;
          // 用户主动停止（宿主 abort）与「上游没响应」（看门狗）必须可分：前者原样抛、不重试
          const _onHostAbort = () => { try { _callCtrl.abort(); } catch (e) {} };
          if (controller.signal.aborted) _onHostAbort();
          else { try { controller.signal.addEventListener("abort", _onHostAbort, { once: true }); } catch (e) {} }
          const _idleMs = _idleMsNow = AGENT_CALL_IDLE_MS + attempt * AGENT_IDLE_STEP_MS;
          const _capMs = AGENT_CALL_TOTAL_MS + attempt * AGENT_IDLE_STEP_MS;
          _armIdle(_idleMs);
          _disarmTotal();
          _totalTimer = setTimeout(function () {
            _totalTimedOut = true;
            try { _callCtrl.abort(); } catch (e) {}
          }, _capMs);
          try {
            return await _callModelOnce(messages, schemas);
          } catch (e) {
            _disarmIdle();
            _disarmTotal();
            // 用户按了停止：不进重试（两家的 ABORTED 都在可重试码之外）
            if (controller.signal.aborted && !_idleTimedOut && !_totalTimedOut) throw e;
            const _code = _classifyCallError(e, { idle: _idleTimedOut, total: _totalTimedOut });
            // 总时长闸门与静默闸门不同：它意味着"这一整轮在 3 分钟里都没收尾"，原样重发第二次
            // 大概率同样撞线（成本double）。只给它一次机会，之后当终局错误。
            const _budget = (!_totalTimedOut || attempt < 1) ? AGENT_RETRY_MAX : 0;
            if (!AGENT_RETRYABLE[_code] || attempt >= _budget) {
              // 重试用尽，把人话原因抛给内核（内核据此 model_error 优雅收尾）
              if (_code === "TIMEOUT" && _idleTimedOut) {
                throw _tagErr(new Error("上游 " + Math.round(_idleMs / 1000) + " 秒无响应（静默卡死），重试 " + attempt + " 次仍失败"), _code);
              }
              if (_code === "TIMEOUT" && _totalTimedOut) {
                throw _tagErr(new Error("本轮调用超过 " + Math.round(_capMs / 60000) + " 分钟（流未关闭），重试 " + attempt + " 次仍失败"), _code);
              }
              if (attempt > 0) throw _tagErr(new Error(String((e && e.message) || e) + "（已重试 " + attempt + " 次）"), _code);
              throw e;
            }
            // 退避：指数上涨 + ±10% 抖动，封顶 10s（与 DSH localDelay 同式）
            const _base = Math.min(AGENT_RETRY_BASE_MS * Math.pow(2, attempt), AGENT_RETRY_CAP_MS);
            const _delay = Math.min(_base * (0.9 + Math.random() * 0.2), AGENT_RETRY_CAP_MS);
            _resetLiveView();
            try {
              if (window.__feedback && typeof window.__feedback.toast === "function") {
                const _why = _code === "TIMEOUT" ? "超时" : _code === "EMPTY_RESPONSE" ? "空响应" : "中断";
                window.__feedback.toast("上游" + _why + "，正在重试 " + (attempt + 1) + "/" + AGENT_RETRY_MAX + "…", 2600);
              }
            } catch (_nt) {}
            // 2026-11-11: 退避等待也响应停止键（旧版最长 10 秒内点停止无反应）。
            await new Promise(function (r) {
              var t = setTimeout(done, _delay);
              function done() {
                try { clearTimeout(t); } catch (_e) {}
                try { controller.signal.removeEventListener("abort", done); } catch (_e) {}
                r();
              }
              try { controller.signal.addEventListener("abort", done, { once: true }); } catch (_e) {}
            });
            if (controller.signal.aborted) throw e;
          } finally {
            _disarmIdle();
            _disarmTotal();
            try { controller.signal.removeEventListener("abort", _onHostAbort); } catch (e2) {}
          }
        }
      };
      const _callModelOnce = async (messages, schemas) => {
        // Vision：首轮把附图注入最后一条 user 消息（仅消费一次，后续轮不重复注入）
        // 2026-09-14: 附件在请求装配时展开(文件全文 / 图片视觉数组),不改 session;
        // 再过一遍协议装配 —— kernel 自己 push 的消息带 _tool 等 UI 字段,不能直接进请求体。
        const _msgsToSend = sanitizeToolProtocol(await expandAttachmentMessages(messages));
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: _callCtrl.signal, // 2026-10-08: 子 controller（链宿主 signal + 空闲看门狗），不再是 controller.signal
          body: JSON.stringify({
            stream: true, // 4.77: agent 改流式(原 false → 边收边渲染 + 增量重组 tool_calls);worker 流式已透传 tools/吐 tool_calls delta
            tools: schemas,
            tool_choice: "auto",
            mode: snapshotMode,
            model: snapshotModel,
            promptProfile: "assist", // 2026-10-04: Agent/工具类路径不吃 RP 专属的 Layer2 状态层(关系/情绪/好感/场景/摘要)
            use_builtin_persona: useBuiltin,
            custom_system_prompt: customPrompt,
            characterCard,
            // Agent 模式只需角色人格，不注入 RP 亲密度/情绪/剧情摘要（会污染工具调用语气）
            relation: "default",
            emotion: "neutral",
            affection: null,
            priorSummary: "",
            extraSystemPrompts: getExtraSystemPrompts(snapshotMode, characterCard) + (_kbInj ? "\n\n" + _kbInj : "") + (_envSnap ? "\n\n" + _envSnap : "") + AGENT_TOOL_USE_DIRECTIVE + (getAgentWorkMode() === "plan" ? AGENT_PLAN_DIRECTIVE : "") + (window.__skills && window.__skills.buildCatalogPrompt ? window.__skills.buildCatalogPrompt((charCap(characterCard) || {}).skillNames) : "") + ambientDirectorPrompt() + (agentPersonalize ? "\n\n【用户个性化指令】\n" + agentPersonalize : ""),
            // 4.82: 思考不再绑定快速档 —— 免费档也下发(worker 按 provider 方言装配参数)
            // 2026-11-11: 能力跟随当前渠道/模型 —— 不支持时强制 disabled，vllm 形态不带 reasoning_effort。
            ...thinkRequestPayload(),
            ...genParamPayload(), // 4.83: 用户在设置里填了 temperature/max_tokens 才带上(留空=不干预)
            replyStyle: localStorage.getItem("cfw_reply_style_v1") || "default",
            customProvider: customProviderSnapshot, // 4.69 BYO 自定义 API 直传
            ...activeProviderIdPayload(), // 2026-10-13 (E1c): 预设渠道显式选择（自定义活跃时不发）
            ...baseIdPayload(characterCard), // 基座版本（角色能力档可覆盖；未选=不发）
            ...stateLayerPayload(), // 2026-10-05：角色状态层(仅在设置里关掉时才发 false)
            ...webSearchPayload(), // 2026-10-07 联网搜索（开关打开时服务端才挂 web_search 工具）
            messages: _msgsToSend,
          }),
        });
        if (!res.ok) {
          const t = await res.text().catch(() => "");
          const _he = new Error("Request failed (" + res.status + "): " + formatChatErrorBody(t));
          _he.__httpStatus = res.status; // 供 _classifyCallError 路由（5xx/429 可重试，4xx 不可）
          throw _he;
        }
        // 4.77: 流式解析 SSE,边收边把"最终答复"渲染进气泡;增量重组 content / reasoning_content / tool_calls。
        // 复用 sendOne 的 sseBuf 行缓冲防跨 chunk 掉字;心跳(": ping")与调试(": __dbg__")注释行非 "data: " 开头自动跳过。
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let _sseBuf = "";
        let _content = "";
        let _reasoning = "";
        let _usage = null;
        const _toolMap = {}; // index -> { id, type, function:{ name, arguments } }
        let _lastLiveMs = 0;
        const _renderLive = () => {
          // 工具轮 content 通常为空;一旦出现 tool_calls 迹象就不再把半截正文当答复刷进气泡
          if (Object.keys(_toolMap).length) return;
          const _now = performance.now();
          if (_now - _lastLiveMs < 70) return;
          _lastLiveMs = _now;
          const _disp = stripPhotoSignalLive(stripJailbreakPrefix(stripThinkBlocks(_content)));
          // 2026-09-14 修:原来这里把累积的「前置话」(模型边说话边调工具的那段文字)拼进了气泡,
          // 于是**运行期间正文会蹦出工作流内容** —— 明明不是最终回复。前置话现在只进过程面板,
          // 气泡在运行期间只显示本轮真正在生成的内容(没有就保持空,跑完由最终渲染填正文)。
          const _shown = _disp;
          if (_shown) aiRow.bubble.textContent = _shown;
          else aiRow.bubble.textContent = "";
        };
        // 2026-09-12: 思考过程实时流式渲染——旧版只在整轮结束后才把 reasoning_content 写入折叠框,
        // 造成"思考非流式、直接蹦出来"的观感;现在跟 _renderLive 一样节流实时刷新折叠框文本。
        let _lastReasonLiveMs = 0;
        const _renderLiveReasoning = () => {
          if (!_reasoning) return;
          const _now = performance.now();
          if (_now - _lastReasonLiveMs < 120) return;
          _lastReasonLiveMs = _now;
          const _liveTxt = _agentReasonLines.concat([_reasoning]).join("\n");
          // Agent 模式:流式思考同样写进过程面板顶部
          _curRoundReason = _reasoning; // 流式期间只显示本轮已收到的思考
          try { if (_stepsLive) { _stepsLive.roundThinking(_curRoundReason); return; } } catch (_lr) {}
          if (!aiRow.reasoning) return;
          const rt = aiRow.reasoning.querySelector(".reasoning-text");
          if (!rt) return;
          rt.textContent = _liveTxt;
          if (getThinkDisplay() === "hide") { aiRow.reasoning.style.display = "none"; return; }
          aiRow.reasoning.style.display = "";
          aiRow.reasoning.open = true;
        };
        const _handleParsed = (parsed) => {
          // 返回值 = 这一条事件是否带来**实际进展**（正文/思考/工具调用）。
          // 上游会发 {"delta":{}} 这类合法但无内容的增量，靠它区分"真在干活"与"心跳式假活"。
          let _progress = false;
          if (parsed.usage) _usage = parsed.usage;
          const d = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
          if (!d) return _progress;
          if (typeof d.reasoning_content === "string" && d.reasoning_content) { _reasoning += d.reasoning_content; _progress = true; _renderLiveReasoning(); }
          if (typeof d.content === "string" && d.content) { _content += d.content; _lastAgentContent = _content; _progress = true; _renderLive(); }
          if (Array.isArray(d.tool_calls)) {
            for (const tc of d.tool_calls) {
              _progress = true;
              const idx = (typeof tc.index === "number") ? tc.index : 0;
              const slot = _toolMap[idx] || (_toolMap[idx] = { id: "", type: "function", function: { name: "", arguments: "" } });
              if (tc.id) slot.id = tc.id;
              if (tc.type) slot.type = tc.type;
              if (tc.function) {
                if (tc.function.name) slot.function.name = tc.function.name;
                if (typeof tc.function.arguments === "string") slot.function.arguments += tc.function.arguments;
              }
            }
          }
          return _progress;
        };
        // 2026-11-09：空增量连续计数。旧版"收到 data 行就重置看门狗"有一个缺口 ——
        // 上游若持续吐 {"delta":{}}（合法空事件），看门狗被无限喂饱，UI 永远"思考中"。
        // 两家参照实现都没这条（DSH/ZCode 的看门狗只认"有没有事件"），但它们都有整轮超时兜底；
        // 我们两样都补，这里是"有事件、无内容"的那一半。
        let _emptyStreak = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) { _sseBuf += decoder.decode(); break; }
          _sseBuf += decoder.decode(value, { stream: true });
          let _nl;
          while ((_nl = _sseBuf.indexOf("\n")) >= 0) {
            const line = _sseBuf.slice(0, _nl);
            _sseBuf = _sseBuf.slice(_nl + 1);
            if (!line.startsWith("data: ")) continue;
            const jsonStr = line.slice(6).trim();
            if (!jsonStr || jsonStr === "[DONE]") continue;
            // 2026-11-09 修：原来每收到一块字节就重置 90 秒看门狗 —— 上游的 keep-alive
            // 心跳（`: ping` / 空行）也会喂它，于是"上游在吐心跳但模型没输出"时永远不超时，
            // UI 停在"思考中"（实测快速档可卡住数分钟）。改为只有**真正的 data 事件**才算
            // "上游在干活"；心跳/空行不再重置，静默 90 秒仍会被看门狗中止。
            _armIdle(_idleMsNow);
            let _parsedEvt = null;
            try { _parsedEvt = JSON.parse(jsonStr); } catch (e) {}
            if (!_parsedEvt) continue; // 半截 JSON：整体已按行缓冲，这里只是兜底
            let _progress = false;
            try { _progress = _handleParsed(_parsedEvt); }
            catch (_he) { _progress = true; } // 渲染层异常不该被当成"上游没内容"
            if (_progress) _emptyStreak = 0;
            else if (++_emptyStreak > AGENT_EMPTY_STREAK_MAX) {
              throw _tagErr(new Error("上游连续 " + _emptyStreak + " 个空事件（无正文/无思考/无工具调用），判定流已失效"), "TIMEOUT");
            }
          }
        }
        // 残行兜底:服务端最后一个 data 事件可能不带结尾 \n(同 sendOne Bug⑦ 修法)
        if (_sseBuf.trim()) {
          const line = _sseBuf.trim();
          if (line.startsWith("data: ")) {
            const jsonStr = line.slice(6).trim();
            if (jsonStr && jsonStr !== "[DONE]") { try { _handleParsed(JSON.parse(jsonStr)); } catch {} }
          }
        }
        // 按 index 升序重组完整 tool_calls;丢弃没拼出 name 的空槽,缺 id 时补一个(上游偶发不下发 id)
        const _toolCalls = Object.keys(_toolMap)
          .sort((a, b) => Number(a) - Number(b))
          .map((k) => _toolMap[k])
          .filter((t) => t && t.function && t.function.name)
          .map((t) => ({ id: t.id || ("call_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)), type: t.type || "function", function: { name: t.function.name, arguments: t.function.arguments || "" } }));
        // 2026-06-17 agent 模式记账:流式末尾 stream_options.include_usage 带回 usage,快速模式按量补记(逐轮累加)
        try {
          if (snapshotMode === "fast" && _usage) {
            const _p = _usage.prompt_tokens || 0;
            const _c = _usage.completion_tokens || 0;
            const _cached = _usage.prompt_cache_hit_tokens || 0;
            _roundUsage.p += _p; _roundUsage.c += _c; _roundUsage.n += 1; // 4.83: 供回合结束回填统计
            const _priceCtx = pricingContext(snapshotMode, snapshotModel, customProviderSnapshot);
            const _cost = calcCost(_priceCtx, _p, _c, _cached);
            if (_cost > 0) {
              totalCostCNY += _cost;
              totalPromptTokens += _p;
              totalCompletionTokens += _c;
              addCostToToday(_cost, _p, _c);
              updateCostDisplay();
            }
          }
        } catch (e) {}
        // 2026-11-09（对齐 DSH 的 EMPTY_RESPONSE）：流正常结束但一个内容块都没有 —— "空完成"。
        // DSH 在 dsh-llm/types/error.js 里把它定为可重试失败码，注释原话：
        //   "an empty message silently ends the turn with nothing for the user or the loop to act on"。
        // 我们这里如果放它过去，内核会当成"模型说完了"，用一条空消息静默收掉整轮 —— 表现就是
        // 工具跑到一半忽然"没反应了"。判定为失败并交给重试预算。
        if (!_toolCalls.length && !String(_content || "").trim() && !String(_reasoning || "").trim()) {
          throw _tagErr(new Error("上游返回空响应（流正常结束，但无正文、无思考、无工具调用）"), "EMPTY_RESPONSE");
        }
        const _msg = { role: "assistant", content: _content };
        if (_toolCalls.length) _msg.tool_calls = _toolCalls;
        // 2026-06-20:本轮若「既有正文又要调工具」,正文是面向用户的前置话(问候/道歉/说明),累积下来,
        // 供最终气泡和 session 落地时拼回,避免被后续轮次覆盖吞掉。
        if (_toolCalls.length && _content && _content.trim()) {
          const _pre = stripResidualMarkup(stripJailbreakPrefix(stripThinkBlocks(_content)));
          if (_pre && _pre.trim()) {
            _agentPreamble += (_agentPreamble ? "\n\n" : "") + _pre.trim();
            // 第2期:前置话归进「过程块」——收起后不再占版面,正文气泡只留最终回答
            try { const _S = _steps(); if (_S) _S.preamble(_pre.trim()); } catch (_pe) {}
          }
        }
        if (_reasoning) _msg.reasoning_content = _reasoning;
        // 4.73 捕获本轮模型推理(思考模式 reasoning_content + 正文内联 <think>)汇入折叠框
        try {
          const _rc = (_reasoning || "").trim();
          const _inlineTh = extractThinkText(_content || "");
          const _piece = [_rc, _inlineTh].filter(Boolean).join("\n");
          if (_piece) { _agentReasonLines.push(_piece); _renderAgentReasoning(_piece); } // 传本轮,用于分轮显示
        } catch (e) {}
        return _msg;
      };

      // kernel 在 messages 里 push assistant/tool 消息。起始喂当前 session 的**协议化副本**
      // (剥掉 UI 字段、满足 §G-1/§G-2),并提前记下长度以便 loop 结束后取出这一轮新增的消息。
      // 4.82 修:必须**先展开附件再协议化** —— sanitizeToolProtocol 会剥掉 files/images 字段,
      // 顺序反了则附件全文/图片在起始消息里就没了,callModel 里的 expandAttachmentMessages 再找不到
      // files 可展开 → Agent 模式下上传的文件永远进不了模型上下文(表现为「文件没算进上下文」)。
      // 2026-10-08: 与 RP 路径同口径 —— 先按"当前场景 + 本角色"投影（工具轮不受投影影响），
      // 再展开附件/协议化。Agent 模式与群聊互斥，所以这里的世界就是"本角色视角"。
      const startMessages = sanitizeToolProtocol(await expandAttachmentMessages(selectSpeakerView(session, { scope: currentScopeKey(), card: characterCard })));
      const _startLen = startMessages.length;
      // 4.69 控制台接线 + 子 agent 编排:把右栏 agent 控制台的 onEvent/ensurePermission 喂进内核,
      // 并把 callModel/onEvent/depth 透传进 context,供 delegate_to_agent 派生子 agent 时复用。
      const _ac = window.__agentConsole || null;
      // 4.83: 每轮发送前清空右栏「活动」面板 —— 旧版内容跨轮堆积,一个会话多轮之后时间线很长。
      // 上一轮仍在运行时不清理:既避免抹掉用户正在看的过程,
      // 也避免清掉未决的「等待放行」卡(其 resolve 还挂着,清了就再也点不到了)。
      try {
        const _acRunning = !!(window.AgentKernel && typeof window.AgentKernel.isRunning === "function" && window.AgentKernel.isRunning());
        if (_ac && typeof _ac.clear === "function" && !_acRunning) _ac.clear();
      } catch (_) {}
      const _consoleOnEvent = (_ac && typeof _ac.onEvent === "function") ? _ac.onEvent : function () {};
      // 2026-09-14 第2期:工具调用不再压成 `▶ 工具名 ✓` 一行文本塞进思考折叠块,改为在气泡上方
      // 渲染「轮次步骤卡片」(ui/agent-steps.js) —— 每轮一张卡,展开能看到入参与**工具返回了什么**。
      // 折叠块只留模型真实推理(reasoning_content / <think>),不再混入工具行。
      var _stepsLive = null;
      var _stepsEnd = undefined; // 过程块的收尾原因（finally 里兜底收尾用；undefined=正常）
      const _steps = () => {
        if (!_stepsLive) {
          try {
            _stepsLive = (window.__agentSteps && aiRow && aiRow.bubble) ? window.__agentSteps.mountLive(aiRow.bubble) : null;
            if (_stepsLive && aiRow.rowEl) aiRow.rowEl.dataset.agentProcess = "1";
          } catch (_) { _stepsLive = null; }
        }
        return _stepsLive;
      };
      const _onEvent = (ev) => {
        try { _consoleOnEvent(ev); } catch (e) {}
        try {
          const S = _steps();
          if (!S) return;
          if (ev.type === 'model_call') { _curRoundReason = ""; S.model_call(); }
          else if (ev.type === 'tool_run' && ev.name) S.tool_run(ev.name, ev.args || {});
          else if (ev.type === 'tool_done' && ev.name) S.tool_done(ev.name, { ok: ev.ok !== false, ms: ev.ms, summary: ev.summary });
          else if (ev.type === 'tool_error' && ev.name) S.tool_error(ev.name, { error: ev.message || ev.error || '调用失败', ms: ev.ms });
          else if (ev.type === 'tool_denied' && ev.name) S.tool_denied(ev.name, ev.args || {});
          // 2026-10-08 多智能体编排：小会/上台的过程进同一块过程面板（可见但不进时间线）
          else if (ev.type === 'meeting_start') S.meeting_start(ev);
          else if (ev.type === 'meeting_speaker') S.meeting_speaker(ev);
          else if (ev.type === 'peer_invite') S.peer_invite(ev);
          if (isNearBottom()) scrollToBottom();
        } catch (_) {}
      };
      const _askBase = (_ac && typeof _ac.ensurePermission === "function") ? _ac.ensurePermission : null;
      const _ensurePermission = makeAgentPermission(getAgentWorkMode(), _askBase);
      // 2026-10-08: 工具轮写回抽成函数 —— 正常收尾与"用户中断"两条路都要走它。
      // 中断时内核已把悬空调用配对（err._agentMessages），写回后会话里不再留断掉的协议尾巴；
      // 重试/删除 走的是"明确丢弃半截"（_discardPartialFlag），那条路不写回 ——
      // 否则 chat-ux 刚做的截断会被这条迟到的回写又补回来（幽灵回复）。
      // 必须用 var(函数作用域): 定义在 try 块内、调用点在 catch 块,const/let 的块作用域在 catch 里
      // 取不到（同 `_roundUsage` 那条注释的教训 —— 实测这一条会让中断自愈静默失效）。
      var _writeBackRounds = (allMsgs) => {
        try {
          if (myGen !== sendGen || _discardPartialFlag) return;
          const _newMsgs = Array.isArray(allMsgs) ? allMsgs.slice(_startLen) : [];
          // 末条是内核自造的「最终答复」assistant —— 正文会用清洗后的版本单独入 session,避免重复
          if (_newMsgs.length && _newMsgs[_newMsgs.length - 1].role === "assistant") _newMsgs.pop();
          _newMsgs.forEach((m) => {
            if (_steerMsgs.has(m)) return; // 插话已在发送时入过 session，别重复
            if (m.role === "tool") {
              const t = { role: "tool", tool_call_id: m.tool_call_id, content: m.content };
              if (m._tool) t._tool = m._tool;
              session.push(scopeTag(t));
              return;
            }
            if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
              const a = { role: "assistant", content: "", tool_calls: m.tool_calls };
              if (m.reasoning_content) a.reasoning_content = m.reasoning_content;
              if (m.content) a.agentPreamble = m.content; // 该轮附带的可见正文(仅给 UI 展示)
              if (characterCard) { a.speakerId = characterCard.id; a.speakerName = characterCard.name; a.speakerIcon = characterCard.icon || "🙂"; }
              session.push(scopeTag(a));
              return;
            }
            session.push(scopeTag({ role: m.role, content: typeof m.content === "string" ? m.content : "" }));
          });
          if (_newMsgs.length) persistSessionIfEnabled();
        } catch (_wb) {}
      };
      // 2026-10-08 角色记忆：小本子（char_db_*）+ 知识库检索（kb_search / kb_read）
      if (window.__charMemory && typeof window.__charMemory.defineTools === "function") {
        try { window.__charMemory.defineTools(registry); } catch (e) { console.warn('[char-memory] defineTools 失败:', e); }
      }
      // 2026-10-08 知识库命中注入：按「当前发言者 + 最后一条用户消息」取 top-K（本地检索，零 token 成本；
      // 命中才有内容）。知识库是"每个角色一套"，所以取的是这张卡的库。
      let _kbInj = "";
      try {
        if (window.__charMemory && typeof window.__charMemory.buildInjection === "function") {
          let _lastUser = "";
          for (let i = startMessages.length - 1; i >= 0; i--) {
            if (startMessages[i] && startMessages[i].role === "user") { _lastUser = String(startMessages[i].content || ""); break; }
          }
          _kbInj = await window.__charMemory.buildInjection(characterCard, _lastUser);
        }
      } catch (e) {}
      // 2026-09-14:最大工具轮数改为可配(原来写死内核默认值 8)。设置页「Agent 工具集」卡里可改。
      // 2026-10-08: signal 交给内核 —— 停止/重试/删除 的中断要能掀掉"等待放行"与轮间空档。
      const result = await window.AgentKernel.runAgentLoop({
        messages: startMessages,
        registry,
        callModel,
        maxIterations: getAgentMaxRounds(),
        context: { characterCard, callModel, onEvent: _onEvent, ensurePermission: _ensurePermission, depth: 0 },
        onEvent: _onEvent,
        ensurePermission: _ensurePermission,
        // 2026-11-10: 用户「插话」在每次模型请求前注入（对齐 ZCode 的工作中发消息）。
        // 放在 beforeStep 而不是 abort 重开：上下文不重置，模型把插话当成新的用户指令。
        beforeStep: [function _drainSteerAndShots() {
          const out = [];
          // 截图先注入：模型下一轮先看到画面，再读到用户插话
          if (_agentImageQueue && _agentImageQueue.length) {
            for (const im of _agentImageQueue.splice(0)) {
              const meta = im.meta || {};
              out.push({
                role: "user",
                content: [
                  { type: "text", text: "[pc_shot] 远程电脑截图" + (meta.w ? " " + meta.w + "x" + meta.h : "") + "。画面仅供判断；要点击请用 pc_ui 的控件坐标或 pc_click_control。" },
                  { type: "image_url", image_url: { url: im.dataUrl } },
                ],
              });
            }
          }
          if (_agentSteerQueue && _agentSteerQueue.length) out.push(..._agentSteerQueue.splice(0));
          return out.length ? { append: out } : undefined;
        }],
        signal: controller.signal,
      });
      finalText = (result && result.finalText) || "";
      // 整轮结束:过程块自动收起成一行摘要(对齐 ZCode —— 过程只在运行时展开,跑完收起,下面才是正文)
      _stepsEnd = "done";
      try { if (_stepsLive) _stepsLive.finish("done"); } catch (_fz) {}

      // 2026-09-14 根因修复:把工具轮次**写回 session**（2026-10-08 抽成 _writeBackRounds）。
      // 旧实现里 startMessages 只是 session 的浅拷贝,result.messages 出了作用域就丢 ——
      // 于是下一条用户消息时,模型完全不知道自己上轮调过什么工具、拿到了什么结果,每次失忆重开。
      // 这正是 Agent「像过家家」的头号原因。现在按协议顺序 assistant(带 tool_calls) → tool(结果)
      // 追加进 session 并持久化(agentPreamble/_tool 是 UI 专用,请求装配时会剥掉)。
      _writeBackRounds(result && result.messages);
    } catch (e) {
      if (e.name === "AbortError") {
        // 2026-10-08: 中断也要收尾过程块 —— 旧版只在正常结束/报错时收尾，点停止后过程块一直转"运行中…"
        // （截图实证：气泡已显示"（已中断）"，过程块还在转）。
        _stepsEnd = "aborted";
        // 2026-10-08: 中断时内核已配对悬空 tool_calls（挂在 err._agentMessages 上），
        // 先把工具轮写回 —— 否则断掉的协议随会话落盘，重启后每次请求被上游 400。
        // （_writeBackRounds 为 var：定义在 try 内、此处可用；理论上更早的异常可能让它还是 undefined）
        if (e._agentMessages && typeof _writeBackRounds === "function") _writeBackRounds(e._agentMessages);
        // 4.79 中断兜底:流被掐断(新发一条/停止/重试/删除/pacing/切角色)时,不再裸 return 丢掉半截,
        // 而是把已收到的可见正文清洗后定格为最终态并入 session(对齐普通 sendOne 的 partialStream 兜底)。
        // 2026-10-08: 只有"保留半截"的停止路径才落盘；重试/删除（discardPartial）不落 —— 那条路正在截断。
        if (myGen === sendGen && !_discardPartialFlag) {
          try {
            const _salvBody = stripResidualMarkup(stripJailbreakPrefix(stripThinkBlocks(_lastAgentContent || "")));
            // 2026-06-20:中断兜底也带上工具轮前置正文,避免 abort 时把已说的问候/道歉一并丢掉。
            const _salv = _agentPreamble ? (_agentPreamble + (_salvBody ? "\n\n" + _salvBody : "")) : _salvBody;
            if (_salv && _salv.trim()) {
              aiRow.bubble.innerHTML = renderMarkdownSafe(_salv);
              const _am = { role: "assistant", content: _salv };
              if (_agentReasonLines.length) _am.reasoning_content = _agentReasonLines.join("\n");
              if (characterCard) { _am.speakerId = characterCard.id; _am.speakerName = characterCard.name; _am.speakerIcon = characterCard.icon || "🙂"; }
              _am._meta = _replyMeta; // 2026-10-05: 中断兜底也留来源标注
              session.push(scopeTag(_am));
              try { aiRow.rowEl.dataset.sidx = String(session.length - 1); } catch (_sx) {} // 2026-10-08
              persistSessionIfEnabled();
            } else if (myGen === sendGen) {
              // 一点内容都没收到就被停止：不留"思考中…"挂在气泡里（旧版会一直挂着直到刷新）
              try { aiRow.bubble.textContent = "（已中断）"; } catch (_ib) {}
            }
          } catch (_se) {}
          isSending = false; sendBtn.disabled = false; if (currentController === controller) currentController = null;
        }
        setStreamingUI(aiRow.rowEl, false);
        return;
      }
      if (myGen === sendGen) {
        aiRow.bubble.textContent = "网络错误: " + e.message;
        // 2026-10-13 (E1c): Agent 路径的失效模型自愈（throw 里带 "Request failed (status)" 口径）
        const _m = /Request failed \((\d+)\)/.exec(String(e.message || ""));
        if (_m && looksLikeInvalidModel(Number(_m[1]), e.message)) attachModelReselectButton(aiRow);
      }
      _stepsEnd = "error";
      finalText = "";
    } finally {
      // 2026-10-08 兜底：任何出口都让过程块收尾（正常路径已在上面收过，重复调用是幂等的）
      try { if (_stepsLive) _stepsLive.finish(_stepsEnd); } catch (_fz) {}
      if (myGen === sendGen) {
        isSending = false;
        sendBtn.disabled = false;
        _agentSteerQueue = null;
        _agentImageQueue = null;
        try { window.__agentVisionOn = false; } catch (e) {}
        updateSendBtnState();
        if (currentController === controller) currentController = null;
      }
      setStreamingUI(aiRow.rowEl, false);
    }

    if (myGen !== sendGen) return;

    // 渲染最终回复(复用 sendOne 清洗:去思考块 / 哨兵前缀 / 残括号)
    let _finalBody = stripResidualMarkup(stripJailbreakPrefix(stripThinkBlocks(finalText)));
    // 2026-09-14:正文气泡只放**最终回答** —— 工具轮的前置话已归入上方「过程块」(收起后不占版面),
    // 不再像以前那样拼进正文,避免"又像聊天又像 agent"的四不像观感。
    let full = _finalBody;
    // Agent 回复用 innerHTML 渲染 Markdown（代码块/表格/标题/粗体）
    if (full) { aiRow.bubble.innerHTML = renderMarkdownSafe(full); } else { aiRow.bubble.textContent = "(无内容)"; }
    // 4.73 agent 运行结束:思考折叠块按「思考过程显示」设置回落(show 展开 / collapse 折叠 / hide 隐藏)
    if (aiRow.reasoning) applyThinkDisplay(aiRow.reasoning);

    // 好感标签解析(与 sendOne 一致;工具 adjust_affinity 已可由模型直接调,此处兜底文本标签)
    if (ch && ch.parseAffectionTag) {
      const tagRes = ch.parseAffectionTag(full);
      if (tagRes.delta && affection !== null) { try { await ch.adjustActiveAffection(tagRes.delta); } catch {} }
      if (tagRes.stripped !== full) { full = tagRes.stripped; aiRow.bubble.innerHTML = renderMarkdownSafe(full); }
    }

    // 2026-10-06 氛围音标签:[[amb:…]]/[[mus:…]]/[[voice:…]] 执行 + 剥离(Agent 模式也可直接调 set_ambient 工具)
    {
      const _ambClean = applyAmbientTags(full);
      if (_ambClean !== full) { full = _ambClean; aiRow.bubble.innerHTML = renderMarkdownSafe(full); }
    }

    const asMsg = { role: "assistant", content: full };
    if (_agentReasonLines.length) asMsg.reasoning_content = _agentReasonLines.join("\n"); // 4.73 思考归档随会话持久化,刷新后仍可展开
    if (characterCard) {
      asMsg.speakerId = characterCard.id;
      asMsg.speakerName = characterCard.name;
      asMsg.speakerIcon = characterCard.icon || "🙂";
    }
    asMsg._meta = _replyMeta; // 2026-10-05: 本轮模型 + 底座来源标注
    session.push(scopeTag(asMsg));
    try { aiRow.rowEl.dataset.sidx = String(session.length - 1); } catch (_sx) {} // 2026-10-08: 删除本行时按真实下标算
    persistSessionIfEnabled();

    // 4.83: 回合结束回填 AI 行统计 —— 旧版开场 aiRow.stats.textContent="" 之后从不回填,
    // agent 模式下整个回合都看不到 token 统计。有真实 usage 用真实值(跨轮累计),
    // 免费模式上游不回 usage 则按估算(与实时路径「Output(估算)」约定一致)。
    try {
      if (_roundUsage.n > 0) {
        aiRow.stats.textContent = `Prompt: ${_roundUsage.p} | Completion: ${_roundUsage.c} | Total: ${_roundUsage.p + _roundUsage.c} | ${_roundUsage.n} 次模型调用`;
      } else {
        const _outEst = estimateTokens(full || "");
        totalOutEstimate += _outEst;
        aiRow.stats.textContent = `Output(估算): ≈${_outEst} | Total Out(估算): ≈${totalOutEstimate}`;
      }
    } catch (_) {}

    updateSpacer();
    scrollToBottom();
    return full;
  }

  // sendOne(opts):核心发送逻辑,可由鱼缸引擎(fishbowl-engine.js)驱动
  // opts: { text?, allowEmptyText?, fishbowlMode?, topic?, asCard? }
  // 不传 opts.text 时从 inputEl 取;返回 AI 完整回复文本,失败/中断返回 null/undefined
  async function sendOne(opts) {
    if (isSending) return null;
    _discardPartialFlag = false; // 新一轮开始：清掉上一轮的"明确丢弃"标记
    // 内核接线 v1:Agent 内核模式开启时改走 sendOneAgent(function-calling + agent loop);默认关走原流式路径
    if (isAgentModeOn()) {
      return await sendOneAgent(opts);
    }
    const opts0 = opts || {};
    const isAuto = opts0.text != null;
    updateSpacer();
    const text = isAuto ? String(opts0.text).trim() : inputEl.value.trim();
    const allowEmpty = !!opts0.allowEmptyText;
    // 2026-09-14: 只附图/文件不打字也应能发送
    if (!text && !allowEmpty && !attCount()) return null;

    isSending = true;
    sendBtn.disabled = true;

    // 阶段 4-③：长对话自动压缩 —— 2026-11-08 升级(对标 ZCode auto-compact)：触发改双通道
    //   ① token 水位（主）：会话估算 token ≥ 70% × 当前模型上下文窗口 —— 给摘要生成与后续
    //      请求预留空间，不等到满窗才压；窗口来源 = 手动覆盖(cfw_ctx_window_v1) > worker
    //      /config.js 下发的 APP_CTX_EXACT/HINTS > 128K 兜底，与右栏状态面板同一套数据
    //   ② 条数保底：session.length > summaryTrigger —— 旧口径保留（短消息密集对话兜底）
    //   最小守护：session.length > 4（至少要有可压缩的轮次）
    if (historyEnabled && summaryEnabled && !summarizing && session.length > 4 &&
        (_sessTokensForCompact() >= _ctxLimitForCompact() * 0.7 || session.length > summaryTrigger)) {
      const prevCostText = costDisplayEl ? costDisplayEl.textContent : "";
      try {
        summarizing = true;
        if (costDisplayEl) costDisplayEl.textContent = "正在压缩早期历史…"; // 4.71: 去掉 📚
        const cutoff = Math.max(0, session.length - summaryKeep);
        const toSum = session.slice(0, cutoff);
        const chEarly = window.__character || null;
        const cardEarly = chEarly && chEarly.getActiveCard ? chEarly.getActiveCard() : null;
        const _byoSummary = (window.__byoProvider && window.__byoProvider.get && window.__byoProvider.get()) || undefined;
        const r = await fetch("/api/summarize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: toSum, priorSummary,
            characterName: cardEarly ? cardEarly.name : "",
            customProvider: _byoSummary,
            model: _byoSummary ? _byoSummary.model : undefined,
          }),
        });
        if (r.ok) {
          const j = await r.json().catch(() => null);
          if (j && typeof j.summary === "string" && j.summary.trim()) {
            priorSummary = j.summary.trim();
            localStorage.setItem(LS_PRIOR_SUMMARY, priorSummary);
            localStorage.removeItem("cfw_summary_chip_hidden_v1");
            const allRows = Array.from(chatEl.children).filter(n => n !== spacerEl && n.classList && n.classList.contains("row"));
            const removeN = Math.min(cutoff, allRows.length);
            for (let i = 0; i < removeN; i++) chatEl.removeChild(allRows[i]);
            session.splice(0, cutoff);
            persistSessionIfEnabled();
            renderSummaryChip();
          }
        }
      } catch (e) {
        console.warn("auto-summarize failed:", e);
      } finally {
        summarizing = false;
        if (costDisplayEl) costDisplayEl.textContent = prevCostText;
        updateCostDisplay();
      }
    }

    const myGen = ++sendGen;
    const controller = new AbortController();
    currentController = controller;
    partialStream = { full: "", fullReasoning: "", speakerId: "", speakerName: "", speakerIcon: "" };

    // 鱼缸 V3:text 为空(allowEmptyText 模式下,鱼缸引擎驱动 / 群聊点角色 chip 直发)时
    // 跳过创建 user row,直接进 AI —— 消灭空 User 气泡污染观感
    // 2026-09-14: 附件(文本/图片)快照到消息上;只附附件不打字也会建气泡
    const _attB = takeAttachments();
    if (text || attHasAny(_attB)) {
      const userRow = makeRow("user");
      if (text) userRow.bubble.textContent = text;
      renderAttachmentsInto(userRow.bubble, _attB);
      applyUserFold(userRow.bubble);
      const inEst = estimateTokens(text) + attFileTokens(_attB);
      totalInEstimate += inEst;
      userRow.stats.textContent = `Input(估算): ≈${inEst} | Total In(估算): ≈${totalInEstimate}`;
      session.push(scopeTag(Object.assign({ role: "user", content: text }, attMeta(_attB))));
      try { userRow.rowEl.dataset.sidx = String(session.length - 1); } catch (_sx) {} // 2026-10-08: 重试/删除按真实下标算
      persistSessionIfEnabled();
    }
    if (!isAuto) {
      inputEl.value = "";
      inputEl.style.height = "auto";
    }
    updateSpacer();
    scrollToBottom();

    const aiRow = makeRow("assistant", { side: opts0.side || null });
    setStreamingUI(aiRow.rowEl, true);
    // 4.19 P2 fix: decorate 调用挪到 characterCard 定义之后（修 TDZ ReferenceError —— 1293 漏看变量声明顺序导致 sendOne 一进去就抛错，普通发送/接龙/鱼缸全死）
    let outStartMs = 0;
    let outEndMs = 0;
    let full = "";
    let fullReasoning = "";
    let reasoningCollapsed = false;
    let _lastLiveRenderMs = 0; // 4.70 流式渲染节流时间戳(降 O(n²) 重算)
    let _lastThinkRenderMs = 0; // 2026-10-05 思考块渲染节流时间戳(与正文同款 70ms;reasoning 的 delta 密得多,见下)
    let exactUsage = null;
    let customPrompt = "";

    if (!useBuiltin && promptEnabled) {
      customPrompt = localStorage.getItem(LS_CUSTOM_PROMPT) || "";
    }

    // 角色卡数据（由 character.js 提供；Worker 端 buildSystemPrompt 用三层架构拼接）
    const ch = window.__character || null;
    // 鱼缸引擎驱动时用 opts.asCard 强制指定发言者(避免 active card 被切换造成错位)
    const characterCard = opts0.asCard
      ? opts0.asCard
      : (ch && ch.getActiveCard ? ch.getActiveCard() : null);
    // 4.19 P1 fix: 显式传 characterCard —— setActiveId 是异步 (await IndexedDB),
    // 鱼缸下一轮 setActive 后立刻进 sendOne,decorate 读模块级 _card 会拿到上一轮 → label 偏移
    // 4.19 P2 fix: 这段必须放在 const characterCard 定义之后,否则 TDZ ReferenceError 整个 sendOne 挂掉
    if (window.__character && window.__character.decorateAiRow) {
      window.__character.decorateAiRow(aiRow.rowEl, characterCard);
    }
    const relation = ch && ch.getActiveRelation ? ch.getActiveRelation() : "default";
    const emotion = ch && ch.getActiveEmotion ? ch.getActiveEmotion() : "neutral";
    const affection = ch && ch.getActiveAffection ? ch.getActiveAffection() : null;
    const sceneOtherNames = (window.__multi && window.__multi.getSceneOtherNames) ? window.__multi.getSceneOtherNames() : [];
    // 4.52 在场感 part2:仅在群聊驱动场景(编排≥2 / 接龙 / 讨论)下,把"可召唤的场景外角色"喂给 worker,让 AI 能 [召唤:X] 叫人入场
    const _summonActive = isGroupChatActive() || (opts0.fishbowlMode && opts0.fishbowlMode !== "orchestrate");
    const summonableNames = (_summonActive && window.__multi && window.__multi.getSummonableNames)
      ? window.__multi.getSummonableNames(characterCard ? characterCard.id : "")
      : [];
    // 阶段 4-②：好感度阈值事件（一次性，发送成功后立即清空）
    const thresholdEvents = (ch && ch.getPendingThresholdEvents) ? ch.getPendingThresholdEvents() : [];
    // 4.49 P3 世界书：按最近对话文本 + 当前角色卡 scope 筛出当前生效条目（常驻 / 关键词命中），priority 降序
    let lorebookEntries = [];
    try {
      if (window.__lorebook && window.__lorebook.getActiveEntries) {
        const scanText = [text].concat(session.slice(-6).map(m => (m && m.content) || "")).join("\n");
        lorebookEntries = window.__lorebook.getActiveEntries({ text: scanText, cardId: characterCard ? characterCard.id : "" })
          .map(e => ({ name: e.name, content: e.content }));
      }
    } catch (e) {}
    if (partialStream && characterCard) {
      partialStream.speakerId = characterCard.id;
      partialStream.speakerName = characterCard.name;
      partialStream.speakerIcon = characterCard.icon || "🙂";
    }

    const snapshotMode  = currentMode;
    const customProviderSnapshot = (window.__byoProvider && window.__byoProvider.get && window.__byoProvider.get()) || undefined;
    const snapshotModel = customProviderSnapshot ? customProviderSnapshot.model : modelSel.value;
    if (!ensureUsableModelBeforeSend(snapshotMode, snapshotModel, customProviderSnapshot)) {
      isSending = false;
      sendBtn.disabled = false;
      currentController = null;
      partialStream = null;
      return null;
    }
    // 2026-10-05: 本轮回复的来源标注(见 sendOneAgent 同名注释)。baseId 空串 = 用默认档(排序第一份)。
    // sanitizeToolProtocol 白名单重建会剥掉它,不会流到上游。
    const _replyMeta = { model: snapshotModel, baseId: baseIdPayload(characterCard).baseId || "" };

    try {
      // 2026-09-14: 附件在请求装配时展开(文件全文拼进 content / 图片转视觉数组),session 本身不动。
      // 非 Agent 模式下把工具轮整段剔除 —— 不支持 function calling 的模型收到 tool 轮会直接报错,
      // 而工具轮的价值只在于 agent 循环内部;最终答复本身已经是普通 assistant 消息,上下文不丢。
      // 2026-10-08: 先投影成"当前发言者的上下文"（场景键过滤 + 他人发言降级为 user【名字】），
      // 再展开附件/协议化 —— 这样每个角色拿到的是自己的历史，不再共享同一条。
      // 发言者取 opts.asCard（鱼缸/编排显式指定）优先，否则当前激活卡。
      const _speakerCard = opts0.asCard || (ch && ch.getActiveCard ? ch.getActiveCard() : null);
      const _reqMessages = sanitizeToolProtocol(
        await expandAttachmentMessages(selectSpeakerView(session, { scope: currentScopeKey(), card: _speakerCard })),
        { dropToolRounds: true }
      );
      // 2026-10-08 知识库命中注入：按「当前发言者 + 最后一条用户消息」取 top-K（本地检索、零 token 成本）
      let _kbInj = "";
      try {
        if (window.__charMemory && typeof window.__charMemory.buildInjection === "function") {
          let _lastUser = "";
          for (let i = _reqMessages.length - 1; i >= 0; i--) {
            if (_reqMessages[i] && _reqMessages[i].role === "user") { _lastUser = String(_reqMessages[i].content || ""); break; }
          }
          _kbInj = await window.__charMemory.buildInjection(_speakerCard, _lastUser);
        }
      } catch (e) {}
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          customProvider: customProviderSnapshot, // 4.69 BYO 自定义 API 直传
          mode: snapshotMode,                          // 新增
          model: snapshotModel,
          promptProfile: "rp", // 2026-10-04: 主聊天(含群聊/鱼缸/自驱)吃全套 RP 层
          use_builtin_persona: useBuiltin,
          custom_system_prompt: customPrompt,
          characterCard,
          relation,
          emotion,
          affection,
          sceneOtherNames,
          summonableNames,
          thresholdEvents,
          priorSummary: historyEnabled ? priorSummary : "",
          extraSystemPrompts: getExtraSystemPrompts(snapshotMode, characterCard) + (_kbInj ? "\n\n" + _kbInj : "") + ((window.__chatImageText && window.__chatImageText.getInjection) ? window.__chatImageText.getInjection() : "") + groupChatInjection(characterCard) + ambientDirectorPrompt(), // 2026-10-06: 技能不再走这里——只有 agent 模式挂「技能目录」，正文由 load_skill 按需取;
          // 4.82: 思考不再绑定快速档 —— 免费档也下发(worker 按 provider 方言装配参数)
          // 2026-11-11: 能力跟随当前渠道/模型 —— 不支持时强制 disabled，vllm 形态不带 reasoning_effort。
          ...thinkRequestPayload(),
          ...genParamPayload(), // 4.83: 用户在设置里填了 temperature/max_tokens 才带上(留空=不干预)
          fishbowlMode: opts0.fishbowlMode || null,
          topic: opts0.topic || "",
          // 2026-05-29: 回复风格 (default / wechat / verbose) - wechat 会在后面拆气泡
          replyStyle: localStorage.getItem("cfw_reply_style_v1") || "default",
          lorebook: lorebookEntries,
          ...baseIdPayload(characterCard), // 基座版本（角色能力档可覆盖；未选=不发）
          ...stateLayerPayload(), // 2026-10-05：角色状态层(仅在设置里关掉时才发 false)
          ...webSearchPayload(), // 2026-10-07 联网搜索（开关打开时服务端才挂 web_search 工具）
          messages: _reqMessages,
        }),
      });

      if (!res.ok) {
        const t = await res.text().catch(() => "");
        const errMsg = formatChatErrorBody(t);
        aiRow.bubble.textContent = `Request failed (${res.status}):\n${errMsg}`;
        aiRow.stats.textContent = "";
        // 2026-10-13 (E1c): 失效模型自愈 —— 模型不存在/不属于当前渠道时给「选择新模型」引导
        if (looksLikeInvalidModel(res.status, errMsg)) attachModelReselectButton(aiRow);
        return;
      }

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      // 4.69 fix: SSE 行缓冲 —— 网络 chunk 边界不对齐 SSE 行边界时,直接 chunk.split("\n") 会把
      // 跨 chunk 截断的 "data: {...}" 行拆成两段:前段 JSON 不完整 → catch 丢弃,后段不含 "data: " → 跳过。
      // 最终表现:长回复（尤其中文,每字 3 字节 UTF-8）随机掉字,无报错,dev 面板「入站流」完整。
      // 改法:用 sseBuf 累加所有 decode 输出,只处理碰到 \n 的完整行;不完整的尾段留在缓冲等下个 chunk。
      let sseBuf = "";
      // 4.82 fix: 回复风格在流开始前读一次 —— 旧版在每个 delta 里同步读 localStorage,一次长回复读数千次。
      // (命名为 _streamReplyStyle,避免与后面拆条处的同名 const 混淆)
      const _streamReplyStyle = localStorage.getItem("cfw_reply_style_v1") || "default";

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // 4.69 fix: flush TextDecoder 残余字节（stream:true 模式下末尾不完整 UTF-8 序列会留在 decoder 内部缓冲）
          sseBuf += decoder.decode();
          break;
        }
        sseBuf += decoder.decode(value, { stream: true });
        let _sseIdx;
        while ((_sseIdx = sseBuf.indexOf("\n")) >= 0) {
          const line = sseBuf.slice(0, _sseIdx);
          sseBuf = sseBuf.slice(_sseIdx + 1);
          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr || jsonStr === "[DONE]") continue;
          try {
            const parsed = JSON.parse(jsonStr);
            if (parsed.usage) exactUsage = parsed.usage;
            const dReason = parsed.choices?.[0]?.delta?.reasoning_content;
            if (dReason && aiRow.reasoning) {
              fullReasoning += dReason;
              if (partialStream) partialStream.fullReasoning = fullReasoning;
              // 2026-10-05 节流(与正文同款 70ms):旧版**每个 reasoning delta** 做三件重活 ——
              //   ① 把全量 fullReasoning 写进 .reasoning-text(长思考下 O(n²) 字符串写)
              //   ② getThinkDisplay() 读一次 localStorage(同步 IO)
              //   ③ isNearBottom() 读 scrollTop/scrollHeight → 强制全文档重排
              // reasoning 的 delta 比正文密得多(逐 token、无标点也可能一个 delta),开 MAX 思考
              // 时这三件事在正文出现之前就能跑几万次 —— 手机端表现为"思考一长就卡死"。
              // 现在三者一起进 70ms 窗口;显示内容不变:流末那段 _reasonArchive 会做完整渲染兜底。
              const _nowR = performance.now();
              if (_nowR - _lastThinkRenderMs >= 70) {
                _lastThinkRenderMs = _nowR;
                aiRow.reasoning.querySelector(".reasoning-text").textContent = fullReasoning;
                // 4.70 按「思考过程显示」设置:hide 则全程不显示;否则流式期间展开看推理,结束后按设置收起
                if (getThinkDisplay() === "hide") {
                  aiRow.reasoning.style.display = "none";
                } else {
                  aiRow.reasoning.style.display = "";
                  aiRow.reasoning.open = true;
                }
                if (isNearBottom()) scrollToBottom();
              }
            }
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              if (!outStartMs) outStartMs = performance.now();
              // 4.19 P0: 流式期间不折叠思考块(避免高度突降抖动);改在 stream 结束后统一折叠
              full += delta;
              if (partialStream) partialStream.full = full;
              // 4.18: 微信模式流式期间不写未处理文本到 bubble (含 [^数字]: 前缀 + || 未拆分)
              // 只显示「正在输入···」typing 动画，结束后再 strip + 拆条 + 按字数 delay 逐条 push
              // 4.18 (v8): wechat + fishbowl 共存——streaming 期间 wechat 仍显 typing,
              // 拆条改成 await delay(下面那段),让 sendOne 等所有 push 完才 resolve
              // fishbowl 接龙 await sendOne 自动等齐,不再错位且保留「几个 AI 群聊」玩法
              const _rs = _streamReplyStyle;
              if (_rs === "wechat") {
                if (!aiRow.bubble.classList.contains("wechat-typing")) {
                  aiRow.bubble.textContent = "正在输入···";
                  aiRow.bubble.classList.add("wechat-typing");
                }
              } else {
                // 4.70 性能:旧版每个 delta 都对「全量 full」重跑 strip(O(n²)),长回复卡顿主因。
                // 改为 ≤每 70ms 渲染一次(节流),流末另有完整 strip 兜底,不影响最终结果。
                const _now = performance.now();
                if (_now - _lastLiveRenderMs >= 70) {
                  _lastLiveRenderMs = _now;
                  aiRow.bubble.textContent = stripPhotoSignalLive(stripJailbreakPrefix(stripThinkBlocks(full)));
                  // 2026-10-07 (E-A): 贴底检查并入节流窗口 —— 旧版每个 delta 都读
                  // scrollHeight/scrollTop（强制布局），拖动手势期间和合成器抢主线程。
                  if (isNearBottom()) scrollToBottom();
                }
              }
            }
          } catch {}
        }
      }
      // 4.69 fix: sseBuf 末尾若有未以 \n 结尾的残行（服务端非标结尾），补处理一次
      // 2026-06-18 Bug⑦ fix: 旧版这里只取 parsed.usage,丢弃了残行里的 delta.content / delta.reasoning_content。
      // 当 worker 最后一个 data:{...正文...} 事件不带结尾 \n(落进 sseBuf 残段)时,这最后一截正文被静默丢弃 →
      // 永不进 full → 永不入 session(刷新/翻历史都找不回)。表现:回复尾部几句话随机丢失,越长越容易触发,与回复风格无关。
      // 修法:残行与内层循环一样累加 content / reasoning_content,后续清洗管线 + session.push 会一并处理。
      if (sseBuf.trim()) {
        const line = sseBuf.trim();
        if (line.startsWith("data: ")) {
          const jsonStr = line.slice(6).trim();
          if (jsonStr && jsonStr !== "[DONE]") {
            try {
              const parsed = JSON.parse(jsonStr);
              if (parsed.usage) exactUsage = parsed.usage;
              const dReason = parsed.choices?.[0]?.delta?.reasoning_content;
              if (dReason) {
                fullReasoning += dReason;
                if (partialStream) partialStream.fullReasoning = fullReasoning;
              }
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                full += delta;
                if (partialStream) partialStream.full = full;
              }
            } catch {}
          }
        }
      }
    } catch (e) {
      if (e.name === "AbortError") {
        // 中断（停止按钮 / 重试 / 删除 / 刷新 触发）—— 只在本代才释放全局状态、负责入 session
        if (myGen === sendGen) {
          // 若 partialStream 仍存在（停止按钮），把已收到部分作为完整 AI 回复入 session
          // 重试/删除传了 discardPartial=true，partialStream 已被清空，跳过
          if (partialStream && partialStream.full) {
            const m = { role: "assistant", content: partialStream.full };
            if (partialStream.fullReasoning) m.reasoning_content = partialStream.fullReasoning;
            if (partialStream.speakerName) {
              m.speakerId = partialStream.speakerId;
              m.speakerName = partialStream.speakerName;
              m.speakerIcon = partialStream.speakerIcon;
            }
            m._meta = _replyMeta; // 2026-10-05: 中断兜底也留来源标注
            session.push(scopeTag(m));
            try { aiRow.rowEl.dataset.sidx = String(session.length - 1); } catch (_sx) {} // 2026-10-08
            persistSessionIfEnabled();
          }
          isSending = false;
          sendBtn.disabled = false;
          if (currentController === controller) currentController = null;
          partialStream = null;
        }
        setStreamingUI(aiRow.rowEl, false);
        return;
      }
      if (myGen === sendGen) {
        // 4.69 fix: wechat 模式网络错误时移除 typing 动画 class，否则报错气泡继续播放 typing CSS 动画
        aiRow.bubble.classList.remove("wechat-typing");
        aiRow.bubble.textContent = `网络错误: ${e.message}`;
      }
    } finally {
      if (myGen === sendGen) {
        isSending = false;
        sendBtn.disabled = false;
        if (currentController === controller) currentController = null;
      }
      setStreamingUI(aiRow.rowEl, false);
    }

    // 新一轮 send 已起，旧闭包不允许再写 session / UI，避免被截断后的鬼消息回填
    if (myGen !== sendGen) return;
    partialStream = null;

    outEndMs = performance.now();

    // 4.70 思考归档:不再「删掉」内联思考,而是把 <think> 块 + [^420]/[^69] 哨兵区间「捕获」进折叠块,
    // 与原生 reasoning_content 合并展示,按「思考过程显示」设置 show/collapse/hide。
    // 正文(body)只保留真正可见内容;即便切割误判,正文也能在思考块里展开找回(fail-open)。
    let _reasonArchive = "";
    {
      const _inlineThink = extractThinkText(full);
      const _split = splitJailbreakPrefix(stripThinkBlocks(full));
      _reasonArchive = buildReasoningArchive(fullReasoning, _inlineThink, _split.thinking);
      if (aiRow.reasoning) {
        const _rt = aiRow.reasoning.querySelector(".reasoning-text");
        if (_reasonArchive) _rt.textContent = _reasonArchive;
        applyThinkDisplay(aiRow.reasoning);
      }
      // 4.74 fix: 无条件重渲气泡 —— 流式期间 70ms 节流会漏渲最后一截 chunk
      // (已进 full/session,气泡却停在上一次节流渲染)。旧版仅 _split.body !== full 才重渲,
      // 默认模式下表现为"实时聊天最后几句被截掉,刷新看历史却完整"。
      full = _split.body;
      aiRow.bubble.innerHTML = renderMarkdownSafe(full);
    }

    // 解析隐藏好感度标签 [好感±N] 并从正文剥离（仅当卡启用好感度时才更新数值）
    if (ch && ch.parseAffectionTag) {
      const tagRes = ch.parseAffectionTag(full);
      if (tagRes.delta && affection !== null) {
        try { await ch.adjustActiveAffection(tagRes.delta); } catch {}
      }
      if (tagRes.stripped !== full) {
        full = tagRes.stripped;
        aiRow.bubble.innerHTML = renderMarkdownSafe(full);
      }
    }

    // 2026-10-06 氛围音标签:[[amb:轨道|音量]] / [[mus:…]] / [[voice:…]] / [[amb:off]] ——
    // 执行(window.__ambient.tag)并从正文剥离,标签不进气泡也不进 session 正文
    {
      const _ambClean = applyAmbientTags(full);
      if (_ambClean !== full) { full = _ambClean; aiRow.bubble.innerHTML = renderMarkdownSafe(full); }
    }

    // 2026-05-29 微信发图:抠出 [[发图:场景]] 信号,从正文剥离(触发延后到入 session 后)
    let _photoSig = null;
    let _photoKind = null; // 4.72 修:透传 extractSignal 解析出的 kind(自拍/场景),不再让 handleSignal 用关键词重新猜(直白描述会被误判成场景→丢基准图)
    if (window.__chatImageText && window.__chatImageText.extractSignal) {
      try {
        const _r = window.__chatImageText.extractSignal(full);
        if (_r && _r.scene != null) {
          _photoSig = _r.scene;
          _photoKind = _r.kind || null;
          if (_r.clean !== full) { full = _r.clean; aiRow.bubble.innerHTML = renderMarkdownSafe(full); }
        }
      } catch (e) {}
    }

    // 2026-05-30 / 4.25: 鱼缸接龙/讨论 —— 剥离 AI 误带的发言人名签 + [next:X]/[end] 标签
    // 名签泄漏会让「冷(女)】」串进气泡;标签泄漏会让 [next:高冷] 显示出来。
    // 保留含标签的原文 _replyForEngine 返回给 fishbowl-engine 解析接力/结束。
    let _replyForEngine = full;
    // 4.43: 接龙/讨论(引擎驱动) + 多人编排群聊(本文件 runAutoRelay 驱动) 都要剥离名签 + [next:X]/[end] 标签,
    // 避免标签泄漏进气泡/历史;_replyForEngine 保留原文(含标签)给接力解析。
    const _isAutoFishbowl = opts0.fishbowlMode && opts0.fishbowlMode !== "orchestrate";
    if (_isAutoFishbowl || isGroupChatActive()) {
      const _lbl = stripSceneSpeakerLabel(full);
      if (_lbl !== full) full = _lbl;
      const _noTags = full.replace(/\[next[:：][^\]\n]*\]/gi, "").replace(/\[end\]/gi, "").replace(/\[召唤[:：][^\]\n]*\]/g, "").trim();
      if (_noTags !== full) full = _noTags;
      if (full !== _replyForEngine) aiRow.bubble.innerHTML = renderMarkdownSafe(full);
    }

    // 4.59 残括号清扫(所有模式通用):清掉模型写崩的 [] / 落单 ] / [好感] 等残体,再入 session/拆条,保证气泡与历史都干净
    {
      const _swept = stripResidualMarkup(full);
      if (_swept !== full) { full = _swept; aiRow.bubble.innerHTML = renderMarkdownSafe(full); }
    }

    // 2026-05-29 / 4.18: 微信风格拆气泡
    // session 里还是存完整拼接串(含 ||),避免下轮 turn 模型看不到连发样式上下文
    // 4.18 (v8): 拆条从 setTimeout 改成 await delay——sendOne 等所有 push 完才 resolve
    // 4.65: 群聊也显示全部 || 拆条,取消 4.18 (v9) 的「前 2 条」上限——第 3 条起被吞让用户以为"消息被切掉"
    const _replyStyle = localStorage.getItem("cfw_reply_style_v1") || "default";
    if (_replyStyle === "wechat") {
      aiRow.bubble.classList.remove("wechat-typing");
      // 4.47: 微信模式剥离行为/动作描写,只保留聊天文字(session 也存剥离版,避免下轮模型又学着写动作)
      const _noAct = stripWechatActions(full);
      if (_noAct && _noAct !== full) { full = _noAct; aiRow.bubble.innerHTML = renderMarkdownSafe(full); }
      // 4.25 (⑨): 模型没拆 || 却吐了长段 → 客户端兜底按句切分,保证不"跳长篇"(session 仍存原文 full)
      let _wechatText = full;
      if (!_wechatText.includes("||")) {
        const _auto = autoSplitWechat(_wechatText);
        if (_auto) _wechatText = _auto;
      }
      if (_wechatText.includes("||")) {
        const _parts = _wechatText.split("||").map(s => s.trim()).filter(Boolean);
        if (_parts.length > 1) {
          // _inFishbowl: fishbowl 模式下 tail 拆条用更长延迟(4.65 起不再截断条数)
          const _inFishbowl = !!opts0.fishbowlMode && opts0.fishbowlMode !== "orchestrate";
          // 4.65: 群聊也显示全部 || 拆条(取消旧「前 2 条」上限)——第 3 条起被吞让用户以为"消息被切掉"
          const _visibleParts = _parts;
          // 第一条立刻显示
          aiRow.bubble.innerHTML = renderMarkdownSafe(_visibleParts[0]);
          if (isNearBottom()) scrollToBottom();
          // 后续条按「上一条字数 * 80ms」延迟逐条 push,fishbowl 模式最少 800ms 给对面 AI 喘息空间
          // tail 用 _tailGen 判断中断,不用 myGen —— stop/重试/删除会动 _tailGen,
          // 若用 sendGen,下个 sendOne 立刻 ++ 会让 tail 一醒就退,2/3 段永不显示
          const _myTailGen = _tailGen;
          const _pushTail = async () => {
            for (let i = 1; i < _visibleParts.length; i++) {
              const _minDelay = _inFishbowl ? 800 : 300;
              const _delay = Math.max(_minDelay, _visibleParts[i - 1].length * (_inFishbowl ? 80 : 60));
              await new Promise(r => setTimeout(r, _delay));
              // 中途被中断(abortCurrent / 鱼缸 stop / 重试 / 删除) → tail 退出
              if (_myTailGen !== _tailGen) return;
              const _piece = _visibleParts[i];
              const _side = opts0.side || null;
              const _r = makeRow("assistant", { side: _side });
              _r.bubble.innerHTML = renderMarkdownSafe(_piece);
              _r.stats.textContent = "";
              if (window.__character && window.__character.decorateAiRow) {
                // 4.19 P1 fix: tail piece 复用主 row 的 characterCard,保持所有拆条都是同一个角色
                window.__character.decorateAiRow(_r.rowEl, characterCard);
              }
              setStreamingUI(_r.rowEl, false);
              if (isNearBottom()) scrollToBottom();
            }
          };
          // 4.20 P0: 回退 fire-and-forget tail —— 用户反馈 AB 拆条交错视觉乱 (2026-05-29 17:03 截图)
          // 原 4.19 P0.5 (1284 第 4 edit) 让 wechat+fishbowl 时 A 早 yield → B 抢屏 → 完全失去群聊接龙节奏
          // 现在改回无条件 await:wechat+fishbowl 时也是 A 把所有 || 段说完才 resolve sendOne,fishbowl 再推到 B
          // _tailGen 模块级 token 保留 (stop/重试/删除/abort 仍需中断 tail,不能用 sendGen 否则下个 sendOne 立刻 ++ 让 tail 一醒就退)
          await _pushTail();
        } else {
          aiRow.bubble.innerHTML = renderMarkdownSafe(full);
        }
      } else {
        // wechat 模式但模型没输 || → 直接显示 full (避免一直卸在 typing 动画)
        aiRow.bubble.innerHTML = renderMarkdownSafe(full);
      }
    } else {
      // 2026-06-08 默认/详细模式残留 || 根治:微信模式拆条后 session 里存的是含 || 的完整串,
      // 切回默认/详细模式后模型会模仿历史里的 || 样本继续吐分隔符(few-shot 污染),而默认分支从不处理 || → 气泡和历史都残留 ||,且越滚越多(雪球)。
      // 兜底:非微信模式把 || 合并成换行,清干净可见气泡 + 入 session 的 full,断掉雪球。
      if (full.includes("||")) {
        const _merged = full.split("||").map(s => s.trim()).filter(Boolean).join("\n");
        if (_merged !== full) { full = _merged; aiRow.bubble.innerHTML = renderMarkdownSafe(full); }
      }
    }

    const asMsg = { role: "assistant", content: full };
    // 4.71 持久化:写入按来源去重分段的思考归档(与折叠块同一份),刷新后仍可展开
    {
      if (_reasonArchive) asMsg.reasoning_content = _reasonArchive;
    }
    if (characterCard) {
      asMsg.speakerId = characterCard.id;
      asMsg.speakerName = characterCard.name;
      asMsg.speakerIcon = characterCard.icon || "🙂";
    }
    asMsg._meta = _replyMeta; // 2026-10-05: 本轮模型 + 底座来源标注(随会话持久化)
    session.push(scopeTag(asMsg));
    try { aiRow.rowEl.dataset.sidx = String(session.length - 1); } catch (_sx) {} // 2026-10-08: 删除本行时按真实下标算
    persistSessionIfEnabled();
    // 2026-05-29 微信发图:正文入 session 后触发出图(图片气泡插在本条 AI 之后)
    if (_photoSig != null && window.__chatImageText && window.__chatImageText.handleSignal) {
      try { window.__chatImageText.handleSignal({ scene: _photoSig, kind: _photoKind, card: characterCard, afterRow: aiRow.rowEl }); } catch (e) {}
    }
    // 阶段 4-②：本轮成功发送后清空已注入的一次性阈值事件
    if (thresholdEvents && thresholdEvents.length && ch && ch.clearPendingThresholdEvents) {
      try { ch.clearPendingThresholdEvents(); } catch {}
    }

    const seconds = Math.max(0.001, (outEndMs - (outStartMs || outEndMs)) / 1000);

    if (exactUsage && typeof exactUsage.completion_tokens === "number") {
      const p = exactUsage.prompt_tokens        || 0;
      const c = exactUsage.completion_tokens    || 0;
      const t = exactUsage.total_tokens         || (p + c);
      const cached = exactUsage.prompt_cache_hit_tokens || 0;
      totalPromptTokens     += p;
      totalCompletionTokens += c;
      const tps = c / seconds;

      let statsText = `Prompt: ${p} | Completion: ${c} | Total: ${t} | Speed: ${tps.toFixed(2)} tok/s`
        + ` | CumPrompt: ${totalPromptTokens} | CumCompletion: ${totalCompletionTokens}`;

      // 快速模式才计费
      // 修订：单条 token 太少时 ¥0.00005 会被 toFixed 截成 ¥0.00000 难看。
      // 改为“累计 token / 累计¥”呈现：累计金额足够大，浮点稳定且直观反映总额。
      if (snapshotMode === "fast") {
        const priceCtx = pricingContext(snapshotMode, snapshotModel, customProviderSnapshot);
        const cost = calcCost(priceCtx, p, c, cached);
        totalCostCNY += cost;
        addCostToToday(cost, p, c);  // Phase 4 阶段 7：同步追加到日志（独立于历史）
        const cumTok = totalPromptTokens + totalCompletionTokens;
        statsText += ` | 累计 ${cumTok} tok / ¥${totalCostCNY.toFixed(4)}`;
        updateCostDisplay();
      }

      aiRow.stats.textContent = statsText;
      // 2026-09-14 UI第二轮:状态面板数据源 —— 真实 usage 优先
      lastReqStats = { at: Date.now(), model: snapshotModel, mode: snapshotMode, prompt: p, completion: c, total: t, cacheHit: cached, ms: Math.round(outEndMs - (outStartMs || outEndMs)), est: false };
    } else {
      const outEst = estimateTokens(full);
      totalOutEstimate += outEst;
      const tps = outEst / seconds;
      aiRow.stats.textContent =
        `Output(估算): ≈${outEst} | Total Out(估算): ≈${totalOutEstimate}`
        + ` | Speed(估算): ${tps.toFixed(2)} tok/s | (usage未返回)`;
      // 2026-09-14 UI第二轮:免费模式上游常不回 usage,如实标记 est:true(面板显示"输出为估算")
      lastReqStats = { at: Date.now(), model: snapshotModel, mode: snapshotMode, prompt: null, completion: null, total: null, cacheHit: null, ms: Math.round(outEndMs - (outStartMs || outEndMs)), est: true, outEstimate: outEst };
    }

    updateSpacer();
    scrollToBottom();

    // 4.25: 返回含 [next:X]/[end] 的原文给鱼缸引擎解析(气泡/session 已是剥离版)
    return _replyForEngine;
  }

  // ─── 4.43 多人群聊:@召唤 + AI 交棒/随机插嘴 自发接力(仅多人模式下的「编排」自由群聊;接龙/讨论由鱼缸引擎驱动)───
  const LS_AUTO_RELAY   = "cfw_group_auto_relay_v1";
  const LS_RANDOM_BARGE = "cfw_group_random_barge_v1";
  const MAX_AUTO_STREAK = 5;
  let _autoBusy = false;

  function autoRelayEnabled() { return (localStorage.getItem(LS_AUTO_RELAY) ?? "1") === "1"; }
  function randomBargeChance() { const n = parseInt(localStorage.getItem(LS_RANDOM_BARGE) ?? "35", 10); return isNaN(n) ? 35 : Math.max(0, Math.min(100, n)); }

  function isGroupChatActive() {
    // 2026-10-08（分层按钮）：Agent 模式与多智能体不再互斥 —— 同开时多智能体是"给 agent 开的能力
    // 闸门"（私下小会 / 派子 agent），时间线仍只有主 agent 一个声音，接力/编排不自动跑，角色只在
    // "小会 / 上台"里出现。所以这里在 agent 模式下恒 false。
    if (isAgentModeOn()) return false;
    const M = window.__multi;
    if (!(M && M.isMulti && M.isMulti())) return false;
    let n = 0; try { n = ((M.getSceneCards && M.getSceneCards()) || []).length; } catch (e) {}
    if (n < 2) return false;
    const fb = window.__fishbowl;
    const mode = fb && fb.getMode ? fb.getMode() : "orchestrate";
    return mode === "orchestrate";
  }

  function _normNameForMatch(s) { return String(s == null ? "" : s).replace(/[\s【】\[\]()（）「」·,，.。!！?？~]/g, "").toLowerCase(); }
  function matchSceneCardByName(hint) {
    if (!hint) return null;
    let cards = []; try { cards = (window.__multi && window.__multi.getSceneCards && window.__multi.getSceneCards()) || []; } catch (e) { return null; }
    if (!cards.length) return null;
    const raw = String(hint).trim();
    let hit = cards.find(c => c && c.name === raw); if (hit) return hit;
    const nh = _normNameForMatch(raw); if (!nh) return null;
    hit = cards.find(c => c && _normNameForMatch(c.name) === nh); if (hit) return hit;
    hit = cards.find(c => { const cn = _normNameForMatch(c && c.name); return cn && cn.length >= 2 && nh.length >= 2 && (cn.includes(nh) || nh.includes(cn)); });
    return hit || null;
  }

  function parseAtMentions(text) {
    if (!text || !isGroupChatActive()) return [];
    const found = []; const re = /@([^\s@,，。!！?？:：、]+)/g; let m;
    while ((m = re.exec(text)) !== null) {
      const hit = matchSceneCardByName(m[1]);
      if (hit && !found.some(c => c.id === hit.id)) found.push(hit);
    }
    return found;
  }

  function groupChatInjection(speakerCard) {
    if (!isGroupChatActive()) return "";
    let names = []; try { names = (((window.__multi.getSceneCards && window.__multi.getSceneCards()) || []).map(c => c && c.name)).filter(Boolean); } catch (e) {}
    if (names.length < 2) return "";
    const self = speakerCard ? speakerCard.name : "当前角色";
    return "\n\n【群聊接力】当前是多人群聊,在场角色:" + names.join("、") + "。你只能以「" + self + "」的身份说话,绝不替别人代言。用户消息里若出现 @某人,主要是在对那个人说话。当你这句话明显在喊某个在场的人、或话题更适合交给在场的另一个人接时,就在整条回复的最末尾追加一个交棒标记 [next:对方名字](只能点在场的人,不能点自己);不需要交棒时就完全不要输出这个标记。该标记只放在最后,用方括号包裹。";
  }

  async function runAutoRelay(seedReply, seedSpeaker) {
    if (_autoBusy) return;
    if (!isGroupChatActive() || !autoRelayEnabled()) return;
    _autoBusy = true;
    const subset = groupOnlineMode() === "subset";
    try {
      let reply = seedReply, lastCard = seedSpeaker, streak = 0;
      while (streak < MAX_AUTO_STREAK) {
        if (!isGroupChatActive()) break;
        let nextCard = null;
        // 4.52 在场感 part2:AI 在编排群聊里 [召唤:X] 把场景外角色叫进来,优先级高于 [next:X]/随机插嘴
        try {
          const _sm = reply ? reply.match(/\[召唤[:：]\s*([^\]\n]+?)\s*\]/) : null;
          if (_sm && window.__multi && window.__multi.summonByName) {
            const _sc = window.__multi.summonByName(_sm[1].trim());
            if (_sc && (!lastCard || _sc.id !== lastCard.id)) nextCard = _sc;
          }
        } catch (e) {}
        try {
          const fb = window.__fishbowl;
          const tags = (!nextCard && fb && fb.parseTags) ? fb.parseTags(reply || "") : null;
          if (tags && tags.next) {
            const hit = matchSceneCardByName(tags.next);
            if (hit && (!lastCard || hit.id !== lastCard.id)) nextCard = hit;
          }
        } catch (e) {}
        if (!nextCard && Math.random() * 100 < randomBargeChance()) {
          let cards = []; try { cards = (window.__multi.getSceneCards && window.__multi.getSceneCards()) || []; } catch (e) {}
          const others = cards.filter(c => c && (!lastCard || c.id !== lastCard.id));
          if (others.length) nextCard = others[Math.floor(Math.random() * others.length)];
        }
        if (!nextCard) break;
        streak++;
        // 4.53 真实在线感:subset 随机更长延迟 + typing,且第 2 棒后有概率"没人接"提前散场
        if (subset) {
          if (streak >= 2 && Math.random() < 0.25) break;
          if (pacingEnabled()) showTyping(nextCard.name);
          await new Promise(r => setTimeout(r, 700 + Math.floor(Math.random() * 1900)));
          hideTyping();
        } else {
          // 4.58 拟人节奏:all 模式也别 600ms 机关枪秒接,按 pacing 设置加“正在输入”+ 拖动延迟
          if (pacingEnabled()) {
            showTyping(nextCard.name);
            await new Promise(r => setTimeout(r, Math.max(700, Math.round(pacingBaseDelay() * (0.6 + Math.random() * 0.7)))));
            hideTyping();
          } else {
            await new Promise(r => setTimeout(r, 600));
          }
        }
        if (!isGroupChatActive()) break;
        reply = await sendOne({ allowEmptyText: true, asCard: nextCard });
        if (reply == null) break;
        lastCard = nextCard;
      }
    } finally { _autoBusy = false; hideTyping(); }
  }
  function continueGroupChat(reply, card) { return runAutoRelay(reply, card); }

  // ─── 2026-10-08 Agent 的多智能体能力（多智能体模式 + Agent 模式同开时可用）───────────────
  // 术语（用户口径）：**平级 agent = 你单独配置好的角色卡**（各有独立上下文，能互发消息）；
  // **子 agent = 主 agent 现造的临时工**（tools.js 的「最小权限」档，任务级、用完即弃）。
  // 这里实现"平级"的两个动作（tools.js 只声明 schema，重活在这边——状态都在本文件）：
  //   runPeerMeeting            私开小会：多位角色并行独立作答（rounds=2 可互评），结论回主 agent、不进时间线
  //   inviteCharacterToTimeline 叫上台：角色按自己的档案与上下文，直接在时间线里回答
  function _maCardByName(name) {
    const raw = String(name == null ? "" : name).trim();
    if (!raw) return null;
    const norm = (s) => String(s == null ? "" : s).replace(/[\s【】\[\]()（）「」·,，.。!！?？~]/g, "").toLowerCase();
    const hit = (arr) => {
      let h = arr.find((c) => c && c.name === raw);
      if (h) return h;
      const n = norm(raw);
      if (!n) return null;
      h = arr.find((c) => c && norm(c.name) === n);
      if (h) return h;
      return arr.find((c) => { const cn = norm(c && c.name); return cn && cn.length >= 2 && n.length >= 2 && (cn.includes(n) || n.includes(cn)); }) || null;
    };
    let scene = [];
    try { scene = (window.__multi && window.__multi.getSceneCards && window.__multi.getSceneCards()) || []; } catch (e) {}
    const s1 = hit(scene); // 在场角色优先
    if (s1) return s1;
    try { return hit((window.__character && window.__character.listAllCards && window.__character.listAllCards()) || []); } catch (e) { return null; }
  }
  function _maCfg() {
    const num = (k, def, lo, hi) => { const n = parseInt(localStorage.getItem(k), 10); return isNaN(n) ? def : Math.max(lo, Math.min(hi, n)); };
    return {
      meetingMax: num("cfw_ma_meeting_max_v1", 6, 1, 6),   // 2026-11-09：默认 3 → 6。四方推演时第四个被静默丢掉，没人发现。
      meetingRounds: num("cfw_ma_meeting_rounds_v1", 1, 1, 2),
      ctxMsgs: num("cfw_ma_ctx_msgs_v1", 60, 0, 400),
    };
  }
  // 给"平级角色"的一次独立模型调用：它自己的角色卡（rp 档案）+ 它自己的上下文视图 + 一段简报。
  // signal 链宿主 currentController（停止按钮能一起掐掉）+ 60 秒硬超时；非流式（小会只要结论，省钱）。
  // 2026-11-09：一次中性的模型调用（记忆抽取 / 巩固用）。
  // 不带人设、不带聊天记录、不要思考链 —— 只要它把「给定文本」按指令转成结构化结果。
  // 记忆是增益件：这里失败一律返回空串，绝不影响对话主流程。
  // 2026-11-09：**给角色装上手**。
  // 群聊里的角色原来只有嘴（callPeerModel 一次调用，不带 tools）——它说的全来自上下文，
  // 一旦上下文里没有就开始编。这里让它跑一次真正的 agent 循环：带自己的角色卡、自己的工具集，
  // 能调工具、看结果、再想。这是"开了 Agent 模式 = 角色变成 agent"的那一层。
  async function callWithTools(card, messages, schemas) {
    let sig;
    try {
      if (currentController && typeof AbortSignal !== "undefined" && AbortSignal.any) sig = AbortSignal.any([currentController.signal, AbortSignal.timeout(90000)]);
      else if (currentController) sig = currentController.signal;
    } catch (e) {}
    const _byo = (window.__byoProvider && window.__byoProvider.get && window.__byoProvider.get()) || undefined;
    const body = {
      stream: false,
      mode: currentMode,
      model: _byo ? _byo.model : (modelSel ? modelSel.value : undefined),
      promptProfile: "rp",
      use_builtin_persona: useBuiltin,
      custom_system_prompt: (!useBuiltin && promptEnabled) ? (localStorage.getItem(LS_CUSTOM_PROMPT) || "") : "",
      characterCard: card || null,
      relation: "default", emotion: "neutral", affection: null, priorSummary: "",
      extraSystemPrompts: getExtraSystemPrompts(currentMode, card),
      thinking: "disabled",
      replyStyle: localStorage.getItem("cfw_reply_style_v1") || "default",
      customProvider: _byo,
      messages: messages,
    };
    if (schemas && schemas.length) { body.tools = schemas; body.tool_choice = "auto"; }
    const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, signal: sig, body: JSON.stringify(body) });
    if (!res.ok) { const t = await res.text().catch(() => ""); throw new Error("Request failed (" + res.status + "): " + formatChatErrorBody(String(t).slice(0, 200))); }
    const j = await res.json().catch(() => null);
    const m = j && j.choices && j.choices[0] && j.choices[0].message;
    const out = { content: String((m && m.content) || "") };
    if (m && Array.isArray(m.tool_calls) && m.tool_calls.length) out.tool_calls = m.tool_calls;
    if (m && m.reasoning_content) out.reasoning_content = m.reasoning_content;
    return out;
  }

  // 让某个角色以 agent 形态干一件事（最多 maxIterations 轮工具）
  async function runCharacterAgent(card, brief, opts) {
    const o = opts || {};
    if (!card) return { ok: false, error: "缺少角色" };
    const kernel = window.AgentKernel;
    if (!kernel || typeof kernel.runAgentLoop !== "function") return { ok: false, error: "内核未就绪" };
    let registry;
    try {
      if (window.OwnChatTools && window.OwnChatTools.buildRegistry) {
        registry = window.OwnChatTools.buildRegistry({ profile: "char" });
        // 角色 agent 的"手"来自这些工具组（read_file / search_file / local_read_file / 画布…）。
        // 它们不归 tools.js 的分档管，所以要显式挂上来；写类工具靠下面的 ensurePermission 一律拒绝。
        ["__agentWorkspace", "__sourceTools", "__localExecTools", "__stageTools"].forEach(function (k) {
          try { if (window[k] && typeof window[k].defineTools === "function") window[k].defineTools(registry); } catch (e) {}
        });
      } else { registry = null; }
    } catch (e) { registry = null; }
    if (!registry) return { ok: false, error: "工具表构建失败" };
    const onEvent = typeof o.onEvent === "function" ? o.onEvent : function () {};
    let memInj = "";
    try { if (window.__memCore) memInj = await window.__memCore.buildInjection(card.id || card.name, brief || ""); } catch (e) {}
    try {
      const res = await kernel.runAgentLoop({
        messages: [{ role: "user", content: String(brief || "") + memInj }],
        registry: registry,
        callModel: function (msgs, schemas) { return callWithTools(card, msgs, schemas); },
        maxIterations: Math.max(1, Math.min(6, parseInt(o.maxIterations, 10) || 3)),
        context: { characterCard: card, depth: (o.depth || 0) + 1, onEvent: onEvent },
        // 角色 agent 一律拒绝破坏性工具（防它改用户数据）；只读工具不走闸门。
        ensurePermission: o.ensurePermission || function () { return Promise.resolve(false); },
        onEvent: onEvent,
      });
      const text = String((res && res.finalText) || "").trim();
      if (!text) return { ok: false, error: card.name + " 没有产出内容" };
      try {
        if (window.__memCore && window.__memCore.enabled()) {
          window.__memCore.remember("【" + card.name + "】" + text, { speakerCid: card.id });
        }
      } catch (e) {}
      return { ok: true, said: text, iterations: res && res.iterations, stopReason: res && res.stopReason };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }
  async function oneShot(opts) {
    const o = opts || {};
    const sys = String(o.system || "");
    const user = String(o.user || "");
    if (!user) return "";
    let sig;
    try {
      if (currentController && typeof AbortSignal !== "undefined" && AbortSignal.any) sig = AbortSignal.any([currentController.signal, AbortSignal.timeout(o.timeoutMs || 60000)]);
      else if (currentController) sig = currentController.signal;
    } catch (e) {}
    const _byo = (window.__byoProvider && window.__byoProvider.get && window.__byoProvider.get()) || undefined;
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: sig,
      body: JSON.stringify({
        stream: false,
        mode: currentMode,
        model: _byo ? _byo.model : (modelSel ? modelSel.value : undefined),
        promptProfile: "assist",
        use_builtin_persona: false,
        custom_system_prompt: sys,
        characterCard: null,
        relation: "default", emotion: "neutral", affection: null, priorSummary: "",
        extraSystemPrompts: "",
        thinking: "disabled",
        replyStyle: localStorage.getItem("cfw_reply_style_v1") || "default",
        customProvider: _byo,
        ...activeProviderIdPayload(),
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) { const t = await res.text().catch(() => ""); throw new Error("oneShot " + res.status + " " + String(t).slice(0, 200)); }
    const j = await res.json().catch(() => null);
    const m = j && j.choices && j.choices[0] && j.choices[0].message;
    return String((m && m.content) || "");
  }

  async function callPeerModel(card, view, brief) {
    let sig;
    try {
      if (currentController && typeof AbortSignal !== "undefined" && AbortSignal.any) sig = AbortSignal.any([currentController.signal, AbortSignal.timeout(60000)]);
      else if (currentController) sig = currentController.signal;
    } catch (e) {}
    const msgs = (view || []).concat(brief ? [{ role: "user", content: String(brief) }] : []);
    const _byo = (window.__byoProvider && window.__byoProvider.get && window.__byoProvider.get()) || undefined;
    // 2026-10-08 知识库命中注入（同 RP/agent 路径）：这一位平级角色的库里，与本轮话题最相关的段落
    let _kbInj = "";
    try {
      if (window.__charMemory && typeof window.__charMemory.buildInjection === "function") {
        _kbInj = await window.__charMemory.buildInjection(card, String(brief || "").slice(0, 600));
      }
    } catch (e) {}
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: sig,
      body: JSON.stringify({
        stream: false,
        mode: currentMode,
        model: _byo ? _byo.model : (modelSel ? modelSel.value : undefined),
        promptProfile: "rp",
        use_builtin_persona: useBuiltin,
        custom_system_prompt: (!useBuiltin && promptEnabled) ? (localStorage.getItem(LS_CUSTOM_PROMPT) || "") : "",
        characterCard: card || null,
        relation: "default",
        emotion: "neutral",
        affection: null,
        priorSummary: "",
        extraSystemPrompts: getExtraSystemPrompts(currentMode, card) + (_kbInj ? "\n\n" + _kbInj : ""),
        thinking: "disabled", // 小会要结论不要思考链（省钱、更快）
        replyStyle: localStorage.getItem("cfw_reply_style_v1") || "default",
        customProvider: _byo,
        ...activeProviderIdPayload(), // 2026-10-13 (E1c): 预设渠道显式选择（自定义活跃时不发）
        ...baseIdPayload(card),
        ...stateLayerPayload(),
        messages: msgs,
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error("Request failed (" + res.status + "): " + formatChatErrorBody(String(t).slice(0, 200)));
    }
    const j = await res.json().catch(() => null);
    // 记账：与 sendOne/callModel 同口径（快速档有 usage 才记）
    try {
      if (currentMode === "fast" && j && j.usage) {
        const _p = j.usage.prompt_tokens || 0, _c = j.usage.completion_tokens || 0, _ca = j.usage.prompt_cache_hit_tokens || 0;
        const cost = calcCost(pricingContext(currentMode, _byo ? _byo.model : (modelSel ? modelSel.value : undefined), _byo), _p, _c, _ca);
        if (cost > 0) { totalCostCNY += cost; totalPromptTokens += _p; totalCompletionTokens += _c; addCostToToday(cost, _p, _c); updateCostDisplay(); }
      }
    } catch (e) {}
    const m = j && j.choices && j.choices[0] && j.choices[0].message;
    return (m && typeof m.content === "string") ? m.content : "";
  }
  // 2026-11-09：把每次召集实时推进右栏「多智能体讨论区」。
  // 为什么需要：convene_meeting 的结果原来只回给主 agent，界面上什么都看不见，
  // agent 于是以为"平台没有讨论区"，自己写一页 HTML、在一个上下文里把多个角色演掉。
  // 画布不是讨论区时（例如正开着沙盘）这些调用会被对方以"没有这个函数"拒掉，静默跳过即可。
  async function _councilPush(fn, args) {
    try {
      const P = window.__panel;
      if (!P || typeof P.call !== "function") return;
      const st = (typeof P.state === "function") ? P.state() : null;
      if (!st || !st.hasContent) return;
      await P.call(fn, args || [], 5000);
    } catch (e) { /* 当前画布不是讨论区 —— 正常跳过 */ }
  }

  async function runPeerMeeting(opts) {
    const o = opts || {};
    const topic = String(o.topic || "").trim();
    if (!topic) return { ok: false, error: "缺少议题（topic）" };
    const cfg = _maCfg();
    const onEvent = typeof o.onEvent === "function" ? o.onEvent : function () {};
    const rounds = Math.max(1, Math.min(2, parseInt(o.rounds, 10) || cfg.meetingRounds));
    // 参与者的上下文取"群聊视角"：小会是场景层面的事，在场角色互相可见（各自仍是独立上下文/独立调用）
    const scope = "group";
    let names = Array.isArray(o.participants) ? o.participants.map((x) => String(x || "").trim()).filter(Boolean) : [];
    if (!names.length) {
      try { names = ((window.__multi && window.__multi.getSceneCards && window.__multi.getSceneCards()) || []).map((c) => c.name).filter(Boolean); } catch (e) {}
    }
    let entries = names.slice(0, cfg.meetingMax).map((n) => ({ name: n, card: _maCardByName(n), aspect: "" }));
    // agenda：多方多主题（给参与者指定负责的方面）
    const agenda = Array.isArray(o.agenda) ? o.agenda : [];
    agenda.slice(0, cfg.meetingMax).forEach((a, i) => {
      if (!a) return;
      const who = a.who ? _maCardByName(a.who) : null;
      if (who) {
        const exist = entries.find((e) => e.card && e.card.id === who.id);
        if (exist) { exist.aspect = String(a.aspect || ""); return; }
        entries.push({ name: who.name, card: who, aspect: String(a.aspect || "") });
      } else if (entries[i]) entries[i].aspect = String(a.aspect || "");
    });
    // 2026-11-09：**不再静默截断** —— 超限的名字要回给调用方，否则"少了一个人"永远查不出来。
    const _dropped = names.slice(cfg.meetingMax);
    entries = entries.filter((e) => e.card).slice(0, cfg.meetingMax);
    if (!entries.length) {
      // 一张角色卡都不可用 → 通用视角（仍是各自独立的调用与上下文，只是人设换成"专家视角"）
      const aspects = (agenda.length ? agenda.map((a) => String((a && a.aspect) || "")) : ["总体评估", "风险与代价", "替代方案"]).filter(Boolean).slice(0, cfg.meetingMax);
      entries = aspects.map((a, i) => ({ name: "视角" + (i + 1) + "：" + a, card: null, aspect: a }));
    }
    // 2026-11-09：默认**隔离上下文**。
    // 旧实现给每位参与者的是 selectSpeakerView(session, {card}) —— 它遍历的是同一个 session，
    // 只把别人的话降级成「【名字】…」的 user 行。于是四个人读的是同一段聊天记录，
    // 那不是独立 agent，是一个模型换着人设说话（连"开会"都算不上）。
    // 现在默认只给：自己的角色卡 + 议题简报（+ 它自己知识库里与本议题相关的段落，在 callPeerModel 里注入）。
    // 需要他们接着群聊说话时传 context:"chat"。
    const isolated = String(o.context || "isolated") !== "chat";
    const capView = (card) => {
      if (isolated) return [];   // 不给聊天记录 —— 他们只知道自己被交代的事 + 自己的档案
      let view = selectSpeakerView(session, { scope: scope, card: card });
      if (cfg.ctxMsgs > 0 && view.length > cfg.ctxMsgs) view = view.slice(-cfg.ctxMsgs);
      return view;
    };
    onEvent({ type: "meeting_start", topic, participants: entries.map((e) => e.name), rounds });
    await _councilPush("begin", [{ topic: topic, rounds: rounds, isolated: isolated, participants: entries.map((e) => e.name) }]);
    const answers = [];
    const runRound = async (roundNo, withReview) => {
      await _councilPush("round", [roundNo]);
      return await Promise.all(entries.map(async (e) => {
        const aspectLine = e.aspect ? ("\n本会议你负责的方面：" + e.aspect) : "";
        const review = withReview
          ? ("\n【上一轮其他人的结论】\n" + answers.map((a) => "· " + a.name + "：" + String(a.text || "").slice(0, 800)).join("\n") + "\n请针对以上结论补充、修正或反驳（不必重复赞同）。")
          : "";
        const brief = "【私下小会·第 " + roundNo + " 轮】议题：" + topic + aspectLine + review + "\n请直接用你的身份给出结论（简洁、可执行；不要寒暄、不要提问、不要输出方括号标记）。";
        try {
          onEvent({ type: "meeting_speaker", who: e.name, round: roundNo, phase: "start" });
          await _councilPush("speaking", [e.name]);
          let _memInj = "";
          try {
            if (window.__memCore && e.card) _memInj = await window.__memCore.buildInjection(e.card.id || e.card.name, brief);
          } catch (_me) { _memInj = ""; }
          const text = await callPeerModel(e.card, capView(e.card), brief + _memInj);
          const clean = String(text || "").trim();
          // text 带全文（过程面板要能读到"小会里说了什么"）；summary 仅给右栏控制台做一行预览
          onEvent({ type: "meeting_speaker", who: e.name, round: roundNo, phase: "done", summary: clean.slice(0, 200), text: clean });
          await _councilPush("say", [{ who: e.name, text: clean }]);
          try {
            if (window.__memCore && e.card && window.__memCore.enabled()) {
              window.__memCore.remember("【" + e.name + "】" + clean, { speakerCid: e.card.id });
            }
          } catch (_we) {}
          return { name: e.name, aspect: e.aspect, text: clean };
        } catch (err) {
          const msg = String((err && err.message) || err);
          onEvent({ type: "meeting_speaker", who: e.name, round: roundNo, phase: "error", error: msg });
          await _councilPush("say", [{ who: e.name, error: msg }]);
          return { name: e.name, aspect: e.aspect, text: "", error: msg };
        }
      }));
    };
    const r1 = await runRound(1, false);
    answers.push(...r1);
    let r2 = null;
    if (rounds >= 2) r2 = await runRound(2, true);
    onEvent({ type: "meeting_done", topic, participants: answers.map((a) => a.name) });
    await _councilPush("done", [{ note: rounds + " 轮结束 · 结论已回给主 agent" }]);
    return {
      ok: true, topic, rounds,
      room: "/tools/council/index.html",
      dropped: _dropped.length ? _dropped : undefined,
      context: isolated ? "isolated" : "chat",
      answers: answers.map((a) => ({ who: a.name, aspect: a.aspect || undefined, text: a.text, error: a.error || undefined })),
      review: r2 ? r2.map((a) => ({ who: a.name, text: a.text, error: a.error || undefined })) : undefined,
      note: "以上为多智能体讨论结论（未进聊天时间线）。过程在右栏讨论区可见（room 字段的地址，用 stage_open 打开）。" +
        "可据此作答；也可用 invite_character 请其中一位上台直接回答。",
    };
  }
  // 2026-11-09：群聊里的私有通道（耳语）。
  // 只让被指定的角色知道某件事，其他角色与其他 agent 都看不到 —— 这才是"信息差"，
  // 也是群聊能变成真多智能体的关键：各自的上下文不同，不是同一份日志换人设。
  function whisperTo(opts) {
    const o = opts || {};
    const card = _maCardByName(o.to || o.name || "");
    if (!card) return { ok: false, error: "找不到角色：" + (o.to || o.name || "") };
    const text = String(o.text || "").trim();
    if (!text) return { ok: false, error: "需要 text" };
    session.push({ role: "user", content: "（私下对" + card.name + "）" + text, sc: currentScopeKey(), to: card.name });
    // 耳语只进接收方的记忆 —— 别的人也读不到，将来也记不起来
    try {
      if (window.__memCore && window.__memCore.enabled()) {
        window.__memCore.putFacts(card.id, [{ what: text, why: "whisper", fact_type: "world", fact_kind: "conversation", entities: [] }], { kind: "whisper" });
      }
    } catch (e) {}
    try { persistSessionIfEnabled(); } catch (e) {}
    return { ok: true, to: card.name, note: "只有 " + card.name + " 能看到这条；其他角色看不到。" };
  }

  async function inviteCharacterToTimeline(opts) {
    const o = opts || {};
    const card = _maCardByName(o.name);
    if (!card) return { ok: false, error: "找不到角色：" + String(o.name || "") };
    const onEvent = typeof o.onEvent === "function" ? o.onEvent : function () {};
    onEvent({ type: "peer_invite", who: card.name, phase: "start" });
    try {
      const cfg = _maCfg();
      let view = selectSpeakerView(session, { scope: currentScopeKey(), card });
      if (cfg.ctxMsgs > 0 && view.length > cfg.ctxMsgs) view = view.slice(-cfg.ctxMsgs);
      const brief0 = String(o.brief || "").trim();
      // 2026-11-09：发言前先取出"它自己记得的事"（按角色分库，别人的记忆取不到）
      let _memInj = "";
      try {
        if (window.__memCore) _memInj = await window.__memCore.buildInjection(card.id || card.name, brief0 || "当前局面");
      } catch (e) { _memInj = ""; }
      // 2026-11-09：Agent 模式下，角色以 **agent 形态**上台（自己能调工具查证），
      // 而不是一次裸调用。非 agent 模式仍走原来的单次调用（便宜、够用）。
      const _agentMode = (function () {
        try { const b = document.getElementById("agentModeBtn"); return !!(b && b.getAttribute("aria-pressed") === "true"); } catch (e) { return false; }
      })();
      const _useLoop = (typeof o.loop === "boolean") ? o.loop : _agentMode;
      let text;
      if (_useLoop) {
        const r = await runCharacterAgent(card, (brief0 || "用户刚把你请进这段对话，请按你的身份接住当前话题、直接说话。"));
        if (!r.ok) throw new Error(r.error || (card.name + " 没有产出内容"));
        text = r.said;
      } else {
        const brief = (brief0 + _memInj);
        text = await callPeerModel(
          card, view,
          brief
            ? ("【被请上台】" + brief + "\n请按你的身份直接回答（不要寒暄、不要提问、不要输出方括号标记）。")
            : "【被请上台】用户刚把你请进这段对话，请按你的身份接住当前话题、直接说话（不要寒暄、不要输出方括号标记）。"
        );
      }
      const clean = stripResidualMarkup(stripJailbreakPrefix(stripThinkBlocks(String(text || ""))));
      if (!clean.trim()) { onEvent({ type: "peer_invite", who: card.name, phase: "done" }); return { ok: false, error: card.name + " 没有产出内容" }; }
      // 渲染成时间线里的一条 AI 行（挂该角色的名字/头像）+ 落库（带场景键）
      const row = makeRow("assistant");
      row.bubble.innerHTML = renderMarkdownSafe(clean);
      if (window.__character && window.__character.decorateAiRow) { try { window.__character.decorateAiRow(row.rowEl, card); } catch (e) {} }
      setStreamingUI(row.rowEl, false);
      // 2026-11-09：这一句进它自己的记忆，也进其他在场者"听到"的记忆。
      // remember 内部只抽取一次再分发写入 —— 四个人听到不该做四次抽取。
      try {
        if (window.__memCore && window.__memCore.enabled()) {
          const _others = (window.__multi && window.__multi.getSceneCards ? window.__multi.getSceneCards() : [])
            .filter((c) => c && c.id !== card.id).map((c) => c.id);
          window.__memCore.remember("【" + card.name + "】" + clean, { speakerCid: card.id, listenerCids: _others });
        }
      } catch (e) {}
      const msg = { role: "assistant", content: clean, speakerId: card.id, speakerName: card.name, speakerIcon: card.icon || "🙂" };
      session.push(scopeTag(msg));
      try { row.rowEl.dataset.sidx = String(session.length - 1); } catch (e) {}
      persistSessionIfEnabled();
      updateSpacer();
      scrollToBottom();
      onEvent({ type: "peer_invite", who: card.name, phase: "done", text: clean });
      return { ok: true, who: card.name, said: clean, note: "已请「" + card.name + "」在时间线上回答（用户能看到它的气泡）。" };
    } catch (err) {
      onEvent({ type: "peer_invite", who: card.name, phase: "done" });
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  // ─── 4.53 真实节奏:攒消息防抖(支持连发) + 不秒回延迟 + 「正在输入」提示 + 群聊在线模式 ───
  // 痛点:发一条就秒回、且没法像真人那样连着发好几句。
  // 做法:Send/Enter 先把消息只入 UI+session(不触发 AI),起一个防抖计时;你继续发就重置计时,
  //      停手 N 秒(基准 cfw_reply_pacing_delay_v1 + 随机抖动)才真正触发 AI 回复,期间显示「正在输入」。
  // 群聊在线模式 cfw_group_online_mode_v1: all=现状(基本都会接力) / subset=拟真(随机谁回、延迟更长、可能没人接)。
  const LS_REPLY_PACING = "cfw_reply_pacing_v1";
  const LS_PACING_DELAY = "cfw_reply_pacing_delay_v1";
  const LS_GROUP_ONLINE = "cfw_group_online_mode_v1";
  function pacingEnabled() { return (localStorage.getItem(LS_REPLY_PACING) ?? "1") === "1"; }
  function pacingBaseDelay() { const n = parseInt(localStorage.getItem(LS_PACING_DELAY) ?? "2200", 10); return isNaN(n) ? 2200 : Math.max(0, Math.min(15000, n)); }
  function groupOnlineMode() { return localStorage.getItem(LS_GROUP_ONLINE) === "subset" ? "subset" : "all"; }

  let _typingEl = null;
  function showTyping(label) {
    hideTyping();
    const el = document.createElement("div");
    el.className = "row ai pacing-typing";
    const av = document.createElement("div"); av.className = "avatar bot"; av.textContent = "🙂";
    const content = document.createElement("div"); content.className = "content";
    const bubble = document.createElement("div"); bubble.className = "bubble ai wechat-typing";
    bubble.textContent = (label ? label + " " : "") + "正在输入···";
    content.appendChild(bubble);
    el.appendChild(av); el.appendChild(content);
    chatEl.insertBefore(el, spacerEl);
    _typingEl = el;
    if (isNearBottom()) scrollToBottom();
  }
  function hideTyping() {
    if (_typingEl && _typingEl.parentNode) _typingEl.parentNode.removeChild(_typingEl);
    _typingEl = null;
  }

  function dedupeCards(arr) {
    const seen = new Set(); const out = [];
    for (const c of (arr || [])) { if (c && c.id && !seen.has(c.id)) { seen.add(c.id); out.push(c); } }
    return out;
  }
  function pickRandomOnlineCard(excludeCard) {
    let cards = [];
    try { cards = (window.__multi.getSceneCards && window.__multi.getSceneCards()) || []; } catch (e) {}
    cards = cards.filter(c => c && (!excludeCard || c.id !== excludeCard.id));
    if (!cards.length) return null;
    return cards[Math.floor(Math.random() * cards.length)];
  }

  // 只把输入消息入 UI+session,不触发 AI(攒消息用)
  function pushUserMessageOnly(text) {
    // 2026-09-14: 附件在这里就快照进消息(files/images 随 session 持久化),气泡同步渲染 chip/卡片。
    // 之后 fireReply→sendOne({allowEmptyText}) 只负责请求装配时展开,不再依赖任何内存全局 ——
    // 所以刷新/重试都不会丢附件内容(旧实现的「读而不清」hack 因此消失)。
    const _attC = takeAttachments();
    const userRow = makeRow("user");
    if (text) userRow.bubble.textContent = text;
    renderAttachmentsInto(userRow.bubble, _attC);
    applyUserFold(userRow.bubble);
    const inEst = estimateTokens(text) + attFileTokens(_attC);
    totalInEstimate += inEst;
    userRow.stats.textContent = `Input(估算): ≈${inEst} | Total In(估算): ≈${totalInEstimate}`;
    session.push(scopeTag(Object.assign({ role: "user", content: text }, attMeta(_attC))));
    try { userRow.rowEl.dataset.sidx = String(session.length - 1); } catch (_sx) {} // 2026-10-08: 重试/删除按真实下标算
    persistSessionIfEnabled();
  }

  let _pendingTimer = null;
  let _pendingTypingTimer = null;
  let _pendingTargets = null;
  function clearPendingTimers() {
    if (_pendingTimer) { clearTimeout(_pendingTimer); _pendingTimer = null; }
    if (_pendingTypingTimer) { clearTimeout(_pendingTypingTimer); _pendingTypingTimer = null; }
  }

  // 防抖入口:把消息攒进 session,停手 N 秒后才真正回复(连发期间不断重置计时)
  function queueSend() {
    const raw = inputEl.value.trim();
    // 2026-09-14: 只附附件不打字也允许发送
    if (!raw && !attCount()) return;
    if (isGroupChatActive()) {
      const t = parseAtMentions(raw);
      if (t.length) _pendingTargets = dedupeCards((_pendingTargets || []).concat(t));
    }
    pushUserMessageOnly(raw);
    inputEl.value = "";
    inputEl.style.height = "auto";
    updateSpacer();
    scrollToBottom();
    clearPendingTimers();
    hideTyping();
    const delay = pacingBaseDelay() + Math.floor(Math.random() * 800);
    const typingAt = Math.max(0, delay - 1200);
    _pendingTypingTimer = setTimeout(() => { showTyping(); }, typingAt);
    _pendingTimer = setTimeout(function fire() {
      if (isSending) { _pendingTimer = setTimeout(fire, 700); return; }
      clearPendingTimers();
      hideTyping();
      const targets = _pendingTargets; _pendingTargets = null;
      fireReply(targets);
    }, delay);
  }

  // 防抖计时结束后真正触发 AI 回复(用户消息已在 session,allowEmptyText 不再建 user 气泡)
  async function fireReply(targets) {
    if (!isGroupChatActive()) {
      return sendOne({ allowEmptyText: true });
    }
    if (targets && targets.length) {
      let reply = await sendOne({ allowEmptyText: true, asCard: targets[0] });
      for (let i = 1; i < targets.length; i++) {
        if (!isGroupChatActive()) break;
        const r = await sendOne({ allowEmptyText: true, asCard: targets[i] });
        if (r == null) break;
        reply = r;
      }
      if (reply != null) runAutoRelay(reply, targets[targets.length - 1]);
      return reply;
    }
    // 无 @:subset 模式随机挑一位"在线"的人先回,all 模式沿用当前角色
    const firstCard = groupOnlineMode() === "subset" ? pickRandomOnlineCard(null) : null;
    const speaker = firstCard || ((window.__character && window.__character.getActiveCard) ? window.__character.getActiveCard() : null);
    const reply = firstCard
      ? await sendOne({ allowEmptyText: true, asCard: firstCard })
      : await sendOne({ allowEmptyText: true });
    if (reply != null) runAutoRelay(reply, speaker);
    return reply;
  }

  // send():从输入框取消息的入口(绑定 Send 按钮 / Enter 键)
  // 4.53 真实节奏:pacing 开启走 queueSend 攒消息防抖;关闭走 sendImmediate 即时发送(旧行为)
  function send() {
    // 2026-11-10: agent 轮次进行中 —— 输入的文本作为「插话」注入当前轮，不新起一条消息。
    if (isSending) {
      if (_agentSteerQueue) return steerAgent();
      return null;
    }
    if (pacingEnabled()) return queueSend();
    return sendImmediate();
  }

  // 2026-11-10: 把用户插话注入正在跑的 agent 轮次（对齐 ZCode「工作中发消息」）。
  // 不 abort 上下文：内核 next-round 的 beforeStep 钩子把它 append 进 messages，模型当作新的用户指令处理。
  // 同时解掉挂着的放行卡 —— 否则循环卡在等待放行里，插话永远读不到。
  function steerAgent() {
    const text = inputEl.value.trim();
    if (!text || !_agentSteerQueue) return null;
    const isStop = /^(停|停止|停下来|停手|别动|别点了|别再点|stop\b|halt\b)/i.test(text);
    const row = makeRow("user");
    row.bubble.textContent = text;
    applyUserFold(row.bubble);
    inputEl.value = "";
    inputEl.style.height = "auto";
    updateSendBtnState();
    updateSpacer();
    scrollToBottom();

    if (isStop) {
      try { if (window.__agentConsole && window.__agentConsole.note) window.__agentConsole.note("用户要求停止：" + text); } catch (e) {}
      const gen = sendGen;
      try { if (window.__stopCurrent) window.__stopCurrent(); } catch (e) {}
      const pushStop = () => {
        session.push(scopeTag({ role: "user", content: text }));
        try { row.rowEl.dataset.sidx = String(session.length - 1); } catch (_sx) {}
        persistSessionIfEnabled();
      };
      const t0 = Date.now();
      const tick = () => {
        if (sendGen !== gen) { pushStop(); return; } // 用户已经发了新消息，别把「停」弄丢
        const kernelBusy = !!(window.AgentKernel && typeof window.AgentKernel.isRunning === "function" && window.AgentKernel.isRunning());
        if (!isSending && !kernelBusy) {
          // 等中断产生的半截 assistant 先落盘，再入 session —— 保证「停」是最后一条 user，
          // 新一轮模型才会针对它回话，而不是接着自己的半截继续说。
          pushStop();
          try { sendOne({ allowEmptyText: true }); } catch (e) {}
          return;
        }
        if (Date.now() - t0 > 10000) { pushStop(); return; } // 工具卡死就不强发
        setTimeout(tick, 250);
      };
      setTimeout(tick, 350);
      return null;
    }

    session.push(scopeTag({ role: "user", content: text }));
    try { row.rowEl.dataset.sidx = String(session.length - 1); } catch (_sx) {}
    persistSessionIfEnabled();
    const m = { role: "user", content: text };
    _steerMsgs.add(m);            // 已入 session，写回时跳过
    _agentSteerQueue.push(m);     // 内核下一轮请求前 append 进 messages
    try { if (window.__agentConsole && window.__agentConsole.note) window.__agentConsole.note("用户插话：" + text); } catch (e) {}
    try { if (window.__agentConsole && window.__agentConsole.cancelPending) window.__agentConsole.cancelPending("用户插话"); } catch (e) {}
    return null;
  }

  // 4.43 多人编排群聊:解析 @召唤 → 被点名者依次回 → 触发自发接力;否则当前角色回 → 触发自发接力。
  async function sendImmediate() {
    if (!isGroupChatActive()) return sendOne();
    const raw = inputEl.value.trim();
    const targets = parseAtMentions(raw);
    if (raw && targets.length) {
      let reply = await sendOne({ text: raw, asCard: targets[0] });
      for (let i = 1; i < targets.length; i++) {
        if (!isGroupChatActive()) break;
        const r = await sendOne({ allowEmptyText: true, asCard: targets[i] });
        if (r == null) break;
        reply = r;
      }
      if (reply != null) runAutoRelay(reply, targets[targets.length - 1]);
      return reply;
    }
    const speaker = (window.__character && window.__character.getActiveCard) ? window.__character.getActiveCard() : null;
    const reply = await sendOne();
    if (reply != null) runAutoRelay(reply, speaker);
    return reply;
  }

  // injectModeratorMsg(text):鱼缸引擎/主持人通道,把一条旁白介入消息插到 session 和 UI
  // 吐槽姬 mode 下走 .row.moderator 居中样式,不占用户位
  function injectModeratorMsg(text) {
    if (!text) return;
    const content = "【主持人】" + String(text);
    const row = makeRow("user", { moderator: true });
    row.bubble.textContent = content;
    // 2026-09-14: 主持人/鱼缸旁白不再「偷吃」待发附件(旧实现会调 consumePendingFileAppendix 把用户
    // 刚附加的文件全文塞进主持人消息,用户真正那条反而丢了)。旁白就是纯文本。
    session.push(scopeTag({ role: "user", content: content }));
    try { row.rowEl.dataset.sidx = String(session.length - 1); } catch (_sx) {} // 2026-10-08
    persistSessionIfEnabled();
    updateSpacer();
    scrollToBottom();
  }

  // 2026-11-10: agent 运行中点发送键 = 有字插话 / 没字停止（对齐 ZCode 的「工作中可插话」）。
  sendBtn.addEventListener("click", () => {
    if (isSending && _agentSteerQueue) {
      if (inputEl.value.trim()) return steerAgent();
      try { if (window.__stopCurrent) window.__stopCurrent(); } catch (e) {}
      return;
    }
    send();
  });

  // 刷新/关页时若有流式进行中，把已收到的部分当作一条完整的 assistant 回复兑现到 session 并持久化
  // 避免“用户消息已保存但 AI 回复丢失”的悬空状态
  window.addEventListener("beforeunload", () => {
    if (!partialStream || !partialStream.full) return;
    const m = { role: "assistant", content: partialStream.full };
    if (partialStream.fullReasoning) m.reasoning_content = partialStream.fullReasoning;
    if (partialStream.speakerName) {
      m.speakerId = partialStream.speakerId;
      m.speakerName = partialStream.speakerName;
      m.speakerIcon = partialStream.speakerIcon;
    }
    session.push(scopeTag(m));
    persistSessionIfEnabled();
  });

  // 2026-06-21 Bug:云同步「对话同步了但内容为空」+「手机主对话在别处看不见」——
  // 根因:聊天推送是 markChatDirty 的 30s 防抖;beforeunload 在移动端不可靠,手机切后台/被系统回收
  // 常发生在 30s 内 → 最新消息及本机主对话槽从未推上云。修:页面转入后台(visibilitychange→hidden)
  // 或卸载(pagehide)时立即 flush 一次聊天推送。pushChatNow 内部有 includeChat()/syncEnabled() 门控,
  // 关同步时为 no-op,安全;persistSessionIfEnabled 先把当前会话(含本机主对话槽)落本地再推。
  function _flushChatToCloud() {
    try {
      // 4.82 去重:visibilitychange(hidden) + pagehide + beforeunload 会在一次关页/最小化里连发,
      // 每次都全量 persist + push;2s 内只真正 flush 一次。
      const _now = Date.now();
      if (_now - (_flushChatToCloud._last || 0) < 2000) return;
      _flushChatToCloud._last = _now;
      persistSessionIfEnabled();
      if (window.__sync && window.__sync.pushChatNow) window.__sync.pushChatNow();
    } catch (e) {}
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") _flushChatToCloud(); });
  window.addEventListener("pagehide", _flushChatToCloud);

  // ─── 4.43 @召唤自动补全:多人编排群聊下,输入框打 @ 弹出在场角色候选 ───
  let _atMenu = null, _atItems = [], _atIndex = -1, _atOpen = false;
  function ensureAtMenu() {
    if (_atMenu) return _atMenu;
    const menu = document.createElement("div");
    menu.id = "atMentionMenu";
    menu.style.cssText = "position:absolute;z-index:9999;min-width:160px;max-width:280px;max-height:240px;overflow:auto;border-radius:10px;padding:4px;display:none;box-shadow:0 8px 24px rgba(0,0,0,.35);";
    document.body.appendChild(menu);
    _atMenu = menu;
    return menu;
  }
  function getAtQuery() {
    const val = inputEl.value || "";
    const pos = inputEl.selectionStart || 0;
    const left = val.slice(0, pos);
    const m = left.match(/(^|\s)@([^\s@]*)$/);
    if (!m) return null;
    return { query: m[2], start: pos - m[2].length - 1, end: pos };
  }
  function insertMention(card) {
    const q = getAtQuery();
    if (!q || !card) { closeAtMenu(); return; }
    const val = inputEl.value || "";
    const before = val.slice(0, q.start);
    const after = val.slice(q.end);
    const insert = "@" + card.name + " ";
    inputEl.value = before + insert + after;
    const caret = (before + insert).length;
    try { inputEl.setSelectionRange(caret, caret); } catch (e) {}
    closeAtMenu();
    inputEl.focus();
    try { inputEl.dispatchEvent(new Event("input")); } catch (e) {}
  }
  function highlightAt() {
    const isLight = (window.__theme && typeof window.__theme.is === "function") ? window.__theme.is("light") : (localStorage.getItem("my-theme") === "light"); // 4.79 #12: 改读有效明暗(显式选择||主题原生),修 glass/少女 原生浅色下直读 my-theme=null 误判为暗导致 UI 不可读
    _atItems.forEach((it, i) => { it.el.style.background = (i === _atIndex) ? (isLight ? "#eaeaea" : "#33333d") : "transparent"; });
  }
  function setAtIndex(i) { _atIndex = i; highlightAt(); }
  function closeAtMenu() { if (_atMenu) _atMenu.style.display = "none"; _atOpen = false; _atItems = []; _atIndex = -1; }
  function positionAtMenu() {
    if (!_atMenu) return;
    const r = inputEl.getBoundingClientRect();
    const mh = _atMenu.offsetHeight || 200;
    let top = r.top - mh - 6;
    if (top < 8) top = r.bottom + 6;
    _atMenu.style.top = (top + window.scrollY) + "px";
    _atMenu.style.left = (r.left + window.scrollX) + "px";
  }
  function openAtMenu(cards) {
    const menu = ensureAtMenu();
    const isLight = (window.__theme && typeof window.__theme.is === "function") ? window.__theme.is("light") : (localStorage.getItem("my-theme") === "light"); // 4.79 #12: 改读有效明暗(显式选择||主题原生),修 glass/少女 原生浅色下直读 my-theme=null 误判为暗导致 UI 不可读
    menu.style.background = isLight ? "#ffffff" : "#1c1c22";
    menu.style.border = "1px solid " + (isLight ? "#ddd" : "#3a3a44");
    menu.style.color = isLight ? "#222" : "#eee";
    menu.innerHTML = "";
    _atItems = [];
    cards.forEach((card, i) => {
      const it = document.createElement("div");
      it.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:7px;cursor:pointer;font-size:14px;white-space:nowrap;";
      const ico = document.createElement("span"); ico.textContent = card.icon || "🙂"; ico.style.flexShrink = "0";
      const nm = document.createElement("span"); nm.textContent = card.name; nm.style.cssText = "overflow:hidden;text-overflow:ellipsis;";
      it.appendChild(ico); it.appendChild(nm);
      it.addEventListener("mousedown", (e) => { e.preventDefault(); insertMention(card); });
      it.addEventListener("mouseenter", () => setAtIndex(i));
      menu.appendChild(it);
      _atItems.push({ card, el: it });
    });
    _atIndex = 0;
    highlightAt();
    menu.style.display = "block";
    _atOpen = true;
    positionAtMenu();
  }
  function updateAtMenu() {
    if (!isGroupChatActive()) { closeAtMenu(); return; }
    const q = getAtQuery();
    if (!q) { closeAtMenu(); return; }
    let cards = [];
    try { cards = (window.__multi.getSceneCards && window.__multi.getSceneCards()) || []; } catch (e) {}
    const query = (q.query || "").toLowerCase();
    const filtered = (query ? cards.filter(c => c && c.name && c.name.toLowerCase().includes(query)) : cards).filter(Boolean);
    if (!filtered.length) { closeAtMenu(); return; }
    openAtMenu(filtered);
  }
  function atMenuKeydown(e) {
    if (!_atOpen || !_atItems.length) return false;
    if (e.key === "ArrowDown") { e.preventDefault(); _atIndex = (_atIndex + 1) % _atItems.length; highlightAt(); return true; }
    if (e.key === "ArrowUp") { e.preventDefault(); _atIndex = (_atIndex - 1 + _atItems.length) % _atItems.length; highlightAt(); return true; }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); const it = _atItems[_atIndex] || _atItems[0]; if (it) insertMention(it.card); return true; }
    if (e.key === "Escape") { e.preventDefault(); closeAtMenu(); return true; }
    return false;
  }
  inputEl.addEventListener("input", updateAtMenu);
  inputEl.addEventListener("blur", () => { setTimeout(closeAtMenu, 150); });

  inputEl.addEventListener("keydown", (e) => {
    if (_atOpen && atMenuKeydown(e)) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  // ─── 2026-06-07 手机端滚动自动隐藏顶栏/底栏(集中一处:JS 只切 body.nav-hidden,位移/过渡全在 styles.css 的 @media 手机段)───
  function setupScrollHide() {
    if (!historyWrap) return;
    let lastY = 0, ticking = false;
    const TH = 8; // 滚动阈值,过滤抖动
    // 4.75 顶栏占位块修复:#topbar 是 position:sticky,靠 transform:translateY(-110%) 收起并不会归还它在 flex 流里占的高度,
    //   于是 nav-hidden 挂着时顶部始终残留一条「空槽」。正常滚动时这条空槽在视口之上看不到;
    //   但历史恢复/切角色/切会话会用 scrollToBottom() 程序化跳变,被滚动处理器误判成「下滑」而加上 nav-hidden,
    //   此时人停在顶部/内容不足一屏 → 空槽就停在正文上方挡住文字(用户反馈的「占位块」)。
    //   ① notScrollable():内容不足一屏(不可滚动)时强制显示顶栏,根除短对话/恢复后残留。
    //   ② window.__navHideReset:给历史恢复/切角色/切会话调用,复位 lastY 并显示顶栏,杜绝程序化滚动误触发收起。
    function notScrollable() {
      return (historyWrap.scrollHeight - historyWrap.clientHeight) < 80;
    }
    function reset() {
      document.body.classList.remove("nav-hidden");
      lastY = historyWrap.scrollTop;
    }
    window.__navHideReset = reset;
    historyWrap.addEventListener("scroll", () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        if (notScrollable()) { document.body.classList.remove("nav-hidden"); lastY = historyWrap.scrollTop; return; }
        const y = historyWrap.scrollTop;
        const dy = y - lastY;
        if (Math.abs(dy) < TH) return;
        if (y < 40) document.body.classList.remove("nav-hidden");       // 贴顶始终显示
        else if (dy > 0) document.body.classList.add("nav-hidden");      // 下滑→隐藏
        else document.body.classList.remove("nav-hidden");              // 上滑→显示
        lastY = y;
      });
    }, { passive: true });
  }

  // ─── 2026-06-08 手机端开发者按钮收纳:dev 模式 + 窄屏时,顶栏 ⏸ 暂停同步 / 🛠 开发者面板 会和模型选择器/设置挤成换行冲突。
  // 收进一个「更多」下拉(仅手机 + dev 显示该入口);桌面端仍内联平铺。用 matchMedia 在两种布局间搬运真实节点(不复制,保留事件绑定)。───
  function setupTopbarOverflow() {
    const moreBtn = document.getElementById("topbarMoreBtn");
    const pauseBtn = document.getElementById("syncPauseBtn");
    const devBadge = document.getElementById("devBadgeTopbar");
    if (!moreBtn || (!pauseBtn && !devBadge)) return;
    // 桌面还原锚点(注释节点占位,搬回时插回原处)
    const pauseAnchor = pauseBtn ? document.createComment("pause-home") : null;
    const devAnchor = devBadge ? document.createComment("dev-home") : null;
    if (pauseBtn && pauseAnchor) pauseBtn.parentNode.insertBefore(pauseAnchor, pauseBtn);
    if (devBadge && devAnchor) devBadge.parentNode.insertBefore(devAnchor, devBadge);
    const menu = document.createElement("div");
    menu.id = "topbarMoreMenu";
    menu.style.display = "none";
    document.body.appendChild(menu);
    let open = false;
    function closeMenu() { open = false; menu.style.display = "none"; }
    function openMenu() {
      open = true; menu.style.display = "flex";
      const r = moreBtn.getBoundingClientRect();
      menu.style.top = (r.bottom + window.scrollY + 6) + "px";
      menu.style.left = (Math.max(8, r.right - (menu.offsetWidth || 160)) + window.scrollX) + "px";
    }
    moreBtn.addEventListener("click", (e) => { e.stopPropagation(); open ? closeMenu() : openMenu(); });
    document.addEventListener("click", (e) => { if (open && !menu.contains(e.target) && e.target !== moreBtn && !moreBtn.contains(e.target)) closeMenu(); });
    const mq = window.matchMedia("(max-width: 1023px)");
    function apply() {
      if (mq.matches) {
        if (pauseBtn && pauseBtn.parentNode !== menu) menu.appendChild(pauseBtn);
        if (devBadge && devBadge.parentNode !== menu) menu.appendChild(devBadge);
      } else {
        if (pauseBtn && pauseAnchor && pauseAnchor.parentNode) pauseAnchor.parentNode.insertBefore(pauseBtn, pauseAnchor);
        if (devBadge && devAnchor && devAnchor.parentNode) devAnchor.parentNode.insertBefore(devBadge, devAnchor);
        closeMenu();
      }
    }
    apply();
    if (mq.addEventListener) mq.addEventListener("change", apply); else if (mq.addListener) mq.addListener(apply);
  }

  // ─── 2026-10-08 内存自愈（设置→外观可关，壳内默认开）───
  // WebView2 壳长跑后 GPU/渲染进程会持住大量缓存内存（实测与特效档位关系不大 —— 大头是随会话、
  // 图片、长驻页面增长的部分）。本机制：窗口在后台 ≥10 分钟、没有发送中/待批/进行中的 agent 循环、
  // 输入框也没有草稿时，自动刷新页面释放整页内存。聊天记录已落盘（cfw_chat_session_v1），刷新只影响
  // 内存态，不影响任何数据。
  (function memIdleRelease() {
    function enabled() {
      try {
        const v = localStorage.getItem("cfw_mem_idle_release_v1");
        if (v === "0") return false;
        if (v === "1") return true;
        return document.documentElement.classList.contains("android-app"); // 缺省：壳内开、网页关
      } catch (e) { return false; }
    }
    const LIMIT_MS = 10 * 60 * 1000;
    let hiddenSince = 0;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { if (!hiddenSince) hiddenSince = Date.now(); }
      else hiddenSince = 0;
    });
    setInterval(() => {
      try {
        if (!document.hidden || !hiddenSince) return;
        if (Date.now() - hiddenSince < LIMIT_MS) return;
        if (!enabled()) { hiddenSince = 0; return; }
        if (isSending) return;
        if (inputEl && inputEl.value && inputEl.value.trim()) return; // 有草稿：不刷
        if (attCount()) return; // 有未发附件：不刷
        if (window.AgentKernel && typeof window.AgentKernel.isRunning === "function" && window.AgentKernel.isRunning()) return;
        location.reload();
      } catch (e) {}
    }, 60 * 1000);
  })();

  // 「思考过程显示」下拉已迁移到 settings.js

  // 2026-10-08 外部改动（云同步回灌 / 别的标签页）后：重读"缓存进模块变量"的开关 + 重绘对应控件。
  // 这四个标志在请求装配时会用到（useBuiltin / historyEnabled / promptEnabled / thinkingOn），
  // 缓存过期 = "设置变了但行为没变"（历史不落盘、不带思考、底座开关错位）。
  // 由 index.html 的 applyExternalSettings() 广播 cfw:external-settings 触发。
  function refreshCachedFlagsFromLS() {
    try { useBuiltin = (localStorage.getItem(LS_USE_BUILTIN) ?? "1") === "1"; } catch (e) {}
    try { historyEnabled = (localStorage.getItem(LS_HISTORY_ENABLED) ?? "1") === "1"; } catch (e) {}
    try { promptEnabled = (localStorage.getItem(LS_PROMPT_ENABLED) ?? "1") === "1"; } catch (e) {}
    try { thinkingOn = (localStorage.getItem(LS_THINKING) ?? "0") === "1"; } catch (e) {}
    try { if (typeof updateThinkToggleUI === "function") updateThinkToggleUI(); } catch (e) {}
    try { if (typeof paintPersonaButton === "function") paintPersonaButton(); } catch (e) {}
    try { const el = document.getElementById("historyKeep"); if (el) el.checked = historyEnabled; } catch (e) {}
    try { const el = document.getElementById("promptKeep"); if (el) el.checked = promptEnabled; } catch (e) {}
  }
  window.addEventListener("cfw:external-settings", refreshCachedFlagsFromLS);

  function init() {
    purgeLegacyConvs();         // 会话系统重做:一次性清掉旧「角色卡#会话」槽位(只跑一次)
    dedupeDefaultConvs();       // 一次性合并重复的空默认会话(只跑一次)
    applyMode(currentMode);     // 初始化模式 + 模型下拉
    setupResizeObserver();
    setupViewportListener();
    setupScrollHide();
    setupTopbarOverflow();
    updateSpacer();
    restoreSessionIfEnabled();
    renderSummaryChip();
    scrollToBottom();
    // 4.20 P1: dev mode 下 scrollLeft = scrollWidth 会把 #modeToggle 滚出桌面可视区
    // root cause: dev-only 按钮 #syncPauseBtn + #devBadgeTopbar 让 topbar-inner 总宽超 topbar-scroll viewport,
    // 推到最右后最左的 modeToggle (免费/快速切换) 被截。手机端正常因为本来就习惯横滑。
    // 修法:dev mode 下不推右,保持 modeToggle 在左侧可见;普通模式下继续推让 settingsBtn 入视。
    const tbs = document.getElementById("topbarScroll");
    const _devOn = localStorage.getItem("cfw_dev_mode_v1") === "1";
    if (tbs && !_devOn) tbs.scrollLeft = tbs.scrollWidth;
    // 2026-09-14 会话与角色卡解绑:切角色不再切槽、不再清空历史。
    // 角色只是「当前会话在跟谁聊」→ 把当前角色写回当前会话的注册表即可,历史原样保留,
    // 后续回复自然换人(助理消息本就自带 speakerId/speakerName,渲染时会用)。
    // 旧实现在这里 clearUIRows() + 换槽 —— 那正是「一切角色聊天记录就全没了」的根因;
    // 旧代码为鱼缸 relay/discuss 写的豁免分支也随之不需要了(它每轮 setActiveId 现在完全无害)。
    window.addEventListener("character:changed", () => {
      const key = currentSlotKey();
      try { setConvCharId(key, activeCardId()); } catch {}
      updateSpacer();
    });
  }

  // 暴露给 multi-agent.js / fishbowl-engine.js
  // 暴露 applyThinkDisplay 给 settings.js 切换显示模式时调用
  window.__app = { updateSpacer, sendOne, abortCurrent, injectModeratorMsg, continueGroupChat, showTyping, hideTyping, listConversations, switchConversation, createConversation, renameConversation, deleteConversation, getActiveConvId: activeConvId, applyThinkDisplay, applyAllThinkDisplay: () => document.querySelectorAll(".reasoning-block").forEach(applyThinkDisplay), setCustomPricing, getCustomPricing, getPricing, pricingKeysFor, canonicalEndpoint,
    // 2026-09-14 UI第二轮:状态面板只读数据接口(会话消息引用/令牌估算/最近请求快照)
    estimateTokens, getSessionMessages: () => session, getLastRequestStats: () => lastReqStats,
    // 4.83: 附件 token 估算(状态面板「上传文档」行用,与实时统计同口径)
    attFileTokens,
    // 2026-09-14 附件重构:供 chat-ux.js 的「重试」按 DOM 行号取回原始消息(含附件元数据)
    getSessionMessageAt: (i) => (i >= 0 && i < session.length ? session[i] : null),
    // 2026-10-08 多智能体独立上下文：控制台/状态面板读「当前口径 + 计入条数」（隔离要可见，不然像 bug）
    getContextInfo: () => {
      try {
        const scope = currentScopeKey();
        const card = (window.__character && window.__character.getActiveCard) ? window.__character.getActiveCard() : null;
        const included = selectSpeakerView(session, { scope, card }).length;
        return { scope, label: scopeLabel(scope), total: session.length, included, speaker: card ? card.name : "" };
      } catch (e) { return null; }
    },
    // 平级名单用：某角色"自己的单聊上下文"条数（把多智能体独立上下文可见化）
    getRoleContextCount: (card) => {
      try {
        const id = typeof card === "string" ? card : (card && card.id);
        if (!id) return null;
        return selectSpeakerView(session, { scope: "char:" + id, card: (typeof card === "object" ? card : null) }).length;
      } catch (e) { return null; }
    },
    // 2026-10-08 Agent 的多智能体能力（tools.js 的 convene_meeting / invite_character 调这两个）
    runPeerMeeting,
    oneShot,
    runCharacterAgent,
    whisperTo,
    inviteCharacterToTimeline };

  // 云同步 + Auth UI 已迁移到 settings.js

  init();
})();