(function () {
/**
 * Left-sidebar toggle: the mobile drawer open/close for the left navigation.
 *
 * The engine answers two decisions only — whether a sidebar tap should auto-close the drawer and
 * whether Escape closes it — plus the open/close class flips; every DOM lookup, listener and the
 * 60ms close delay arrive through {@link TogglePorts}, so the plan asserts in a vm without a
 * document. The close button is handled separately by its own listener and never double-fires.
 * @module services/ui/left-sidebar-toggle
 */

/** Ports: body class flips, media query, delegated closest lookup and the close scheduler. */
                              
                                             
                    
                                                
                       
                                                  
                       
                                                            
                           
                                                                                      
                                                                             
                                                                                             
                                             
 

/** Public surface; no frozen contract — the wiring binds everything at boot. */
                            
               
                
                                                                                                       
                                        
                                                                
                               
                                                                                       
 

/** The selector the wiring feeds into {@link autoCloseDecision}; kept here so test and product agree. */
const AUTO_CLOSE_SELECTOR = ".sidebar-btn:not([disabled]),.sidebar-close";

/**
 * Decide whether a sidebar tap auto-closes the drawer. Mobile-only; a tap that missed every
 * eligible button does nothing, and the dedicated close button is excluded (it closes itself).
 * @param matches - whether the mobile media query matches.
 * @param hit - the `closest` hit for {@link AUTO_CLOSE_SELECTOR}, `null` on a miss.
 * @returns `true` when the drawer should close after a 60ms delay.
 */
function autoCloseDecision(matches         , hit                                )          {
  if (!matches) return false;
  if (hit === null) return false;
  if (hit["id"] === "sidebarCloseBtn") return false;
  return true;
}

/** Create the handlers. Nothing is bound here; the wiring owns every listener. */
function createLeftSidebarToggle(ports             )            {
  function open()       {
    ports.drawerAdd();
  }
  function close()       {
    ports.drawerRemove();
  }
  function onSidebarClick(target         )       {
    const hit = ports.closest(target, AUTO_CLOSE_SELECTOR);
    if (!autoCloseDecision(ports.matchesMobile(), hit)) return;
    ports.schedule(close, 60);
  }
  function onKeydown(key        )       {
    if (key === "Escape" && ports.drawerHas()) close();
  }
  return { open: open, close: close, onSidebarClick: onSidebarClick, onKeydown: onKeydown };
}

// Browser wiring (injected by tooling/l0/emit.mjs): binds the drawer listeners; no frozen contract,
// the old inline script was an anonymous IIFE with no window surface.
(function () {
  var body = document.body;
  var menuBtn = document.getElementById("menuToggle");
  var closeBtn = document.getElementById("sidebarCloseBtn");
  var backdrop = document.getElementById("sidebarBackdrop");
  var sidebar = document.getElementById("leftSidebar");
  if (!menuBtn || !sidebar) return;
  var mq = window.matchMedia ? window.matchMedia("(max-width: 1023px)") : null;
  var api = createLeftSidebarToggle({
    drawerAdd: function () { body.classList.add("drawer-open"); },
    drawerRemove: function () { body.classList.remove("drawer-open"); },
    drawerHas: function () { return body.classList.contains("drawer-open"); },
    matchesMobile: function () { try { return !!mq && mq.matches; } catch (e) { return false; } },
    closest: function (target, selector) {
      try {
        return target && typeof target.closest === "function" ? target.closest(selector) : null;
      } catch (e) {
        return null;
      }
    },
    schedule: function (fn, ms) { setTimeout(fn, ms); },
  });
  menuBtn.addEventListener("click", api.open);
  if (closeBtn) closeBtn.addEventListener("click", api.close);
  if (backdrop) backdrop.addEventListener("click", api.close);
  // 手机上点抽屉里任意可用按钮后自动关闭,避免点完还要手动 ✕
  sidebar.addEventListener("click", function (e) { api.onSidebarClick(e.target); });
  document.addEventListener("keydown", function (e) { api.onKeydown(e.key); });
})();

globalThis.AUTO_CLOSE_SELECTOR = AUTO_CLOSE_SELECTOR;
globalThis.autoCloseDecision = autoCloseDecision;
globalThis.createLeftSidebarToggle = createLeftSidebarToggle;
})();
