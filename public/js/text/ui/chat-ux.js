// public/js/text/ui/chat-ux.js — 对话区交互细节
//   ① 用户/AI 行操作按钮（复制 / ⇺ 重试 / 删除 / ■ 停止）+ 流式状态守护
//   ② 智能自动滚动（用户在底部时跟随新消息；上拉阅读时不打扰；点发送回底）
//   ③ 桌面欢迎页：✕ 关闭仅本次会话隐藏，不再永久关闭（下次启动仍出现）；网页端不显示
//
// 与 app.js 的接口：
//   window.__abortCurrent(discardPartial?)   重试/删除 传 true 丢弃 partialStream
//   window.__sessionTruncateTo(n)            截断 session 到第 n 条
//   window.__sessionDeleteAt(start, count)   删除 session 指定位置的消息
//   AI 行 .row.ai 有 dataset.streaming === "1" 时 ■ 停止按钮可见

(function () {
  // ────────────────────────────────────────────────────────────
  // ③ 桌面欢迎页：关闭不再永久（运行时修，不改 index.html）
  //   index.html 的 ✕ 关闭会写 LS cfw_welcome_dismissed_v1='1' 把欢迎页永久关掉。
  //   这里：① 启动时清掉该持久化标记并恢复显示资格（每次启动都当作未关闭）；
  //        ② ✕ 关闭后延后一拍再清一次 LS（盖过 index.html 内联的同步写入），
  //   使「关一次 = 仅本次会话隐藏」，重开桌面端欢迎页照常回来。
  //   网页版无 html.is-desktop，欢迎页 CSS 本就不显示，这段对网页端无副作用。
  // ────────────────────────────────────────────────────────────
  (function welcomeDismissFix() {
    try { localStorage.removeItem("cfw_welcome_dismissed_v1"); } catch (e) {}
    try { document.documentElement.classList.remove("welcome-dismissed"); } catch (e) {}
    function wire() {
      var cb = document.getElementById("owCloseBtn");
      if (!cb || cb.__uxDismissFix) return;
      cb.__uxDismissFix = "1";
      cb.addEventListener("click", function () {
        // index.html 内联处理器会同步写 LS='1'；延后一拍清掉，保留本次隐藏但不持久化
        setTimeout(function () {
          try { localStorage.removeItem("cfw_welcome_dismissed_v1"); } catch (e) {}
        }, 0);
      });
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
    else wire();
    setTimeout(wire, 800);
  })();

  // ────────────────────────────────────────────────────────────
  // ① 行按钮
  // ────────────────────────────────────────────────────────────
  window.addEventListener("load", function () {
    const chat = document.getElementById("chat");
    const sendBtn = document.getElementById("sendBtn");
    const msgInput = document.getElementById("msg");
    if (!chat || !sendBtn || !msgInput) return;

    // 样式交由 styles.css .msg-action-btn 管，与 Phase 4 主题系统（minimal / glass）统一
    // 2026-09-14:按钮支持线性 SVG 图标 —— 原来用裸文本符号(■ U+25A0 / ↺ U+21BA),
    // 这类码位在部分平台会按 emoji 呈现,而且字号与基线不受控,观感廉价。
    // 2026-09-14 全部改「纯 SVG 图标」按钮(对齐 ZCode 消息操作条):无边框无底色,悬停才有反馈;
    // 文字放进 title/aria-label 做无障碍与提示。原来带文字标签("重试/删除/复制")太占宽度、也吵。
    var ICON_STOP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
    var ICON_RETRY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>';
    var ICON_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.2"/><path d="M15 6.5V5.2A2.2 2.2 0 0 0 12.8 3H5.2A2.2 2.2 0 0 0 3 5.2v7.6A2.2 2.2 0 0 0 5.2 15h1.3"/></svg>';
    var ICON_DEL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M9.5 7V5.4A1.4 1.4 0 0 1 10.9 4h2.2a1.4 1.4 0 0 1 1.4 1.4V7"/><path d="M6.5 7l.8 12a1.6 1.6 0 0 0 1.6 1.5h6.2a1.6 1.6 0 0 0 1.6-1.5L17.5 7"/><path d="M10.5 11v6M13.5 11v6"/></svg>';
    function makeBtn(label, iconSvg) {
      const btn = document.createElement("button");
      btn.className = "msg-action-btn";
      if (iconSvg) {
        btn.innerHTML = iconSvg;
        btn.classList.add("icon-only");
      } else {
        btn.textContent = label;
      }
      btn.setAttribute("title", label);
      btn.setAttribute("aria-label", label);
      return btn;
    }

    // 通用：复制 bubble 文本（带 navigator.clipboard + execCommand fallback，手机兼容）
    function bindCopy(btn, bubbleSelector, row) {
      btn.addEventListener("click", () => {
        const bubble = row.querySelector(bubbleSelector);
        const text = bubble ? bubble.textContent.trim() : "";
        const doFallback = () => {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;font-size:16px;";
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          try {
            document.execCommand("copy");
            btn.classList.add("ok");
          } catch {
            btn.textContent = "失败";
          }
          document.body.removeChild(ta);
          setTimeout(() => btn.classList.remove("ok"), 1200);
        };
        if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard
            .writeText(text)
            .then(() => {
              btn.classList.add("ok");
              setTimeout(() => btn.classList.remove("ok"), 1200);
            })
            .catch(doFallback);
        } else {
          doFallback();
        }
      });
    }

    // 通用：从指定起始 row（含）开始全部移除 DOM + 截断 session + 回填输入框 + 触发发送
    function resendFromUserRow(userRow) {
      if (typeof window.__abortCurrent === "function") window.__abortCurrent(true);
      const allRows = Array.from(chat.querySelectorAll(".row"));
      const userIdx = allRows.indexOf(userRow);
      if (userIdx < 0) return;
      const bubble = userRow.querySelector(".bubble.user");
      if (!bubble) return;
      // 2026-09-14 附件重构:原实现用 bubble.textContent 重建消息 —— 气泡里只有文件 chip,
      // 没有文件全文;而 __sessionTruncateTo 会把含全文的原消息(内存+磁盘)一起删掉,
      // 结果「换模型 → 点重试」附件内容就永久消失。现改为从 session 取原始消息,
      // 并把它的附件重新放回待发状态,重发时仍带全文/图片。
      let msg = null;
      try { msg = window.__app && window.__app.getSessionMessageAt ? window.__app.getSessionMessageAt(userIdx) : null; } catch (e) {}
      const userText = (msg && typeof msg.content === "string") ? msg.content : bubble.textContent.trim();
      if (!userText) {
        const hasAtt = !!(msg && ((msg.files && msg.files.length) || (msg.images && msg.images.length)));
        if (!hasAtt) return; // 纯空消息(无文字无附件)才真的放弃
      }
      for (let i = allRows.length - 1; i >= userIdx; i--) allRows[i].remove();
      try {
        if (msg && window.__attach && window.__attach.restage) window.__attach.restage(msg);
      } catch (e) {}
      if (typeof window.__sessionTruncateTo === "function") {
        window.__sessionTruncateTo(userIdx);
      }
      if (typeof window.__resetSending === "function") window.__resetSending();
      else {
        sendBtn.disabled = false;
        sendBtn.textContent = "Send";
      }
      msgInput.value = userText;
      msgInput.dispatchEvent(new Event("input"));
      setTimeout(() => {
        msgInput.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
        );
      }, 30);
    }

    // 通用：删 user + 紧随的 AI / 删 AI + 前面的 user；同时清理任何残留流式行
    function deleteRowPair(anchorRow, mode) {
      // mode = "fromUser" | "fromAi"
      if (typeof window.__abortCurrent === "function") window.__abortCurrent(true);
      const allRows = Array.from(chat.querySelectorAll(".row"));
      const idx = allRows.indexOf(anchorRow);
      if (idx < 0) return;
      let start, count;
      if (mode === "fromUser") {
        const next = allRows[idx + 1];
        const hasAi = !!(next && next.classList.contains("ai"));
        anchorRow.remove();
        if (hasAi) next.remove();
        start = idx;
        count = hasAi ? 2 : 1;
      } else {
        const prev = allRows[idx - 1];
        const hasUser = !!(prev && prev.classList.contains("user"));
        anchorRow.remove();
        if (hasUser) prev.remove();
        start = hasUser ? idx - 1 : idx;
        count = hasUser ? 2 : 1;
      }
      if (typeof window.__sessionDeleteAt === "function") {
        window.__sessionDeleteAt(start, count);
      }
      // partialStream 已被 __abortCurrent(true) 丢弃，必须连带从 DOM 移除残留流式行
      // 否则会出现 DOM 多一条悬空 AI 行 / session 少一条 a_n 的错位
      chat.querySelectorAll('.row.ai[data-streaming="1"]').forEach((r) => r.remove());
    }

    function addAiButtons(aiRow) {
      if (aiRow.dataset.btnsAttached) return;
      aiRow.dataset.btnsAttached = "1";
      const content = aiRow.querySelector(".content");
      if (!content) return;

      const wrap = document.createElement("div");
      wrap.className = "my-action-btns";
      wrap.style.cssText =
        "display:flex;justify-content:flex-start;gap:8px;padding:4px 4px 2px;flex-wrap:wrap;";

      // ■ 停止（仅流式中可见；点击中断当前请求，已收到部分作为完整 AI 回复保留入 session）
      const stopBtn = makeBtn("停止", ICON_STOP);
      stopBtn.classList.add("my-stop-btn");
      stopBtn.style.display = aiRow.dataset.streaming === "1" ? "" : "none";
      stopBtn.addEventListener("click", () => {
        if (typeof window.__abortCurrent === "function") window.__abortCurrent();
        stopBtn.style.display = "none";
        try {
          delete aiRow.dataset.streaming;
        } catch {
          aiRow.removeAttribute("data-streaming");
        }
      });

      const copyBtn = makeBtn("复制", ICON_COPY);
      bindCopy(copyBtn, ".bubble.ai", aiRow);

      // ⇺ 重试（从对应的上一条用户消息重新发送）
      const retryBtn = makeBtn("重试", ICON_RETRY);
      retryBtn.addEventListener("click", () => {
        const allRows = Array.from(chat.querySelectorAll(".row"));
        const aiIdx = allRows.indexOf(aiRow);
        if (aiIdx < 0) return;
        const prev = allRows[aiIdx - 1];
        if (!prev || !prev.classList.contains("user")) return;
        resendFromUserRow(prev);
      });

      // 删除（本条 AI + 前面的用户消息一并删，清理残留流式行）
      const delBtn = makeBtn("删除", ICON_DEL);
      delBtn.addEventListener("click", () => deleteRowPair(aiRow, "fromAi"));

      wrap.appendChild(stopBtn);
      wrap.appendChild(retryBtn);
      wrap.appendChild(delBtn);
      wrap.appendChild(copyBtn);
      content.appendChild(wrap);
    }

    function addUserButtons(userRow) {
      if (userRow.dataset.btnsAttached) return;
      userRow.dataset.btnsAttached = "1";
      const content = userRow.querySelector(".content");
      if (!content) return;

      const wrap = document.createElement("div");
      wrap.className = "my-action-btns";
      wrap.style.cssText =
        "display:flex;justify-content:flex-end;gap:8px;padding:4px 4px 2px;flex-wrap:wrap;";

      const copyBtn = makeBtn("复制", ICON_COPY);
      bindCopy(copyBtn, ".bubble.user", userRow);

      // ⇺ 重试（从这条用户消息重新发送，其后所有回复 / 后续对话都会被丢弃）
      const retryBtn = makeBtn("重试", ICON_RETRY);
      retryBtn.addEventListener("click", () => resendFromUserRow(userRow));

      // 删除（本条用户 + 紧随其后的 AI 回复一并删）
      const delBtn = makeBtn("删除", ICON_DEL);
      delBtn.addEventListener("click", () => deleteRowPair(userRow, "fromUser"));

      wrap.appendChild(retryBtn);
      wrap.appendChild(delBtn);
      wrap.appendChild(copyBtn);
      content.appendChild(wrap);
    }

    // 监听新增的消息行，自动挂按钮（流式回复 / 刷新还原 / 多智能体切换都会触发）
    const observer = new MutationObserver(() => {
      chat.querySelectorAll(".row.ai").forEach(addAiButtons);
      chat.querySelectorAll(".row.user").forEach(addUserButtons);
    });
    observer.observe(chat, { childList: true });

    // 首次加载时给历史还原的消息补按钮
    chat.querySelectorAll(".row.ai").forEach(addAiButtons);
    chat.querySelectorAll(".row.user").forEach(addUserButtons);
  });

  // ────────────────────────────────────────────────────────────
  // ② 智能自动滚动
  //   原 my-comfort.js 的浅/深主题切换已剥离（Phase 4 阶段 4 由 theme.js 接管）
  //   旧 localStorage 键 "my-theme" 已无任何代码读写
  // ────────────────────────────────────────────────────────────
  window.addEventListener("load", function () {
    const chat = document.getElementById("chat");
    const history = document.getElementById("history");
    if (!chat || !history) return;

    // 用户在底部时自动跟随到最新消息；上拉阅读时不打扰
    let autoScroll = true;
    history.addEventListener(
      "scroll",
      () => {
        const dist = history.scrollHeight - history.scrollTop - history.clientHeight;
        autoScroll = dist < 60;
      },
      { passive: true }
    );

    const scrollObserver = new MutationObserver(() => {
      if (autoScroll) {
        history.scrollTo({ top: history.scrollHeight, behavior: "smooth" });
      }
    });
    scrollObserver.observe(chat, { childList: true, subtree: true, characterData: true });

    // 点击发送：强制贴底（即使用户刚才滚到上面看历史）
    const sendBtn = document.getElementById("sendBtn");
    if (sendBtn) {
      sendBtn.addEventListener("click", () => {
        autoScroll = true;
        setTimeout(() => {
          history.scrollTo({ top: history.scrollHeight, behavior: "smooth" });
        }, 50);
      });
    }
  });
})();