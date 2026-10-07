// image-gallery.js —— 工坊内画廊 tab + 手动收藏入 R2 + KV 跨设备同步 + IDB 缓存
(function () {
  if (window.__gallery) return;
  var LS_META = 'cfw_image_gallery_v1';   // 本地元数据(离线兜底,JSON 数组)
  var IDB_NAME = 'cfw_image_gallery';
  var IDB_STORE = 'blobs';

  // ── 鉴权:复用文本侧云同步 token(= CHAT_PASSWORD)──
  function token() { try { return (window.__auth && window.__auth.getToken && window.__auth.getToken()) || ''; } catch (e) { return ''; } }
  function syncHeaders(extra) { var h = extra || {}; var t = token(); if (t) h['Authorization'] = 'Bearer ' + t; return h; }
  function syncOn() { try { return !!(window.__sync && window.__sync.syncEnabled && window.__sync.syncEnabled()) && !!token(); } catch (e) { return false; } }

  // ── 本地元数据 ──
  var STATE = { items: load() };
  function load() { try { return JSON.parse(localStorage.getItem(LS_META) || '[]') || []; } catch (e) { return []; } }
  function persist() { try { localStorage.setItem(LS_META, JSON.stringify(STATE.items)); } catch (e) {} }
  function uuid() { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('g-' + Date.now() + '-' + Math.random().toString(16).slice(2)); }
  function visible() { return STATE.items.filter(function (it) { return it && !it.deleted; }); }

  // ── IDB 缓存(blob)──
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

  // ── 同步:拉 / 合并(id-union, 较新覆盖, 保留 tombstone) / 推 ──
  function merge(a, b) {
    var map = {};
    (a || []).forEach(function (it) { if (it && it.id) map[it.id] = it; });
    (b || []).forEach(function (it) { if (!it || !it.id) return; var p = map[it.id]; if (!p || (it.ts || 0) >= (p.ts || 0)) map[it.id] = it; });
    var arr = Object.keys(map).map(function (k) { return map[k]; });
    arr.sort(function (x, y) { return (y.ts || 0) - (x.ts || 0); });
    return arr;
  }
  async function pull() {
    if (!syncOn()) { renderGrid(); return; }
    try {
      var r = await fetch('/img/gallery', { headers: syncHeaders() });
      if (!r.ok) return;
      var j = await r.json();
      STATE.items = merge(STATE.items, j.items || []);
      persist(); renderGrid();
    } catch (e) {}
  }
  var pushTimer = null;
  function pushSoon() { if (!syncOn()) return; if (pushTimer) clearTimeout(pushTimer); pushTimer = setTimeout(doPush, 1500); }
  async function doPush() {
    pushTimer = null;
    if (!syncOn()) return;
    try {
      var r = await fetch('/img/gallery', { method: 'PUT', headers: syncHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ items: STATE.items }) });
      if (!r.ok) return;
      var j = await r.json();
      STATE.items = merge(STATE.items, j.items || []);
      persist(); renderGrid();
    } catch (e) {}
  }

  // ── 收藏 / 删除 ──
  async function favorite(srcUrl, info) {
    info = info || {};
    if (!srcUrl) return;
    var savedUrl = srcUrl, key = '', r2Missing = false;
    if (syncOn()) {
      try {
        var r = await fetch('/img/r2/save?url=' + encodeURIComponent(srcUrl), { method: 'POST', headers: syncHeaders() });
        if (r.ok) { var j = await r.json(); key = j.key || ''; savedUrl = j.url || srcUrl; }
        else if (r.status === 501) { r2Missing = true; } // 未绑 R2 → 纯本地降级
      } catch (e) {}
    }
    var item = { id: uuid(), key: key, url: savedUrl, src: srcUrl, kind: info.kind || '', prompt: info.prompt || '', ts: Date.now(), deleted: false, local: !key };
    STATE.items.unshift(item);
    persist();
    // 缓存 blob 到 IDB(R2 用 key,纯本地用 local:<id>),保证缩略图离线 / 过期后仍可显示
    var cacheKey = key || ('local:' + item.id);
    try { var b = await (await fetch(key ? savedUrl : ('/img/dl?url=' + encodeURIComponent(srcUrl)))).blob(); if (b) await idbPut(cacheKey, b); } catch (e) {}
    renderGrid();
    // 仅当图已进 R2 才把元数据推 KV;没 R2 的纯本地条目不同步,避免别的设备拿到裂图
    if (key) pushSoon();
    toast(key ? (syncOn() ? '已收藏并同步到画廊' : '已收藏到本地画廊')
              : (r2Missing ? '未配置云存储,收藏仅保存在本机' : '已收藏到本地画廊(未开云同步,暂不跨设备)'));
    return item;
  }
  function remove(id) {
    var it = STATE.items.filter(function (x) { return x.id === id; })[0];
    if (!it) return;
    it.deleted = true; it.ts = Date.now();
    persist(); renderGrid(); pushSoon();
  }
  // 2026-09-14 UI第一轮:统一反馈组件代理 —— __feedback 在则转发,缺失回退 #galToast 原实现
  function toast(msg) {
    if (window.__feedback && window.__feedback.toast) return window.__feedback.toast(msg, { ms: 2000 });
    try { var t = document.getElementById('galToast'); if (!t) { t = document.createElement('div'); t.id = 'galToast'; t.className = 'gal-toast'; document.body.appendChild(t); } t.textContent = msg; t.style.opacity = '1'; setTimeout(function () { t.style.opacity = '0'; }, 2000); } catch (e) {}
  }

  // ── 缩略图取源:优先 IDB 缓存,否则走 R2/原始 url ──
  async function thumbSrc(it) {
    var ck = it.key || ('local:' + it.id);
    var b = await idbGet(ck); if (b) return URL.createObjectURL(b);
    return it.url || it.src || '';
  }

  // ── UI:工坊(#imgBody)内画廊 tab ──
  function ensureStyles() {
    if (document.getElementById('galStyles')) return;
    var s = document.createElement('style'); s.id = 'galStyles';
    s.textContent = [
      /* 2026-10-06: 原版 background:transparent/inherit 在玻璃等亮色主题下整条"隐形"
         (鬼影 = galPanel 透明叠在表单上)。全部改走主题变量,四主题自动适配。
         2026-10-06 二版: 面板对标 文生图/改图 表单页 —— 页头块(图标+标题+说明+工具按钮),
         卡片式格子(悬停浮起),虚线空状态;工具按钮直接复用工坊的 .img-btn 语言。 */
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
    // 2026-10-06: 原 __galDone 一次性守卫有洞 —— renderBody() 重写 imgBody.innerHTML 时会把
    // 已挂的画廊条/面板一起抹掉,守卫又阻止重挂 → 画廊按钮"消失"。改为按元素存在性幂等:
    // 每次工坊 open(钩子都会调本函数)都补挂缺失的部分。
    // 2026-10-06 三改: 画廊做成与「文生图/改图」平级的第三个页签(同一套 pill 样式);
    // 打开时页签点亮,返回生成/切回生改图时熄灭并收起面板。
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
      // 切回 文生图/改图 时收起画廊并熄灭页签(两个模式页签是静态 DOM,这里守卫只绑一次)
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
      // 2026-10-06 对标表单页: 页头块(图标+标题+说明+工具按钮,.img-btn 同语言) + 卡片网格
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
  async function renderGrid() {
    var grid = document.getElementById('galGrid');
    if (!grid) return;
    var items = visible();
    if (!items.length) { grid.innerHTML = '<div class="gal-empty">画廊还是空的。生成图片后点图片上的「收藏」即可存入,开了云同步还能跨设备。</div>'; return; }
    grid.innerHTML = '';
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var cell = document.createElement('div'); cell.className = 'gal-cell';
      var im = document.createElement('img');
      im.src = await thumbSrc(it);
      im.title = ((it.kind || '') + ' ' + (it.prompt || '')).trim();
      (function (u) { im.onclick = function () { openInStudio(u); }; })(it.url || it.src);
      var meta = document.createElement('div'); meta.className = 'gal-meta';
      meta.textContent = ((it.kind || '') + ' ' + (it.prompt || '')).trim() || '(无提示词)';
      var acts = document.createElement('div'); acts.className = 'gal-actions';
      var del = document.createElement('button'); del.textContent = '删除'; del.title = '从画廊删除';
      (function (id) { del.onclick = function (e) { e.stopPropagation(); remove(id); }; })(it.id);
      acts.appendChild(del);
      cell.appendChild(im); cell.appendChild(meta); cell.appendChild(acts);
      grid.appendChild(cell);
    }
  }
  function openInStudio(url) {
    try {
      if (window.__image && window.__image.open) window.__image.open();
      var out = document.getElementById('imgOutput');
      if (out) { var im = document.createElement('img'); im.src = url; im.style.maxWidth = '100%'; out.innerHTML = ''; out.appendChild(im); }
      var p = document.getElementById('galPanel'); if (p) p.style.display = 'none';
    } catch (e) {}
  }

  // 工坊(#imgBody Modal)是按需创建的。4.82: 不再常驻观察 document.body 整棵树(主站流式聊天期间
  // 每次 DOM 变更都会空跑一次 getElementById),改为钩住工坊入口 __image.open + 启动后有限次重试。
  function hookWorkshopOpen() {
    try {
      if (window.__image && typeof window.__image.open === 'function' && !window.__image.__galHooked) {
        var origOpen = window.__image.open;
        window.__image.open = function () {
          var r = origOpen.apply(this, arguments);
          setTimeout(ensureUI, 50);
          setTimeout(ensureUI, 400); // Modal 若异步构建,补一次(ensureUI 有 __galDone 幂等守卫)
          return r;
        };
        window.__image.__galHooked = true;
      }
      return !!(window.__image && window.__image.__galHooked);
    } catch (e) { return false; }
  }
  function watch() {
    ensureStyles();
    if (document.getElementById('imgBody')) ensureUI();
    if (hookWorkshopOpen()) return;
    // image-embed 尚未加载完(脚本顺序兜底):有限次重试,不挂常驻 observer
    [1500, 4000, 8000].forEach(function (ms) { setTimeout(function () { hookWorkshopOpen(); }, ms); });
  }

  window.__gallery = {
    favorite: favorite,
    remove: remove,
    pull: pull,
    items: function () { return visible(); },
    open: function () {
      var b = document.getElementById('galToggleBtn');
      if (b) { b.click(); return; }
      if (window.__image && window.__image.open) { window.__image.open(); setTimeout(function () { var b2 = document.getElementById('galToggleBtn'); if (b2) b2.click(); }, 300); }
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { watch(); pull(); });
  else { watch(); pull(); }
})();