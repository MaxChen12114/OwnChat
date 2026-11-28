(function () {
/**
 * Unified feedback surface — one toast stack and one modal, both theme-token driven.
 *
 * Colours come only from `:root` variables with the default theme's values as fallbacks, so the four
 * shipped themes (default / minimal / glass / candle) and both light and dark are handled without a
 * single branch here. Message text is always written through `textContent`: a toast argument is
 * user data, not markup, and the only HTML this module sets is its own constant icon SVG.
 *
 * Z-order is a contract, not a taste: toast 99999 > confirm 99998 > dev panel 99997. The unlock
 * access-code dialog also sits at 99998 and is never open at the same time as a confirm, which is why
 * they can share a level.
 *
 * The whole DOM arrives through {@link FeedbackEnv.doc}; the modal's state machine (busy flag,
 * promise settlement, Esc/Enter rules) lives here because it is the part worth testing.
 *
 * Lock: none upstream — this file's behaviour was pinned only by manual use, so the split is kept
 * literal: the body below is the old body with `document` renamed to `doc`.
 * @module services/ui/feedback
 */

const FEEDBACK_STYLE_ID = "feedbackStyles";
const FEEDBACK_HOST_ID = "feedbackToastHost";
const FEEDBACK_MASK_ID = "feedbackConfirmMask";
/** At most four toasts on screen; a fifth pushes the oldest out. */
const FEEDBACK_MAX_STACK = 4;

const FEEDBACK_CSS = `
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

/** The DOM surface this module touches; declared structurally so no DOM lib is required. */
                                  
             
                    
                    
                      
                             
                    
                
               
                      
                    
                  
                               
                                                                                         
                                     
                                                                     
                                                  
                                                       
                                                                        
                 
                
 

                                
                  
               
                          
                         
 

                              
                                                     
                                              
                        
                                   
                        
 

                                        
                 
                    
                  
                             
                   
                
                                                                                                     
                  
                                     
 

                                       
                
              
 

                              
                   
                                                                                                     
                             
                                                      
                                                         
                                     
 

                              
                                                              
                                           
                                            
                                       
                                           
 

const FEEDBACK_ICONS                         = {
  info: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg>',
  ok: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5.5"/></svg>',
  warn: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4L2.5 20h19L12 4z"/><path d="M12 10.5v4"/><path d="M12 17.4h.01"/></svg>',
  err: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6"/><path d="M9 9l6 6"/></svg>',
};

function recOf(value         )                          {
  const out                          = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) out[k] = v;
  }
  return out;
}

function createFeedback(env             )              {
  const doc = env.doc;
  const raf = typeof env.raf === "function" ? env.raf : (fn            ) => setTimeout(fn, 0);

  function ensureCss()       {
    if (doc.getElementById(FEEDBACK_STYLE_ID)) return;
    const s = doc.createElement("style");
    s.id = FEEDBACK_STYLE_ID;
    s.textContent = FEEDBACK_CSS;
    (doc.head || doc.documentElement).appendChild(s);
  }

  function ensureHost()                  {
    ensureCss();
    let host = doc.getElementById(FEEDBACK_HOST_ID);
    if (!host) {
      host = doc.createElement("div");
      host.id = FEEDBACK_HOST_ID;
      host.setAttribute("aria-live", "polite");
      doc.body.appendChild(host);
    }
    return host;
  }

  /**
   * Shows a toast.
   * @param opts either `{ type, ms }` or a bare number of milliseconds (the old signature).
   * @returns the toast element, or null when the DOM path failed — a failed toast must never throw
   * into the caller, because it is called from error paths.
   */
  function toast(msg         , opts          )                         {
    try {
      const o = typeof opts === "number" ? { ms: opts } : recOf(opts);
      const type = typeof o.type === "string" && FEEDBACK_ICONS[o.type] ? o.type : "info";
      const host = ensureHost();
      const el = doc.createElement("div");
      el.className = "fb-toast fb-" + type;
      el.setAttribute("role", "status");
      el.innerHTML = '<span class="fb-ico">' + FEEDBACK_ICONS[type] + "</span>";
      const txt = doc.createElement("span");
      txt.className = "fb-txt";
      txt.textContent = msg == null ? "" : String(msg);
      el.appendChild(txt);
      host.appendChild(el);
      while (host.children.length > FEEDBACK_MAX_STACK) host.firstElementChild.remove();
      raf(() => el.classList.add("fb-show"));
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

  /**
   * Opens the modal and settles when it closes.
   * @returns `true` when the confirm button was used with no input, the input's value when the
   * dialog has an input, and `null` for cancel / Esc / backdrop / a `false`-returning `onOk`.
   * @remarks `onOk` may return a promise: `false` keeps the dialog open, a string is shown as the
   * inline error and keeps it open, anything else closes it. While `onOk` runs, the confirm button is
   * disabled so a double click cannot submit twice.
   */
  function dialog(opts          )                   {
    return new Promise((resolve) => {
      try {
        const o = typeof opts === "string" ? { message: opts } : recOf(opts);
        const title0 = o.title;
        ensureCss();
        const mask = doc.createElement("div");
        mask.id = FEEDBACK_MASK_ID;
        mask.setAttribute("role", "dialog");
        mask.setAttribute("aria-modal", "true");
        mask.setAttribute("aria-label", typeof title0 === "string" && title0 ? title0 : "确认");

        const card = doc.createElement("div");
        card.id = "feedbackConfirmCard";

        const head = doc.createElement("div");
        head.className = "fb-c-head";
        const ico = doc.createElement("span");
        ico.className = "fb-c-ico" + (o.danger ? " danger" : "");
        ico.innerHTML = typeof o.icon === "string" && o.icon ? o.icon : o.danger ? FEEDBACK_ICONS.warn : FEEDBACK_ICONS.info;
        const title = doc.createElement("h4");
        title.className = "fb-c-title";
        title.textContent = typeof title0 === "string" && title0 ? title0 : "确认";
        head.appendChild(ico);
        head.appendChild(title);

        const msgEl = doc.createElement("p");
        msgEl.className = "fb-c-msg";
        msgEl.textContent = o.message == null ? "" : String(o.message);

        card.appendChild(head);
        card.appendChild(msgEl);

        let inputEl                         = null;
        if (o.input) {
          const cfg                          = typeof o.input === "string" ? { type: o.input } : recOf(o.input);
          inputEl = doc.createElement(cfg.multiline ? "textarea" : "input");
          if (!cfg.multiline) inputEl.type = typeof cfg.type === "string" ? cfg.type : "text";
          inputEl.className = "fb-c-input";
          if (typeof cfg.placeholder === "string" && cfg.placeholder) inputEl.placeholder = cfg.placeholder;
          if (cfg.value != null) inputEl.value = String(cfg.value);
          if (typeof cfg.maxLength === "number" && cfg.maxLength) inputEl.maxLength = cfg.maxLength;
          card.appendChild(inputEl);
        }
        const errEl = doc.createElement("div");
        errEl.className = "fb-c-err";
        card.appendChild(errEl);

        const btns = doc.createElement("div");
        btns.className = "fb-c-btns";
        const cancel = doc.createElement("button");
        cancel.type = "button";
        cancel.className = "fb-c-cancel";
        cancel.textContent = typeof o.cancelText === "string" && o.cancelText ? o.cancelText : "取消";
        const ok = doc.createElement("button");
        ok.type = "button";
        ok.className = "fb-c-ok" + (o.danger ? " danger" : "");
        ok.textContent = typeof o.okText === "string" && o.okText ? o.okText : "确定";
        if (o.cancelText === null) cancel.style.display = "none";
        btns.appendChild(cancel);
        btns.appendChild(ok);
        card.appendChild(btns);

        mask.appendChild(card);
        doc.body.appendChild(mask);

        let done = false;
        let busy = false;
        const finish = (val         ) => {
          if (done) return;
          done = true;
          mask.remove();
          resolve(val);
        };
        const currentValue = () => (inputEl ? inputEl.value : undefined);
        async function submit()                {
          if (busy) return;
          const v = currentValue();
          if (typeof o.onOk === "function") {
            busy = true;
            ok.disabled = true;
            errEl.textContent = "";
            try {
              const r = await o.onOk(v);
              busy = false;
              ok.disabled = false;
              if (r === false) return;
              if (typeof r === "string") {
                errEl.textContent = r;
                return;
              }
              finish(inputEl ? v : true);
            } catch (e) {
              busy = false;
              ok.disabled = false;
              const em = recOf(e).message;
              errEl.textContent = em ? String(em) : String(e);
            }
            return;
          }
          finish(inputEl ? v : true);
        }
        mask.addEventListener("click", (e) => {
          if (e.target === mask) finish(null);
        });
        cancel.addEventListener("click", () => finish(null));
        ok.addEventListener("click", submit);
        mask.addEventListener("keydown", (e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            finish(null);
          } else if (e.key === "Enter" && inputEl && inputEl.tagName !== "TEXTAREA") {
            e.preventDefault();
            submit();
          }
        });
        setTimeout(() => {
          if (inputEl) inputEl.focus();
          else (o.danger ? cancel : ok).focus();
        }, 30);
      } catch (e) {
        console.warn("[feedback] dialog failed:", e);
        const o = typeof opts === "string" ? { message: opts } : recOf(opts);
        if (o.input) {
          const v = env.prompt ? env.prompt(String(o.message || ""), "") : null;
          resolve(v == null ? null : v);
        } else {
          const yes = env.confirm ? env.confirm(String(o.message || "")) : false;
          resolve(yes ? true : null);
        }
      }
    });
  }

  function confirm(opts          )                   {
    const o = typeof opts === "string" ? { message: opts } : recOf(opts);
    return dialog(o).then((v) => v === true);
  }

  function alert(opts          )                {
    const o = typeof opts === "string" ? { message: opts } : recOf(opts);
    o.okText = o.okText || "知道了";
    o.cancelText = null;
    return dialog(o).then(() => undefined);
  }

  function prompt(opts          )                   {
    const o = typeof opts === "string" ? { message: opts } : recOf(opts);
    if (!o.input) o.input = { type: "text" };
    return dialog(o);
  }

  return { toast: toast, dialog: dialog, confirm: confirm, alert: alert, prompt: prompt };
}

// ── Browser wiring (injected by tooling/l0/emit.mjs): binds the service to the frozen window contract name ──
// The implementation moved to services/ui/feedback.ts. Ports are the document, requestAnimationFrame
// and the two native fallbacks used only when the DOM path throws. `document` is captured once —
// its identity is stable for the page's life, and the old code read the same object every call.
(function () {
  if (window.feedbackSvc) return;
  window.feedbackSvc = createFeedback({
    doc: window.document,
    raf: function (fn) { return window.requestAnimationFrame(fn); },
    prompt: function (message, value) { return window.prompt(message, value); },
    confirm: function (message) { return window.confirm(message); },
  });
})();

globalThis.createFeedback = createFeedback;
})();
