(function () {
/**
 * The private-mode gate, minus the DOM: which level the content-mode key is derived to, what an
 * unlock writes, what a relock removes, whether a chat body needs the unlock token, and how many taps
 * on the version tag count as "asked for the passphrase".
 *
 * The content-mode key is deliberately *derived*, never edited: locked writes `0`, unlocked writes
 * `3`, and this runs on every load so an earlier session's value cannot survive a relock. Several
 * modules read that key (themes, the image side, `data-nsfw` in the page), which is why it may not be
 * dropped altogether — only overwritten.
 *
 * An unlock also seeds the access token, because one passphrase is both the private-mode key and the
 * app password. That single write is why relock must clear the access token too: leaving it behind
 * kept every `/api/*` call authenticated after the user had visibly locked the app.
 * @module services/auth/unlock
 */

const UNLOCK_FLAG_KEY = "cfw_unlocked_v1";
const UNLOCK_TOKEN_KEY = "cfw_unlock_token_v1";
const AUTH_TOKEN_KEY = "cfw_auth_token_v1";
const CONTENT_MODE_KEY = "cfw_nsfw_mode_v1";
const DEV_MODE_KEY = "cfw_dev_mode_v1";
const THEME_KEY = "cfw_theme_v1";

/** Themes that only exist for the private mode; a relock falls back to the plain one. */
const PRIVATE_THEMES = ["lewd-peach", "lewd-doll", "candle"];
const FALLBACK_THEME = "minimal";

/** Taps on the version tag, and how long a gap still counts as the same run. */
const UNLOCK_TAPS = 7;
const TAP_WINDOW_MS = 1500;

/** The content-mode value implied by the lock state. */
function contentMode(unlocked         )         {
  return unlocked ? "3" : "0";
}

                        
              
                
 

/** What a successful unlock persists: the flag, both token keys, and the debug panel. */
function unlockWrites(token        )          {
  return [
    { key: UNLOCK_FLAG_KEY, value: "1" },
    { key: UNLOCK_TOKEN_KEY, value: token },
    { key: AUTH_TOKEN_KEY, value: token },
    { key: DEV_MODE_KEY, value: "1" },
  ];
}

/**
 * The access token to copy into the auth key at startup, or an empty string when there is nothing to
 * copy. Only fills a gap: an auth key the user already has is never replaced by the unlock token.
 */
function seedAuthToken(flag        , unlockToken        , authToken        )         {
  if (flag !== "1" || !unlockToken) return "";
  if (authToken) return "";
  return unlockToken;
}

                             
                                                                                            
                   
                                                                                  
                
                      
 

function relockPlan(theme        )             {
  return {
    remove: [UNLOCK_FLAG_KEY, UNLOCK_TOKEN_KEY, AUTH_TOKEN_KEY, DEV_MODE_KEY],
    theme: PRIVATE_THEMES.indexOf(theme) >= 0 ? FALLBACK_THEME : "",
    contentMode: contentMode(false),
  };
}

/**
 * The chat body with `unlockToken` added, or an empty string when the body should be left alone.
 *
 * Left alone means: not a chat request, still locked, no token, a body that is not JSON text, or a
 * body that does not parse. The wrapper then sends the original bytes untouched — a malformed body is
 * the server's call to reject, not ours to rewrite.
 */
function chatBodyWithUnlock(url        , unlocked         , token        , body         )         {
  if (url.indexOf("/api/chat") < 0) return "";
  if (!unlocked || !token) return "";
  if (typeof body !== "string") return "";
  let parsed         ;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    return "";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
  const out                          = {};
  for (const [k, v] of Object.entries(parsed)) out[k] = v;
  out.unlockToken = token;
  return JSON.stringify(out);
}

                           
                
               
 

/**
 * One tap folded into the run. A gap longer than the window starts a new run at 1, so a user who taps
 * four times in the morning and three times in the evening never opens the passphrase dialog.
 */
function nextTap(state          , now        , windowMs        )           {
  const sameRun = state.last > 0 && now - state.last <= windowMs;
  return { count: sameRun ? state.count + 1 : 1, last: now };
}

function tapFires(state          )          {
  return state.count >= UNLOCK_TAPS;
}

// Browser adapter, appended by l0/emit.mjs. Engine: services/auth/unlock.ts; this file owns the modal,
// the version-tag trigger, the html class and the reload.
//
// Default state is locked: everything marked [data-nsfw] stays hidden until the passphrase is proven.
// Unlocking sets `html.unlocked` and adds an unlock token to every /api/chat body; the real guard is
// in the worker, this is the visible half of it.
//
// Loaded after dev.js so its fetch patch sits outermost: the token has to be on the body before dev.js
// records the payload.
(function(){
  "use strict";
  var FLAG=UNLOCK_FLAG_KEY, TOK=UNLOCK_TOKEN_KEY;
  function unlocked(){ try{ return localStorage.getItem(FLAG)==="1"; }catch(e){ return false; } }
  function tok(){ try{ return localStorage.getItem(TOK)||""; }catch(e){ return ""; } }

  // The content-mode key is a derived value, and this is its only writer on load. Other modules may
  // write it at runtime (the image side, theme coupling), but the next load corrects it. It cannot be
  // removed either: chat-image, theme, tools and the page's own data-nsfw attribute all read it.
  function enforceMaxed(){
    try{
      localStorage.setItem(CONTENT_MODE_KEY, contentMode(unlocked()));
    }catch(e){}
  }
  // Run immediately, after the FOUC inline script and before any consumer reads the key.
  enforceMaxed();

  (function(){
    if(!window.fetch) return;
    var orig=window.fetch.bind(window);
    window.fetch=function(input,init){
      try{
        var url=typeof input==="string"?input:(input&&input.url)||"";
        var body=chatBodyWithUnlock(url, unlocked(), tok(), init && init.body);
        if(body) init=Object.assign({},init,{body:body});
      }catch(e){}
      return orig(input,init);
    };
  })();

  // One passphrase is both the private-mode key and the app password, so a previous unlock seeds the
  // auth key — but only when that key is empty.
  try{
    var seed = seedAuthToken(localStorage.getItem(FLAG)||"", localStorage.getItem(TOK)||"", localStorage.getItem(AUTH_TOKEN_KEY)||"");
    if(seed) localStorage.setItem(AUTH_TOKEN_KEY, seed);
  }catch(e){}

  function applyVisibility(){
    var on=unlocked();
    document.documentElement.classList.toggle("unlocked",on);
    if(on) document.querySelectorAll("[data-nsfw]").forEach(function(el){ if(el.style.display==="none") el.style.display=""; });
  }

  // Feedback goes through the shared toast when it is loaded; the fallback keeps a bare page usable.
  function toast(msg){
    if(window.__feedback&&window.__feedback.toast)return window.__feedback.toast(msg,{ms:1400});
    var t=document.createElement("div");
    t.textContent=msg;
    t.style.cssText="position:fixed;left:50%;top:24px;transform:translateX(-50%);padding:10px 18px;background:rgba(0,0,0,.88);color:#fff;border-radius:10px;font-size:13px;font-weight:600;z-index:99999;";
    document.body.appendChild(t);
    setTimeout(function(){ t.remove(); },1400);
  }

  var modal=null;
  function openPrompt(){
    if(modal){ modal.style.display="flex"; var ii=modal.querySelector("input"); if(ii){ ii.value=""; ii.focus(); } return; }
    modal=document.createElement("div");
    modal.style.cssText="position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:99998;padding:20px;backdrop-filter:blur(6px);box-sizing:border-box;";
    var box=document.createElement("div");
    box.style.cssText="box-sizing:border-box;width:100%;max-width:320px;background:var(--bg,#16161e);color:inherit;border:1px solid var(--border,rgba(127,127,127,.3));border-radius:16px;padding:22px 20px;box-shadow:0 24px 60px rgba(0,0,0,.5);";
    box.innerHTML='<div style="font-size:14px;font-weight:600;margin-bottom:12px;">访问码</div><input type="password" autocomplete="off" style="width:100%;box-sizing:border-box;padding:9px 11px;border-radius:9px;border:1px solid rgba(127,127,127,.3);background:rgba(127,127,127,.1);color:inherit;font-size:14px;"><div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;"><button data-c style="padding:7px 14px;border-radius:8px;border:1px solid rgba(127,127,127,.3);background:transparent;color:inherit;font-size:13px;cursor:pointer;">取消</button><button data-k style="padding:7px 14px;border-radius:8px;border:none;background:#9aa3ff;color:#fff;font-size:13px;cursor:pointer;">确定</button></div>';
    modal.appendChild(box);
    document.body.appendChild(modal);
    var input=box.querySelector("input"), ok=box.querySelector("[data-k]"), cancel=box.querySelector("[data-c]");
    function close(){ modal.style.display="none"; }
    function shake(){ if(box.animate) box.animate([{transform:"translateX(0)"},{transform:"translateX(-8px)"},{transform:"translateX(8px)"},{transform:"translateX(0)"}],{duration:280}); }
    function submit(){
      var v=(input.value||"").trim();
      if(!v){ shake(); return; }
      ok.disabled=true;
      fetch("/api/unlock",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:v})})
        .then(function(r){ return r.json().catch(function(){ return {ok:false}; }); })
        .then(function(d){
          ok.disabled=false;
          // Unlocking also opens the debug panel. It is a debugging surface, not a content gate, and
          // the settings page can close it again.
          if(d&&d.ok){
            try{
              var writes=unlockWrites(v);
              for(var wi=0;wi<writes.length;wi++) localStorage.setItem(writes[wi].key, writes[wi].value);
            }catch(e){}
            enforceMaxed(); close(); location.reload();
          }
          else{ input.value=""; shake(); }
        })
        .catch(function(){ ok.disabled=false; input.value=""; shake(); });
    }
    ok.addEventListener("click",submit);
    cancel.addEventListener("click",close);
    input.addEventListener("keydown",function(e){ if(e.key==="Enter") submit(); });
    modal.addEventListener("click",function(e){ if(e.target===modal) close(); });
    input.focus();
  }

  function wireTrigger(){
    ["appVersionTag","appVersionTagHome"].forEach(function(id){
      var tag=document.getElementById(id);
      if(!tag||tag.dataset.wired==="1") return;
      tag.dataset.wired="1";
      var taps={count:0,last:0};
      tag.addEventListener("click",function(){
        taps=nextTap(taps, Date.now(), TAP_WINDOW_MS);
        if(tapFires(taps)){ taps={count:0,last:0}; openPrompt(); }
      });
    });
  }

  function doRelock(){
    var plan=relockPlan("");
    try{
      plan=relockPlan(localStorage.getItem(THEME_KEY)||"");
      for(var i=0;i<plan.remove.length;i++) localStorage.removeItem(plan.remove[i]);
      if(plan.theme) localStorage.setItem(THEME_KEY, plan.theme);
      localStorage.setItem(CONTENT_MODE_KEY, plan.contentMode);
    }catch(e){}
    toast("已退出私密模式");
    setTimeout(function(){ location.reload(); },700);
  }
  function wireLockBtn(){
    if(!unlocked()) return;
    if(document.getElementById("relockBtn")) return;
    var b=document.createElement("button");
    b.id="relockBtn";
    // No lock emoji: the .smallbtn style already carries the context.
    b.textContent="退出私密模式";
    var footer=document.getElementById("settingsFooter");
    var host=footer?footer.querySelector(".btns"):null;
    if(host){
      b.className="smallbtn";
      b.addEventListener("click",doRelock);
      host.insertBefore(b,host.firstChild);
      return;
    }
    var tag=document.getElementById("appVersionTag");
    if(!tag) return;
    b.style.cssText="display:block;margin:10px auto 0;padding:6px 14px;border-radius:8px;border:1px solid rgba(127,127,127,.3);background:transparent;color:#9aa3ff;font-size:12px;cursor:pointer;";
    b.addEventListener("click",doRelock);
    tag.parentNode.insertBefore(b,tag.nextSibling);
  }

  document.addEventListener("DOMContentLoaded",function(){
    enforceMaxed(); applyVisibility(); wireTrigger(); wireLockBtn();
    var sb=document.getElementById("settingsBtn");
    if(sb) sb.addEventListener("click",function(){ setTimeout(wireLockBtn,120); });
  });
})();

globalThis.UNLOCK_FLAG_KEY = UNLOCK_FLAG_KEY;
globalThis.UNLOCK_TOKEN_KEY = UNLOCK_TOKEN_KEY;
globalThis.AUTH_TOKEN_KEY = AUTH_TOKEN_KEY;
globalThis.CONTENT_MODE_KEY = CONTENT_MODE_KEY;
globalThis.DEV_MODE_KEY = DEV_MODE_KEY;
globalThis.THEME_KEY = THEME_KEY;
globalThis.PRIVATE_THEMES = PRIVATE_THEMES;
globalThis.FALLBACK_THEME = FALLBACK_THEME;
globalThis.UNLOCK_TAPS = UNLOCK_TAPS;
globalThis.TAP_WINDOW_MS = TAP_WINDOW_MS;
globalThis.contentMode = contentMode;
globalThis.unlockWrites = unlockWrites;
globalThis.seedAuthToken = seedAuthToken;
globalThis.relockPlan = relockPlan;
globalThis.chatBodyWithUnlock = chatBodyWithUnlock;
globalThis.nextTap = nextTap;
globalThis.tapFires = tapFires;
})();
