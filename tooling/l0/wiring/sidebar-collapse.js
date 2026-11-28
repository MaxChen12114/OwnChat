// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/ui/sidebar-collapse.ts
// (stored flag, viewport override, toggle result and button state); this file owns
// class toggling, animation and the event listeners.
(function () {
  var btn = document.getElementById('sidebarCollapseBtn');
  if (!btn) return;
  var KEY = SBC_KEY;
  var html = document.documentElement;
  function apply(on, anim) {
    html.classList.toggle('left-collapsed', on);
    var st = sbcButtonState(on);
    btn.setAttribute('aria-expanded', st.expanded);
    btn.title = st.title;
    btn.setAttribute('aria-label', btn.title);
    if (anim) {
      html.classList.add('left-anim');
      setTimeout(function () { html.classList.remove('left-anim'); window.dispatchEvent(new Event('resize')); }, 300);
    }
  }
  apply(html.classList.contains('left-collapsed'), false);
  var mqMobile = window.matchMedia('(max-width: 1023px)');
  function syncCollapseForViewport() {
    apply(sbcViewportOn(mqMobile.matches, localStorage.getItem(KEY)), false);
  }
  if (mqMobile.addEventListener) mqMobile.addEventListener('change', syncCollapseForViewport);
  else if (mqMobile.addListener) mqMobile.addListener(syncCollapseForViewport);
  syncCollapseForViewport();
  btn.addEventListener('click', function () {
    var on = sbcNextOn(html.classList.contains('left-collapsed'));
    try { localStorage.setItem(KEY, sbcStoredValue(on)); } catch (e) {}
    apply(on, true);
  });
})();
