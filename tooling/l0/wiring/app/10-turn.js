// 10-turn.js — 每会话独立 turn、并发/取消、模式与费用状态。
  // ── A09: 模型目录/占位/自动拉取已迁到 /js/text/data/model-catalog.js（window.__modelCatalog）。

  // ── A07: provider-aware 计价已迁到 /js/text/data/cost-ledger.js（window.__costLedger）。

  let session = [];

  // ─── 2026-11-11 会话并行：每个会话一条独立 turn ───
  // 旧版 session/isSending/controller/sendGen 全是单例：切换会话时旧请求会把回复
  // 写进新会话（串台），旧 AI 行被清掉后看起来"消息全没了"。现在每个会话有自己的
  // turn（session 引用/controller/partial/steer 队列）；切换只换视图，不中断后台轮次。
  // turn.alive 只在 turn 结束/被替换时置 false；停止走 turn.discard/stopped，仍允许半截落盘。
  // ── A24: 轮次注册表与生命周期已迁到 /js/text/engine/turn-runtime.js（window.turnRuntimeSvc）。
  //    本文件只负责「界面镜像」：isSending / 插话队列 / 部分流 / 发送键形态（syncActiveTurnGlobals），
  //    以及轮次结束后的实时事件应用（afterEnd）。所有状态迁移都走模块，不在两处各留一份。
  const _turns = window.turnRuntimeSvc.create({
    getActiveConvId: () => activeConvId(),
    getSession: () => session,
    persistSession: (convId, arr) => persistSessionForConv(convId, arr),
    onChange: () => { syncActiveTurnGlobals(); notifyConvTurns(); },
    afterEnd: () => { try { if (window.chatRealtimeSvc && typeof window.chatRealtimeSvc.applyPending === "function") window.chatRealtimeSvc.applyPending().catch(() => {}); } catch (e) {} },
  });
  const activeTurn = () => _turns.activeTurn();
  const isConvSending = (id) => _turns.isSending(id);
  const hasAnyTurnRunning = () => _turns.hasAnyRunning();
  function syncActiveTurnGlobals() {
    const t = activeTurn();
    isSending = !!(t && t.running);
    _agentSteerQueue = t ? t.steerQueue : null;
    _agentImageQueue = t ? t.imageQueue : null;
    currentController = t ? t.controller : null;
    partialStream = t ? t.partialStream : null;
    try {
      if (sendBtn) {
        // 普通轮次：发送键禁用；Agent 轮次：保持可点（有字插话 / 没字停止）
        sendBtn.disabled = !!(t && t.running && !t.stopping && t.kind !== "agent");
        updateSendBtnState();
      }
    } catch (e) {}
  }
  // sendOne 内部会 shadow 局部 partialStream；这个 setter 给「活跃轮次」同步外层引用（beforeunload 用）。
  function setActivePartialStream(v) { partialStream = v; }
  function notifyConvTurns() {
    try { window.dispatchEvent(new CustomEvent("cfw:conv-turns")); } catch (e) {}
  }
  // 该 turn 是否仍是这个会话的当前轮次（被新发送替换/已被清掉时，旧闭包不能再写回）
  const turnIsCurrent = (turn) => _turns.isCurrent(turn);
  const beginTurn = (kind) => _turns.begin(kind);
  const endTurn = (turn) => _turns.end(turn);
  const hasActiveTurn = (convId) => _turns.hasActive(convId);
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalInEstimate = 0;
  let totalOutEstimate = 0;
  // 2026-09-14 UI第二轮:最近一次完成请求的真实 usage 快照(供右栏/手机「状态」面板读取,见 appSvc.getLastRequestStats)
  let lastReqStats = null;
  let isSending = false;
  // 2026-11-10: agent 运行中的「插话」通道（对齐 ZCode 工作中发消息）——
  // 非 null = 当前有 agent 轮次在跑；push 一条 {role:"user"} 内核会在下一轮请求前 append 进 messages。
  let _agentSteerQueue = null;
  const _steerMsgs = new WeakSet(); // 标记已由插话路径入过 session，写回时跳过，避免重复
  // 2026-11-10: pc_shot 截图进模型上下文 —— 视觉模型在下一轮请求前以 user 图文消息注入。
  let _agentImageQueue = null;
  function pcVisionOn(modelId) {
    // 2026-11-25 F1：覆盖开关与视觉模型族判定归 services/chat/model-caps.ts（window.modelCaps）
    let raw = null;
    try { raw = localStorage.getItem("cfw_pc_vision_v1"); } catch (e) {}
    return window.modelCaps.pcVisionOn(raw, modelId);
  }

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
    try { if (window.agentConsoleSvc && window.agentConsoleSvc.cancelPending) window.agentConsoleSvc.cancelPending("已中断"); } catch (e) {}
    _tailGen++; // 4.19 P1: 取消所有 fire-and-forget tail (停止/重试/删除/鱼缸 stop 共用)
    // T4-A: 取消策略是纯函数（services/chat/turn-plan.ts）—— 停止保留半截、重试/删除丢弃并清流。
    const _cancel = (window.turnPlanSvc && window.turnPlanSvc.planCancel)
      ? window.turnPlanSvc.planCancel({ discardPartial: !!discardPartial })
      : { abort: true, discard: !!discardPartial, keepPartial: !discardPartial, clearPartialStream: !!discardPartial, clearPartialText: !!discardPartial, markDiscardFlag: !!discardPartial };
    const turn = activeTurn();
    if (turn) {
      turn.discard = _cancel.discard;
      turn.stopped = true;
      if (_cancel.clearPartialStream) turn.partialStream = null;
      if (_cancel.clearPartialText) turn.partialText = "";
      try { turn.controller.abort(); } catch {}
    }
    if (_cancel.clearPartialStream) partialStream = null;
    if (_cancel.markDiscardFlag) _discardPartialFlag = true;
    if (!turn && currentController) {
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

  // ── A07: 费用/计价模块实例（实现在 /js/text/data/cost-ledger.js）──
  //    注：todayStr/getDeviceId/sumCostDay/loadCostLog/saveCostLog/addCostToToday/getCostStats
  //    仍留本文件（main 的「全模式用量记账 + 按模型分桶」实现更新，合并时以 main 为准）。
  // 放 currentMode 之后：pricingContext 的兜底模式要读它；下面的转发供 costSvc/appSvc 与调用点使用。
  const _costLedger = window.__costLedger.create({ getMode: () => currentMode });
  const getCustomPricing = () => _costLedger.getCustomPricing();
  const canonicalEndpoint = (endpoint) => _costLedger.canonicalEndpoint(endpoint);
  const pricingKeysFor = (ctxOrModel) => _costLedger.pricingKeysFor(ctxOrModel);
  const getPricing = (ctxOrModel) => _costLedger.getPricing(ctxOrModel);
  const setCustomPricing = (keyOrModel, pricing, ctx) => _costLedger.setCustomPricing(keyOrModel, pricing, ctx);
  const calcCost = (modelOrCtx, promptTokens, completionTokens, cachedTokens = 0) =>
    _costLedger.calcCost(modelOrCtx, promptTokens, completionTokens, cachedTokens);
  const pricingContext = (mode, model, customProvider) => _costLedger.pricingContext(mode, model, customProvider);

  // ── A09: 渠道负载/错误体美化/失效模型自愈已迁到 /js/text/data/model-catalog.js（window.__modelCatalog）。

  // ── A07: 费用流水/日账单统计已迁到 /js/text/data/cost-ledger.js（window.__costLedger）。
  //    totalCostCNY 改为模块私有，app.js 通过 _costLedger.getTotal()/addTotal() 读写。

  // 2026-11-15: 日费用日志实现收进 services/cost/ledger.ts（原本地段与 ledger 旧版双实现并存,
  //    以 2026-11-12 全模式记账语义为准升级 ledger,本文件只留转发;getUsageStats 除外,
  //    它依赖 __usageStats,留在下面）。window.costSvc 门面成员与签名零变化。
  const todayStr = () => _costLedger.todayStr();
  const getDeviceId = () => _costLedger.getDeviceId();
  const sumCostDay = (e) => _costLedger.sumCostDay(e);
  const loadCostLog = () => _costLedger.loadCostLog();
  const saveCostLog = (log) => _costLedger.saveCostLog(log);
  const addCostToToday = (cost, promptTok, completionTok, model, opts) => _costLedger.addCostToToday(cost, promptTok, completionTok, model, opts);
  const getCostStats = () => _costLedger.getCostStats();
  // 用量统计（2026-11-12）：日/模型聚合交给纯函数模块，status-panel 只负责画。
  function getUsageStats() {
    try { return window.__usageStats ? window.__usageStats.build(loadCostLog()) : null; } catch (e) { return null; }
  }

  // ── A08: 顶栏费用显示实现已迁到 /shared/panel/topbar-cost.js（window.__topbarCost.refresh）。
  //    后置加载，所以这里保留惰性转发；调用点零改动。
  //    合并说明（2026-11-12）：main 侧原有一份内联实现（含图标态/免费模式占位），取分支的转发版本，
  //    同一件事只留一份代码；图标态逻辑已在 topbar-cost.js 内，合并后需真窗复核顶栏金额显示。
  const updateCostDisplay = () => {
    try { if (window.__topbarCost && window.__topbarCost.refresh) window.__topbarCost.refresh(); } catch (e) {}
  };

  // ── 2026-11-26: 自动压缩执行器（services/chat/compact.ts）──
  // 普通聊天与 agent 回合共用；配置/计划/摘要请求/落库/工具配对边界都在服务里，这里只给宿主
  // 闭包端口（会话开关、摘要镜像、费用行状态、DOM 行删除由每次调用快照传入）。
  let _compactPrevCostText = "";
  const _chatCompact = window.chatCompactSvc.create({
    context: _context,
    historyEnabled: () => historyEnabled,
    applySummary: (text) => { priorSummary = text; },
    renderChip: () => renderSummaryChip(),
    busy: (on) => {
      if (!costDisplayEl) return;
      if (on) {
        _compactPrevCostText = costDisplayEl.textContent;
        costDisplayEl.textContent = "正在压缩早期历史…"; // 4.71: 去掉 📚
      } else {
        costDisplayEl.textContent = _compactPrevCostText;
        _compactPrevCostText = "";
        updateCostDisplay();
      }
    },
  });

  // 暴露给 Settings UI（index.html load 处理器使用）
  window.costSvc = {
    loadCostLog,
    saveCostLog,
    getCostStats,
    getUsageStats,
    todayStr,
    sumCostDay,
    getDeviceId,
    refreshTopbar: updateCostDisplay,
  };

  // 开发者模式控制台 API
  // 2026-05-29: 加 NSFW 等级 / 开发者模式 控制台 API（严格角色扮演 API 已于 2026-10-05 随尺度层一起删除）
  // 控制台用法举例:
  //   devSvc.setNsfwLevel(n)           // 仅写本地偏好 cfw_nsfw_mode_v1(图像侧/主题联动用);
  //                                   // 2026-09-10 起正文尺度由 worker 锁态决定(payload.nsfwLevel 一律忽略),此 API 不再影响正文
  //   devSvc.setDevMode(true)           // 启用开发者模式 (解锁自定义情绪/阈值事件/互斥组)
  // 2026-10-05(A-3): 改为**合并**而非整体覆盖 —— 本文件后加载,原来的整体赋值会把
  // dev.js 先挂到 window.devSvc 上的 9 个方法(isOn/toggle/enable/disable/debug/log/
  // exportLS/setLastPayload/openPanel)全部挤掉,它们经 window.devSvc 变成不可达
  // (dev.js 面板内部走闭包不受影响,所以自检发现不了)。合并后两组 API 共存;
  // 消费方(tools.js/env-context/wechat-group)全部用的是本文件这组,行为零变化。
  window.devSvc = {
    ...(window.devSvc || {}),
    isJailbreakStripOn,
    setJailbreakStripOn(on) {
      // A01: LS key 归 /services/chat/text-format.js 统一管理，这里只转发（行为不变）。
      window.textFormatSvc.setJailbreakStripOn(on);
    },
    getReplyStyle() {
      return localStorage.getItem("cfw_reply_style_v1") || "default";
    },
    setReplyStyle(s) {
      const v = (s === "wechat" || s === "verbose") ? s : "default";
      localStorage.setItem("cfw_reply_style_v1", v);
    },
    getNsfwLevel() {
      return parseInt(localStorage.getItem("cfw_nsfw_mode_v1") || "0", 10) || 0;
    },
    setNsfwLevel(n) {
      const lv = Math.max(0, Math.min(3, parseInt(n, 10) || 0));
      localStorage.setItem("cfw_nsfw_mode_v1", String(lv));
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

