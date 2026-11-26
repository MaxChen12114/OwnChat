// Browser adapter, appended by l0/emit.mjs. Engine: services/ui/mobile-shell.ts; this file owns the
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
