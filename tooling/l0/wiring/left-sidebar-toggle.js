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
