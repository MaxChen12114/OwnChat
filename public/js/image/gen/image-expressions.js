/**
 * image-expressions.js · 表情差分包
 * 基于当前角色的发图基准图，用 Qwen-Image-Edit 只改表情、其余不变。
 * 依赖 window.__chatImage.editImage({ characterId, instruction })。
 * 生成结果会被 image-album 自动收进本地画廊。
 * window.__expressions = { generate, generateAll, list }
 */
(function () {
  'use strict';
  if (window.__expressions) return;

  var EXPR = [
    { key: '开心', en: 'a happy bright cheerful smile' },
    { key: '害羞', en: 'a shy bashful expression with a light blush' },
    { key: '生气', en: 'an angry annoyed expression with a slight pout' },
    { key: '惊讶', en: 'a surprised expression with wide open eyes' },
    { key: '难过', en: 'a sad sorrowful downcast expression' },
    { key: '微笑', en: 'a gentle soft warm smile' }
  ];

  function instructionFor(en) {
    return 'Keep the SAME person, identical pose, outfit, hairstyle, camera framing and background from the source image. Change ONLY the facial expression to ' + en + '. consistent character, natural, high quality.';
  }
  function activeCard() { try { return (window.__character && window.__character.getActiveCard && window.__character.getActiveCard()) || null; } catch (e) { return null; } }
  function activeCharId() { var c = activeCard(); return (c && c.id) || 'default'; }
  function activeCharName() { var c = activeCard(); return (c && c.name) || '当前角色'; }

  function setStatus(msg) { var el = document.getElementById('imgExprStatus'); if (el) el.textContent = msg || ''; }
  function addResult(expr, imageUrl) {
    var wrap = document.getElementById('imgExprResults'); if (!wrap) return;
    var fig = document.createElement('div'); fig.className = 'expr-thumb';
    var img = document.createElement('img'); img.src = imageUrl; img.alt = expr; img.title = expr;
    img.addEventListener('click', function () { window.open(imageUrl, '_blank'); });
    var cap = document.createElement('div'); cap.className = 'expr-cap'; cap.textContent = expr;
    fig.appendChild(img); fig.appendChild(cap); wrap.insertBefore(fig, wrap.firstChild);
  }

  async function generate(exprKey) {
    var item = EXPR.filter(function (e) { return e.key === exprKey; })[0];
    if (!item) return;
    if (!(window.__chatImage && window.__chatImage.editImage)) { setStatus('发图模块未就绪，无法生成'); return; }
    setStatus('正在生成「' + item.key + '」…（首次无基准图会先造一张，约 30-45s）');
    try {
      var res = await window.__chatImage.editImage({ characterId: activeCharId(), instruction: instructionFor(item.en) });
      if (res && res.imageUrl) { addResult(item.key, res.imageUrl); setStatus('「' + item.key + '」已生成，已存入本地画廊'); }
      else setStatus('「' + item.key + '」未返回结果');
    } catch (e) { setStatus('生成失败:' + ((e && e.message) || e)); }
  }
  async function generateAll() {
    for (var i = 0; i < EXPR.length; i++) { await generate(EXPR[i].key); }
    setStatus('全套表情已生成完毕，去本地画廊查看/管理');
  }

  window.__expressions = { generate: generate, generateAll: generateAll, list: EXPR };

  function ensureStyles() {
    if (document.getElementById('exprStyles')) return;
    var s = document.createElement('style'); s.id = 'exprStyles';
    s.textContent = [
      '.expr-btns{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0;}',
      '.expr-btns button{font-size:12px;padding:4px 10px;border-radius:8px;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;cursor:pointer;}',
      '.expr-btns button:hover{background:rgba(127,127,127,.15);}',
      '.expr-results{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;}',
      '.expr-thumb{width:96px;}',
      '.expr-thumb img{width:96px;height:120px;object-fit:cover;border-radius:8px;display:block;cursor:zoom-in;}',
      '.expr-cap{font-size:11px;opacity:.7;text-align:center;margin-top:2px;}'
    ].join('');
    document.head.appendChild(s);
  }
  function injectCard() {
    var settings = document.getElementById('settings');
    if (!settings || document.getElementById('imgExprCard')) return;
    // 2026-10-05: 显式挂进「发图」类目的 #settingsImageSlot,不再 append 到 #settings 根
    // 靠 index.html 的 MutationObserver「扫孤儿」搬过去 —— 那是歪打正着,不是显式归属。
    // 回落 #settings 只为老页面(缺该 slot 时卡仍能显示,只是落在面板底部)。
    var slot = document.getElementById('settingsImageSlot') || settings;
    ensureStyles();
    var card = document.createElement('div'); card.className = 'card'; card.id = 'imgExprCard';
    var btns = EXPR.map(function (e) { return '<button data-expr="' + e.key + '">' + e.key + '</button>'; }).join('');
    card.innerHTML = [
      '<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8.5 15c.8-1.2 2-2 3.5-2s2.7.8 3.5 2"/><circle cx="9" cy="9.5" r=".9"/><circle cx="15" cy="9.5" r=".9"/></svg>表情差分包</h4>',
      '<p>基于当前角色的发图基准图，只改表情、其余（姿势/穿着/背景）不变。当前角色：<b id="imgExprWho"></b>。生成的图自动存入本地画廊。</p>',
      '<div class="expr-btns">' + btns + '<button data-expr="__all__" style="font-weight:600;">生成全套</button></div>',
      '<div id="imgExprStatus" style="font-size:12px;opacity:.75;min-height:16px;"></div>',
      '<div class="expr-results" id="imgExprResults"></div>'
    ].join('');
    slot.appendChild(card);
    var who = document.getElementById('imgExprWho'); if (who) who.textContent = activeCharName();
    card.querySelectorAll('.expr-btns button').forEach(function (b) {
      b.addEventListener('click', function () { var k = b.getAttribute('data-expr'); if (k === '__all__') generateAll(); else generate(k); });
    });
    window.addEventListener('character:changed', function () { var w = document.getElementById('imgExprWho'); if (w) w.textContent = activeCharName(); });
  }
  function init() { injectCard(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();