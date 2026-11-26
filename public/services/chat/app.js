(function () {
/**
 * Host-shell decisions for the chat engine: restoring a session array, normalizing the prior
 * summary and the background-flush debounce.
 *
 * These are the three rules inside app.js that are not DOM and not transport: a restore must refuse
 * while a turn is live, the summary is always a string (null/undefined become ""), and the
 * visibility/pagehide flush is coalesced to one call per two seconds. The shell keeps the session
 * variable, the renderer, localStorage and the sync push. Prior-summary storage (per-conversation
 * table plus the legacy key) belongs to `services/conv/summary.ts`; this module only normalizes the
 * in-memory mirror.
 * @module services/chat/app
 */

/** @returns The summary as a string; null/undefined mean "no summary". */
function normalizePriorSummary(text         )         {
  return text == null ? "" : String(text);
}

/** The restore decision: a live turn or a non-array input means "refuse". */
                                
                          
                                                        

/**
 * Decide whether a checkpoint's message array may replace the live session.
 *
 * @param messages - Candidate array from the checkpoint.
 * @param activeTurn - Whether the active conversation has a turn in flight.
 * @param renderable - The context module's `toRenderableMessages`, applied to a copy.
 * @returns The refusal, or the renderable copy to install.
 */
function restoreSessionPlan(
  messages         ,
  activeTurn         ,
  renderable                                    ,
)                     {
  if (!Array.isArray(messages)) return { ok: false };
  if (activeTurn) return { ok: false };
  return { ok: true, messages: renderable(messages.slice()) };
}

/**
 * @param last - Timestamp of the previous flush (0 when never).
 * @param now - Current timestamp.
 * @param windowMs - Coalescing window; defaults to the 2s used by the pagehide flush.
 * @returns Whether this flush should run.
 */
function flushDue(last        , now        , windowMs         = 2000)          {
  return now - last >= windowMs;
}

/* l0-wiring-part: opens the shared IIFE; parsed as part of public/services/chat/app.js */
/**
 * tooling/l0/wiring/app/00-core.js — 聊天引擎外壳：DOM 引用、服务门面、会话/turn 初始状态。
 *
 * 2026-11-26 拆件：原 2786 行 app.js 按执行段拆成 7 个片段 + 宿主；片段按顺序拼接、
 * 共享同一个 IIFE 与词法状态。切点都在顶层空白行，不改变任何初始化顺序。
 */
// tooling/l0/wiring/app.js — browser wiring for services/chat/app.ts
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
  // 2026-11-12 清理: customPrompt/savePrompt/clearPrompt/historyKeep/clearHistory/promptKeep
  //   六个元素已由 settings.js 动态建卡并自己接线,这里加载期抓到的引用永远是 null(全文零引用),
  //   删掉避免后人以为还有一条老路径。
  const costDisplayEl = document.getElementById("costDisplay");   // 新增：费用显示

  // ── A01: 正文清洗模块门面（实现在 /services/chat/text-format.js（2026-11-14 B1 服务层），index.html 先于本文件加载）──
  // 必须放在文件顶部：下面 571 行的 window.devSvc 在**加载期**就抓 isJailbreakStripOn 的引用，
  // 若把转发留在原来的 1277 行位置，const 会处于 TDZ，启动直接 ReferenceError。
  // 用 const 箭头而非 function 声明，是为了让“旧实现已清零”的 grep 门禁可判（见夜班队列 A01）。
  const isJailbreakStripOn = () => window.textFormatSvc.isJailbreakStripOn();
  const stripJailbreakPrefix = (text) => window.textFormatSvc.stripJailbreakPrefix(text);
  const stripThinkBlocks = (text) => window.textFormatSvc.stripThinkBlocks(text);
  const stripPhotoSignalLive = (text) => window.textFormatSvc.stripPhotoSignalLive(text);
  const stripResidualMarkup = (text) => window.textFormatSvc.stripResidualMarkup(text);

  // ── A02: Markdown 渲染门面（实现在 /js/text/chat/markdown.js，index.html 先于本文件加载）──
  // 与 A01 同理放顶部：后续若有人在加载期抓引用，不会踩 const 的 TDZ。
  const renderMarkdownSafe = (text) => window.__markdown.safe(text);
  // rich/legacy 两个入口只有 markdown.js 内部用（safe 里做降级），app.js 从不直接调，已删。

  // ── A03: 思考提取/折叠/存档门面（实现在 /services/chat/reasoning.js（2026-11-14 B1 服务层），先于本文件加载）──
  // 必须放顶部：appSvc（加载期）抓 applyThinkDisplay；其余函数虽只在调用期用，统一放顶部避免后续加载期引用踩 TDZ。
  const getThinkDisplay = () => window.__reasoning.getThinkDisplay();
  const applyThinkDisplay = (reasoningEl) => window.__reasoning.applyThinkDisplay(reasoningEl);
  const extractThinkText = (text) => window.__reasoning.extractThinkText(text);
  const buildReasoningArchive = (nativeReasoning, inlineThink, jailbreakThink) =>
    window.__reasoning.buildReasoningArchive(nativeReasoning, inlineThink, jailbreakThink);
  // effort 方言思考字段（reasoning_content / reasoning）的单一判定，sendOne 与 sendOneAgent 共用。
  const reasoningDelta = (delta) => window.__reasoning.reasoningDelta(delta);

  // ── A14: 作用域/发言者视图/协议清洗门面（实现在 /js/text/chat/context.js，index.html 先于本文件加载）──
  // 放顶部与 A01–A03 同理：这些函数在加载期就会被 appSvc 等对象抓引用，留在原位置会踩 const 的 TDZ。
  const _context = window.__context.create({ getActiveConvId: () => activeConvId(), getSession: () => session });
  const currentScopeKey = () => _context.currentScopeKey();
  const scopeTag = (obj) => _context.scopeTag(obj);
  const scopeLabel = (sc) => _context.scopeLabel(sc);
  const selectSpeakerView = (msgs, opts) => _context.selectSpeakerView(msgs, opts);
  const sanitizeToolProtocol = (msgs, opts) => _context.sanitizeToolProtocol(msgs, opts);

  // ── A26: conversation lifecycle engine (implementation in /services/conv/lifecycle.ts, loaded
  // before this file). Switch / create / rename / delete / remote apply, the memory-slot cache and
  // the render hand-off live in the engine. This file keeps: canonical `session` ownership, the
  // active-turn UI mirror (syncActiveTurnGlobals) and turn teardown (discardTurn).
  const _convLifecycle = window.__convLifecycle.create({
    // Canonical session array stays owned here; the engine reads and replaces it via these two.
    getSession: () => session,
    setSession: (v) => { session = v; },
    historyEnabled: () => historyEnabled,
    deviceId: () => getDeviceId(),
    activeConvId: () => activeConvId(),
    setActiveConvId: (id) => setActiveConvId(id),
    isConvId: (id) => isConvId(id),
    newConvId: () => newConvId(),
    ensureDefaultConv: () => ensureDefaultConv(),
    loadActiveConvRaw: () => loadActiveConvRaw(),
    currentSlotKey: () => currentSlotKey(),
    touchConv: (convId, patch) => touchConv(convId, patch),
    activeCardId: () => activeCardId(),
    loadConvMeta: () => loadConvMeta(),
    saveConvMeta: (m) => saveConvMeta(m),
    loadAllSessions: () => loadAllSessions(),
    // T3-D: the blob write goes through the session store so the in-memory full-array mirror stays
    // in step and only the hot window is serialised. LS_CHAT_SESSION is still the same key.
    writeSessionBlob: (json) => { _sessionStore.writeSessionBlob(json); },
    removeSessionBlob: () => { _sessionStore.removeSessionBlob(); },
    writeChatTombstone: (k) => writeChatTombstone(k),
    bumpSlotMeta: (k) => bumpSlotMeta(k),
    buildConversationList: (input) => _convStore.buildConversationList(input),
    recordConv: (convId, patch, kind) => {
      try { if (window.chatRealtimeSvc && typeof window.chatRealtimeSvc.recordConv === "function") window.chatRealtimeSvc.recordConv(convId, patch, kind); } catch (e) {}
    },
    ensureMessageIds: (arr, convId) => {
      try { return (window.__chatEvents && window.__chatEvents.ensureMessageIds) ? window.__chatEvents.ensureMessageIds(arr, convId, getDeviceId()) : arr; } catch (e) { return arr; }
    },
    listAllCards: () => {
      try { return (window.characterSvc && window.characterSvc.listAllCards) ? (window.characterSvc.listAllCards() || []) : []; } catch (e) { return []; }
    },
    agentWorkspaceRemove: (convId) => {
      try { if (window.__agentWorkspace && window.__agentWorkspace.removeByConv) window.__agentWorkspace.removeByConv(convId); } catch (e) {}
    },
    getTurn: (id) => _turns.get(id),
    // Turn teardown stays engine-side: abort, mark dead, drop the poll row (deleteConversation calls it).
    discardTurn: (convId) => {
      const t = _turns.get(convId);
      if (!t) return;
      t.deleted = true;
      t.discard = true;
      t.running = false;
      try { t.controller.abort(); } catch (e) {}
      _turns.remove(convId);
      if (t.uiTimer) { try { clearInterval(t.uiTimer); } catch (e) {} t.uiTimer = null; }
      t.uiRow = null;
    },
    hasActiveTurn: (id) => _turns.hasActive(id),
    isConvSending: (id) => _turns.isSending(id),
    syncActiveTurnGlobals: () => syncActiveTurnGlobals(),
    toRenderableMessages: (arr) => _context.toRenderableMessages(arr),
    renderSession: (arr) => _messageList.renderSession(arr),
    clearUIRows: () => clearUIRows(),
    clearPendingAttachments: () => clearPendingAttachments(),
    clearChoiceChips: () => clearChoiceChips(),
    applyConvChar: (id) => applyConvChar(id),
    appModeApplyConv: (id) => _appMode.applyConv(id),
    renderSummaryChip: () => renderSummaryChip(),
    // Summary is per conversation (services/conv/summary.ts): restore on switch, drop on delete.
    restoreSummary: (id) => { priorSummary = window.convSummarySvc.load(id); },
    removeSummary: (id) => { window.convSummarySvc.remove(id); },
    // T3-D cold cascade: events truth + messages projection + the summaries row for this conv.
    removeColdSession: (id) => {
      try { if (window.sessionEventsSvc && typeof window.sessionEventsSvc.removeConv === "function") window.sessionEventsSvc.removeConv(id); } catch (e) {}
    },
    updateSpacer: () => updateSpacer(),
    scrollToBottom: () => scrollToBottom(),
    navHideReset: () => { if (window.__navHideReset) window.__navHideReset(); },
    makeRow: (role) => makeRow(role),
    setStreamingUI: (rowEl, streaming) => setStreamingUI(rowEl, streaming),
    agentStepsAvailable: () => !!(window.__agentSteps && window.__agentSteps.mountLive && window.__agentSteps.replay),
    agentStepsMountLive: (bubble) => window.__agentSteps.mountLive(bubble),
    agentStepsReplay: (ui, rounds) => window.__agentSteps.replay(ui, rounds),
    cleanPartialText: (txt) => stripResidualMarkup(stripJailbreakPrefix(stripThinkBlocks(txt))),
    getThinkDisplay: () => getThinkDisplay(),
    setTimer: (fn, ms) => setInterval(fn, ms),
    clearTimer: (id) => clearInterval(id),
  });
  // The engine owns the memory-slot cache; session-store / conv-store below read this same object.
  const _memSlots = _convLifecycle.memSlots;
  const applyRemoteChat = (convId) => _convLifecycle.applyRemoteChat(convId);
  const handleRemoteConvDeleted = (convId) => _convLifecycle.handleRemoteConvDeleted(convId);
  const restoreSessionIfEnabled = () => _convLifecycle.restoreSessionIfEnabled();
  const listConversations = () => _convLifecycle.listConversations();
  const switchConversation = (convId) => _convLifecycle.switchConversation(convId);
  const createConversation = (name) => _convLifecycle.createConversation(name);
  const renameConversation = (convId, name) => _convLifecycle.renameConversation(convId, name);
  const deleteConversation = (convId) => _convLifecycle.deleteConversation(convId);

  // ── A22: 会话消息持久化门面（实现在 /js/text/data/session-store.js）──
  // 存储层（cfw_chat_session_v1 / slot meta / 删除墓碑 / 2MB 裁剪）迁出；渲染还原仍在本文件（A22b）。
  // T3-D 起 localStorage 只写热窗口（最近 10 条），更早的消息由 session_events 的投影在启动时
  // 水合进内存镜像；同步 API 不变，读到的仍是完整会话。
  const _sessionStore = window.__sessionStore.create({
    getDeviceId: () => getDeviceId(),
    getHistoryEnabled: () => historyEnabled,
    getMemSlots: () => _memSlots,
    getSession: () => session,
    currentSlotKey: () => currentSlotKey(),
    touchConv: (convId, patch) => touchConv(convId, patch),
    isConvId: (id) => isConvId(id),
    getConvMeta: () => loadConvMeta(),
    saveConvMeta: (m) => saveConvMeta(m),
    ensureMessageIds: (arr, convId, dev) => {
      try { return (window.__chatEvents && window.__chatEvents.ensureMessageIds) ? window.__chatEvents.ensureMessageIds(arr, convId, dev) : arr; } catch (e) { return arr; }
    },
    getChatSlotMeta: () => { try { return (window.syncSvc && window.syncSvc.getChatSlotMeta) ? window.syncSvc.getChatSlotMeta() : {}; } catch (e) { return {}; } },
    recordLocal: (convId, prev, next) => { try { if (window.chatRealtimeSvc && window.chatRealtimeSvc.recordLocal) window.chatRealtimeSvc.recordLocal(convId, prev, next); } catch (e) {} },
    // Cold projection + archive writer. Late lookup: dbSvc resolves its adapter on first use.
    cold: () => {
      try {
        var svc = window.sessionEventsSvc;
        return svc && typeof svc.coldPort === "function" ? svc.coldPort() : null;
      } catch (e) { return null; }
    },
    // Boot hydration merged the cold prefix: repaint the conversation on screen unless a live turn
    // owns the array (a background turn keeps streaming into its own snapshot).
    onHydrated: (convId) => {
      try {
        if (convId === activeConvId() && !hasActiveTurn(convId) && historyEnabled) restoreSessionIfEnabled();
      } catch (e) {}
    },
    warn: (message, error) => { try { console.warn(message, error); } catch (e) {} },
  });
  const LS_CHAT_SESSION = _sessionStore.LS_CHAT_SESSION;
  // T4-A: the instance, not the factory. The sync/realtime channels apply a whole remote map through
  // it so the mirror and the hot window move together; the factory global (`window.__sessionStore`)
  // cannot answer that — its promise is only a `create` function.
  window.sessionStoreSvc = _sessionStore;
  const loadAllSessions = () => _sessionStore.loadAllSessions();
  const saveAllSessions = (all) => _sessionStore.saveAllSessions(all);
  const bumpSlotMeta = (k) => _sessionStore.bumpSlotMeta(k);
  const writeChatTombstone = (k) => _sessionStore.writeChatTombstone(k);
  const purgeLegacyConvs = () => _sessionStore.purgeLegacyConvs();
  const persistSessionForConv = (convId, arr) => _sessionStore.persistSessionForConv(convId, arr);
  const persistSessionIfEnabled = () => _sessionStore.persistSessionIfEnabled();
  // One-shot legacy blob → events, then the cold projection into the mirror. Deferred one microtask
  // so the boot fragment finishes its own init (purge/dedupe/restore) first; migration then reads
  // the final storage state and cannot race the hot-window writer. The page boots on the hot window
  // and repaints through onHydrated when the merge lands.
  try {
    Promise.resolve().then(function () { return _sessionStore.boot(); }).catch(function (e) {
      try { console.warn("[session] 启动水合失败（热窗口仍可用）", e); } catch (_e) {}
    });
  } catch (e) {}
  // The summaries table is the persistent copy; a fresh device or cleared storage recovers here.
  // When rows merged, refresh the synchronous mirror the send path reads for the active conv.
  try {
    if (window.convSummarySvc && typeof window.convSummarySvc.hydrate === "function") {
      Promise.resolve(window.convSummarySvc.hydrate()).then(function (res) {
        try {
          if (res && res.merged) {
            priorSummary = window.convSummarySvc.load(activeConvId());
            renderSummaryChip();
          }
        } catch (e) {}
      }).catch(function () {});
    }
  } catch (e) {}

  // ── A23: 会话注册表 / 当前会话语义门面（实现在 /js/text/data/conv-store.js）──
  // 宿主注入的六条能力都在本文件：设备 id、会话 blob 读写、_memSlots、删除墓碑、角色卡、实时 meta 事件。
  const _convStore = window.__convStore.create({
    getDeviceId: () => getDeviceId(),
    getAllSessions: () => loadAllSessions(),
    // Route through the session store: a full array updates the mirror and only the hot tail is
    // written (T3-D). A direct localStorage write here would silently defeat the hot window.
    saveAllSessions: (all) => { _sessionStore.saveAllSessions(all); },
    getMemSlots: () => _memSlots,
    writeChatTombstone: (k) => writeChatTombstone(k),
    getActiveCard: () => ((window.characterSvc && window.characterSvc.getActiveCard) ? window.characterSvc.getActiveCard() : null),
    setActiveCardId: (id) => { try { if (window.characterSvc && window.characterSvc.setActiveId) window.characterSvc.setActiveId(id); } catch (e) {} },
    toast: (m, ms) => { try { toastMsg(m, ms); } catch (e) {} },
    recordMeta: (convId, patch, kind) => { try { if (window.chatRealtimeSvc && window.chatRealtimeSvc.recordConv) window.chatRealtimeSvc.recordConv(convId, patch, kind); } catch (e) {} },
  });
  const newConvId = () => _convStore.newConvId();
  const isConvId = (id) => _convStore.isConvId(id);
  const loadActiveConvRaw = () => _convStore.loadActiveConvRaw();
  const setActiveConvId = (id) => _convStore.setActiveConvId(id);
  const loadConvMeta = () => _convStore.loadConvMeta();
  const saveConvMeta = (m) => _convStore.saveConvMeta(m);
  const touchConv = (convId, patch) => _convStore.touchConv(convId, patch);
  const setConvCharId = (convId, charId) => _convStore.setConvCharId(convId, charId);
  const ensureDefaultConv = () => _convStore.ensureDefaultConv();
  const dedupeDefaultConvs = () => _convStore.dedupeDefaultConvs();
  const activeConvId = () => _convStore.activeConvId();
  const currentSlotKey = () => _convStore.currentSlotKey();
  const applyConvChar = (convId) => _convStore.applyConvChar(convId);
  const activeCardId = () => _convStore.activeCardId();

  // ── A21: 手机壳门面（实现在 /js/text/ui/mobile-shell.js）──
  const _mobileShell = window.__mobileShell.create({ getHistory: () => historyWrap });
  const setupScrollHide = () => _mobileShell.setupScrollHide();
  const setupTopbarOverflow = () => _mobileShell.setupTopbarOverflow();

  // ── A20（已并入 A18）: @ 召唤补全由 composer 实例承担，不再单独建模块 ──
  // ── A19: 真实节奏门面（实现在 /js/text/ui/pacing.js）──
  // 会话写入/发送/接力/输入框清理都留在本文件，经 host 注入；模块只负责「什么时候回复、回复谁」。
  const _pacingCtl = window.__pacing.create({
    getInput: () => inputEl,
    attCount: () => attCount(),
    pushUser: (text) => pushUserMessageOnly(text),
    afterQueue: () => { inputEl.value = ""; inputEl.style.height = "auto"; updateSpacer(); scrollToBottom(); },
    isGroupChatActive: () => isGroupChatActive(),
    parseAtMentions: (text) => parseAtMentions(text),
    getActiveCard: () => ((window.characterSvc && window.characterSvc.getActiveCard) ? window.characterSvc.getActiveCard() : null),
    isConvBusy: (convId) => isConvSending(convId),
    activeConvId: () => activeConvId(),
    sendOne: (opts) => sendOne(opts),
    runAutoRelay: (reply, speaker) => runAutoRelay(reply, speaker),
    getChat: () => chatEl,
    getSpacer: () => spacerEl,
    isNearBottom: () => isNearBottom(),
    scrollToBottom: () => scrollToBottom(),
  });
  const pacingEnabled = () => _pacingCtl.pacingEnabled();
  const pacingBaseDelay = () => _pacingCtl.pacingBaseDelay();
  const groupOnlineMode = () => _pacingCtl.groupOnlineMode();
  const showTyping = (label) => _pacingCtl.showTyping(label);
  const hideTyping = () => _pacingCtl.hideTyping();
  const queueSend = () => _pacingCtl.queueSend();
  const fireReply = (targets) => _pacingCtl.fireReply(targets);

  // ── A18: 输入框/发送键/键盘联动门面（实现在 /js/text/ui/composer.js）──
  // 必须放顶部：window.__updateSendBtnState 在加载期就赋值，晚放会踩 const 的 TDZ。
  const _composerCtl = window.__composer.create({
    getInput: () => inputEl,
    getComposer: () => composerEl,
    getSendBtn: () => sendBtn,
    sendIconHtml: SEND_BTN_ICON_HTML,
    stopIconHtml: STOP_BTN_ICON_HTML,
    isAgentRunning: () => {
      const t = activeTurn();
      return !!(t && t.kind === "agent" && t.running && !t.stopping);
    },
    onLayoutChange: () => {
      const stick = isNearBottom();
      updateSpacer();
      if (stick) scrollToBottom();
    },
    isGroupChatActive: () => isGroupChatActive(),
    getSceneCards: () => { try { return (window.multiSvc && window.multiSvc.getSceneCards) ? window.multiSvc.getSceneCards() : []; } catch (e) { return []; } },
  });
  const updateSendBtnState = () => _composerCtl.updateSendBtnState();

  // ── A17: 消息行/滚动/底部留白门面（实现在 /js/text/ui/message-list.js）──
  // _realScrollToBottom 保留原语义：sendOne 内部会用同名局部函数遮蔽它（后台 turn 不抢当前会话滚动）。
  const _messageList = window.__messageList.create({
    getComposer: () => composerEl,
    getSpacer: () => spacerEl,
    getHistory: () => historyWrap,
    getChat: () => chatEl,
    // A22b(2): 还原历史行要用到的六个能力 + token 累计器（全部是别的模块的门面，这里只转手）
    renderMarkdown: (t) => renderMarkdownSafe(t),
    renderAttachments: (bubble, att) => renderAttachmentsInto(bubble, att),
    applyUserFold: (bubble) => applyUserFold(bubble),
    estimateTokens: (t) => estimateTokens(t),
    attFileTokens: (att) => attFileTokens(att),
    applyThinkDisplay: (el) => applyThinkDisplay(el),
    resetTotals: () => { totalInEstimate = 0; totalOutEstimate = 0; },
    addInEstimate: (n) => (totalInEstimate += n),
    addOutEstimate: (n) => (totalOutEstimate += n),
  });
  const updateSpacer = () => _messageList.updateSpacer();
  const isNearBottom = () => _messageList.isNearBottom();
  const scrollToBottom = () => _messageList.scrollToBottom();
  const _realScrollToBottom = () => _messageList.scrollToBottom();
  const makeRow = (role, opts) => _messageList.makeRow(role, opts);
  const clearUIRows = () => _messageList.clearUIRows();

  // ── A16: token 估算门面（实现在 /js/text/chat/context.js，与 A14 同一个模块）──
  // 压缩水位/会话 token 判定已随刀3并入 context 服务，由 _context.shouldCompact 内部直接读取。
  const estimateTokens = (text) => _context.estimateTokens(text);

  // ── A15: 附件取用/元信息/token/展开/渲染/折叠门面（实现扩在 /js/text/ui/attachments.js 的 attachSvc）──
  // 与 A01–A03 同理放顶部；失败一律软降级到「没有附件」的旧行为，绝不让附件层异常打断发送链路。
  const takeAttachments = () => {
    try { return window.attachSvc.takePending(); } catch (_) { return { files: undefined, images: undefined, _memImages: [] }; }
  };
  const attCount = () => { try { return window.attachSvc.count(); } catch (_) { return 0; } };
  const clearPendingAttachments = () => { try { window.attachSvc.clear(); } catch (_) {} };
  const attHasAny = (att) => { try { return window.attachSvc.attHasAny(att); } catch (_) { return !!(att && ((att.files && att.files.length) || (att.images && att.images.length))); } };
  const attMeta = (att) => { try { return window.attachSvc.attMeta(att); } catch (_) { return {}; } };
  const attMaxChars = () => { try { return window.attachSvc.attMaxChars(); } catch (_) { return 100000; } };
  const attFileTokens = (att) => { try { return window.attachSvc.attFileTokens(att, estimateTokens); } catch (_) { return 0; } };
  const renderAttachmentsInto = (bubble, att) => { try { window.attachSvc.renderAttachmentsInto(bubble, att); } catch (_) {} };
  const applyUserFold = (bubble) => { try { window.attachSvc.applyUserFold(bubble); } catch (_) {} };
  const expandAttachmentMessages = (msgs) => window.attachSvc.expandAttachmentMessages(msgs);

  // ── 顶栏图标集中表(2026-06-07 UI 重构:emoji→线性 SVG,currentColor 随主题;换图标只改这一处) ──
  const ICONS = {
    modeFree: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6"/></svg>',
    modeFast: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 3 14h9l-1 8 10-12h-9z"/></svg>',
    personaBuiltin: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4.5h16v6.5a8 8 0 0 1-16 0z"/><path d="M9 8.5v.01M15 8.5v.01"/><path d="M9.2 12.6c.9.8 4.7.8 5.6 0"/></svg>',
    personaCustom: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20l4-1 9.6-9.6a2 2 0 0 0-2.8-2.8L5.4 16z"/><path d="M13.5 6.3l4.2 4.2"/></svg>',
    // 2026-11-14 顶栏一级模式（原 personaBuiltin/personaCustom 的按钮位置）：
    // 工作 = 三根滑杆（交付/参数面）；角色扮演 = 面具（角色层）
    modeWork: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h7M15 17h5"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="13" cy="17" r="2"/></svg>',
    modeRp: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6.5h16v7a6.5 6.5 0 0 1-6.5 6.5h-3A6.5 6.5 0 0 1 4 13.5z"/><path d="M9 10.5h.01M15 10.5h.01"/><path d="M9.5 14.2c1 .9 4 .9 5 0"/></svg>',
  };
  // setIcon(el, 图标名, 可选文字标签):带 label 时附 .btn-text(供 CSS 在手机端隐藏、只留图标)
  function setIcon(el, name, label) {
    if (!el) return;
    const svg = ICONS[name] || "";
    el.innerHTML = label ? svg + '<span class="btn-text">' + label + '</span>' : svg;
  }

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

// 20-ui.js — 外部工具函数、模型下拉、历史 UI、输入区尺寸与氛围标签门面。
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
  // ── A18: 发送键形态（updateSendBtnState）已迁到 /js/text/ui/composer.js（window.__composer）。
  //    同名转发在文件顶部；这里只保留调试入口的赋值。
  window.__updateSendBtnState = updateSendBtnState; // 调试/桩测入口
  window.__resetSending = function () {
    const _t = activeTurn();
    if (_t) {
      _t.stopping = true;
      // 立即释放本会话发送锁：重试/删除会紧接着起新一轮，不能等旧 fetch 的 catch 跑完
      _t.running = false;
      if (_t.uiTimer) { try { clearInterval(_t.uiTimer); } catch (e) {} _t.uiTimer = null; }
      _t.uiRow = null;
    }
    syncActiveTurnGlobals();
    isSending = false;
    sendBtn.disabled = false;
    // 还原小飞机图标(原 textContent="Send" 会把 SVG 抹成英文字"Send")
    sendBtn.classList.remove("is-stop");
    if (SEND_BTN_ICON_HTML) sendBtn.innerHTML = SEND_BTN_ICON_HTML; else sendBtn.textContent = "发送";
    updateSendBtnState();
    notifyConvTurns();
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
    try { if (window.agentConsoleSvc && window.agentConsoleSvc.cancelPending) window.agentConsoleSvc.cancelPending("已中断"); } catch (e) {}
    abortCurrent();
    window.__resetSending();
  };

  // 2026-11-10: pc_shot 把截图交给模型（仅视觉模型；内核 beforeStep 在下一轮请求前注入）。
  window.__agentPushImage = function (dataUrl, meta, ctx) {
    // 2026-11-11 会话并行：工具带 ctx.__turn 时进该 turn 自己的视觉队列；
    // 没带（旧调用）才用当前活跃 turn 的全局队列。
    var _q = (ctx && ctx.__turn && ctx.__turn.imageQueue) || _agentImageQueue;
    if (!_q || !dataUrl) return false;
    if (_q.length >= 6) _q.shift(); // 同轮最多带 6 张，超出丢最旧（视觉上下文护栏）
    _q.push({ dataUrl: String(dataUrl), meta: meta || {} });
    return true;
  };

  const LS_MODEL      = "cfw_model";

  // ── A09: 模型目录/占位/自动拉取/错误自愈已迁到 /js/text/data/model-catalog.js（window.__modelCatalog）。
  //    实例放 LS_MODEL 之后：autoFetch 要写 cfw_model；initModels/toastMsg 是函数声明，已提升。
  const _modelCatalog = window.__modelCatalog.create({
    getMode: () => currentMode,
    refreshModels: () => initModels(),
    toast: (msg, ms) => toastMsg(msg, ms),
    lsModelKey: LS_MODEL,
  });
  const isPlaceholderModel = (id) => _modelCatalog.isPlaceholderModel(id);
  const getRuntimeModels = (mode) => _modelCatalog.getRuntimeModels(mode);
  const runtimeDefaultModel = (mode, models) => _modelCatalog.runtimeDefaultModel(mode, models);
  const autoFetchModelsForMode = (mode) => _modelCatalog.autoFetchModelsForMode(mode);
  const ensureUsableModelBeforeSend = (mode, model, customProvider) => _modelCatalog.ensureUsableModelBeforeSend(mode, model, customProvider);
  const activeProviderIdPayload = () => _modelCatalog.activeProviderIdPayload();
  const formatChatErrorBody = (t) => _modelCatalog.formatChatErrorBody(t);
  const looksLikeInvalidModel = (status, text) => _modelCatalog.looksLikeInvalidModel(status, text);
  const attachModelReselectButton = (aiRow) => _modelCatalog.attachModelReselectButton(aiRow);
  const LS_USE_BUILTIN     = "cfw_use_builtin";
  const LS_HISTORY_ENABLED = "cfw_history_enabled";
  // LS_CHAT_SESSION 由 A22 收进 session-store.js，顶部有门面常量。
  const LS_PROMPT_ENABLED  = "cfw_prompt_enabled";
  const LS_CUSTOM_PROMPT   = "cfw_custom_prompt_v1";
  // 阶段 4-③：压缩参数（启用 / 触发条数 / 保留条数 / 水位比例）的唯一真源在
  // services/chat/context.ts 的 compactConfig()；摘要本身按会话隔离，读写归 services/conv/summary.ts。
  // 旧全局键在这里一次性迁入当前会话（迁移失败由服务留痕，不在这里吞掉）。
  try { window.convSummarySvc.migrate(activeConvId()); } catch (e) { console.warn("summary legacy migration failed:", e); }
  let priorSummary = window.convSummarySvc.load(activeConvId());
  // Phase 4 阶段 6：提示词预设库（5 starter + 用户自建，每项 { id, name, content, enabled, order }）
  const LS_PROMPT_PRESETS  = window.systemPromptsSvc.PROMPT_PRESETS_KEY;
  // Phase 4 阶段 7：费用日志已迁到 cost-ledger.js（LS key 由模块持有）

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
    const isLight = (window.themeSvc && typeof window.themeSvc.is === "function") ? window.themeSvc.is("light") : (localStorage.getItem("my-theme") === "light"); // 4.79 #12: 改读有效明暗(显式选择||主题原生),修 glass/少女 原生浅色下直读 my-theme=null 误判为暗导致 UI 不可读
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

  // ── 2026-10-09 顶栏「基座」按钮两种语义 ──
  //    2026-11-14：顶栏该按钮已改为「工作 / 角色扮演」（见下方 _appMode），
  //    BASE_SWITCH_MODE 在本文件不再有消费点，故删掉这个加载期常量；
  //    prompt-profile.js 自己仍按 window.__baseSwitchMode 决定是否启用「自定义目录」下拉，互不影响。
  function toastMsg(msg, ms) {
    try { if (window.feedbackSvc && typeof window.feedbackSvc.toast === "function") window.feedbackSvc.toast(msg, ms || 2000); } catch (e) {}
  }

  // ── A12: 基座/中性/状态层/角色能力/生成参数/联网 已迁到 /services/data/prompt-profile.js（window.__promptProfile；
  //    2026-11-14 深夜 data 域服务层化，源=services/data/prompt-profile.ts，create(host) 契约不变）。
  //    实例放 useBuiltin 之后（483），host 注入 isUseBuiltin + setIcon。
  //    2026-11-14：原来这里紧跟一行 _promptProfile.paintPersonaButton() 做加载期首绘 ——
  //    #personaToggle 已改为模式按钮，那行会把它画成「内置/自定义」，故撤掉（首绘由 _appMode 自己 paint）。
  const _promptProfile = window.__promptProfile.create({
    isUseBuiltin: () => useBuiltin,
    setIcon: (el, name, label) => setIcon(el, name, label),
  });

  // ── 2026-11-14 顶栏「工作 / 角色扮演」一级模式（实现在 /js/text/ui/app-mode.js）──
  //    这个位置原来是「内置 / 自定义基座」按钮：语义只有一小撮公开渠道构建用得上，
  //    且与 unlock.js 的私人解锁在用户认知里长期混淆。现在按钮改为意图轴，
  //    基座目录切换降级到 设置 → 对话 → 「基座目录」卡（见 settings.js 的 mountBaseRegistryCard）。
  //    下游只拨三处：promptProfile（rp ↔ assist，worker 已支持）、stateLayer、replyStyle/生成参数。
  //    Agent 工作 loop 属驱动权轴（cfw_agent_mode_v1），刻意不在这里强绑。
  const _appMode = window.__appMode.create({
    storage: {
      getItem: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
      setItem: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} },
    },
    activeConvId: () => activeConvId(),
    touchConv: (id, patch) => touchConv(id, patch),
    loadConvMeta: () => loadConvMeta(),
    setIcon: (el, name, label) => setIcon(el, name, label),
    emit: () => { try { window.dispatchEvent(new CustomEvent("cfw:app-mode-changed")); } catch (e) {} },
    button: () => personaToggle,
  });

  // A12 保留：这些是与 Prompt Profile 无关的 app.js 状态，迁移时不能跟着走。
  let historyEnabled = (localStorage.getItem(LS_HISTORY_ENABLED) ?? "1") === "1";
  let promptEnabled  = (localStorage.getItem(LS_PROMPT_ENABLED)  ?? "1") === "1";
  // Bug1 fix: historyKeep/promptKeep 由 settings.js mountLocalHistoryCard() 动态挂载，IIFE 执行时尚不存在。
  // 2026-11-12: 原来这里用加载期抓到的引用做「有就赋值」，那两个引用恒为 null（元素还没建），
  // 等于两行空操作。赋值与事件绑定本来就在 wireHistoryUI()/设置卡挂载时按 id 现取，这里直接删。

  // ─── 思考模式 toggle（4.82 起免费档同样可开,参数由 worker 按 provider 方言下发）───
  const LS_THINKING = "cfw_thinking";
  let thinkingOn = (localStorage.getItem(LS_THINKING) ?? "0") === "1";

  // ── A03: 思考提取/折叠/存档已迁到 /services/chat/reasoning.js（window.__reasoning）。
  //    同名转发在文件顶部；#thinkToggle 与档位控制已由 A05 迁到 ui/think-control.js。

  // ── A05: 思考档位控制已迁到 /js/text/ui/think-control.js（window.__thinkControl）。
  //    宿主注入 currentMode / modelSel.value / thinkingOn / LS_THINKING；下面的转发保持调用点零改动。
  const _thinkControl = window.__thinkControl.create({
    getMode: () => currentMode,
    getModel: () => (modelSel && modelSel.value) || "",
    isThinkingOn: () => thinkingOn,
    setThinkingOn: (on) => { thinkingOn = !!on; },
    lsThinkingKey: LS_THINKING,
  });
  _thinkControl.bind();
  // A06: 思考接线已收口到 _thinkControl（无本地转发）；payload / UI 直接调模块实例。

  // ── A10: 渠道信息/模式切换已迁到 /services/ui/channel-mode.js（window.__channelMode）。
  //    实例注入 currentMode 读写 / LS_MODE / setIcon / initModels / updateCostDisplay / think UI。
  const _channelMode = window.__channelMode.create({
    getMode: () => currentMode,
    setMode: (mode) => { currentMode = mode; },
    lsModeKey: LS_MODE,
    setIcon: (el, name, label) => setIcon(el, name, label),
    refreshModels: () => initModels(),
    refreshCost: () => updateCostDisplay(),
    refreshThink: () => _thinkControl.updateThinkToggleUI(),
  });
  const applyMode = (mode) => _channelMode.applyMode(mode);

  _channelMode.bind();

  // 输入框文字颜色交由 styles.css 主题系统接管（minimal: #fff / glass: #1a1f2e）
  // 旧版读已废弃的 my-theme LS key 并 inline 写码，造成 glass 主题下白底上白字不可见

  // ── A01: 正文清洗已迁到 /services/chat/text-format.js（window.textFormatSvc）。
  //    同名转发在文件顶部；pipelineSvc 已由 A04 收口到 chat/pipeline.js。

  // ── A04: 清洗管线探针已由 /js/text/chat/pipeline.js 提供（window.pipelineSvc）。

  // ── A02: Markdown 渲染已迁到 /js/text/chat/markdown.js（window.__markdown）。
  //    同名转发在文件顶部；附件辅助（takeAttachments 等）已由 A15 并入 attachments.js。

  // ── A15: 附件取用/元信息/token 已扩到 /js/text/ui/attachments.js（window.attachSvc）。
  //    同名转发在文件顶部；FENCE/取用/元信息/attMaxChars/attFileTokens 的旧实现已清零。

  // ── A14: 作用域 / 发言者视图 / 协议清洗已迁到 /js/text/chat/context.js（window.__context）。
  //    同名转发在文件顶部；本区块原有 116 行实现（含 2026-10-08 多角色独立上下文的注释）已清零，
  //    设计说明随实现一起迁到模块文件头。


  // ── A15: 附件渲染（renderAttachmentsInto）已扩到 attachments.js（同 3 行转发在文件顶部）。

  // remote-desk：把 PC 截图作为 UI-only 图片消息落进当前会话（不进模型请求）
  // 图片 Blob 由 attachSvc.putBlob 存 IndexedDB（cfw_chat_images），消息里只留 {id,name,w,h}。
  window.__pcAppendImage = function (meta, ctx) {
    try {
      if (!meta || !meta.id) return false;
      // 2026-11-11 会话并行：后台 agent 的截图必须进它自己的会话，不能插到当前活跃会话
      var _turn = (ctx && ctx.__turn) || null;
      if (_turn && !turnIsCurrent(_turn)) return false; // 已被重试/删除替换的旧轮次，别再写回
      var _arr = _turn ? _turn.session : session;
      var _convId = _turn ? _turn.convId : currentSlotKey();
      var _isActive = activeConvId() === _convId;
      var msg = { role: "assistant", content: "", _uiOnly: true, images: [{ id: String(meta.id), name: String(meta.name || "PC 截图"), w: meta.w || 0, h: meta.h || 0, source: "pc" }] };
      try {
        var _card = (ctx && ctx.__card) || ((window.characterSvc && window.characterSvc.getActiveCard) ? window.characterSvc.getActiveCard() : null);
        if (_card && _card.id) { msg.speakerId = _card.id; msg.speakerName = _card.name; msg.speakerIcon = _card.icon || "🙂"; }
      } catch (_c) {}
      _arr.push(scopeTag(msg));
      if (_turn) _turn.persist(); else persistSessionIfEnabled();
      if (!_isActive) return true; // 后台：只落库，不碰当前 DOM
      var r = makeRow("assistant");
      r.bubble.style.display = "none";
      if (r.stats) r.stats.textContent = "";
      renderAttachmentsInto(r.bubble, { images: msg.images });
      if (msg.speakerName && window.characterSvc && window.characterSvc.decorateAiRow) {
        try { window.characterSvc.decorateAiRow(r.rowEl, { id: msg.speakerId || "", name: msg.speakerName, icon: msg.speakerIcon || "🙂" }); } catch (_) {}
      }
      try { r.rowEl.dataset.sidx = String(_arr.length - 1); } catch (e) {}
      if (isNearBottom()) scrollToBottom();
      return true;
    } catch (e) { try { window.__pcAppendImageError = String((e && e.stack) || e); console.warn("[pc-image] append failed:", e); } catch (_) {} return false; }
  };

  // ── A15: 长消息折叠（applyUserFold）已扩到 attachments.js。

  // ── A15: 请求装配展开（expandAttachmentMessages）已扩到 attachments.js。

  // ── A16: token 估算与压缩水位已迁到 /js/text/chat/context.js（window.__context）。
  //    同名转发在文件顶部；估算口径（CJK 1 字≈1 token）与水位优先级（手动覆盖 > APP_CTX_EXACT/HINTS > 128K）不变。

  // ── A17: 行构造/滚动/底部留白/清屏已迁到 /js/text/ui/message-list.js（window.__messageList）。
  //    同名转发在文件顶部；流式正文的逐 delta 更新仍属 turn 薄编排，留在本文件。

  // ───────── 会话系统(2026-09-14 重做:会话与角色卡解绑)─────────
  // 旧模型:槽位键 = "<角色卡ID>#<会话ID>" —— 角色卡是外层维度,于是「切角色」= 换整份历史、
  //         「会话列表」只能列当前角色的会话、多人模式下干脆没有会话概念(全部共用 __scene__ 一条)。
  // 新模型:槽位键 = 平铺的 convId(如 "c_m3kq_ab12");角色只是会话的一个字段
  //         (注册表里的 charId = 「这个会话在跟谁聊」)。于是:
  //           · 切角色不再换槽、不再清空历史 —— 只是后续回复换人(助理消息本就自带 speakerId/speakerName)
  //           · 「新对话」= 真的新建一个空会话
  //           · 多人/群聊不再共用全局 __scene__ 槽,各自是独立会话(一条对话放多角色消息是现成能力)
  //         LS 键名沿用不变 → 云同步 /sync/chat 的契约(键=不透明字符串)零改动。
  // ── A23: 会话注册表 / 当前会话语义已迁到 /js/text/data/conv-store.js（window.__convStore）。
  //    被迁走：id 形态、cfw_conv_meta_v1 读写、cfw_conv_active_v1、主对话收敛与去重、切会话应用角色。
  //    仍留本文件：会话消息持久化（A22）、列表/切换/新建/改名/删除的 UI 编排（A25）。

  // 清掉输入框上方的「选项芯片」(agent offer_choices / [选项] 解析产出)。
  // 2026-09-14 fix:芯片是挂在输入框上方的**独立元素**,不在聊天记录里 —— clearUIRows() 带不走它。
  // 所以切换/新建/删除会话时必须显式清,否则上一条对话的选项会残留在新会话上方。
  function clearChoiceChips() {
    try { if (window.choicesSvc && window.choicesSvc.clearChoices) window.choicesSvc.clearChoices(); } catch (_) {}
  }
  // 2026-09-14:Agent 最大工具轮数 —— 原来写死内核默认 8 轮,跑到上限就一句「已达最大轮数」收场,
  // 复杂任务(多文件读写 / 多轮检索)不够用。现在可在设置里改(1~50,默认 8)。
  // 2026-09-14:Agent 工作模式(放行尺度)—— 对齐成熟 agent 工具的做法,设置页「Agent」分类里可改。
  //   confirm 变更前确认:有副作用的操作都要问
  //   auto    自动编辑  :文件类直接做,影响全局的(改设置/换模型)仍问
  //   plan    计划模式  :只做只读调查,一律不动手,先给计划
  //   full    完全访问  :不再确认
  // ── A25: Agent 行为配置已并入 /js/text/agent/registry.js（__agentRegistry）──
  //    工作模式/权限编译器/轮数上限/计划指令与工具注册表同属「Agent 工具层」；同名转发在这里。
  const getAgentWorkMode = () => window.__agentRegistry.getWorkMode();
  const makeAgentPermission = (mode, askBase) => window.__agentRegistry.makePermission(mode, askBase);
  const AGENT_PLAN_DIRECTIVE = window.__agentRegistry.PLAN_DIRECTIVE;
  const getAgentMaxRounds = () => window.__agentRegistry.getMaxRounds();


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
    // ── A25: 厂商分组已并入 model-catalog（groupModelsForSelect，纯函数）；建 DOM 仍在这里 ──
    // 2026-11-11(C): 免费档放宽到 50 个模型后，平铺的下拉没法看 —— 按厂商分组(<optgroup>)。
    // 没有厂商前缀的（DeepSeek 官方的 deepseek-flash 之类）不套组，直接平铺，保持原样。
    const mkOpt = (m) => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label || m.id;
      return opt;
    };
    const groups = window.__modelCatalog.groupModelsForSelect(MODELS);
    if (groups.length <= 1) {
      for (const m of MODELS) modelSel.appendChild(mkOpt(m));
    } else {
      for (const g of groups) {
        if (!g.vendor) { for (const m of g.models) modelSel.appendChild(mkOpt(m)); continue; }
        const og = document.createElement("optgroup");
        og.label = g.vendor;
        for (const m of g.models) og.appendChild(mkOpt(m));
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
    fitModelSelectWidth();
  }

  // 2026-11-11: 模型选择条按「当前选中的名字」定宽。
  // 为什么要用 JS 量：原生 <select> 的宽度跟着**最长选项**走（免费档最长是
  // nemotron-3-nano-omni-30b-a3b-reasoning），于是框被撑到 max-width 230px，
  // 里面只有十几个字符 → 右边空出一大截，还把顶栏其它按钮挤走。
  // 这里用 canvas 量真实文字宽度（含字体/字重），加箭头与内边距余量，夹在 130~230 之间。
  // 手机端不设内联宽度（媒体查询让 pill 占满中段），故按断点开关。
  function fitModelSelectWidth() {
    if (!modelSel) return;
    try {
      const desktop = window.matchMedia("(min-width: 769px)").matches;
      if (!desktop) { modelSel.style.width = ""; return; }
      const opt = modelSel.selectedOptions && modelSel.selectedOptions[0];
      modelSel.style.width = "auto"; // 先归位，避免上一次的内联宽度影响量测
      if (!opt) return;
      const cs = getComputedStyle(modelSel);
      const ctx = document.createElement("canvas").getContext("2d");
      ctx.font = (cs.fontWeight || "600") + " " + (cs.fontSize || "13px") + " " + (cs.fontFamily || "sans-serif");
      const textW = ctx.measureText(opt.textContent || "").width;
      const chrome = 44; // 下拉箭头 + 左右内边距的实测余量
      const w = Math.max(130, Math.min(230, Math.ceil(textW + chrome)));
      modelSel.style.width = w + "px";
    } catch (e) {}
  }
  // 窗口跨断点/改尺寸时重算（只影响宽度，不看其它状态）
  try {
    let _fitT = 0;
    window.addEventListener("resize", function () {
      clearTimeout(_fitT);
      _fitT = setTimeout(fitModelSelectWidth, 120);
    });
  } catch (e) {}

  modelSel.addEventListener("change", () => {
    localStorage.setItem(LS_MODEL, modelSel.value);
    // 2026-10-13 (E1c): 自定义渠道活跃时，顶栏换模型 = 换该渠道的当前模型（发请求时取 byo.model）
    try {
      if (window.providersSvc) {
        const st = window.providersSvc.read();
        if (st && st.activeId && String(st.activeId).indexOf("custom:") === 0 && window.providersSvc.setSelectedModel) {
          window.providersSvc.setSelectedModel(st.activeId, modelSel.value);
        }
      }
    } catch (e) {}
    // 2026-11-11: 换模型可能换掉思考能力（不支持 / 只有开 / 只有三档）。
    _thinkControl.updateThinkToggleUI();
    fitModelSelectWidth(); // 名字长短不同 → 选择条跟着收放，别留着固定的大空档
  });

  // ── A11: providers-changed 的“渠道→模式/下拉跟随”已收口到 channel-mode.bind()。

  // 2026-11-14: 顶栏按钮语义改为「工作 / 角色扮演」。
  // 原来这里切「内置 / 自定义基座目录」或「是否注入内置提示词」—— 两个能力都还在：
  //   · 基座目录 → 设置 → 对话 → 「基座目录」卡（settings.js mountBaseRegistryCard）
  //   · 内置提示词注入 → 设置 → 对话 → 「网页自定义人物模板」卡的 #useBuiltinToggle
  //     （私有版构建原来只有顶栏这一个开关，别把它丢了；开关改完会广播 cfw:external-settings
  //      让本文件的 useBuiltin 缓存重读，见 refreshCachedFlagsFromLS）
  // 这里只留一行绑定，状态与请求装配全在 app-mode.js，便于单测。
  _appMode.bind(personaToggle);
  try { _appMode.applyConv(activeConvId()); } catch (e) {}

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
          priorSummary = window.convSummarySvc.load(activeConvId());
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
          const _allIds = new Set([...Object.keys(all), ...Object.keys(loadConvMeta())].filter(isConvId));
          for (const _k of _allIds) {
            writeChatTombstone(_k); // 4.78: 逐槽写删除墓碑,清空所有历史并跨设备生效
            try { if (window.chatRealtimeSvc && typeof window.chatRealtimeSvc.recordConv === "function") window.chatRealtimeSvc.recordConv(_k, null, "delete"); } catch (e) {}
          }
        } catch {}
        // T3-D: the store owns the blob, the pending-archive spill and the in-memory mirror; reset
        // clears all three, then the cold truth is wiped in one transaction (best effort).
        try { _sessionStore.reset(); } catch (_r) { localStorage.removeItem(LS_CHAT_SESSION); }
        try { if (window.sessionEventsSvc && typeof window.sessionEventsSvc.clearAll === "function") window.sessionEventsSvc.clearAll(); } catch (_c) {}
        try { localStorage.removeItem(_convStore.LS_CONV_META); } catch {}   // 4.78: 清会话名
        try { localStorage.removeItem(LS_CONV_ACTIVE); } catch {} // 4.78: 清活跃会话指针
        // 摘要按会话存：清空全部会话时整表删除（旧全局键由服务一并清掉）
        try { window.convSummarySvc.clear(); } catch {}
        localStorage.removeItem("cfw_summary_chip_hidden_v1");
        priorSummary = "";
        // 清空全部会话：掐掉所有后台 turn，禁止迟到的 persist 把会话复活
        for (const _t of _turns.values()) {
          _t.deleted = true;
          _t.discard = true;
          _t.running = false;
          try { _t.controller.abort(); } catch {}
          if (_t.uiTimer) { try { clearInterval(_t.uiTimer); } catch {} _t.uiTimer = null; }
          _t.uiRow = null;
        }
        _turns.clear();
        session = [];
        syncActiveTurnGlobals();
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

  // ── A18: 输入自增高 / ResizeObserver / --kb 键盘兜底 / window.resize 联动已迁到 /js/text/ui/composer.js。
  //    本处只留接线：输入事件 rAF 节流、窗口尺寸联动；setupResizeObserver/setupViewportListener 由 init 调。
  _composerCtl.wireInput();
  _composerCtl.setupWindowResize();
  function setupResizeObserver() { _composerCtl.setupResizeObserver(); }
  function setupViewportListener() { _composerCtl.setupViewportListener(); }

  // Phase 4 阶段 6：从 LS 读取启用的预设，按 order 排序，filter enabled，COT 在快速档下自动禁用
  // （2026-10-06: 原「语音情绪白名单」(emotionTagDirective) 已随多情绪系统删除 —— 本函数曾残留对它的
  //   活调用导致所有聊天路径 ReferenceError 中止(agent 模式报"emotionTagDirective is not defined")，已清。）
  function getExtraSystemPrompts(mode, card) {
    try {
      // 2026-11-26 F2：预设筛选/排序/COT 快档禁用归 services/chat/system-prompts.ts（window.systemPromptsSvc）
      const raw = localStorage.getItem(LS_PROMPT_PRESETS);
      const cap = _promptProfile.charCap(card);
      const presetIds = cap && Array.isArray(cap.presetIds) ? cap.presetIds : null;
      return window.systemPromptsSvc.buildExtra(raw, mode, presetIds);
    } catch (e) { return ""; }
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
  // dev 开关 cfw_agent_mode_v1 开启 且 内核 SDK(/shared/agent/agent-kernel.js + /shared/agent/tools.js)已加载时,
  // sendOne 改走 sendOneAgent:让模型自主调用 send_image / adjust_affinity 等工具,
  // 由 AgentKernel.runAgentLoop 驱动多轮 tool 调用。默认关 → 保持原流式 sendOne 零回归。
  // 控制台开:devSvc.setAgentMode(true)
  function isAgentModeOn() {
    // 2026-11-26 F2：开关归一与内核就位判定归 services/chat/system-prompts.ts
    return window.systemPromptsSvc.agentModeOn(
      localStorage.getItem("cfw_agent_mode_v1"),
      !!(window.AgentKernel && window.OwnChatTools),
    );
  }

// 30-agent.js — Agent 内核路径：工具使用纲领 + sendOneAgent（function-calling 循环宿主）。
  // 2026-06-21 Bug:agent「不爱用工具/糊弄/抓网页能力差」——给 agent 模式追加强硬「工具使用纲领」。
  // 仅 agent 路径,经 worker 拼进 system prompt;不碰解限底座。
  const AGENT_TOOL_USE_DIRECTIVE = "\n\n【工具使用纲领·必读】你已接入真实可用的联网与本地工具,默认就该主动调用,绝不能凭记忆臆测或编造结果。\n1. 需要网上的网页/文件/资料时:已知或能推断 URL → 必须真的调用 fetch_page 抓取原文后再作答;不知道 URL → 先用 web_search 找到链接,再 fetch_page 读取。严禁假装读过某页或杜撰其内容。\n2. 抓取或搜索失败时,如实说明失败,可改用 fetch_page / web_search,或调 reach_diagnose 自检后重试;不要假装成功,也不要用「我无法联网」搪塞——你确实能联网。\n3. 多步任务要连续多轮调用工具直到真正完成再收尾,中途不要糊弄或跳步。\n4. 仅在确有必要时才用付费深度搜索(web_search deep=true);一般信息用默认免费搜索即可。";

  async function sendOneAgent(opts) {
    var opts0 = opts || {};
    var isAuto = opts0.text != null;
    var text = isAuto ? String(opts0.text).trim() : inputEl.value.trim();
    var allowEmpty = !!opts0.allowEmptyText;
    // T4-A: 与普通聊天同一条纯决策（忙碌 / 空输入 / 压缩闸门 / 重试预算）。agent 路径自带的
    // 「模型可用性」检查仍在建完用户气泡之后（旧顺序，不在这条计划里搬动）。
    var _plan = window.turnPlanSvc.planSend({
      kind: "agent",
      isAuto: isAuto,
      text: text,
      hasAttachments: !!attCount(),
      allowEmptyText: allowEmpty,
      convBusy: isConvSending(activeConvId()),
      agentMode: true,
      compact: _compactGateSnapshot(_currentSessionArray()),
      agentMaxRounds: getAgentMaxRounds(),
      toolMode: (function () {
        try { return window.toolModeSvc.readToolMode(localStorage.getItem("cfw_tool_mode_v1") || ""); } catch (e) { return "full"; }
      })(),
      visionOn: false,
      retry: _retryPolicySnapshot(),
    });
    if (!_plan.ok) return null;

    // 2026-11-11 会话并行：turn 绑定当前会话；切换会话不会中断它，所有写入走 turn.session。
    const turn = beginTurn("agent");
    if (!turn) return null;
    const session = turn.session;                         // 遮蔽外层 session（后台轮次写自己的数组）
    const persistSessionIfEnabled = () => turn.persist(); // 遮蔽外层持久化（写自己的 conv slot）
    let _agentSteerQueue = turn.steerQueue;               // 遮蔽全局插话队列
    let _agentImageQueue = turn.imageQueue;
    _discardPartialFlag = false; // 新一轮开始：清掉上一轮的"明确丢弃"标记
    const myGen = turn.gen;
    const controller = turn.controller;
    // 后台 turn 不抢当前会话的滚动/占位（局部遮蔽外层同名函数）
    const _turnActive = () => activeConvId() === turn.convId;
    const updateSpacer = () => { if (_turnActive()) { try { window.appSvc.updateSpacer(); } catch (e) {} } };
    const scrollToBottom = () => { if (_turnActive()) { try { _realScrollToBottom(); } catch (e) {} } };

    isSending = true;
    // 2026-11-10: agent 运行中不禁用发送键 —— 允许「插话」注入当前轮（见 steerAgent）。
    // 2026-11-11: 空输入时这个键整体变成停止键（方形图标 + 危险色）。
    sendBtn.disabled = false;
    updateSendBtnState();

    // 用户气泡 + 入 session(与 sendOne 输入处理一致)
    const _attA = takeAttachments();
    if (_plan.buildUserRow) {
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
    if (_plan.clearInput) {
      inputEl.value = "";
      inputEl.style.height = "auto";
      updateSendBtnState();
    }
    updateSpacer();
    scrollToBottom();

    // 角色卡 / 关系 / 好感 等上下文(对齐 sendOne 的 /api/chat payload)
    const ch = window.characterSvc || null;
    const characterCard = opts0.asCard
      ? opts0.asCard
      : (ch && ch.getActiveCard ? ch.getActiveCard() : null);
    const relation = ch && ch.getActiveRelation ? ch.getActiveRelation() : "default";
    const emotion = ch && ch.getActiveEmotion ? ch.getActiveEmotion() : "neutral";
    const affection = ch && ch.getActiveAffection ? ch.getActiveAffection() : null;
    let customPrompt = "";
    if (!useBuiltin && promptEnabled) customPrompt = localStorage.getItem(LS_CUSTOM_PROMPT) || "";
    // 2026-11-11: Agent 个性化（设置 → 个性化）。只作用于 Agent 路径，不受内置/自定义与角色卡影响。
    // trim 语义与设置页写侧共用 services/ui/settings-personalize.ts，避免两侧漂移。
    let agentPersonalize = "";
    try { agentPersonalize = window.settingsPersonalize.read(); } catch (e) {}
    const snapshotMode  = currentMode;
    const customProviderSnapshot = (window.byoProviderSvc && window.byoProviderSvc.get && window.byoProviderSvc.get()) || undefined;
    const snapshotModel = customProviderSnapshot ? customProviderSnapshot.model : modelSel.value;
    // 2026-11-10: 视觉模型才把 pc_shot 的截图注入上下文（文本模型塞图会被上游 400）
    try { window.__agentVisionOn = pcVisionOn(snapshotModel); } catch (e) { window.__agentVisionOn = false; }
    if (!ensureUsableModelBeforeSend(snapshotMode, snapshotModel, customProviderSnapshot)) {
      endTurn(turn);
      sendBtn.disabled = false;
      updateSendBtnState();
      return null;
    }
    // 2026-11-26: agent 回合开始前也走同一个压缩器。此时 session 只含已完成的历史；若末尾仍是
    // 未收尾的工具交换（中断残留），executor 会整体拒绝压缩，绝不切断 tool_calls/tool 配对。
    if (_plan.compact.attempt) await _chatCompact.maybeCompact({
      session,
      convId: turn.convId,
      activeConvId: activeConvId(),
      priorSummary,
      characterName: characterCard ? characterCard.name : "",
      customProvider: customProviderSnapshot,
      mode: snapshotMode,
      model: snapshotModel,
      providerId: activeProviderIdPayload(),
      persist: persistSessionIfEnabled,
      removeRows: (n) => {
        if (!_turnActive()) return;
        const allRows = Array.from(chatEl.children).filter(row => row !== spacerEl && row.classList && row.classList.contains("row"));
        const removeN = Math.min(n, allRows.length);
        for (let i = 0; i < removeN; i++) chatEl.removeChild(allRows[i]);
      },
    });
    // 2026-10-05: 本轮回复的来源标注,随会话持久化(翻历史时能看出这条是哪个模型+哪个底座答的)。
    // 与 payload 同一快照口径:中途切模型/底座,旧回复保留旧标注、新回复带新的 —— 所以按条存,不按会话盖章。
    // baseId 空串 = 「用默认档」(worker 侧回落到排序第一份),不是没记录。
    // 这个字段只进 UI/本地会话:发请求前 sanitizeToolProtocol 白名单重建会把它剥掉,不会流到上游。
    const _replyMeta = { model: snapshotModel, baseId: _promptProfile.baseIdPayload(characterCard).baseId || "" };

    const aiRow = makeRow("assistant", { side: opts0.side || null });
    setStreamingUI(aiRow.rowEl, true);
    if (window.characterSvc && window.characterSvc.decorateAiRow) {
      window.characterSvc.decorateAiRow(aiRow.rowEl, characterCard);
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
      try { const _S = turn.stepsUI || _stepsLive; if (_S) { _S.roundThinking(_curRoundReason); return; } } catch (_sr) {}
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
      const _pcOnImage = (url, meta, ctx) => {
          // 2026-11-11 会话并行：后台会话的临时图不进当前 DOM（持久化路径走 __pcAppendImage + ctx）
          const _turn = (ctx && ctx.__turn) || null;
          const _isActive = !_turn || (activeConvId() === _turn.convId && turnIsCurrent(_turn));
          // send_image 工具已通过 chatImageSvc.sendPhoto 生成图片并拿到 URL，直接渲染气泡，不重复生成
          // Bug fix 2026-06-18: 旧版把 url 字符串当对象取 .scene_prompt → scene="" → handleSignal 拿空 scene 无渲染
          // 且 handleSignal 会触发二次出图而非展示已有 URL；现改为直接插 <img> 气泡。
          try {
            if (url && typeof url === 'string' && _isActive) {
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
      // ── A29: 工具注册表装配（内核工具 + 11 组可选能力 + 系统快照）已迁到 /js/text/agent/registry.js。
      //    注册顺序、「不在就跳过」、「单组失败不牵连其它」的语义都在那边；这里只取 registry 与快照。
      const _reg = window.__agentRegistry.build({ onImage: _pcOnImage });
      const registry = _reg.registry;
      let _envSnap = _reg.envSnap;

      // callModel(messages, schemas):4.77 改流式打 /api/chat(stream:true),边收边把最终答复渲染进气泡 + 增量重组 tool_calls,回传与原非流式同形状的 message(含 tool_calls)。worker /api/chat 已支持流式带 tools(透传 tools + 原样吐 tool_calls delta),故内核与 worker 均不用动。
      // 4.83: 本回合 usage 累计 —— 回合结束时回填 AI 行统计(旧版开场清空后从不回填,
      // agent 模式下始终看不到任何统计)。必须用 var(函数作用域): 声明在 try 块内,
      // 但回填点在 finally 块,const/let 的块作用域会 ReferenceError。
      var _roundUsage = { p: 0, c: 0, n: 0 }; // 旧口径的本地计数；T4-A 起以 _turnMeter 为准
      // 2026-10-08 上游"静默卡死"防护：agent 的 callModel 是流式（4.77），但上游可能
      // headers 之后 body 不再吐字节（worker 默认流是裸透传、无心跳）——旧版只能干等，
      // 表现就是「工具跑完不回字、行一直 streaming」，唯一出路是点停止。
      // 现在：包装真 callModel，90 秒没有任何 chunk 就中止本次调用并抛出人话错误
      // （内核据此走 model_error 优雅收尾）。用独立子 controller 链到宿主 signal：
      // 用户主动停止（宿主 abort）与「上游没响应」（看门狗）在错误类型上可区分。
      // ── A28: 重试预算/错误分类/退避算式已迁到 /services/chat/retry.js（__retry，纯函数）。
      //    那边保留了 DSH retry-policy 与 ZCode idleTimeout 的原始依据；这里只留同名常量别名，
      //    调用点零改动。真正发请求、起停看门狗仍在本文件。
      const _retry = window.__retry;
      // 只剩「空事件上限」还用得上（在 callOnce 的流解析里）；看门狗与重试的常量随循环搬走了
      const AGENT_EMPTY_STREAK_MAX = _retry.cfg.EMPTY_STREAK_MAX;
      const _tagErr = (e, code) => _retry.tag(e, code);
      const _classifyCallError = (e, flags) => _retry.classify(e, flags);
      // ── A31a: 看门狗（静默/总时长）与重试循环已迁到 /js/text/agent/call-loop.js。
      //    子 controller、两个计时器、「用户停止 vs 上游没响应」的区分都在那边；
      //    这里只提供 callOnce（真正发请求 + 解析流）和重发前的 UI 清理/提示。
      // 重试是"整轮重发"：上一次尝试留在气泡里的半截正文必须清掉，否则旧字会挂在新流前面
      const _resetLiveView = () => {
        try { _lastAgentContent = ""; } catch (e) {}
        try { if (aiRow && aiRow.bubble) aiRow.bubble.textContent = ""; } catch (e) {}
      };
      // ── A31: 重试/看门狗包装与循环体已迁 services/agent-host/turn.ts（__agentTurn）。
      //    这里只留：注入袋（知识库注入/系统快照回传给请求装配）+ host（app 闭包桥）+ 轮创建。
      const _inj = { kb: "", env: "" };
      const host = {
        getCharacterCard: () => characterCard,
        // B2 C-3: the policy manifest payload and the raw tool-mode flag ride toolsConfig; both
        // absent-or-dirty = full mode (the runtime's read side is dirty-tolerant, one-byte rollback).
        getToolsConfig: () => ({
          registry: registry,
          envSnap: _envSnap,
          toolManifest: (function () { try { return (window.hostApi && window.hostApi.tools && window.hostApi.tools.manifest) || null; } catch (e) { return null; } })(),
          toolModeRaw: (function () { try { return localStorage.getItem("cfw_tool_mode_v1") || ""; } catch (e) { return ""; } })(),
        }),
        callModel: (messages, schemas, ctx) => _callModelOnce(messages, schemas, ctx),
        resetLive: () => _resetLiveView(),
        onRetry: (attempt, code) => {
          try {
            if (window.feedbackSvc && typeof window.feedbackSvc.toast === "function") {
              // T4-A: 重试预算来自本轮计划（与 call-loop 的 cfg 同源，计划只是把它拍成快照）。
              var _retryMax = (_plan && _plan.retry && _plan.retry.max) ? _plan.retry.max : _retry.cfg.RETRY_MAX;
              window.feedbackSvc.toast("上游" + _retry.whyText(code) + "，正在重试 " + (attempt + 1) + "/" + _retryMax + "…", 2600);
            }
          } catch (_nt) {}
        },
        getStartMessages: async () => sanitizeToolProtocol(await expandAttachmentMessages(selectSpeakerView(session, { scope: currentScopeKey(), card: characterCard }))),
        // Agent compaction continuity: turn.ts appends this as a system-prompt block.
        getPriorSummary: () => priorSummary,
        getActiveConvId: () => activeConvId(),
        isCurrent: (t) => turnIsCurrent(t),
        getSteps: () => _steps(),
        onRoundStart: () => { _curRoundReason = ""; },
        isNearBottom: () => isNearBottom(),
        scrollToBottom: () => scrollToBottom(),
        requestPermission: (name, args) => _ensurePermission(name, args),
        isSteered: (m) => _steerMsgs.has(m),
        persist: () => persistSessionIfEnabled(),
        getAgentMaxRounds: () => getAgentMaxRounds(),
        setInjections: (kb, env) => { _inj.kb = kb; _inj.env = env; },
        // T4-A: the turn scope owns the usage meter; the charging site below reports into it at the
        // same instant it charges the daily log, so the AI-row stats and the ledger cannot drift.
        bindUsage: (meter) => { _turnMeter = meter; },
        getTurnMeta: () => ({ mode: snapshotMode, model: snapshotModel }),
      };
      // Registry / scope / trace are the turn host's business: the root context comes from the db
      // facade (one per page), the trace recorder from the turn-events service. Both are optional —
      // a shell without them keeps the old behaviour (no scoped unload, no session turn rows).
      var _rootScope = null;
      try { _rootScope = (window.dbSvc && window.dbSvc.context) || null; } catch (e) { _rootScope = null; }
      var _traceRecorder = null;
      try {
        if (window.turnEventsSvc) {
          _traceRecorder = window.turnEventsSvc.create({ sink: () => window.sessionEventsSvc || null });
        }
      } catch (e) { _traceRecorder = null; }
      const _agentTurn = window.__agentTurn.create({
        session: session,
        controller: controller,
        turn: turn,
        host: host,
        scope: _rootScope,
        trace: _traceRecorder,
      });
      var _turnMeter = null;
      const _callModelOnce = async (messages, schemas, _ctx) => {
        // Vision：首轮把附图注入最后一条 user 消息（仅消费一次，后续轮不重复注入）
        // 2026-09-14: 附件在请求装配时展开(文件全文 / 图片视觉数组),不改 session;
        // 再过一遍协议装配 —— kernel 自己 push 的消息带 _tool 等 UI 字段,不能直接进请求体。
        const _msgsToSend = sanitizeToolProtocol(await expandAttachmentMessages(messages));
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: _ctx.signal, // 2026-10-08: 子 controller（链宿主 signal + 空闲看门狗），不再是 controller.signal
          // ── A26: 请求体结构（含可选层展开顺序）在 /services/chat/request.js 的 agentBody。
          //    extraSystemPrompts 的**内容拼装**仍留在这里（它要读技能目录/氛围/工作模式等页面状态）。
          body: JSON.stringify(window.__request.agentBody({
            tools: schemas,
            mode: snapshotMode,
            model: snapshotModel,
            useBuiltin,
            customPrompt,
            characterCard,
            thinkControl: _thinkControl,
            promptProfile: _promptProfile,
            extraSystemPrompts: getExtraSystemPrompts(snapshotMode, characterCard) + (_inj.kb ? "\n\n" + _inj.kb : "") + (_inj.env ? "\n\n" + _inj.env : "") + AGENT_TOOL_USE_DIRECTIVE + (getAgentWorkMode() === "plan" ? AGENT_PLAN_DIRECTIVE : "") + (window.skillsSvc && window.skillsSvc.buildCatalogPrompt ? window.skillsSvc.buildCatalogPrompt((_promptProfile.charCap(characterCard) || {}).skillNames) : "") + ambientDirectorPrompt() + (agentPersonalize ? "\n\n【用户个性化指令】\n" + agentPersonalize : ""),
            customProvider: customProviderSnapshot,
            providerId: activeProviderIdPayload(),
            messages: _msgsToSend,
          })),
        });
        if (!res.ok) {
          const t = await res.text().catch(() => "");
          const _he = new Error("Request failed (" + res.status + "): " + formatChatErrorBody(t));
          _he.__httpStatus = res.status; // 供 _classifyCallError 路由（5xx/429 可重试，4xx 不可）
          throw _he;
        }
        // 4.77: 流式解析 SSE,边收边把"最终答复"渲染进气泡;增量重组 content / reasoning_content / tool_calls。
        // 复用 sendOne 的 sseBuf 行缓冲防跨 chunk 掉字;心跳(": ping")与调试(": __dbg__")注释行非 "data: " 开头自动跳过。
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
          try { const _S = turn.stepsUI || _stepsLive; if (_S) { _S.roundThinking(_curRoundReason); return; } } catch (_lr) {}
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
          // effort 方言（reasoning_content / reasoning）的判定已内聚到 reasoning 服务，与 sendOne 共用。
          const _dReason = reasoningDelta(d);
          if (_dReason) {
            _reasoning += _dReason; turn.partialReasoning = _reasoning; _progress = true;
            // 记进当前轮：切走再切回时，过程面板里的「思考」要能重放出来
            try { const _r = turn.rounds && turn.rounds[turn.rounds.length - 1]; if (_r) _r.thinking = _reasoning; } catch (_) {}
            _renderLiveReasoning();
          }
          if (typeof d.content === "string" && d.content) { _content += d.content; _lastAgentContent = _content; turn.partialText = _content; _progress = true; _renderLive(); }
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
        // SSE 读取统一走 chatStreamSvc.readSse（原三份拷贝合一）：跨 chunk 行缓冲、decoder flush、
        // 末尾残行兜底（Bug⑦）都在那边；这里只管「这条事件算不算进展」与空事件看门狗。
        await window.chatStreamSvc.readSse(res, (jsonStr, _isTail) => {
          // 2026-11-09 修：只有**真正的 data 事件**才重置 90 秒看门狗 —— 上游的 keep-alive
          // 心跳（`: ping` / 空行）也会喂它，于是"上游在吐心跳但模型没输出"时永远不超时，
          // UI 停在"思考中"（实测快速档可卡住数分钟）。心跳/空行不再重置，静默 90 秒仍会被中止。
          if (!_isTail) _ctx.armIdle(_ctx.idleMs);
          let _parsedEvt = null;
          try { _parsedEvt = JSON.parse(jsonStr); } catch (e) {}
          if (!_parsedEvt) return; // 半截 JSON：整体已按行缓冲，这里只是兜底
          let _progress = false;
          try { _progress = _handleParsed(_parsedEvt); }
          catch (_he) { _progress = true; } // 渲染层异常不该被当成"上游没内容"
          if (_progress) { _emptyStreak = 0; return; }
          // 残行是流末补的那一刀，不参与空事件看门狗（与旧版一致：旧版残行直接吞异常）
          if (_isTail) return;
          if (++_emptyStreak > AGENT_EMPTY_STREAK_MAX) {
            throw _tagErr(new Error("上游连续 " + _emptyStreak + " 个空事件（无正文/无思考/无工具调用），判定流已失效"), "TIMEOUT");
          }
        });
        // 按 index 升序重组完整 tool_calls;丢弃没拼出 name 的空槽,缺 id 时补一个(上游偶发不下发 id)
        const _toolCalls = Object.keys(_toolMap)
          .sort((a, b) => Number(a) - Number(b))
          .map((k) => _toolMap[k])
          .filter((t) => t && t.function && t.function.name)
          .map((t) => ({ id: t.id || ("call_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)), type: t.type || "function", function: { name: t.function.name, arguments: t.function.arguments || "" } }));
        // 2026-06-17 agent 模式记账:流式末尾 stream_options.include_usage 带回 usage,快速模式按量补记(逐轮累加)
        try {
          if (_usage) {
            const _p = _usage.prompt_tokens || 0;
            const _c = _usage.completion_tokens || 0;
            const _cached = _usage.prompt_cache_hit_tokens || 0;
            _roundUsage.p += _p; _roundUsage.c += _c; _roundUsage.n += 1; // 4.83: 供回合结束回填统计
            // T4-A: 同一次记账喂给回合 scope 的计量器（stats 行改用它；充值与统计同一时点）。
            try { if (_turnMeter) _turnMeter.add(_usage); } catch (_mu) {}
            const _priceCtx = pricingContext(snapshotMode, snapshotModel, customProviderSnapshot);
            const _cost = snapshotMode === "fast" ? calcCost(_priceCtx, _p, _c, _cached) : 0;
            // 2026-11-12: 免费/Agent 路径也记 token（cost 可为 0），统计图才完整
            addCostToToday(_cost, _p, _c, snapshotModel);
            totalPromptTokens += _p;
            totalCompletionTokens += _c;
            if (_cost > 0) { _costLedger.addTotal(_cost); updateCostDisplay(); }
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

      // ── A31: 起始消息投影/控制台接线/事件分派已迁 services/agent-host/turn.ts（host.getStartMessages 等）──
      // （_consoleOnEvent 已随 A31 迁 services/agent-host/turn.ts —— 控制台桥在接线层端口）
      // 2026-09-14 第2期:工具调用不再压成 `▶ 工具名 ✓` 一行文本塞进思考折叠块,改为在气泡上方
      // 渲染「轮次步骤卡片」(ui/agent-steps.js) —— 每轮一张卡,展开能看到入参与**工具返回了什么**。
      // 折叠块只留模型真实推理(reasoning_content / <think>),不再混入工具行。
      var _stepsLive = null;
      var _stepsEnd = undefined; // 过程块的收尾原因（finally 里兜底收尾用；undefined=正常）
      const _steps = () => {
        try {
          // 2026-11-12 修「切回会话后过程不再更新」：切走时行被 clearUIRows 删掉，
          // 旧句柄还挂在已脱离文档的旧气泡上。这里必须检查「是不是还挂在当前行」，
          // 不是就换一个新句柄（attachTurnUI 已经重放过历史，新事件写新句柄即可）。
          if (turn.stepsUI && turn.stepsUI.element && document.contains(turn.stepsUI.element)) {
            if (!turn.uiRow || turn.stepsUI.element.closest(".row") === turn.uiRow.rowEl) {
              _stepsLive = turn.stepsUI;
              return _stepsLive;
            }
          }
          const _bubble = (turn.uiRow && turn.uiRow.bubble) || (aiRow && aiRow.bubble);
          _stepsLive = (window.__agentSteps && _bubble) ? window.__agentSteps.mountLive(_bubble) : null;
          turn.stepsUI = _stepsLive;
          const _rowEl = (turn.uiRow && turn.uiRow.rowEl) || (aiRow && aiRow.rowEl);
          if (_stepsLive && _rowEl) _rowEl.dataset.agentProcess = "1";
        } catch (_) { _stepsLive = null; }
        return _stepsLive;
      };
      // ── A30/A31: 事件记账与分派已随循环体迁 services/agent-host/turn.ts（ports.events）。
      //    _askBase/权限卡策略留在本文件（host.requestPermission）。
      const _ac = window.agentConsoleSvc || null; // A31 修复：_askBase 的消费者还在这 —— 控制台桥定义随控制台接线迁走后，这里补回本域取用
      const _askBase = (_ac && typeof _ac.ensurePermission === "function") ? _ac.ensurePermission : null;
      const _permBase = makeAgentPermission(getAgentWorkMode(), _askBase);
      // 后台会话请求放行：先提示用户切回该会话，切回后再弹卡；5 分钟没切回按拒绝处理，
      // 避免放行卡出现在错误会话、也避免后台 agent 无声挂死。
      const _ensurePermission = async (name, args) => {
        if (!turnIsCurrent(turn)) return false;
        if (activeConvId() !== turn.convId) {
          try { toastMsg("后台会话请求放行：" + name + " · 切回该会话后确认", 5000); } catch (e) {}
          await new Promise((resolve) => {
            const _t0 = Date.now();
            const _iv = setInterval(() => {
              if (activeConvId() === turn.convId || Date.now() - _t0 > 300000) { clearInterval(_iv); resolve(); }
            }, 300);
          });
          if (activeConvId() !== turn.convId || !turnIsCurrent(turn)) {
            try { if (window.agentConsoleSvc && window.agentConsoleSvc.note) window.agentConsoleSvc.note("后台会话未切回，自动拒绝放行：" + name); } catch (e) {}
            return false;
          }
        }
        return _permBase(name, args);
      };
      // ── A31: 内核循环/工具轮写回/角色记忆接线/插话与截图队列消费已全数迁
      // services/agent-host/turn.ts（__agentTurn.run）—— 这里只发起一轮并取回最终正文。
      const _runResult = await _agentTurn.run();
      finalText = _runResult.finalText;
    } catch (e) {
      if (e.name === "AbortError") {
        // 2026-10-08: 中断也要收尾过程块 —— 旧版只在正常结束/报错时收尾，点停止后过程块一直转"运行中…"
        // （截图实证：气泡已显示"（已中断）"，过程块还在转）。
        _stepsEnd = "aborted";
        // 2026-10-08 中断写回已随 A31 迁 services/agent-host/turn.ts（run 的 catch 在 rethrow 前
        // 做 steps 收尾 + err._agentMessages 写回）；这里只做 DOM 兜底（半截正文定格）。
        // 4.79 中断兜底:流被掐断(新发一条/停止/重试/删除/pacing/切角色)时,不再裸 return 丢掉半截,
        // 而是把已收到的可见正文清洗后定格为最终态并入 session(对齐普通 sendOne 的 partialStream 兜底)。
        // 2026-10-08: 只有"保留半截"的停止路径才落盘；重试/删除（discardPartial）不落 —— 那条路正在截断。
        if (turn.alive && !turn.discard && turnIsCurrent(turn)) {
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
            } else if (turn.alive) {
              // 一点内容都没收到就被停止：不留"思考中…"挂在气泡里（旧版会一直挂着直到刷新）
              try { aiRow.bubble.textContent = "（已中断）"; } catch (_ib) {}
            }
          } catch (_se) {}
        }
        setStreamingUI(aiRow.rowEl, false);
        return;
      }
      if (turn.alive) {
        aiRow.bubble.textContent = "网络错误: " + e.message;
        // 2026-10-13 (E1c): Agent 路径的失效模型自愈（throw 里带 "Request failed (status)" 口径）
        const _m = /Request failed \((\d+)\)/.exec(String(e.message || ""));
        if (_m && looksLikeInvalidModel(Number(_m[1]), e.message)) attachModelReselectButton(aiRow);
      }
      _stepsEnd = "error";
      finalText = "";
    } finally {
      // 2026-10-08 兜底：任何出口都让过程块收尾（正常路径已在上面收过，重复调用是幂等的）
      try { const _S = turn.stepsUI || _stepsLive; if (_S) _S.finish(_stepsEnd); } catch (_fz) {}
      if (turn.alive) {
        const _isActive = activeConvId() === turn.convId;
        endTurn(turn);
        if (_isActive) {
          sendBtn.disabled = false;
          try { window.__agentVisionOn = false; } catch (e) {}
          updateSendBtnState();
        }
      }
      setStreamingUI(aiRow.rowEl, false);
    }

    if (!turn.alive || !turnIsCurrent(turn)) return;

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
    // 2026-11-13 A34: Agent 路径同样在回复落盘后精炼会话名（没走 sendOne 的本地阶段也能从默认名直接起）
    try { if (window.__convAutoname) window.__convAutoname.refine(turn.convId, session); } catch (e) {}

    // 4.83: 回合结束回填 AI 行统计 —— 旧版开场 aiRow.stats.textContent="" 之后从不回填,
    // agent 模式下整个回合都看不到 token 统计。有真实 usage 用真实值(跨轮累计),
    // 免费模式上游不回 usage 则按估算(与实时路径「Output(估算)」约定一致)。
    // ── A33b: 统计行组装已并入 cost-ledger（formatAgentRoundStats，纯格式化）；累计器仍在这里 ──
    try {
      var _turnUsage = null;
      try { if (_turnMeter) _turnUsage = _turnMeter.summary(); } catch (_tu) { _turnUsage = null; }
      var _usageForStats = (_turnUsage && _turnUsage.n > 0) ? { p: _turnUsage.p, c: _turnUsage.c, n: _turnUsage.n } : _roundUsage;
      if (_usageForStats.n > 0) {
        aiRow.stats.textContent = window.__costLedger.formatAgentRoundStats({ usage: _usageForStats });
      } else {
        const _outEst = estimateTokens(full || "");
        totalOutEstimate += _outEst;
        aiRow.stats.textContent = window.__costLedger.formatAgentRoundStats({ outEst: _outEst, totalOutEstimate });
      }
    } catch (_) {}

    updateSpacer();
    scrollToBottom();
    return full;
  }

// 40-send.js — 流式主路径 sendOne（含附件装配、工具轮渲染、错误归一）。
  // sendOne(opts):核心发送逻辑,可由鱼缸引擎(fishbowl-engine.js)驱动
  // opts: { text?, allowEmptyText?, fishbowlMode?, topic?, asCard? }
  // 不传 opts.text 时从 inputEl 取;返回 AI 完整回复文本,失败/中断返回 null/undefined

  // ── T4-A: 计划输入快照（纯读取，不产生副作用）──
  // 读模块级会话数组要经这个函数：sendOne/sendOneAgent 内部都有 `const session = turn.session`，
  // 同一函数作用域里直接写 `session` 会撞上那个 const 的 TDZ（真窗实测：每次发送都
  // ReferenceError）。函数作用域查的是模块级绑定，安全。
  function _currentSessionArray() { return session; }
  // 阈值/水位/配对边界仍归 services/chat/compact.ts；这里只把「本轮是否值得调用压缩器」的四道
  // 便宜闸门拍成快照，交给 turn-plan 判定（判定与 maybeCompact 内部一致，跳过调用=它自己会返回 false）。
  function _compactGateSnapshot(sessionArr) {
    var gate = { enabled: true, historyEnabled: true, sessionLength: 0, endsInToolExchange: false };
    try { gate.enabled = !!_context.compactConfig().enabled; } catch (e) {}
    try { gate.historyEnabled = !!historyEnabled; } catch (e) {}
    gate.sessionLength = Array.isArray(sessionArr) ? sessionArr.length : 0;
    try { gate.endsInToolExchange = !!(window.endsInToolExchange && window.endsInToolExchange(sessionArr)); } catch (e) {}
    return gate;
  }
  function _retryPolicySnapshot() {
    try {
      var cfg = window.__retry.cfg;
      return { max: cfg.RETRY_MAX, idleMs: cfg.IDLE_MS, emptyStreakMax: cfg.EMPTY_STREAK_MAX };
    } catch (e) {
      return { max: 0, idleMs: 0, emptyStreakMax: 0 };
    }
  }

  async function sendOne(opts) {
    var opts0 = opts || {};
    var isAuto = opts0.text != null;
    var text = isAuto ? String(opts0.text).trim() : inputEl.value.trim();
    var allowEmpty = !!opts0.allowEmptyText;
    // 忙碌 / 空输入 / Agent 模式转交 / 压缩闸门 / 取消与重试预算：一次纯函数计划。
    var _plan = window.turnPlanSvc.planSend({
      kind: "chat",
      isAuto: isAuto,
      text: text,
      hasAttachments: !!attCount(),
      allowEmptyText: allowEmpty,
      convBusy: isConvSending(activeConvId()),
      agentMode: isAgentModeOn(),
      compact: _compactGateSnapshot(_currentSessionArray()),
      agentMaxRounds: 0,
      toolMode: "full",
      visionOn: false,
      retry: _retryPolicySnapshot(),
    });
    if (!_plan.ok) return null;
    // 内核接线 v1:Agent 内核模式开启时改走 sendOneAgent(function-calling + agent loop);默认关走原流式路径
    if (_plan.delegate) return await sendOneAgent(opts);
    _discardPartialFlag = false; // 新一轮开始：清掉上一轮的"明确丢弃"标记

    // 2026-11-11 会话并行：turn 绑定当前会话；切换会话不会中断它，所有写入走 turn.session。
    const turn = beginTurn("chat");
    if (!turn) return null;
    const session = turn.session;                         // 遮蔽外层 session
    const persistSessionIfEnabled = () => turn.persist(); // 遮蔽外层持久化
    let partialStream = turn.partialStream;
    const myGen = turn.gen;
    const controller = turn.controller;
    // 后台 turn 不抢当前会话的滚动/占位（局部遮蔽外层同名函数）
    const _turnActive = () => activeConvId() === turn.convId;
    const updateSpacer = () => { if (_turnActive()) { try { window.appSvc.updateSpacer(); } catch (e) {} } };
    const scrollToBottom = () => { if (_turnActive()) { try { _realScrollToBottom(); } catch (e) {} } };
    isSending = true;
    sendBtn.disabled = true;

    // T4-A: one formal trace per turn. turn/start + turn/end go into the event truth; step/tool
    // events stay the agent path's (this path has no steps). Fail-soft: no event service, no trace.
    var _chatTrace = null;
    try {
      if (window.turnEventsSvc) {
        _chatTrace = window.turnEventsSvc.create({
          sink: function () { return window.sessionEventsSvc || null; },
        }).begin({ convId: turn.convId, source: "chat", mode: currentMode, model: modelSel ? modelSel.value : "" });
      }
    } catch (e) { _chatTrace = null; }
    var _endChatTrace = function (status, reason) {
      if (!_chatTrace) return;
      try { _chatTrace.end(status, reason || ""); } catch (e) {}
      _chatTrace = null;
    };

    // 阶段 4-③：长对话自动压缩。参数快照/水位判定/工具配对安全边界/摘要请求/落库/删行都在
    // services/chat/compact.ts；这里只给本轮快照（此时尚未建 user row，与旧口径一致）。
    // 快照口径与主请求一致：BYO 生效用 byo.model，否则用顶栏当前模型。
    const _chEarly = window.characterSvc || null;
    const _cardEarly = _chEarly && _chEarly.getActiveCard ? _chEarly.getActiveCard() : null;
    const _byoEarly = (window.byoProviderSvc && window.byoProviderSvc.get && window.byoProviderSvc.get()) || undefined;
    if (_plan.compact.attempt) await _chatCompact.maybeCompact({
      session,
      convId: turn.convId,
      activeConvId: activeConvId(),
      priorSummary,
      characterName: _cardEarly ? _cardEarly.name : "",
      customProvider: _byoEarly,
      mode: currentMode,
      model: _byoEarly ? _byoEarly.model : modelSel.value,
      providerId: activeProviderIdPayload(),
      persist: persistSessionIfEnabled,
      removeRows: (n) => {
        if (activeConvId() !== turn.convId) return; // 后台 turn 不动前台 DOM
        const allRows = Array.from(chatEl.children).filter(row => row !== spacerEl && row.classList && row.classList.contains("row"));
        const removeN = Math.min(n, allRows.length);
        for (let i = 0; i < removeN; i++) chatEl.removeChild(allRows[i]);
      },
    });

    partialStream = { full: "", fullReasoning: "", speakerId: "", speakerName: "", speakerIcon: "" };
    turn.partialStream = partialStream;
    if (activeConvId() === turn.convId) setActivePartialStream(partialStream);

    // 鱼缸 V3:text 为空(allowEmptyText 模式下,鱼缸引擎驱动 / 群聊点角色 chip 直发)时
    // 跳过创建 user row,直接进 AI —— 消灭空 User 气泡污染观感
    // 2026-09-14: 附件(文本/图片)快照到消息上;只附附件不打字也会建气泡
    const _attB = takeAttachments();
    if (_plan.buildUserRow) {
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
      // 2026-11-13 A34: 首条消息 → 本地即时会话名（零请求；只动「新对话」）
      try { if (window.__convAutoname) window.__convAutoname.local(turn.convId, text); } catch (e) {}
    }
    if (_plan.clearInput) {
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
    const ch = window.characterSvc || null;
    // 鱼缸引擎驱动时用 opts.asCard 强制指定发言者(避免 active card 被切换造成错位)
    const characterCard = opts0.asCard
      ? opts0.asCard
      : (ch && ch.getActiveCard ? ch.getActiveCard() : null);
    // 4.19 P1 fix: 显式传 characterCard —— setActiveId 是异步 (await IndexedDB),
    // 鱼缸下一轮 setActive 后立刻进 sendOne,decorate 读模块级 _card 会拿到上一轮 → label 偏移
    // 4.19 P2 fix: 这段必须放在 const characterCard 定义之后,否则 TDZ ReferenceError 整个 sendOne 挂掉
    if (window.characterSvc && window.characterSvc.decorateAiRow) {
      window.characterSvc.decorateAiRow(aiRow.rowEl, characterCard);
    }
    const relation = ch && ch.getActiveRelation ? ch.getActiveRelation() : "default";
    const emotion = ch && ch.getActiveEmotion ? ch.getActiveEmotion() : "neutral";
    const affection = ch && ch.getActiveAffection ? ch.getActiveAffection() : null;
    const sceneOtherNames = (window.multiSvc && window.multiSvc.getSceneOtherNames) ? window.multiSvc.getSceneOtherNames() : [];
    // 4.52 在场感 part2:仅在群聊驱动场景(编排≥2 / 接龙 / 讨论)下,把"可召唤的场景外角色"喂给 worker,让 AI 能 [召唤:X] 叫人入场
    const _summonActive = isGroupChatActive() || (opts0.fishbowlMode && opts0.fishbowlMode !== "orchestrate");
    const summonableNames = (_summonActive && window.multiSvc && window.multiSvc.getSummonableNames)
      ? window.multiSvc.getSummonableNames(characterCard ? characterCard.id : "")
      : [];
    // 阶段 4-②：好感度阈值事件（一次性，发送成功后立即清空）
    const thresholdEvents = (ch && ch.getPendingThresholdEvents) ? ch.getPendingThresholdEvents() : [];
    // 4.49 P3 世界书：按最近对话文本 + 当前角色卡 scope 筛出当前生效条目（常驻 / 关键词命中），priority 降序
    let lorebookEntries = [];
    try {
      if (window.lorebookSvc && window.lorebookSvc.getActiveEntries) {
        const scanText = [text].concat(session.slice(-6).map(m => (m && m.content) || "")).join("\n");
        lorebookEntries = window.lorebookSvc.getActiveEntries({ text: scanText, cardId: characterCard ? characterCard.id : "" })
          .map(e => ({ name: e.name, content: e.content }));
      }
    } catch (e) {}
    if (partialStream && characterCard) {
      partialStream.speakerId = characterCard.id;
      partialStream.speakerName = characterCard.name;
      partialStream.speakerIcon = characterCard.icon || "🙂";
    }

    const snapshotMode  = currentMode;
    const customProviderSnapshot = (window.byoProviderSvc && window.byoProviderSvc.get && window.byoProviderSvc.get()) || undefined;
    const snapshotModel = customProviderSnapshot ? customProviderSnapshot.model : modelSel.value;
    if (!ensureUsableModelBeforeSend(snapshotMode, snapshotModel, customProviderSnapshot)) {
      endTurn(turn);
      sendBtn.disabled = false;
      updateSendBtnState();
      partialStream = null;
      _endChatTrace("blocked", "model-unusable");
      return null;
    }
    // 2026-10-05: 本轮回复的来源标注(见 sendOneAgent 同名注释)。baseId 空串 = 用默认档(排序第一份)。
    // sanitizeToolProtocol 白名单重建会剥掉它,不会流到上游。
    const _replyMeta = { model: snapshotModel, baseId: _promptProfile.baseIdPayload(characterCard).baseId || "" };

    // 2026-11-13 修：原先 const _reqMessages 困在 try 块里，而免费档的估算输入记账（下方 stats 的
    // est 路径）在 try 外引用它 —— ReferenceError 被外层 catch 静默吞掉，「免费档也记一条估算」
    // 从上线起就没生效过。声明提到 try 外，行为才与注释相符。
    let _reqMessages = null;
    try {
      // 2026-09-14: 附件在请求装配时展开(文件全文拼进 content / 图片转视觉数组),session 本身不动。
      // 非 Agent 模式下把工具轮整段剔除 —— 不支持 function calling 的模型收到 tool 轮会直接报错,
      // 而工具轮的价值只在于 agent 循环内部;最终答复本身已经是普通 assistant 消息,上下文不丢。
      // 2026-10-08: 先投影成"当前发言者的上下文"（场景键过滤 + 他人发言降级为 user【名字】），
      // 再展开附件/协议化 —— 这样每个角色拿到的是自己的历史，不再共享同一条。
      // 发言者取 opts.asCard（鱼缸/编排显式指定）优先，否则当前激活卡。
      const _speakerCard = opts0.asCard || (ch && ch.getActiveCard ? ch.getActiveCard() : null);
      _reqMessages = sanitizeToolProtocol(
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
      // 2026-11-14: 工作 / 角色扮演的请求装配收口在 app-mode.decidePayload（纯函数，有单测）。
      // 工作档：promptProfile=assist（worker 不吃 Layer2）、stateLayer=false、replyStyle=default、
      // 未设温度时补 0.3；角色扮演档：完全沿用用户设置（零回归）。
      const _pay = _appMode.payload({
        genParams: _promptProfile.genParamPayload(),
        stateLayer: _promptProfile.stateLayerPayload(),
      });
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          customProvider: customProviderSnapshot, // 4.69 BYO 自定义 API 直传
          mode: snapshotMode,                          // 新增
          model: snapshotModel,
          promptProfile: _pay.promptProfile, // 2026-11-14: 工作=assist(不吃 Layer2) / 角色扮演=rp(全套)
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
          extraSystemPrompts: getExtraSystemPrompts(snapshotMode, characterCard) + (_kbInj ? "\n\n" + _kbInj : "") + ((window.chatImageTextSvc && window.chatImageTextSvc.getInjection) ? window.chatImageTextSvc.getInjection() : "") + groupChatInjection(characterCard) + ambientDirectorPrompt(), // 2026-10-06: 技能不再走这里——只有 agent 模式挂「技能目录」，正文由 load_skill 按需取;
          // 4.82: 思考不再绑定快速档 —— 免费档也下发(worker 按 provider 方言装配参数)
          // 2026-11-11: 能力跟随当前渠道/模型 —— 不支持时强制 disabled，vllm 形态不带 reasoning_effort。
          ..._thinkControl.thinkRequestPayload(),
          ..._pay.genParams, // 4.83 原样保留用户设置；工作档未设温度时补 0.3（见 app-mode.decidePayload）
          fishbowlMode: opts0.fishbowlMode || null,
          topic: opts0.topic || "",
          // 2026-05-29: 回复风格 (default / wechat / verbose) - wechat 会在后面拆气泡
          // 2026-11-14: 工作档强制 default（工作不需要连发/长段叙事），角色扮演档读用户设置
          replyStyle: _pay.replyStyle,
          lorebook: lorebookEntries,
          ..._promptProfile.baseIdPayload(characterCard), // 解锁态：解限底座版本（角色能力档可覆盖；未选=不发）
          ..._promptProfile.neutralIdPayload(), // 锁定态：基础行为准则(未选/已解锁=不发)
          ..._pay.stateLayer, // 2026-10-05 原样保留设置里的关闭；2026-11-14 工作档显式 false（双保险）
          ..._promptProfile.webSearchPayload(), // 2026-10-07 联网搜索（开关打开时服务端才挂 web_search 工具）
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
        _endChatTrace("error", "http " + res.status);
        return;
      }

      // SSE 读取统一走 chatStreamSvc.readSse（与 Agent 循环同一份实现）：跨 chunk 行缓冲、
      // decoder flush、末尾残行兜底（Bug⑦：最后一条 data 不带 \n → 尾部正文丢失）都在那边。
      // 这里只管「一条 delta 怎么落到气泡和 session」。
      // 4.82 fix: 回复风格在流开始前读一次 —— 旧版在每个 delta 里同步读 localStorage,一次长回复读数千次。
      // (命名为 _streamReplyStyle,避免与后面拆条处的同名 const 混淆)
      const _streamReplyStyle = localStorage.getItem("cfw_reply_style_v1") || "default";
      await window.chatStreamSvc.readSse(res, (jsonStr) => {
        try {
          const parsed = JSON.parse(jsonStr);
          if (parsed.usage) exactUsage = parsed.usage;
          // effort 方言（reasoning_content / reasoning）的判定已内聚到 reasoning 服务，与 sendOneAgent 共用。
          const dReason = reasoningDelta(parsed.choices?.[0]?.delta);
          if (dReason && aiRow.reasoning) {
            fullReasoning += dReason;
            if (partialStream) partialStream.fullReasoning = fullReasoning;
            turn.partialReasoning = fullReasoning;
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
            turn.partialText = full;
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
      });
    } catch (e) {
      if (e.name === "AbortError") {
        // 中断（停止按钮 / 重试 / 删除 / 刷新 触发）—— 只在可保留半截时入 session
        if (turn.alive && !turn.discard && turnIsCurrent(turn)) {
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
          partialStream = null;
        }
        setStreamingUI(aiRow.rowEl, false);
        _endChatTrace("aborted", "abort");
        return;
      }
      if (turn.alive) {
        // 4.69 fix: wechat 模式网络错误时移除 typing 动画 class，否则报错气泡继续播放 typing CSS 动画
        aiRow.bubble.classList.remove("wechat-typing");
        aiRow.bubble.textContent = `网络错误: ${e.message}`;
      }
      // A real failure is not a cancellation: close the trace as an error before the finally block.
      _endChatTrace("error", String((e && e.message) || e));
    } finally {
      if (turn.alive) {
        const _isActive = activeConvId() === turn.convId;
        endTurn(turn);
        if (_isActive) {
          sendBtn.disabled = false;
          updateSendBtnState();
        }
      }
      setStreamingUI(aiRow.rowEl, false);
    }

    // 新一轮 send 已起，旧闭包不允许再写 session / UI，避免被截断后的鬼消息回填
    if (!turn.alive || !turnIsCurrent(turn)) { _endChatTrace("aborted", "stale-turn"); return; }
    partialStream = null;

    outEndMs = performance.now();

    // ── A33(1): 收尾清洗管道已并入 /js/text/chat/text-format.js（finalizeReply）──
    // ①思考归档 ②好感标签(await 点在模块内) ③氛围音 ④发图信号 ⑤engine 快照 ⑥群聊标签 ⑦残括号
    // 的顺序都在模块里；气泡重渲经 onRender 回调（与原「每步变化就重渲」逐拍一致），
    // 思考折叠块的归档落字经 onArchive（applyThinkDisplay 要读页面设置，留在本文件）。
    let _reasonArchive = "";
    let _photoSig = null;
    let _photoKind = null; // 4.72 修:透传 extractSignal 解析出的 kind,不再让 handleSignal 用关键词重新猜
    let _replyForEngine = full;
    const _isAutoFishbowl = opts0.fishbowlMode && opts0.fishbowlMode !== "orchestrate";
    {
      const fin = await window.textFormatSvc.finalizeReply(full, {
        fullReasoning,
        extractInlineThink: (t) => extractThinkText(t),
        buildArchive: (native, inline, sentinel) => buildReasoningArchive(native, inline, sentinel),
        parseAffectionTag: (ch && ch.parseAffectionTag) ? (t) => ch.parseAffectionTag(t) : null,
        affectionActive: affection !== null,
        adjustAffection: (ch && ch.adjustActiveAffection) ? (d) => ch.adjustActiveAffection(d) : null,
        stripGroupTags: _isAutoFishbowl || isGroupChatActive(),
        onRender: (t) => { aiRow.bubble.innerHTML = renderMarkdownSafe(t); },
        onArchive: (archive) => {
          if (aiRow.reasoning) {
            const _rt = aiRow.reasoning.querySelector(".reasoning-text");
            if (archive) _rt.textContent = archive;
            applyThinkDisplay(aiRow.reasoning);
          }
        },
      });
      _reasonArchive = fin.reasonArchive;
      full = fin.full;
      _replyForEngine = fin.replyForEngine;
      _photoSig = fin.photoSig;
      _photoKind = fin.photoKind;
    }

    // 2026-05-29 / 4.18: 微信风格拆气泡
    // session 里还是存完整拼接串(含 ||),避免下轮 turn 模型看不到连发样式上下文
    // 4.18 (v8): 拆条从 setTimeout 改成 await delay——sendOne 等所有 push 完才 resolve
    // 4.65: 群聊也显示全部 || 拆条,取消 4.18 (v9) 的「前 2 条」上限——第 3 条起被吞让用户以为"消息被切掉"
    const _replyStyle = localStorage.getItem("cfw_reply_style_v1") || "default";
    if (_replyStyle === "wechat") {
      aiRow.bubble.classList.remove("wechat-typing");
      // ── A33(1b): 拆条计算已并入 text-format（splitWechatParts）；建行/延迟/_tailGen 中断仍在下面 ──
      // session 存剥离动作描写后的 full（避免下轮模型又学着写动作）
      const _ws = window.textFormatSvc.splitWechatParts(full);
      if (_ws.text !== full) { full = _ws.text; aiRow.bubble.innerHTML = renderMarkdownSafe(full); }
      if (_ws.parts) {
        const _parts = _ws.parts;
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
              if (window.characterSvc && window.characterSvc.decorateAiRow) {
                // 4.19 P1 fix: tail piece 复用主 row 的 characterCard,保持所有拆条都是同一个角色
                window.characterSvc.decorateAiRow(_r.rowEl, characterCard);
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
    // 2026-11-26: 普通（非 agent）回合也走同一个收尾写入器；开关/空回复/异常规则在服务里。
    try { window.__memCore.autoWriteTurn(full, characterCard, turn.convId); } catch (e) {}
    // 2026-11-13 A34: 首轮回复落盘 → 异步 AI 精炼会话名（后台 turn 也用 turn.convId，不依赖当前会话）
    try { if (window.__convAutoname) window.__convAutoname.refine(turn.convId, session); } catch (e) {}
    // 2026-05-29 微信发图:正文入 session 后触发出图(图片气泡插在本条 AI 之后)
    if (_photoSig != null && window.chatImageTextSvc && window.chatImageTextSvc.handleSignal) {
      try { window.chatImageTextSvc.handleSignal({ scene: _photoSig, kind: _photoKind, card: characterCard, afterRow: aiRow.rowEl }); } catch (e) {}
    }
    // 阶段 4-②：本轮成功发送后清空已注入的一次性阈值事件
    if (thresholdEvents && thresholdEvents.length && ch && ch.clearPendingThresholdEvents) {
      try { ch.clearPendingThresholdEvents(); } catch {}
    }

    // ── A33(2): 统计行/面板快照的组装已并入 data/cost-ledger.js（formatTurnStats，纯格式化）──
    // 累计器与记账留在调用方（与 peer-calls 的 host.usage 同一口径：快速档计费、免费档记 token）。
    const _ms = Math.round(outEndMs - (outStartMs || outEndMs));
    const _seconds = Math.max(0.001, (outEndMs - (outStartMs || outEndMs)) / 1000);
    if (exactUsage && typeof exactUsage.completion_tokens === "number") {
      const p = exactUsage.prompt_tokens        || 0;
      const c = exactUsage.completion_tokens    || 0;
      totalPromptTokens     += p;
      totalCompletionTokens += c;
      if (snapshotMode === "fast") {
        const cost = calcCost(pricingContext(snapshotMode, snapshotModel, customProviderSnapshot), p, c, exactUsage.prompt_cache_hit_tokens || 0);
        _costLedger.addTotal(cost);
        addCostToToday(cost, p, c, snapshotModel);  // Phase 4 阶段 7：同步追加到日志（独立于历史）
        updateCostDisplay();
      }
      const _st = window.__costLedger.formatTurnStats({
        usage: exactUsage, seconds: _seconds, ms: _ms, at: Date.now(),
        mode: snapshotMode, model: snapshotModel,
        cumPrompt: totalPromptTokens, cumCompletion: totalCompletionTokens,
        fast: snapshotMode === "fast", cumCost: _costLedger.getTotal(),
      });
      aiRow.stats.textContent = _st.statsText;
      // 2026-09-14 UI第二轮:状态面板数据源 —— 真实 usage 优先
      lastReqStats = _st.lastReqStats;
    } else {
      const outEst = estimateTokens(full);
      totalOutEstimate += outEst;
      // 2026-11-12: 上游没回 usage（免费档常见）也记一条估算，统计图不至于空白。
      // （_reqMessages 现在在 try 外声明 —— A33 修复前这里抛 ReferenceError 被 catch 吞掉，记账从未生效）
      try {
        const _pEst = estimateTokens((_reqMessages || []).map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content || "")).join("\n"));
        addCostToToday(0, _pEst, outEst, snapshotModel, { est: true });
      } catch (e) {}
      const _st = window.__costLedger.formatTurnStats({
        seconds: _seconds, ms: _ms, at: Date.now(),
        mode: snapshotMode, model: snapshotModel,
        outEst, totalOutEstimate,
      });
      aiRow.stats.textContent = _st.statsText;
      lastReqStats = _st.lastReqStats;
    }

    updateSpacer();
    scrollToBottom();

    // 4.25: 返回含 [next:X]/[end] 的原文给鱼缸引擎解析(气泡/session 已是剥离版)
    _endChatTrace("done", "");
    return _replyForEngine;
  }

// 50-relay.js — 群聊 @ 召唤 / 自动接力 / 平级角色动作 / 攒消息入会话。
  // ─── 4.43 多人群聊:@召唤 + AI 交棒/随机插嘴 自发接力(仅多人模式下的「编排」自由群聊;接龙/讨论由鱼缸引擎驱动)───
  // 2026-11-25 F1：键/默认值/@匹配/接力闸门/群聊注入文案归 services/conv/group-chat.ts（window.groupChatSvc）
  const LS_AUTO_RELAY   = window.groupChatSvc.LS_AUTO_RELAY;
  const LS_RANDOM_BARGE = window.groupChatSvc.LS_RANDOM_BARGE;
  const MAX_AUTO_STREAK = window.groupChatSvc.MAX_AUTO_STREAK;
  let _autoBusy = false;

  function autoRelayEnabled() { return window.groupChatSvc.autoRelayOn(localStorage.getItem(LS_AUTO_RELAY)); }
  function randomBargeChance() { return window.groupChatSvc.randomBargeChance(localStorage.getItem(LS_RANDOM_BARGE)); }

  function isGroupChatActive() {
    // 2026-10-08（分层按钮）：Agent 模式与多智能体不再互斥 —— 同开时多智能体是"给 agent 开的能力
    // 闸门"（私下小会 / 派子 agent），时间线仍只有主 agent 一个声音，接力/编排不自动跑，角色只在
    // "小会 / 上台"里出现。所以这里在 agent 模式下恒 false。
    const M = window.multiSvc;
    let n = 0; try { n = ((M && M.getSceneCards && M.getSceneCards()) || []).length; } catch (e) {}
    const fb = window.fishbowlSvc;
    return window.groupChatSvc.isGroupChatActive({
      agentMode: isAgentModeOn(),
      multi: !!(M && M.isMulti && M.isMulti()),
      sceneCount: n,
      fishbowlMode: fb && fb.getMode ? fb.getMode() : "orchestrate",
    });
  }

  function matchSceneCardByName(hint) {
    let cards = []; try { cards = (window.multiSvc && window.multiSvc.getSceneCards && window.multiSvc.getSceneCards()) || []; } catch (e) { return null; }
    return window.groupChatSvc.matchCardByName(cards, hint);
  }

  function parseAtMentions(text) {
    if (!text || !isGroupChatActive()) return [];
    let cards = []; try { cards = (window.multiSvc && window.multiSvc.getSceneCards && window.multiSvc.getSceneCards()) || []; } catch (e) {}
    return window.groupChatSvc.parseMentions(text, cards);
  }

  function groupChatInjection(speakerCard) {
    if (!isGroupChatActive()) return "";
    let names = []; try { names = (((window.multiSvc.getSceneCards && window.multiSvc.getSceneCards()) || []).map(c => c && c.name)).filter(Boolean); } catch (e) {}
    return window.groupChatSvc.groupChatInjection(names, speakerCard ? speakerCard.name : "当前角色");
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
          const _sm = reply ? window.autoRelaySvc.summonName(reply) : null;
          if (_sm && window.multiSvc && window.multiSvc.summonByName) {
            const _sc = window.multiSvc.summonByName(_sm);
            if (_sc && (!lastCard || _sc.id !== lastCard.id)) nextCard = _sc;
          }
        } catch (e) {}
        try {
          const fb = window.fishbowlSvc;
          const tags = (!nextCard && fb && fb.parseTags) ? fb.parseTags(reply || "") : null;
          if (tags && tags.next) {
            const hit = matchSceneCardByName(tags.next);
            if (hit && (!lastCard || hit.id !== lastCard.id)) nextCard = hit;
          }
        } catch (e) {}
        if (!nextCard && Math.random() * 100 < randomBargeChance()) {
          let cards = []; try { cards = (window.multiSvc.getSceneCards && window.multiSvc.getSceneCards()) || []; } catch (e) {}
          nextCard = window.autoRelaySvc.pickBargeCard(cards, lastCard && lastCard.id, Math.random());
        }
        if (!nextCard) break;
        streak++;
        // 4.53 真实在线感:subset 随机更长延迟 + typing,且第 2 棒后有概率"没人接"提前散场
        if (subset) {
          if (window.autoRelaySvc.subsetDrops(streak, Math.random())) break;
          if (pacingEnabled()) showTyping(nextCard.name);
          await new Promise(r => setTimeout(r, window.autoRelaySvc.relayDelayMs({ subset: true, pacing: false, baseDelay: 0, random: Math.random() })));
          hideTyping();
        } else {
          // 4.58 拟人节奏:all 模式也别 600ms 机关枪秒接,按 pacing 设置加“正在输入”+ 拖动延迟
          if (pacingEnabled()) {
            showTyping(nextCard.name);
            await new Promise(r => setTimeout(r, window.autoRelaySvc.relayDelayMs({ subset: false, pacing: true, baseDelay: pacingBaseDelay(), random: Math.random() })));
            hideTyping();
          } else {
            await new Promise(r => setTimeout(r, window.autoRelaySvc.relayDelayMs({ subset: false, pacing: false, baseDelay: 0, random: Math.random() })));
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
  // ── A32(1): 平级角色的模型调用原语已迁到 /js/text/agent/peer-calls.js（__peerCalls）。
  //    角色匹配/配置/注册调用/oneShot/群聊发言/讨论区推送都在那边；本文件只剩编排
  //    （谁参加小会、几轮互评、渲染到时间线 —— A32b）。宿主注入的全是页面级状态。
  const _peerCalls = window.__peerCalls.create({
    signal: () => currentController,
    mode: () => currentMode,
    modelFallback: () => (modelSel ? modelSel.value : undefined),
    useBuiltin: () => useBuiltin,
    promptEnabled: () => promptEnabled,
    customPrompt: () => { try { return localStorage.getItem(LS_CUSTOM_PROMPT) || ""; } catch (e) { return ""; } },
    extraPrompts: (mode, card) => getExtraSystemPrompts(mode, card),
    promptProfile: _promptProfile,
    providerId: () => activeProviderIdPayload(),
    formatError: (t) => formatChatErrorBody(t),
    usage: (p, c, ca, modelUsed, byo) => {
      // 记账口径与主路径一致：快速档计费，免费档记 token（cost=0），统计按全模式汇总
      const cost = calcCost(pricingContext(currentMode, modelUsed, byo), p, c, ca);
      _costLedger.addTotal(cost);
      addCostToToday(cost, p, c, modelUsed);
      totalPromptTokens += p;
      totalCompletionTokens += c;
      if (cost > 0) updateCostDisplay();
    },
  });
  const runCharacterAgent = (card, brief, opts) => _peerCalls.runCharacterAgent(card, brief, opts);
  const oneShot = (opts) => _peerCalls.oneShot(opts);
  const callPeerModel = (card, view, brief) => _peerCalls.callPeerModel(card, view, brief);

  // ── A32b: 三个动作的编排已迁到 services/agent/peer-actions.ts（__peerActions，2026-11-15 服务层化）。
  //    谁参加小会、几轮互评、结论怎么回、耳语的信息差、上台的渲染落库都在那边；
  //    三条不变量（隔离上下文 / 不静默截断 / 记忆只抽取一次）写在模块头，改动前先读。
  const _peerActions = window.__peerActions.create({
    cardByName: (n) => _peerCalls.cardByName(n),
    cfg: () => _peerCalls.cfg(),
    callPeerModel: (card, view, brief) => _peerCalls.callPeerModel(card, view, brief),
    runCharacterAgent: (card, brief) => _peerCalls.runCharacterAgent(card, brief),
    councilPush: (fn, args) => _peerCalls.councilPush(fn, args),
    getSession: () => session,
    scopeKey: () => currentScopeKey(),
    scopeTagMsg: (m) => scopeTag(m),
    speakerView: (opts) => selectSpeakerView(session, opts),
    getSceneCards: () => { try { return (window.multiSvc && window.multiSvc.getSceneCards) ? window.multiSvc.getSceneCards() : []; } catch (e) { return []; } },
    // 上台是否走 agent 形态：原实现读 agentModeBtn 的 aria-pressed，与 isAgentModeOn() 的
    // localStorage 判断不同源 —— 照抄原实现，不要"顺手统一"成另一种状态源。
    agentStageMode: () => { try { const b = document.getElementById("agentModeBtn"); return !!(b && b.getAttribute("aria-pressed") === "true"); } catch (e) { return false; } },
    cleanText: (t) => stripResidualMarkup(stripJailbreakPrefix(stripThinkBlocks(t))),
    renderMarkdown: (t) => renderMarkdownSafe(t),
    makeRow: (role) => makeRow(role),
    decorateAiRow: (rowEl, card) => { try { if (window.characterSvc && window.characterSvc.decorateAiRow) window.characterSvc.decorateAiRow(rowEl, card); } catch (e) {} },
    setStreaming: (rowEl, on) => setStreamingUI(rowEl, on),
    persist: () => { try { persistSessionIfEnabled(); } catch (e) {} },
    updateSpacer: () => updateSpacer(),
    scrollToBottom: () => scrollToBottom(),
    memBuildInjection: async (cid, brief) => {
      try { if (window.__memCore && typeof window.__memCore.buildInjection === "function") return (await window.__memCore.buildInjection(cid, brief)) || ""; } catch (e) {}
      return "";
    },
    memEnabled: () => { try { return !!(window.__memCore && window.__memCore.enabled && window.__memCore.enabled()); } catch (e) { return false; } },
    memRemember: (text, opts) => { try { if (window.__memCore) window.__memCore.remember(text, opts); } catch (e) {} },
    memPutFacts: (cid, facts, opts) => { try { if (window.__memCore) window.__memCore.putFacts(cid, facts, opts); } catch (e) {} },
  });
  const runPeerMeeting = (opts) => _peerActions.runPeerMeeting(opts);
  const whisperTo = (opts) => _peerActions.whisperTo(opts);
  const inviteCharacterToTimeline = (opts) => _peerActions.inviteCharacterToTimeline(opts);

  // ── A19: 节奏配置/正在输入/在线模式/防抖队列已迁到 /js/text/ui/pacing.js（window.__pacing）。
  //    同名转发在文件顶部；pushUserMessageOnly 留在这里（它写 session，属 turn 生命周期）。

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
    // 2026-11-13 A34: pacing 攒消息路径同样给一次本地即时名（模块内部去重，攒多条不会反复写）
    try { if (window.__convAutoname) window.__convAutoname.local(activeConvId(), text); } catch (e) {}
  }

  // ── A19: 防抖计时器与 queueSend/fireReply 已迁到 pacing.js（同上）。

// 60-input.js — 发送入口、插话/停止、审核消息与后台 flush 事件。
  // send():从输入框取消息的入口(绑定 Send 按钮 / Enter 键)
  // 4.53 真实节奏:pacing 开启走 queueSend 攒消息防抖;关闭走 sendImmediate 即时发送(旧行为)
  function send() {
    // 2026-11-10: agent 轮次进行中 —— 输入的文本作为「插话」注入当前轮，不新起一条消息。
    const _t = activeTurn();
    if (_t && _t.running) {
      if (_t.kind === "agent" && _t.steerQueue) return steerAgent();
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
    const turn = activeTurn();
    if (!text || !turn || !turn.steerQueue) return null;
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
      try { if (window.agentConsoleSvc && window.agentConsoleSvc.note) window.agentConsoleSvc.note("用户要求停止：" + text); } catch (e) {}
      const gen = turn.gen;
      try { if (window.__stopCurrent) window.__stopCurrent(); } catch (e) {}
      const pushStop = () => {
        if (activeTurn() === turn) {
          session.push(scopeTag({ role: "user", content: text }));
          try { row.rowEl.dataset.sidx = String(session.length - 1); } catch (_sx) {}
          persistSessionIfEnabled();
        } else {
          turn.session.push(scopeTag({ role: "user", content: text }));
          turn.persist();
        }
      };
      const t0 = Date.now();
      const tick = () => {
        if (activeTurn() !== turn) { pushStop(); return; } // 用户已经切走/发了新消息，别把「停」弄丢
        const kernelBusy = !!(window.AgentKernel && typeof window.AgentKernel.isRunning === "function" && window.AgentKernel.isRunning());
        if (!turn.running && !kernelBusy) {
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
    turn.steerQueue.push(m);     // 内核下一轮请求前 append 进 messages
    try { if (window.agentConsoleSvc && window.agentConsoleSvc.note) window.agentConsoleSvc.note("用户插话：" + text); } catch (e) {}
    try { if (window.agentConsoleSvc && window.agentConsoleSvc.cancelPending) window.agentConsoleSvc.cancelPending("用户插话"); } catch (e) {}
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
    const speaker = (window.characterSvc && window.characterSvc.getActiveCard) ? window.characterSvc.getActiveCard() : null;
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
    const _t = activeTurn();
    if (_t && _t.running && !_t.stopping && _t.kind === "agent" && _t.steerQueue) {
      if (inputEl.value.trim()) return steerAgent();
      try { if (window.__stopCurrent) window.__stopCurrent(); } catch (e) {}
      return;
    }
    send();
  });

  // 刷新/关页时若有流式进行中，把已收到的部分当作一条完整的 assistant 回复兑现到 session 并持久化
  // 避免“用户消息已保存但 AI 回复丢失”的悬空状态
  window.addEventListener("beforeunload", () => {
    // 后台会话的 partial 也要落盘 —— 刷新/关页会掐掉所有请求，不能让后台轮次白跑
    try {
      const _active = activeConvId();
      for (const t of _turns.values()) {
        if (!t.running || t.convId === _active) continue;
        const _txt = String(t.partialText || "").trim();
        if (!_txt) { t.persist(); continue; }
        const _pm = { role: "assistant", content: _txt };
        if (t.partialReasoning) _pm.reasoning_content = t.partialReasoning;
        t.session.push(scopeTag(_pm));
        t.persist();
      }
    } catch (e) {}
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
      if (!flushDue(_flushChatToCloud._last || 0, _now)) return;
      _flushChatToCloud._last = _now;
      persistSessionIfEnabled();
      if (window.syncSvc && window.syncSvc.pushChatNow) window.syncSvc.pushChatNow();
    } catch (e) {}
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") _flushChatToCloud(); });
  window.addEventListener("pagehide", _flushChatToCloud);

  // ── A20（已并入 A18）: @ 召唤补全在 /js/text/ui/composer.js（同一个「输入区」模块）。
  //    键位分派留在这里（Enter 还要走 send()），补全菜单只回「这一键吃没吃」。
  _composerCtl.wireMention();

  inputEl.addEventListener("keydown", (e) => {
    if (_composerCtl.mentionKeydown(e)) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  // ── A21: 手机壳（滚动隐藏顶/底栏 + 顶栏开发者入口收纳）已迁到 /js/text/ui/mobile-shell.js。
  //    同名转发在文件顶部；window.__navHideReset 仍由模块挂到全局（历史恢复等处照旧调用）。

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

globalThis.normalizePriorSummary = normalizePriorSummary;
globalThis.restoreSessionPlan = restoreSessionPlan;
globalThis.flushDue = flushDue;
})();
