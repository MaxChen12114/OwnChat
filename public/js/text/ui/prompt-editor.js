
(function(){
  'use strict';

  if (window.__promptEditor) return;

  var MASK_ID = 'promptEditorMask';

  // 4.59 线性图标:编辑器标题 + 各 Tab 改用与全站一致的 currentColor 线性 SVG(替换 emoji,去掉 v0 骨架角标)。
  // 2026-10-06: 动作按钮(编辑/删除/拖拽/箭头/关闭)也一并 SVG 化 —— 原先这些位置是 ✎ ✕ ⠹ ▸ 这类文字字形。
  function ueSvg(d, size){ return '<svg viewBox="0 0 24 24" width="' + (size||16) + '" height="' + (size||16) + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-3px;flex:none;">' + d + '</svg>'; }
  var UE_ICON = {
    wrench: ueSvg('<path d="M4 7h10M18 7h2M4 12h2M10 12h10M4 17h7M15 17h5"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="13" cy="17" r="2"/>', 17),
    preset: ueSvg('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/>'),
    character: ueSvg('<circle cx="12" cy="8.5" r="3.3"/><path d="M5.5 19.5a6.5 6.5 0 0 1 13 0"/>'),
    world: ueSvg('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.6 2.4 2.6 14.6 0 17M12 3.5c-2.6 2.4-2.6 14.6 0 17"/>'),
  };

  // 4.60 去 emoji:工具栏按钮 / 分区标题 / 占位符统一用线性 SVG(currentColor),替换 ＋↻📋📁📤📥🎨📐🖼🔊⚙️📦⌛
  var UE_A = {
    plus: ueSvg('<path d="M12 5v14M5 12h14"/>', 15),
    reload: ueSvg('<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>', 15),
    code: ueSvg('<path d="M9 8l-4 4 4 4M15 8l4 4-4 4"/>', 15),
    folder: ueSvg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', 15),
    imp: ueSvg('<path d="M12 3v12"/><path d="M8 11l4 4 4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>', 15),
    exp: ueSvg('<path d="M12 15V3"/><path d="M8 7l4-4 4 4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>', 15),
    // 2026-10-06: 动作按钮统一线性 SVG（原先这些位置是 ✎ ✕ ⠹ ▸ 这类文字/emoji 字形）
    pencil: ueSvg('<path d="M4 20h4l10-10-4-4L4 16z"/><path d="M14 6l4 4"/>', 14),
    close: ueSvg('<path d="M6 6l12 12M18 6L6 18"/>', 14),
    grip: ueSvg('<circle cx="9" cy="6" r="1.3"/><circle cx="15" cy="6" r="1.3"/><circle cx="9" cy="12" r="1.3"/><circle cx="15" cy="12" r="1.3"/><circle cx="9" cy="18" r="1.3"/><circle cx="15" cy="18" r="1.3"/>', 14),
    chevron: ueSvg('<path d="M9 6l6 6-6 6"/>', 14),
    file: ueSvg('<path d="M7 3.5h7L18.5 8v12.5H7z"/><path d="M14 3.5V8h4.5"/>', 14),
  };

  var TABS = [
    {
      id: 'preset', icon: UE_ICON.preset, label: '指令模块',
      desc: '编辑每轮注入 system 的附加指令（基座之后的语调/任务约束层）。带仓库文件名的条目来自 src/prompts/presets/（库），你可以改名、改内容、停用或新建；点「从库重载」把库里新增的条目拉进来（同名会被库原文覆盖）。'
    },
    {
      id: 'character', icon: UE_ICON.character, label: '角色',
      desc: '编辑角色卡的完整字段（身份/背景、场景、性格、说话方式、行为铁则、示例对话），支持导入 SillyTavern V2 卡与 PNG 卡。与左栏「角色卡」是同一份数据（都存本机 IndexedDB）：左栏负责快速切换，这里负责集中管理与导入导出。',
    },
    {
      id: 'world', icon: UE_ICON.world, label: '设定集',
      // desc 由 renderWorldTab 里的页内说明承担（这里留空即可；两处都写会漂移）
      desc: '',
    },
  ];

  var currentTab = 'preset';
  var mask = null;

  function buildDom(){
    if (document.getElementById(MASK_ID)) return;
    mask = document.createElement('div');
    mask.id = MASK_ID;
    mask.innerHTML = [
      '<div id="promptEditor" role="dialog" aria-label="提示词编辑器" aria-modal="true">',
        '<div class="ue-header">',
          '<div class="ue-title">' + UE_ICON.wrench + ' 提示词编辑器</div>',
          '<button class="ue-close" id="ueCloseBtn" aria-label="关闭" title="关闭(ESC)">' + UE_A.close + '</button>',
        '</div>',
        '<div class="ue-tabs" id="ueTabs" role="tablist">',
          TABS.map(function(t){
            return '<button class="ue-tab" role="tab" data-tab="' + t.id + '" title="' + escapeAttr(t.label) + '"><span class="ue-tab-icon">' + t.icon + '</span><span class="ue-tab-label">' + escapeHtml(t.label) + '</span></button>';
          }).join(''),
        '</div>',
        '<div class="ue-body" id="ueBody" role="tabpanel"></div>',
        '<div class="ue-footer">',
          '<span class="ue-footer-hint">这里改的是本机数据（与左栏面板共用同一份），不会触发聊天。Esc 退出。</span>',
          '<button class="ue-btn-ghost" id="ueFooterClose">关闭</button>',
        '</div>',
      '</div>'
    ].join('');
    document.body.appendChild(mask);

    // 点遮罩外侧关闭（点内容区不关）
    mask.addEventListener('click', function(e){
      if (e.target === mask) close();
    });
    document.getElementById('ueCloseBtn').addEventListener('click', close);
    document.getElementById('ueFooterClose').addEventListener('click', close);

    document.getElementById('ueTabs').addEventListener('click', function(e){
      var btn = e.target.closest && e.target.closest('.ue-tab');
      if (!btn) return;
      switchTab(btn.getAttribute('data-tab'));
    });

    document.addEventListener('keydown', function(e){
      if (e.key === 'Escape' && mask && mask.classList.contains('open')) close();
    });
  }

  function renderBody(){
    if (currentTab === 'preset') return renderPresetTab();
    if (currentTab === 'character') return renderCharacterTab();
    if (currentTab === 'world') return renderWorldTab();
  }

  function refreshTabs(){
    var btns = document.querySelectorAll('#ueTabs .ue-tab');
    btns.forEach(function(b){
      var on = b.getAttribute('data-tab') === currentTab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  function findTab(id){
    for (var i = 0; i < TABS.length; i++) if (TABS[i].id === id) return TABS[i];
    return null;
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
    });
  }
  function escapeAttr(s){ return escapeHtml(s); }

  function open(tabId){
    buildDom();
    if (tabId && findTab(tabId)) currentTab = tabId;
    refreshTabs();
    renderBody();
    mask.classList.add('open');
    document.body.classList.add('ue-open');
  }

  function close(){
    if (!mask) return;
    mask.classList.remove('open');
    document.body.classList.remove('ue-open');
  }

  function switchTab(tabId){
    if (!findTab(tabId)) return;
    currentTab = tabId;
    refreshTabs();
    renderBody();
  }

  function bindEntry(){
    var btn = document.getElementById('promptEditorBtn');
    if (btn && !btn.__ueBound) {
      btn.__ueBound = true;
      btn.addEventListener('click', function(e){
        e.preventDefault();
        open();
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindEntry);
  } else {
    bindEntry();
  }

  // 4.48: 左栏或本面板增删改角色卡后,若中枢正停在「角色」Tab 且未在编辑中,刷新列表保持一致
  window.addEventListener('character:changed', function(){
    if (!(mask && mask.classList.contains('open') && currentTab === 'character')) return;
    var slot = document.getElementById('ueCharEditor');
    if (slot && slot.children.length) return;
    renderCharacterTab();
  });

  // 4.49（2026-10-06 更新措辞）: 设定集条目增删改后,若编辑器正停在本页且未在编辑中,刷新列表保持一致
  window.addEventListener('lorebook:changed', function(){
    if (!(mask && mask.classList.contains('open') && currentTab === 'world')) return;
    var slot = document.getElementById('ueWorldEditor');
    if (slot && slot.children.length) return;
    renderWorldTab();
  });

  // ============== Preset Tab 实质化（4.7 v1）==============
  // 与 presets-ui.js 共用 LS key `cfw_prompt_presets_v1`，对左侧栏「提示词预设」面板完全兼容。
  // (4.82: 删掉"只有 Preset 实质化"的旧注释 —— character/world/ui/voice 此后均已实质化)

  var PRESETS_KEY = 'cfw_prompt_presets_v1';

  function uePresetsLoad(){
    try {
      var raw = localStorage.getItem(PRESETS_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  var uePresetSyncTimer = null;
  function ueTouchSync(reason){
    // 编辑器的提示词资产属于 cfw_prompt_presets_v1，理论上在 sync.js 白名单里。
    // 但手机 App / 单页内 setItem 场景里，用户保存后看不到同步状态，且可能在 30s debounce 前就切走。
    // 这里显式通知同步引擎：先 markDirty，再短延迟 pushNow，让跨设备更接近“保存即同步”。
    try {
      if (!window.__sync) return;
      if (typeof window.__sync.markDirty === 'function') window.__sync.markDirty();
      if (uePresetSyncTimer) clearTimeout(uePresetSyncTimer);
      uePresetSyncTimer = setTimeout(function(){
        uePresetSyncTimer = null;
        try {
          if (window.__sync && typeof window.__sync.pushNow === 'function') window.__sync.pushNow();
        } catch (e) {}
      }, 1200);
    } catch (e) {}
  }
  function uePresetsSave(arr){
    try { localStorage.setItem(PRESETS_KEY, JSON.stringify(arr)); } catch (e) {}
    ueTouchSync('presets');
  }
  function uePresetUid(){
    return 'preset-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  }
  function ueShowExportBox(filename, json, msg){
    var slot = document.getElementById('uePresetEditor') || document.getElementById('ueCharEditor') || document.getElementById('ueWorldEditor');
    if (!slot) {
      try { prompt('复制 JSON：', json); } catch (e) { alert('导出失败：当前环境不允许下载或显示复制框'); }
      return;
    }
    slot.innerHTML = [
      '<div class="ue-editor-card">',
        '<div class="ue-editor-head">' + escapeHtml(msg || 'JSON 已生成') + '</div>',
        '<p class="ue-panel-desc">如果浏览器/手机 App 没有弹出保存窗口，请复制下面内容，手动保存为 <b>' + escapeHtml(filename) + '</b>。</p>',
        '<textarea class="ue-textarea ue-mono" id="ueExportJsonText" rows="14">' + escapeHtml(json) + '</textarea>',
        '<div class="ue-editor-foot">',
          '<button class="ue-btn ue-btn-primary" id="ueExportCopy">复制 JSON</button>',
          '<button class="ue-btn" id="ueExportRetry">重新下载</button>',
          '<button class="ue-btn" id="ueExportClose">关闭</button>',
        '</div>',
      '</div>'
    ].join('');
    try { slot.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) {}
    var ta = document.getElementById('ueExportJsonText');
    var copyBtn = document.getElementById('ueExportCopy');
    var retryBtn = document.getElementById('ueExportRetry');
    var closeBtn = document.getElementById('ueExportClose');
    if (copyBtn) copyBtn.addEventListener('click', function(){
      var text = ta ? ta.value : json;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function(){ alert('已复制 JSON'); }, function(){ if (ta) { ta.focus(); ta.select(); } });
      } else if (ta) { ta.focus(); ta.select(); }
    });
    if (retryBtn) retryBtn.addEventListener('click', function(){ ueDownloadJson(filename, json, msg, true); });
    if (closeBtn) closeBtn.addEventListener('click', function(){ slot.innerHTML = ''; });
  }
  function ueDownloadJson(filename, json, copiedMsg, silent){
    var msg = copiedMsg || 'JSON 已导出';
    // 2026-11-11: Tauri 壳走原生写盘（Android WebView 不认 <a download>，旧版点了没反应）。
    // 走 save-file.js 统一出口；结果仍用可复制兜底框展示（写盘路径/取消原因看得见）。
    if (window.__saveFile && window.__saveFile.isTauri()) {
      window.__saveFile.saveTextFile(json, filename).then(function (r) {
        if (silent) return;
        if (r.ok) ueShowExportBox(filename, json, msg + '；已写盘 ' + (r.path || ''));
        else ueShowExportBox(filename, json, msg + '；' + (r.error || '未写盘'));
      });
      return;
    }
    var ok = false;
    try {
      var file = new Blob([json], { type: 'application/json;charset=utf-8' });
      var url = URL.createObjectURL(file);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.rel = 'noopener';
      a.target = '_blank';
      a.style.position = 'fixed';
      a.style.left = '-9999px';
      a.style.top = '-9999px';
      document.body.appendChild(a);
      // 必须保持在用户点击事件的同步调用栈里触发；不要等 clipboard Promise 后再 click。
      a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      ok = true;
      setTimeout(function(){
        try { if (a && a.parentNode) a.parentNode.removeChild(a); } catch (e) {}
        try { URL.revokeObjectURL(url); } catch (e) {}
      }, 4000);
    } catch (e) { ok = false; }

    // 下载被 WebView/浏览器拦截时通常不会抛异常，所以无论如何都展示可复制兜底框；
    // 这样电脑端“按钮没反应”和 Android WebView“不跳文件弹窗”都有明确结果。
    if (!silent) {
      ueShowExportBox(filename, json, msg + (ok ? '；已尝试下载文件' : '；当前环境未允许直接下载'));
      try {
        var ta = document.getElementById('ueExportJsonText');
        if (ta) { ta.focus(); ta.select(); }
      } catch (e) {}
    }
  }
  // 2026-10-06: 库不再是 public/presets/starter-presets.json（静态资产、人人可 GET，锁定访客也会被
  // 锁定态 403，一个字符都不回。库文本由 scripts/gen-prompts.mjs 从 src/prompts/{presets,skills} 生成。
  var LIB_VERSION_KEY = 'cfw_prompt_lib_v1';
  async function ueFetchLibrary(){
    try {
      const tok = (window.__auth && window.__auth.getToken) ? window.__auth.getToken() : '';
      if (!tok) return null;                                  // 未登录：不发请求（服务端也会 403）
      var resp = await fetch('/api/presets', {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!resp.ok) return null;
      var data = await resp.json();
      var arr = data && Array.isArray(data.presets) ? data.presets : null;
      if (!arr || !arr.length) return null;
      if (data.version && data.version.presets) ueFetchLibrary.lastVersion = data.version.presets;
      return arr;
    } catch (e) { return null; }
  }
  function ueLibraryVersion(){ return ueFetchLibrary.lastVersion || ''; }

  // ============== 库合并（2026-10-06 重做：从「首屏播种」升级为「每次打开都对齐库」）==============
  // 三条规矩，缺一不可：
  //   ① 只增不删：库里出现的新 id → 追加（默认关）；库里删掉的 id → 只动 lib-* 前缀的历史遗留，别的一律不碰
  //   ② 用户改过的不动：同 id 已在本地 → 保留本地那一条（用户在编辑器里改过 name/content/enabled/order 都算数）
  //   ③ 一次性迁移：老库（RP-Hub 那 11 条）id 全是 rphub-* —— 只清这一批，其余用户自建条目原样保留
  // 指纹存 cfw_prompt_lib_v1：库没变就一个字段都不重组（避免无谓写盘与云同步 push）。
  var RP_HUB_IDS = /^rphub-/;
  function ueMergeLibrary(pack){
    var cur = uePresetsLoad();
    var version = ueLibraryVersion();
    var seen = {};
    cur.forEach(function (p) { if (p && p.id) seen[p.id] = true; });
    // ① 迁移：清掉 RP-Hub 遗留（它们的内容已随提交删除，留着只会显示成"文件已不存在"）
    var before = cur.length;
    cur = cur.filter(function (p) { return !(p && typeof p.id === 'string' && RP_HUB_IDS.test(p.id)); });
    var purged = before - cur.length;
    // ②b 2026-10-06: 库调整过路径/id（功能 → functional、中文文件名 → ASCII）时，旧的 lib-* 条目会变成孤儿。
    //     规则：id 以 lib- 开头、且当前库里已不存在 → 清掉（这类条目由库管理，用户的编辑会随之丢失）；
    //     用户自建条目（preset-<时间戳>/sk_*/__dev_inject__）没有这个前缀，永远不碰。
    var _libIds = {};
    pack.forEach(function (e) { if (e && e.id) _libIds[e.id] = true; });
    var _beforeOrphan = cur.length;
    cur = cur.filter(function (p) { return !(p && typeof p.id === "string" && p.id.indexOf("lib-") === 0 && !_libIds[p.id]); });
    var orphanPurged = _beforeOrphan - cur.length;
    // ①b 元数据回填：id 命中库的条目，把**库侧的出处信息**刷新一遍（file/source/license/note/lang/description）。
    //     名字/正文/开关/排序/分组是用户的东西，一律不碰 —— 回填只补这条例来自哪个仓库文件、什么许可。
    //     （file 是 2026-10-06 新加的字段，不补的话老条目永远显示不出仓库文件名。）
    var _byId = {};
    pack.forEach(function (e) { if (e && e.id) _byId[e.id] = e; });
    var metaRefreshed = 0;
    cur.forEach(function (p) {
      var e = p && _byId[p.id];
      if (!e) return;
      ["file", "source", "license", "note", "lang", "description"].forEach(function (k) {
        var v = e[k] || "";
        if (v && p[k] !== v) { p[k] = v; metaRefreshed++; }
      });
    });
    // ② 追加库里还没有的 id（enabled 用库里的默认值：库是库，用哪个由用户勾）
    var added = 0;
    var maxOrder = cur.reduce(function (m, x) { return Math.max(m, x.order || 0); }, -1);
    pack.forEach(function (e) {
      if (!e || !e.id || seen[e.id]) return;
      cur.push({
        id: e.id, name: e.name || e.id, content: e.content || '',
        enabled: !!e.enabled, order: (typeof e.order === 'number' ? e.order : (++maxOrder)),
        group: e.group || '', lang: e.lang || '', description: e.description || '',
        source: e.source || '', license: e.license || '', note: e.note || '', file: e.file || '', fromLibrary: true,
      });
      seen[e.id] = true; added++;
    });
    if (purged || added || orphanPurged || metaRefreshed) {
      uePresetsSave(cur);
      try { if (version) localStorage.setItem(LIB_VERSION_KEY, version); } catch (e) {}
    } else {
      try { if (version && localStorage.getItem(LIB_VERSION_KEY) !== version) localStorage.setItem(LIB_VERSION_KEY, version); } catch (e) {}
    }
    return { purged: purged, orphanPurged: orphanPurged, added: added, metaRefreshed: metaRefreshed, total: cur.length };
  }
  async function ueSyncLibraryIfNeeded(silent){
    var pack = await ueFetchLibrary();
    if (!pack) return null;                                  // 未登录/网络失败：什么都不做（不是错误）
    var version = ueLibraryVersion();
    var seenVersion = '';
    try { seenVersion = localStorage.getItem(LIB_VERSION_KEY) || ''; } catch (e) {}
    var r = ueMergeLibrary(pack);
    if (!silent && (r.purged || r.added)) {
      try { console.log('[prompt-editor] 库已对齐：新增 ' + r.added + ' 条，清理旧 starter ' + r.purged + ' 条，清理孤儿 lib-* ' + r.orphanPurged + ' 条'); } catch (e) {}
    }
    void version; void seenVersion;
    return r;
  }
  // 打开编辑器时对齐一次
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function(){ ueSyncLibraryIfNeeded(true); });
  } else {
    ueSyncLibraryIfNeeded(true);
  }

  function renderPresetTab(){
    var t = findTab('preset');
    var body = document.getElementById('ueBody');
    if (!body) return;
    var arr = uePresetsLoad();
    arr.sort(function(a,b){ return (a.order||0) - (b.order||0); });

    body.innerHTML = [
      '<div class="ue-panel">',
        '<div class="ue-panel-head">',
          '<span class="ue-panel-icon">' + t.icon + '</span>',
          '<span class="ue-panel-name">' + escapeHtml(t.label) + '</span>',
        '</div>',
        '<p class="ue-panel-desc">' + escapeHtml(t.desc) + '</p>',
        '<div class="ue-toolbar">',
          '<button class="ue-btn ue-btn-primary" id="uePresetNew">' + UE_A.plus + ' 新建</button>',
          '<button class="ue-btn" id="uePresetReloadStarter" title="从库（src/prompts/presets）重新拉取：同名覆盖、新条目追加；你自建的条目不动">' + UE_A.reload + ' 从库重载</button>',
          '<button class="ue-btn" id="uePresetJsonMode">' + UE_A.code + ' JSON 源码</button>',
          '<button class="ue-btn" id="uePresetUpload" title="上传 .json（追加；兼容 SillyTavern 预设）">' + UE_A.folder + ' 上传</button>',
          '<input type="file" id="uePresetFile" accept=".json,application/json" style="display:none">',
          '<button class="ue-btn" id="uePresetExport">' + UE_A.exp + ' 导出</button>',
          '<span class="ue-toolbar-spacer"></span>',
          '<span class="ue-count">共 ' + arr.length + ' 条</span>',
        '</div>',
        '<div class="ue-preset-list" id="uePresetList">',
          ueRenderPresetListHtml(arr),
        '</div>',
        '<div class="ue-editor-slot" id="uePresetEditor"></div>',
      '</div>'
    ].join('');

    document.getElementById('uePresetNew').addEventListener('click', function(){
      var cur = uePresetsLoad();
      var maxOrder = cur.reduce(function(m, x){ return Math.max(m, x.order||0); }, -1);
      var p = { id: uePresetUid(), name: '新预设', content: '', enabled: false, order: maxOrder + 1 };
      cur.push(p);
      uePresetsSave(cur);
      renderPresetTab();
      uePresetEdit(p.id);
    });
    document.getElementById('uePresetReloadStarter').addEventListener('click', async function(){
      var pack = await ueFetchLibrary();
      if (!pack) { alert('从库加载失败：未登录、未部署或网络异常。\n（库走 POST /api/presets，需要先登录）'); return; }
      var cur = uePresetsLoad();
      var libIds = {};
      pack.forEach(function (e) { libIds[e.id] = e; });
      var touched = cur.filter(function (p) { return p && libIds[p.id]; }).length;
      if (!confirm('从库重载 ' + pack.length + ' 条：\n· 同名条目将被库里的原文覆盖（' + touched + ' 条会受影响，你的编辑会丢）\n· 库里新增的条目追加进来（默认关）\n· 你自建的条目完全不动\n\n继续？')) return;
      // 同名覆盖 + 追加新的；用户自建（库里没有的 id）原样保留
      var kept = cur.filter(function (p) { return p && !libIds[p.id]; });
      var overwritten = 0;
      cur.forEach(function (p) {
        if (p && libIds[p.id]) {
          var e = libIds[p.id];
          p.name = e.name || p.name; p.content = e.content || p.content; p.group = e.group || '';
          p.description = e.description || ''; p.source = e.source || ''; p.license = e.license || '';
          p.note = e.note || ''; p.lang = e.lang || ''; p.file = e.file || ''; p.fromLibrary = true;
          overwritten++;
        }
      });
      var have = {};
      cur.forEach(function (p) { if (p && p.id) have[p.id] = true; });
      var maxOrder = cur.reduce(function (m, x) { return Math.max(m, x.order || 0); }, -1);
      var added = 0;
      pack.forEach(function (e) {
        if (have[e.id]) return;
        cur.push({ id: e.id, name: e.name, content: e.content, enabled: !!e.enabled, order: (typeof e.order === 'number' ? e.order : (++maxOrder)),
          group: e.group || '', lang: e.lang || '', description: e.description || '', source: e.source || '', license: e.license || '', note: e.note || '', file: e.file || '', fromLibrary: true });
        added++;
      });
      void kept;
      uePresetsSave(cur);
      try { localStorage.setItem(LIB_VERSION_KEY, ueLibraryVersion()); } catch (e) {}
      renderPresetTab();
      alert('已从库重载：覆盖 ' + overwritten + ' 条，追加 ' + added + ' 条。');
    });
    document.getElementById('uePresetJsonMode').addEventListener('click', uePresetJsonEditor);
    document.getElementById('uePresetExport').addEventListener('click', function(){
      var json = JSON.stringify(uePresetsLoad(), null, 2);
      var name = 'ownchat-presets-' + new Date().toISOString().slice(0, 10) + '.json';
      ueDownloadJson(name, json, '已导出 ' + uePresetsLoad().length + ' 个 preset');
    });

    var fileEl = document.getElementById('uePresetFile');
    var upBtn = document.getElementById('uePresetUpload');
    if (upBtn) upBtn.addEventListener('click', function(){ if (fileEl) { fileEl.value = ''; fileEl.click(); } });
    if (fileEl) fileEl.addEventListener('change', function(){
      var f = fileEl.files && fileEl.files[0]; if (!f) return;
      var rd = new FileReader();
      rd.onload = function(){ ueImportPresetFile(String(rd.result || ''), f.name); };
      rd.readAsText(f);
    });

    var listEl = document.getElementById('uePresetList');
    listEl.addEventListener('click', function(e){
      var head = e.target.closest && e.target.closest('.ue-pgroup-head');
      if (head) {
        // 2026-10-06: 按钮里是 SVG 图标，点在图标上时 e.target 是 <path>，直接在 e.target 上判类名会漏
        var gDel = e.target.closest && e.target.closest('.ue-pgroup-del');
        if (gDel) { ueGroupDelete(gDel.getAttribute('data-group')); return; }
        var g = head.getAttribute('data-group');
        uePresetCollapsed[g] = !uePresetCollapsed[g];
        renderPresetTab();
        return;
      }
      // Bug fix(2026-09-12): 行上 draggable="true" 会在部分环境里吞掉 <label> 对隐藏
      // checkbox 的原生点击转发，导致点 preset 词条毫无反应（世界观 Tab 的勾选框是可见的
      // 原生 checkbox，不受影响；preset 用隐藏 checkbox + 徽章样式，才会撞上这个坑）。
      // 这里显式接管：点击选中区时手动切换 checkbox 状态并派发 change 事件，不再依赖
      // 浏览器的原生 label→hidden-checkbox 转发。
      var row = e.target.closest && e.target.closest('.ue-preset-row');
      if (!row) return;
      var pid = row.getAttribute('data-id');
      // 2026-10-06: 从按钮上取动作 —— 图标是 SVG，点铅笔画笔时 e.target 是 <path>,
      // 老写法 e.target.classList.contains('ue-preset-edit') 直接判空 → 点了没反应。
      var act = e.target.closest && e.target.closest('.ue-preset-edit,.ue-preset-del,.ue-preset-up,.ue-preset-down');
      if (!act) return;
      if (act.classList.contains('ue-preset-edit')) uePresetEdit(pid);
      else if (act.classList.contains('ue-preset-del')) uePresetDel(pid);
      else if (act.classList.contains('ue-preset-up')) uePresetMove(pid, -1);
      else if (act.classList.contains('ue-preset-down')) uePresetMove(pid, +1);
    });
    listEl.addEventListener('dragstart', function(e){
      var row = e.target.closest && e.target.closest('.ue-preset-row');
      if (!row) return;
      ueDragId = row.getAttribute('data-id');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', ueDragId); } catch (x) {}
      row.classList.add('dragging');
    });
    listEl.addEventListener('dragend', function(e){
      var row = e.target.closest && e.target.closest('.ue-preset-row');
      if (row) row.classList.remove('dragging');
      listEl.querySelectorAll('.dragover').forEach(function(r){ r.classList.remove('dragover'); });
      ueDragId = null;
    });
    listEl.addEventListener('dragover', function(e){
      if (!ueDragId) return;
      e.preventDefault();
      var row = e.target.closest && e.target.closest('.ue-preset-row');
      listEl.querySelectorAll('.dragover').forEach(function(r){ if (r !== row) r.classList.remove('dragover'); });
      if (row && row.getAttribute('data-id') !== ueDragId) row.classList.add('dragover');
    });
    listEl.addEventListener('drop', function(e){
      e.preventDefault();
      var row = e.target.closest && e.target.closest('.ue-preset-row');
      if (!row || !ueDragId) return;
      var targetId = row.getAttribute('data-id');
      if (targetId !== ueDragId) uePresetDrop(ueDragId, targetId);
    });
    listEl.addEventListener('change', function(e){
      if (!e.target.classList.contains('ue-preset-chk')) return;
      var row = e.target.closest('.ue-preset-row');
      var pid = row.getAttribute('data-id');
      var cur = uePresetsLoad();
      var p = cur.find(function(x){ return x.id === pid; });
      if (p) { p.enabled = !!e.target.checked; uePresetsSave(cur); row.classList.toggle('enabled', p.enabled); }
    });
  }

  // 2026-10-06 修回归：删多情绪系统那次把本函数的**行容器与名字节点**跟着 ue-emo-row 一起删了，
  // 只剩孤儿 </div> —— 行没有 data-id，点击处理器 closest('.ue-preset-row') 得 null 直接 return，
  // 于是 ✎/✕ 全按不动、开关不显示、拖拽失效。这里按 4+1 列网格重建（多出的一列是拖拽抓手）。
  // 主标签 = 显示名（front-matter 的 name / 你自建条目填的名字）；**库里条目**再多一行小字的仓库文件名
  // （p.file，由生成器写入），你自己建的条目不在仓库里、没有文件名可显示 —— 这条界线本身就是「库 vs 你的数据」。
  function uePresetRowHtml(p){
    var content = (p.content || '');
    var preview = content.slice(0, 80).replace(/\n/g, ' ');
    if (content.length > 80) preview += '…';
    var fileTag = p.file ? '<span class="ue-preset-file" title="仓库文件：src/prompts/presets/' + escapeAttr(p.file) + '">' + escapeHtml(p.file) + '</span>' : '';
    return [
      '<div class="ue-preset-row ue-has-drag' + (p.enabled ? ' enabled' : '') + '" data-id="' + escapeAttr(p.id) + '" draggable="true">',
        '<span class="ue-preset-drag" title="拖拽排序 —— 决定注入顺序（越靠上越先注入）" draggable="false">' + UE_A.grip + '</span>',
        '<label class="ue-preset-tog" title="' + (p.enabled ? '已启用 · 点击禁用' : '已禁用 · 点击启用') + '">',
          '<input type="checkbox" class="ue-preset-chk"' + (p.enabled ? ' checked' : '') + '>',
        '</label>',
        '<span class="ue-preset-name">' + escapeHtml(p.name || '(未命名)') + fileTag + '</span>',
        '<div class="ue-preset-preview">' + (escapeHtml(preview) || '<em>（空内容）</em>') + '</div>',
        '<div class="ue-preset-ops">',
          '<button class="ue-mini ue-preset-edit" title="编辑">' + UE_A.pencil + '</button>',
          '<button class="ue-mini danger ue-preset-del" title="删除">' + UE_A.close + '</button>',
        '</div>',
      '</div>'
    ].join('');
  }

  function uePresetEdit(pid){
    var cur = uePresetsLoad();
    var p = cur.find(function(x){ return x.id === pid; });
    if (!p) return;
    var slot = document.getElementById('uePresetEditor');
    if (!slot) return;
    slot.innerHTML = [
      '<div class="ue-editor-card">',
        '<div class="ue-editor-head">' + UE_A.pencil + ' 编辑：' + escapeHtml(p.name || '(未命名)') + '</div>',
        '<label class="ue-field"><span>名称</span><input class="ue-input" id="uePEName" value="' + escapeAttr(p.name || '') + '"></label>',
        '<label class="ue-field"><span>内容（追加到 system prompt 末层）</span><textarea class="ue-textarea" id="uePEContent" rows="10">' + escapeHtml(p.content || '') + '</textarea></label>',
        '<div class="ue-editor-foot">',
          '<button class="ue-btn ue-btn-primary" id="uePESave">保存修改</button>',
          '<button class="ue-btn" id="uePECancel">取消</button>',
        '</div>',
      '</div>'
    ].join('');
    slot.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    document.getElementById('uePESave').addEventListener('click', function(){
      var nm = (document.getElementById('uePEName').value || '').trim();
      if (!nm) { alert('名称不能为空'); return; }
      var ct = document.getElementById('uePEContent').value || '';
      p.name = nm; p.content = ct;
      uePresetsSave(cur);
      renderPresetTab();
    });
    document.getElementById('uePECancel').addEventListener('click', function(){ slot.innerHTML = ''; });
  }

  function uePresetDel(pid){
    var cur = uePresetsLoad();
    var p = cur.find(function(x){ return x.id === pid; });
    if (!p) return;
    if (!confirm('删除 preset「' + p.name + '」？')) return;
    cur = cur.filter(function(x){ return x.id !== pid; });
    uePresetsSave(cur);
    renderPresetTab();
  }

  function uePresetMove(pid, dir){
    var cur = uePresetsLoad();
    cur.sort(function(a,b){ return (a.order||0) - (b.order||0); });
    var i = cur.findIndex(function(x){ return x.id === pid; });
    if (i < 0) return;
    var j = i + dir;
    if (j < 0 || j >= cur.length) return;
    var tmp = cur[j].order; cur[j].order = cur[i].order; cur[i].order = tmp;
    uePresetsSave(cur);
    renderPresetTab();
  }

  function uePresetJsonEditor(){
    var slot = document.getElementById('uePresetEditor');
    if (!slot) return;
    var json = JSON.stringify(uePresetsLoad(), null, 2);
    slot.innerHTML = [
      '<div class="ue-editor-card">',
        '<div class="ue-editor-head">' + UE_A.code + ' JSON 源码模式（保存会覆盖全部 preset）</div>',
        '<textarea class="ue-textarea ue-mono" id="uePresetJsonText" rows="16">' + escapeHtml(json) + '</textarea>',
        '<div class="ue-editor-foot">',
          '<button class="ue-btn ue-btn-primary" id="uePJSave">保存 JSON</button>',
          '<button class="ue-btn" id="uePJCancel">取消</button>',
        '</div>',
      '</div>'
    ].join('');
    slot.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    document.getElementById('uePJSave').addEventListener('click', function(){
      var s = document.getElementById('uePresetJsonText').value || '';
      try {
        var arr = JSON.parse(s);
        if (!Array.isArray(arr)) throw new Error('JSON 顶层必须是数组');
        // 2026-10-06: 元数据字段（source/license/description/note/lang）要一起保留 ——
        // 早先这里只留 {id,name,content,enabled,order,group}，用户一进 JSON 源码模式保存，
        // 出处与许可就被静默抹掉了。
        var clean = arr.filter(function(x){ return x && typeof x.name === 'string' && typeof x.content === 'string'; })
          .map(function(x, i){
            return {
              id: x.id || ('preset-' + Date.now() + '-' + i),
              name: x.name, content: x.content,
              enabled: !!x.enabled,
              order: typeof x.order === 'number' ? x.order : i,
              group: typeof x.group === 'string' ? x.group : '',
              lang: typeof x.lang === 'string' ? x.lang : '',
              description: typeof x.description === 'string' ? x.description : '',
              source: typeof x.source === 'string' ? x.source : '',
              license: typeof x.license === 'string' ? x.license : '',
              note: typeof x.note === 'string' ? x.note : '',
              file: typeof x.file === 'string' ? x.file : ''
            };
          });
        if (!clean.length) { alert('没有有效 preset（需 name + content 字段）'); return; }
        if (!confirm('将用 ' + clean.length + ' 个 preset 覆盖当前 ' + uePresetsLoad().length + ' 个。继续？')) return;
        uePresetsSave(clean);
        renderPresetTab();
      } catch (e) {
        alert('JSON 解析失败：' + e.message);
      }
    });
    document.getElementById('uePJCancel').addEventListener('click', function(){ slot.innerHTML = ''; });
  }

  // ============== 4.23: Preset 增强（分组收纳 / 拖拽 / .json 上传）==============
  // group 为可选字段（不填=未分组，老数据完全兼容）。SillyTavern 预设按文件名收进同名分组。
  var uePresetCollapsed = {};
  var ueDragId = null;

  function ueRenderPresetListHtml(arr){
    if (!arr.length) return '<div class="ue-empty">还没有指令模块。点上方「新建」，或「上传」导入 JSON（兼容 SillyTavern 预设）；也可以「从库重载」把 src/prompts/presets/ 里的条目拉下来。</div>';
    var order = [], map = {};
    arr.forEach(function(p){ var g = p.group || ''; if (!(g in map)) { map[g] = []; order.push(g); } map[g].push(p); });
    var html = '';
    order.forEach(function(g){
      var items = map[g];
      if (g === '') { html += items.map(uePresetRowHtml).join(''); return; }
      var collapsed = !!uePresetCollapsed[g];
      html += '<div class="ue-pgroup-head" data-group="' + escapeAttr(g) + '">'
        + '<span class="ue-pgroup-arrow' + (collapsed ? ' folded' : '') + '">' + UE_A.chevron + '</span>'
        + '<span class="ue-pgroup-name">' + escapeHtml(g) + '</span>'
        + '<span class="ue-pgroup-count">' + items.length + '</span>'
        + '<button class="ue-mini danger ue-pgroup-del" data-group="' + escapeAttr(g) + '" title="删除整组">' + UE_A.close + '</button></div>';
      if (!collapsed) html += '<div class="ue-pgroup-body">' + items.map(uePresetRowHtml).join('') + '</div>';
    });
    return html;
  }

  function uePresetDrop(dragId, targetId){
    var cur = uePresetsLoad();
    cur.sort(function(a,b){ return (a.order||0) - (b.order||0); });
    var di = cur.findIndex(function(x){ return x.id === dragId; });
    if (di < 0) return;
    var item = cur.splice(di, 1)[0];
    var ti = cur.findIndex(function(x){ return x.id === targetId; });
    if (ti < 0) { cur.push(item); } else { item.group = cur[ti].group || ''; cur.splice(ti, 0, item); }
    cur.forEach(function(x, i){ x.order = i; });
    uePresetsSave(cur);
    renderPresetTab();
  }

  function ueGroupDelete(g){
    var cur = uePresetsLoad();
    var n = cur.filter(function(x){ return (x.group||'') === g; }).length;
    if (!confirm('删除分组「' + g + '」下的全部 ' + n + ' 个 preset？')) return;
    cur = cur.filter(function(x){ return (x.group||'') !== g; });
    uePresetsSave(cur);
    renderPresetTab();
  }

  function ueImportPresetFile(text, fname){
    var data;
    try { data = JSON.parse(text); } catch (e) { alert('JSON 解析失败：' + e.message); return; }
    var groupName = String(fname || '').replace(/\.json$/i, '') || '导入';
    var add = [];
    if (Array.isArray(data)) {
      add = data.filter(function(x){ return x && typeof x.name === 'string' && typeof x.content === 'string'; })
        .map(function(x){ return { name: x.name, content: x.content, enabled: !!x.enabled, group: (typeof x.group === 'string' ? x.group : ''),
          lang: x.lang || '', description: x.description || '', source: x.source || '', license: x.license || '', note: x.note || '' }; });
    } else if (data && Array.isArray(data.prompts)) {
      add = ueParseSillyTavern(data, groupName);
    } else if (data && typeof data.name === 'string' && typeof data.content === 'string') {
      add = [{ name: data.name, content: data.content, enabled: !!data.enabled, group: '' }];
    } else {
      alert('无法识别的预设格式（支持本应用数组 / SillyTavern 预设 / 单条 {name,content}）');
      return;
    }
    if (!add.length) { alert('文件里没有可导入的有效条目'); return; }
    var cur = uePresetsLoad();
    var maxOrder = cur.reduce(function(m, x){ return Math.max(m, x.order||0); }, -1);
    add.forEach(function(p, i){
      cur.push({ id: uePresetUid() + '-' + i, name: p.name, content: p.content, enabled: !!p.enabled, order: maxOrder + 1 + i, group: p.group || '',
        lang: p.lang || '', description: p.description || '', source: p.source || '', license: p.license || '', note: p.note || '' });
    });
    uePresetsSave(cur);
    if (add[0] && add[0].group) uePresetCollapsed[add[0].group] = false;
    renderPresetTab();
    alert('已追加 ' + add.length + ' 个 preset' + (add[0] && add[0].group ? ('（分组「' + add[0].group + '」）') : ''));
  }

  function ueParseSillyTavern(data, groupName){
    var enabledMap = {};
    if (Array.isArray(data.prompt_order) && data.prompt_order.length) {
      var ord = data.prompt_order[data.prompt_order.length - 1];
      if (ord && Array.isArray(ord.order)) ord.order.forEach(function(o){ if (o && o.identifier) enabledMap[o.identifier] = (o.enabled !== false); });
    }
    var out = [];
    data.prompts.forEach(function(pr){
      if (!pr || pr.marker === true) return;
      var content = (typeof pr.content === 'string') ? pr.content : '';
      if (!content.trim()) return;
      var name = pr.name || pr.identifier || '(未命名)';
      var en = (pr.identifier && (pr.identifier in enabledMap)) ? enabledMap[pr.identifier] : false;
      out.push({ name: name, content: content, enabled: !!en, group: groupName });
    });
    return out;
  }

  // ============== 角色卡 Tab 实质化（P1 · 复用 character.js 的 tavern_chars_v2,单一数据源）==============
  var GENDER_PH = '女 / 男 / 双性 / 无性别 / 自定义';
  function ueCharApi(){ return (window.__character && typeof window.__character.getAllCards === 'function') ? window.__character : null; }
  async function renderCharacterTab(){
    var t = findTab('character'), body = document.getElementById('ueBody'); if (!body) return;
    var api = ueCharApi();
    if (!api){ body.innerHTML = '<div class="ue-panel"><div class="ue-panel-head"><span class="ue-panel-icon">' + t.icon + '</span><span class="ue-panel-name">' + escapeHtml(t.label) + '</span></div><div class="ue-empty">角色卡模块尚未就绪（character.js 未加载）,请刷新页面后重试。</div></div>'; return; }
    var cards = []; try { cards = await api.getAllCards(); } catch (e) { cards = []; }
    var activeId = ''; try { activeId = localStorage.getItem('tavern_active_char_id') || ''; } catch (e) {}
    body.innerHTML = ['<div class="ue-panel">',
      '<div class="ue-panel-head"><span class="ue-panel-icon">' + t.icon + '</span><span class="ue-panel-name">' + escapeHtml(t.label) + '</span></div>',
      '<p class="ue-panel-desc">' + escapeHtml(t.desc) + '</p>',
      '<div class="ue-toolbar"><button class="ue-btn ue-btn-primary" id="ueCharNew">' + UE_A.plus + ' 新建角色卡</button><button class="ue-btn" id="ueCharImport" title="导入角色卡：SillyTavern V1/V2 JSON、PNG 卡（内嵌 tEXt）、本应用导出数组；内嵌世界书一并导入">' + UE_A.imp + ' 导入</button><input type="file" id="ueCharFile" accept=".json,application/json,.png,image/png" style="display:none"><button class="ue-btn" id="ueCharExport" title="导出为 SillyTavern Card V2（可被 ST 等工具直接读取；内部扩展挂 data.extensions.ownchat(并双写旧键 omnigent 兼容老导出)）">' + UE_A.exp + ' 导出 V2</button><button class="ue-btn" id="ueCharExportRaw" title="本应用内部格式（含好感度阈值等本平台专有字段，仅供本应用回导/备份）">' + UE_A.file + ' 内部 JSON</button><span class="ue-toolbar-spacer"></span><span class="ue-count">共 ' + cards.length + ' 条</span></div>',
      '<div class="ue-preset-list" id="ueCharList">' + ueCharListHtml(cards, activeId) + '</div>',
      '<div class="ue-editor-slot" id="ueCharEditor"></div>',
    '</div>'].join('');
    document.getElementById('ueCharNew').addEventListener('click', function(){ ueCharEdit(null); });
    document.getElementById('ueCharExport').addEventListener('click', function(){
      var v2 = cards.map(ueCardToV2);
      ueDownloadJson('ownchat-characters-v2-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(v2.length === 1 ? v2[0] : v2, null, 2),
        '已导出 ' + v2.length + ' 张（V2 标准格式，含内嵌世界书）');
    });
    document.getElementById('ueCharExportRaw').addEventListener('click', function(){
      ueDownloadJson('ownchat-characters-internal-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(cards, null, 2),
        '已导出 ' + cards.length + ' 张（本应用内部格式）');
    });
    var _cf = document.getElementById('ueCharFile'), _ci = document.getElementById('ueCharImport');
    if (_ci) _ci.addEventListener('click', function(){ if (_cf){ _cf.value=''; _cf.click(); } });
    if (_cf) _cf.addEventListener('change', function(){
      var f = _cf.files && _cf.files[0]; if (!f) return;
      var rd = new FileReader();
      var isPng = /\.png$/i.test(f.name) || f.type === 'image/png';
      // PNG 角色卡（chub / characterhub 的主要下载形式）= 图片的 tEXt 块里塞 base64 JSON。
      // 必须按二进制读 —— 按文本读会把 chunk 结构毁掉（旧版直接报「JSON 解析失败」，用户拿到的卡一张都进不来）。
      rd.onload = function(){
        if (isPng) {
          var buf = rd.result;
          try { ueCharImportFile(uePngCardToJson(new Uint8Array(buf)), f.name, true); }
          catch (e) { alert('PNG 角色卡解析失败：' + (e && e.message ? e.message : e)); }
        } else {
          ueCharImportFile(String(rd.result || ''), f.name);
        }
      };
      if (isPng) rd.readAsArrayBuffer(f); else rd.readAsText(f);
    });
    var listEl = document.getElementById('ueCharList');
    // 2026-10-06: 与指令模块同一处坑（按钮里是 SVG 图标 → 要在按钮上判类名，不能在 e.target 上判）
    listEl.addEventListener('click', function(e){ var row = e.target.closest && e.target.closest('.ue-preset-row'); if (!row) return; var id = row.getAttribute('data-id'); var act = e.target.closest && e.target.closest('.ue-char-edit,.ue-char-del'); if (!act) return; if (act.classList.contains('ue-char-edit')) ueCharEditById(id); else if (act.classList.contains('ue-char-del')) ueCharDel(id); });
    listEl.addEventListener('change', function(e){
      if (!e.target.classList.contains('ue-char-chk')) return;
      var row = e.target.closest('.ue-preset-row'); if (!row) return;
      var api = ueCharApi(); if (!api) return;
      try { api.setActiveId(e.target.checked ? row.getAttribute('data-id') : ''); } catch (x) {}   // '' = 卸下（非角色模式）
      renderCharacterTab();
    });
  }
  // 2026-10-06（所有者反馈「点了用之后不能卸下」）: 角色行改成与指令模块同一套形式 ——
  //   勾选列 = 当前使用（可勾可取消），头像内联进名字列，动作只剩编辑/删除。
  //   语义差别只有一条：「当前使用」是单选（勾一个就换掉上一个，再点一下 = 清空 = 非角色模式），
  //   而指令模块的勾是「启用」，可以多选。清空走的是数据层既有的 setActiveId(空串)（左栏面板的「清除」同一条路径）。
  function ueCharListHtml(cards, activeId){
    if (!cards.length) return '<div class="ue-empty">还没有角色卡。点上方「新建角色卡」创建；也可以「导入」网上找的 SillyTavern V2 卡或 PNG 卡。</div>';
    return cards.map(function(c){
      var sub = (c.identity || c.personality || '').slice(0, 60).replace(/\n/g, ' ');
      var on = c.id === activeId;
      return ['<div class="ue-preset-row' + (on ? ' enabled' : '') + '" data-id="' + escapeAttr(c.id) + '">',
        '<label class="ue-preset-tog" title="' + (on ? '当前使用 · 点击卸下（改为非角色模式）' : '点击设为当前角色') + '">',
          '<input type="checkbox" class="ue-preset-chk ue-char-chk"' + (on ? ' checked' : '') + '>',
        '</label>',
        '<span class="ue-preset-name"><span class="ue-char-line"><span class="ue-char-ava">' + escapeHtml(c.icon || '🙂') + '</span>' + escapeHtml(c.name || '(未命名)') + (on ? ' <span class="ue-char-cur">当前</span>' : '') + '</span></span>',
        '<div class="ue-preset-preview">' + (escapeHtml(sub) || '<em>（无描述）</em>') + '</div>',
        '<div class="ue-preset-ops"><button class="ue-mini ue-char-edit" title="编辑">' + UE_A.pencil + '</button><button class="ue-mini danger ue-char-del" title="删除">' + UE_A.close + '</button></div>',
      '</div>'].join('');
    }).join('');
  }
  async function ueCharEditById(id){ var api = ueCharApi(); if (!api) return; var cards = []; try { cards = await api.getAllCards(); } catch (e) {} var c = cards.find(function(x){ return x.id === id; }); ueCharEdit(c || null); }
  function ueCharDel(id){ var api = ueCharApi(); if (!api) return; api.getAllCards().then(function(cards){ var c = cards.find(function(x){ return x.id === id; }); if (!confirm('删除角色卡「' + ((c && c.name) || id) + '」？此操作不可撤销。')) return; api.deleteCard(id).then(function(){ renderCharacterTab(); }); }); }
  function ueCharEdit(card){
    var slot = document.getElementById('ueCharEditor'); if (!slot) return;
    var isNew = !card || !card.id, c = card || {};
    var rules = Array.isArray(c.rules) ? c.rules.slice() : []; while (rules.length < 3) rules.push('');
    var qa = Array.isArray(c.exampleQA) ? c.exampleQA.slice() : []; while (qa.length < 2) qa.push({ user:'', character:'' });
    function F(lb,k,v,ph){ return '<label class="ue-field"><span>' + escapeHtml(lb) + '</span><input class="ue-input" data-cf="' + k + '" value="' + escapeAttr(v||'') + '" placeholder="' + escapeAttr(ph||'') + '"></label>'; }
    function I(k,v,ph,mb){ return '<input class="ue-input" data-cf="' + k + '" value="' + escapeAttr(v||'') + '" placeholder="' + escapeAttr(ph||'') + '"' + (mb?' style="margin-bottom:6px;"':'') + '>'; }
    slot.innerHTML = ['<div class="ue-editor-card">',
      '<div class="ue-editor-head">' + (isNew ? UE_A.plus + ' 新建角色卡' : UE_A.pencil + ' 编辑：' + escapeHtml(c.name||'')) + '</div>',
      F('角色名 *','name', c.name, '角色名称'),
      '<div class="ue-char-grid2">' + F('性别','gender', c.gender, GENDER_PH) + F('年龄','age', c.age, '如：18 / 二十出头（影响立绘）') + '</div>',
      F('身份/背景','identity', c.identity, '如：高中生 / 修仙者（可空）'),
      F('场景','scenario', c.scenario, '如：雨夜的旧书店（对应 ST 的 scenario；可空）'),
      F('头像 emoji','icon', c.icon, '🙂'),
      F('性格关键词','personality', c.personality, '如：包容、耐心'),
      F('说话方式','speakingStyle', c.speakingStyle, '如：轻声细语'),
      '<label class="ue-field"><span>行为铁则（最多 3 条）</span>' + I('r0',rules[0],'铁则 1',1) + I('r1',rules[1],'铁则 2',1) + I('r2',rules[2],'铁则 3') + '</label>',
      F('开场白','opening', c.openingLine, '第一句话'),
      '<label class="ue-field"><span>示例对话 1</span>' + I('q0u',qa[0].user,'用户说',1) + I('q0c',qa[0].character,'角色回') + '</label>',
      '<label class="ue-field"><span>示例对话 2</span>' + I('q1u',qa[1].user,'用户说',1) + I('q1c',qa[1].character,'角色回') + '</label>',
      '<div class="ue-editor-foot"><button class="ue-btn ue-btn-primary" id="ueCharSave">' + (isNew?'新建':'保存修改') + '</button><button class="ue-btn" id="ueCharCancel">取消</button></div>',
    '</div>'].join('');
    slot.scrollIntoView({ behavior:'smooth', block:'nearest' });
    document.getElementById('ueCharCancel').addEventListener('click', function(){ slot.innerHTML = ''; });
    document.getElementById('ueCharSave').addEventListener('click', async function(){
      var api = ueCharApi(); if (!api) return;
      var g = function(k){ var el = slot.querySelector('[data-cf="' + k + '"]'); return el ? el.value.trim() : ''; };
      var name = g('name'); if (!name) { alert('角色名不能为空'); return; }
      var merged = { id:(c&&c.id)||'', name:name, gender:g('gender'), age:g('age'), identity:g('identity'), scenario:g('scenario'), icon:g('icon')||'🙂', personality:g('personality'), speakingStyle:g('speakingStyle'), rules:[g('r0'),g('r1'),g('r2')].filter(function(r){ return r; }), openingLine:g('opening'), exampleQA:[{ user:g('q0u'), character:g('q0c') },{ user:g('q1u'), character:g('q1c') }].filter(function(q){ return q.user||q.character; }), enableAffection:c?c.enableAffection:undefined, affectionThresholds:(c&&Array.isArray(c.affectionThresholds))?c.affectionThresholds:[], avatar:(c&&c.avatar)||'', spec:(c&&c.spec)||null };
      try { await api.saveCard(merged); renderCharacterTab(); } catch (e) { alert('保存失败：' + (e&&e.message?e.message:e)); }
    });
  }

  // ============== 角色卡导入 / 导出（2026-10-06 重写）==============
  // 目标：**网上找来的卡即插即用、且不静默丢东西**。三条老毛病都在这儿修：
  //   ① PNG 卡（chub/characterhub 主要下载形式：JSON 藏在 PNG 的 tEXt 块里）——旧版只收 .json，直接失败；
  //   ② 一包多卡（数组）——旧版把数组当"本应用导出"，每张都因字段名对不上而失败，最后报「已导入 0 张」；
  //   ③ description 与 scenario 被揉成一段"身份"，且 alternate_greetings / system_prompt /
  //      post_history_instructions / creator_notes / tags / extensions 全丢且不提示。
  // 处理原则：**能映射的映射，映射不了的原样存进 card.spec**（导出时按 V2 还回去），并在结果里如实报告。

  // PNG 的 tEXt 块：keyword \0 text。角色卡固定两个关键字：chara(V2) 与 ccv3(V3)。
  // 自己按 PNG 规范解析（约 30 行）——SillyTavern 的实现是 AGPL，不抄它的代码。
  function uePngCardToJson(bytes){
    var u8 = bytes, dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (u8.length < 8 || dv.getUint32(0) !== 0x89504e47) throw new Error('不是 PNG（签名不符）');
    var off = 8, found = {};
    while (off + 8 <= u8.length) {
      var len = dv.getUint32(off), type = '';
      for (var k = 0; k < 4; k++) type += String.fromCharCode(u8[off + 4 + k]);
      var dataStart = off + 8;
      if (dataStart + len > u8.length) break;
      if (type === 'tEXt') {
        var nul = -1;
        for (var q = dataStart; q < dataStart + len; q++) { if (u8[q] === 0) { nul = q; break; } }
        if (nul > 0) {
          var key = '';
          for (var a = dataStart; a < nul; a++) key += String.fromCharCode(u8[a]);
          var raw = u8.subarray(nul + 1, dataStart + len);
          var txt = '';
          for (var b = 0; b < raw.length; b++) txt += String.fromCharCode(raw[b]);
          if (key === 'chara' || key === 'ccv3') found[key] = txt;
        }
      }
      off = dataStart + len + 4;
      if (type === 'IEND') break;
    }
    var pick = found.ccv3 || found.chara;
    if (!pick) throw new Error('PNG 里没有 chara / ccv3 文本块（不是角色卡，或用了不支持的编码）');
    var bin = atob(pick.trim());
    var buf = new Uint8Array(bin.length);
    for (var t = 0; t < bin.length; t++) buf[t] = bin.charCodeAt(t);
    // V3 的 ccv3 块也可能是"PNG 里再套一层"的旧格式；两种都试
    var json = new TextDecoder().decode(buf);
    try { return JSON.parse(json); }
    catch (e) { return JSON.parse(new TextDecoder().decode(uePngCardToJson(buf))); }
  }

  // mes_example 三种常见写法都认：<START> 分块 + {{user}}/{{char}} 前缀（标准）、"Name:" 前缀（老卡）、
  // 纯文本块（拿不到角色名时按"整块给用户、角色留空"处理）。解析不出成对示例时如实计数，别静默归零。
  function ueParseExamples(mex, cardName){
    var out = [], failed = 0;
    if (!mex || typeof mex !== 'string') return { qa: out, failed: failed, empty: !mex };
    var blocks = mex.split(/<START>/i).map(function(x){ return x.trim(); }).filter(Boolean);
    var nameRe = cardName ? new RegExp('^' + cardName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[:：]', 'i') : null;
    blocks.forEach(function(blk){
      if (out.length >= 2) return;
      var u = '', c = '';
      var um = blk.match(/\{\{user\}\}\s*[:：]\s*([\s\S]*?)(?=\{\{char\}\}|$)/i);
      var cm = blk.match(/\{\{char\}\}\s*[:：]\s*([\s\S]*?)(?=\{\{user\}\}|$)/i);
      if (um || cm) { u = um ? um[1].trim() : ''; c = cm ? cm[1].trim() : ''; }
      else if (nameRe) {
        // "露娜: xxx\n我: yyy" 这种老写法
        var lines = blk.split('\n');
        var cur = '';
        lines.forEach(function(ln){
          if (nameRe.test(ln)) { if (cur === 'user' && u) { } if (cur === 'user') u += (u ? '\n' : '') + ln.replace(nameRe, '').trim(); else if (cur === 'char') c += (c ? '\n' : '') + ln.replace(nameRe, '').trim(); cur = 'char'; }
          else if (/^\s*(你|我|user|User|USER)\s*[:：]/.test(ln)) { if (cur === 'user') u += (u ? '\n' : '') + ln.replace(/^\s*(你|我|user|User|USER)\s*[:：]/, '').trim(); cur = 'user'; }
          else if (cur === 'user') u += (u ? '\n' : '') + ln;
          else if (cur === 'char') c += (c ? '\n' : '') + ln;
        });
      }
      if (u || c) out.push({ user: u, character: c });
      else failed++;
    });
    return { qa: out.slice(0, 2), failed: failed };
  }

  /**
   * SillyTavern V1/V2/V3 卡 → 本应用卡 + 一份"丢了什么"的报告。
   * V1 的旧命名（char_name / char_persona / world_scenario / char_greeting / example_dialogue）一并认。
   */
  function ueCardFromSillyTavern(raw){
    var d = (raw && raw.data && typeof raw.data === 'object') ? raw.data : raw;   // V2/V3 在 data 下，V1 平铺
    if (!d || typeof d !== 'object') return { card: null, report: { ok: false, reason: '不是角色卡对象' } };
    var g = function(){ for (var i = 0; i < arguments.length; i++) { var v = d[arguments[i]]; if (typeof v === 'string' && v.trim()) return v.trim(); } return ''; };
    var name = g('name', 'char_name');
    var desc = g('description', 'char_persona');
    var scenario = g('scenario', 'world_scenario');
    var opening = g('first_mes', 'char_greeting');
    var mex = g('mes_example', 'example_dialogue');
    if (!name && !opening && !desc) return { card: null, report: { ok: false, reason: '没有 name/description/first_mes（且不是数组）' } };
    var ex = ueParseExamples(mex, name);
    var spec = {
      specVersion: (raw && raw.spec_version) || (raw && raw.spec) || '',
      creator: g('creator'), creatorNotes: g('creator_notes'), characterVersion: g('character_version'),
      systemPrompt: g('system_prompt'), postHistoryInstructions: g('post_history_instructions'),
      alternateGreetings: Array.isArray(d.alternate_greetings) ? d.alternate_greetings : [],
      tags: Array.isArray(d.tags) ? d.tags : [],
      extensions: (d.extensions && typeof d.extensions === 'object') ? d.extensions : {},
    };
    var card = {
      name: name || '导入角色',
      // 刻意**分开**：identity 对应 V2 的 description（人设/背景），scenario 对应 V2 的 scenario（当下处境）
      identity: desc,
      scenario: scenario,
      personality: typeof d.personality === 'string' ? d.personality : '',
      speakingStyle: '',
      openingLine: opening,
      exampleQA: ex.qa,
      icon: '🙂',
      avatar: '',
      gender: '',            // 网络卡一般没有性别字段；留空 → prompt 里不出现「性别」（旧版强写 female，全部都错成"女"）
      spec: spec,
    };
    // 报告：哪些进了、哪些只是"存着"、哪些彻底没用
    var used = [], stored = [], dropped = [];
    [['name', name], ['description', desc], ['scenario', scenario], ['personality', card.personality], ['first_mes', opening]]
      .forEach(function(kv){ if (kv[1]) used.push(kv[0]); });
    if (ex.qa.length) used.push('mes_example(' + ex.qa.length + ' 组)');
    else if (mex) dropped.push('mes_example(解析不出成对示例)');
    else if (ex.empty === false && ex.failed) dropped.push('mes_example');
    if (spec.systemPrompt) stored.push('system_prompt');
    if (spec.postHistoryInstructions) stored.push('post_history_instructions');
    if (spec.alternateGreetings.length) stored.push('alternate_greetings(' + spec.alternateGreetings.length + ')');
    if (spec.creatorNotes) stored.push('creator_notes');
    if (spec.tags.length) stored.push('tags(' + spec.tags.length + ')');
    if (Object.keys(spec.extensions).length) stored.push('extensions');
    if (d.character_book) stored.push('character_book(→世界书)');
    ['nickname', 'group_only_greetings', 'assets', 'source', 'creation_date', 'modification_date', 'creator_notes_multilingual']
      .forEach(function(k){ if (d[k] !== undefined) dropped.push(k + '(V3 专有，未存)'); });
    return { card: card, report: { ok: true, used: used, stored: stored, dropped: dropped, failedExamples: ex.failed } };
  }

  // 导出：本应用卡 → SillyTavern V2。内部专有字段（规则/好感度阈值/表情…）挂
  // data.extensions.ownchat，别人读前六字段、我们回导时不丢；
  // 同时双写旧键 omnigent —— 改名前的导出可能被外部工具按老键读过，双写不花钱。
  function ueCardToV2(c){
    var sp = c.spec && typeof c.spec === 'object' ? c.spec : {};
    var data = {
      name: c.name || '',
      description: c.identity || '',
      personality: c.personality || '',
      scenario: c.scenario || '',
      first_mes: c.openingLine || '',
      mes_example: (Array.isArray(c.exampleQA) ? c.exampleQA : []).filter(function(q){ return q && (q.user || q.character); })
        .map(function(q){ return '<START>\n{{user}}: ' + (q.user || '') + '\n{{char}}: ' + (q.character || ''); }).join('\n'),
      creator_notes: sp.creatorNotes || '',
      system_prompt: sp.systemPrompt || '',
      post_history_instructions: sp.postHistoryInstructions || '',
      alternate_greetings: Array.isArray(sp.alternateGreetings) ? sp.alternateGreetings : [],
      tags: Array.isArray(sp.tags) ? sp.tags : [],
      creator: sp.creator || 'OwnChat',
      character_version: sp.characterVersion || '',
      extensions: Object.assign({}, sp.extensions || {}, {
        ownchat: {
          gender: c.gender || '', age: c.age || '', speakingStyle: c.speakingStyle || '',
          rules: Array.isArray(c.rules) ? c.rules.filter(Boolean) : [],
          enableAffection: c.enableAffection !== false,
          affectionThresholds: Array.isArray(c.affectionThresholds) ? c.affectionThresholds : [],
          id: c.id || '',
        },
        omnigent: {
          gender: c.gender || '', age: c.age || '', speakingStyle: c.speakingStyle || '',
          rules: Array.isArray(c.rules) ? c.rules.filter(Boolean) : [],
          enableAffection: c.enableAffection !== false,
          affectionThresholds: Array.isArray(c.affectionThresholds) ? c.affectionThresholds : [],
          id: c.id || '',
        },
      }),
    };
    // 内嵌世界书：本应用的世界书是全局的，导出时把"绑到这张卡"的 perCard 条目带上（读不到就不带）
    try {
      if (window.__lorebook && typeof window.__lorebook.getAll === 'function') {
        var bound = (window.__lorebook.getAll() || []).filter(function(e){ return e && e.scope === 'perCard' && e.boundCardId === c.id; });
        if (bound.length) {
          data.character_book = {
            name: (c.name || '') + ' 的世界书', extensions: {},
            entries: bound.map(function(e){
              return { keys: e.keywords || [], content: e.content || '', enabled: e.enabled !== false,
                insertion_order: e.priority || 0, extensions: {}, name: e.name || '' };
            }),
          };
        }
      }
    } catch (e) {}
    return { spec: 'chara_card_v2', spec_version: '2.0', data: data };
  }

  // 一包多卡：数组里每个元素都可能是 V2（带 data）或 V1（平铺）；本应用自己的导出数组也走这里
  function ueCardsFromAny(data){
    var list = Array.isArray(data) ? data : [data];
    var cards = [], reports = [], rejected = 0;
    list.forEach(function(one){
      var r = ueCardFromSillyTavern(one);
      if (r.card) { cards.push(r.card); reports.push(r.report); } else rejected++;
    });
    return { cards: cards, reports: reports, rejected: rejected, isArray: Array.isArray(data) };
  }

  function ueCharImportFile(text, fname, isBinaryPng){
    var api = ueCharApi(); if (!api) { alert('角色卡模块未就绪（character.js 未加载），请刷新页面后重试。'); return; }
    var data;
    if (isBinaryPng) { data = text; }                                        // 调用方已把 PNG 解成对象
    else { try { data = JSON.parse(text); } catch (e) { alert('JSON 解析失败：' + e.message); return; } }
    var any = ueCardsFromAny(data);
    if (!any.cards.length) { alert('未识别到角色卡（支持 SillyTavern V1/V2/V3 单卡或多卡数组、PNG 卡、本应用导出）' + (any.rejected ? ('；被拒 ' + any.rejected + ' 个') : '')); return; }
    var saved = 0, chain = Promise.resolve();
    any.cards.forEach(function(c){ chain = chain.then(function(){ return api.saveCard(c); }).then(function(){ saved++; }, function(){}); });
    // 内嵌世界书：只对"单卡"做（多卡时哪张绑哪本没法定，如实说明）
    var loreN = 0, loreSkipped = 0;
    if (!any.isArray && window.__lorebook && window.__lorebook.parseSillyTavernBook) {
      var book = window.__lorebook.parseSillyTavernBook(data, (any.cards[0] && any.cards[0].name) || 'import');
      if (book && book.length) loreN = window.__lorebook.importAll(book, { merge: true });
    } else if (any.isArray) {
      var withBook = (Array.isArray(data) ? data : []).filter(function(x){ return x && (x.character_book || (x.data && x.data.character_book)); }).length;
      loreSkipped = withBook;
    }
    chain.then(function(){
      renderCharacterTab();
      // 报告：进了什么 / 存着什么（导出能还回去）/ 丢了什么 —— 旧版只报条数，用户根本不知道丢了什么
      var lines = ['已导入 ' + saved + ' 张角色卡' + (loreN ? ('，及内嵌世界书 ' + loreN + ' 条') : '') + '。'];
      if (any.rejected) lines.push('· 被拒 ' + any.rejected + ' 个（缺 name/description/first_mes）');
      var r0 = any.reports[0] || {};
      if (r0.used && r0.used.length) lines.push('· 映射进卡：' + r0.used.join(', '));
      if (r0.stored && r0.stored.length) lines.push('· 原样存着（导出 V2 会还回去，本应用暂不使用）：' + r0.stored.join(', '));
      if (r0.dropped && r0.dropped.length) lines.push('· 丢弃：' + r0.dropped.join(', '));
      if (r0.failedExamples) lines.push('· 有 ' + r0.failedExamples + ' 段示例对话没解析成对（可用 {{user}}: / {{char}}: 分隔，或手动补）');
      if (loreSkipped) lines.push('· 有 ' + loreSkipped + ' 张卡自带世界书：多卡导入时不自动并（哪张绑哪本没法定），请单卡导入一次');
      alert(lines.join('\n'));
    });
  }

  // ============== 设定集 Tab 实质化（P2 · 世界书 lorebook.js）==============
  // 复用 preset/角色 Tab 的列表 + 编辑器卡样式（ue-preset-row / ue-editor-card）。
  // 数据层走 window.__lorebook（LS tavern_lorebook_v1，随 sync.js 自动上云）。
  function ueWorldApi(){ return (window.__lorebook && typeof window.__lorebook.getAll === 'function') ? window.__lorebook : null; }

  function renderWorldTab(){
    var t = findTab('world'), body = document.getElementById('ueBody'); if (!body) return;
    var api = ueWorldApi();
    if (!api){ body.innerHTML = '<div class="ue-panel"><div class="ue-panel-head"><span class="ue-panel-icon">' + t.icon + '</span><span class="ue-panel-name">' + escapeHtml(t.label) + '</span></div><div class="ue-empty">设定集模块尚未就绪（lorebook.js 未加载），请刷新页面后重试。</div></div>'; return; }
    var entries = api.getAll();
    entries.sort(function(a,b){ return (b.priority||0) - (a.priority||0); });
    body.innerHTML = ['<div class="ue-panel">',
      '<div class="ue-panel-head"><span class="ue-panel-icon">' + t.icon + '</span><span class="ue-panel-name">' + escapeHtml(t.label) + '</span></div>',
      '<p class="ue-panel-desc">设定集条目（世界书 / Lorebook）：常驻或命中关键词时注入 system。与角色、剧情无关的通用设定也放这里；随云同步跨设备。</p>',
      '<div class="ue-toolbar">',
        '<button class="ue-btn ue-btn-primary" id="ueWorldNew">' + UE_A.plus + ' 新建条目</button>',
        '<button class="ue-btn" id="ueWorldImport" title="导入 SillyTavern 世界书 / 角色卡内嵌 character_book / 本应用导出的 JSON">' + UE_A.imp + ' 导入</button>',
        '<input type="file" id="ueWorldFile" accept=".json,application/json" style="display:none">',
        '<button class="ue-btn" id="ueWorldExport" title="导出全部设定集 JSON（下载文件）">' + UE_A.exp + ' 导出</button>',
        '<span class="ue-toolbar-spacer"></span>',
        '<span class="ue-count">共 ' + entries.length + ' 条</span>',
      '</div>',
      '<div class="ue-preset-list" id="ueWorldList">' + ueWorldListHtml(entries) + '</div>',
      '<div class="ue-editor-slot" id="ueWorldEditor"></div>',
    '</div>'].join('');
    document.getElementById('ueWorldNew').addEventListener('click', function(){ ueWorldEdit(null); });
    document.getElementById('ueWorldExport').addEventListener('click', function(){
      var json = JSON.stringify(api.exportAll(), null, 2);
      ueDownloadJson('ownchat-lorebook-' + new Date().toISOString().slice(0, 10) + '.json', json, '已导出 ' + entries.length + ' 条世界书');
    });
    var fileEl = document.getElementById('ueWorldFile'), impBtn = document.getElementById('ueWorldImport');
    if (impBtn) impBtn.addEventListener('click', function(){ if (fileEl){ fileEl.value=''; fileEl.click(); } });
    if (fileEl) fileEl.addEventListener('change', function(){
      var f = fileEl.files && fileEl.files[0]; if (!f) return;
      var rd = new FileReader();
      rd.onload = function(){ ueWorldImportFile(String(rd.result||''), f.name); };
      rd.readAsText(f);
    });
    var listEl = document.getElementById('ueWorldList');
    listEl.addEventListener('click', function(e){
      var row = e.target.closest && e.target.closest('.ue-preset-row'); if (!row) return;
      var id = row.getAttribute('data-id');
      // 2026-10-06: 同上（SVG 图标 → 先 closest 到按钮）
      var act = e.target.closest && e.target.closest('.ue-world-edit,.ue-world-del'); if (!act) return;
      if (act.classList.contains('ue-world-edit')) ueWorldEditById(id);
      else if (act.classList.contains('ue-world-del')) ueWorldDel(id);
    });
    listEl.addEventListener('change', function(e){
      if (!e.target.classList.contains('ue-world-chk')) return;
      var row = e.target.closest('.ue-preset-row'); var id = row.getAttribute('data-id');
      var en = api.getEntry(id); if (en){ en.enabled = !!e.target.checked; api.saveEntry(en); row.classList.toggle('enabled', en.enabled); }
    });
  }

  function ueWorldListHtml(entries){
    if (!entries.length) return '<div class="ue-empty">还没有设定集条目。点上方「新建条目」创建；也可以「导入」SillyTavern 的 world info（世界书）。</div>';
    return entries.map(function(e){
      var tags = [];
      if (e.alwaysOn) tags.push('常驻'); else tags.push((e.keywords && e.keywords.length) ? ('关键词:' + e.keywords.slice(0,4).join('/')) : '无触发词');
      if (e.scope === 'perCard') tags.push('绑卡');
      var sub = tags.join(' · ') + ' · ' + (e.content||'').slice(0,50).replace(/\n/g,' ');
      return ['<div class="ue-preset-row' + (e.enabled !== false ? ' enabled' : '') + '" data-id="' + escapeAttr(e.id) + '">',
        '<label class="ue-preset-tog"><input type="checkbox" class="ue-world-chk"' + (e.enabled !== false ? ' checked' : '') + '><span class="ue-preset-name">' + escapeHtml(e.name || '(未命名条目)') + '</span></label>',
        '<div class="ue-preset-preview">' + (escapeHtml(sub) || '<em>（空）</em>') + '</div>',
        '<div class="ue-preset-ops"><button class="ue-mini ue-world-edit" title="编辑">✎</button><button class="ue-mini danger ue-world-del" title="删除">✕</button></div>',
      '</div>'].join('');
    }).join('');
  }

  function ueWorldEditById(id){ var api = ueWorldApi(); if (!api) return; ueWorldEdit(api.getEntry(id)); }
  function ueWorldDel(id){ var api = ueWorldApi(); if (!api) return; var e = api.getEntry(id); if (!confirm('删除世界书条目「' + ((e&&e.name)||id) + '」？')) return; api.deleteEntry(id); renderWorldTab(); }

  function ueWorldImportFile(text, fname){
    var api = ueWorldApi(); if (!api) return;
    var data; try { data = JSON.parse(text); } catch (e) { alert('JSON 解析失败：' + e.message); return; }
    var add;
    if (Array.isArray(data)) add = data;                                  // 本应用导出格式（数组）
    else add = api.parseSillyTavernBook(data, String(fname||'').replace(/\.json$/i,'') || 'import');  // ST 世界书 / 角色卡内嵌 character_book
    if (!add || !add.length) { alert('未识别到可导入的世界书条目（支持本应用数组 / SillyTavern world info / 角色卡内嵌 character_book）'); return; }
    var n = api.importAll(add, { merge: true });
    renderWorldTab();
    alert('已追加导入 ' + n + ' 条世界书');
  }

  function ueWorldEdit(entry){
    var slot = document.getElementById('ueWorldEditor'); if (!slot) return;
    var isNew = !entry || !entry.id, e = entry || {};
    var kw = Array.isArray(e.keywords) ? e.keywords.join(', ') : (e.keywords || '');
    slot.innerHTML = ['<div class="ue-editor-card">',
      '<div class="ue-editor-head">' + (isNew ? UE_A.plus + ' 新建设定集条目' : UE_A.pencil + ' 编辑：' + escapeHtml(e.name||'')) + '</div>',
      '<label class="ue-field"><span>条目名 *</span><input class="ue-input" data-wf="name" value="' + escapeAttr(e.name||'') + '" placeholder="如：王国设定 / 主角的过去"></label>',
      '<label class="ue-field"><span>触发关键词（逗号分隔；勾选常驻则忽略）</span><input class="ue-input" data-wf="keywords" value="' + escapeAttr(kw) + '" placeholder="如：王国, 首都, 国王"></label>',
      '<label class="ue-field"><span>内容（注入到【世界设定】的正文）</span><textarea class="ue-textarea" data-wf="content" rows="6">' + escapeHtml(e.content||'') + '</textarea></label>',
      '<div class="ue-char-grid2">',
        '<label class="ue-field"><span>优先级（越大越靠前）</span><input class="ue-input" data-wf="priority" type="number" value="' + escapeAttr(e.priority != null ? String(e.priority) : '0') + '"></label>',
        '<label class="ue-field"><span>生效范围</span><select class="ue-input" data-wf="scope" id="ueWorldScope"><option value="global"' + (e.scope!=='perCard'?' selected':'') + '>全局</option><option value="perCard"' + (e.scope==='perCard'?' selected':'') + '>仅绑定角色卡</option></select></label>',
      '</div>',
      '<label class="ue-field" id="ueWorldBindWrap" style="' + (e.scope==='perCard'?'':'display:none;') + '"><span>绑定角色卡</span><select class="ue-input" data-wf="boundCardId" id="ueWorldBind"><option value="">（加载中…）</option></select></label>',
      '<label class="ue-field" style="flex-direction:row;align-items:center;gap:8px;"><input type="checkbox" data-wf="alwaysOn"' + (e.alwaysOn?' checked':'') + '><span>常驻注入（无视关键词，每轮都注入）</span></label>',
      '<div class="ue-editor-foot"><button class="ue-btn ue-btn-primary" id="ueWorldSave">' + (isNew?'新建':'保存修改') + '</button><button class="ue-btn" id="ueWorldCancel">取消</button></div>',
    '</div>'].join('');
    slot.scrollIntoView({ behavior:'smooth', block:'nearest' });
    var bindSel = document.getElementById('ueWorldBind');
    if (bindSel && window.__character && window.__character.getAllCards){
      window.__character.getAllCards().then(function(cards){
        bindSel.innerHTML = '<option value="">（选择角色卡）</option>' + (cards||[]).map(function(c){ return '<option value="' + escapeAttr(c.id) + '"' + (c.id===e.boundCardId?' selected':'') + '>' + escapeHtml((c.icon?c.icon+' ':'')+(c.name||c.id)) + '</option>'; }).join('');
      }, function(){ bindSel.innerHTML = '<option value="">（无法加载角色卡）</option>'; });
    }
    var scopeSel = document.getElementById('ueWorldScope'), bindWrap = document.getElementById('ueWorldBindWrap');
    if (scopeSel) scopeSel.addEventListener('change', function(){ if (bindWrap) bindWrap.style.display = scopeSel.value==='perCard' ? '' : 'none'; });
    document.getElementById('ueWorldCancel').addEventListener('click', function(){ slot.innerHTML=''; });
    document.getElementById('ueWorldSave').addEventListener('click', function(){
      var api = ueWorldApi(); if (!api) return;
      var g = function(k){ var el = slot.querySelector('[data-wf="' + k + '"]'); return el ? el.value : ''; };
      var name = (g('name')||'').trim(), content = g('content')||'';
      if (!name && !content.trim()) { alert('条目名和内容不能都为空'); return; }
      var scope = g('scope') === 'perCard' ? 'perCard' : 'global';
      var chk = slot.querySelector('[data-wf="alwaysOn"]');
      var merged = {
        id: (e&&e.id)||'',
        name: name,
        keywords: g('keywords')||'',
        content: content,
        alwaysOn: !!(chk && chk.checked),
        priority: parseInt(g('priority'),10) || 0,
        scope: scope,
        boundCardId: scope==='perCard' ? (g('boundCardId')||'') : '',
        enabled: (e && e.enabled === false) ? false : true,
        source: e ? e.source : ''
      };
      try { api.saveEntry(merged); renderWorldTab(); } catch (x) { alert('保存失败：' + (x&&x.message?x.message:x)); }
    });
  }

  window.__promptEditor = {
    open: open, close: close, switchTab: switchTab,
    // 外部强制刷新当前 tab（如 settings 改了 LS 后调用）
    refresh: function(){ if (mask && mask.classList.contains('open')) renderBody(); }
  };
})();