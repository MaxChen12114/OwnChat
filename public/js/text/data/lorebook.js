/**
 * lorebook.js · 设定集（世界书 / Lore Book）数据层
 * P2 设定集基建（4.49；界面术语 2026-10-06 从「世界书」统一为「设定集」）。与 character.js 平级的 data 层模块。
 *
 * 存储：localStorage key `tavern_lorebook_v1`（纯文本条目，体积小）。
 *   选 LS 而非 IDB 的原因：世界书是小文本，放 LS 可被现有 sync.js 自动 dump 进云端 KV，
 *   一并实现「文件云端」——换设备同步世界观，无需单独写 IDB 上云通道。
 *
 * 条目 schema:
 *   { id, name, keywords[], content, alwaysOn, priority, scope:'global'|'perCard', boundCardId, enabled, source }
 *   - alwaysOn: 常驻注入（无视关键词）
 *   - keywords: 命中最近对话文本时才注入（alwaysOn=false 且无 keywords = 永不注入）
 *   - scope: global=全局生效；perCard=仅绑定的角色卡生效（boundCardId）
 *   - priority: 数字，越大越靠前
 *
 * 公开 API：window.__lorebook = {
 *   getAll, getEntry, saveEntry, deleteEntry,
 *   getActiveEntries({text, cardId}),   // 供 app.js 在发送时筛出当前生效条目
 *   exportAll, importAll(arr,{merge}),
 *   parseSillyTavernBook(json, source)  // ST v2 world info / character_book 解析
 * }
 * 变更后派发 window 事件 'lorebook:changed'（编辑器世界观 Tab 监听刷新）。
 */
(function(){
  'use strict';
  if (window.__lorebook) return;

  var LS_KEY = 'tavern_lorebook_v1';

  function load(){
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.map(normalize) : [];
    } catch (e) { return []; }
  }
  function save(arr){
    try { localStorage.setItem(LS_KEY, JSON.stringify((arr || []).map(normalize))); } catch (e) {}
    notify();
  }
  function notify(){
    try { window.dispatchEvent(new Event('lorebook:changed')); } catch (e) {}
  }
  function uid(){
    return 'lb_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function normalize(e){
    e = e || {};
    var kws = e.keywords;
    if (typeof kws === 'string') kws = kws.split(/[,，;；\n]/);
    if (!Array.isArray(kws)) kws = [];
    kws = kws.map(function(k){ return String(k == null ? '' : k).trim(); }).filter(Boolean);
    return {
      id: e.id || uid(),
      name: String(e.name || '').trim(),
      keywords: kws,
      content: String(e.content || ''),
      alwaysOn: !!e.alwaysOn,
      priority: (typeof e.priority === 'number' && isFinite(e.priority)) ? e.priority : (parseInt(e.priority, 10) || 0),
      scope: e.scope === 'perCard' ? 'perCard' : 'global',
      boundCardId: e.boundCardId || '',
      enabled: e.enabled !== false,
      source: e.source || ''
    };
  }

  function getAll(){ return load(); }
  function getEntry(id){ return load().filter(function(e){ return e.id === id; })[0] || null; }

  function saveEntry(entry){
    var e = normalize(entry);
    var arr = load();
    var i = arr.findIndex(function(x){ return x.id === e.id; });
    if (i >= 0) arr[i] = e; else arr.push(e);
    save(arr);
    return e;
  }
  function deleteEntry(id){
    var arr = load().filter(function(e){ return e.id !== id; });
    save(arr);
  }

  // 供 app.js 在 send 时调用：按 scope + alwaysOn/keywords 命中筛出当前应注入的条目，priority 降序
  function getActiveEntries(opts){
    opts = opts || {};
    var text = String(opts.text || '').toLowerCase();
    var cardId = opts.cardId || '';
    var hit = load().filter(function(e){
      if (e.enabled === false) return false;
      if (!(e.content || '').trim()) return false;
      if (e.scope === 'perCard' && !(e.boundCardId && e.boundCardId === cardId)) return false;
      if (e.alwaysOn) return true;
      if (!e.keywords.length) return false;
      return e.keywords.some(function(k){ k = k.toLowerCase(); return k && text.indexOf(k) >= 0; });
    });
    hit.sort(function(a, b){ return (b.priority || 0) - (a.priority || 0); });
    return hit;
  }

  function exportAll(){ return load(); }
  function importAll(arr, opts){
    opts = opts || {};
    if (!Array.isArray(arr)) return 0;
    var add = arr.map(normalize).filter(function(e){ return e.content.trim() || e.name; });
    if (opts.merge) {
      var cur = load();
      // 合并时重新分配 id，避免与现有冲突
      add.forEach(function(e){ e.id = uid(); cur.push(e); });
      save(cur);
    } else {
      save(add);
    }
    return add.length;
  }

  // SillyTavern v2：world info 文件（{entries:{...}}）或角色卡内嵌 character_book
  function parseSillyTavernBook(data, source){
    var book = data;
    if (data && data.character_book) book = data.character_book;          // 角色卡内嵌
    else if (data && data.data && data.data.character_book) book = data.data.character_book;
    var entriesObj = book && (book.entries || (book.data && book.data.entries));
    var out = [];
    if (entriesObj && typeof entriesObj === 'object') {
      var list = Array.isArray(entriesObj) ? entriesObj : Object.keys(entriesObj).map(function(k){ return entriesObj[k]; });
      list.forEach(function(en){
        if (!en) return;
        var content = typeof en.content === 'string' ? en.content : '';
        if (!content.trim()) return;
        var keys = en.keys || en.key || [];
        if (typeof keys === 'string') keys = keys.split(/[,，]/);
        out.push(normalize({
          name: en.comment || en.name || '',
          keywords: keys,
          content: content,
          alwaysOn: !!(en.constant || en.alwaysOn),
          priority: (typeof en.insertion_order === 'number') ? en.insertion_order : (typeof en.order === 'number' ? en.order : 0),
          enabled: !(en.disable === true || en.enabled === false),
          scope: 'global',
          source: source || 'SillyTavern'
        }));
      });
    }
    return out;
  }

  window.__lorebook = {
    getAll: getAll,
    getEntry: getEntry,
    saveEntry: saveEntry,
    deleteEntry: deleteEntry,
    getActiveEntries: getActiveEntries,
    exportAll: exportAll,
    importAll: importAll,
    parseSillyTavernBook: parseSillyTavernBook,
    LS_KEY: LS_KEY
  };
})();