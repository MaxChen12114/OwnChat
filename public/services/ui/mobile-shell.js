(function () {
/**
 * The mobile shell's decisions, minus the DOM: when a scroll gesture should hide or reveal the top
 * and bottom bars, where the topbar overflow menu opens, and whether a click outside it closes it.
 *
 * These rules only look trivial. The "not scrollable" branch exists because `#topbar` is
 * `position: sticky` and hiding it with `translateY(-110%)` does not give back the height it holds in
 * the flex flow, so a short conversation — or a session restored by `scrollToBottom()`, which looks
 * like a downward gesture — leaves an empty slot sitting on top of the text. Content that cannot
 * scroll therefore always shows the bar, and a programmatic jump resets the baseline instead of being
 * read as a scroll.
 *
 * The wiring owns the scroll listener, the rAF throttle, `matchMedia` and the real node moves; it
 * calls in here for every decision.
 * @module services/ui/mobile-shell
 */

/** Movement (px) below which a scroll event is treated as jitter and ignored. */
const MS_SCROLL_THRESHOLD = 8;

/** Content shorter than the viewport by less than this counts as "not scrollable". */
const MS_SCROLLABLE_SLACK = 80;

/** Within this distance from the top the bars always stay visible. */
const MS_TOP_EDGE = 40;

/** The overflow menu never hugs the viewport edge closer than this. */
const MS_MENU_MIN_LEFT = 8;

/** Fallback menu width when it has not been laid out yet (`offsetWidth` is 0 before first paint). */
const MS_MENU_DEFAULT_WIDTH = 160;

/** Vertical gap between the "more" button and its menu. */
const MS_MENU_GAP = 6;

/** What a scroll event means for the bars. `none` = below the jitter threshold, leave `lastY` alone. */
                                                    

/** A viewport rectangle, as `getBoundingClientRect()` reports it. */
                         
               
                  
                
                 
 

/** True while the container has enough content to scroll (by more than the slack). */
function msIsScrollable(scrollHeight        , clientHeight        , slack         = MS_SCROLLABLE_SLACK)          {
  return scrollHeight - clientHeight >= slack;
}

/**
 * Decide what one scroll position means. Order matters: an unscrollable container wins over
 * everything (that is the empty-slot fix), jitter changes nothing, the top edge always shows, and
 * only a genuine downward move hides.
 */
function msScrollAction(y        , lastY        , scrollable         )               {
  if (!scrollable) return "show";
  if (Math.abs(y - lastY) < MS_SCROLL_THRESHOLD) return "none";
  if (y < MS_TOP_EDGE) return "show";
  return y > lastY ? "hide" : "show";
}

/** Where the overflow menu goes: under the button, right-aligned, never past the left edge. */
function msMenuPosition(rect        , menuWidth        , scrollX        , scrollY        )                                {
  const bottom = typeof rect.bottom === "number" ? rect.bottom : 0;
  const right = typeof rect.right === "number" ? rect.right : 0;
  const width = menuWidth || MS_MENU_DEFAULT_WIDTH;
  return {
    top: bottom + scrollY + MS_MENU_GAP,
    left: Math.max(MS_MENU_MIN_LEFT, right - width) + scrollX,
  };
}

/** An open menu closes on any click that is neither inside it nor on its button. */
function msMenuShouldClose(open         , insideMenu         , onButton         )          {
  return open && !insideMenu && !onButton;
}

/** Which topbar layout applies at the current width. */
function msLayout(narrow         )                    {
  return narrow ? "menu" : "inline";
}

// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/ui/mobile-shell.ts; this file owns the
// real nodes: the scroll listener with its rAF throttle, the two comment anchors that let the topbar
// entries be moved into a menu and put back, and the matchMedia listener.
//
// Contract with app.js (frozen global, created once at boot):
//   const shell = window.__mobileShell.create({ getHistory: () => historyWrap });
//   shell.setupScrollHide(); shell.setupTopbarOverflow();
// and the scroll baseline reset that history restore / character switch / session switch call:
//   window.__navHideReset()      only exists after setupScrollHide ran with a real container.
(function (global) {
  "use strict";

  if (window.__mobileShell) return;

  window.__mobileShell = {
    create(host) {
      host = host || {};
      const doc = global.document;
      const historyWrap = typeof host.getHistory === "function" ? host.getHistory() : null;

      /**
       * Hide the bars while the user reads downward, reveal them on any upward move, at the top, or
       * when there is nothing to scroll. `lastY` is the baseline the next event is compared against;
       * `__navHideReset` is how a programmatic jump tells this listener "you did not see that scroll".
       */
      function setupScrollHide() {
        if (!historyWrap) return;
        let lastY = 0;
        let ticking = false;

        function reset() {
          doc.body.classList.remove("nav-hidden");
          lastY = historyWrap.scrollTop;
        }
        window.__navHideReset = reset;

        historyWrap.addEventListener(
          "scroll",
          () => {
            if (ticking) return;
            ticking = true;
            global.requestAnimationFrame(() => {
              ticking = false;
              const y = historyWrap.scrollTop;
              const action = msScrollAction(y, lastY, msIsScrollable(historyWrap.scrollHeight, historyWrap.clientHeight));
              if (action === "show") doc.body.classList.remove("nav-hidden");
              else if (action === "hide") doc.body.classList.add("nav-hidden");
              if (action !== "none") lastY = y;
            });
          },
          { passive: true }
        );
      }

      /**
       * On phones in dev mode the topbar's pause and dev entries collide with the model picker, so both
       * move into a "more" dropdown. The move is of the real nodes (event bindings survive), and each
       * original position keeps a comment node as the anchor to put them back on a wide viewport.
       */
      function setupTopbarOverflow() {
        const moreBtn = doc.getElementById("topbarMoreBtn");
        const pauseBtn = doc.getElementById("syncPauseBtn");
        const devBadge = doc.getElementById("devBadgeTopbar");
        if (!moreBtn || (!pauseBtn && !devBadge)) return;

        const pauseAnchor = pauseBtn ? doc.createComment("pause-home") : null;
        const devAnchor = devBadge ? doc.createComment("dev-home") : null;
        if (pauseBtn && pauseAnchor) pauseBtn.parentNode.insertBefore(pauseAnchor, pauseBtn);
        if (devBadge && devAnchor) devBadge.parentNode.insertBefore(devAnchor, devBadge);

        const menu = doc.createElement("div");
        menu.id = "topbarMoreMenu";
        menu.style.display = "none";
        doc.body.appendChild(menu);

        let open = false;
        function closeMenu() {
          open = false;
          menu.style.display = "none";
        }
        function openMenu() {
          open = true;
          menu.style.display = "flex";
          const pos = msMenuPosition(moreBtn.getBoundingClientRect(), menu.offsetWidth, global.scrollX, global.scrollY);
          menu.style.top = pos.top + "px";
          menu.style.left = pos.left + "px";
        }

        moreBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (open) closeMenu();
          else openMenu();
        });
        doc.addEventListener("click", (e) => {
          const insideMenu = menu.contains(e.target);
          const onButton = e.target === moreBtn || (moreBtn.contains && moreBtn.contains(e.target));
          if (msMenuShouldClose(open, !!insideMenu, !!onButton)) closeMenu();
        });

        const mq = global.matchMedia("(max-width: 1023px)");
        function apply() {
          if (msLayout(mq.matches) === "menu") {
            if (pauseBtn && pauseBtn.parentNode !== menu) menu.appendChild(pauseBtn);
            if (devBadge && devBadge.parentNode !== menu) menu.appendChild(devBadge);
          } else {
            // Put each entry back where its anchor sits; an anchor removed by a re-render means the
            // node stays where it is rather than being appended somewhere arbitrary.
            if (pauseBtn && pauseAnchor && pauseAnchor.parentNode) pauseAnchor.parentNode.insertBefore(pauseBtn, pauseAnchor);
            if (devBadge && devAnchor && devAnchor.parentNode) devAnchor.parentNode.insertBefore(devBadge, devAnchor);
            closeMenu();
          }
        }
        apply();
        // Older WebViews only have addListener; a missing change event leaves the initial apply() in force.
        if (mq.addEventListener) mq.addEventListener("change", apply);
        else if (mq.addListener) mq.addListener(apply);
      }

      return { setupScrollHide, setupTopbarOverflow };
    },
  };
})(typeof globalThis !== "undefined" ? globalThis : this);

globalThis.MS_SCROLL_THRESHOLD = MS_SCROLL_THRESHOLD;
globalThis.MS_SCROLLABLE_SLACK = MS_SCROLLABLE_SLACK;
globalThis.MS_TOP_EDGE = MS_TOP_EDGE;
globalThis.MS_MENU_MIN_LEFT = MS_MENU_MIN_LEFT;
globalThis.MS_MENU_DEFAULT_WIDTH = MS_MENU_DEFAULT_WIDTH;
globalThis.MS_MENU_GAP = MS_MENU_GAP;
globalThis.msIsScrollable = msIsScrollable;
globalThis.msScrollAction = msScrollAction;
globalThis.msMenuPosition = msMenuPosition;
globalThis.msMenuShouldClose = msMenuShouldClose;
globalThis.msLayout = msLayout;
})();
