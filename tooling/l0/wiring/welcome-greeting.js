// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/ui/welcome-greeting.ts
// (desktop detection, greeting and empty-chat count); this file owns DOM classes,
// the MutationObserver and the click handlers.
(function(){
  var html = document.documentElement;
  try { if (wgrIsDesktop((window.tauriSvc ? window.tauriSvc.presence() : { tauri: false, internals: false, isTauri: false, metadata: false }), navigator.userAgent, location.protocol, location.hostname)) html.classList.add('is-desktop'); } catch(e){}
  var wrap = document.getElementById('ownchatWelcome');
  var chat = document.getElementById('chat');
  if (!wrap || !chat) return;
  try { var g = wgrGreeting(new Date().getHours()); var ge = document.getElementById('owGreeting'); if (ge) ge.textContent = g; } catch(e){}
  function refresh(){
    var kids = chat.children;
    var ids = [];
    for (var i = 0; i < kids.length; i++) ids.push(kids[i].id);
    html.classList.toggle('chat-empty', wgrIsEmpty(wgrChatCount(ids)));
  }
  try { new MutationObserver(refresh).observe(chat, { childList: true }); } catch(e){}
  refresh(); setTimeout(refresh, 400); setTimeout(refresh, 1500);
  wrap.addEventListener('click', function(e){
    var card = e.target.closest('.ow-card'); if (!card) return;
    var p = card.getAttribute('data-prompt') || '';
    var ta = document.getElementById('msg');
    if (ta) { ta.value = p; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus(); }
  });
  var cb = document.getElementById('owCloseBtn');
  if (cb) cb.addEventListener('click', function(){ try { localStorage.setItem('cfw_welcome_dismissed_v1', '1'); } catch(e){} html.classList.add('welcome-dismissed'); });
})();
