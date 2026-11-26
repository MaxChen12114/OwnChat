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

