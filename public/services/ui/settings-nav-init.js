(function () {
/**
 * Settings category navigation rules: which category exists, which one is the visible default,
 * and whether a saved category can be restored. The wiring owns DOM toggling, scroll reset and
 * the listeners.
 *
 * A saved category that no longer has a panel MUST fall back to the first visible item instead of
 * leaving every panel inactive. Visibility is caller-supplied because offsetParent is a DOM fact.
 * @module services/ui/settings-nav-init
 */

const SNI_LS_CAT = "cfw_settings_cat_v1";

/** @returns whether a category has a matching panel. */
function sniHit(cats                               , cat        )          {
  return cats.indexOf(cat) >= 0;
}

/** @returns the first visible category, or the first one when none is visible. */
function sniFirstVisible(items                                     )         {
  for (const it of items) if (it.visible) return it.cat;
  return items.length ? items[0].cat : "";
}

/** @returns whether the saved category can be restored directly. */
function sniShouldRestore(saved               , cats                               )          {
  return !!saved && sniHit(cats, saved);
}

/** @returns the category to activate on startup. */
function sniInitialCat(
  saved               ,
  cats                               ,
  items                                     ,
)         {
  return sniShouldRestore(saved, cats) ? String(saved) : sniFirstVisible(items);
}

// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/ui/settings-nav-init.ts
// (category hit, visible default and restore decision); this file owns DOM toggling,
// scroll reset and the listeners.
(function(){
  function init(){
    var nav = document.querySelector('.settings-cat-nav');
    if(!nav) return;
    var items = Array.prototype.slice.call(nav.querySelectorAll('.scn-item'));
    var panels = Array.prototype.slice.call(document.querySelectorAll('#settings .set-cat'));
    if(!items.length || !panels.length) return;
    var LS = SNI_LS_CAT;
    function show(cat){
      var hit = sniHit(panels.map(function(p){ return p.getAttribute('data-cat'); }), cat);
      panels.forEach(function(p){ p.classList.toggle('active', p.getAttribute('data-cat') === cat); });
      items.forEach(function(b){ b.classList.toggle('active', b.getAttribute('data-cat') === cat); });
      if(hit){ try{ localStorage.setItem(LS, cat); }catch(e){} var s = document.getElementById('settings'); var sh = document.querySelector('.settings-shell'); var m = document.getElementById('settingsMask'); if(s) s.scrollTop = 0; if(sh) sh.scrollTop = 0; if(m) m.scrollTop = 0; }
      return hit;
    }
    function firstVisible(){ return sniFirstVisible(items.map(function(b){ return { cat: b.getAttribute('data-cat'), visible: b.offsetParent !== null }; })); }
    items.forEach(function(b){ b.addEventListener('click', function(){ show(b.getAttribute('data-cat')); }); });
    var saved = null; try{ saved = localStorage.getItem(LS); }catch(e){}
    show(sniInitialCat(saved, panels.map(function(p){ return p.getAttribute('data-cat'); }), items.map(function(b){ return { cat: b.getAttribute('data-cat'), visible: b.offsetParent !== null }; })));
    function onOpen(){ setTimeout(function(){ var cur = nav.querySelector('.scn-item.active'); if(!cur || cur.offsetParent === null) show(firstVisible()); var s = document.getElementById('settings'); var sh = document.querySelector('.settings-shell'); var m = document.getElementById('settingsMask'); if(s) s.scrollTop = 0; if(sh) sh.scrollTop = 0; if(m) m.scrollTop = 0; }, 0); }
    ['settingsBtn'].forEach(function(id){ var el = document.getElementById(id); if(el) el.addEventListener('click', onOpen); });
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();

globalThis.SNI_LS_CAT = SNI_LS_CAT;
globalThis.sniHit = sniHit;
globalThis.sniFirstVisible = sniFirstVisible;
globalThis.sniShouldRestore = sniShouldRestore;
globalThis.sniInitialCat = sniInitialCat;
})();
