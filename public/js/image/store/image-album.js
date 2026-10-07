/**
 * image-album.js · 纯本地画廊闭环（IndexedDB）
 *
 * 自动收图:包 window.fetch（在 image-cache 之后加载，最外层）观察两类成功响应：
 *   - POST /img/v1/images/generations → data[].url | b64_json（文生图/立绘/基准图）
 *   - GET  /img/v1/task/{id}          → output.file_url（改图/发图照片）
 * 下载为 Blob 存 IndexedDB（durable，不怕直链过期），按 url 哈希去重，最多 60 张。
 * UI:「本地画廊」卡已迁移至 settings.js（模态网格仍在本模块），每张:设为基准图/插入对话/再改一张/下载/删除。
 * 不依赖 R2/KV，完全本机。window.__album = { add, list, remove, clear, open }
 */
(function () {
  'use strict';
  if (window.__album) return;

  var DB_NAME = 'cfw_image_album';
  var STORE = 'items';
  var MAX = 60;
  var _db = null;
  var _seen = {};
  var _objUrls = [];
  var orig = window.fetch.bind(window);

  function openDb() {
    return new Promise(function (resolve, reject) {
      if (_db) return resolve(_db);
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var os = db.createObjectStore(STORE, { keyPath: 'id' });
          os.createIndex('ts', 'ts', { unique: false });
        }
      };
      req.onsuccess = function () { _db = req.result; resolve(_db); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function store(mode) { return openDb().then(function (db) { return db.transaction(STORE, mode).objectStore(STORE); }); }
  function idbPut(item) { return store('readwrite').then(function (os) { return new Promise(function (res, rej) { var r = os.put(item); r.onsuccess = function () { res(); }; r.onerror = function () { rej(r.error); }; }); }); }
  function idbGet(id) { return store('readonly').then(function (os) { return new Promise(function (res) { var r = os.get(id); r.onsuccess = function () { res(r.result || null); }; r.onerror = function () { res(null); }; }); }); }
  function idbDel(id) { return store('readwrite').then(function (os) { return new Promise(function (res) { var r = os.delete(id); r.onsuccess = function () { res(); }; r.onerror = function () { res(); }; }); }); }
  function idbAll() { return store('readonly').then(function (os) { return new Promise(function (res) { var out = []; var r = os.openCursor(); r.onsuccess = function () { var c = r.result; if (c) { out.push(c.value); c.continue(); } else res(out); }; r.onerror = function () { res(out); }; }); }); }
  function idbClear() { return store('readwrite').then(function (os) { return new Promise(function (res) { var r = os.clear(); r.onsuccess = function () { res(); }; r.onerror = function () { res(); }; }); }); }

  function hashId(s) { var h = 5381, i = s.length; while (i) { h = (h * 33) ^ s.charCodeAt(--i); } return 'a' + (h >>> 0).toString(36); }
  function fire() { try { window.dispatchEvent(new CustomEvent('imagealbum:changed')); } catch (e) {} }

  function dlBlob(url) {
    if (url.indexOf('data:') === 0) return orig(url).then(function (r) { return r.blob(); });
    return orig('/img/dl?url=' + encodeURIComponent(url)).then(function (r) { if (!r.ok) throw new Error('dl ' + r.status); return r.blob(); });
  }
  function blobToDataUrl(blob) { return new Promise(function (res, rej) { var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.onerror = function () { rej(fr.error); }; fr.readAsDataURL(blob); }); }

  async function add(opts) {
    opts = opts || {};
    var url = opts.url;
    if (!url) return;
    var id = hashId(url);
    if (_seen[id]) return;
    _seen[id] = 1;
    var exist = await idbGet(id);
    if (exist) return;
    var blob;
    try { blob = await dlBlob(url); } catch (e) { return; }
    await idbPut({ id: id, url: url, prompt: (opts.prompt || '').slice(0, 200), ts: Date.now(), blob: blob });
    var all = await idbAll();
    if (all.length > MAX) {
      all.sort(function (a, b) { return a.ts - b.ts; });
      var extra = all.slice(0, all.length - MAX);
      for (var i = 0; i < extra.length; i++) { await idbDel(extra[i].id); }
    }
    fire();
  }
  function list() { return idbAll().then(function (a) { a.sort(function (x, y) { return y.ts - x.ts; }); return a; }); }
  function remove(id) { return idbDel(id).then(fire); }
  function clear() { _seen = {}; return idbClear().then(fire); }

  window.__album = { add: add, list: list, remove: remove, clear: clear, open: openPanel };

  function urlOf(input) { try { return typeof input === 'string' ? input : ((input && input.url) || ''); } catch (e) { return ''; } }
  window.fetch = function (input, init) {
    var p = orig(input, init);
    try {
      var url = urlOf(input);
      var method = (((init && init.method) || (input && input.method)) || 'GET').toUpperCase();
      if (method === 'POST' && url.indexOf('images/generations') !== -1 && url.indexOf('async/') === -1) {
        var prompt = '';
        try { var b = JSON.parse((init && init.body) || '{}'); prompt = b.prompt || ''; } catch (e) {}
        p.then(function (res) { if (res && res.ok) { res.clone().json().then(function (j) { var arr = (j && j.data) || []; arr.forEach(function (d) { var u = d && (d.url || (d.b64_json ? 'data:image/png;base64,' + d.b64_json : '')); if (u) add({ url: u, prompt: prompt }); }); }).catch(function () {}); } }).catch(function () {});
      } else if (method === 'GET' && url.indexOf('/img/v1/task/') !== -1) {
        p.then(function (res) { if (res && res.ok) { res.clone().json().then(function (j) { var u = (j && j.output && j.output.file_url) || (j && j.raw && j.raw.output && j.raw.output.file_url); if (u) add({ url: u, prompt: 'edit' }); }).catch(function () {}); } }).catch(function () {});
      }
    } catch (e) {}
    return p;
  };

  function revokeAll() { _objUrls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} }); _objUrls = []; }
  function ensureStyles() {
    if (document.getElementById('albumStyles')) return;
    var s = document.createElement('style'); s.id = 'albumStyles';
    s.textContent = [
      '.alb-mask{position:fixed;inset:0;z-index:45;display:none;align-items:flex-start;justify-content:center;background:rgba(0,0,0,.55);overflow:auto;padding:32px 16px;}',
      '.alb-mask.open{display:flex;}',
      '.alb-box{width:100%;max-width:720px;background:var(--bg,#1a1a1a);color:inherit;border:1px solid currentColor;border-radius:14px;padding:18px;box-shadow:0 12px 40px rgba(0,0,0,.5);}',
      '.alb-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;}',
      '.alb-title{font-weight:600;font-size:16px;}',
      '.alb-close{background:transparent;border:1px solid rgba(127,127,127,.4);color:inherit;border-radius:8px;cursor:pointer;width:30px;height:30px;}',
      '.alb-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;}',
      '.alb-tile{border:1px solid rgba(127,127,127,.25);border-radius:10px;overflow:hidden;display:flex;flex-direction:column;}',
      '.alb-tile img{width:100%;height:150px;object-fit:cover;display:block;}',
      '.alb-cap{font-size:11px;opacity:.6;padding:4px 6px;max-height:30px;overflow:hidden;}',
      '.alb-acts{display:flex;flex-wrap:wrap;gap:4px;padding:6px;}',
      '.alb-acts button{font-size:11px;padding:3px 7px;border-radius:6px;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;cursor:pointer;}',
      '.alb-acts button:hover{background:rgba(127,127,127,.15);}',
      '.alb-empty{opacity:.6;font-size:13px;padding:24px;text-align:center;}'
    ].join('');
    document.head.appendChild(s);
  }
  function activeCharId() { try { var c = window.__character && window.__character.getActiveCard && window.__character.getActiveCard(); return (c && c.id) || 'default'; } catch (e) { return 'default'; } }
  function insertIntoChat(objUrl) {
    var chat = document.getElementById('chat');
    if (!chat) { alert('当前不在聊天页面，无法插入'); return; }
    var spacer = document.getElementById('bottom-spacer');
    var row = document.createElement('div'); row.className = 'row ai chat-image-row';
    var avatar = document.createElement('div'); avatar.className = 'avatar bot'; avatar.textContent = '🖼️';
    var content = document.createElement('div'); content.className = 'content';
    var bubble = document.createElement('div'); bubble.className = 'bubble ai chat-image-bubble';
    var img = document.createElement('img'); img.src = objUrl; img.style.cssText = 'max-width:220px;border-radius:10px;display:block;cursor:zoom-in;';
    img.addEventListener('click', function () { window.open(objUrl, '_blank'); });
    bubble.appendChild(img); content.appendChild(bubble); row.appendChild(avatar); row.appendChild(content);
    if (spacer) chat.insertBefore(row, spacer); else chat.appendChild(row);
    try { var hw = document.getElementById('history'); if (hw) hw.scrollTop = hw.scrollHeight; } catch (e) {}
    closePanel();
  }
  function mkBtn(label, fn) { var b = document.createElement('button'); b.textContent = label; b.addEventListener('click', fn); return b; }
  function dl(objUrl) { var a = document.createElement('a'); a.href = objUrl; a.download = 'album-' + Date.now() + '.png'; document.body.appendChild(a); a.click(); document.body.removeChild(a); }
  async function setAsBase(it) {
    try {
      if (!(window.__chatImage && window.__chatImage.setBaseImage)) { alert('发图模块未就绪'); return; }
      var dataUrl = await blobToDataUrl(it.blob);
      await window.__chatImage.setBaseImage({ characterId: activeCharId(), imageUrl: dataUrl });
      alert('已设为当前角色的发图基准图');
    } catch (e) { alert('失败:' + ((e && e.message) || e)); }
  }
  async function reEdit(it) {
    var scene = window.prompt('把这张改成什么场景/动作？（保持同一人）', '换个场景');
    if (!scene) return;
    try {
      if (!(window.__chatImage && window.__chatImage.sendPhoto)) { alert('发图模块未就绪'); return; }
      var dataUrl = await blobToDataUrl(it.blob);
      var res = await window.__chatImage.sendPhoto({ characterId: activeCharId(), scenePrompt: scene, baseImageUrl: dataUrl });
      if (res && res.imageUrl) { await add({ url: res.imageUrl, prompt: scene }); renderGrid(); }
      else { alert('改图未返回结果'); }
    } catch (e) { alert('失败:' + ((e && e.message) || e)); }
  }
  function openPanel() {
    ensureStyles();
    var mask = document.getElementById('albumMask');
    if (!mask) {
      mask = document.createElement('div'); mask.id = 'albumMask'; mask.className = 'alb-mask';
      mask.innerHTML = '<div class="alb-box"><div class="alb-head"><div class="alb-title"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px;margin-right:5px;"><rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="M4 17.5l5-5 3.2 3.2 3.2-3.8 4.1 5"/></svg>本地画廊</div><button class="alb-close" id="albCloseBtn">✕</button></div><div class="alb-grid" id="albGrid"></div></div>';
      document.body.appendChild(mask);
      mask.addEventListener('click', function (e) { if (e.target === mask) closePanel(); });
      document.getElementById('albCloseBtn').addEventListener('click', closePanel);
    }
    mask.classList.add('open');
    renderGrid();
  }
  function closePanel() { var m = document.getElementById('albumMask'); if (m) m.classList.remove('open'); revokeAll(); }
  async function renderGrid() {
    var grid = document.getElementById('albGrid'); if (!grid) return;
    revokeAll();
    var items = await list();
    if (!items.length) { grid.innerHTML = '<div class="alb-empty">还没有图片。去工坊/立绘/发图生成后会自动收进这里。</div>'; return; }
    grid.innerHTML = '';
    items.forEach(function (it) {
      var objUrl = URL.createObjectURL(it.blob); _objUrls.push(objUrl);
      var tile = document.createElement('div'); tile.className = 'alb-tile';
      var img = document.createElement('img'); img.src = objUrl; img.loading = 'lazy';
      var cap = document.createElement('div'); cap.className = 'alb-cap'; cap.textContent = it.prompt || '';
      var acts = document.createElement('div'); acts.className = 'alb-acts';
      acts.appendChild(mkBtn('设为基准图', function () { setAsBase(it); }));
      acts.appendChild(mkBtn('插入对话', function () { insertIntoChat(objUrl); }));
      acts.appendChild(mkBtn('再改一张', function () { reEdit(it); }));
      acts.appendChild(mkBtn('下载', function () { dl(objUrl); }));
      acts.appendChild(mkBtn('删除', function () { remove(it.id).then(renderGrid); }));
      tile.appendChild(img); tile.appendChild(cap); tile.appendChild(acts);
      grid.appendChild(tile);
    });
  }

  // 画廊卡已迁移至 settings.js 统一挂载
})();