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

