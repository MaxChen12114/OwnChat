// public/js/text/ui/settings.js
// 设置面板统一管理模块
// 职责:
//   1. 分类标签切换(settings-cat-nav + LS 持久化)
//   2. 面板开关(settingsBtn / closeSettingsBtn / settingsMask)
//   3. 所有 LS-only 开关/选择器(从 index.html 内联 <script> 迁入)
//      - showTopbarCostToggle  → cfw_show_topbar_cost_v1   (外观 · 顶栏资金按钮)
//      - hideMsgActionsToggle  → cfw_hide_msg_actions_v1   (外观 · 显示设置)
//      - hideStatsToggle       → cfw_hide_stats_v1         (外观 · 显示设置)
//      - replyStyleSel         → cfw_reply_style_v1        (对话 · 回复风格)
//      - 字号 / 字体           → cfw_chat_font_size_v1 / cfw_chat_font_family_v1 (外观 · 显示设置)
//      - syncIncludeChatToggle → cfw_sync_include_chat_v1
//      - syncWipeBtn / cloudExcludeSection
//   4. 云同步 + Auth UI(从 app.js setupSyncAuthUI 迁入)
//   5. 「思考过程显示」下拉 → cfw_think_display_v1(注入 外观 · 显示设置 卡;2026-10-05 之前靠 #historyKeep 反查宿主,寄生在「账号 · 本地对话记忆」卡里)
// 加载时机: app.js 之后,各 image 模块之前
// 路径: public/js/text/ui/settings.js
// 版本: 4.70 — 全部 emoji 清除，h4 改 SVG 图标
(() => {
  // ─── 0. 暴露 BYO 自定义模型配置给 app.js / agent 适配器 ───
  // get() 仅在 endpoint+model 齐全时返回配置对象,否则 null(回落内置 free/fast)。
  // app.js / 适配器组 /api/chat 请求体时: body.customProvider = window.__byoProvider.get() || undefined
  window.__byoProvider = {
    get() {
      try {
        var priv = JSON.parse(localStorage.getItem('cfw_byo_provider_v1') || '{}') || {};
        var pub = JSON.parse(localStorage.getItem('cfw_byo_provider_public_v1') || '{}') || {};
        var o = Object.assign({}, pub, priv);
        if (priv && typeof priv.apiKey === 'string') o.apiKey = priv.apiKey;
        else delete o.apiKey;
        return (o && o.endpoint && o.model) ? o : null;
      } catch (e) { return null; }
    }
  };

  // ─── 0.5 静态设置卡 JS 注入(M1:把卡 DOM 移出 index.html) ───
  // 每张卡在此创建并插入对应分类槽位,DOM 在 init 接线前就位,既有 init* 照常按 ID 接线。
  // 2026-10-05: 标题由「顶栏组件(Topbar Components)」改成「顶栏资金按钮」—— 卡里实际只有一个开关
  // (那个实时资金按钮),旧名承诺了"可选组件"复数,名不副实。归属(外观·界面)不变:顶栏就是界面。
  function mountTopbarCostCard() {
    var slot = document.getElementById('setAppearanceTopSlot');
    if (!slot || document.getElementById('showTopbarCostToggle')) return;
    var card = document.createElement('div'); card.className = 'card';
    card.innerHTML = '<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><path d="M3.5 9.2h17"/></svg>顶栏资金按钮</h4>'
      + '<p>控制顶栏那个实时资金按钮(今日 / 总计)的显示。关闭后剩余按钮(模式切换 / 内置 / 同步 / 设置)自动紧凑排列。<b>仅本设备生效</b>(不进云同步)。</p>'
      + '<div class="rowline"><div class="toggle"><input type="checkbox" id="showTopbarCostToggle"><label for="showTopbarCostToggle">显示实时资金按钮（顶栏：今日 / 总计）</label></div></div>'
      + '<div class="settings-tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg><span>资金数据始终在「高级 → 费用日志」卡里完整可看;关掉顶栏仅减少视觉占用,不影响计费/同步。</span></div>';
    slot.appendChild(card);
  }
  // 2026-09-12 修复:M1 重构把「顶栏组件」卡迁进 mountTopbarCostCard(),但外观 tab 第二个槙
  // #setAppearanceThemeSlot(主题切换)从未被迁移/重新挂载 —— 导致外观页只剩顶栏组件一张卡,
  // 主题切换彻底消失。theme.js 的 wireSettings() 只负责「找到已存在的 input[name=cfwTheme]接线」,
  // 它不负责创建 DOM,原 DOM 在 index.html 里,M1 迁移时漏了这一个。这里补回卡片 DOM + 自带读写逻辑
  // (不依赖 theme.js 的 load 时机,自己订阅 __theme,双重保险)。
  function mountMobileAppLayoutCard() {
    var slot = document.getElementById('setAppearanceThemeSlot') || document.getElementById('setAppearanceTopSlot');
    if (!slot || document.getElementById('mobileAppLayoutCard')) return;
    var K = 'cfw_mobile_bottom_tabs_v1';
    var RK = 'cfw_mobile_tabs_restore_v1';
    var card = document.createElement('div'); card.className = 'card'; card.id = 'mobileAppLayoutCard';
    card.innerHTML = '<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="2.5" width="12" height="19" rx="2.4"/><path d="M9.5 18.5h5"/></svg>手机 App 布局</h4>'
      + '<p>Android App 专用适配。输入框已按同类聊天 App 放大为更易点按的通栏布局;底部功能栏默认折叠,需要时可在这里打开。<b>仅本设备生效</b>。</p>'
      + '<div class="rowline"><div class="toggle"><input type="checkbox" id="mobileBottomTabsToggle"><label for="mobileBottomTabsToggle">显示底部功能栏(鱼缸 / 形象 / 场景 / Agent)</label></div><div class="btns"><button class="smallbtn" id="mobileAppRefreshBtn" type="button">刷新页面</button></div></div>'
      + '<div class="rowline" style="margin-top:6px;"><div class="toggle"><input type="checkbox" id="mobileTabsRestoreToggle"><label for="mobileTabsRestoreToggle">显示右下角快速唤醒按钮 ▦</label></div></div>'
      + '<div class="settings-tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg><span>底栏关闭后输入框会贴近底部安全区;快速唤醒按钮默认隐藏,打开上方开关后才显示。</span></div>';
    slot.appendChild(card);
    var t = card.querySelector('#mobileBottomTabsToggle');
    var rt = card.querySelector('#mobileTabsRestoreToggle');
    function isAndroidApp() {
      try { return document.documentElement.classList.contains('android-app') || localStorage.getItem('cfw_android_app_shell_v1') === '1'; } catch (e) { return false; }
    }
    function apply(on) {
      document.documentElement.classList.toggle('hide-mobile-tabs', !on);
      try { localStorage.setItem(K, on ? '1' : '0'); } catch (e) {}
    }
    function applyRestore(on) {
      document.documentElement.classList.toggle('show-mobile-tabs-restore', !!on);
      try { localStorage.setItem(RK, on ? '1' : '0'); } catch (e) {}
    }
    var on = true;
    try {
      var saved = localStorage.getItem(K);
      on = isAndroidApp() ? saved === '1' : saved !== '0';
    } catch (e) {}
    t.checked = on;
    apply(on);
    var restoreOn = false;
    try { restoreOn = localStorage.getItem(RK) === '1'; } catch (e) {}
    if (rt) { rt.checked = restoreOn; applyRestore(restoreOn); }
    t.addEventListener('change', function () { apply(t.checked); });
    if (rt) rt.addEventListener('change', function () { applyRestore(rt.checked); });
    var rb = card.querySelector('#mobileAppRefreshBtn');
    if (rb) rb.addEventListener('click', function () { location.reload(); });
  }
  // ─── §外观. 聊天背景图（2026-10-06 从编辑器「UI 配置」页搬来）───
  // 原「UI 配置」页里唯一还有人用的功能就是换背景图，其余（自定义颜色/圆角/背景音/原始变量）一并删掉：
  // 用户原话「其它的完全就是跟随主题就好了」。存储沿用原键，老用户已设的背景不会丢：
  //   cfw_ui_overrides_v1.bg = { src: URL | '__local__', opacity, blur }
  //   cfw_ui_assets_v1.bgData = 本机上传的 base64（该键在 sync 的 PROTECTED 里，永不上云）
  // 应用由 theme.js 的 __theme.applyBg() 负责（启动时自动一次）。
  function mountBackgroundCard() {
    var slot = document.getElementById('setAppearanceThemeSlot') || document.getElementById('setAppearanceTopSlot');
    if (!slot || document.getElementById('chatBgCard')) return;
    var card = document.createElement('div'); card.className = 'card'; card.id = 'chatBgCard';
    card.innerHTML = '<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="M21 16l-5-5L5 20"/></svg>聊天背景图</h4>'
      + '<p>给聊天区铺一张背景图（覆盖在主题底色上）。<b>仅本设备生效</b>：填 URL 会随云同步，上传的图片只留本机。</p>'
      + '<div style="margin-top:8px;"><label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;">图片 URL</label>'
      + '<div style="display:flex;gap:6px;"><input id="chatBgUrl" type="text" placeholder="https://… 或留空" style="flex:1;box-sizing:border-box;padding:7px 9px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;">'
      + '<button class="smallbtn" id="chatBgUrlApply" type="button">应用</button></div></div>'
      + '<div class="rowline" style="margin-top:10px;gap:6px;"><input type="file" id="chatBgFile" accept="image/*" style="display:none"><button class="smallbtn" id="chatBgPick" type="button">上传本地图片</button><button class="smallbtn danger" id="chatBgClear" type="button">清除背景</button><span id="chatBgStatus" style="font-size:11px;color:var(--muted);"></span></div>'
      + '<div style="margin-top:12px;"><label for="chatBgOpacity" style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:4px;"><span>不透明度</span><span id="chatBgOpacityLbl">100%</span></label><input id="chatBgOpacity" type="range" min="0" max="100" step="1" value="100" style="width:100%;"></div>'
      + '<div style="margin-top:8px;"><label for="chatBgBlur" style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:4px;"><span>模糊</span><span id="chatBgBlurLbl">0px</span></label><input id="chatBgBlur" type="range" min="0" max="24" step="1" value="0" style="width:100%;"></div>'
      + '<div style="margin-top:8px;"><label for="chatBgPosX" style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:4px;"><span>水平位置</span><span id="chatBgPosXLbl">居中</span></label><input id="chatBgPosX" type="range" min="0" max="100" step="1" value="50" style="width:100%;"></div>'
      + '<div style="margin-top:8px;"><label for="chatBgPosY" style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:4px;"><span>垂直位置</span><span id="chatBgPosYLbl">居中</span></label><input id="chatBgPosY" type="range" min="0" max="100" step="1" value="50" style="width:100%;"></div>'
      + '<div class="settings-tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg><span>上传的图片以 base64 存在本机（体积大，不进云同步）；换设备请用 URL。位置滑杆用来挪画面：0% = 靠左/靠上，100% = 靠右/靠下（图片按 cover 铺满，挪动即换露出区域）。背景图只在没有实色底的地方透出来，不影响侧栏与气泡可读性。</span></div>';
    slot.appendChild(card);
    var q = function (id) { return card.querySelector('#' + id); };
    function conf() { try { return JSON.parse(localStorage.getItem('cfw_ui_overrides_v1') || '{}') || {}; } catch (e) { return {}; } }
    function saveConf(o) { try { localStorage.setItem('cfw_ui_overrides_v1', JSON.stringify(o || {})); } catch (e) {} if (window.__theme && window.__theme.applyBg) window.__theme.applyBg(); }
    function assets() { try { return JSON.parse(localStorage.getItem('cfw_ui_assets_v1') || '{}') || {}; } catch (e) { return {}; } }
    function saveAssets(o) { try { localStorage.setItem('cfw_ui_assets_v1', JSON.stringify(o || {})); } catch (e) {} }
    function status(t) { var el = q('chatBgStatus'); if (el) el.textContent = t || ''; }
    function sync(fromAsset) {
      var bg = (conf().bg) || {};
      if (!fromAsset) { var u = q('chatBgUrl'); if (u) u.value = (bg.src && bg.src !== '__local__') ? bg.src : ''; }
      var op = (bg.opacity != null && bg.opacity !== '') ? parseInt(bg.opacity, 10) : 100;
      var bl = (bg.blur != null && bg.blur !== '') ? parseInt(bg.blur, 10) : 0;
      var px = (bg.posX != null && bg.posX !== '') ? parseInt(bg.posX, 10) : 50;
      var py = (bg.posY != null && bg.posY !== '') ? parseInt(bg.posY, 10) : 50;
      if (!isFinite(px)) px = 50; if (!isFinite(py)) py = 50;
      var oe = q('chatBgOpacity'), be = q('chatBgBlur'), xe = q('chatBgPosX'), ye = q('chatBgPosY');
      if (oe) oe.value = String(op); if (be) be.value = String(bl);
      if (xe) xe.value = String(px); if (ye) ye.value = String(py);
      var ol = q('chatBgOpacityLbl'), bll = q('chatBgBlurLbl'), xl = q('chatBgPosXLbl'), yl = q('chatBgPosYLbl');
      if (ol) ol.textContent = op + '%'; if (bll) bll.textContent = bl + 'px';
      // 位置标签：非中位时直接显示百分比，中位写「居中」，一眼能看出有没有挪过
      var posLabel = function (v) { return v === 50 ? '居中' : v + '%'; };
      if (xl) xl.textContent = posLabel(px);
      if (yl) yl.textContent = posLabel(py);
      status(bg.src ? (bg.src === '__local__' ? '当前：本机上传的图片' : '当前：URL') : '当前：未设置');
    }
    q('chatBgUrlApply').addEventListener('click', function () {
      var url = (q('chatBgUrl').value || '').trim();
      var o = conf(); o.bg = o.bg || {};
      if (!url) { delete o.bg.src; } else { o.bg.src = url; }
      if (!o.bg.src) delete o.bg;
      saveConf(o); sync();
    });
    q('chatBgPick').addEventListener('click', function () { q('chatBgFile').click(); });
    q('chatBgFile').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0]; if (!f) return;
      if (f.size > 4 * 1024 * 1024) { status('图片超过 4MB，换一张小一点的（base64 会更大）'); e.target.value = ''; return; }
      var rd = new FileReader();
      rd.onload = function () {
        var a = assets(); a.bgData = String(rd.result || ''); saveAssets(a);
        var o = conf(); o.bg = o.bg || {}; o.bg.src = '__local__'; saveConf(o); sync(true);
      };
      rd.onerror = function () { status('读取文件失败'); };
      rd.readAsDataURL(f); e.target.value = '';
    });
    q('chatBgClear').addEventListener('click', function () {
      var o = conf(); delete o.bg; saveConf(o);
      var a = assets(); delete a.bgData; saveAssets(a);
      var u = q('chatBgUrl'); if (u) u.value = '';
      sync();
    });
    q('chatBgOpacity').addEventListener('input', function () {
      var o = conf(); o.bg = o.bg || {}; o.bg.opacity = q('chatBgOpacity').value; saveConf(o);
      sync(true);
    });
    q('chatBgBlur').addEventListener('input', function () {
      var o = conf(); o.bg = o.bg || {}; o.bg.blur = q('chatBgBlur').value; saveConf(o);
      sync(true);
    });
    q('chatBgPosX').addEventListener('input', function () {
      var o = conf(); o.bg = o.bg || {}; o.bg.posX = q('chatBgPosX').value; saveConf(o);
      sync(true);
    });
    q('chatBgPosY').addEventListener('input', function () {
      var o = conf(); o.bg = o.bg || {}; o.bg.posY = q('chatBgPosY').value; saveConf(o);
      sync(true);
    });
    sync();
  }
  function mountThemeCard() {
    var slot = document.getElementById('setAppearanceThemeSlot');
    if (!slot || document.getElementById('appearanceThemeCard')) return;
    var card = document.createElement('div'); card.className = 'card'; card.id = 'appearanceThemeCard';
    card.innerHTML = '<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>外观风格(Visual Theme)</h4>'
      + '<p>切换整站配色与视觉氛围,三种风格随时切换。<b>仅本设备生效</b>(不进云同步)。</p>'
      + '<div class="theme-options">'
      + '<label class="theme-option"><input type="radio" name="cfwTheme" value="minimal"><div class="theme-swatch theme-swatch-minimal"></div><div class="theme-text"><div class="theme-title">极简</div><div class="theme-sub">Notion 风格，日/夜双态</div></div></label>'
      + '<label class="theme-option"><input type="radio" name="cfwTheme" value="glass"><div class="theme-swatch theme-swatch-glass"></div><div class="theme-text"><div class="theme-title">玻璃</div><div class="theme-sub">毛玻璃，晴空竹屋</div></div></label>'
      + '<label class="theme-option"><input type="radio" name="cfwTheme" value="candle"><div class="theme-swatch theme-swatch-candle"></div><div class="theme-text"><div class="theme-title">烛夜私语</div><div class="theme-sub">暗调，烛光</div></div></label>'
      + '</div>'
      + '<div class="settings-tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg><span>烛夜私语是暗调主题,含烛光薄雾与暗角;极简风格下方会出现日/夜切换。</span></div>';
    slot.appendChild(card);
    function syncChecked() {
      var cur = (window.__theme && window.__theme.get && window.__theme.get().style) || 'minimal';
      card.querySelectorAll('input[name="cfwTheme"]').forEach(function (r) { r.checked = (r.value === cur); });
    }
    card.querySelectorAll('input[name="cfwTheme"]').forEach(function (r) {
      r.addEventListener('change', function () {
        if (!r.checked) return;
        if (window.__theme && window.__theme.set) window.__theme.set({ style: r.value });
      });
    });
    syncChecked();
    if (window.__theme && window.__theme.subscribe) window.__theme.subscribe(syncChecked);
  }
  // ─── §氛围音卡（2026-10-06 双轨混音器：环境 amb × 音乐 mus）───
  // chips 与事件接线都在 theme.js 的 wireAmbientCard()（音轨注册表 = 唯一来源），
  // 本函数只负责卡壳子：总开关 / 两轨音量 / 两条 chips 容器 / 全部停止。
  function mountAmbientCard() {
    var slot = document.getElementById('setAppearanceThemeSlot');
    if (!slot || document.getElementById('ambientCard')) return;
    var card = document.createElement('div'); card.className = 'card'; card.id = 'ambientCard';
    card.innerHTML = '<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h2l2-5 3 10 3-7 2 4h6"/></svg>氛围音(Ambient)</h4>'
      + '<p>环境声与背景音乐两条独立音轨,可同时叠加、音量独立,切换带淡入淡出。RP 模式下 Agent 会按剧情自行调用(聊天里说「放点音乐」也会照做)。</p>'
      + '<div class="rowline"><div class="toggle"><input type="checkbox" id="ambEnabled"><label for="ambEnabled">启用氛围音</label></div>'
      + '<div class="btns"><button class="smallbtn" id="ambStopAll" type="button">全部停止</button></div></div>'
      + '<div class="amb-layer"><div class="amb-layer-head"><span class="amb-layer-name">环境声</span>'
      + '<label class="amb-vol" for="ambVolAmb"><span>音量</span><input type="range" id="ambVolAmb" min="0" max="100" step="1" value="60"><span class="amb-vol-val" id="ambVolAmbLabel">60%</span></label></div>'
      + '<div class="amb-chips" id="ambChipsAmb"></div></div>'
      + '<div class="amb-layer"><div class="amb-layer-head"><span class="amb-layer-name">背景音乐</span>'
      + '<label class="amb-vol" for="ambVolMus"><span>音量</span><input type="range" id="ambVolMus" min="0" max="100" step="1" value="35"><span class="amb-vol-val" id="ambVolMusLabel">35%</span></label></div>'
      + '<div class="amb-chips" id="ambChipsMus"></div></div>'
      + '<div class="settings-tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg><span>点标签播放、再点一下停止;高亮的是当前在放的轨。浏览器/手机 WebView 需先点过页面才会出声(自动播放限制)。音源全部为 CC0,来源见 <code>public/assets/ambient/CREDITS.txt</code>。</span></div>';
    slot.appendChild(card);
    try { if (window.__theme && window.__theme.wireAmbientCard) window.__theme.wireAmbientCard(); } catch (e) {}
  }
  // 为什么独立:底座是 system 提示词的第一段,对全部聊天生效(内置模型与自定义直连都吃),
  // 本身与"直连"毫无关系 —— 塞在直连卡最底部、隔一条分割线时,没人能找到它。
  // 为什么放「对话」类目首卡:基座影响一切,理应排在该分类最上面(prepend 保证位置,不依赖挂载顺序)。
  function mountBaseIdCard() {
    var slot = document.getElementById('setChatSlot');
    if (!slot || document.getElementById('baseIdCard')) return;
    function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    var card = document.createElement('div');
    card.className = 'card'; card.id = 'baseIdCard';
    card.innerHTML = `<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/></svg>基座提示词（系统提示第一段）</h4><p>底座是 system 提示词的第一段，所有聊天都吃它——内置模型与自定义直连一样。</p><div style="margin-top:10px;"><select id="baseIdSel" style="width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;"></select></div><div class="settings-tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg><span>选项就是 <code>src/prompts/bases/</code> 里的文件名（<b>默认</b> = 排序第一份；想让某份当默认，就在它名字最前面加个数字）。切换后<b>下一轮</b>生效（上游缓存前缀会重算一次）。两个目录：<code>src/prompts/bases/</code> 放正经的（随包一份「基础」），<code>src/prompts/custom/</code> 放你自己留着的那些 —— 顶栏那个按钮在两者之间切换。各放一个 <code>.md</code> / <code>.txt</code>（或一整个子目录 = 多文件基座），部署后下拉里自动多一项。<b><code>custom/</code> 里的东西别提交进公开仓库</b>（加进 <code>.gitignore</code>）。</span></div>`;
    slot.prepend(card);
    // 候选项来自 /config.js 的 APP_BASE_IDS(worker 侧 bases/index.js 自动发现的产物)。
    // 只存 id、不存文本;真正的取舍在服务端 resolveBaseId 白名单,前端这里只负责挑。
    var bs = document.getElementById('baseIdSel');
    if (!bs) return;
    var KB = 'cfw_base_id_v1';
    var ids = Array.isArray(window.APP_BASE_IDS) ? window.APP_BASE_IDS : [];
    // 2026-10-05: 下拉里**不加任何注释** —— 文件名本身就是标签(用户按名字分辨效果),
    // 旧版那张 HINTS 短注表(base-1=Pyrite / base-2=GLM…)已删,免得改名后表里说法变假。
    bs.innerHTML = '<option value="">默认</option>' + ids.map(function (id) {
      return '<option value="' + esc(id) + '">' + esc(id) + '</option>';
    }).join('');
    // 存了个已不存在的 id(文件被删/改名)时,浏览器会把 select 落回空 → 界面自动显示「默认」,
    // 与 worker 的白名单回落一致(那边也会回落到默认档)。
    try { bs.value = localStorage.getItem(KB) || ''; } catch (e) {}
    bs.addEventListener('change', function () {
      try { if (bs.value) localStorage.setItem(KB, bs.value); else localStorage.removeItem(KB); } catch (e) {}
    });
    // 2026-10-09 公开渠道（__baseSwitchMode）：第二套目录 —— 自定义（src/prompts/custom/）也来一个下拉。
    // 顶栏按钮只管在两套目录间切换，具体档位在这里各自选；私有版不置位，这段不执行。
    if (window.__baseSwitchMode) {
      var wrap = document.createElement('div');
      wrap.style.cssText = 'margin-top:12px;';
      var lab = document.createElement('div');
      lab.style.cssText = 'font-size:12px;opacity:.65;margin-bottom:5px;';
      lab.textContent = '自定义目录（src/prompts/custom/）';
      wrap.appendChild(lab);
      var cs = document.createElement('select');
      cs.id = 'customBaseIdSel';
      cs.style.cssText = 'width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;';
      var cids = Array.isArray(window.APP_CUSTOM_IDS) ? window.APP_CUSTOM_IDS : [];
      if (!cids.length) {
        cs.innerHTML = '<option value="">（目录为空 —— 把 .md / .txt 放进去并部署）</option>';
        cs.disabled = true;
      } else {
        cs.innerHTML = '<option value="">默认</option>' + cids.map(function (id) {
          return '<option value="' + esc(id) + '">' + esc(id) + '</option>';
        }).join('');
        try { cs.value = localStorage.getItem('cfw_custom_id_v1') || ''; } catch (e) {}
        cs.addEventListener('change', function () {
          try { if (cs.value) localStorage.setItem('cfw_custom_id_v1', cs.value); else localStorage.removeItem('cfw_custom_id_v1'); } catch (e) {}
        });
      }
      wrap.appendChild(cs);
      var host = bs.parentNode && bs.parentNode.parentNode;
      if (host) host.insertBefore(wrap, bs.parentNode.nextSibling);
    }
  }
  // ─── §联网搜索卡（2026-10-07 新增）───
  // 背景：DeepSeek 官方 API 没有服务端搜索（官方文档里内置工具标 Ignored，定价页也无搜索项），
  // 所以「联网」由本项目的 Worker 代查：免费的 DuckDuckGo 兜底，配了 EXA_API_KEY 才升级深搜。
  // 开关默认关（不静默把查询外发）；只对普通聊天生效，Agent 模式本来就有 web_search 工具。
  function mountWebSearchCard() {
    var slot = document.getElementById('setChatSlot');
    if (!slot || document.getElementById('webSearchCard')) return;
    var card = document.createElement('div'); card.className = 'card'; card.id = 'webSearchCard';
    card.innerHTML = '<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>联网搜索（Web Search）</h4>'
      + '<p>开启后，普通聊天遇到需要实时信息的问题（新闻、价格、版本、赛事…）时会自己搜索再回答，并在引用处附来源链接。搜索由<b>你自己的 Worker</b> 执行 —— 官方 API 里没有内置搜索，这里是把搜索工具挂在聊天请求上、由 Worker 侧跑。</p>'
      + '<div class="rowline"><div class="toggle"><input type="checkbox" id="webSearchToggle"><label for="webSearchToggle">启用联网搜索</label></div>'
      + '<div class="toggle" style="margin-top:6px;"><input type="checkbox" id="webSearchDeepToggle"><label for="webSearchDeepToggle">深度搜索（Exa，按次计费 ≈¥0.05/次）</label></div></div>'
      + '<div id="webSearchStatus" style="font-size:11px;color:var(--muted);margin-top:8px;"></div>'
      + '<div class="settings-tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg><span>默认走免费的 DuckDuckGo,它不通时自动改用 <b>Bing</b>(同样免费);只有 Worker 侧配置了 <code>EXA_API_KEY</code>（<code>wrangler secret put EXA_API_KEY</code>）且这里勾了「深度搜索」时才会用 Exa,没配则自动降级。开了联网的回复会比平时慢一些——要多 1~2 轮「搜索 + 复述结果」。查询词会发到你自己的 Worker 再转给搜索服务;Agent 模式的 <code>web_search</code> 工具不受此开关影响。</span></div>';
    slot.appendChild(card);
    var t = card.querySelector('#webSearchToggle');
    var d = card.querySelector('#webSearchDeepToggle');
    var st = card.querySelector('#webSearchStatus');
    function paint() {
      var on = localStorage.getItem('cfw_web_search_v1') === '1';
      var deep = localStorage.getItem('cfw_web_search_deep_v1') === '1';
      t.checked = on; d.checked = deep;
      d.disabled = !on;
      if (st) st.textContent = !on ? '未启用（聊天只靠模型自身知识）' : (deep ? '已启用：深搜(Exa)优先，未配 key 自动降级' : '已启用：免费搜索(DuckDuckGo)');
    }
    t.addEventListener('change', function () {
      localStorage.setItem('cfw_web_search_v1', t.checked ? '1' : '0');
      if (!t.checked) { localStorage.setItem('cfw_web_search_deep_v1', '0'); }
      paint();
    });
    d.addEventListener('change', function () { localStorage.setItem('cfw_web_search_deep_v1', d.checked ? '1' : '0'); paint(); });
    paint();
  }
  // ─── §对话. 角色状态层开关（2026-10-05 新增）───
  // 回答「为什么默认就是 RP」:判定只有一条 —— 有角色卡就注入 Layer2 的【当前状态】那一段
  // (关系/情绪/好感/场景/摘要)。这个开关就是那个手动把手:关掉后角色卡照旧,只是不再注入状态。
  // 为什么单独成卡而不是塞进「回复风格」卡:那卡只管排版取材,这个名字也对不上(旧账就是乱放被挑过)。
  function mountStateLayerCard() {
    var slot = document.getElementById('setChatSlot');
    if (!slot || document.getElementById('stateLayerToggle')) return;
    var card = document.createElement('div'); card.className = 'card';
    card.innerHTML = `<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20V10"/><path d="M6 20v-6"/><path d="M18 20V4"/></svg>角色状态层</h4><p>有角色卡时，服务端会把「【当前状态】」那一段（关系 / 情绪 / 好感度 / 场景 / 剧情摘要）接在 system 末尾。<b>关掉后角色卡照旧生效，只是不再注入这些状态</b>——想让它纯按角色卡演、不吃好感度与场景提示时用。</p><div class="rowline"><div class="toggle"><input type="checkbox" id="stateLayerToggle"><label for="stateLayerToggle">注入角色状态层（【当前状态】/ 场景 / 摘要）</label></div></div><div class="settings-tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg><span>切换后<b>下一轮</b>生效。默认开 —— 不是按模型判的，就一条规则：有角色卡就注入。工具/Agent 那条路径本来就不吃状态层。</span></div>`;
    slot.appendChild(card);
  }
  // 2026-10-05: 标题由「互动模式(Roleplay Mode)」改成「回复风格」,并交出了两个显示 toggle
  // (隐藏小按钮/隐藏统计小字 → 搬进「外观·显示设置」卡)。卡名与内容对齐:它现在只管回复风格。
  // 守卫 ID 随之从 hideMsgActionsToggle 换成本卡仍有的 replyStyleSel —— 否则 toggle 搬走后守卫失效,会反复重挂。
  function mountChatModeCard() {
    var slot = document.getElementById('setChatSlot');
    if (!slot || document.getElementById('replyStyleSel')) return;
    var card = document.createElement('div'); card.className = 'card';
    card.innerHTML = `<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 19l8.5-8.5"/><path d="M15 4.5l.9 2 2 .9-2 .9-.9 2-.9-2-2-.9 2-.9z"/><path d="M6.5 4.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z"/></svg>回复风格(Reply Style)</h4><p>控制 AI 回复的取材与排版。</p><div style="margin-top:10px;"><div style="font-size:12px;color:var(--muted);margin-bottom:8px;">回复风格</div><select id="replyStyleSel" style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--border, #333);background:transparent;color:inherit;font-size:13px;"><option value="default">默认（交由角色卡决定）</option><option value="wechat">微信连发（1-2 句一条，多气泡连发）</option><option value="verbose">长段叙事（小说式丰满段落，写小说）</option></select></div><div class="settings-tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg><span>单人普通对话<b>没有字数限制</b>,写小说请选 <b>长段叙事</b> 档。字数限制(150-250 字)只存在于鱼缸接龙/讨论模式,保持多人轮转节奏。</span></div>`;
    slot.appendChild(card);
  }
  // 显示设置卡 = 聊天区呈现的唯一去处(字号 / 字体 / 内容里的显示开关)。
  // 2026-10-05: 「隐藏小按钮」「隐藏统计小字」两个 toggle 从「互动模式」卡搬来 ——
  // 显示类开关原本被拆在两个类目里(字号字体在外观、两个 toggle 在对话),现在收拢到一处。
  // 接线不受影响:它们由 ID 查元素(见本文件 initPanelToggle 区),不依赖父节点。
  function mountDisplayCard() {
    var slot = document.getElementById('setAppearanceThemeSlot') || document.getElementById('setAppearanceTopSlot');
    if (!slot || document.getElementById('chatFontSizeRange')) return;
    var card = document.createElement('div'); card.className = 'card';
    card.innerHTML = `<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h8M16 7h4M4 12h2M10 12h10M4 17h6M14 17h6"/><circle cx="14" cy="7" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="12" cy="17" r="2"/></svg>显示设置(Display)</h4><p>调整聊天区字号、字体，以及聊天内容里的显示开关。<b>仅本设备生效</b>(不进云同步)，刷新页面也会保留。</p><div style="margin-top:8px;"><label for="chatFontSizeRange" style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:6px;"><span>聊天字号</span><span id="chatFontSizeLabel" style="font-variant-numeric:tabular-nums;">13px</span></label><input type="range" id="chatFontSizeRange" min="12" max="22" step="1" value="13" style="width:100%;"></div><div style="margin-top:14px;"><div style="font-size:12px;color:var(--muted);margin-bottom:6px;">聊天字体</div><select id="chatFontFamilySel" style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--border, #333);background:transparent;color:inherit;font-size:13px;"><option value="">系统默认（苹方/微软雅黑）</option><option value='"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif'>圆体（PingFang）</option><option value='"Noto Serif SC", "Source Han Serif SC", "SimSun", serif'>宋体（Noto Serif）</option><option value='"Kaiti SC", "STKaiti", KaiTi, serif'>楷体（Kaiti）</option><option value='FangSong, STFangsong, serif'>仿宋（FangSong）</option><option value='ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'>等宽（Monospace）</option></select></div><div class="rowline" style="margin-top:14px;"><div class="toggle"><input type="checkbox" id="hideMsgActionsToggle"><label for="hideMsgActionsToggle">隐藏消息行下方的小按钮(重试/删除/复制)</label></div></div><div class="rowline"><div class="toggle"><input type="checkbox" id="hideStatsToggle"><label for="hideStatsToggle">隐藏统计小字(token / 速度 / 累计费用)</label></div></div><div class="settings-tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg><span>气泡跳动同步梳理主题请到「外观风格」卡切主题；wechat 连发模式会自动隐藏小按钮(同时被上面的 toggle 接管)。</span></div>`;
    slot.appendChild(card);
  }
  function mountAuthCard() {
    var slot = document.getElementById('setAccountSlot');
    if (!slot || document.getElementById('chatProtectToggle')) return;
    var card = document.createElement('div');
    card.className = 'card';
    card.setAttribute('data-dev-only', '');
    card.innerHTML = `<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/></svg>密码保护（Auth）</h4><p><b>云同步</b>永远需要密码（用 Cloudflare Secret <code>CHAT_PASSWORD</code> 鉴权）。<b>聊天密码保护</b>可选:开启后调用 <code>/api/chat</code> 需带 token,关闭后聊天接口公开(任何扫到域名的人都能用你的余额)。</p><div class="rowline"><div class="toggle"><input type="checkbox" id="chatProtectToggle"><label for="chatProtectToggle">启用聊天密码保护(强烈推荐)</label></div><div class="btns"><button class="smallbtn danger" id="authLogoutBtn" title="清除本地保存的密码 token">退出登录</button></div></div><div id="authStatus" style="font-size:11px;color:var(--muted);margin-top:8px;"></div>`;
    slot.appendChild(card);
  }
  function mountSyncCard() {
    var slot = document.getElementById('setAccountSlot');
    if (!slot || document.getElementById('syncEnableToggle')) return;
    var card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.5 18.5a4.5 4.5 0 0 1-.7-8.95A5.5 5.5 0 0 1 17 9.1 3.7 3.7 0 0 1 16.8 18.5z"/></svg>云同步（Cloud Sync）</h4><p>把数据同步到 Cloudflare KV,换浏览器换设备都能看到:角色卡 / 指令模块 / 亲密度 / 费用日志,以及<b>对话历史（需勾选下方「同步聊天历史」)</b>。本地改动延迟 30 秒自动推送(为省 KV 配额;桌面端关窗与回到前台会立刻补推/补拉)。<b>不同步:</b>密码 token / 同步状态本身。</p><div class="rowline"><div class="toggle"><input type="checkbox" id="syncEnableToggle"><label for="syncEnableToggle">启用云同步</label></div><div class="toggle" style="margin-top:6px;"><input type="checkbox" id="syncIncludeChatToggle"><label for="syncIncludeChatToggle">同步聊天历史（跨设备共享对话）</label></div><div class="btns"><button class="smallbtn" id="syncNowBtn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v3.5h-3.5"/></svg>立即同步</button><button class="smallbtn" id="syncExportBtn" data-dev-only><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15.5V5"/><path d="M8 8.5L12 4.5l4 4"/><path d="M5 14.5v3.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5v-3.5"/></svg>导出备份</button><button class="smallbtn" id="syncImportBtn" data-dev-only><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4.5V15"/><path d="M8 11l4 4 4-4"/><path d="M5 14.5v3.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5v-3.5"/></svg>导入备份</button><input type="file" id="syncImportFile" accept=".json" style="display:none"><button class="smallbtn danger" id="syncWipeBtn" title="删除云端 KV 上的全部数据(角色卡/指令模块/费用/对话的云端副本)。本地数据保留;同步仍开启时下次本地改动会重新上传,想让云端保持空请清空后关闭云同步。"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 6.5h15"/><path d="M9 6.5V5.2A1.7 1.7 0 0 1 10.7 3.5h2.6A1.7 1.7 0 0 1 15 5.2V6.5"/><path d="M6.8 6.5l.7 12.2a1.8 1.8 0 0 0 1.8 1.7h5.4a1.8 1.8 0 0 0 1.8-1.7l.7-12.2"/></svg>清空云端</button></div></div><div id="syncStatus" style="font-size:11px;color:var(--muted);margin-top:8px;"></div><div id="syncQuotaWarn" style="font-size:11px;color:#f80;margin-top:4px;display:none;"></div><details id="cloudExcludeSection" style="margin-top:10px;"><summary style="cursor:pointer;font-size:12px;color:var(--muted);"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.5 16.5a4.2 4.2 0 0 1-.6-8.35A5.2 5.2 0 0 1 16.5 8"/><path d="M14.5 14l5 5M19.5 14l-5 5"/></svg>按角色/会话 只清云端（保留本地）</summary><div style="font-size:11px;color:var(--muted);margin:6px 0;line-height:1.5;">只把选中项从云端 KV 抹掉,本地保留且本设备不再上传(tombstone)。<b>会话</b>仅在开了「同步聊天历史」时云端才有副本。<b>跨设备注意:</b>排除清单仅本设备生效,其他仍持有该数据且未排除的设备改动后可能把它推回。</div><div id="cloudExcludeList" style="display:flex;flex-direction:column;gap:6px;"></div></details>`;
    slot.appendChild(card);
  }
  // ─── M1: 本地对话记忆卡(#historyKeep / #promptKeep / #clearHistory) ───
  // 保存逻辑由 app.js 按 ID 接线；settings.js 仅在 openPanel 时同步显示值(见 initPanelToggle)。
  function mountLocalHistoryCard() {
    var slot = document.getElementById('setAccountSlot');
    if (!slot || document.getElementById('historyKeep')) return;
    var card = document.createElement('div'); card.className = 'card'; card.id = 'localHistoryCard';
    card.innerHTML = '<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>本地对话记忆</h4>'
      + '<p>开启后发消息会带上本机历史上下文，AI 能记住你们说过的话。<b>仅本设备</b>（不进云同步）。</p>'
      + '<div class="rowline"><div class="toggle"><input type="checkbox" id="historyKeep"><label for="historyKeep">记住本机对话（带上历史消息）</label></div><div class="btns"><button class="smallbtn danger" id="clearHistory">清空对话</button></div></div>'
      + '<div class="rowline" style="margin-top:6px;"><div class="toggle"><input type="checkbox" id="promptKeep"><label for="promptKeep">记住自定义提示词（每次对话带上）</label></div></div>'
      + '<div class="settings-warn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg><span>历史消息会消耗更多 token，上下文过长时请手动清空对话。</span></div>';
    slot.appendChild(card);
  }

  // ─── M1: 网页自定义人物模板卡(#customPrompt) ───
  // 保存逻辑由 app.js 按 ID 接线；settings.js 仅在 openPanel 时回填 LS 值(见 initPanelToggle)。
  function mountPersonaCard() {
    var slot = document.getElementById('setChatSlot');
    if (!slot || document.getElementById('customPrompt')) return;
    var card = document.createElement('div'); card.className = 'card'; card.id = 'personaTemplateCard';
    card.innerHTML = '<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>网页自定义人物模板</h4>'
      + '<p>这段文字会追加到每条对话的 system prompt 末尾（优先级低于角色卡）。适合补充你对 AI 行为的统一要求。<b>仅本设备</b>。</p>'
      + '<textarea id="customPrompt" rows="5" placeholder="输入自定义人物设定或全局指令…" style="width:100%;box-sizing:border-box;padding:8px 10px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;resize:vertical;"></textarea>'
      + '<div class="settings-tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg><span>上方「记住自定义提示词」开关控制本内容是否实际发送。留空 = 不追加任何内容。</span></div>';
    slot.appendChild(card);
  }

  // ─── 自驱叙事控制卡(autopilot.js 的入口 UI · 决策 O 默认半自动) ───
  // 写 cfw_autopilot_* + cfw_address_mode_v1 + cfw_choices_freq_v1;开始/停止直接调 window.__autopilot。仅本设备。挂 #setChatSlot。
  function mountAutopilotCard() {
    var slot = document.getElementById('setChatSlot');
    if (!slot || document.getElementById('autopilotCard')) return;
    // 2026-09-10 瘦身: speed / climax 两个 key 随 arousal 机制一起下线(见 autopilot.js)
    var K = { mode: 'cfw_autopilot_mode_v1', auto: 'cfw_autopilot_auto_v1', maxSeg: 'cfw_autopilot_max_segments_v1', gateTts: 'cfw_autopilot_gate_tts_v1', address: 'cfw_address_mode_v1', choices: 'cfw_choices_freq_v1' };
    function g(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
    function set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
    var SS = 'flex:1;padding:7px 9px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;';
    var LB = 'font-size:12px;color:var(--muted);min-width:56px;';
    var card = document.createElement('div'); card.className = 'card'; card.id = 'autopilotCard';
    card.innerHTML = '<h4>自驱叙事(Autopilot)</h4>'
      + '<p>让 AI 自己一段段往下写,不用每次催。<b>半自动</b>每段停下给「继续 / 选项 / 自己写」,<b>全自动</b>按节拍连演。「一句话把活干完」的工作模式不在这,走 Agent。随时 <b>Shift+Esc</b> 全停。<b>仅本设备</b>。</p>'
      + '<div class="rowline" style="align-items:center;gap:10px;"><label style="' + LB + '">模式</label><select id="apMode" style="' + SS + '"><option value="">关</option><option value="novel">小说叙事</option></select></div>'
      + '<div class="rowline" style="align-items:center;gap:10px;"><label style="' + LB + '">推进</label><select id="apAuto" style="' + SS + '"><option value="half">半自动（每段停一下）</option><option value="full">全自动（连续演）</option></select></div>'
      + '<div class="rowline" style="align-items:center;gap:10px;"><label style="' + LB + '">视角</label><select id="apAddress" style="' + SS + '"><option value="dialogue">对话（只对你说话）</option><option value="immersive">沉浸（带动作旁白）</option><option value="narration">小说（第三人称）</option></select></div>'
      + '<div class="rowline" style="align-items:center;gap:10px;"><label style="' + LB + '">选项</label><select id="apChoices" style="' + SS + '"><option value="off">不给选项</option><option value="fork">岔路口才给(默认)</option><option value="every">每段都给</option></select></div>'
      + '<div class="rowline" style="align-items:center;gap:10px;"><label style="' + LB + '">最多段</label><input type="number" id="apMaxSeg" min="1" max="1000" style="width:90px;padding:6px 8px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;"></div>'
      + '<div class="rowline"><div class="toggle"><input type="checkbox" id="apGateTts"><label for="apGateTts">读完一段再演下一段(仅桌面 TTS)</label></div></div>'
      + '<div class="rowline"><div></div><div class="btns"><button class="smallbtn" id="apStart" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.5 4.9v14.2L19.5 12z"/></svg>开始自驱</button><button class="smallbtn danger" id="apStop" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="1.8"/></svg>停止</button></div></div>'
      + '<div id="apStatus" style="font-size:11px;color:var(--muted);margin-top:8px;"></div>'
      + '<div class="settings-tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg><span>半自动暂停时直接在输入框打字发送会自动接管。需 index.html 已引入 autopilot.js。</span></div>';
    slot.appendChild(card);
    function q(id) { return card.querySelector(id); }
    var mode = q('#apMode'), auto = q('#apAuto'), address = q('#apAddress'), choices = q('#apChoices'), maxSeg = q('#apMaxSeg'), gateTts = q('#apGateTts'), statusEl = q('#apStatus');
    // 2026-09-10: 老 LS 里存的 'rp' 下拉里已没这个 option,不归一的话 select 会变成空值(看着像「设置丢了」)
    var _m = g(K.mode, ''); if (_m === 'rp') { _m = 'novel'; set(K.mode, 'novel'); }
    mode.value = _m; auto.value = g(K.auto, 'half'); address.value = g(K.address, 'dialogue'); choices.value = g(K.choices, 'fork'); maxSeg.value = g(K.maxSeg, '12'); gateTts.checked = g(K.gateTts, '0') === '1';
    mode.addEventListener('change', function () { set(K.mode, mode.value); });
    auto.addEventListener('change', function () { set(K.auto, auto.value); });
    address.addEventListener('change', function () { set(K.address, address.value); });
    choices.addEventListener('change', function () { set(K.choices, choices.value); });
    maxSeg.addEventListener('change', function () { var n = parseInt(maxSeg.value, 10); if (!(n >= 1 && n <= 1000)) { n = 12; maxSeg.value = '12'; } set(K.maxSeg, String(n)); });
    gateTts.addEventListener('change', function () { set(K.gateTts, gateTts.checked ? '1' : '0'); });
    function setMsg(t) { if (statusEl) statusEl.textContent = t || ''; }
    q('#apStart').addEventListener('click', function () {
      if (!window.__autopilot) { setMsg('自驱引擎未加载(检查 index.html 是否引了 autopilot.js)'); return; }
      var r = window.__autopilot.start({ mode: mode.value });
      if (r && r.ok) setMsg('已开始：小说叙事 / ' + (auto.value === 'full' ? '全自动' : '半自动'));
      else setMsg('没开起来:' + ((r && r.reason) || '未知'));
    });
    q('#apStop').addEventListener('click', function () { if (window.__autopilot) window.__autopilot.stop('user-stop'); setMsg('已停止'); });
    try { if (window.__autopilot && window.__autopilot.onTick) window.__autopilot.onTick(function (st) { setMsg('状态:' + st.state + '，第 ' + st.seg + ' 段'); }); } catch (e) {}
  }

  // ─── 多智能体编排（2026-10-08 从「Agent 工作模式」卡拆出）───
  // 用户口径：编排玩法与工作能力是两件事，各占一张卡。工具是否注册由 tools.js 的 MA_GATED
  // 三重条件共同决定：① 侧栏「多智能体」模式开着 ② 本卡对应开关开着 ③ 当前不是子 agent 档。
  function mountMultiAgentCard() {
    var slot = document.getElementById('setAgentSlot') || document.getElementById('setChatSlot');
    if (!slot || document.getElementById('multiAgentCard')) return;
    var SS = 'flex:1;padding:7px 9px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;';
    var card = document.createElement('div'); card.className = 'card'; card.id = 'multiAgentCard';
    card.innerHTML = '<h4>多智能体编排</h4>'
      // 本段刻意写成"整句单文本节点"（不带 <b> 内联标签）：双语引擎按文本节点整串匹配，
      // 带标签的句子会被切成碎片、字典键难对（这是上一批翻译踩过的坑）。
      + '<p>先在侧栏打开「多智能体」模式，再按下面开关逐个放行；模式关闭时 = 单 agent，不挂任何编排工具。平级 agent = 你配置好的角色卡（各有独立上下文）；子 agent = 主 agent 现造的临时工（最小权限、任务完成即回收，不进聊天记录）。</p>'
      + '<div class="rowline"><div class="toggle"><input type="checkbox" id="maDelegate"><label for="maDelegate">主子分派（允许派子 agent 干活）</label></div></div>'
      + '<div class="rowline"><div class="toggle"><input type="checkbox" id="maMeeting"><label for="maMeeting">私下小会（向角色私下征询，结论不进时间线）</label></div></div>'
      + '<div class="rowline"><div class="toggle"><input type="checkbox" id="maInvite"><label for="maInvite">请角色上台（角色可直接在时间线回答）</label></div></div>'
      + '<div class="rowline" style="align-items:center;gap:8px;flex-wrap:wrap;"><label style="font-size:12px;color:var(--muted);min-width:52px;">小会</label>'
      + '<input id="maMeetMax" type="number" min="1" max="6" step="1" style="' + SS + 'max-width:76px;" title="每次小会最多几位角色（每位都是一次独立计费调用）"> <span style="font-size:11px;color:var(--muted);">人数上限</span>'
      + '<input id="maMeetRounds" type="number" min="1" max="2" step="1" style="' + SS + 'max-width:76px;" title="2 = 第二轮参与者能看到彼此答案、互相补充或反驳（成本约翻倍）"> <span style="font-size:11px;color:var(--muted);">轮数</span>'
      + '<input id="maCtxMsgs" type="number" min="0" max="400" step="10" style="' + SS + 'max-width:88px;" title="每位角色带多少条自己的上下文（0 = 全带；条数越多越贵）"> <span style="font-size:11px;color:var(--muted);">上下文条数</span></div>'
      + '<div class="settings-tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg><span>成本提示：小会里每位角色都是一次独立计费调用，轮数 2 约等于翻倍；子 agent 继承最小权限，不碰你的数据与时间线。</span></div>';
    slot.appendChild(card);

    // 开关与上限（tools.js 的 MA_GATED / app.js 的 _maCfg 读这些键；键"没值"= 开/默认，
    // 这样老用户不用先来这里点一遍）
    [['maDelegate', 'cfw_ma_delegate_v1'], ['maMeeting', 'cfw_ma_meeting_v1'], ['maInvite', 'cfw_ma_invite_v1']].forEach(function (pair) {
      var el = card.querySelector('#' + pair[0]); if (!el) return;
      var cur = true; try { var v = localStorage.getItem(pair[1]); if (v != null) cur = v === '1'; } catch (e) {}
      el.checked = cur;
      el.addEventListener('change', function () { try { localStorage.setItem(pair[1], el.checked ? '1' : '0'); } catch (e) {} });
    });
    [['maMeetMax', 'cfw_ma_meeting_max_v1', 3, 1, 6], ['maMeetRounds', 'cfw_ma_meeting_rounds_v1', 1, 1, 2], ['maCtxMsgs', 'cfw_ma_ctx_msgs_v1', 60, 0, 400]].forEach(function (q) {
      var el = card.querySelector('#' + q[0]); if (!el) return;
      var cur = q[2]; try { var n = parseInt(localStorage.getItem(q[1]), 10); if (!isNaN(n)) cur = Math.max(q[3], Math.min(q[4], n)); } catch (e) {}
      el.value = String(cur);
      el.addEventListener('change', function () {
        var n2 = parseInt(el.value, 10); if (isNaN(n2)) n2 = q[2];
        n2 = Math.max(q[3], Math.min(q[4], n2)); el.value = String(n2);
        try { localStorage.setItem(q[1], String(n2)); } catch (e) {}
      });
    });
  }

  // ─── Agent 工具集档位(对应 shared/tools.js 里的 CORE_TOOLS 门控 · LS cfw_agent_tools_v1) ───
  // 两档: core(常用) / full(全量,自检时才开)。档位数在卡内动态点数（作者会持续加工具）。
  function mountAgentToolsCard() {
    // 2026-09-14:Agent 配置独立成分类(工具档位 / 轮数 / 工作模式);旧页面回落 #setChatSlot
    var slot = document.getElementById('setAgentSlot') || document.getElementById('setChatSlot');
    if (!slot || document.getElementById('agentToolsCard')) return;
    var K = 'cfw_agent_tools_v1';
    var SS = 'flex:1;padding:7px 9px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;';
    var card = document.createElement('div'); card.className = 'card'; card.id = 'agentToolsCard';
    card.innerHTML = '<h4>Agent 工作模式</h4>'
      + '<p>决定 Agent 执行动作时的放行策略(对齐成熟 agent 工具的做法)。<b>仅本设备</b>。</p>'
      + '<div class="rowline" style="align-items:center;gap:10px;"><label style="font-size:12px;color:var(--muted);min-width:42px;">模式</label><select id="agentWorkMode" style="' + SS + '">'
      + '<option value="confirm">变更前确认：有副作用的操作先问我</option>'
      + '<option value="auto">自动编辑：文件类操作直接做，其余仍问</option>'
      + '<option value="plan">计划模式：先出计划，不动手</option>'
      + '<option value="full">完全访问：不再确认</option>'
      + '</select></div>'
      + '<div id="agentWorkDesc" style="font-size:11px;color:var(--muted);margin-top:8px;line-height:1.6;"></div>'
      + '<div class="rowline" style="align-items:center;gap:10px;margin-top:12px;"><label style="font-size:12px;color:var(--muted);min-width:42px;">工具</label>'
      + '<select id="agentToolsSel" style="' + SS + '"></select></div>'
      + '<div class="rowline" style="align-items:center;gap:10px;margin-top:8px;"><label style="font-size:12px;color:var(--muted);min-width:42px;">轮数</label>'
      + '<input id="agentMaxRounds" type="number" min="1" max="50" step="1" style="' + SS + 'max-width:110px;" title="一次回复里模型最多可以「思考→调工具」多少个来回">'
      + '<span style="font-size:11px;color:var(--muted);">最大工具轮数(1~50,默认 8)</span></div>'
      // 4.70 本地能力:工作目录。**并进这张卡**而不是另开一张 ——
      // index.html 的注释写明 Agent 分类由本卡注入主要配置；多智能体编排 2026-10-08 起已拆走
      // （mountMultiAgentCard），因为"工作能力"与"编排玩法"是两件事，混在一张卡里互相干扰阅读。
      + '<div class="rowline" style="align-items:center;gap:10px;margin-top:12px;"><label style="font-size:12px;color:var(--muted);min-width:42px;">工作目录</label>'
      + '<input id="agentWorkdirPath" type="text" readonly style="' + SS + 'cursor:default;" placeholder="尚未设置">'
      + '<button id="agentWorkdirPick" style="padding:7px 12px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;cursor:pointer;white-space:nowrap;">选择…</button></div>'
      + '<div id="agentLocalStatus" style="font-size:11px;color:var(--muted);margin-top:6px;line-height:1.6;"></div>'
      + '<div id="agentToolsDesc" style="font-size:11px;color:var(--muted);margin-top:8px;line-height:1.6;"></div>'
      + '<div class="settings-tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg><span>文件工具(list/search/read/write/edit/delete/export)与联网工具(搜索 / 抓网页)由各自模块单独注册,<b>两档都有</b>,不受这里影响：先 search_file 定位、read_file 按行分页读(大文件不怕截断)、长文 fetch_page 可续读 —— 由模型按需灵活组合。改完<b>下一次开 Agent 生效</b>(当前正在跑的不变)。<br>轮数决定一次回复能跑多少来回:读写多个文件、多轮检索这类任务要调大;太小会在中途被"已达最大轮数"截断。</span></div>';
    slot.appendChild(card);
    var sel = card.querySelector('#agentToolsSel'), desc = card.querySelector('#agentToolsDesc');
    // 档位数**动态点数**（2026-10-08）：另一个会话加了 search_file / 分页读 / fetch 续读等新工具后，
    // 写死的「7 个 / 16 个」立刻过期。直接问注册表要数；数不出来就只写档名，不写假数字（缺东西要响）。
    function toolCount(profile) {
      try {
        var r = window.OwnChatTools && window.OwnChatTools.buildRegistry({ profile: profile });
        return (r && typeof r.list === "function") ? r.list().length : 0;
      } catch (e) { return 0; }
    }
    var nCore = toolCount('core'), nFull = toolCount('full');
    sel.innerHTML = '<option value="core">' + (nCore ? '常用（' + nCore + ' 个）' : '常用（默认）') + '</option>'
      + '<option value="full">' + (nFull ? '全量（' + nFull + ' 个）' : '全量') + '</option>';
    var TXT = {
      core: '给选项 / 载技能 / 角色卡增删改 / 发图 / 好感度 / 朗读，外加多智能体编排（分派 / 小会 / 请角色上台，见「多智能体编排」卡）。文件与联网工具两档都有。',
      full: '在常用基础上再加：设定集 / 指令模块 / 换主题 / 换模型 / 改设置 / 开编辑器 / 查费用 / 生成视频故事。其中视频故事一跑就是一两小时且不能关页 —— 只建议临时开。'
    };
    function render() { if (desc) desc.textContent = TXT[sel.value] || ''; }
    var v = 'core'; try { v = localStorage.getItem(K) === 'full' ? 'full' : 'core'; } catch (e) {}
    sel.value = v; render();
    sel.addEventListener('change', function () {
      try { if (sel.value === 'full') localStorage.setItem(K, 'full'); else localStorage.setItem(K, 'core'); } catch (e) {}
      render();
    });
    var wmEl = card.querySelector('#agentWorkMode'), wdEl = card.querySelector('#agentWorkDesc');
    var WORK_TXT = {
      confirm: '有副作用的工具(写文件、改角色卡/设定集/指令模块、改设置、换主题换模型等)执行前会弹确认,由你放行或拒绝。最安全,但会打断节奏。',
      auto: '文件类工具(写文件等)直接执行不打断;改设置/换模型这类影响全局的仍然确认。适合"我只想让它干活、别问太多"。',
      plan: 'Agent 只做只读调查(抓网页/搜索/读文件),**不会真的动手改**;先给你一份计划,你确认后再切到别的模式执行。',
      full: '所有工具直接执行、完全不确认。快,但写错就是写错了 —— 只在你完全信任当前任务时用。'
    };
    var WM_KEY = 'cfw_agent_work_mode_v1';
    function renderWork() { if (wdEl) wdEl.textContent = WORK_TXT[wmEl.value] || ''; }
    var wmv = 'confirm'; try { var _w = localStorage.getItem(WM_KEY); if (_w && WORK_TXT[_w]) wmv = _w; } catch (e) {}
    if (wmEl) {
      wmEl.value = wmv; renderWork();
      wmEl.addEventListener('change', function () {
        try { localStorage.setItem(WM_KEY, wmEl.value); } catch (e) {}
        renderWork();
      });
    }

    // 2026-09-14:最大工具轮数(原来写死 8)—— 复杂任务会被中途截断,这里放开可调
    var roundsEl = card.querySelector('#agentMaxRounds');
    if (roundsEl) {
      var RK = 'cfw_agent_max_rounds_v1';
      var cur = 8; try { cur = parseInt(localStorage.getItem(RK) || '8', 10) || 8; } catch (e) {}
      roundsEl.value = String((cur >= 1 && cur <= 50) ? cur : 8);
      roundsEl.addEventListener('change', function () {
        var v2 = parseInt(roundsEl.value, 10);
        if (!(v2 >= 1 && v2 <= 50)) v2 = 8;
        roundsEl.value = String(v2);
        try { localStorage.setItem(RK, String(v2)); } catch (e) {}
      });
    }

    // 多智能体编排的开关与上限 → 2026-10-08 已拆到独立卡（mountMultiAgentCard），见下方。
    // 这里保留一句提示：编排类工具是否注册由「多智能体模式 + 那张卡的开关」共同决定。

    // 4.70 本地能力:工作目录 + Node 运行时状态。同卡内的一块,不另开卡片。
    // 文案必须说清:命令类工具**不受工作目录限制**,工作目录只是 cwd ——
    // 否则用户会以为"选了目录 = 命令被关在里面"。
    var wdEl = card.querySelector('#agentWorkdirPath');
    var wdBtn = card.querySelector('#agentWorkdirPick');
    var wdSt = card.querySelector('#agentLocalStatus');
    var inv = (typeof window !== 'undefined' && window.__TAURI__ && window.__TAURI__.core)
      ? window.__TAURI__.core.invoke : null;
    if (!inv) {
      if (wdEl) wdEl.placeholder = '仅桌面端可用';
      if (wdBtn) { wdBtn.disabled = true; wdBtn.style.opacity = '0.5'; wdBtn.style.cursor = 'default'; }
      if (wdSt) wdSt.textContent = '网页版没有本地文件/命令能力,这部分在桌面 App 里生效。';
    } else {
      var refreshWd = function () {
        inv('local_env_info').then(function (i) {
          // 移动端(Tauri for Android/iOS)同样有 window.__TAURI__,所以不能只看它 ——
          // 用命令回传的真实平台判断,否则手机上会亮一个"能点但一点就报错"的按钮。
          var desktopOS = (i.platform === 'windows' || i.platform === 'macos' || i.platform === 'linux');
          if (!desktopOS) {
            if (wdEl) wdEl.placeholder = '移动端不支持';
            if (wdBtn) { wdBtn.disabled = true; wdBtn.style.opacity = '0.5'; wdBtn.style.cursor = 'default'; }
            if (wdSt) wdSt.textContent = '本地文件与命令能力仅桌面端提供;移动端 Agent 走虚拟工作区与联网工具。';
            return;
          }
          if (wdEl) wdEl.value = i.workdir || '';
          var parts = [];
          parts.push(i.workdir ? ('目录内 ' + (i.entries || 0) + ' 个条目。') : '未设置 —— 本地文件工具会拒绝所有操作。');
          if (i.node) {
            parts.push(i.node.ready
              ? ('Node ' + (i.node.source === 'system' ? '系统安装 ' : '自带 ') + (i.node.version || '') + '。')
              : 'Node 未找到(不影响已安装命令的执行)。');
          }
          parts.push('文件类工具限定在此目录内;命令类只以此为起始目录,不受限。');
          if (wdSt) wdSt.textContent = parts.join(' ');
        }).catch(function (e) {
          // 部署顺序会产生一个中间态:前端已 deploy、但用户的 exe 还是旧版。
          // 旧 exe 里没有这些命令,invoke 会报 "command not found" —— 那是版本问题,
          // 不是故障。照原样抛出去会让用户以为是 bug,所以识别一下给出可行动的提示。
          var msg = String((e && e.message) || e);
          var stale = /not found|not allowed|unknown command|command .* not/i.test(msg);
          if (wdSt) wdSt.textContent = stale
            ? '当前 App 版本还没有本地能力(需要 4.70+)。更新 App 后这里就能用。'
            : '读取状态失败: ' + msg;
        });
      };
      refreshWd();
      if (wdBtn) {
        wdBtn.addEventListener('click', function () {
          inv('agent_workdir_pick').then(function (dir) {
            if (!dir) return null;
            return inv('agent_workdir_set', { dir: dir });
          }).then(function () { refreshWd(); }).catch(function (e) {
            if (wdSt) wdSt.textContent = '设置失败: ' + ((e && e.message) || e);
          });
        });
      }
    }
  }

  // ─── 模型候选池(方案 C) · 从源站拉全量模型 → 勾几个进下拉 ───
  // 背景: 模型半年一个版本号,写死列表 = 每次都得改代码重部。现在:
  //   点「拉取模型列表」→ GET /api/models?mode=free|fast(key 在服务端,前端拿不到)
  //   → 勾选 → 存 LS cfw_models_free_v1 / cfw_models_fast_v1 → /config.js 里的覆盖脚本下次加载时刷进下拉。
  //   一个都不勾 = 回落内置兜底(厂商默认模型),不会出现空下拉。仅本设备。
  function mountModelPoolCard() {
    var slot = document.getElementById('setModelApiSlot') || document.getElementById('settings');
    if (!slot || document.getElementById('modelPoolCard')) return;
    var LSK = { free: 'cfw_models_free_v1', fast: 'cfw_models_fast_v1' };
    var SS = 'flex:1;padding:7px 9px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;';
    var card = document.createElement('div'); card.className = 'card'; card.id = 'modelPoolCard';
    card.innerHTML = '<h4>模型候选池(下拉里显示哪几个)</h4>'
      + '<p>从源站实时拉全量可用模型,勾几个放进顶栏下拉。模型出新版时<b>不用改代码</b>,回这里重拉一次勾上就行。一个不勾 = 自动回落内置默认模型。<b>仅本设备</b>。</p>'
      + '<div class="rowline" style="align-items:center;gap:10px;"><label style="font-size:12px;color:var(--muted);min-width:42px;">源</label><select id="mpMode" style="' + SS + '"><option value="free">免费 · NVIDIA NIM</option><option value="fast">快速 · DeepSeek 官方</option></select><div class="btns"><button class="smallbtn" id="mpFetch" type="button">拉取模型列表</button></div></div>'
      + '<div class="rowline" style="align-items:center;gap:10px;margin-top:8px;"><input id="mpSearch" type="text" placeholder="搜模型名(如 deepseek / glm / kimi)" style="' + SS + '"><div class="btns"><button class="smallbtn" id="mpNone" type="button">全不选</button></div></div>'
      + '<div id="mpList" style="margin-top:10px;max-height:38vh;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;display:flex;flex-direction:column;gap:4px;border:1px solid var(--border,#333);border-radius:8px;padding:8px;"></div>'
      + '<div class="rowline" style="margin-top:10px;"><div id="mpStatus" style="font-size:11px;color:var(--muted);flex:1;"></div><div class="btns"><button class="smallbtn" id="mpSave" type="button">保存到下拉</button><button class="smallbtn danger" id="mpClear" type="button">清空·回内置</button></div></div>'
      + '<div class="settings-tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg><span>保存后<b>刷新页面</b>下拉才会换。基座在「基座提示词」卡里选,与型号无关;新型号不用手配。自带 API 的直连在下面「自定义直连」卡,不受本卡影响。</span></div>';
    slot.appendChild(card);

    var modeEl = card.querySelector('#mpMode'), searchEl = card.querySelector('#mpSearch'), listEl = card.querySelector('#mpList'), statusEl = card.querySelector('#mpStatus');
    var all = [];      // 本次拉到的全量模型
    var chosen = {};   // id → {id,label}
    function setMsg(t) { if (statusEl) statusEl.textContent = t || ''; }
    function readPool(mode) {
      try { var a = JSON.parse(localStorage.getItem(LSK[mode]) || '[]'); return Array.isArray(a) ? a.filter(function (m) { return m && m.id; }) : []; } catch (e) { return []; }
    }
    function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    function render() {
      var kw = (searchEl.value || '').trim().toLowerCase();
      // 已勾的始终置顶且始终可见(即使本次没拉列表 / 源站已下线该型号)
      var ids = Object.keys(chosen);
      var rest = all.filter(function (m) { return !chosen[m.id]; });
      var rows = ids.map(function (id) { return chosen[id]; }).concat(rest)
        .filter(function (m) { return !kw || m.id.toLowerCase().indexOf(kw) >= 0; });
      if (!rows.length) { listEl.innerHTML = '<div style="font-size:12px;color:var(--muted);">' + (all.length ? '没有匹配的模型' : '还没拉取 —— 点右上「拉取模型列表」') + '</div>'; return; }
      listEl.innerHTML = rows.map(function (m) {
        var on = !!chosen[m.id];
        return '<label style="display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;padding:2px 0;">'
          + '<input type="checkbox" data-id="' + esc(m.id) + '"' + (on ? ' checked' : '') + '>'
          + '<span style="flex:1;word-break:break-all;">' + esc(m.id) + '</span>'
          + '</label>';
      }).join('');
    }
    function syncCount() { setMsg('当前勾中 ' + Object.keys(chosen).length + ' 个' + (all.length ? (' · 源站共 ' + all.length + ' 个可用') : '')); }
    function loadChosen() {
      chosen = {};
      // 2026-10-05: 不再带 persona 字段 —— 它原先只喂那个 P1/P2/P3 徽标(展示"这模型默认吃哪套底座"),
      // 而按模型自动选底座已退役,留着就是指错路。
      readPool(modeEl.value).forEach(function (m) { chosen[m.id] = { id: m.id, label: m.label || m.id }; });
    }
    listEl.addEventListener('change', function (e) {
      var cb = e.target;
      if (!cb || cb.type !== 'checkbox') return;
      var id = cb.getAttribute('data-id');
      if (cb.checked) {
        var meta = all.filter(function (m) { return m.id === id; })[0] || { id: id, label: (id.indexOf('/') >= 0 ? id.split('/').pop() : id) };
        chosen[id] = { id: id, label: meta.label || id };
      } else { delete chosen[id]; }
      syncCount();
    });
    searchEl.addEventListener('input', render);
    modeEl.addEventListener('change', function () { all = []; loadChosen(); render(); syncCount(); });
    card.querySelector('#mpNone').addEventListener('click', function () { chosen = {}; render(); syncCount(); });
    card.querySelector('#mpFetch').addEventListener('click', async function () {
      var btn = card.querySelector('#mpFetch'); btn.disabled = true; setMsg('拉取中…');
      try {
        var headers = {};
        try { var tk = window.__auth && window.__auth.getToken && window.__auth.getToken(); if (tk) headers.Authorization = 'Bearer ' + tk; } catch (e) {}
        var r = await fetch('/api/models?mode=' + encodeURIComponent(modeEl.value), { headers: headers });
        var d = await r.json();
        all = (d && Array.isArray(d.models)) ? d.models : [];
        render();
        if (d && d.ok) syncCount();
        else setMsg('源站没拉到(' + ((d && d.error) || r.status) + ') · 先列出内置兜底模型');
      } catch (e) { setMsg('拉取失败:' + ((e && e.message) || e)); }
      btn.disabled = false;
    });
    card.querySelector('#mpSave').addEventListener('click', function () {
      var list = Object.keys(chosen).map(function (id) { return chosen[id]; });
      try {
        if (list.length) localStorage.setItem(LSK[modeEl.value], JSON.stringify(list));
        else localStorage.removeItem(LSK[modeEl.value]);
      } catch (e) {}
      setMsg(list.length ? ('已保存 ' + list.length + ' 个 · 刷新页面后下拉生效') : '已清空 · 刷新后回内置默认模型');
    });
    card.querySelector('#mpClear').addEventListener('click', function () {
      try { localStorage.removeItem(LSK[modeEl.value]); } catch (e) {}
      chosen = {}; render(); setMsg('已清空本档候选池 · 刷新后回内置默认模型');
    });
    loadChosen(); render(); syncCount();
  }

  // ─── 4.83: 生成参数（temperature / max_tokens）───
  // 归「模型 API」分类。核心设计:**留空 = 不干预** —— 未填的字段根本不发给模型，
  // 由上游用自己的默认值。这样既不会因我们猜错默认值而让输出质量退化，
  // 也不会覆盖上游针对模型做的调校。
  // 落库 key 与 app.js 的 LS_GEN_PARAMS 一致；app.js 通过 genParamPayload() 展开进 /api/chat body
  // （worker 侧早就支持 temperature/top_p/max_tokens 透传，只是此前没有正式 UI 入口）。
  var GEN_PARAMS_KEY = 'cfw_gen_params_v1';
  function readGenParams() {
    try {
      var o = JSON.parse(localStorage.getItem(GEN_PARAMS_KEY) || '{}');
      return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
    } catch (e) { return {}; }
  }
  function writeGenParams(o) { try { localStorage.setItem(GEN_PARAMS_KEY, JSON.stringify(o || {})); } catch (e) {} }
  function mountGenParamsCard() {
    var slot = document.getElementById('setModelApiSlot');
    if (!slot || document.getElementById('genParamsCard')) return;
    var inp = 'style="width:110px;padding:6px 8px;border-radius:7px;border:1px solid var(--border,#2a2a2a);background:rgba(127,127,127,.08);color:inherit;font-size:13px;"';
    var row = 'style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;"';
    var card = document.createElement('div'); card.className = 'card'; card.id = 'genParamsCard';
    card.innerHTML = '<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h8M16 7h4M4 12h2M10 12h10M4 17h6M14 17h6"/><circle cx="14" cy="7" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="12" cy="17" r="2"/></svg>生成参数（Generation Params）</h4>'
      + '<p>微调模型的发挥风格。<b>留空 = 不干预</b>：该字段不会发给模型，由模型用自己的默认值 —— 不确定就别填。</p>'
      + '<div class="rowline" ' + row + '><label for="genTemp" style="font-size:12.5px;min-width:152px;">温度（temperature）</label><input id="genTemp" type="number" min="0" max="2" step="0.1" placeholder="默认" ' + inp + '><span style="font-size:11px;color:var(--muted);">越高越有创意，越低越稳</span></div>'
      + '<div class="rowline" ' + row + '><label for="genMax" style="font-size:12.5px;min-width:152px;">最长输出（max_tokens）</label><input id="genMax" type="number" min="1" step="256" placeholder="默认" ' + inp + '><span style="font-size:11px;color:var(--muted);">写长文 / 开思考时要留足</span></div>'
      + '<div class="rowline" ' + row + '><span style="font-size:12px;color:var(--muted);">快速预设：</span><button class="smallbtn" data-genpreset="rp" type="button">角色扮演</button><button class="smallbtn" data-genpreset="write" type="button">长文写作</button><button class="smallbtn" data-genpreset="code" type="button">编程 / 工具</button><button class="smallbtn danger" data-genpreset="reset" type="button">全部恢复默认</button></div>'
      + '<div class="settings-tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg><span>留空是推荐状态。开思考时 max_tokens 会被推理内容占用，设小了会出现正文被截断或空白 —— 写长文建议 8192。温度设 0 不等于更准，长对话会明显重复；若换模型后上游报错，回来清空或调低。</span></div>'
      + '<div class="settings-tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg><span><b>默认基准（"恢复默认"回到的就是这些）：</b>温度 1.0（0~2）· max_tokens 不传时 非思考 8K / 思考 64K（DeepSeek 官方文档；免费档 NIM 为 vLLM 系，温度默认同为 1.0）。注意：<b>思考模式下温度参数无效</b>，思考中的风格由模型自己决定。</span></div>';
    slot.appendChild(card);

    var tEl = card.querySelector('#genTemp');
    var mEl = card.querySelector('#genMax');
    function sync() {
      var g = readGenParams();
      tEl.value = (typeof g.temperature === 'number') ? g.temperature : '';
      mEl.value = (typeof g.maxTokens === 'number') ? g.maxTokens : '';
    }
    function save(syncBack) {
      var g = readGenParams();
      var t = parseFloat(tEl.value);
      var m = parseInt(mEl.value, 10);
      // 空值 = 删除该覆盖（回到"不干预"），而不是写 0
      if (tEl.value.trim() === '' || isNaN(t)) delete g.temperature;
      else g.temperature = Math.max(0, Math.min(2, t));
      if (mEl.value.trim() === '' || isNaN(m)) delete g.maxTokens;
      else g.maxTokens = Math.max(1, Math.floor(m));
      writeGenParams(g);
      if (syncBack) sync();
    }
    // input:即时落库 —— 用户清空输入框就立刻回到"默认",不依赖失焦。
    //   (实测 number 输入框的 change 在清空/全选删除时不一定触发,靠它会让"恢复默认"时灵时不灵)
    //   此时**不回写输入框**,否则会打断正在输入的内容与光标位置。
    // change:失焦时补一次并回写规范化后的值,让越界输入(如温度填 5)被 clamp 后能看到真实生效值。
    tEl.addEventListener('input', function () { save(false); });
    mEl.addEventListener('input', function () { save(false); });
    tEl.addEventListener('change', function () { save(true); });
    mEl.addEventListener('change', function () { save(true); });
    var PRESETS = {
      rp:    { temperature: 1.2 },                    // 角色扮演:偏创意,避免长对话重复
      write: { temperature: 1.4, maxTokens: 8192 },   // 长文写作:更放 + 输出上限留足
      code:  { temperature: 0.3 },                    // 编程 / 工具调用:求稳,参数填报更准
    };
    card.querySelectorAll('[data-genpreset]').forEach(function (b) {
      b.addEventListener('click', function () {
        var k = b.dataset.genpreset;
        if (k === 'reset') { writeGenParams({}); sync(); return; }
        if (PRESETS[k]) { writeGenParams(Object.assign({}, PRESETS[k])); sync(); }
      });
    });
    sync();
  }

  // ─── §外观. App 壳特效档位（2026-10-07 新增，E-B；2026-10-08 文案修正）───
  // 壳内（含桌面壳 —— 桌面壳也是 ?shell=android，见 tauri.conf.json）默认「流畅优先」：
  // index.html 里 html.android-app:not(.fx-rich) 那组覆盖关掉了毛玻璃 / 全屏混合层 / 常驻动画
  // （拖动卡顿的主因），并且在低特效档停掉 --pulse 的定时重算。勾选 = 加回 .fx-rich。
  // 注意：气泡级的毛玻璃与 ::after 流光**所有档位都关**（成本随消息数线性增长），这里换不回来。
  function mountAppFxCard() {
    if (!document.documentElement.classList.contains('android-app')) return;
    var slot = document.getElementById('setAppearanceThemeSlot') || document.getElementById('setAppearanceTopSlot');
    if (!slot || document.getElementById('appFxCard')) return;
    var card = document.createElement('div'); card.className = 'card'; card.id = 'appFxCard';
    card.innerHTML = '<h4>App 内特效档位</h4>'
      + '<p>App 壳内<b>默认「流畅优先」</b>：关闭毛玻璃模糊、全屏混合层、常驻动画与背景光晕律动，拖动/滚动更跟手、更省电。勾选可换回玻璃 / 烛光的完整观感（代价是耗电与可能的卡顿）。<br>气泡级的磨砂与流光已<b>永久关闭</b>（成本随消息条数增长），不再随本开关恢复。</p>'
      + '<div class="rowline"><div class="toggle"><input type="checkbox" id="appFxRichToggle"><label for="appFxRichToggle">完整特效（更耗电 / 可能卡顿）</label></div></div>'
      + '<h4 style="margin-top:12px;">内存</h4>'
      + '<p>壳长时间挂在后台后，页面会持住大量缓存内存（与特效档位关系不大）。开启后：<b>窗口在后台超过 10 分钟</b>且没有发送中/待批/草稿时，自动刷新页面释放内存 —— 聊天记录已落盘，不受影响。</p>'
      + '<div class="rowline"><div class="toggle"><input type="checkbox" id="appMemIdleToggle"><label for="appMemIdleToggle">空闲自动释放内存</label></div></div>';
    slot.appendChild(card);
    var t = card.querySelector('#appFxRichToggle');
    t.checked = localStorage.getItem('cfw_app_fx_rich_v1') === '1';
    t.addEventListener('change', function () {
      localStorage.setItem('cfw_app_fx_rich_v1', t.checked ? '1' : '0');
      document.documentElement.classList.toggle('fx-rich', t.checked);
    });
    var m = card.querySelector('#appMemIdleToggle');
    // 缺省开（壳是长跑场景）：未显式设置过时显示为勾选，切换才写值
    m.checked = localStorage.getItem('cfw_mem_idle_release_v1') !== '0';
    m.addEventListener('change', function () {
      localStorage.setItem('cfw_mem_idle_release_v1', m.checked ? '1' : '0');
    });
  }

  // ─── §外观. 界面语言（2026-10-07 新增，双语插件）───
  // 双语是「插件脚本」实现：/shared/i18n.js 引擎 + /shared/i18n-dict.js 字典（启用英文才懒加载，
  // 中文用户零开销）。按已渲染文本整串替换，模型输出/用户内容不在翻译范围；覆盖主路径，
  // 未覆盖的仍显示中文（可增量补字典，`node scripts/check-i18n.mjs` 审计缺口）。切换会整页刷新。
  function mountI18nCard() {
    var slot = document.getElementById('setAppearanceThemeSlot') || document.getElementById('setAppearanceTopSlot');
    if (!slot || document.getElementById('i18nCard')) return;
    var card = document.createElement('div'); card.className = 'card'; card.id = 'i18nCard';
    card.innerHTML = '<h4>界面语言 / Language</h4>'
      + '<p>英文界面是<b>运行时翻译插件</b>（beta）：按字典把界面文案替换成英文 —— 模型输出、消息内容、角色名不会被翻译。已覆盖主路径；个别未覆盖的文案仍显示中文，可增量补字典。切换语言会刷新页面。</p>'
      + '<div class="rowline"><div class="toggle"><input type="checkbox" id="i18nEnToggle"><label for="i18nEnToggle">English UI（beta，部分文案未覆盖）</label></div></div>';
    slot.appendChild(card);
    var t = card.querySelector('#i18nEnToggle');
    t.checked = localStorage.getItem('cfw_ui_lang_v1') === 'en';
    t.addEventListener('change', function () {
      localStorage.setItem('cfw_ui_lang_v1', t.checked ? 'en' : 'zh');
      location.reload();
    });
  }

  function mountStaticSettingsCards() {
    mountAuthCard();
    mountLocalHistoryCard(); // 常用:放账号页第一屏
    mountSyncCard();
    mountTopbarCostCard();
    mountThemeCard();
    mountAmbientCard();   // 氛围音双轨混音器（环境×音乐），全主题可用
    mountBackgroundCard(); // 2026-10-06: 背景图从编辑器 UI 页搬来（外观分类）
    mountMobileAppLayoutCard();
    mountDisplayCard();      // 字号/字体属于外观
    mountAppFxCard();        // 2026-10-07 (E-B): App 壳内特效档位（仅壳内出现）
    mountI18nCard();         // 2026-10-07: 界面语言（双语插件开关）
    mountStateLayerCard();  // 角色状态层开关(有卡就注入的把手)
    mountWebSearchCard();   // 2026-10-07: 联网搜索（Worker 代查 + Exa 可选）
    mountBaseIdCard();       // 基座:放「对话」首卡 —— 它影响一切,理应最上面
    mountChatModeCard();
    mountAutopilotCard();
    mountAgentToolsCard();
    mountMultiAgentCard();   // 2026-10-08 独立成卡（编排玩法与工作能力分开）
    mountPersonaCard();      // M1
    mountModelPoolCard(); // 2026-09-10 (方案 C): 模型候选池,放在自定义直连之前
    mountByoCard(); // 2026-06-24: 聊天模型自定义直连归「模型 API」分类(原在「对话」)
    mountCustomPricingCard(); // 2026-09-12 / 4.70: 自定义模型定价 UI,写 cfw_custom_pricing_v1(已进云同步白名单)
    mountGenParamsCard(); // 4.83: 生成参数(temperature / max_tokens),留空=不干预(app.js genParamPayload 展开)
  }

  // ─── 1. 分类标签切换 ───
  const LS_CAT = 'cfw_settings_cat_v1';
  function initCatNav() {
    const nav = document.querySelector('.settings-cat-nav');
    if (!nav) return;
    const items = Array.from(nav.querySelectorAll('.scn-item'));
    const cats  = Array.from(document.querySelectorAll('.set-cat'));
    const devOn = localStorage.getItem('cfw_dev_mode_v1') === '1';
    const isApp = !!(window.__TAURI__ || window.__TAURI_INTERNALS__);
    items.forEach(it => {
      if (it.dataset.devOnly && !devOn) it.style.display = 'none';
      if (it.dataset.cat === 'voice' && !isApp) it.style.display = 'none';
    });
    function switchTo(cat) {
      items.forEach(it => it.classList.toggle('active', it.dataset.cat === cat));
      cats.forEach(c  => c.classList.toggle('active',  c.dataset.cat  === cat));
      localStorage.setItem(LS_CAT, cat);
    }
    const saved = localStorage.getItem(LS_CAT);
    const validItem = items.find(it => it.dataset.cat === saved && it.style.display !== 'none');
    const firstVisible = items.find(it => it.style.display !== 'none') || items[0];
    switchTo(validItem ? saved : (firstVisible && firstVisible.dataset.cat || 'account'));
    items.forEach(it => it.addEventListener('click', () => switchTo(it.dataset.cat)));
  }

  // ─── 2. 面板开关 ───
  function initPanelToggle() {
    const settingsBtn    = document.getElementById('settingsBtn');
    const settingsMask   = document.getElementById('settingsMask');
    const closeSettingsBtn = document.getElementById('closeSettings');
    const historyKeepEl  = document.getElementById('historyKeep');
    const promptKeepEl   = document.getElementById('promptKeep');
    const customPromptEl = document.getElementById('customPrompt');
    const LS_HISTORY     = 'cfw_history_enabled';
    const LS_PROMPT      = 'cfw_prompt_enabled';
    const LS_CUSTOM      = 'cfw_custom_prompt_v1';

    function openPanel() {
      if (!settingsMask) return;
      // 2026-10-09: 手机端抽屉(z20) > 设置遮罩(z10) —— 抽屉开着时从它上方点齿轮,
      // 面板会开在抽屉底下,看起来"没反应"。开面板前先收抽屉。
      try { document.body.classList.remove('drawer-open'); } catch (e) {}
      settingsMask.style.display = 'flex';
      mountImageCards();
      mountVoiceCards(); // 4.71
      if (historyKeepEl)  historyKeepEl.checked  = localStorage.getItem(LS_HISTORY) === '1';
      if (promptKeepEl)   promptKeepEl.checked   = (localStorage.getItem(LS_PROMPT) ?? '1') === '1';
      if (customPromptEl) customPromptEl.value   = localStorage.getItem(LS_CUSTOM) || '';
      try { if (window.__settingsRefreshAuth) window.__settingsRefreshAuth(); } catch(e) {}
      try { if (window.__settingsRefreshSync) window.__settingsRefreshSync(); } catch(e) {}
    }

    if (settingsBtn)      settingsBtn.addEventListener('click', openPanel);
    if (closeSettingsBtn) closeSettingsBtn.addEventListener('click', () => {
      if (settingsMask) settingsMask.style.display = 'none';
    });
    if (settingsMask) settingsMask.addEventListener('click', e => {
      if (e.target === settingsMask) settingsMask.style.display = 'none';
    });
  }

  // ─── 2.9 角色状态层开关(2026-10-05) ───
  // 与 app.js 的 stateLayerPayload() 同一个键:关掉才发 payload.stateLayer=false(缺省=开)。
  function initStateLayerToggle() {
    const el = document.getElementById('stateLayerToggle');
    if (!el) return;
    el.checked = localStorage.getItem('cfw_state_layer_v1') !== '0';
    el.addEventListener('change', () => {
      localStorage.setItem('cfw_state_layer_v1', el.checked ? '1' : '0');
    });
  }

  // ─── 3. 顶栏组件开关 ───
  function initTopbarToggles() {
    const html = document.documentElement;
    const t = document.getElementById('showTopbarCostToggle');
    if (!t) return;
    const on = localStorage.getItem('cfw_show_topbar_cost_v1') !== '0';
    t.checked = on;
    html.classList.toggle('hide-topbar-cost', !on);
    t.addEventListener('change', () => {
      localStorage.setItem('cfw_show_topbar_cost_v1', t.checked ? '1' : '0');
      html.classList.toggle('hide-topbar-cost', !t.checked);
    });
  }

  // ─── 4. 对话个性化 toggles / selects ───
  function initChatToggles() {
    const html = document.documentElement;
    const hideMsgEl = document.getElementById('hideMsgActionsToggle');
    if (hideMsgEl) {
      hideMsgEl.checked = localStorage.getItem('cfw_hide_msg_actions_v1') === '1';
      hideMsgEl.addEventListener('change', () => {
        localStorage.setItem('cfw_hide_msg_actions_v1', hideMsgEl.checked ? '1' : '0');
        html.classList.toggle('hide-msg-actions', hideMsgEl.checked);
      });
    }
    const hideStEl = document.getElementById('hideStatsToggle');
    if (hideStEl) {
      hideStEl.checked = localStorage.getItem('cfw_hide_stats_v1') === '1';
      hideStEl.addEventListener('change', () => {
        localStorage.setItem('cfw_hide_stats_v1', hideStEl.checked ? '1' : '0');
        html.classList.toggle('hide-stats', hideStEl.checked);
      });
    }
    //   · 原四档单选配上 theme.js 的自动覆写 = 「选了没用 + 刷新就回弹」,这次一并拔除;
    //   · 严格角色扮演(cfw_strict_roleplay_v1)与强制顺从(cfw_dev_force_comply_v1)两个键已彻底作废（2026-10-05 删掉对应提示词层）。
    const replyStyleEl = document.getElementById('replyStyleSel');
    if (replyStyleEl) {
      replyStyleEl.value = localStorage.getItem('cfw_reply_style_v1') || 'default';
      replyStyleEl.addEventListener('change', () => {
        localStorage.setItem('cfw_reply_style_v1', replyStyleEl.value);
      });
    }
    const fontSizeEl = document.getElementById('chatFontSizeRange');
    const fontSizeLb = document.getElementById('chatFontSizeLabel');
    if (fontSizeEl) {
      let fs = parseInt(localStorage.getItem('cfw_chat_font_size_v1') || '13', 10);
      if (!(fs >= 12 && fs <= 22)) fs = 13;
      fontSizeEl.value = String(fs);
      if (fontSizeLb) fontSizeLb.textContent = fs + 'px';
      // range 滑块用 input 事件实时反馈 + 同步 label(原 index.html 显示设置卡内联迁入)
      fontSizeEl.addEventListener('input', () => {
        const v = parseInt(fontSizeEl.value, 10) || 13;
        if (fontSizeLb) fontSizeLb.textContent = v + 'px';
        html.style.setProperty('--chat-font-size', v + 'px');
        localStorage.setItem('cfw_chat_font_size_v1', String(v));
      });
    }
    const fontFamilyEl = document.getElementById('chatFontFamilySel');
    if (fontFamilyEl) {
      fontFamilyEl.value = localStorage.getItem('cfw_chat_font_family_v1') || '';
      fontFamilyEl.addEventListener('change', () => {
        const v = fontFamilyEl.value || '';
        localStorage.setItem('cfw_chat_font_family_v1', v);
        if (v) document.documentElement.style.setProperty('--chat-font-family', v);
        else   document.documentElement.style.removeProperty('--chat-font-family');
      });
    }
  }

  // ─── 5. 同步聊天历史 toggle ───
  // 2026-10-07: 初值从 __sync.includeChat() 读（"默认开"的口径只在 sync.js 一处），
  // 打开时立刻 pull→push 一轮并给可见反馈 —— 旧版只写 LS，用户勾了看不到任何动静。
  function initSyncChatToggle() {
    const t = document.getElementById('syncIncludeChatToggle');
    if (!t) return;
    const st = (window.__sync && window.__sync.getStatus && window.__sync.getStatus()) || {};
    t.checked = !!st.includeChat;
    t.addEventListener('change', async () => {
      if (window.__sync && window.__sync.setIncludeChat) window.__sync.setIncludeChat(t.checked);
      else localStorage.setItem('cfw_sync_include_chat_v1', t.checked ? '1' : '0');
      if (!t.checked) return;
      const el = document.getElementById('syncStatus');
      const say = (s) => { if (el) el.textContent = s; };
      say('正在拉取云端对话…');
      try {
        const r = await window.__sync.pullChatNow();
        if (r && r.skipped) { say(r.skipped === 'sync-off' ? '请先打开上面的「启用云同步」并输入密码，对话才能同步' : '对话同步未生效'); return; }
        if (r && r.error) { say('拉取云端对话失败：' + r.error); return; }
        say('已拉取云端对话，正在上传本机对话…');
        const p = await window.__sync.pushChatNow();
        say(p && p.ok ? ('对话同步已开启，已上传 ' + (p.slots || 0) + ' 条会话') : '对话同步已开启（本机暂无会话可上传）');
      } catch (e) { say('对话同步失败：' + ((e && e.message) || e)); }
    });
  }

  // ─── 6. 清空云端按钮 ───
  function initSyncWipeBtn() {
    const wb = document.getElementById('syncWipeBtn');
    if (!wb) return;
    wb.addEventListener('click', async () => {
      const sync = window.__sync;
      if (!sync || typeof sync.wipeCloud !== 'function') { alert('云同步模块未就绪'); return; }
      const st = (sync.getStatus && sync.getStatus()) || {};
      if (!st.enabled || !st.hasToken) { alert('请先启用云同步(需密码)再清空云端'); return; }
      if (!confirm('确定清空云端的全部数据吗?\n\n删除：角色卡/指令模块/亲密度/费用/对话历史的【云端副本】\n保留：本设备本地数据全部不动\n注意：同步仍开启时,下次本地改动会把本地重新上传。想让云端保持空,请清空后关闭云同步。')) return;
      const old = wb.textContent; wb.disabled = true; wb.textContent = '清空中…';
      try {
        await sync.wipeCloud();
        wb.textContent = '已清空';
        const s = document.getElementById('syncStatus');
        if (s) s.textContent = '云端已清空 · ' + new Date().toLocaleTimeString();
        setTimeout(() => { wb.textContent = old; wb.disabled = false; }, 2000);
      } catch (e) {
        wb.textContent = old; wb.disabled = false;
        alert('清空云端失败:' + (e && e.message || e));
      }
    });
  }

  // ─── 7. KV 配额告警 + cloudExcludeSection ───
  function initCloudExcludeSection() {
    function wireWarn() {
      if (!window.__sync || !window.__sync.onStatus) { setTimeout(wireWarn, 500); return; }
      window.__sync.onStatus((s, d) => {
        if (s !== 'warn' || !d || d.reason !== 'kv-quota') return;
        const w = document.getElementById('syncQuotaWarn');
        if (w) { w.style.display = 'block'; w.textContent = '今日已 push ' + d.count + ' 次到 KV (免费层 1000/日上限),可点顶栏暂停同步避免超额'; }
      });
    }
    wireWarn();
    const listEl = document.getElementById('cloudExcludeList');
    if (!listEl) return;
    function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    function cards() { try { return (window.__character && window.__character.listAllCards) ? (window.__character.listAllCards() || []) : []; } catch(e) { return []; } }
    function slots() { try { const raw = localStorage.getItem('cfw_chat_session_v1'); if (!raw) return []; const m = JSON.parse(raw); return (m && typeof m === 'object' && !Array.isArray(m)) ? Object.keys(m) : []; } catch(e) { return []; } }
    function excluded() { try { return (window.__sync && window.__sync.getExcluded) ? window.__sync.getExcluded() : { roles: [], sessions: [] }; } catch(e) { return { roles: [], sessions: [] }; } }
    function nameOf(id, cs) { if (id === '__none__') return '（未选角色）'; const c = cs.filter(x => x.id === id)[0]; return c ? ((c.icon ? c.icon + ' ' : '') + c.name) : id; }
    function rowHtml(kind, id, label, isEx) {
      const btn = isEx
        ? `<button class="smallbtn" data-act="restore" data-kind="${kind}" data-id="${esc(id)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 7L4 12l5 5"/><path d="M4 12h10a6 6 0 0 1 6 6"/></svg>恢复同步</button>`
        : `<button class="smallbtn danger" data-act="wipe" data-kind="${kind}" data-id="${esc(id)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 6.5h15"/><path d="M9 6.5V5.2A1.7 1.7 0 0 1 10.7 3.5h2.6A1.7 1.7 0 0 1 15 5.2V6.5"/><path d="M6.8 6.5l.7 12.2a1.8 1.8 0 0 0 1.8 1.7h5.4a1.8 1.8 0 0 0 1.8-1.7l.7-12.2"/></svg>仅清云端</button>`;
      const tag = kind === 'session' ? '[会话]' : '[角色]';
      return `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;${isEx ? 'opacity:.65;' : ''}"><span>${isEx ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true" style="width:12px;height:12px;vertical-align:-1px;margin-right:3px;opacity:.7"><circle cx="12" cy="12" r="8"/><path d="M6.5 6.5l11 11"/></svg>' : ''}<b style="color:var(--muted);">${tag}</b> ${esc(label)}</span>${btn}</div>`;
    }
    function render() {
      const cs = cards(), ex = excluded(), sl = slots();
      let html = '';
      html += '<div style="font-size:11px;color:var(--muted);margin-top:4px;">角色卡</div>';
      if (!cs.length) html += '<div style="font-size:11px;color:var(--muted);">（无角色卡）</div>';
      cs.forEach(c => { html += rowHtml('role', c.id, (c.icon ? c.icon + ' ' : '') + c.name, ex.roles.indexOf(c.id) >= 0); });
      ex.roles.forEach(id => { if (!cs.filter(x => x.id === id)[0]) html += rowHtml('role', id, id + '（本地已无）', true); });
      html += '<div style="font-size:11px;color:var(--muted);margin-top:8px;">对话会话槽</div>';
      if (!sl.length) html += '<div style="font-size:11px;color:var(--muted);">（无本地会话槽）</div>';
      sl.forEach(k => { html += rowHtml('session', k, nameOf(k, cs), ex.sessions.indexOf(k) >= 0); });
      ex.sessions.forEach(k => { if (sl.indexOf(k) < 0) html += rowHtml('session', k, nameOf(k, cs) + '（本地已无）', true); });
      listEl.innerHTML = html;
    }
    listEl.addEventListener('click', async e => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      const sync = window.__sync;
      if (!sync || !sync.wipeCloudEntity) { alert('云同步模块未就绪'); return; }
      const st = (sync.getStatus && sync.getStatus()) || {};
      if (!st.enabled || !st.hasToken) { alert('请先启用云同步(需密码)'); return; }
      const act = b.getAttribute('data-act'), kind = b.getAttribute('data-kind'), id = b.getAttribute('data-id');
      const old = b.textContent; b.disabled = true; b.textContent = '处理中…';
      try {
        if (act === 'wipe') {
          if (!confirm('确定只把这一' + (kind === 'session' ? '个会话' : '个角色') + '从云端清除吗?\n本地保留,且本设备不再上传它。')) { b.disabled = false; b.textContent = old; return; }
          await sync.wipeCloudEntity(kind, id);
        } else { await sync.restoreCloudEntity(kind, id); }
        render();
      } catch(err) { b.disabled = false; b.textContent = old; alert('操作失败:' + (err && err.message || err)); }
    });
    const sb  = document.getElementById('settingsBtn');
    if (sb)  sb.addEventListener('click', () => setTimeout(render, 50));
    const sec = document.getElementById('cloudExcludeSection');
    if (sec) sec.addEventListener('toggle', () => { if (sec.open) render(); });
  }

  // ─── 8. 云同步 + Auth UI ───
  function setupSyncAuthUI() {
    const syncEnableToggle  = document.getElementById('syncEnableToggle');
    const syncNowBtn        = document.getElementById('syncNowBtn');
    const syncExportBtn     = document.getElementById('syncExportBtn');
    const syncImportBtn     = document.getElementById('syncImportBtn');
    const syncImportFile    = document.getElementById('syncImportFile');
    const syncStatusEl      = document.getElementById('syncStatus');
    const chatProtectToggle = document.getElementById('chatProtectToggle');
    const authLogoutBtn     = document.getElementById('authLogoutBtn');
    const authStatusEl      = document.getElementById('authStatus');
    if (!syncEnableToggle || !chatProtectToggle) return;

    function fmtTime(ms) {
      if (!ms) return '—';
      try { return new Date(ms).toLocaleString('zh-CN', { hour12: false }); } catch { return String(ms); }
    }
    function refreshAuthUI() {
      if (!window.__auth) return;
      const hasToken = !!window.__auth.getToken();
      chatProtectToggle.checked = window.__auth.chatProtectOn();
      if (authStatusEl) authStatusEl.textContent = hasToken
        ? '已登录（密码 token 保存在本地）'
        : '未登录（启用聊天保护或云同步时会弹密码框）';
      if (authLogoutBtn) authLogoutBtn.disabled = !hasToken;
    }
    function refreshSyncUI() {
      if (!window.__sync) return;
      const s = window.__sync.getStatus();
      syncEnableToggle.checked = s.enabled;
      const parts = [s.enabled ? '已启用' : '未启用'];
      if (s.lastPush) parts.push('上次推送 ' + fmtTime(s.lastPush));
      if (syncStatusEl) syncStatusEl.textContent = parts.join('，');
    }

    window.__settingsRefreshAuth = refreshAuthUI;
    window.__settingsRefreshSync = refreshSyncUI;

    if (window.__sync) {
      window.__sync.onStatus((st, detail) => {
        if (!syncStatusEl) return;
        if (st === 'syncing') syncStatusEl.textContent = '同步中…';
        else if (st === 'synced') {
          const size = detail && detail.size ? ` (${(detail.size / 1024).toFixed(1)}KB)` : '';
          syncStatusEl.textContent = '同步完成 ' + fmtTime(Date.now()) + size;
        } else if (st === 'restored') {
          syncStatusEl.textContent = '已从云端还原，即将刷新页面…';
        } else if (st === 'error') {
          syncStatusEl.textContent = '错误：' + (detail && detail.message || '同步失败');
        }
      });
    }

    syncEnableToggle.addEventListener('change', async () => {
      if (!window.__sync || !window.__auth) return;
      if (syncEnableToggle.checked) {
        if (!window.__auth.getToken()) {
          try {
            const pw = await window.__auth.promptForPassword({
              title: '启用云同步',
              hint: '输入 Cloudflare Secret <code>CHAT_PASSWORD</code> 的值。密码会保存在本地浏览器，下次自动登录。',
            });
            window.__auth.setToken(pw);
          } catch { syncEnableToggle.checked = false; return; }
        }
        window.__sync.setSyncEnabled(true);
        refreshAuthUI(); refreshSyncUI();
        window.__sync.pullOnStartup();
      } else {
        window.__sync.setSyncEnabled(false);
        refreshSyncUI();
      }
    });

    syncNowBtn.addEventListener('click', async () => {
      // 4.75 立即同步反馈修复:原版点了无任何按钮级反馈(只往 #syncStatus 写一行小字),看着像"没反应"。
      // 现加:未登录直接提示 + 按钮态 同步中…/✓ 已同步/同步失败,与"清空云端"按钮一致。
      if (!window.__sync) { alert('云同步模块未就绪'); return; }
      var st = (window.__sync.getStatus && window.__sync.getStatus()) || {};
      if (!st.hasToken) { alert('请先在上方打开「启用云同步」并输入密码,再点立即同步'); return; }
      var _old = syncNowBtn.innerHTML;
      syncNowBtn.disabled = true;
      syncNowBtn.textContent = '同步中…';
      try {
        await window.__sync.pushNow();
        // 4.78: 立即同步同时补推独立通道(pushNow 只推 main blob;聊天走 /sync/chat、角色卡走 /sync/chars,否则手动点立即同步不会立刻推这两类,得等各自 30s 自动推)
        const _chat = window.__sync.pushChatNow ? await window.__sync.pushChatNow() : null;
        if (window.__sync.pushCharsNow) await window.__sync.pushCharsNow();
        // 2026-10-07: 如实回报 —— 对话通道没开/没推成时必须说清楚,不再一律"✓ 已同步"(那条假成功让"什么都没同步"看起来像成功了)
        const _when = new Date().toLocaleString('zh-CN', { hour12: false });
        if (_chat && _chat.skipped === 'chat-off') {
          syncNowBtn.textContent = '✓ 已同步(不含对话)';
          if (syncStatusEl) syncStatusEl.textContent = '对话历史未同步:勾选上方「同步聊天历史」后,对话才会跨设备共享，' + _when;
        } else if (_chat && _chat.skipped === 'sync-off') {
          syncNowBtn.textContent = '✓ 已同步(不含对话)';
          if (syncStatusEl) syncStatusEl.textContent = '未启用云同步/缺密码:对话未同步，' + _when;
        } else if (_chat && _chat.error) {
          syncNowBtn.textContent = '部分失败';
          if (syncStatusEl) syncStatusEl.textContent = '其余数据已同步,对话同步失败:' + _chat.error + '，' + _when;
        } else {
          syncNowBtn.textContent = '✓ 已同步';
          if (syncStatusEl) syncStatusEl.textContent = '同步完成(含对话 ' + ((_chat && _chat.slots) || 0) + ' 条会话)，' + _when;
        }
      } catch (e) {
        syncNowBtn.textContent = '同步失败';
        alert('同步失败: ' + (e && e.message || e));
      } finally {
        setTimeout(function () { syncNowBtn.innerHTML = _old; syncNowBtn.disabled = false; }, 1800);
      }
    });
    if (syncExportBtn) syncExportBtn.addEventListener('click', async () => {
      if (!window.__sync) return;
      try { await window.__sync.exportJSON(); } catch (e) { alert('导出失败: ' + e.message); }
    });
    if (syncImportBtn) syncImportBtn.addEventListener('click', () => { syncImportFile && syncImportFile.click(); });
    if (syncImportFile) syncImportFile.addEventListener('change', async e => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      if (!confirm('导入将覆盖本地所有数据（角色卡 / 历史 / 指令模块 / 费用日志）。确认？')) { syncImportFile.value = ''; return; }
      try {
        await window.__sync.importJSON(file);
        alert('导入成功，即将刷新页面…');
        setTimeout(() => location.reload(), 400);
      } catch (err) { alert('导入失败: ' + err.message); }
      syncImportFile.value = '';
    });

    chatProtectToggle.addEventListener('change', async () => {
      if (!window.__auth) return;
      if (chatProtectToggle.checked) {
        if (!window.__auth.getToken()) {
          try {
            const pw = await window.__auth.promptForPassword({
              title: '启用聊天密码保护',
              hint: '输入 Cloudflare Secret <code>CHAT_PASSWORD</code> 的值。',
            });
            window.__auth.setToken(pw);
          } catch { chatProtectToggle.checked = false; return; }
        }
        window.__auth.setChatProtect(true);
      } else {
        window.__auth.setChatProtect(false);
      }
      refreshAuthUI();
    });

    if (authLogoutBtn) authLogoutBtn.addEventListener('click', () => {
      if (!window.__auth) return;
      if (!confirm('退出登录会清除本地保存的密码 token，并关闭云同步和聊天保护。确认？')) return;
      window.__auth.clearToken();
      window.__auth.setChatProtect(false);
      if (window.__sync) window.__sync.setSyncEnabled(false);
      refreshAuthUI(); refreshSyncUI();
    });
  }

  // ─── 9. 思考过程显示下拉 ───
  // 2026-10-05: 宿主改成「外观 · 显示设置」卡(它和字号/字体同属"聊天区怎么呈现")。
  // 旧实现靠 #historyKeep 反查宿主,而那张卡(本地对话记忆)后来挪进了「账号」类目 ——
  // 这一行就跟着寄生到与它毫无关系的分类里(用户实测反馈)。宿主判定改为:显示设置卡 > #historyKeep > #customPrompt,
  // 回落链保留只为老页面(缺显示设置卡时仍能显示,不会整行消失)。
  function setupThinkDisplaySetting() {
    if (document.getElementById('thinkDisplaySel')) return;
    const fontEl = document.getElementById('chatFontSizeRange');
    const displayCard = (fontEl && fontEl.closest) ? fontEl.closest('.card') : null;
    const displayTip  = displayCard ? displayCard.querySelector('.settings-tip') : null;
    const historyKeepEl  = document.getElementById('historyKeep');
    const customPromptEl = document.getElementById('customPrompt');
    const anchor = (historyKeepEl && (historyKeepEl.closest('label') || historyKeepEl.parentElement)) || null;
    const legacyHost = (anchor && anchor.parentNode) || (customPromptEl && customPromptEl.parentNode);
    const host = displayCard || legacyHost;
    if (!host) return;
    const wrap = document.createElement('div');
    // 2026-10-04: 独立成行(复用 .rowline 的分隔线/换行兜底),不再作为设置行的第三个 flex 项 ——
    // 它和长标签、清空按钮同排抢宽时,窄宽度下「思考过程显示」会被挤成每行一两个字的竖排。
    wrap.className = 'setting-row think-display-row rowline';
    wrap.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:14px;';
    const label = document.createElement('span');
    label.textContent = '思考过程显示';
    label.style.whiteSpace = 'nowrap';
    label.title = '思考模式下模型产生的思考内容如何呈现';
    const sel = document.createElement('select');
    sel.id = 'thinkDisplaySel';
    sel.style.cssText = 'padding:4px 8px;border-radius:6px;';
    [['collapse', '折叠(默认)'], ['show', '展开'], ['hide', '隐藏']].forEach(([v, t]) => {
      const o = document.createElement('option');
      o.value = v; o.textContent = t;
      sel.appendChild(o);
    });
    function getVal() {
      const v = localStorage.getItem('cfw_think_display_v1');
      return (v === 'show' || v === 'hide') ? v : 'collapse';
    }
    sel.value = getVal();
    sel.addEventListener('change', () => {
      localStorage.setItem('cfw_think_display_v1', sel.value);
      if (window.__app && window.__app.applyAllThinkDisplay) {
        window.__app.applyAllThinkDisplay();
      } else {
        document.querySelectorAll('.reasoning-block').forEach(el => {
          try { if (window.__app && window.__app.applyThinkDisplay) window.__app.applyThinkDisplay(el); } catch(e) {}
        });
      }
    });
    wrap.appendChild(label);
    wrap.appendChild(sel);
    // 落点:显示设置卡里插到 tip 之前(即控件区末尾,排在字号/字体/两个 toggle 之后);
    // 没有 tip 就追加到卡尾。走回落宿主时沿用旧行为(插到承载开关的 rowline 之后)。
    if (displayCard) {
      if (displayTip) displayCard.insertBefore(wrap, displayTip);
      else displayCard.appendChild(wrap);
    } else if (host.classList && host.classList.contains('rowline') && host.parentNode) {
      host.parentNode.insertBefore(wrap, host.nextSibling);
    } else {
      host.appendChild(wrap);
    }
  }

  // ─── 10. 图像模块设置卡挂载 ───
  function getSlot() {
    return document.getElementById('settingsImageSlot') || document.getElementById('settings');
  }
  // 4.71: 语音 tab slot
  function getVoiceSlot() {
    return document.getElementById('settingsVoiceSlot') || null;
  }
  var _imgCardsMounted = false;
  function mountImageCards() {
    if (_imgCardsMounted) return;
    if (!getSlot()) return;
    mountImgStyleCard();
    mountImgKeyCard();
    mountImgQuotaCard();
    mountImgExpanderCard();
    // ── 角色立绘 ──
    (function(){
      var s=getSlot(); if(s&&!document.getElementById('imgSecTitle1')){
        var d=document.createElement('div'); d.id='imgSecTitle1';
        d.style.cssText='font-size:11px;font-weight:700;color:var(--muted);letter-spacing:.06em;padding:14px 0 4px;border-top:1px solid rgba(127,127,127,.12);margin-top:4px;';
        d.textContent='角色立绘'; s.appendChild(d);
      }
    })();
    mountImgPortraitCard();
    // ── 画廊·缓存 ──
    (function(){
      var s=getSlot(); if(s&&!document.getElementById('imgSecTitle2')){
        var d=document.createElement('div'); d.id='imgSecTitle2';
        d.style.cssText='font-size:11px;font-weight:700;color:var(--muted);letter-spacing:.06em;padding:14px 0 4px;border-top:1px solid rgba(127,127,127,.12);margin-top:4px;';
        d.textContent='画廊·缓存'; s.appendChild(d);
      }
    })();
    mountImgAlbumCard();
    mountImgCacheCard();
    _imgCardsMounted = true;
  }
  // 4.71: 语音 tab 挂载
  var _voiceCardsMounted = false;
  function mountVoiceCards() {
    if (_voiceCardsMounted) return;
    if (!getVoiceSlot()) return;
    mountTtsCard();
    _voiceCardsMounted = true;
  }
  var _SL = [['none','默认（不指定）'],['real','写实'],['anime','动漫（现代日系）'],['soft','日系厚涂'],['webtoon','韩漫（网漫）'],['uscomic','美漫（美式）'],['gufeng','中式（国风）'],['fantasy','欧美奇幻厚涂'],['oil','古典油画'],['water','水彩'],['render3d','3D（皮克斯渲染）'],['chibi','Q版（萌系）'],['inkmanga','黑白漫画'],['cyber','赛博朋克']];
  function styleOpts(){return _SL.map(function(p){return'<option value="'+p[0]+'">'+p[1]+'</option>';}).join('');}

  function mountImgStyleCard() {
    var slot=getSlot(); if(!slot||document.getElementById('imgStyleCard'))return;
    var pt=window.__portrait; if(!pt)return;
    var card=document.createElement('div'); card.className='card'; card.id='imgStyleCard';
    card.innerHTML='<h4>全局画风（全站出图生效）</h4><p>统一控制<b>所有自动出图</b>的画风，工坊手动文生图不受影响，仅本设备。</p><div class="rowline" style="align-items:center;gap:10px;margin-top:6px;"><label style="font-size:12px;opacity:.6;">画风</label><select id="imgStyleSelect" style="flex:1;padding:8px 10px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;">'+styleOpts()+'</select></div>';
    if(slot.firstChild)slot.insertBefore(card,slot.firstChild); else slot.appendChild(card);
    var sel=document.getElementById('imgStyleSelect');
    if(sel){sel.value=pt.getStyle();sel.addEventListener('change',function(){pt.setStyle(sel.value);});window.addEventListener('imagestyle:changed',function(e){var v=(e&&e.detail&&e.detail.style)||pt.getStyle();if(sel.value!==v)sel.value=v;});}
  }

  function mountImgKeyCard() {
    // 2026-06-24: 图像 API Key 归「模型 API」分类(setModelApiSlot),原在「发图」settingsImageSlot
    var slot=document.getElementById('setModelApiSlot')||getSlot(); if(!slot||document.getElementById('imgKeyCard'))return;
    var K='cfw_image_key_v1';
    var card=document.createElement('div'); card.className='card'; card.id='imgKeyCard';
    card.innerHTML='<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>图像 API Key（Gitee）</h4><p>图像工坊（生图/改图）调用 <code>ai.gitee.com</code>，需要单独的 Gitee API Key（LS <code>cfw_image_key_v1</code>），不进云同步。</p><div class="rowline"><input type="password" id="imgKeyInput" placeholder="Bearer Token" style="flex:1;padding:8px 10px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;"></div><div class="rowline" style="margin-top:8px;"><div></div><div class="btns"><button class="smallbtn" id="imgKeySave">保存</button><button class="smallbtn danger" id="imgKeyClear">清除</button></div></div><div id="imgKeyStatus" style="font-size:11px;color:var(--muted);margin-top:8px;"></div>';
    slot.appendChild(card);
    var inp=document.getElementById('imgKeyInput'),sts=document.getElementById('imgKeyStatus');
    try{inp.value=localStorage.getItem(K)||'';}catch(e){}
    function setMsg(){try{sts.textContent=localStorage.getItem(K)?'已保存 Key':'未设置 Key';}catch(e){}}
    setMsg();
    document.getElementById('imgKeySave').addEventListener('click',function(){try{localStorage.setItem(K,(inp.value||'').trim());}catch(e){}setMsg();});
    document.getElementById('imgKeyClear').addEventListener('click',function(){try{localStorage.removeItem(K);}catch(e){}inp.value='';setMsg();});
  }

  function mountImgQuotaCard() {
    var slot=getSlot(); if(!slot||document.getElementById('imgQuotaCard'))return;
    var q=window.__imageQuota; if(!q)return;
    var card=document.createElement('div'); card.className='card'; card.id='imgQuotaCard';
    card.innerHTML='<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="2"/><path d="M7 16v-4M12 16V8M17 16v-6"/></svg>图像额度计数（每日）</h4><p>Gitee 免费图像额度每天约 <b>100 次</b>。本站发图成功时按图片张数累加，<b>仅本设备本地统计</b>。</p><div id="imgQuotaDisplay" style="margin:6px 0 8px;"></div><div style="height:6px;border-radius:4px;background:rgba(127,127,127,.2);overflow:hidden;margin-bottom:12px;"><div id="imgQuotaBar" style="height:100%;width:0;transition:width .25s;"></div></div><div class="rowline" style="align-items:center;gap:10px;"><label style="font-size:12px;color:var(--muted);">每日额度</label><input type="number" id="imgQuotaLimit" min="1" max="9999" style="width:90px;padding:5px 8px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;"><div class="btns"><button class="smallbtn" id="imgQuotaMinus">-1</button><button class="smallbtn" id="imgQuotaPlus">+1</button><button class="smallbtn danger" id="imgQuotaReset">今日归零</button></div></div>';
    slot.appendChild(card);
    var lim=document.getElementById('imgQuotaLimit'); if(lim)lim.addEventListener('change',function(){q.setLimit(lim.value);});
    var qp=document.getElementById('imgQuotaPlus'); if(qp)qp.addEventListener('click',function(){q.add(1);});
    var qm=document.getElementById('imgQuotaMinus'); if(qm)qm.addEventListener('click',function(){q.add(-1);});
    var qr=document.getElementById('imgQuotaReset'); if(qr)qr.addEventListener('click',function(){q.reset();});
    if(q.renderCard)q.renderCard();
  }

  function mountImgPortraitCard(){
    var slot=getSlot(); if(!slot||document.getElementById('imgPortraitCard'))return;
    var pt=window.__portrait; if(!pt)return;
    var opts=_SL.map(function(p){return'<option value="'+p[0]+'">'+p[1]+'</option>';}).join('');
    var card=document.createElement('div'); card.className='card'; card.id='imgPortraitCard';
    card.innerHTML='<h4>角色立绘 → 发图基准图</h4><p>用当前选中<b>角色卡</b>自动拼提示词，z-image 出一张半身立绘，一键设为<b>微信发图基准图</b>。消耗 1 次图像额度，<b>仅本设备</b>。</p><div id="imgPortraitWho" style="font-size:13px;margin:4px 0;"></div><div class="rowline" style="align-items:center;gap:10px;margin-top:8px;"><label style="font-size:12px;opacity:.6;">画风</label><select id="imgPortraitStyle" style="flex:1;padding:6px 8px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;">'+opts+'</select></div><div class="rowline" style="margin-top:10px;"><div></div><div class="btns"><button class="smallbtn" id="imgPortraitGen">生成立绘</button><button class="smallbtn" id="imgPortraitSet" disabled>设为基准图</button><button class="smallbtn danger" id="imgPortraitClear">清除基准图</button></div></div><div id="imgPortraitStatus" style="font-size:11px;opacity:.6;margin-top:8px;"></div><div id="imgPortraitPreview" style="margin-top:10px;display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;"></div>';
    slot.appendChild(card);
    var sel=document.getElementById('imgPortraitStyle'),genBtn=document.getElementById('imgPortraitGen'),setBtn=document.getElementById('imgPortraitSet'),delBtn=document.getElementById('imgPortraitClear'),status=document.getElementById('imgPortraitStatus'),preview=document.getElementById('imgPortraitPreview');
    if(sel){sel.value=pt.getStyle();sel.addEventListener('change',function(){pt.setStyle(sel.value);});window.addEventListener('imagestyle:changed',function(e){var v=(e&&e.detail&&e.detail.style)||pt.getStyle();if(sel.value!==v)sel.value=v;});}
    function setMsg(t){if(status)status.textContent=t||'';}
    function activeCard(){try{return window.__character&&window.__character.getActiveCard&&window.__character.getActiveCard();}catch(e){return null;}}
    function refreshWho(){var who=document.getElementById('imgPortraitWho'),c=activeCard();if(who)who.innerHTML=c?'当前角色：<b>'+((c.icon?c.icon+' ':'')+(c.name||'(未命名)'))+'</b>':'<span style="color:#e5484d;">未选择角色卡 — 先去左侧「角色卡」选一个</span>';try{if(window.__chatImage&&window.__chatImage.getBaseImage&&c){Promise.resolve(window.__chatImage.getBaseImage({characterId:c.id||'default'})).then(function(b){if(b&&preview&&!preview.querySelector('[data-gen]'))preview.innerHTML='<div style="text-align:center;"><img src="'+b+'" style="max-width:140px;border-radius:8px;display:block;"><div style="font-size:11px;opacity:.6;margin-top:4px;">当前基准图</div></div>';}).catch(function(){});}}catch(e){}}
    if(genBtn)genBtn.addEventListener('click',async function(){genBtn.disabled=true;setMsg('生成中…（约 10-30 秒）');try{var r=await pt.generateForActive();if(preview)preview.innerHTML='<div style="text-align:center;"><img data-gen="1" src="'+r.url+'" style="max-width:160px;border-radius:8px;display:block;"><div style="font-size:11px;opacity:.6;margin-top:4px;">新立绘：'+(r.name||'')+'</div></div>';if(setBtn)setBtn.disabled=false;setMsg('生成完成，点「设为基准图」锁定。');}catch(e){setMsg('错误：'+((e&&e.message)||e));}genBtn.disabled=false;});
    if(setBtn)setBtn.addEventListener('click',async function(){setBtn.disabled=true;setMsg('保存基准图中…');try{await pt.setAsBase();setMsg('已设为当前角色的发图基准图。');}catch(e){setMsg('错误：'+((e&&e.message)||e));setBtn.disabled=false;}});
    if(delBtn)delBtn.addEventListener('click',async function(){if(!(window.__chatImage&&window.__chatImage.clearBaseImage)){setMsg('发图模块未就绪');return;}if(!confirm('清除当前角色的发图基准图？'))return;var c=activeCard();delBtn.disabled=true;setMsg('清除中…');try{await window.__chatImage.clearBaseImage({characterId:(c&&c.id)||'default'});if(preview)preview.innerHTML='';if(setBtn)setBtn.disabled=true;setMsg('已清除。');}catch(e){setMsg('错误：'+((e&&e.message)||e));}delBtn.disabled=false;});
    refreshWho(); window.addEventListener('character:changed',refreshWho);
  }

  function mountImgCacheCard(){
    var slot=getSlot(); if(!slot||document.getElementById('imgCacheCard'))return;
    var cache=window.__imageCache; if(!cache)return;
    var card=document.createElement('div'); card.className='card'; card.id='imgCacheCard';
    card.innerHTML='<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>提示词缓存去重</h4><p>相同提示词在短期内再次生成时，直接复用上次的图，<b>不再消耗当日额度</b>。仅文生图，缓存 6 小时，<b>仅本设备</b>。</p><label class="rowline" style="align-items:center;gap:8px;cursor:pointer;"><input type="checkbox" id="imgCacheToggle"><span>启用缓存去重</span></label><div id="imgCacheStats" style="font-size:12px;opacity:.75;margin-top:8px;"></div><div class="rowline" style="margin-top:8px;"><div></div><div class="btns"><button class="smallbtn danger" id="imgCacheClear">清空缓存</button></div></div>';
    slot.appendChild(card);
    var tog=document.getElementById('imgCacheToggle'),clr=document.getElementById('imgCacheClear'),st=document.getElementById('imgCacheStats');
    function refresh(){if(tog)tog.checked=cache.isEnabled();if(st){var s=cache.stats();st.textContent='已缓存 '+s.count+' 条，累计省下 '+s.saved+' 次生成';}}
    if(tog)tog.addEventListener('change',function(){cache.setEnabled(tog.checked);});
    if(clr)clr.addEventListener('click',function(){cache.clear();});
    window.addEventListener('imagecache:changed',refresh); refresh();
  }

  // 4.72 §十.A: 发图扩写器模型选择(LS cfw_expander_model_v1;留空=自动选 gpt-oss)
  function mountImgExpanderCard(){
    var slot=getSlot(); if(!slot||document.getElementById('imgExpanderCard'))return;
    var K='cfw_expander_model_v1';
    var list=[]; try{list=window.APP_MODELS_FREE||[];}catch(e){}
    var opts='<option value="">默认（自动选 gpt-oss-120b）</option>';
    for(var i=0;i<list.length;i++){var id=(list[i]&&list[i].id)||'';if(!id)continue;var nm=(list[i].name||id);opts+='<option value="'+id+'">'+nm+'</option>';}
    var card=document.createElement('div'); card.className='card'; card.id='imgExpanderCard';
    card.innerHTML='<h4>发图扩写器模型</h4><p>非限制级发图时，用这个免费模型把中文发图信号扩写成英文画面描述；限制级(≥1)走本地模板、不调此模型。留「默认」即自动选 gpt-oss-120b。<b>仅本设备</b>。</p><div class="rowline" style="align-items:center;gap:10px;margin-top:6px;"><label style="font-size:12px;opacity:.6;">扩写模型</label><select id="imgExpanderSelect" style="flex:1;padding:8px 10px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;">'+opts+'</select></div>';
    slot.appendChild(card);
    var sel=document.getElementById('imgExpanderSelect');
    if(sel){try{sel.value=localStorage.getItem(K)||'';}catch(e){}sel.addEventListener('change',function(){try{if(sel.value)localStorage.setItem(K,sel.value);else localStorage.removeItem(K);}catch(e){}});}
  }

  function mountImgAlbumCard(){
    var slot=getSlot(); if(!slot||document.getElementById('imgAlbumCard'))return;
    var album=window.__album; if(!album)return;
    var card=document.createElement('div'); card.className='card'; card.id='imgAlbumCard';
    card.innerHTML='<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="M4 17.5l5-5 3.2 3.2 3.2-3.8 4.1 5"/></svg>本地画廊</h4><p>工坊/立绘/发图生成的图会自动收进本地相册（浏览器 IndexedDB，最多 60 张）。每张可一键：设为基准图 / 插入对话 / 再改一张 / 下载 / 删除，<b>仅本设备</b>。</p><div id="imgAlbumStat" style="font-size:12px;opacity:.75;margin:6px 0;"></div><div class="rowline"><div></div><div class="btns"><button class="smallbtn" id="imgAlbumOpen">打开画廊</button><button class="smallbtn danger" id="imgAlbumClear">清空</button></div></div>';
    slot.appendChild(card);
    var stat=document.getElementById('imgAlbumStat');
    function refresh(){album.list().then(function(a){if(stat)stat.textContent='已收藏 '+a.length+' 张';});}
    var ob=document.getElementById('imgAlbumOpen'); if(ob)ob.addEventListener('click',function(){album.open();});
    var cb=document.getElementById('imgAlbumClear'); if(cb)cb.addEventListener('click',function(){if(confirm('清空本地画廊？'))album.clear();});
    window.addEventListener('imagealbum:changed',refresh); refresh();
  }

  function mountTtsCard(){
    if(!window.__TAURI__)return;
    var slot=getVoiceSlot(); if(!slot||document.getElementById('omniTtsCard'))return; // 语音 slot(本地 GPT-SoVITS 是本机服务、非外接 API,留「语音」tab)
    var tts=window.__omniTTS; if(!tts)return;
    var c=tts.cfg();
    var LR='cfw_tts_ref_audio_v1',LP='cfw_tts_prompt_text_v1',LA='cfw_tts_autoplay_v1',LSPD='cfw_tts_speed_v1';
    function lsSet(k,v){try{localStorage.setItem(k,v);}catch(e){}}
    var card=document.createElement('div'); card.className='card'; card.id='omniTtsCard';
    card.innerHTML='<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>本地语音（TTS，仅桌面版）</h4><p>用本机 GPT-SoVITS 把 AI 回复读出来。先在托盘「语音启动服务」，再填参考音频。<b>仅本设备</b>。</p><div style="margin-top:8px;"><label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;">参考音频完整路径 (.wav)</label><div style="display:flex;gap:6px;"><input id="omniTtsRef" type="text" style="flex:1;box-sizing:border-box;padding:7px 9px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;"><button class="smallbtn" id="omniTtsRefPick" type="button">选择…</button></div></div><div style="margin-top:10px;"><label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;">参考音频对应文字 (可留空)</label><input id="omniTtsPrompt" type="text" style="width:100%;box-sizing:border-box;padding:7px 9px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;"></div><div style="margin-top:10px;"><label for="omniTtsSpeed" style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:4px;"><span>语速</span><span id="omniTtsSpeedLabel" style="font-variant-numeric:tabular-nums;">1.00×</span></label><input id="omniTtsSpeed" type="range" min="0.5" max="1.5" step="0.05" value="1" style="width:100%;"><div style="font-size:11px;color:var(--muted);margin-top:4px;">向左变慢、向右变快(1.00× 为模型原速)。觉得太快就拉到 0.85～0.9。</div></div><div class="rowline" style="margin-top:10px;"><div class="toggle"><input type="checkbox" id="omniTtsAuto"><label for="omniTtsAuto">自动朗读每条 AI 回复(默认关)</label></div><div class="btns"><button class="smallbtn" id="omniTtsTest" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.5 4.9v14.2L19.5 12z"/></svg>试听</button></div></div><div style="margin-top:12px;border-top:1px solid rgba(127,127,127,.12);padding-top:10px;"><label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;">音色模型（底模，扫描热切，免重启）</label><div class="rowline" style="margin-top:10px;align-items:center;gap:8px;"><select id="omniTtsScanSovits" style="flex:1;padding:6px 8px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:12px;"><option value="">SoVITS(.pth) — 点扫描列出</option></select><select id="omniTtsScanGpt" style="flex:1;padding:6px 8px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:12px;"><option value="">GPT(.ckpt) — 可选</option></select></div><div class="rowline" style="margin-top:6px;"><div style="font-size:11px;color:var(--muted);flex:1;">扫 GPT-SoVITS 目录下 GPT_weights*/SoVITS_weights*,仿 WebUI 列出全部已装底模,免手敲路径</div><div class="btns"><button class="smallbtn" id="omniTtsScan" type="button">扫描已装</button><button class="smallbtn" id="omniTtsScanApply" type="button">应用所选</button></div></div></div><div style="margin-top:12px;border-top:1px solid rgba(127,127,127,.12);padding-top:10px;"><label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;">稳定音色 / 多参考（可选）</label><div id="omniTtsAuxList" style="display:flex;flex-direction:column;gap:6px;"></div><div class="rowline" style="margin-top:8px;gap:6px;"><input id="omniTtsAuxInput" type="text" placeholder="手填 .wav 路径,可一次多条(用 ; 或 | 分隔);或点「选择文件」多选" style="flex:1;padding:6px 8px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:12px;"><div class="btns"><button class="smallbtn" id="omniTtsAuxPick" type="button">选择文件(可多选)</button><button class="smallbtn" id="omniTtsAuxAdd" type="button">＋ 添加</button><button class="smallbtn danger" id="omniTtsAuxClear" type="button">清空全部</button></div></div><div style="font-size:11px;color:var(--muted);margin-top:6px;">多丢几条同一个人的干净 .wav,api_v2 融合多条参考、音色更稳不漂。留空=只用单条主参考。<br>「选择文件」可按住 Ctrl/Shift 一次多选;「添加」是把上面输入框里手填/粘贴的路径入列(选文件已自动入列,不用再点添加)。</div></div><div id="omniTtsStatus" style="font-size:11px;color:var(--muted);margin-top:8px;"></div>';
    slot.appendChild(card);
    var refEl=card.querySelector('#omniTtsRef'),promptEl=card.querySelector('#omniTtsPrompt'),autoEl=card.querySelector('#omniTtsAuto');
    refEl.value=c.refAudioPath; promptEl.value=c.promptText; autoEl.checked=c.autoplay;
    var speedEl=card.querySelector('#omniTtsSpeed'),speedLb=card.querySelector('#omniTtsSpeedLabel');
    if(speedEl){var sv=parseFloat(localStorage.getItem(LSPD)||'1');if(!(sv>=0.5&&sv<=1.5))sv=1;speedEl.value=String(sv);if(speedLb)speedLb.textContent=sv.toFixed(2)+'×';speedEl.addEventListener('input',function(){var v=parseFloat(speedEl.value)||1;if(speedLb)speedLb.textContent=v.toFixed(2)+'×';lsSet(LSPD,String(v));});}
    async function renderStatus(){
      var s=card.querySelector('#omniTtsStatus'); if(!s)return;
      var cc=tts.cfg();
      // 据实测端口判定:不管是 App 托盘启的、还是你自己双击 .bat 启的,只要 9880 在听就算「运行中」。
      var alive=(tts.probeService)?(await tts.probeService()):(cc.serviceRunning===true);
      s.textContent=alive?('✓ 语音服务运行中（端口 '+cc.port+(cc.ttsDir?'，'+cc.ttsDir:'')):'● 语音服务未启动 — 双击你的启动 .bat 或托盘「语音启动服务」,等控制台出现 Uvicorn running';}
    renderStatus();
    refEl.addEventListener('change',function(){lsSet(LR,refEl.value.trim());});
    promptEl.addEventListener('change',function(){lsSet(LP,promptEl.value.trim());});
    autoEl.addEventListener('change',function(){lsSet(LA,autoEl.checked?'1':'0');});
    // 主参考音「选择…」:调原生 tts_pick_file 弹系统文件框选 .wav,免手敲路径;旧版 .exe 无此命令时提示更新并回退手填
    var refPick=card.querySelector('#omniTtsRefPick');
    if(refPick)refPick.addEventListener('click',async function(){
      if(typeof tts.pickFile!=='function'){alert('当前运行的桌面版较旧,没有文件选择框命令(tts_pick_file)— 强刷页面并更新到新版后即可;暂时请直接粘贴 .wav 完整路径');return;}
      var p=await tts.pickFile();
      if(p){refEl.value=p;lsSet(LR,p);var s=card.querySelector('#omniTtsStatus');if(s)s.textContent='已选参考音频:'+p;}
    });
    card.querySelector('#omniTtsTest').addEventListener('click',async function(){
      lsSet(LR,refEl.value.trim()); lsSet(LP,promptEl.value.trim());
      var s=card.querySelector('#omniTtsStatus');
      if(!refEl.value.trim()){alert('先填(或用「选择…」选)参考音频 .wav 完整路径,再点试听。');return;}
      await tts.refreshNativeCfg(); renderStatus();
      // 直接合成一发:不再靠「是不是 App 自己启的服务」判断 —— 你双击 .bat 启的服务 App 看不到子进程,
      // 但端口在听就能合成。真打一发 9880,据实结果提示,无论谁启的都能试听。
      if(s)s.textContent='合成中…(首次要加载模型,十几秒~一两分钟)';
      tts.stop();
      var blob=null,synthErr=null;
      try{ blob=await tts.synthWith({text:'你好呀，现在能听到我说话了吗？'}); }catch(e){synthErr=e;}
      if(!blob){
        var port=tts.cfg().port;
        if(s)s.textContent='';
        if(synthErr&&/返回\s*4\d\d/.test(String((synthErr&&synthErr.message)||''))){
          // 服务在跑、但 api_v2 把合成请求拒了(最常见:所选底模与你的 GPT-SoVITS 版本不兼容)。原样亮出 api_v2 的报错,免得你去翻控制台。
          alert('GPT-SoVITS 收到请求但合成失败了 —— 多半是当前所选底模和你的 GPT-SoVITS 核心版本不兼容(换回匹配的 .pth + .ckpt,或升级 GPT-SoVITS 核心再试)。\n\napi_v2 原始报错:\n'+String(synthErr.message)+'\n\n(同样的红字也会打印在你的 api_v2 控制台窗口里)');
        }else{
          alert('试听没出声 —— 八成是 GPT-SoVITS 服务还没起来(端口 '+port+' 连不上),或参考音频路径不对。\n\n1) 确认你的 api_v2 窗口里已经出现 Uvicorn running on http://127.0.0.1:'+port+'(双击你的 .bat 或托盘「语音启动服务」都行),起来之后再点试听;\n2) 若服务已在跑还是没声:多半是「参考音频」填的路径不对(必须是真实存在的 .wav 完整路径),或所选底模没加载成功。');
        }
        return;
      }
      // 合成拿到音频 ≠ 一定出声:真去播并等结果。playBlob 会在 <audio> 播不出时自动回落 Web Audio 解码播,
      // 两路都失败才如实报错 —— 不再像以前那样一拿到字节就显示「成功」、其实没声还蒙在鼓里。
      if(s)s.textContent='✓ 合成成功，播放中…';
      try{
        await tts.enqueuePlay(blob);
        if(s)s.textContent='✓ 合成并播放完成(若没听到:检查系统音量/输出设备,或换底模/参考音再试)';
      }catch(e){
        if(s)s.textContent='';
        alert('音频已经合成出来了,但这台设备的网页层没把它播出来(WebView 播放被拒或解码失败)。\n\n排查:\n1) 系统没静音、输出设备正常;\n2) Ctrl+Shift+R 强刷页面后重试(已加 Web Audio 兜底播放);\n3) 仍无声:把 F12 控制台里 [TTS] 开头的红字发我。\n\n('+((e&&e.message)||e)+')');
      }
    });
    // ── 稳定音色·多参考:管理辅助参考音列表(__omniTTS.getAuxRefs/setAuxRefs),synthWith 自动带 aux_ref_audio_paths ──
    var auxListEl=card.querySelector('#omniTtsAuxList'),auxInput=card.querySelector('#omniTtsAuxInput'),auxAdd=card.querySelector('#omniTtsAuxAdd'),auxPick=card.querySelector('#omniTtsAuxPick'),auxClear=card.querySelector('#omniTtsAuxClear');
    function renderAux(){
      if(!auxListEl)return;
      var list=(tts.getAuxRefs&&tts.getAuxRefs())||[];
      if(!list.length){auxListEl.innerHTML='<div style="font-size:11px;color:var(--muted);">（未加辅助参考，只用单条主参考）</div>';return;}
      auxListEl.innerHTML='';
      list.forEach(function(p,idx){
        var row=document.createElement('div');
        row.style.cssText='display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;';
        var span=document.createElement('span');span.style.cssText='flex:1;word-break:break-all;color:var(--muted);';span.textContent=p;
        var del=document.createElement('button');del.className='smallbtn danger';del.type='button';del.textContent='删除';
        del.addEventListener('click',function(){var l=(tts.getAuxRefs&&tts.getAuxRefs())||[];l.splice(idx,1);tts.setAuxRefs(l);renderAux();});
        row.appendChild(span);row.appendChild(del);auxListEl.appendChild(row);
      });
    }
    renderAux();
    // 辅助参考入列(单一入口):校验 .wav + 去重 → 存 LS → 重画列表。选文件/手填/「添加」都走它。
    // 入列(单一入口·支持一次多条):传数组(多选文件)或字符串(手填,用 ; | 换行分隔)都行。
    // 逐条校验 .wav + 去重,有几条加几条,末尾汇总提示加了几条/跳过几条。
    function addAux(v){
      var raw=Array.isArray(v)?v:String(v==null?'':v).split(/[\r\n;|]+/);
      var cands=raw.map(function(x){return (x||'').trim();}).filter(function(x){return x;});
      if(!cands.length){alert('先用「选择文件」选(可多选),或在输入框手填 .wav 路径(多条用 ; 或 | 分隔),再点添加');return false;}
      var l=(tts.getAuxRefs&&tts.getAuxRefs())||[];
      var added=0,dup=0,bad=0;
      cands.forEach(function(p){
        if(!/\.wav$/i.test(p)){bad++;return;}
        if(l.indexOf(p)>=0){dup++;return;}
        l.push(p);added++;
      });
      if(added){tts.setAuxRefs(l);renderAux();}
      var s=card.querySelector('#omniTtsStatus');
      if(s)s.textContent='已加 '+added+' 条辅助参考'+(dup?('，跳过 '+dup+' 条重复'):'')+(bad?('，忽略 '+bad+' 条非 .wav'):'')+(added?' — 合成时与主参考一起融合稳定音色':'');
      if(!added&&bad&&!dup)alert('辅助参考必须是具体的 .wav 文件路径(不能是文件夹)');
      return added>0;
    }
    // 「选择文件」:弹系统框选 .wav,选中即直接入列(不用再点「添加」);旧版 .exe 无 tts_pick_file 时提示更新并回退手填
    if(auxPick)auxPick.addEventListener('click',async function(){
      if(typeof tts.pickFiles!=='function'&&typeof tts.pickFile!=='function'){alert('当前运行的桌面版较旧,没有文件选择框命令 — 强刷页面并更新到新版后即可;暂时请直接粘贴 .wav 完整路径');return;}
      // 多选:tts.pickFiles 一次返回多条;旧版 .exe 无 tts_pick_files 时 pickFiles 内部已回落单选。再兜底老 tts.js 只有 pickFile 的情况。
      var ps=(typeof tts.pickFiles==='function')?(await tts.pickFiles()):(await tts.pickFile().then(function(p){return p?[p]:[];}));
      if(ps&&ps.length&&addAux(ps))auxInput.value='';
    });
    // 「添加」:把输入框里手填/粘贴的路径入列(选文件已自动入列,这个留给手敲路径用)
    if(auxAdd)auxAdd.addEventListener('click',function(){ if(addAux(auxInput.value))auxInput.value=''; });
    // 「清空全部」:一键删掉所有辅助参考(主参考音不动);加了几千条时不用一条条点删除
    if(auxClear)auxClear.addEventListener('click',function(){
      var l=(tts.getAuxRefs&&tts.getAuxRefs())||[];
      var s=card.querySelector('#omniTtsStatus');
      if(!l.length){if(s)s.textContent='辅助参考本来就是空的,无需清空';return;}
      if(!confirm('确定清空全部 '+l.length+' 条辅助参考吗?\n\n只清辅助参考列表,主参考音不受影响\n纯本地操作,清错了重新添加即可'))return;
      tts.setAuxRefs([]);renderAux();
      if(s)s.textContent='已清空全部辅助参考(原 '+l.length+' 条)';
    });
    // ── 扫描已安装底模(仿 WebUI 自动列表):原生 tts_list_models 扫 GPT_weights*/SoVITS_weights* ──
    var scanSovits=card.querySelector('#omniTtsScanSovits'),scanGpt=card.querySelector('#omniTtsScanGpt');
    var scanBtn=card.querySelector('#omniTtsScan'),scanApply=card.querySelector('#omniTtsScanApply');
    function fillScan(sel,arr,label){if(!sel)return;var h='<option value="">'+label+'</option>';for(var i=0;i<(arr||[]).length;i++){var v=arr[i];h+='<option value="'+v+'">'+v+'</option>';}sel.innerHTML=h;}
    // 回显上次选定的底模(switchWeights 成功会存 cfw_tts_weights_current_v1):即便还没点「扫描已装」,
    // 也把上次选的塞进下拉并选中,让人看到「记住了」;扫描后再对齐选中。运行期自动切回由 tts.js ensureSavedWeights 负责。
    function preselect(sel,val){
      if(!sel||!val)return;
      var has=false;for(var i=0;i<sel.options.length;i++){if(sel.options[i].value===val){has=true;break;}}
      if(!has){var o=document.createElement('option');o.value=val;o.textContent=val;sel.appendChild(o);}
      sel.value=val;
    }
    var savedW=(tts.getCurrentWeights&&tts.getCurrentWeights())||{sovits:'',gpt:''};
    preselect(scanSovits,savedW.sovits); preselect(scanGpt,savedW.gpt);
    if(savedW.sovits){var _ss=card.querySelector('#omniTtsStatus');if(_ss&&!_ss.textContent)_ss.textContent='上次已切底模:'+savedW.sovits+(savedW.gpt?(' + '+savedW.gpt):'')+'(重启后首次合成会自动切回)';}
    if(scanBtn)scanBtn.addEventListener('click',async function(){
      var s=card.querySelector('#omniTtsStatus');if(s)s.textContent='扫描中…';
      var r=(tts.listInstalledModels&&await tts.listInstalledModels())||{gpt:[],sovits:[]};
      if(r.error){if(s)s.textContent='扫描失败:'+r.error+'(先在托盘设好并启动 GPT-SoVITS 文件夹)';return;}
      fillScan(scanSovits,r.sovits,'SoVITS(.pth)，共 '+((r.sovits||[]).length)+' 个,选一个');
      fillScan(scanGpt,r.gpt,'GPT(.ckpt)（可选），共 '+((r.gpt||[]).length)+' 个');
      var sw=(tts.getCurrentWeights&&tts.getCurrentWeights())||{sovits:'',gpt:''}; preselect(scanSovits,sw.sovits); preselect(scanGpt,sw.gpt);
      if(s)s.textContent='扫到 SoVITS '+((r.sovits||[]).length)+' 个 / GPT '+((r.gpt||[]).length)+' 个 — 选好点「应用所选」热切'+(sw.sovits?'(已自动选回上次:'+sw.sovits+')':'');
    });
    if(scanApply)scanApply.addEventListener('click',async function(){
      var sovits=scanSovits&&scanSovits.value,gpt=scanGpt&&scanGpt.value,s=card.querySelector('#omniTtsStatus');
      if(!sovits&&!gpt){alert('先点「扫描已装」再选一个 SoVITS(.pth)(GPT 可选)');return;}
      if(s)s.textContent='切换中…';
      var r=await tts.switchWeights({sovits:sovits,gpt:gpt});
      if(s)s.textContent=(r&&r.ok)?('✓ 已切到所选权重，热生效,无需重启'):('切换失败:'+((r&&r.reason)||'未知'));
    });
  }

  // ─── §模型API. 聊天模型自定义直连配置卡 ───
  // endpoint/model/key 存 LS cfw_byo_provider_v1(JSON);消费方读 window.__byoProvider.get()。
  function mountByoCard() {
    // 2026-09-12 / 4.70 块⑤: 自定义直连完善优先 —— 支持通过 Worker 代理拉取 /v1/models，
    // 解决浏览器 CORS/GFW；仍保留手填 fallback，兼容本地 vLLM/ollama 等不完整 OpenAI 兼容端点。
    var slot = document.getElementById('setModelApiSlot') || document.getElementById('settings');
    if (!slot || document.getElementById('byoProviderCard')) return;
    var K = 'cfw_byo_provider_v1';
    var PK = 'cfw_byo_provider_public_v1';
    function readPrivate() { try { var o = JSON.parse(localStorage.getItem(K) || '{}'); return (o && typeof o === 'object') ? o : {}; } catch (e) { return {}; } }
    function readPublic() { try { var o = JSON.parse(localStorage.getItem(PK) || '{}'); return (o && typeof o === 'object') ? o : {}; } catch (e) { return {}; } }
    function read() { return Object.assign({}, readPublic(), readPrivate()); }
    function publicCopy(o) {
      return {
        endpoint: (o && o.endpoint) || '',
        model: (o && o.model) || '',
        supportsThinking: !!(o && o.supportsThinking),
        needsReasoningHistory: !!(o && o.needsReasoningHistory),
        models: Array.isArray(o && o.models) ? o.models : []
      };
    }
    function saveBoth(o) {
      try { localStorage.setItem(K, JSON.stringify(o || {})); } catch (e) {}
      try { localStorage.setItem(PK, JSON.stringify(publicCopy(o || {}))); } catch (e) {}
    }
    function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    var cur = read();
    var card = document.createElement('div'); card.className = 'card'; card.id = 'byoProviderCard';
    card.innerHTML = '<h4>聊天模型 · 自定义直连</h4><p>填自带的 OpenAI 兼容端点(GPT/Qwen/GLM/Kimi/本地 vLLM 等)。现在可先拉取该端点真实模型列表再选择；拉不到也能手填。填了就<b>跳过内置白名单</b>直连该端点，自定义模型仍吃基座。Key 当前仍<b>仅存本设备</b>，云端保存放下一步。</p>'
      + '<div style="margin-top:8px;"><label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;">Endpoint(/v1/chat/completions 全路径，或 /v1 base)</label><input id="byoEndpoint" type="text" placeholder="https://api.openai.com/v1/chat/completions" style="width:100%;box-sizing:border-box;padding:7px 9px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;"></div>'
      + '<div style="margin-top:10px;"><label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;">API Key(本地 vLLM/ollama 可留空)</label><input id="byoKey" type="password" placeholder="Bearer Token" style="width:100%;box-sizing:border-box;padding:7px 9px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;"></div>'
      + '<div class="rowline" style="margin-top:10px;align-items:center;gap:10px;"><label style="font-size:12px;color:var(--muted);min-width:42px;">模型</label><select id="byoModelSelect" style="flex:1;min-width:0;padding:7px 9px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;"><option value="">请先拉取模型列表，或手填</option></select><div class="btns"><button class="smallbtn" id="byoFetchModels" type="button">拉取模型列表</button></div></div>'
      + '<div style="margin-top:8px;"><input id="byoModel" type="text" placeholder="手填 fallback：gpt-4o / qwen-max / glm-4-plus ..." style="width:100%;box-sizing:border-box;padding:7px 9px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;"></div>'
      + '<div class="rowline" style="margin-top:10px;align-items:center;gap:10px;"><label class="toggle" style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;"><input type="checkbox" id="byoThinking"><span>该模型支持思考(thinking,会补 reasoning 历史)</span></label></div>'
      + '<div class="rowline" style="margin-top:10px;"><div></div><div class="btns"><button class="smallbtn" id="byoSave">保存</button><button class="smallbtn danger" id="byoClear">清除·回内置</button></div></div>'
      + '<div id="byoStatus" style="font-size:11px;color:var(--muted);margin-top:8px;"></div>';
    slot.appendChild(card);
    var ep = document.getElementById('byoEndpoint'), md = document.getElementById('byoModel'), ky = document.getElementById('byoKey'), tk = document.getElementById('byoThinking'), sts = document.getElementById('byoStatus'), sel = document.getElementById('byoModelSelect');
    ep.value = cur.endpoint || ''; md.value = cur.model || ''; ky.value = cur.apiKey || ''; tk.checked = cur.supportsThinking === true;
    function setMsg(t) { var o = read(); sts.textContent = t || ((o.endpoint && o.model) ? ('● 已启用自定义直连 · ' + o.model) : '○ 未配置 · 当前用内置 free/fast 模型'); }
    function fillSelect(models, selected) {
      var list = Array.isArray(models) ? models : [];
      if (!sel) return;
      if (!list.length) { sel.innerHTML = '<option value="">未拉取到模型 · 使用手填 fallback</option>'; return; }
      sel.innerHTML = '<option value="">手填 fallback</option>' + list.map(function (m) {
        var id = (m && m.id) || m;
        return '<option value="' + esc(id) + '">' + esc(id) + '</option>';
      }).join('');
      if (selected) sel.value = selected;
    }
    fillSelect(cur.models || [], cur.model || '');
    setMsg();
    if (sel) sel.addEventListener('change', function () { if (sel.value) md.value = sel.value; });
    document.getElementById('byoFetchModels').addEventListener('click', async function () {
      var btn = document.getElementById('byoFetchModels');
      var endpoint = (ep.value || '').trim();
      var apiKey = (ky.value || '').trim();
      if (!endpoint) { alert('先填写 Endpoint'); return; }
      btn.disabled = true; setMsg('拉取自定义端点模型列表中…');
      try {
        var headers = { 'Content-Type': 'application/json' };
        try { var token = window.__auth && window.__auth.getToken && window.__auth.getToken(); if (token) headers.Authorization = 'Bearer ' + token; } catch (e) {}
        var r = await fetch('/api/custom-endpoint/models', { method: 'POST', headers: headers, body: JSON.stringify({ endpoint: endpoint, apiKey: apiKey }) });
        var d = await r.json().catch(function () { return null; });
        var models = d && Array.isArray(d.models) ? d.models : [];
        fillSelect(models, md.value || '');
        if (d && d.ok && models.length) {
          var old = read(); old.models = models; old.endpoint = endpoint; old.apiKey = apiKey; saveBoth(old);
          setMsg('已拉取 ' + models.length + ' 个模型 · 可从下拉选择，也可继续手填');
        } else {
          setMsg('没拉到模型(' + ((d && d.error) || r.status) + ') · 可继续手填 model');
        }
      } catch (e) { setMsg('拉取失败:' + ((e && e.message) || e) + ' · 可继续手填 model'); }
      btn.disabled = false;
    });
    document.getElementById('byoSave').addEventListener('click', function () {
      var chosen = (sel && sel.value) ? sel.value : (md.value || '').trim();
      var o = { endpoint: (ep.value || '').trim(), model: chosen, apiKey: (ky.value || '').trim(), supportsThinking: !!tk.checked, needsReasoningHistory: !!tk.checked };
      var old = read(); if (Array.isArray(old.models) && old.endpoint === o.endpoint) o.models = old.models;
      if (o.endpoint && !o.model) { alert('填了 Endpoint 就必须选择或填写模型名'); return; }
      if (!o.endpoint && !o.model) { try { localStorage.removeItem(K); } catch (e) {} fillSelect([], ''); setMsg(); return; }
      saveBoth(o);
      md.value = o.model;
      setMsg();
    });
    document.getElementById('byoClear').addEventListener('click', function () { try { localStorage.removeItem(K); localStorage.removeItem(PK); } catch (e) {} ep.value = ''; md.value = ''; ky.value = ''; tk.checked = false; fillSelect([], ''); setMsg(); });
  }

  // ─── §模型API. 自定义模型定价 ───
  // 写 cfw_custom_pricing_v1；app.js calcCost 每次实时合并，因此保存后立即生效。
  // 该 key 已加入 sync.js 主同步白名单，可跨端同步；不含 API Key。
  function mountCustomPricingCard() {
    var slot = document.getElementById('setModelApiSlot') || document.getElementById('settings');
    if (!slot || document.getElementById('customPricingCard')) return;
    var K = 'cfw_custom_pricing_v1';
    function read() { try { var o = JSON.parse(localStorage.getItem(K) || '{}'); return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {}; } catch (e) { return {}; } }
    function write(o) { try { localStorage.setItem(K, JSON.stringify(o || {})); } catch (e) {} }
    function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    var card = document.createElement('div'); card.className = 'card'; card.id = 'customPricingCard';
    card.innerHTML = '<h4>自定义模型定价</h4>'
      + '<p>给自定义直连或候选池里的新模型补价格。单位是 <b>¥ / 百万 token</b>；保存后费用估算立即生效，并随云同步跨端保存。</p>'
      + '<div class="settings-grid-2">'
      + '<label><span>模型 ID</span><input id="cpModel" type="text" placeholder="deepseek-v4-flash / qwen-max / gpt-4o ..."></label>'
      + '<label><span>缓存命中输入价</span><input id="cpCache" type="number" min="0" step="0.001" placeholder="0.02"></label>'
      + '<label><span>普通输入价</span><input id="cpInput" type="number" min="0" step="0.001" placeholder="1.00"></label>'
      + '<label><span>输出价</span><input id="cpOutput" type="number" min="0" step="0.001" placeholder="2.00"></label>'
      + '</div>'
      + '<div class="rowline" style="margin-top:10px;"><div id="cpStatus" style="font-size:11px;color:var(--muted);flex:1;"></div><div class="btns"><button class="smallbtn" id="cpUseCurrent" type="button">填当前模型</button><button class="smallbtn" id="cpSave" type="button">保存定价</button><button class="smallbtn danger" id="cpDelete" type="button">删除此模型</button></div></div>'
      + '<div id="cpList" class="settings-mini-list"></div>';
    slot.appendChild(card);
    var model = card.querySelector('#cpModel'), cache = card.querySelector('#cpCache'), input = card.querySelector('#cpInput'), output = card.querySelector('#cpOutput'), status = card.querySelector('#cpStatus'), list = card.querySelector('#cpList');
    function setMsg(t) { if (status) status.textContent = t || ''; }
    function fill(id) {
      var all = read(), p = all[id] || {};
      model.value = id || '';
      cache.value = p.cache_hit != null ? p.cache_hit : '';
      input.value = p.input != null ? p.input : '';
      output.value = p.output != null ? p.output : '';
    }
    function render() {
      var all = read(), ids = Object.keys(all).sort();
      if (!ids.length) { list.innerHTML = '<div style="font-size:11px;color:var(--muted);padding-top:8px;">暂无自定义定价</div>'; return; }
      list.innerHTML = ids.map(function (id) {
        var p = all[id] || {};
        return '<button type="button" data-id="' + esc(id) + '"><span>' + esc(id) + '</span><small>in ' + esc(p.input) + ' / out ' + esc(p.output) + '</small></button>';
      }).join('');
    }
    list.addEventListener('click', function (e) { var b = e.target.closest('button[data-id]'); if (b) fill(b.getAttribute('data-id')); });
    card.querySelector('#cpUseCurrent').addEventListener('click', function () {
      var id = '';
      try {
        var byo = window.__byoProvider && window.__byoProvider.get && window.__byoProvider.get();
        id = (byo && byo.model) || (document.getElementById('modelSel') && document.getElementById('modelSel').value) || '';
      } catch (e) {}
      fill(id);
      setMsg(id ? '已填入当前模型' : '没有可用的当前模型');
    });
    card.querySelector('#cpSave').addEventListener('click', function () {
      var id = (model.value || '').trim();
      var p = { cache_hit: parseFloat(cache.value), input: parseFloat(input.value), output: parseFloat(output.value) };
      if (!id) { alert('先填写模型 ID'); return; }
      if (!(p.cache_hit >= 0) || !(p.input >= 0) || !(p.output >= 0)) { alert('三个价格都要填数字，单位是 ¥/百万 token'); return; }
      var all = read(); all[id] = p; write(all); render(); setMsg('已保存 ' + id + ' 的定价');
    });
    card.querySelector('#cpDelete').addEventListener('click', function () {
      var id = (model.value || '').trim();
      if (!id) return;
      var all = read(); delete all[id]; write(all); fill(''); render(); setMsg('已删除 ' + id + ' 的自定义定价');
    });
    render();
  }

  // ─── 2026-10-08 外部改动（云同步回灌 / 别的标签页）后：把设置面板里这些开关/输入的值回读一遍 ───
  // 面板的卡片是"挂载一次"的（各 mount* 用 id 存在与否做守卫），旧版不会因为远端设置变化而更新 ——
  // 用户会看到"设置里显示关着、实际云端是开着的"。这里按"元素 id ← LS 键"的清单逐个回读。
  // （只处理会被同步的、且已直接落到 LS 的开关；内容型数据如角色卡/预设由各自通道的合并逻辑刷新。）
  const SYNCED_CONTROLS = [
    ["historyKeep", "cfw_history_enabled"],
    ["promptKeep", "cfw_prompt_enabled"],
    ["syncIncludeChatToggle", "cfw_sync_include_chat_v1"],
    ["appFxRichToggle", "cfw_app_fx_rich_v1"],
    ["appMemIdleToggle", "cfw_mem_idle_release_v1"],
    ["maDelegate", "cfw_ma_delegate_v1"],
    ["maMeeting", "cfw_ma_meeting_v1"],
    ["maInvite", "cfw_ma_invite_v1"],
    ["agentMaxRounds", "cfw_agent_max_rounds_v1"],
  ];
  function syncSettingsControlsFromLS() {
    if (!document.getElementById("settingsMask")) return;
    SYNCED_CONTROLS.forEach(function (pair) {
      var el = document.getElementById(pair[0]);
      if (!el) return;
      try {
        var v = localStorage.getItem(pair[1]);
        if (el.type === "checkbox") el.checked = (v == null) ? true : (v === "1");
        else if (v != null) el.value = v;
      } catch (e) {}
    });
    // 下拉类（值域与默认值各不同）单独回读：
    try { var ag = document.getElementById("agentWorkMode"); var w = localStorage.getItem("cfw_agent_work_mode_v1"); if (ag && w) ag.value = w; } catch (e) {}
    try { var at = document.getElementById("agentToolsSel"); var t = localStorage.getItem("cfw_agent_tools_v1"); if (at && t) at.value = t; } catch (e) {}
  }
  window.addEventListener("cfw:external-settings", syncSettingsControlsFromLS);

  // ─── init ───
  function init() {
    mountStaticSettingsCards();
    initCatNav();
    initPanelToggle();
    initStateLayerToggle();
    initTopbarToggles();
    initChatToggles();
    initSyncChatToggle();
    initSyncWipeBtn();
    initCloudExcludeSection();
    setupSyncAuthUI();
    setupThinkDisplaySetting();
    window.addEventListener('load', mountImageCards);
    window.addEventListener('load', mountVoiceCards); // 4.71
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();