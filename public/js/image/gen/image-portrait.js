/**
 * image-portrait.js
 * window.__portrait = { generateForActive, setAsBase, buildPrompt, getStyle, setStyle, getLastImage }
 */
(function () {
  'use strict';
  if (window.__portrait) return;

  var LS_STYLE = 'cfw_image_style_v1';
  var STYLES = {
    none:     { label: '\u9ed8\u8ba4', tags: '' },
    real:     { label: '\u5199\u5b9e', tags: '\u5199\u5b9e\u98ce\u683c / photorealistic' },
    anime:    { label: '\u52a8\u6f2b\u00b7\u65e5\u7cfb', tags: '\u73b0\u4ee3\u65e5\u7cfb\u52a8\u6f2b / anime \u63d2\u753b\u98ce\u683c' },
    soft:     { label: '\u65e5\u7cfb\u539a\u6d82', tags: '\u65e5\u7cfb\u539a\u6d82 / Japanese semi-realistic painterly' },
    webtoon:  { label: '\u97e9\u6f2b\u00b7\u7f51\u6f2b', tags: '\u97e9\u6f2b / Korean webtoon manhwa' },
    uscomic:  { label: '\u7f8e\u6f2b\u00b7\u7f8e\u5f0f', tags: '\u7f8e\u6f2b / American comic' },
    gufeng:   { label: '\u4e2d\u5f0f\u00b7\u56fd\u98ce', tags: '\u4e2d\u5f0f\u56fd\u98ce\u63d2\u753b / Chinese gufeng ink painting' },
    fantasy:  { label: '\u6b27\u7f8e\u5947\u5e7b\u539a\u6d82', tags: '\u6b27\u7f8e\u5947\u5e7b\u539a\u6d82 / Western fantasy concept art' },
    oil:      { label: '\u53e4\u5178\u6cb9\u753b', tags: '\u53e4\u5178\u6cb9\u753b / classical oil painting' },
    water:    { label: '\u6c34\u5f69', tags: '\u6c34\u5f69\u63d2\u753b / watercolor painting' },
    render3d: { label: '3D\u00b7\u76ae\u514b\u65af', tags: '3D \u6e32\u67d3 / Pixar Disney 3D render' },
    chibi:    { label: 'Q\u7248\u00b7\u841d\u7cfb', tags: 'Q \u7248\u841d\u7cfb / chibi' },
    inkmanga: { label: '\u9ed8\u767d\u6f2b\u753b', tags: '\u65e5\u5f0f\u9ed8\u767d\u6f2b\u753b / black-and-white manga' },
    cyber:    { label: '\u8d5b\u535a\u670b\u514b', tags: '\u8d5b\u535a\u670b\u514b\u63d2\u753b / cyberpunk' }
  };
  var lastImage = null;

  function byId(id) { return document.getElementById(id); }
  function getStyle() { try { return localStorage.getItem(LS_STYLE) || 'none'; } catch (e) { return 'none'; } }
  function setStyle(s) {
    try { localStorage.setItem(LS_STYLE, s || 'none'); } catch (e) {}
    try { window.dispatchEvent(new CustomEvent('imagestyle:changed', { detail: { style: getStyle() } })); } catch (e) {}
  }
  function styleTags() {
    var key = getStyle();
    var s = STYLES[key];
    if (!s || !s.tags) return '';
    if (key === 'real') return s.tags;
    return '\u8fd9\u662f\u4e00\u5e45\u4e8c\u7ef4\u63d2\u753b/\u624b\u7ed8\u4f5c\u54c1\uff08\u7edd\u5bf9\u4e0d\u662f\u771f\u4eba\u7167\u7247\uff09\u3002' + s.tags;
  }

  function subjectPhrase(card) {
    var s = (((card && card.gender) || '') + ' ' + ((card && card.name) || '')).toLowerCase();
    if (/\u5973|girl|female|woman|\u5c11\u5973|\u841d\u8389/.test(s)) return '\u4e00\u4f4d\u5973\u6027\u89d2\u8272';
    if (/\u7537|boy|male|man|\u5c11\u5e74/.test(s)) return '\u4e00\u4f4d\u7537\u6027\u89d2\u8272';
    return '\u4e00\u4f4d\u89d2\u8272';
  }
  function buildPrompt(card) {
    var st = styleTags();
    var parts = [];
    if (st && getStyle() !== 'real') parts.push('\u753b\u98ce\u52a1\u5fc5\u4e25\u683c\u9075\u5faa\uff1a' + st);
    parts.push('\u753b\u9762\u5185\u5bb9\uff1a\u534a\u8eab\u808c\u50cf\uff0c' + subjectPhrase(card) + '\uff0c\u5355\u4eba\uff0c\u6b63\u9762\u9762\u5411\u955c\u5934');
    if (card) {
      if (card.age) parts.push('\u89d2\u8272\u5e74\u9f84\uff1a' + String(card.age).trim());
      if (card.identity) parts.push('\u8eab\u4efd\u4e0e\u80cc\u666f\uff1a' + card.identity);
      if (card.personality) parts.push('\u6c14\u8d28\u6027\u683c\uff1a' + card.personality);
    }
    parts.push('\u67d4\u548c\u81ea\u7136\u7684\u6253\u5149\uff0c\u5e72\u51c0\u7b80\u6d01\u7684\u80cc\u666f\uff0c\u6784\u56fe\u5747\u8861\uff0c\u7ec6\u8282\u4e30\u5bcc\u3001\u6784\u56fe\u5b8c\u6574\u3001\u6770\u4f5c\u7ea7\u5b8c\u6210\u5ea6');
    if (st && getStyle() === 'real') parts.push('\u753b\u98ce\u52a1\u5fc5\u4e25\u683c\u9075\u5faa\uff1a' + st);
    else if (st) parts.push('\u6574\u5e45\u4f5c\u54c1\u52a1\u5fc5\u662f\u4e0a\u8ff0\u753b\u98ce\u7684\u63d2\u753b,\u7edd\u4e0d\u753b\u6210\u771f\u4eba\u5199\u5b9e\u7167\u7247');
    return parts.filter(Boolean).join('\uff0c') + '\u3002';
  }
  function activeCard() {
    try { return (window.__character && window.__character.getActiveCard) ? window.__character.getActiveCard() : null; } catch (e) { return null; }
  }

  async function rawGenerate(prompt) {
    if (window.__image && typeof window.__image.generate === 'function') {
      var data = await window.__image.generate({ prompt: prompt, n: 1, size: '768x1024' });
      var d = (data && data[0]) || null;
      if (d) return d.url || (d.b64_json ? 'data:image/png;base64,' + d.b64_json : null);
      return null;
    }
    var key = '';
    try { key = localStorage.getItem('cfw_image_key_v1') || localStorage.getItem('moark_api_key') || ''; } catch (e) {}
    if (!key) throw new Error('\u8bf7\u5148\u5728\u8bbe\u7f6e \u2192 \u6a21\u578b API \u2192 \u56fe\u50cf\u6e20\u9053\u586b\u5199\u5f53\u524d\u6e20\u9053\u7684 Key');
    var _h = { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' };
    try { var _t = (window.__auth && window.__auth.getToken && window.__auth.getToken()) || localStorage.getItem('cfw_auth_token_v1') || ''; if (_t) _h['X-Sync-Token'] = _t; } catch (e) {}
    var r = await fetch('/img/v1/images/generations', {
      method: 'POST',
      headers: _h,
      body: JSON.stringify({ prompt: prompt, model: 'z-image-turbo', n: 1, size: '768x1024' })
    });
    if (!r.ok) throw new Error('\u751f\u6210\u5931\u8d25 ' + r.status);
    var j = await r.json();
    var first = (j.data || [])[0] || null;
    if (!first) throw new Error('\u65e0\u8fd4\u56de');
    return first.url || (first.b64_json ? 'data:image/png;base64,' + first.b64_json : null);
  }

  async function generateForActive() {
    var card = activeCard();
    if (!card) throw new Error('\u8bf7\u5148\u5728\u300c\u89d2\u8272\u5361\u300d\u91cc\u9009\u62e9\u4e00\u4e2a\u89d2\u8272');
    var img = await rawGenerate(buildPrompt(card));
    if (!img) throw new Error('\u672a\u53d6\u5230\u56fe\u7247');
    lastImage = { url: img, characterId: card.id || 'default', name: card.name || '' };
    return lastImage;
  }
  async function setAsBase(imageUrl, characterId) {
    var card = activeCard();
    var id = characterId || (lastImage && lastImage.characterId) || (card && card.id) || 'default';
    var url = imageUrl || (lastImage && lastImage.url);
    if (!url) throw new Error('\u8fd8\u6ca1\u6709\u53ef\u7528\u7684\u7acb\u7ed8');
    if (!(window.__chatImage && window.__chatImage.setBaseImage)) throw new Error('\u53d1\u56fe\u6a21\u5757\u672a\u5c31\u7eea');
    await window.__chatImage.setBaseImage({ characterId: id, imageUrl: url });
    return id;
  }
  function getLastImage() { return lastImage; }

  window.__portrait = {
    generateForActive: generateForActive, setAsBase: setAsBase, buildPrompt: buildPrompt,
    getStyle: getStyle, setStyle: setStyle, getStyleTags: styleTags, getLastImage: getLastImage
  };

  // injectCard/injectGlobalStyleCard 已迁移至 settings.js 统一挂载(4.82 删除空壳残留)
  // settings.js unified mount
})();
