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
  // 2026-11-27（所有者）：历史开关退役 —— 对话恒为落盘/可恢复；旧的 cfw_history_enabled=0
  // 不再读取（否则用户被永久锁在“刷新即失忆”且没有 UI 可恢复）。
  let historyEnabled = true;
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
    const _clrBtn  = document.getElementById("clearHistory");
    const _prmEl   = document.getElementById("promptKeep");
    const _custEl  = document.getElementById("customPrompt");
    const _saveBtn = document.getElementById("savePrompt");
    const _clrPBtn = document.getElementById("clearPrompt");
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

