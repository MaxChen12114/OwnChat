// 10-appearance.js — 外观：顶栏资金 / 手机布局 / 背景 / 主题 / 氛围音 / 壳特效 / 语言 / 自动命名。
// 由 settings.js 宿主的 init()/mountStaticSettingsCards() 调用；函数声明在同一 IIFE 内提升。
  // ─── 0.5 静态设置卡 JS 注入(M1:把卡 DOM 移出 index.html) ───
  // 每张卡在此创建并插入对应分类槽位,DOM 在 init 接线前就位,既有 init* 照常按 ID 接线。
  // 2026-10-05: 标题由「顶栏组件(Topbar Components)」改成「顶栏资金按钮」—— 卡里实际只有一个开关
  // (那个实时资金按钮),旧名承诺了"可选组件"复数,名不副实。归属(外观·界面)不变:顶栏就是界面。
  function mountTopbarCostCard() {
    var slot = window.slotRegistry.pick('setAppearanceTopSlot');
    if (slot) window.slotRegistry.claim({ cardId: 'showTopbarCostToggle', slotId: 'setAppearanceTopSlot' });
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
  // (不依赖 theme.js 的 load 时机,自己订阅 themeSvc,双重保险)。
  function mountMobileAppLayoutCard() {
    var slot = window.slotRegistry.pick('setAppearanceThemeSlot');
    if (slot) window.slotRegistry.claim({ cardId: 'mobileAppLayoutCard', slotId: 'setAppearanceThemeSlot' });
    if (!slot || document.getElementById('mobileAppLayoutCard')) return;
    var sa = window.settingsAppearance; // services/ui/settings-appearance.ts（默认值与极性单一来源）
    var K = sa.MOBILE_TABS_KEY;
    var card = document.createElement('div'); card.className = 'card'; card.id = 'mobileAppLayoutCard';
    card.innerHTML = '<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="2.5" width="12" height="19" rx="2.4"/><path d="M9.5 18.5h5"/></svg>手机 App 布局</h4>'
      + '<p>Android App 专用适配。输入框已按同类聊天 App 放大为更易点按的通栏布局;底部功能栏默认折叠,需要时可在这里打开。<b>仅本设备生效</b>。</p>'
      + '<div class="rowline"><div class="toggle"><input type="checkbox" id="mobileBottomTabsToggle"><label for="mobileBottomTabsToggle">显示底部功能栏(鱼缸 / 状态 / Agent)</label></div><div class="btns"><button class="smallbtn" id="mobileAppRefreshBtn" type="button">刷新页面</button></div></div>'
      + '<div class="settings-tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg><span>底栏关闭后输入框会贴近底部安全区;需要时回到这里重新打开。</span></div>';
    slot.appendChild(card);
    var t = card.querySelector('#mobileBottomTabsToggle');
    function isAndroidApp() {
      try { return sa.isAndroidShell(document.documentElement.classList.contains('android-app'), localStorage.getItem('cfw_android_app_shell_v1')); } catch (e) { return false; }
    }
    function apply(on) {
      document.documentElement.classList.toggle('hide-mobile-tabs', !on);
      try { localStorage.setItem(K, sa.flagValue(on)); } catch (e) {}
    }
    var on = true;
    try {
      var saved = localStorage.getItem(K);
      on = sa.mobileTabsOn(isAndroidApp(), saved);
    } catch (e) {}
    t.checked = on;
    apply(on);
    t.addEventListener('change', function () { apply(t.checked); });
    var rb = card.querySelector('#mobileAppRefreshBtn');
    if (rb) rb.addEventListener('click', function () { location.reload(); });
  }

  // ─── §外观. 聊天背景图（2026-10-06 从编辑器「UI 配置」页搬来）───
  // 原「UI 配置」页里唯一还有人用的功能就是换背景图，其余（自定义颜色/圆角/背景音/原始变量）一并删掉：
  // 用户原话「其它的完全就是跟随主题就好了」。存储沿用原键，老用户已设的背景不会丢：
  //   cfw_ui_overrides_v1.bg = { src: URL | '__local__', opacity, blur }
  //   cfw_ui_assets_v1.bgData = 本机上传的 base64（该键在 sync 的 PROTECTED 里，永不上云）
  // 应用由 theme.js 的 themeSvc.applyBg() 负责（启动时自动一次）。
  function mountBackgroundCard() {
    var slot = window.slotRegistry.pick('setAppearanceThemeSlot');
    if (slot) window.slotRegistry.claim({ cardId: 'chatBgCard', slotId: 'setAppearanceThemeSlot' });
    if (!slot || document.getElementById('chatBgCard')) return;
    var card = document.createElement('div'); card.className = 'card'; card.id = 'chatBgCard';
    card.innerHTML = '<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="M21 16l-5-5L5 20"/></svg>聊天背景图</h4>'
      + '<p>给聊天区铺一张背景图（覆盖在主题底色上）。<b>仅本设备生效</b>：URL、图片、模糊与位置都不进云同步，换设备需要重新设置。</p>'
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
    // 背景图存储形状/滑块解析/居中标签/删键规则已下沉 services/ui/settings-background.ts
    //（window.settingsBackground）；本卡只留 DOM、文件选择、状态文案与测试连接。
    var _bg = window.settingsBackground;
    function status(t) { var el = q('chatBgStatus'); if (el) el.textContent = t || ''; }
    function sync(fromAsset) {
      var bgRaw = _bg.readConfig().bg || {};
      var cfg = _bg.parseConfig(bgRaw);
      if (!fromAsset) { var u = q('chatBgUrl'); if (u) u.value = (cfg.src && cfg.src !== '__local__') ? cfg.src : ''; }
      var oe = q('chatBgOpacity'), be = q('chatBgBlur'), xe = q('chatBgPosX'), ye = q('chatBgPosY');
      if (oe) oe.value = String(cfg.opacity); if (be) be.value = String(cfg.blur);
      if (xe) xe.value = String(cfg.posX); if (ye) ye.value = String(cfg.posY);
      var ol = q('chatBgOpacityLbl'), bll = q('chatBgBlurLbl'), xl = q('chatBgPosXLbl'), yl = q('chatBgPosYLbl');
      if (ol) ol.textContent = cfg.opacity + '%'; if (bll) bll.textContent = cfg.blur + 'px';
      if (xl) xl.textContent = _bg.posLabel(cfg.posX);
      if (yl) yl.textContent = _bg.posLabel(cfg.posY);
      status(cfg.src ? (cfg.src === '__local__' ? '当前：本机上传的图片' : '当前：URL') : '当前：未设置');
    }
    q('chatBgUrlApply').addEventListener('click', function () {
      _bg.writeConfig(_bg.applyUrl(_bg.readConfig(), q('chatBgUrl').value));
      sync();
    });
    q('chatBgPick').addEventListener('click', function () { q('chatBgFile').click(); });
    q('chatBgFile').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0]; if (!f) return;
      if (_bg.isOverUploadLimit(f.size)) { status('图片超过 4MB，换一张小一点的（base64 会更大）'); e.target.value = ''; return; }
      var rd = new FileReader();
      rd.onload = function () {
        var a = _bg.readAssets(); a.bgData = String(rd.result || ''); _bg.writeAssets(a);
        _bg.setLocalSource(); sync(true);
      };
      rd.onerror = function () { status('读取文件失败'); };
      rd.readAsDataURL(f); e.target.value = '';
    });
    q('chatBgClear').addEventListener('click', function () {
      _bg.writeConfig(_bg.clearBg(_bg.readConfig()));
      var a = _bg.readAssets(); delete a.bgData; _bg.writeAssets(a);
      var u = q('chatBgUrl'); if (u) u.value = '';
      sync();
    });
    q('chatBgOpacity').addEventListener('input', function () { _bg.setField('opacity', q('chatBgOpacity').value); sync(true); });
    q('chatBgBlur').addEventListener('input', function () { _bg.setField('blur', q('chatBgBlur').value); sync(true); });
    q('chatBgPosX').addEventListener('input', function () { _bg.setField('posX', q('chatBgPosX').value); sync(true); });
    q('chatBgPosY').addEventListener('input', function () { _bg.setField('posY', q('chatBgPosY').value); sync(true); });
    sync();
  }

  function mountThemeCard() {
    var slot = window.slotRegistry.pick('setAppearanceThemeSlot');
    if (slot) window.slotRegistry.claim({ cardId: 'appearanceThemeCard', slotId: 'setAppearanceThemeSlot' });
    if (!slot || document.getElementById('appearanceThemeCard')) return;
    var card = document.createElement('div'); card.className = 'card'; card.id = 'appearanceThemeCard';
    card.innerHTML = '<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>外观风格</h4>'
      + '<p>切换整站配色与视觉氛围,四种风格随时切换。<b>仅本设备生效</b>(不进云同步)。</p>'
      + '<div class="theme-options">'
      + '<label class="theme-option"><input type="radio" name="cfwTheme" value="minimal"><div class="theme-swatch theme-swatch-minimal"></div><div class="theme-text"><div class="theme-title">极简</div><div class="theme-sub">Notion 风格，日/夜双态</div></div></label>'
      + '<label class="theme-option"><input type="radio" name="cfwTheme" value="glass"><div class="theme-swatch theme-swatch-glass"></div><div class="theme-text"><div class="theme-title">玻璃</div><div class="theme-sub">毛玻璃，晴空竹屋</div></div></label>'
      + '<label class="theme-option"><input type="radio" name="cfwTheme" value="lumen"><div class="theme-swatch theme-swatch-lumen"></div><div class="theme-text"><div class="theme-title">流光</div><div class="theme-sub">液态玻璃 · 文档式聊天</div></div></label>'
      + '<label class="theme-option" data-nsfw><input type="radio" name="cfwTheme" value="candle"><div class="theme-swatch theme-swatch-candle"></div><div class="theme-text"><div class="theme-title">烛夜私语</div><div class="theme-sub">暗调 · 私享</div></div></label>'
      + '</div>'
      + '<div class="settings-tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg><span>烛夜私语需先解锁才可见,含呼吸光效;极简 / 流光下方会出现日/夜切换。聊天呈现可独立切换:跟随主题 / 气泡 / 文档;流光默认文档,其余主题默认气泡。</span></div>';
    slot.appendChild(card);
    function syncChecked() {
      var cur = (window.themeSvc && window.themeSvc.get && window.themeSvc.get().style) || 'minimal';
      card.querySelectorAll('input[name="cfwTheme"]').forEach(function (r) { r.checked = (r.value === cur); });
    }
    card.querySelectorAll('input[name="cfwTheme"]').forEach(function (r) {
      r.addEventListener('change', function () {
        if (!r.checked) return;
        if (window.themeSvc && window.themeSvc.set) window.themeSvc.set({ style: r.value });
      });
    });
    syncChecked();
    if (window.themeSvc && window.themeSvc.subscribe) window.themeSvc.subscribe(syncChecked);
  }

  // ─── §氛围音卡（2026-10-06 双轨混音器：环境 amb × 音乐 mus）───
  // chips 与事件接线都在 theme.js 的 wireAmbientCard()（音轨注册表 = 唯一来源），
  // 本函数只负责卡壳子：总开关 / 两轨音量 / 两条 chips 容器 / 全部停止。
  // 不挂 data-nsfw —— 氛围音全主题可用（这是它存在的意义：工作背景音也能用）。
  function mountAmbientCard() {
    var slot = window.slotRegistry.pick('setAppearanceThemeSlot');
    if (slot) window.slotRegistry.claim({ cardId: 'ambientCard', slotId: 'setAppearanceThemeSlot' });
    if (!slot || document.getElementById('ambientCard')) return;
    var card = document.createElement('div'); card.className = 'card'; card.id = 'ambientCard';
    card.innerHTML = '<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h2l2-5 3 10 3-7 2 4h6"/></svg>氛围音</h4>'
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
    try { if (window.themeSvc && window.themeSvc.wireAmbientCard) window.themeSvc.wireAmbientCard(); } catch (e) {}
  }

  // ─── §外观. App 壳特效档位（2026-10-07 新增，E-B；2026-10-08 文案修正）───
  // 壳内（含桌面壳 —— 桌面壳也是 ?shell=android，见 tauri.conf.json）默认「流畅优先」：
  // index.html 里 html.android-app:not(.fx-rich) 那组覆盖关掉了毛玻璃 / 全屏混合层 / 常驻动画
  // （拖动卡顿的主因），并且在低特效档停掉 --pulse 的定时重算。勾选 = 加回 .fx-rich。
  // 注意：气泡级的毛玻璃与 ::after 流光**所有档位都关**（成本随消息数线性增长），这里换不回来。
  function mountAppFxCard() {
    if (!document.documentElement.classList.contains('android-app')) return;
    var slot = window.slotRegistry.pick('setAppearanceThemeSlot');
    if (slot) window.slotRegistry.claim({ cardId: 'appFxCard', slotId: 'setAppearanceThemeSlot' });
    if (!slot || document.getElementById('appFxCard')) return;
    var card = document.createElement('div'); card.className = 'card'; card.id = 'appFxCard';
    card.innerHTML = '<h4>App 内特效档位</h4>'
      + '<p>App 壳内<b>默认「流畅优先」</b>：关闭毛玻璃模糊、全屏混合层、常驻动画与背景光晕律动，拖动/滚动更跟手、更省电。勾选可换回玻璃 / 烛光的完整观感（代价是耗电与可能的卡顿）。<br>气泡级的磨砂与流光已<b>永久关闭</b>（成本随消息条数增长），不再随本开关恢复。</p>'
      + '<div class="rowline"><div class="toggle"><input type="checkbox" id="appFxRichToggle"><label for="appFxRichToggle">完整特效（更耗电 / 可能卡顿）</label></div></div>'
      + '<h4 style="margin-top:12px;">内存</h4>'
      + '<p>壳长时间挂在后台后，页面会持住大量缓存内存（与特效档位关系不大）。开启后：<b>窗口在后台超过 10 分钟</b>且没有发送中/待批/草稿时，自动刷新页面释放内存 —— 聊天记录已落盘，不受影响。</p>'
      + '<div class="rowline"><div class="toggle"><input type="checkbox" id="appMemIdleToggle"><label for="appMemIdleToggle">空闲自动释放内存</label></div></div>';
    slot.appendChild(card);
    var sa = window.settingsAppearance; // services/ui/settings-appearance.ts
    var t = card.querySelector('#appFxRichToggle');
    t.checked = sa.appFxOn(localStorage.getItem(sa.APP_FX_KEY));
    t.addEventListener('change', function () {
      localStorage.setItem(sa.APP_FX_KEY, sa.flagValue(t.checked));
      document.documentElement.classList.toggle('fx-rich', t.checked);
    });
    var m = card.querySelector('#appMemIdleToggle');
    // 缺省开（壳是长跑场景）：未显式设置过时显示为勾选，切换才写值
    m.checked = sa.memIdleOn(localStorage.getItem(sa.MEM_IDLE_KEY));
    m.addEventListener('change', function () {
      localStorage.setItem(sa.MEM_IDLE_KEY, sa.flagValue(m.checked));
    });
  }

  // ─── §外观. 界面语言（2026-10-07 新增，双语插件）───
  // 双语是「插件脚本」实现：/shared/lib/i18n.js 引擎 + /shared/core/i18n-dict.js 字典（启用英文才懒加载，
  // 中文用户零开销）。按已渲染文本整串替换，模型输出/用户内容不在翻译范围；覆盖主路径，
  // 未覆盖的仍显示中文（可增量补字典，`node tooling/scripts/check-i18n.mjs` 审计缺口）。切换会整页刷新。
  function mountI18nCard() {
    var slot = window.slotRegistry.pick('setAppearanceThemeSlot');
    if (slot) window.slotRegistry.claim({ cardId: 'i18nCard', slotId: 'setAppearanceThemeSlot' });
    if (!slot || document.getElementById('i18nCard')) return;
    var card = document.createElement('div'); card.className = 'card'; card.id = 'i18nCard';
    card.innerHTML = '<h4>界面语言</h4>'
      + '<p>英文界面是<b>运行时翻译插件</b>（beta）：按字典把界面文案替换成英文 —— 模型输出、消息内容、角色名不会被翻译。已覆盖主路径；个别未覆盖的文案仍显示中文，可增量补字典。切换语言会刷新页面。</p>'
      + '<div class="rowline"><div class="toggle"><input type="checkbox" id="i18nEnToggle"><label for="i18nEnToggle">English UI（beta，部分文案未覆盖）</label></div></div>';
    slot.appendChild(card);
    var sa = window.settingsAppearance; // services/ui/settings-appearance.ts
    var t = card.querySelector('#i18nEnToggle');
    t.checked = sa.langIsEn(localStorage.getItem(sa.UI_LANG_KEY));
    t.addEventListener('change', function () {
      localStorage.setItem(sa.UI_LANG_KEY, sa.langValue(t.checked));
      location.reload();
    });
  }

  // ─── §外观. 内容面板（2026-11-26）───
  // 右栏标签宿的两个外部地址。沙盘根地址的键、http(s) 校验、路径拼接与提示全部在
  // services/sandbox/views.ts（唯一真源）；这里只负责输入框与写盘。GEO 仍是独立外部源。
  // 改动后派发 panel:config-changed：panel-host 重扫目录，手机壳重渲染工作台。
  function mountPanelToolsCard() {
    var slot = window.slotRegistry.pick('setAppearanceThemeSlot');
    if (slot) window.slotRegistry.claim({ cardId: 'panelToolsCard', slotId: 'setAppearanceThemeSlot' });
    if (!slot || document.getElementById('panelToolsCard')) return;
    var MAP_KEY = 'cfw_panel_map_url_v1';
    var viewsApi = window.sandboxViews;
    var SANDBOX_KEY = viewsApi ? viewsApi.baseKey : '';
    var inputStyle = 'flex:1;min-width:0;padding:8px 10px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;';
    var card = document.createElement('div'); card.className = 'card'; card.id = 'panelToolsCard';
    card.innerHTML = '<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4.5" width="18" height="15" rx="2.4"/><path d="M9 4.5v15"/></svg>内容面板</h4>'
      + '<p>左栏「工作台」和右栏「+」打开的是<b>同一份目录</b>（public/tools/*/tool.json），标签都在右栏里切。下面两个是外部页面地址，<b>仅本设备生效</b>；留空表示未配置。</p>'
      + '<div style="margin-top:10px;"><div style="font-size:12px;color:var(--muted);margin-bottom:6px;">沙盘地址（独立仓）</div>'
      + '<div class="rowline" style="align-items:center;gap:8px;"><input type="text" id="panelSandboxUrl" maxlength="300" placeholder="http://127.0.0.1:8000/" style="' + inputStyle + '"><button class="smallbtn" id="panelSandboxUrlSave" type="button">保存</button><button class="smallbtn" id="panelSandboxUrlClear" type="button">清除</button></div>'
      + '<div class="settings-tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg><span>沙盘不在本仓：在沙盘仓库目录执行 <code>cd OwnChat-Sandbox &amp;&amp; npm run dev</code>，默认地址 <code>http://127.0.0.1:8000/</code>。这里填<b>根地址</b>；「沙盘」标签默认打开星系→行星→地图，配置后另出现「星图」页（3D 飞行页不挂）。手机访问需局域网 IP 或独立部署。</span></div></div>'
      + '<div style="margin-top:14px;"><div style="font-size:12px;color:var(--muted);margin-bottom:6px;">GEO 地图地址（外部源）</div>'
      + '<div class="rowline" style="align-items:center;gap:8px;"><input type="text" id="panelMapUrl" maxlength="300" placeholder="http://127.0.0.1:8796/map-viewer/" style="' + inputStyle + '"><button class="smallbtn" id="panelMapUrlSave" type="button">保存</button><button class="smallbtn" id="panelMapUrlClear" type="button">清除</button></div>'
      + '<div class="settings-tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg><span>先启动 GEO-Agent（它的启动器会拉起 8795 / 8796）。未填时右栏不出现 GEO 地图入口——不占位、不显示引导。</span></div></div>';
    slot.appendChild(card);

    function notify() {
      try { window.dispatchEvent(new CustomEvent('panel:config-changed')); } catch (e) {}
    }
    function bind(inputId, saveId, clearId, key, normalize) {
      var input = card.querySelector('#' + inputId);
      var save = card.querySelector('#' + saveId);
      var clear = card.querySelector('#' + clearId);
      function apply() {
        var v = String(input.value || '').trim();
        if (v) {
          if (!key) { input.style.borderColor = '#b4553f'; return; }
          var checked = normalize(v);
          if (!checked || !checked.ok) {
            input.style.borderColor = '#b4553f';
            return;
          }
          input.value = checked.value;
          v = checked.value;
        }
        input.style.borderColor = '';
        try {
          if (v) localStorage.setItem(key, v); else localStorage.removeItem(key);
        } catch (e) {}
        notify();
      }
      input.value = key ? (function () { try { return localStorage.getItem(key) || ''; } catch (e) { return ''; } })() : '';
      save.addEventListener('click', apply);
      clear.addEventListener('click', function () {
        input.value = '';
        input.style.borderColor = '';
        if (key) { try { localStorage.removeItem(key); } catch (e) {} }
        notify();
      });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); apply(); }
      });
    }
    bind('panelSandboxUrl', 'panelSandboxUrlSave', 'panelSandboxUrlClear', SANDBOX_KEY, function (value) {
      if (typeof normalizeSandboxBase !== 'function') return { ok: false, value: '' };
      var r = normalizeSandboxBase(value);
      return r && r.ok ? { ok: true, value: r.base } : { ok: false, value: '' };
    });
    bind('panelMapUrl', 'panelMapUrlSave', 'panelMapUrlClear', MAP_KEY, function (value) {
      return /^https?:\/\//i.test(value) ? { ok: true, value: value } : { ok: false, value: '' };
    });
  }

  // 2026-11-13 A34: 会话自动命名开关。两个开关都只写本设备 LS，模块运行时读同一对键，
  // 因此这里不依赖 __convAutoname 是否已加载（脚本顺序 / 老页面刷新都安全）。
  function mountConvAutonameCard() {
    var slot = window.slotRegistry.pick('setChatSlot');
    if (slot) window.slotRegistry.claim({ cardId: 'convAutonameCard', slotId: 'setChatSlot' });
    if (!slot || document.getElementById('convAutonameCard')) return;
    var card = document.createElement('div'); card.className = 'card'; card.id = 'convAutonameCard';
    card.innerHTML = '<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6.5h16M4 12h10M4 17.5h7"/><circle cx="18.5" cy="16.5" r="3"/></svg>会话自动命名</h4>'
      + '<p>新建会话默认叫「新对话」。开启后，发出第一条消息就会用本地规则截取一个短名，首轮回复后再让模型精炼成更贴切的名称。<b>仅本设备生效</b>。</p>'
      + '<div class="rowline"><div class="toggle"><input type="checkbox" id="convAutonameToggle"><label for="convAutonameToggle">新对话自动命名（本地即时，零请求）</label></div></div>'
      + '<div class="rowline"><div class="toggle"><input type="checkbox" id="convAutonameAiToggle"><label for="convAutonameAiToggle">首轮回复后用 AI 精炼标题（每个新会话多一次轻量模型调用）</label></div></div>'
      + '<div class="settings-tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg><span>只作用于名字仍是「新对话」的会话；你手动改过的名字不会被覆盖，「主对话」保持原名，已有历史会话不动。</span></div>';
    slot.appendChild(card);
    // 2026-11-18 服务层搬迁：主从联动（键/极性/禁用门）在 services/ui/settings-autoname.ts
    // （window.settingsAutoname）；键与 conv/autoname.ts 同源，测试锁住漂移。
    var t = card.querySelector('#convAutonameToggle'), ai = card.querySelector('#convAutonameAiToggle');
    var pair = window.settingsAutoname.read();
    t.checked = pair.on; ai.checked = pair.aiOn; ai.disabled = !pair.on;
    t.addEventListener('change', function () {
      var p2 = window.settingsAutoname.writeMaster(t.checked);
      ai.checked = p2.aiOn; ai.disabled = !p2.on;
    });
    ai.addEventListener('change', function () {
      window.settingsAutoname.writeAi(ai.checked);
    });
  }
