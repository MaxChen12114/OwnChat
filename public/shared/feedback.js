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
.fb-toast.fb-err .fb-ico{color:#e8607d;}
#feedbackConfirmMask{position:fixed;inset:0;background:rgba(0,0,0,.5);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;z-index:99998;padding:20px;box-sizing:border-box;animation:fbFadeIn .16s ease;}
#feedbackConfirmCard{background:var(--bg,#0b0b0b);color:inherit;border:1px solid var(--border,#2a2a2a);border-radius:18px;padding:20px;width:100%;max-width:360px;box-shadow:0 30px 80px rgba(0,0,0,.5);font-family:var(--chat-font-family,ui-sans-serif,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif);box-sizing:border-box;animation:fbPopIn .18s ease;}
#feedbackConfirmCard .fb-c-title{font-size:15px;font-weight:700;margin:0 0 10px;}
#feedbackConfirmCard .fb-c-msg{font-size:13px;line-height:1.65;color:var(--muted,#9a9a9a);white-space:pre-wrap;word-break:break-word;margin:0 0 16px;max-height:50vh;overflow:auto;}
#feedbackConfirmCard .fb-c-btns{display:flex;gap:10px;justify-content:flex-end;}
#feedbackConfirmCard button{font:600 13px/1 var(--chat-font-family,ui-sans-serif,sans-serif);padding:9px 16px;border-radius:10px;cursor:pointer;border:1px solid var(--border,#2a2a2a);background:var(--btn-bg,#3b3b3b);color:inherit;transition:background .15s ease,border-color .15s ease;}
#feedbackConfirmCard button:hover{background:var(--btn-bg-hover,#4a4a4a);}
#feedbackConfirmCard .fb-c-ok.danger{border-color:rgba(232,96,125,.45);background:rgba(232,96,125,.14);color:#e8607d;}
#feedbackConfirmCard .fb-c-ok.danger:hover{background:rgba(232,96,125,.24);border-color:rgba(232,96,125,.6);}
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

  function confirm(opts){
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

        const title = document.createElement("h4");
        title.className = "fb-c-title";
        title.textContent = o.title || "确认";

        const msgEl = document.createElement("p");
        msgEl.className = "fb-c-msg";
        msgEl.textContent = o.message == null ? "" : String(o.message);

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
        btns.appendChild(cancel);
        btns.appendChild(ok);

        card.appendChild(title);
        card.appendChild(msgEl);
        card.appendChild(btns);
        mask.appendChild(card);
        document.body.appendChild(mask);

        let done = false;
        const finish = (val) => {
          if (done) return;
          done = true;
          mask.remove();
          resolve(val);
        };
        mask.addEventListener("click", (e) => { if (e.target === mask) finish(false); });
        cancel.addEventListener("click", () => finish(false));
        ok.addEventListener("click", () => finish(true));
        // Esc 只绑在 mask 上(初始焦点在按钮内,事件会冒泡到 mask),不污染全局快捷键
        mask.addEventListener("keydown", (e) => {
          if (e.key === "Escape") { e.stopPropagation(); finish(false); }
        });
        (o.danger ? cancel : ok).focus();
      } catch (e) {
        console.warn("[feedback] confirm failed, falling back to window.confirm:", e);
        resolve(window.confirm((opts && opts.message) || ""));
      }
    });
  }

  window.__feedback = { toast, confirm };
})();
