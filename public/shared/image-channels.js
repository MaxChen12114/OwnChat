/**
 * image-channels.js · 图像渠道注册表（数据驱动）
 *
 * 渠道是用户可维护的数据，不是代码里的 if/else：
 *   { id, name, kind: 'openai'|'comfyui', transport: 'site'|'direct',
 *     baseUrl, key, models: [], model, editModel, capabilities: ['t2i','edit'],
 *     ckpt, steps, cfg, sampler, scheduler }
 *
 * - Gitee 只是内置的一条 openai 预设（transport:'site'，走 Worker /img/v1 代理）
 * - 自定义 OpenAI 兼容渠道默认 transport:'direct'（浏览器直连 baseUrl）
 * - 本地 ComfyUI kind:'comfyui'（浏览器直连 /prompt、/history、/view）
 *
 * save() 只落盘，不自动切 active；切换当前渠道用 setActive()（与聊天渠道卡语义一致）。
 *
 * 必须在 image-common.js 之前加载；本模块不碰 DOM。
 */
(function () {
  'use strict';
  if (window.__imageChannels) return;

  var LS_CHANNELS = 'cfw_image_channels_v1';
  var LS_ACTIVE = 'cfw_image_channel_active_v1';
  var LEGACY_KEY = 'cfw_image_key_v1';

  var DEFAULT_GITEE = {
    id: 'gitee',
    name: 'Gitee AI',
    kind: 'openai',
    transport: 'site',
    baseUrl: 'https://ai.gitee.com/v1',
    key: '',
    models: ['z-image-turbo', 'Qwen-Image-Edit-2511'],
    model: 'z-image-turbo',
    editModel: 'Qwen-Image-Edit-2511',
    capabilities: ['t2i', 'edit']
  };

  function clone(o) { try { return JSON.parse(JSON.stringify(o)); } catch (e) { return o; } }
  function read() {
    try {
      var a = JSON.parse(localStorage.getItem(LS_CHANNELS) || '[]');
      return Array.isArray(a) ? a : [];
    } catch (e) { return []; }
  }
  function write(a) { try { localStorage.setItem(LS_CHANNELS, JSON.stringify(a.slice(0, 40))); } catch (e) {} }
  function normModels(v) {
    if (Array.isArray(v)) return v.map(function (x) { return String(x || '').trim(); }).filter(Boolean).slice(0, 30);
    return String(v || '').split(/[,，\n]/).map(function (x) { return x.trim(); }).filter(Boolean).slice(0, 30);
  }
  function norm(ch) {
    ch = ch || {};
    var id = String(ch.id || '').trim() || ('ch-' + Date.now().toString(36));
    var kind = ch.kind === 'comfyui' ? 'comfyui' : 'openai';
    var transport = ch.transport === 'site' ? 'site' : (ch.transport === 'direct' ? 'direct' : (id === 'gitee' ? 'site' : 'direct'));
    var models = normModels(ch.models);
    if (!models.length && id === 'gitee') models = ['z-image-turbo', 'Qwen-Image-Edit-2511'];
    var caps = Array.isArray(ch.capabilities) ? ch.capabilities.filter(function (x) { return x === 't2i' || x === 'edit'; }) : null;
    if (!caps) caps = (kind === 'openai' && ch.editModel) ? ['t2i', 'edit'] : ['t2i'];
    if (kind === 'comfyui') caps = ['t2i', 'edit']; // img2img 工作流支持参考图改图
    return {
      id: id,
      name: String(ch.name || (kind === 'comfyui' ? '本地 ComfyUI' : '自定义渠道')).slice(0, 60),
      kind: kind,
      transport: transport,
      baseUrl: String(ch.baseUrl || '').trim().replace(/\/+$/, ''),
      key: String(ch.key || ''),
      models: models,
      model: String(ch.model || models[0] || '').trim(),
      editModel: String(ch.editModel || '').trim(),
      capabilities: caps,
      ckpt: String(ch.ckpt || 'z-image-turbo-fp8-aio.safetensors').trim(),
      steps: Math.max(1, Math.min(80, parseInt(ch.steps, 10) || 9)),
      cfg: Math.max(0, Math.min(30, parseFloat(ch.cfg) || 1)),
      sampler: String(ch.sampler || 'res_multistep').trim(),
      scheduler: String(ch.scheduler || 'simple').trim()
    };
  }
  function ensure() {
    var a = read().map(norm);
    if (!a.length) a = [norm(clone(DEFAULT_GITEE))];
    // 老版本只有一个 Gitee key：迁进 gitee 渠道（保留旧 key 作为 fallback）
    try {
      // 2026-11-08 修(审查 P1): 迁移一次性化 —— 旧版每次 ensure 都从 legacy 回填,用户在渠道卡
      // 清除 Key 后下一次 list() 就复活,Key 永远清不掉。迁完即删 legacy 源。
      var legacy = localStorage.getItem(LEGACY_KEY) || '';
      if (legacy) {
        var g = a.find(function (x) { return x.id === 'gitee'; });
        if (g && !g.key) g.key = legacy;
        localStorage.removeItem(LEGACY_KEY);
      }
    } catch (e) {}
    write(a);
    return a;
  }
  function list() { return ensure(); }
  function get(id) {
    var a = list();
    return a.find(function (x) { return x.id === id; }) || null;
  }
  function activeId() {
    var a = list();
    var want = '';
    try { want = localStorage.getItem(LS_ACTIVE) || ''; } catch (e) {}
    if (want && a.some(function (x) { return x.id === want; })) return want;
    return a[0] ? a[0].id : '';
  }
  function setActive(id) {
    var a = list();
    if (!a.some(function (x) { return x.id === id; })) return false;
    try { localStorage.setItem(LS_ACTIVE, id); } catch (e) {}
    emit();
    return true;
  }
  function getActive() {
    var a = list();
    var id = activeId();
    return a.find(function (x) { return x.id === id; }) || a[0] || null;
  }
  function save(ch) {
    var n = norm(ch);
    var a = list();
    var i = a.findIndex(function (x) { return x.id === n.id; });
    if (i >= 0) a[i] = n; else a.push(n);
    write(a);
    // 保存 ≠ 启用：切换当前渠道走 setActive（与聊天渠道卡一致，避免新增时把原渠道顶掉）
    emit();
    return n;
  }
  function create() {
    var a = list();
    var id = 'ch-' + Date.now().toString(36);
    var ch = norm({
      id: id, name: '新渠道', kind: 'openai', transport: 'direct',
      baseUrl: '', key: '', models: [], model: '', editModel: '', capabilities: ['t2i']
    });
    a.push(ch); write(a);
    emit();
    return ch;
  }
  function remove(id) {
    var a = list();
    if (a.length <= 1) return false; // 至少留一条
    a = a.filter(function (x) { return x.id !== id; });
    write(a);
    try {
      if ((localStorage.getItem(LS_ACTIVE) || '') === id) localStorage.setItem(LS_ACTIVE, a[0].id);
    } catch (e) {}
    emit();
    return true;
  }
  function hasEdit(ch) {
    ch = ch || getActive();
    // 2026-11-08: 改图能力渠道化 —— ComfyUI 走 img2img；openai 直连渠道配置了改图模型
    // (norm() 会给 caps 补 edit) 同样可改图；site 传输(Gitee 预设)维持原有 caps 判定。
    if (!ch) return false;
    if (ch.kind === 'comfyui') return true;
    return !!(ch.kind === 'openai' && ch.capabilities && ch.capabilities.indexOf('edit') >= 0);
  }
  function models(ch) {
    ch = ch || getActive();
    return (ch && ch.models) ? ch.models.slice() : [];
  }
  var listeners = [];
  function onChange(fn) { if (typeof fn === 'function') listeners.push(fn); }
  function emit() { listeners.forEach(function (fn) { try { fn(getActive()); } catch (e) {} }); }

  window.__imageChannels = {
    list: list, get: get, getActive: getActive, activeId: activeId, setActive: setActive,
    save: save, create: create, remove: remove, hasEdit: hasEdit, models: models, onChange: onChange,
    DEFAULT_GITEE: clone(DEFAULT_GITEE)
  };
})();
