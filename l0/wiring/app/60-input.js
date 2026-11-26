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

