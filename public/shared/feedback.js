// public/shared/feedback.js — 统一反馈组件(toast / confirm)· 2026-09-14 UI第一轮
// API: window.__feedback = { toast(msg, opts), confirm(opts) -> Promise<boolean> }
//   toast(msg [, { type:'info'|'ok'|'warn'|'err', ms:number }])   兼容旧签名 toast(msg, ms)
//   confirm({ title, message, okText, cancelText, danger })       Promise 化确认框;Esc / 遮罩 / 取消 = false
//
// 设计约束(2026-09-14 与作者确认的安全策略):
//   1. 零依赖 IIFE,classic script,主页/子应用一个 <script> 即用;CSS 由本文件自注入
//      (沿用 prompt-editor.js / image-embed.js 的「自注入 DOM + 自注入 CSS」惯例)。
//   2. 配色全部走 :root 令牌(--bubble-ai/--bg/--border/--muted/--btn-bg…),fallback 值取
//      styles.css 默认主题,自动适配 minimal/glass/candle 主题与 light/dark。
//   3. 各模块旧 toast 保留原签名做「代理转发」:__feedback 缺失时回退原实现,永不硬失败。
//      访问码弹窗(99998)同时出现的场景不重叠。
//   5. 所有消息文本一律 textContent 写入,不吃 HTML;图标 SVG 为内置常量,无注入面。
(function(){
  "use strict";
  if (window.__feedback) return;

  const STYLE_ID = "feedbackStyles";
  const HOST_ID = "feedbackToastHost";
  const MASK_ID = "feedbackConfirmMask";
  const MAX_STACK = 4; // 同屏最多 4 条,新的挤掉最旧的

  const CSS_TEXT = `
#feedbackToastHost{position:fixed;left:50%;top:calc(18px + env(safe-area-inset-top,0px));transform:translateX(-50%);z-index:99999;display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none;max-width:min(92vw,480px);}
.fb-toast{pointer-events:auto;display:flex;align-items:center;gap:8px;max-width:100%;padding:10px 16px;border-radius:12px;background:var(--bubble-ai,#141414);color:inherit;border:1px solid var(--border,#222);box-shadow:0 8px 24px rgba(0,0,0,.35);font:600 13px/1.5 var(--chat-font-family,ui-sans-serif,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif);opacity:0;transform:translateY(-8px);transition:opacity .18s ease,transform .18s ease;box-sizing:border-box;}
.fb-toast.fb-show{opacity:1;transform:translateY(0);}
.fb-toast .fb-ico{flex:none;display:inline-flex;}
.fb-toast .fb-ico svg{display:block;}
.fb-toast .fb-txt{word-break:break-word;}
.fb-toast.fb-info .fb-ico{color:var(--muted,#9a9a9a);}
.fb-toast.fb-ok .fb-ico{color:#5ec98a;}
.fb-toast.fb-warn .fb-ico{color:#ffb648;}
.fb-toast.fb-err .fb-ico{color:var(--danger,#e8607d);}
#feedbackConfirmMask{position:fixed;inset:0;background:rgba(0,0,0,.5);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;z-index:99998;padding:20px;box-sizing:border-box;animation:fbFadeIn .16s ease;}
#feedbackConfirmCard{background:var(--bg,#0b0b0b);color:inherit;border:1px solid var(--border,#2a2a2a);border-radius:18px;padding:20px;width:100%;max-width:360px;box-shadow:0 30px 80px rgba(0,0,0,.5);font-family:var(--chat-font-family,ui-sans-serif,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif);box-sizing:border-box;animation:fbPopIn .18s ease;}
#feedbackConfirmCard .fb-c-title{font-size:15px;font-weight:700;margin:0 0 10px;}
#feedbackConfirmCard .fb-c-msg{font-size:13px;line-height:1.65;color:var(--muted,#9a9a9a);white-space:pre-wrap;word-break:break-word;margin:0 0 16px;max-height:50vh;overflow:auto;}
#feedbackConfirmCard .fb-c-btns{display:flex;gap:10px;justify-content:flex-end;}
#feedbackConfirmCard button{font:600 13px/1 var(--chat-font-family,ui-sans-serif,sans-serif);padding:9px 16px;border-radius:10px;cursor:pointer;border:1px solid var(--border,#2a2a2a);background:var(--btn-bg,#3b3b3b);color:inherit;transition:background .15s ease,border-color .15s ease;}
#feedbackConfirmCard button:hover{background:var(--btn-bg-hover,#4a4a4a);}
#feedbackConfirmCard .fb-c-ok.danger{border-color:var(--danger-border,rgba(232,96,125,.45));background:var(--danger-soft,rgba(232,96,125,.14));color:var(--danger,#e8607d);}
#feedbackConfirmCard .fb-c-ok.danger:hover{background:var(--danger-soft-hover,rgba(232,96,125,.24));border-color:var(--danger-border,rgba(232,96,125,.6));}
/* ── 2026-11-10 统一弹窗（ZCode 风）：图标标题 + 正文 + 输入 + 右对齐按钮 ── */
#feedbackConfirmCard .fb-c-head{display:flex;align-items:flex-start;gap:10px;margin:0 0 6px;}
#feedbackConfirmCard .fb-c-ico{flex:none;width:28px;height:28px;border-radius:9px;display:inline-flex;align-items:center;justify-content:center;background:rgba(127,127,127,.14);color:var(--accent,#7b82e8);}
#feedbackConfirmCard .fb-c-ico svg{width:16px;height:16px;display:block;}
#feedbackConfirmCard .fb-c-ico.danger{background:var(--danger-soft,rgba(232,96,125,.14));color:var(--danger,#e8607d);}
#feedbackConfirmCard .fb-c-title{margin:3px 0 0;font-size:15px;line-height:1.3;}
#feedbackConfirmCard .fb-c-input{width:100%;box-sizing:border-box;margin:10px 0 0;padding:9px 11px;border-radius:10px;border:1px solid var(--border,rgba(127,127,127,.35));background:var(--input-bg,rgba(127,127,127,.10));color:inherit;font:inherit;font-size:13px;outline:none;resize:vertical;min-height:38px;}
#feedbackConfirmCard .fb-c-input:focus{border-color:var(--accent,#7b82e8);box-shadow:0 0 0 3px var(--accent-soft,rgba(127,127,127,.18));}
#feedbackConfirmCard .fb-c-err{font-size:12px;color:var(--danger,#e8607d);min-height:16px;margin:6px 0 0;}
#feedbackConfirmCard button.fb-c-ok{background:var(--accent,#4a9eff);color:#fff;border-color:transparent;}
#feedbackConfirmCard button.fb-c-ok:hover{filter:brightness(1.06);}
#feedbackConfirmCard button.fb-c-ok:disabled{opacity:.55;cursor:default;filter:none;}
#feedbackConfirmCard button.fb-c-cancel{background:transparent;}
#feedbackConfirmCard button.fb-c-cancel:hover{background:rgba(127,127,127,.14);}
html[data-theme="glass"] #feedbackConfirmMask{background:rgba(24,48,70,.26);-webkit-backdrop-filter:blur(10px) saturate(130%);backdrop-filter:blur(10px) saturate(130%);}
html[data-theme="glass"] #feedbackConfirmCard{background:rgba(255,255,255,.88);border-color:rgba(255,255,255,.78);-webkit-backdrop-filter:blur(24px) saturate(180%);backdrop-filter:blur(24px) saturate(180%);box-shadow:0 30px 80px rgba(30,60,90,.26),inset 0 1px 0 rgba(255,255,255,.85);}
html[data-theme="glass"] #feedbackConfirmCard .fb-c-msg{color:#4a5a68;}
html[data-theme="glass"] #feedbackConfirmCard button.fb-c-cancel{background:rgba(15,30,60,.06);border-color:rgba(15,30,60,.14);}
@keyframes fbFadeIn{from{opacity:0}to{opacity:1}}
@keyframes fbPopIn{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:scale(1)}}
@media (prefers-reduced-motion:reduce){.fb-toast,#feedbackConfirmMask,#feedbackConfirmCard{transition:none;animation:none;}}
@media (max-width:640px){#feedbackToastHost{top:calc(10px + env(safe-area-inset-top,0px));width:100%;max-width:100vw;padding:0 14px;box-sizing:border-box;align-items:stretch;}#feedbackConfirmMask{padding:16px;}}
`;

  function ensureCss(){
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS_TEXT;
    (document.head || document.documentElement).appendChild(s);
  }

  const ICONS = {
    info: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg>',
    ok:   '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5.5"/></svg>',
    warn: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4L2.5 20h19L12 4z"/><path d="M12 10.5v4"/><path d="M12 17.4h.01"/></svg>',
    err:  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6"/><path d="M9 9l6 6"/></svg>'
  };

  function ensureHost(){
    ensureCss();
    let host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement("div");
      host.id = HOST_ID;
      host.setAttribute("aria-live", "polite");
      document.body.appendChild(host);
    }
    return host;
  }

  function toast(msg, opts){
    try {
      if (typeof opts === "number") opts = { ms: opts }; // 兼容旧调用 toast(msg, ms)
      const o = opts || {};
      const type = ICONS[o.type] ? o.type : "info";
      const host = ensureHost();
      const el = document.createElement("div");
      el.className = "fb-toast fb-" + type;
      el.setAttribute("role", "status");
      el.innerHTML = '<span class="fb-ico">' + ICONS[type] + '</span>';
      const txt = document.createElement("span");
      txt.className = "fb-txt";
      txt.textContent = msg == null ? "" : String(msg);
      el.appendChild(txt);
      host.appendChild(el);
      while (host.children.length > MAX_STACK) host.firstElementChild.remove();
      requestAnimationFrame(() => el.classList.add("fb-show"));
      const ms = Math.max(400, typeof o.ms === "number" ? o.ms : 2400);
      setTimeout(() => {
        el.classList.remove("fb-show");
        setTimeout(() => el.remove(), 240);
      }, ms);
      return el;
    } catch (e) {
      console.warn("[feedback] toast failed:", e);
      return null;
    }
  }

  // ── 2026-11-10 统一对话框：confirm / alert / prompt / dialog ─────────────
  // 设计：图标标题 + 正文 + 可选输入 + 右对齐按钮；全部走主题令牌（暗/亮/玻璃/烛光）。
  // onOk(value) 可返回 Promise：true 关闭；字符串 = 显示为该行错误并保持打开；false 保持打开。
  function dialog(opts){
    return new Promise((resolve) => {
      try {
        const o = (typeof opts === "string") ? { message: opts } : (opts || {});
        ensureCss();
        const mask = document.createElement("div");
        mask.id = MASK_ID;
        mask.setAttribute("role", "dialog");
        mask.setAttribute("aria-modal", "true");
        mask.setAttribute("aria-label", o.title || "确认");

        const card = document.createElement("div");
        card.id = "feedbackConfirmCard";

        const head = document.createElement("div");
        head.className = "fb-c-head";
        const ico = document.createElement("span");
        ico.className = "fb-c-ico" + (o.danger ? " danger" : "");
        ico.innerHTML = (o.icon || (o.danger ? ICONS.warn : ICONS.info));
        const title = document.createElement("h4");
        title.className = "fb-c-title";
        title.textContent = o.title || "确认";
        head.appendChild(ico);
        head.appendChild(title);

        const msgEl = document.createElement("p");
        msgEl.className = "fb-c-msg";
        msgEl.textContent = o.message == null ? "" : String(o.message);

        card.appendChild(head);
        card.appendChild(msgEl);

        let inputEl = null;
        if (o.input) {
          const cfg = (typeof o.input === "string") ? { type: o.input } : o.input;
          inputEl = document.createElement(cfg.multiline ? "textarea" : "input");
          if (!cfg.multiline) inputEl.type = cfg.type || "text";
          inputEl.className = "fb-c-input";
          if (cfg.placeholder) inputEl.placeholder = cfg.placeholder;
          if (cfg.value != null) inputEl.value = String(cfg.value);
          if (cfg.maxLength) inputEl.maxLength = cfg.maxLength;
          card.appendChild(inputEl);
        }
        const errEl = document.createElement("div");
        errEl.className = "fb-c-err";
        card.appendChild(errEl);

        const btns = document.createElement("div");
        btns.className = "fb-c-btns";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "fb-c-cancel";
        cancel.textContent = o.cancelText || "取消";
        const ok = document.createElement("button");
        ok.type = "button";
        ok.className = "fb-c-ok" + (o.danger ? " danger" : "");
        ok.textContent = o.okText || "确定";
        if (o.cancelText === null) cancel.style.display = "none";
        btns.appendChild(cancel);
        btns.appendChild(ok);
        card.appendChild(btns);

        mask.appendChild(card);
        document.body.appendChild(mask);

        let done = false, busy = false;
        const finish = (val) => {
          if (done) return;
          done = true;
          mask.remove();
          resolve(val);
        };
        const currentValue = () => (inputEl ? inputEl.value : undefined);
        async function submit(){
          if (busy) return;
          const v = currentValue();
          if (typeof o.onOk === "function") {
            busy = true; ok.disabled = true; errEl.textContent = "";
            try {
              const r = await o.onOk(v);
              busy = false; ok.disabled = false;
              if (r === false) return;
              if (typeof r === "string") { errEl.textContent = r; return; }
              finish(inputEl ? v : true);
            } catch (e) {
              busy = false; ok.disabled = false;
              errEl.textContent = (e && e.message) || String(e);
            }
            return;
          }
          finish(inputEl ? v : true);
        }
        mask.addEventListener("click", (e) => { if (e.target === mask) finish(null); });
        cancel.addEventListener("click", () => finish(null));
        ok.addEventListener("click", submit);
        mask.addEventListener("keydown", (e) => {
          if (e.key === "Escape") { e.stopPropagation(); finish(null); }
          else if (e.key === "Enter" && inputEl && inputEl.tagName !== "TEXTAREA") { e.preventDefault(); submit(); }
        });
        setTimeout(() => { if (inputEl) inputEl.focus(); else (o.danger ? cancel : ok).focus(); }, 30);
      } catch (e) {
        console.warn("[feedback] dialog failed:", e);
        if (opts && opts.input) {
          const v = window.prompt((opts && opts.message) || "", "");
          resolve(v == null ? null : v);
        } else {
          resolve(window.confirm((opts && opts.message) || "") ? true : null);
        }
      }
    });
  }

  function confirm(opts){
    const o = (typeof opts === "string") ? { message: opts } : (opts || {});
    return dialog(o).then((v) => v === true);
  }
  function alert(opts){
    const o = (typeof opts === "string") ? { message: opts } : (opts || {});
    o.okText = o.okText || "知道了";
    o.cancelText = null;
    return dialog(o).then(() => undefined);
  }
  function prompt(opts){
    const o = (typeof opts === "string") ? { message: opts } : (opts || {});
    if (!o.input) o.input = { type: "text" };
    return dialog(o);
  }

  window.__feedback = { toast, dialog, confirm, alert, prompt };
})();
