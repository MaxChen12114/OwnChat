(function () {
/**
 * Welcome-screen rules: desktop detection, the time-of-day greeting and the empty-chat count.
 * The wiring owns the DOM classes, the MutationObserver and the click handlers.
 *
 * The chat container always holds structural spacer/welcome nodes; counting every child would
 * keep the empty state hidden forever. Mobile desktop flags are caller-supplied so the same
 * predicate can be asserted without a Tauri runtime.
 * @module services/ui/welcome-greeting
 */

const WGR_DISMISS_KEY = "cfw_welcome_dismissed_v1";

/** @returns the greeting for a local hour in [0, 23]. */
function wgrGreeting(hour        )         {
  if (hour < 5) return "夜深了";
  if (hour < 11) return "上午好";
  if (hour < 13) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

/** @returns whether the page runs inside a desktop shell. */
function wgrIsDesktop(
  flags                                                                             ,
  ua        ,
  protocol        ,
  hostname        ,
)          {
  return !!(
    flags.tauri || flags.internals || flags.isTauri || flags.metadata
    || /Tauri/i.test(ua) || protocol === "tauri:" || hostname === "tauri.localhost"
  );
}

/** @returns the number of real message rows, ignoring the two structural children. */
function wgrChatCount(ids                               )         {
  let n = 0;
  for (const id of ids) if (id !== "bottom-spacer" && id !== "ownchatWelcome") n++;
  return n;
}

/** @returns whether the welcome screen should be shown. */
function wgrIsEmpty(count        )          {
  return count === 0;
}

// Browser adapter, appended by l0/emit.mjs. Engine: services/ui/welcome-greeting.ts
// (desktop detection, greeting and empty-chat count); this file owns DOM classes,
// the MutationObserver and the click handlers.
(function(){
  var html = document.documentElement;
  try { if (wgrIsDesktop({ tauri: !!window.__TAURI__, internals: !!window.__TAURI_INTERNALS__, isTauri: !!window.isTauri, metadata: !!window.__TAURI_METADATA__ }, navigator.userAgent, location.protocol, location.hostname)) html.classList.add('is-desktop'); } catch(e){}
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

globalThis.WGR_DISMISS_KEY = WGR_DISMISS_KEY;
globalThis.wgrGreeting = wgrGreeting;
globalThis.wgrIsDesktop = wgrIsDesktop;
globalThis.wgrChatCount = wgrChatCount;
globalThis.wgrIsEmpty = wgrIsEmpty;
})();
