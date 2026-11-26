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
