/**
 * image-cache.js · 提示词缓存去重 · 省每日额度
 *
 * 包 window.fetch。加载顺序为 image-quota.js → image-cache.js → image-album.js（album 最外层）:
 * 拦截 POST /img/v1/images/generations，按 model|size|prompt 哈希。
 * 命中缓存 → 直接返回上次结果（不打 Gitee、不计额度）；未命中 → 真生成后记录。
 * 仅缓存 n=1 且返回 http(s) 直链的结果；data: base64 不缓存（防 LS 膨胀）。
 * 直链有时效，默认 TTL 6 小时（主要省同一会话里反复重出同一张）。
 * LS cfw_image_cache_v1 / 开关 cfw_image_cache_enabled_v1（缓存设置卡已迁移至 settings.js）。
 *
 * window.__imageCache = { get, put, clear, stats, isEnabled, setEnabled, hashKey }
 */
(function () {
  'use strict';
  if (window.__imageCache) return;

  var LS_CACHE = 'cfw_image_cache_v1';
  var LS_ON = 'cfw_image_cache_enabled_v1';
  var MAX = 80;
  var TTL = 6 * 3600 * 1000;
  var GEN_MARK = 'images/generations';

  function load() { try { return JSON.parse(localStorage.getItem(LS_CACHE) || '{}') || {}; } catch (e) { return {}; } }
  function save(o) { try { localStorage.setItem(LS_CACHE, JSON.stringify(o)); } catch (e) {} }
  function state() { var o = load(); if (!o.entries) o.entries = {}; if (typeof o.saved !== 'number') o.saved = 0; return o; }
  function isEnabled() { try { return localStorage.getItem(LS_ON) !== '0'; } catch (e) { return true; } }
  function setEnabled(v) { try { localStorage.setItem(LS_ON, v ? '1' : '0'); } catch (e) {} fire(); }
  function fire() { try { window.dispatchEvent(new CustomEvent('imagecache:changed')); } catch (e) {} }

  function hashKey(s) {
    var h = 5381, i = s.length;
    while (i) { h = (h * 33) ^ s.charCodeAt(--i); }
    return 'k' + (h >>> 0).toString(36);
  }
  function keyFromBody(b) {
    var model = b.model || 'z-image-turbo';
    var size = b.size || '1024x1024';
    var prompt = (b.prompt || '').trim();
    if (!prompt) return null;
    return hashKey(model + '|' + size + '|' + prompt);
  }

  function get(key) {
    if (!key) return null;
    var o = state(); var e = o.entries[key];
    if (!e) return null;
    if (Date.now() - e.ts > TTL) { delete o.entries[key]; save(o); return null; }
    return e.url || null;
  }
  function put(key, url, prompt) {
    if (!key || !url || url.indexOf('data:') === 0) return;
    var o = state();
    o.entries[key] = { url: url, ts: Date.now(), prompt: (prompt || '').slice(0, 120) };
    var keys = Object.keys(o.entries);
    if (keys.length > MAX) {
      keys.map(function (k) { return [k, o.entries[k].ts]; })
        .sort(function (a, b) { return a[1] - b[1]; })
        .slice(0, keys.length - MAX)
        .forEach(function (p) { delete o.entries[p[0]]; });
    }
    save(o); fire();
  }
  function bumpSaved() { var o = state(); o.saved = (o.saved || 0) + 1; save(o); fire(); }
  function clear() { save({ entries: {}, saved: 0 }); fire(); }
  function stats() { var o = state(); return { count: Object.keys(o.entries).length, saved: o.saved || 0 }; }

  window.__imageCache = { get: get, put: put, clear: clear, stats: stats, isEnabled: isEnabled, setEnabled: setEnabled, hashKey: hashKey };

  var orig = window.fetch.bind(window);
  function urlOf(input) { try { return typeof input === 'string' ? input : ((input && input.url) || ''); } catch (e) { return ''; } }
  window.fetch = function (input, init) {
    try {
      var url = urlOf(input);
      var method = (((init && init.method) || (input && input.method)) || 'GET').toUpperCase();
      if (isEnabled() && method === 'POST' && url.indexOf(GEN_MARK) !== -1 && url.indexOf('async/') === -1) {
        var raw = init && init.body;
        if (typeof raw === 'string') {
          var body = null;
          try { body = JSON.parse(raw); } catch (e) { body = null; }
          if (body && (body.n == null || body.n === 1)) {
            var key = keyFromBody(body);
            var hit = get(key);
            if (hit) {
              bumpSaved();
              return Promise.resolve(new Response(
                JSON.stringify({ data: [{ url: hit }], _cached: true }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
              ));
            }
            return orig(input, init).then(function (res) {
              try {
                if (res && res.ok) {
                  res.clone().json().then(function (j) {
                    var first = (j && j.data && j.data[0]) || null;
                    var u = first && first.url;
                    if (u) put(key, u, body.prompt);
                  }).catch(function () {});
                }
              } catch (e) {}
              return res;
            });
          }
        }
      }
    } catch (e) {}
    return orig(input, init);
  };

  function byId(id) { return document.getElementById(id); }
  // 缓存卡已迁移至 settings.js 统一挂载
})();