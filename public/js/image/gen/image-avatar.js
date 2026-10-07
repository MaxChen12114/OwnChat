/**
 * image-avatar.js · 角色头像
 * 以发图基准图为底，用 Qwen-Image-Edit 裁一张近景头像（可选表情），按角色保存。
 * 依赖 window.__chatImage.editImage / setBaseImage。结果同时被 image-album 自动收进画廊。
 * 头像存 LS cfw_char_avatar_v1 (id -> url)，变更时发 avatar:changed 事件，供文本侧 UI 取用。
 * window.__avatar = { generate, get, getAll, set, clear, list }
 */
(function () {
  'use strict';
  if (window.__avatar) return;
  var LS_AV = 'cfw_char_avatar_v1';
  var AV_EXPR = [
    { key: '默认', en: 'a natural calm expression' },
    { key: '微笑', en: 'a gentle warm smile' },
    { key: '开心', en: 'a happy bright smile' },
    { key: '害羞', en: 'a shy bashful blush' },
    { key: '认真', en: 'a serious focused expression' }
  ];
  function loadMap() { try { return JSON.parse(localStorage.getItem(LS_AV) || '{}') || {}; } catch (e) { return {}; } }
  function saveMap(m) { try { localStorage.setItem(LS_AV, JSON.stringify(m)); } catch (e) {} }
  function activeCard() { try { return (window.__character && window.__character.getActiveCard && window.__character.getActiveCard()) || null; } catch (e) { return null; } }
  function activeId() { var c = activeCard(); return (c && c.id) || 'default'; }
  function activeName() { var c = activeCard(); return (c && c.name) || '当前角色'; }
  function get(id) { var m = loadMap(); return m[id || activeId()] || null; }
  function getAll() { return loadMap(); }
  function fire(id, url) { try { window.dispatchEvent(new CustomEvent('avatar:changed', { detail: { id: id, url: url } })); } catch (e) {} }
  function set(id, url) { if (!url) return; id = id || activeId(); var m = loadMap(); m[id] = url; saveMap(m); fire(id, url); }
  function clear(id) { id = id || activeId(); var m = loadMap(); delete m[id]; saveMap(m); fire(id, null); }
  function instructionFor(en) { return 'Crop to a close-up headshot portrait of the SAME person from the source image, face and shoulders centered, ' + en + ', clean soft solid-color background, square composition, sharp focus on the face, high-quality profile avatar. Keep the same identity, hairstyle and outfit. Do NOT change the face.'; }
  function setStatus(m) { var el = document.getElementById('imgAvStatus'); if (el) el.textContent = m || ''; }
  function renderPreview() {
    var box = document.getElementById('imgAvPreview'); if (!box) return;
    var url = get(activeId()); box.innerHTML = '';
    if (url) { var img = document.createElement('img'); img.src = url; img.className = 'av-img'; img.addEventListener('click', function () { window.open(url, '_blank'); }); box.appendChild(img); }
    else { box.textContent = '（当前角色还没有头像）'; }
  }
  async function generate(opts) {
    opts = opts || {};
    if (!(window.__chatImage && window.__chatImage.editImage)) { setStatus('发图模块未就绪'); return; }
    var item = AV_EXPR.filter(function (e) { return e.key === opts.expression; })[0] || AV_EXPR[0];
    var id = activeId();
    setStatus('正在生成头像（' + item.key + '）…首次无基准图会先造一张，约 30-45s');
    try {
      var res = await window.__chatImage.editImage({ characterId: id, instruction: instructionFor(item.en) });
      if (res && res.imageUrl) { set(id, res.imageUrl); renderPreview(); setStatus('头像已生成并保存，也存入了本地画廊'); return res.imageUrl; }
      setStatus('未返回结果');
    } catch (e) { setStatus('生成失败:' + ((e && e.message) || e)); }
  }
  window.__avatar = { generate: generate, get: get, getAll: getAll, set: set, clear: clear, list: AV_EXPR };
  function ensureStyles() {
    if (document.getElementById('avStyles')) return;
    var s = document.createElement('style'); s.id = 'avStyles';
    s.textContent = [
      '#imgAvPreview{margin-top:8px;min-height:20px;font-size:12px;opacity:.7;}',
      '#imgAvPreview .av-img{width:104px;height:104px;object-fit:cover;border-radius:12px;cursor:zoom-in;display:block;}',
      '.av-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:8px 0;}',
      '.av-row select,.av-row button{font-size:12px;padding:4px 10px;border-radius:8px;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;cursor:pointer;}'
    ].join('');
    document.head.appendChild(s);
  }
  function injectCard() {
    var settings = document.getElementById('settings');
    if (!settings || document.getElementById('imgAvatarCard')) return;
    // 2026-10-05: 显式挂进「发图」类目的 #settingsImageSlot,不再 append 到 #settings 根
    // 靠 index.html 的 MutationObserver「扫孤儿」搬过去 —— 那是歪打正着,不是显式归属。
    // 回落 #settings 只为老页面(缺该 slot 时卡仍能显示,只是落在面板底部)。
    var slot = document.getElementById('settingsImageSlot') || settings;
    ensureStyles();
    var card = document.createElement('div'); card.className = 'card'; card.id = 'imgAvatarCard';
    var opts = AV_EXPR.map(function (e) { return '<option value="' + e.key + '">' + e.key + '</option>'; }).join('');
    card.innerHTML = [
      '<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><circle cx="12" cy="10" r="2.8"/><path d="M6.5 19.5a5.5 5.5 0 0 1 11 0"/></svg>角色头像</h4>',
      '<p>以发图基准图为底，裁一张近景头像（可选表情），保存为当前角色头像。当前角色：<b id="imgAvWho"></b>。</p>',
      '<div class="av-row"><label style="font-size:12px;opacity:.8;">表情</label><select id="imgAvExpr">' + opts + '</select><button id="imgAvGen" style="font-weight:600;">生成头像</button><button id="imgAvBase">设为基准图</button><button id="imgAvDl">下载</button><button id="imgAvClear">清除</button></div>',
      '<div id="imgAvStatus" style="font-size:12px;opacity:.75;min-height:16px;"></div>',
      '<div id="imgAvPreview"></div>'
    ].join('');
    slot.appendChild(card);
    var who = document.getElementById('imgAvWho'); if (who) who.textContent = activeName();
    renderPreview();
    document.getElementById('imgAvGen').addEventListener('click', function () { generate({ expression: (document.getElementById('imgAvExpr') || {}).value }); });
    document.getElementById('imgAvBase').addEventListener('click', function () { var url = get(activeId()); if (!url) { setStatus('还没有头像'); return; } if (window.__chatImage && window.__chatImage.setBaseImage) { window.__chatImage.setBaseImage({ characterId: activeId(), imageUrl: url }); setStatus('已把头像设为该角色发图基准图'); } });
    document.getElementById('imgAvDl').addEventListener('click', function () { var url = get(activeId()); if (!url) { setStatus('还没有头像'); return; } var a = document.createElement('a'); a.href = url; a.download = 'avatar.png'; a.target = '_blank'; document.body.appendChild(a); a.click(); a.remove(); });
    document.getElementById('imgAvClear').addEventListener('click', function () { clear(activeId()); renderPreview(); setStatus('已清除当前角色头像'); });
    window.addEventListener('character:changed', function () { var w = document.getElementById('imgAvWho'); if (w) w.textContent = activeName(); renderPreview(); });
  }
  function init() { injectCard(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();