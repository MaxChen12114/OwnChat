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

  // One switch, two directions; leaving is a mode change, not a logout.
  //
  // Keeping the access token on the way out is deliberate: the same passphrase is the app password,
  // so dropping it would sign the user out of sync just because they wanted the plain UI. The
  // content gate still closes — chat bodies stop carrying `unlockToken`, and the worker picks the
  // private registry only from that token.
  function doRelock(){
    var plan=relockPlan("");
    try{
      plan=relockPlan(localStorage.getItem(THEME_KEY)||"", true);
      for(var i=0;i<plan.remove.length;i++) localStorage.removeItem(plan.remove[i]);
      if(plan.theme) localStorage.setItem(THEME_KEY, plan.theme);
      localStorage.setItem(CONTENT_MODE_KEY, plan.contentMode);
    }catch(e){}
    toast("已退出私密模式");
    setTimeout(function(){ location.reload(); },700);
  }

  // Reopening asks for nothing: a stored access token means the passphrase was accepted on this
  // device already. No token means the caller is a fresh visitor and wireSwitch never offered this.
  function doResume(){
    try{
      var atok=localStorage.getItem(AUTH_TOKEN_KEY)||"";
      if(!atok) return;
      var writes=resumeWrites(atok);
      for(var i=0;i<writes.length;i++) localStorage.setItem(writes[i].key, writes[i].value);
    }catch(e){}
    location.reload();
  }

  function wireSwitch(){
    if(document.getElementById("relockBtn")) return;
    var on=unlocked();
    var atok="";
    try{ atok=localStorage.getItem(AUTH_TOKEN_KEY)||""; }catch(e){}
    // Locked visitors without a token see nothing: the switch must not advertise what it switches.
    // Unlocked always gets the way out, token or not — a one-way door is worse than a leaked word.
    if(!on && !canResume(atok, "0")) return;
    var b=document.createElement("button");
    b.id="relockBtn";
    b.textContent=on?"退出私密模式":"进入私密模式";
    b.addEventListener("click", on?doRelock:doResume);
    var footer=document.getElementById("settingsFooter");
    var host=footer?footer.querySelector(".btns"):null;
    if(host){
      b.className="smallbtn";
      host.insertBefore(b,host.firstChild);
      return;
    }
    var tag=document.getElementById("appVersionTag");
    if(!tag) return;
    b.style.cssText="display:block;margin:10px auto 0;padding:6px 14px;border-radius:8px;border:1px solid rgba(127,127,127,.3);background:transparent;color:#9aa3ff;font-size:12px;cursor:pointer;";
    tag.parentNode.insertBefore(b,tag.nextSibling);
  }

  document.addEventListener("DOMContentLoaded",function(){
    enforceMaxed(); applyVisibility(); wireTrigger(); wireSwitch();
    var sb=document.getElementById("settingsBtn");
    if(sb) sb.addEventListener("click",function(){ setTimeout(wireSwitch,120); });
  });
})();