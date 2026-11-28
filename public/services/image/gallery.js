(function () {
/**
 * Workshop gallery: the local record of images a user chose to keep, with the blob cache that makes
 * a thumbnail survive the provider link expiring.
 *
 * The metadata is an append-only list with tombstones, kept in localStorage because it is small and
 * must survive a reload without waiting on a database. A deleted entry stays in the list with
 * `deleted: true` and a fresh timestamp instead of being spliced out — that is what makes a delete
 * reconcilable later, and it is why every read goes through one visibility filter.
 *
 * The cloud gallery routes this used to call are gone; the "uploaded" branch is kept only so older
 * entries that still carry a key keep rendering. Everything new is `local`, cached under a
 * per-item key, and the module says so out loud rather than pretending there is a server.
 * @module services/image/gallery
 */

const LS_META = "cfw_image_gallery_v1";
const IDB_NAME = "cfw_image_gallery";
const IDB_STORE = "blobs";
const EMPTY_TEXT = "(无提示词)";
const EMPTY_GRID_TEXT = "画廊还是空的。生成图片后点图片上的「收藏」即可存入,开了云同步还能跨设备。";

                              
             
              
              
              
               
                 
             
                   
                 
 

function str(v         )         {
  return typeof v === "string" ? v : "";
}

function recOf(v         )                          {
  const out                          = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

/** Stored metadata, defensively: a broken value is an empty gallery, never a crash on load. */
function parseMeta(raw               )                {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((x) => x && typeof x === "object").map(toItem);
  } catch (e) {
    return [];
  }
}

function toItem(v         )              {
  const o = recOf(v);
  return {
    id: str(o.id),
    key: str(o.key),
    url: str(o.url),
    src: str(o.src),
    kind: str(o.kind),
    prompt: str(o.prompt),
    ts: typeof o.ts === "number" ? o.ts : 0,
    deleted: o.deleted === true,
    local: o.local !== false
  };
}

/** Everything the grid may show: tombstones are excluded here and nowhere else. */
function visible(items               )                {
  return items.filter((it) => it && !it.deleted);
}

/** A new entry for a favourite. Newest first, so it goes on top. */
function makeItem(o   
             
              
                
                  
             
 )              {
  return {
    id: o.id,
    key: "",
    url: o.src,
    src: o.src,
    kind: str(o.kind),
    prompt: str(o.prompt),
    ts: o.ts,
    deleted: false,
    local: true
  };
}

function addItem(items               , item             )                {
  return [item].concat(items);
}

/**
 * Mark one entry deleted and bump its timestamp. Returns the same list when the id is unknown, so
 * the caller can skip the write.
 */
function tombstone(items               , id        , ts        )                {
  let hit = false;
  const out = items.map((it) => {
    if (it.id !== id) return it;
    hit = true;
    return { id: it.id, key: it.key, url: it.url, src: it.src, kind: it.kind, prompt: it.prompt, ts: ts, deleted: true, local: it.local };
  });
  return hit ? out : items;
}

/** Blob cache key: entries that came with a remote key use it, local ones are namespaced by id. */
function cacheKeyOf(item             )         {
  return item.key || "local:" + item.id;
}

/** Caption under a tile; the trim keeps an empty kind from leaving a leading space. */
function metaTextOf(item             )         {
  const t = (str(item.kind) + " " + str(item.prompt)).trim();
  return t || EMPTY_TEXT;
}

/** Where the thumbnail comes from when the cache misses. */
function fallbackUrlOf(item             )         {
  return item.url || item.src || "";
}

/** Download URL for the cache fill: a keyed entry is already ours, a source URL goes via the proxy. */
function downloadUrlOf(item             )         {
  return item.key ? item.url : "/img/dl?url=" + encodeURIComponent(item.src);
}

// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/image/gallery.ts; this file owns the
// localStorage list, the blob cache in IndexedDB, the workshop tab and the toast.
//
// The cloud gallery routes this module used to call are gone, so "favourite" is local-only. The
// hooking is deliberately not a MutationObserver: the workshop modal is created on demand, and
// watching the whole document during a streaming chat cost a getElementById per DOM mutation.
(function () {
  if (window.__gallery) return;
  var STATE = { items: parseMeta(readLS()) };

  function readLS() { try { return window.localStorage.getItem(LS_META); } catch (e) { return null; } }
  function persist() { try { window.localStorage.setItem(LS_META, JSON.stringify(STATE.items)); } catch (e) {} }
  function uuid() { return (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : ('g-' + Date.now() + '-' + Math.random().toString(16).slice(2)); }
  function visibleItems() { return visible(STATE.items); }

  // Blob cache: one key per item, filled on favourite.
  function idb() {
    return new Promise(function (res) {
      var req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function () { try { req.result.createObjectStore(IDB_STORE); } catch (e) {} };
      req.onsuccess = function () { res(req.result); };
      req.onerror = function () { res(null); };
    });
  }
  async function idbPut(key, blob) { var db = await idb(); if (!db) return; try { db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).put(blob, key); } catch (e) {} }
  async function idbGet(key) {
    var db = await idb(); if (!db) return null;
    return new Promise(function (res) { try { var r = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key); r.onsuccess = function () { res(r.result || null); }; r.onerror = function () { res(null); }; } catch (e) { res(null); } });
  }

  // Nothing to pull: the local list is the truth (the cloud routes answer 501 and are gone).
  function pull() { renderGrid(); }

  // Favourite / delete.
  async function favorite(srcUrl, info) {
    var i = info || {};
    if (!srcUrl) return;
    var item = makeItem({ id: uuid(), src: srcUrl, kind: i.kind, prompt: i.prompt, ts: Date.now() });
    STATE.items = addItem(STATE.items, item);
    persist();
    // Cache the bytes so the tile still renders after the provider link expires. The proxy needs the
    // app token; the provider key is never sent to it.
    try {
      var headers = {};
      try {
        var t = window.localStorage.getItem("cfw_auth_token_v1");
        if (t) headers["X-Sync-Token"] = t;
      } catch (e) {}
      var b = await (await window.fetch(downloadUrlOf(item), { headers: headers })).blob();
      if (b) await idbPut(cacheKeyOf(item), b);
    } catch (e) {}
    renderGrid();
    toast("已收藏到本地画廊");
    return item;
  }

  function remove(id) {
    var next = tombstone(STATE.items, id, Date.now());
    if (next === STATE.items) return;
    STATE.items = next;
    persist();
    renderGrid();
  }
  // Feedback goes through the shared toast when it is loaded; the fallback keeps a bare page usable.
  function toast(msg) {
    if (window.feedbackSvc && window.feedbackSvc.toast) return window.feedbackSvc.toast(msg, { ms: 2000 });
    try { var t = document.getElementById('galToast'); if (!t) { t = document.createElement('div'); t.id = 'galToast'; t.className = 'gal-toast'; document.body.appendChild(t); } t.textContent = msg; t.style.opacity = '1'; setTimeout(function () { t.style.opacity = '0'; }, 2000); } catch (e) {}
  }

  // Thumbnail source: the cached blob first, the original URL only as a fallback.
  async function thumbSrc(it) {
    var b = await idbGet(cacheKeyOf(it));
    if (b) return URL.createObjectURL(b);
    return fallbackUrlOf(it);
  }

  // The gallery tab inside the workshop modal.
  function ensureStyles() {
    if (document.getElementById('galStyles')) return;
    var s = document.createElement('style'); s.id = 'galStyles';
    s.textContent = [
      /* Everything is a theme variable: the old transparent/inherit values made the whole bar
         invisible on light themes, with the panel ghosting over the form beneath it. */
      '.gal-bar{display:flex;gap:6px;align-items:center;margin-bottom:8px;flex-wrap:wrap;}',
      '.gal-btn{display:inline-flex;align-items:center;gap:5px;font-size:12px;padding:4px 10px;border:1px solid var(--border,rgba(127,127,127,.3));border-radius:999px;background:var(--bubble-ai,rgba(127,127,127,.08));color:inherit;cursor:pointer;transition:background .15s,border-color .15s;font-family:inherit;}',
      '.gal-btn:hover{background:var(--bubble-user,rgba(127,127,127,.16));border-color:var(--accent,#8a8a8a);}',
      '.gal-btn svg{width:13px;height:13px;flex:none;}',
      '#galPanel{position:absolute;inset:0;z-index:6;background:var(--bg,#1a1a1a);overflow:auto;padding:16px 20px 20px;box-sizing:border-box;}',
      '.gal-head{display:flex;align-items:flex-start;gap:12px;padding-bottom:12px;margin-bottom:16px;border-bottom:1px solid rgba(127,127,127,.14);}',
      '.gal-head-name{font-size:16px;font-weight:700;display:flex;align-items:center;gap:8px;}',
      '.gal-head-name svg{color:var(--img-accent,var(--ue-tab-accent,#8a8a8a));flex:none;}',
      '.gal-head-desc{font-size:12.5px;line-height:1.65;opacity:.62;margin-top:5px;max-width:560px;}',
      '.gal-toolbar{margin-left:auto;display:flex;gap:6px;flex:none;}',
      '.gal-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;}',
      '.gal-cell{position:relative;border:1px solid var(--border,rgba(127,127,127,.3));border-radius:12px;overflow:hidden;background:var(--bubble-ai,rgba(127,127,127,.06));padding:8px;transition:border-color .16s,box-shadow .16s,transform .16s;}',
      '.gal-cell:hover{transform:translateY(-1px);box-shadow:0 4px 16px rgba(0,0,0,.12);border-color:var(--img-accent,var(--ue-tab-accent,#8a8a8a));}',
      '.gal-cell img{width:100%;display:block;cursor:zoom-in;border-radius:8px;background:rgba(127,127,127,.08);min-height:60px;}',
      '.gal-cell .gal-meta{font-size:11px;opacity:.55;margin-top:7px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.gal-cell .gal-actions{position:absolute;top:12px;right:12px;display:flex;gap:4px;opacity:0;transition:opacity .15s;}',
      '.gal-cell:hover .gal-actions{opacity:1;}',
      '.gal-cell .gal-actions button{font-size:11px;padding:3px 8px;border-radius:6px;border:none;background:rgba(0,0,0,.6);color:#fff;cursor:pointer;backdrop-filter:blur(4px);}',
      '.gal-empty{border:1px dashed rgba(127,127,127,.3);border-radius:12px;padding:38px 16px;text-align:center;opacity:.6;font-size:12.5px;line-height:1.7;}',
      '.gal-toast{position:fixed;left:50%;bottom:40px;transform:translateX(-50%);background:rgba(0,0,0,.82);color:#fff;padding:8px 14px;border-radius:8px;font-size:13px;z-index:9999;opacity:0;transition:opacity .3s;pointer-events:none;}'
    ].join('\n');
    document.head.appendChild(s);
  }
  function ensureUI() {
    var body = document.getElementById('imgBody');
    if (!body) return;
    // Idempotent by element presence, not by a one-shot flag: the workshop rewrites its own
    // innerHTML on every open, which wiped the tab and panel while the flag still said "done".
    // Every open therefore re-attaches whatever is missing.
    try { if (getComputedStyle(body).position === 'static') body.style.position = 'relative'; } catch (e) {}
    if (!document.getElementById('galToggleBtn')) {
      var tabs = document.querySelector('#imageStudioMask .img-tabs');
      if (!tabs) return;
      var btn = document.createElement('button'); btn.id = 'galToggleBtn';
      btn.className = 'img-tab'; btn.setAttribute('role', 'tab');
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="M4 17.5l5-5 3.2 3.2 3.2-3.8 4.1 5"/></svg><span>画廊</span>';
      tabs.appendChild(btn);
      btn.onclick = function () {
        var p = document.getElementById('galPanel');
        if (!p) return;
        var opening = p.style.display !== 'block';
        p.style.display = opening ? 'block' : 'none';
        btn.classList.toggle('active', opening);
        if (opening) renderGrid();
      };
      // Switching back to a form tab hides the panel and clears the tab; bound once, since those
      // two tabs are static markup.
      if (!tabs.__galBound) {
        tabs.__galBound = true;
        tabs.addEventListener('click', function (e) {
          var t = e.target.closest && e.target.closest('.img-tab[data-mode]');
          if (!t) return;
          var p = document.getElementById('galPanel');
          var g = document.getElementById('galToggleBtn');
          if (p) p.style.display = 'none';
          if (g) g.classList.remove('active');
        });
      }
    }
    if (!document.getElementById('galPanel')) {
      var panel = document.createElement('div'); panel.id = 'galPanel'; panel.style.display = 'none';
      // Same anatomy as the form tabs: header block plus a card grid.
      panel.innerHTML =
        '<div class="gal-head">' +
          '<div class="gal-head-txt">' +
            '<div class="gal-head-name"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="M4 17.5l5-5 3.2 3.2 3.2-3.8 4.1 5"/></svg>画廊</div>' +
            '<div class="gal-head-desc">生成过的图片都会留在这里。点图片可放回下方输出区查看或另存；悬停图片可删除。</div>' +
          '</div>' +
          '<div class="gal-toolbar">' +
            '<button id="galRefreshBtn" class="img-btn"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v3.5h-3.5"/></svg>刷新</button>' +
            '<button id="galBackBtn" class="img-btn"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5"/><path d="M11 6l-6 6 6 6"/></svg>返回生成</button>' +
          '</div>' +
        '</div>' +
        '<div class="gal-grid" id="galGrid"></div>';
      body.appendChild(panel);
      panel.querySelector('#galBackBtn').onclick = function () {
        panel.style.display = 'none';
        var g = document.getElementById('galToggleBtn');
        if (g) g.classList.remove('active');
      };
      panel.querySelector('#galRefreshBtn').onclick = function () { pull(); };
    }
    renderGrid();
  }
  // Concurrent renders used to interleave: each cleared the grid, then awaited a thumbnail and
  // appended, so a favourite landing while the tab opened left duplicate tiles. The sequence number
  // makes a stale pass drop its work instead.
  var renderSeq = 0;

  async function renderGrid() {
    var grid = document.getElementById('galGrid');
    if (!grid) return;
    var seq = ++renderSeq;
    var items = visibleItems();
    if (!items.length) { if (seq === renderSeq) grid.innerHTML = '<div class="gal-empty">画廊还是空的。生成图片后点图片上的「收藏」即可存入,开了云同步还能跨设备。</div>'; return; }
    var built = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var cell = document.createElement('div'); cell.className = 'gal-cell';
      var im = document.createElement('img');
      im.src = await thumbSrc(it);
      if (seq !== renderSeq) return;
      im.title = metaTextOf(it);
      (function (u) { im.onclick = function () { openInStudio(u); }; })(it.url || it.src);
      var meta = document.createElement('div'); meta.className = 'gal-meta';
      meta.textContent = metaTextOf(it);
      var acts = document.createElement('div'); acts.className = 'gal-actions';
      var del = document.createElement('button'); del.textContent = '删除'; del.title = '从画廊删除';
      (function (id) { del.onclick = function (e) { e.stopPropagation(); remove(id); }; })(it.id);
      acts.appendChild(del);
      cell.appendChild(im); cell.appendChild(meta); cell.appendChild(acts);
      built.push(cell);
    }
    if (seq !== renderSeq) return;
    grid.innerHTML = '';
    built.forEach(function (c) { grid.appendChild(c); });
  }
  function openInStudio(url) {
    try {
      if (window.imageStudioSvc && window.imageStudioSvc.open) window.imageStudioSvc.open();
      var out = document.getElementById('imgOutput');
      if (out) { var im = document.createElement('img'); im.src = url; im.style.maxWidth = '100%'; out.innerHTML = ''; out.appendChild(im); }
      var p = document.getElementById('galPanel'); if (p) p.style.display = 'none';
    } catch (e) {}
  }

  // The workshop modal is created on demand, so there is nothing to observe at load. Watching the
  // whole body instead cost a getElementById per DOM mutation during a streaming chat; hooking the
  // workshop's open entry point and retrying a few times after startup is enough.
  function hookWorkshopOpen() {
    try {
      if (window.imageStudioSvc && typeof window.imageStudioSvc.open === 'function' && !window.imageStudioSvc.__galHooked) {
        var origOpen = window.imageStudioSvc.open;
        window.imageStudioSvc.open = function () {
          var r = origOpen.apply(this, arguments);
          setTimeout(ensureUI, 50);
          setTimeout(ensureUI, 400); // second pass in case the modal builds asynchronously
          return r;
        };
        window.imageStudioSvc.__galHooked = true;
      }
      return !!(window.imageStudioSvc && window.imageStudioSvc.__galHooked);
    } catch (e) { return false; }
  }
  function watch() {
    ensureStyles();
    if (document.getElementById('imgBody')) ensureUI();
    if (hookWorkshopOpen()) return;
    // image-embed may not be loaded yet; retry a few times instead of observing forever.
    [1500, 4000, 8000].forEach(function (ms) { setTimeout(function () { hookWorkshopOpen(); }, ms); });
  }

  window.__gallery = {
    favorite: favorite,
    remove: remove,
    pull: pull,
    items: function () { return visibleItems(); },
    open: function () {
      var b = document.getElementById('galToggleBtn');
      if (b) { b.click(); return; }
      if (window.imageStudioSvc && window.imageStudioSvc.open) { window.imageStudioSvc.open(); setTimeout(function () { var b2 = document.getElementById('galToggleBtn'); if (b2) b2.click(); }, 300); }
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { watch(); pull(); });
  else { watch(); pull(); }
})();

globalThis.LS_META = LS_META;
globalThis.IDB_NAME = IDB_NAME;
globalThis.IDB_STORE = IDB_STORE;
globalThis.EMPTY_TEXT = EMPTY_TEXT;
globalThis.EMPTY_GRID_TEXT = EMPTY_GRID_TEXT;
globalThis.parseMeta = parseMeta;
globalThis.visible = visible;
globalThis.makeItem = makeItem;
globalThis.addItem = addItem;
globalThis.tombstone = tombstone;
globalThis.cacheKeyOf = cacheKeyOf;
globalThis.metaTextOf = metaTextOf;
globalThis.fallbackUrlOf = fallbackUrlOf;
globalThis.downloadUrlOf = downloadUrlOf;
})();
