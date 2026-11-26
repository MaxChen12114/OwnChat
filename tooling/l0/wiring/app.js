/* l0-wiring-part: closes the shared IIFE; parsed as part of public/services/chat/app.js */
/**
 * tooling/l0/wiring/app.js — browser wiring host for services/chat/app.ts
 *
 * 2026-11-26 拆件：执行段在 tooling/l0/wiring/app/*.js（00-core / 10-turn / 20-ui / 30-agent /
 * 40-send / 50-relay / 60-input）；本文件只保留内存自愈、外部设置回读、init、会话数据入口
 * 与 window.appSvc 收口。片段由 tooling/l0/emit.mjs 按 WIRING_PARTS 顺序拼接，仍是同一个 IIFE。
 */
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
        if (hasAnyTurnRunning()) return;
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
    try { _thinkControl.updateThinkToggleUI(); } catch (e) {}
    // 顶栏按钮现在画的是模式（工作/角色扮演），外部改动后只需按当前模式重绘一次。
    try { _appMode.paint(); } catch (e) {}
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

  /**
   * Restore a whole message array (roleplay checkpoint). Refuses while a turn is live: replacing
   * the canonical array under a streaming turn would let its late write-back clobber the restore.
   *
   * T4-A: a rollback is an event, not only an array swap. The event log keeps the messages after the
   * restore point, and boot hydration reads that projection — so the restore also truncates the log
   * through `sessionEventsSvc` (one entry, `truncateToMessages`, boundary derived from the kept ids).
   * Async because the checkpoint flow awaits this; a caller that ignores the promise still gets the
   * synchronous array/UI swap first.
   */
  async function setSessionMessages(messages) {
    try {
      const plan = restoreSessionPlan(messages, hasActiveTurn(activeConvId()), _context.toRenderableMessages);
      if (!plan.ok) return false;
      const convId = activeConvId();
      const next = plan.messages;
      session = next;
      try { _memSlots[convId] = next.slice(); } catch (e) {}
      _messageList.renderSession(next);
      persistSessionIfEnabled();
      renderSummaryChip();
      updateSpacer();
      scrollToBottom();
      try {
        const svc = window.sessionEventsSvc;
        if (svc && typeof svc.truncateToMessages === "function") {
          // Boundary from the payload as captured (ids included), not from the renderable copy:
          // `toRenderableMessages` drops ids, and a replay-derived boundary would then miss the
          // projection. The keeper set decides what stays; the event log follows it.
          const res = await svc.truncateToMessages(convId, messages, "checkpoint");
          if (res && res.ok === false) {
            try { console.warn("[session] 回滚事件未写入真源（刷新后可能复现旧消息）", res.error); } catch (_e) {}
          }
        }
      } catch (e) {
        try { console.warn("[session] 回滚事件失败（刷新后可能复现旧消息）", e); } catch (_e) {}
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  /** Restore a prior summary into the current conversation (services/conv/summary.ts owns the table). */
  function setPriorSummary(text) {
    priorSummary = normalizePriorSummary(text);
    window.convSummarySvc.save(activeConvId(), priorSummary);
    try { renderSummaryChip(); } catch (e) {}
    return priorSummary;
  }

  // 暴露给 multi-agent.js / fishbowl-engine.js
  // 暴露 applyThinkDisplay 给 settings.js 切换显示模式时调用
  window.appSvc = { updateSpacer, sendOne, abortCurrent, injectModeratorMsg, continueGroupChat, showTyping, hideTyping, listConversations, switchConversation, createConversation, renameConversation, deleteConversation, getActiveConvId: activeConvId, hasActiveTurn, applyRemoteChat, handleRemoteConvDeleted, applyThinkDisplay, applyAllThinkDisplay: () => document.querySelectorAll(".reasoning-block").forEach(applyThinkDisplay), setCustomPricing, getCustomPricing, getPricing, pricingKeysFor, canonicalEndpoint,
    // 2026-09-14 UI第二轮:状态面板只读数据接口(会话消息引用/令牌估算/最近请求快照)
    estimateTokens, getSessionMessages: () => session, setSessionMessages, setPriorSummary, getLastRequestStats: () => lastReqStats,
    // T3-D: full arrays for every conversation (hot window + cold projection mirror). The
    // attachment GC walks this so images/documents referenced only by archived messages survive.
    getAllSessionMessages: () => loadAllSessions(),
    // 4.83: 附件 token 估算(状态面板「上传文档」行用,与实时统计同口径)
    attFileTokens,
    // 2026-09-14 附件重构:供 chat-ux.js 的「重试」按 DOM 行号取回原始消息(含附件元数据)
    getSessionMessageAt: (i) => (i >= 0 && i < session.length ? session[i] : null),
    // 2026-10-08 多智能体独立上下文：控制台/状态面板读「当前口径 + 计入条数」（隔离要可见，不然像 bug）
    getContextInfo: () => {
      try {
        const scope = currentScopeKey();
        const card = (window.characterSvc && window.characterSvc.getActiveCard) ? window.characterSvc.getActiveCard() : null;
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