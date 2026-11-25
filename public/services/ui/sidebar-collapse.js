(function () {
/**
 * Desktop left-sidebar collapse rules: stored value, viewport override, toggle result and button
 * state. The wiring owns the class toggling, animation and event listeners.
 *
 * Mobile always forces the sidebar open: the collapsed state is a desktop narrow-ridge state, and
 * restoring it on a phone leaves the drawer as a single icon column with no group headings.
 * @module services/ui/sidebar-collapse
 */

const SBC_KEY = "cfw_left_collapsed_v1";

/** @returns whether the stored flag means collapsed. */
function sbcStoredOn(raw         )          {
  return raw === "1";
}

/** @returns the state for the current viewport. */
function sbcViewportOn(isMobile         , raw         )          {
  return isMobile ? false : sbcStoredOn(raw);
}

/** @returns the state after a toggle click. */
function sbcNextOn(current         )          {
  return !current;
}

/** @returns the value to persist. */
function sbcStoredValue(on         )         {
  return on ? "1" : "0";
}

/** @returns the aria-expanded value and the tooltip for a state. */
function sbcButtonState(on         )                                      {
  return {
    expanded: on ? "false" : "true",
    title: on ? "展开侧栏" : "折叠侧栏（收起成一条）",
  };
}

// Browser adapter, appended by l0/emit.mjs. Engine: services/ui/sidebar-collapse.ts
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

globalThis.SBC_KEY = SBC_KEY;
globalThis.sbcStoredOn = sbcStoredOn;
globalThis.sbcViewportOn = sbcViewportOn;
globalThis.sbcNextOn = sbcNextOn;
globalThis.sbcStoredValue = sbcStoredValue;
globalThis.sbcButtonState = sbcButtonState;
})();
