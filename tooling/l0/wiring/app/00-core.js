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

