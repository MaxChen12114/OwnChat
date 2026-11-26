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

