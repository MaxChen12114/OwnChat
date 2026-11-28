(function () {
/**
 * Settings page data: the page-level storage keys and the rules its open/sync passes apply.
 *
 * Most cards now delegate their own keys to dedicated services. What remains here is the page
 * shell: the controls refreshed when the panel opens, the two value tables (`historyKeep` /
 * `promptKeep` / font size) and the external-settings re-read. Keys owned by other services
 * (appearance, multi-agent, persona) stay as literals in {@link SYNCED_CONTROLS} on purpose — this
 * product loads beside them, not above them, and the list is reviewed as one page-level snapshot.
 * @module services/ui/settings
 */

/** Page-level keys; changing one is changing what a saved browser profile sees. */
const SETTINGS_PAGE_KEYS                                   = {
  history: "cfw_history_enabled",
  prompt: "cfw_prompt_enabled",
  customPrompt: "cfw_custom_prompt_v1",
  personalize: "cfw_agent_personalize_v1",
  fontSize: "cfw_chat_font_size_v1",
  fontFamily: "cfw_chat_font_family_v1",
  textFx: "cfw_chat_text_fx_v1",
  chatSession: "cfw_chat_session_v1",
  autoplay: "cfw_tts_autoplay_v1",
  mode: "cfw_mode",
  agentWorkMode: "cfw_agent_work_mode_v1",
  agentTools: "cfw_agent_tools_v1",
  agentMaxRounds: "cfw_agent_max_rounds_v1",
};

/** `[element id, storage key]` pairs re-read after an external-settings broadcast. */
const SYNCED_CONTROLS                                           = [
  ["historyKeep", SETTINGS_PAGE_KEYS.history],
  ["promptKeep", SETTINGS_PAGE_KEYS.prompt],
  // Owned by the persona service; kept literal because that product loads beside this one.
  ["useBuiltinToggle", "cfw_use_builtin"],
  ["appFxRichToggle", "cfw_app_fx_rich_v1"],
  ["appMemIdleToggle", "cfw_mem_idle_release_v1"],
  ["maDelegate", "cfw_ma_delegate_v1"],
  ["maMeeting", "cfw_ma_meeting_v1"],
  ["maInvite", "cfw_ma_invite_v1"],
  ["agentMaxRounds", SETTINGS_PAGE_KEYS.agentMaxRounds],
  // Compaction parameters (owned by the context service; the card mirrors them).
  ["ctxCompactEnabled", "cfw_summary_enabled"],
  ["ctxTrigger", "cfw_summary_trigger"],
  ["ctxKeep", "cfw_summary_keep"],
  ["ctxRatio", "cfw_summary_ratio_v1"],
];

/** History switch: only the literal `"1"` enables sending history. */
function normalizeHistoryKeep(raw         )          {
  return raw === "1";
}

/** Custom-prompt switch: missing means ON; any other value must be the literal `"1"`. */
function normalizePromptKeep(raw         )          {
  return raw == null ? true : raw === "1";
}

/** Chat font size: stored value clamped to the slider range, anything invalid falls back to 13px. */
function normalizeFontSize(raw         )         {
  const n = parseInt(String(raw ?? ""), 10);
  return n >= 12 && n <= 22 ? n : 13;
}

/** Top-level mode mirror: only the literal `fast` selects fast; everything else is free. */
function normalizeMode(raw         )         {
  return raw === "fast" ? "fast" : "free";
}

/** Local TTS auto-read: only the literal `"1"` enables it. */
function normalizeAutoplay(raw         )          {
  return raw === "1";
}

/** Re-read rule for the synced checkbox table: missing means ON, otherwise only `"1"` is on. */
function syncedCheckboxChecked(raw         )          {
  return raw == null ? true : raw === "1";
}

/* l0-wiring-part: opens the shared IIFE; parsed as part of public/services/ui/settings.js */
/**
 * tooling/l0/wiring/settings/00-core.js — settings 产品的共享外壳。
 *
 * 2026-11-26 拆件：原 2553 行 settings.js 按域拆成 7 个函数片段 + 本外壳 + 宿主。
 * 所有片段由 tooling/l0/emit.mjs 按 WIRING_PARTS 顺序拼进同一个 IIFE；函数声明整体提升，
 * 片段顺序不参与运行语义，宿主只负责 init 与收口。
 */
(() => {
  // 2026-11-10: 统一主题弹窗（feedback.js 的 ZCode 风对话框）。未加载时回退原生，保证功能不丢。
  function uiAlert(msg, opts) {
    try { if (window.feedbackSvc && window.feedbackSvc.alert) return window.feedbackSvc.alert(Object.assign({ message: String(msg) }, opts || {})); } catch (e) {}
    return Promise.resolve(window.alert(String(msg)));
  }
  function uiConfirm(msg, opts) {
    try { if (window.feedbackSvc && window.feedbackSvc.confirm) return window.feedbackSvc.confirm(Object.assign({ message: String(msg) }, opts || {})); } catch (e) {}
    return Promise.resolve(window.confirm(String(msg)));
  }

  // ─── 0. BYO 自定义模型配置（批 E1b：薄壳转发 window.providersSvc，形状不变）───
  // 真正的注册表在 /js/text/data/providers.js（window.providersSvc）：预设渠道 + 自定义渠道 + 每模型开关。
  // 这里只保留老契约 get()（app.js / 适配器读取形状照旧）；providers.js 缺席时退回 v2 直读兜底（旧缓存页）。
  // 语义修正：兜底路径也要求 activeId 命中才返回 —— 修掉 v2「列表里有任何服务商就劫持全部请求」的旧病。
  window.byoProviderSvc = {
    get() {
      try {
        if (window.providersSvc && window.providersSvc.byoSnapshot) return window.providersSvc.byoSnapshot();
      } catch (e) {}
      try {
        var o = JSON.parse(localStorage.getItem('cfw_byo_providers_v2') || 'null');
        if (o && Array.isArray(o.providers) && o.activeId) {
          var p = null;
          for (var i = 0; i < o.providers.length; i++) if (o.providers[i].id === o.activeId) p = o.providers[i];
          if (p && p.endpoint && p.model) {
            var out = { id: p.id, name: p.name, endpoint: p.endpoint, model: p.model, supportsThinking: !!p.supportsThinking, needsReasoningHistory: !!p.needsReasoningHistory, models: Array.isArray(p.models) ? p.models : [] };
            if (typeof p.apiKey === 'string' && p.apiKey) out.apiKey = p.apiKey;
            return out;
          }
        }
      } catch (e) {}
      return null;
    }
  };

  // ─── 2. 面板开关 ───
  // 2026-10-13 (批 E1c): 供其它模块按分类打开设置（失效模型自愈跳「模型 API」）——
  // 打开面板 = settingsMask 显示 flex；切分类 = 点对应 .scn-item（initCatNav 的接线照常生效）。
  window.__openSettingsCat = function (cat) {
    try {
      const mask = document.getElementById('settingsMask');
      if (mask) mask.style.display = 'flex';
      const it = document.querySelector('.settings-cat-nav .scn-item[data-cat="' + String(cat || '') + '"]');
      if (it) it.click();
    } catch (e) {}
  };

  var _imgCardsMounted = false;
  // 4.71: 语音 tab 挂载
  var _voiceCardsMounted = false;

// 10-appearance.js — 外观：顶栏资金 / 手机布局 / 背景 / 主题 / 氛围音 / 壳特效 / 语言 / 自动命名。
// 由 settings.js 宿主的 init()/mountStaticSettingsCards() 调用；函数声明在同一 IIFE 内提升。
  // ─── 0.5 静态设置卡 JS 注入(M1:把卡 DOM 移出 index.html) ───
  // 每张卡在此创建并插入对应分类槽位,DOM 在 init 接线前就位,既有 init* 照常按 ID 接线。
  // 2026-10-05: 标题由「顶栏组件(Topbar Components)」改成「顶栏资金按钮」—— 卡里实际只有一个开关
  // (那个实时资金按钮),旧名承诺了"可选组件"复数,名不副实。归属(外观·界面)不变:顶栏就是界面。
  function mountTopbarCostCard() {
    // Card-level id topbarCostCard is new in this batch: the old guard id sat on the inner toggle
    // (showTopbarCostToggle, which the settings host still reads to sync the display), while the
    // declareCard probe must sit on the card element. The toggle keeps its own id and wiring.
    window.slotRegistry.declareCard({
      id: 'topbarCostCard',
      slotId: 'setAppearanceTopSlot',
      build: function (slot) {
        var shell = window.cardShell.createCardShell({
          id: 'topbarCostCard',
          title: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><path d="M3.5 9.2h17"/></svg>顶栏资金按钮',
          desc: '控制顶栏那个实时资金按钮(今日 / 总计)的显示。关闭后剩余按钮(模式切换 / 内置 / 同步 / 设置)自动紧凑排列。<b>仅本设备生效</b>(不进云同步)。',
          extra: '<div class="rowline"><div class="toggle"><input type="checkbox" id="showTopbarCostToggle"><label for="showTopbarCostToggle">显示实时资金按钮（顶栏：今日 / 总计）</label></div></div>',
          tip: '资金数据始终在「高级 → 费用日志」卡里完整可看;关掉顶栏仅减少视觉占用,不影响计费/同步。'
        });
        slot.appendChild(shell.card);
        return shell.card;
      }
    });
  }

  // ─── §外观. 聊天背景图（2026-10-06 从编辑器「UI 配置」页搬来）───
  // 原「UI 配置」页里唯一还有人用的功能就是换背景图，其余（自定义颜色/圆角/背景音/原始变量）一并删掉：
  // 用户原话「其它的完全就是跟随主题就好了」。存储沿用原键，老用户已设的背景不会丢：
  //   cfw_ui_overrides_v1.bg = { src: URL | '__local__', opacity, blur }
  //   cfw_ui_assets_v1.bgData = 本机上传的 base64（该键在 sync 的 PROTECTED 里，永不上云）
  // 应用由 theme.js 的 themeSvc.applyBg() 负责（启动时自动一次）。
  function mountBackgroundCard() {
    window.slotRegistry.declareCard({
      id: 'chatBgCard',
      slotId: 'setAppearanceThemeSlot',
      build: function (slot) {
        var shell = window.cardShell.createCardShell({
          id: 'chatBgCard',
          title: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="M21 16l-5-5L5 20"/></svg>聊天背景图',
          desc: '给聊天区铺一张背景图（覆盖在主题底色上）。<b>仅本设备生效</b>：URL、图片、模糊与位置都不进云同步，换设备需要重新设置。',
          extra: '<div style="margin-top:8px;"><label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;">图片 URL</label>'
            + '<div style="display:flex;gap:6px;"><input id="chatBgUrl" type="text" placeholder="https://… 或留空" style="flex:1;box-sizing:border-box;padding:7px 9px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;">'
            + '<button class="smallbtn" id="chatBgUrlApply" type="button">应用</button></div></div>'
            + '<div class="rowline" style="margin-top:10px;gap:6px;"><input type="file" id="chatBgFile" accept="image/*" style="display:none"><button class="smallbtn" id="chatBgPick" type="button">上传本地图片</button><button class="smallbtn danger" id="chatBgClear" type="button">清除背景</button><span id="chatBgStatus" style="font-size:11px;color:var(--muted);"></span></div>'
            + '<div style="margin-top:12px;"><label for="chatBgOpacity" style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:4px;"><span>不透明度</span><span id="chatBgOpacityLbl">100%</span></label><input id="chatBgOpacity" type="range" min="0" max="100" step="1" value="100" style="width:100%;"></div>'
            + '<div style="margin-top:8px;"><label for="chatBgBlur" style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:4px;"><span>模糊</span><span id="chatBgBlurLbl">0px</span></label><input id="chatBgBlur" type="range" min="0" max="24" step="1" value="0" style="width:100%;"></div>'
            + '<div style="margin-top:8px;"><label for="chatBgPosX" style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:4px;"><span>水平位置</span><span id="chatBgPosXLbl">居中</span></label><input id="chatBgPosX" type="range" min="0" max="100" step="1" value="50" style="width:100%;"></div>'
            + '<div style="margin-top:8px;"><label for="chatBgPosY" style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:4px;"><span>垂直位置</span><span id="chatBgPosYLbl">居中</span></label><input id="chatBgPosY" type="range" min="0" max="100" step="1" value="50" style="width:100%;"></div>',
          tip: '上传的图片以 base64 存在本机（体积大，不进云同步）；换设备请用 URL。位置滑杆用来挪画面：0% = 靠左/靠上，100% = 靠右/靠下（图片按 cover 铺满，挪动即换露出区域）。背景图只在没有实色底的地方透出来，不影响侧栏与气泡可读性。'
        });
        var card = shell.card, q = shell.q;
        slot.appendChild(card);
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
        return card;
      }
    });
  }

  function mountThemeCard() {
    window.slotRegistry.declareCard({
      id: 'appearanceThemeCard',
      slotId: 'setAppearanceThemeSlot',
      build: function (slot) {
        var shell = window.cardShell.createCardShell({
          id: 'appearanceThemeCard',
          title: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>外观风格',
          desc: '切换整站配色与视觉氛围,四种风格随时切换。<b>仅本设备生效</b>(不进云同步)。',
          extra: '<div class="theme-options">'
            + '<label class="theme-option"><input type="radio" name="cfwTheme" value="minimal"><div class="theme-swatch theme-swatch-minimal"></div><div class="theme-text"><div class="theme-title">极简</div><div class="theme-sub">Notion 风格，日/夜双态</div></div></label>'
            + '<label class="theme-option"><input type="radio" name="cfwTheme" value="glass"><div class="theme-swatch theme-swatch-glass"></div><div class="theme-text"><div class="theme-title">玻璃</div><div class="theme-sub">毛玻璃，晴空竹屋</div></div></label>'
            + '<label class="theme-option"><input type="radio" name="cfwTheme" value="lumen"><div class="theme-swatch theme-swatch-lumen"></div><div class="theme-text"><div class="theme-title">流光</div><div class="theme-sub">液态玻璃 · 文档式聊天</div></div></label>'
            + '<label class="theme-option" data-nsfw><input type="radio" name="cfwTheme" value="candle"><div class="theme-swatch theme-swatch-candle"></div><div class="theme-text"><div class="theme-title">烛夜私语</div><div class="theme-sub">暗调 · 私享</div></div></label>'
            + '</div>',
          tip: '烛夜私语需先解锁才可见,含呼吸光效;极简 / 流光下方会出现日/夜切换。聊天呈现可独立切换:跟随主题 / 气泡 / 文档;流光默认文档,其余主题默认气泡。'
        });
        var card = shell.card;
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
        return card;
      }
    });
  }

  // ─── §氛围音卡（2026-10-06 双轨混音器：环境 amb × 音乐 mus）───
  // chips 与事件接线都在 theme.js 的 wireAmbientCard()（音轨注册表 = 唯一来源），
  // 本函数只负责卡壳子：总开关 / 两轨音量 / 两条 chips 容器 / 全部停止。
  // 不挂 data-nsfw —— 氛围音全主题可用（这是它存在的意义：工作背景音也能用）。
  function mountAmbientCard() {
    window.slotRegistry.declareCard({
      id: 'ambientCard',
      slotId: 'setAppearanceThemeSlot',
      build: function (slot) {
        var shell = window.cardShell.createCardShell({
          id: 'ambientCard',
          title: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h2l2-5 3 10 3-7 2 4h6"/></svg>氛围音',
          desc: '环境声与背景音乐两条独立音轨,可同时叠加、音量独立,切换带淡入淡出。RP 模式下 Agent 会按剧情自行调用(聊天里说「放点音乐」也会照做)。',
          extra: '<div class="rowline"><div class="toggle"><input type="checkbox" id="ambEnabled"><label for="ambEnabled">启用氛围音</label></div>'
            + '<div class="btns"><button class="smallbtn" id="ambStopAll" type="button">全部停止</button></div></div>'
            + '<div class="amb-layer"><div class="amb-layer-head"><span class="amb-layer-name">环境声</span>'
            + '<label class="amb-vol" for="ambVolAmb"><span>音量</span><input type="range" id="ambVolAmb" min="0" max="100" step="1" value="60"><span class="amb-vol-val" id="ambVolAmbLabel">60%</span></label></div>'
            + '<div class="amb-chips" id="ambChipsAmb"></div></div>'
            + '<div class="amb-layer"><div class="amb-layer-head"><span class="amb-layer-name">背景音乐</span>'
            + '<label class="amb-vol" for="ambVolMus"><span>音量</span><input type="range" id="ambVolMus" min="0" max="100" step="1" value="35"><span class="amb-vol-val" id="ambVolMusLabel">35%</span></label></div>'
            + '<div class="amb-chips" id="ambChipsMus"></div></div>',
          tip: '点标签播放、再点一下停止;高亮的是当前在放的轨。浏览器/手机 WebView 需先点过页面才会出声(自动播放限制)。音源全部为 CC0,来源见 <code>public/assets/ambient/CREDITS.txt</code>。'
        });
        slot.appendChild(shell.card);
        try { if (window.themeSvc && window.themeSvc.wireAmbientCard) window.themeSvc.wireAmbientCard(); } catch (e) {}
        return shell.card;
      }
    });
  }

  // ─── §外观. App 壳特效档位（2026-10-07 新增，E-B；2026-10-08 文案修正）───
  // 壳内（含桌面壳 —— 桌面壳也是 ?shell=android，见 tauri.conf.json）默认「流畅优先」：
  // index.html 里 html.android-app:not(.fx-rich) 那组覆盖关掉了毛玻璃 / 全屏混合层 / 常驻动画
  // （拖动卡顿的主因），并且在低特效档停掉 --pulse 的定时重算。勾选 = 加回 .fx-rich。
  // 注意：气泡级的毛玻璃与 ::after 流光**所有档位都关**（成本随消息数线性增长），这里换不回来。
  function mountAppFxCard() {
    if (!document.documentElement.classList.contains('android-app')) return;
    window.slotRegistry.declareCard({
      id: 'appFxCard',
      slotId: 'setAppearanceThemeSlot',
      build: function (slot) {
        var shell = window.cardShell.createCardShell({
          id: 'appFxCard',
          title: 'App 内特效档位',
          desc: 'App 壳内<b>默认「流畅优先」</b>：关闭毛玻璃模糊、全屏混合层、常驻动画与背景光晕律动，拖动/滚动更跟手、更省电。勾选可换回玻璃 / 烛光的完整观感（代价是耗电与可能的卡顿）。<br>气泡级的磨砂与流光已<b>永久关闭</b>（成本随消息条数增长），不再随本开关恢复。',
          extra: '<div class="rowline"><div class="toggle"><input type="checkbox" id="appFxRichToggle"><label for="appFxRichToggle">完整特效（更耗电 / 可能卡顿）</label></div></div>'
            + '<h4 style="margin-top:12px;">内存</h4>'
            + '<p>壳长时间挂在后台后，页面会持住大量缓存内存（与特效档位关系不大）。开启后：<b>窗口在后台超过 10 分钟</b>且没有发送中/待批/草稿时，自动刷新页面释放内存 —— 聊天记录已落盘，不受影响。</p>'
            + '<div class="rowline"><div class="toggle"><input type="checkbox" id="appMemIdleToggle"><label for="appMemIdleToggle">空闲自动释放内存</label></div></div>'
        });
        var card = shell.card;
        slot.appendChild(card);
        var sa = window.settingsAppearance; // services/ui/settings-appearance.ts
        // Bind primitives: the reflect/listen/write triple collapses into bindToggle; keys and
        // polarity stay on settingsAppearance (unbound when the service is absent — the old code
        // would have thrown a ReferenceError here). The fx-rich class flip rides on onChange.
        window.bindEl.bindToggle(card, '#appFxRichToggle', {
          key: sa ? sa.APP_FX_KEY : 'cfw_app_fx_rich_v1',
          read: sa ? function () { return sa.appFxOn(localStorage.getItem(sa.APP_FX_KEY)); } : null,
          write: sa ? function (on) { localStorage.setItem(sa.APP_FX_KEY, sa.flagValue(on)); } : null,
          fallbackGet: null,
          fallbackSet: null,
          onChange: function (on) { document.documentElement.classList.toggle('fx-rich', on); },
        });
        // 缺省开（壳是长跑场景）：未显式设置过时显示为勾选，切换才写值
        window.bindEl.bindToggle(card, '#appMemIdleToggle', {
          key: sa ? sa.MEM_IDLE_KEY : 'cfw_mem_idle_release_v1',
          read: sa ? function () { return sa.memIdleOn(localStorage.getItem(sa.MEM_IDLE_KEY)); } : null,
          write: sa ? function (on) { localStorage.setItem(sa.MEM_IDLE_KEY, sa.flagValue(on)); } : null,
          fallbackGet: null,
          fallbackSet: null,
          onChange: null,
        });
        return card;
      }
    });
  }

  // ─── §外观. 界面语言（2026-10-07 新增，双语插件）───
  // 双语是「插件脚本」实现：/shared/lib/i18n.js 引擎 + /shared/core/i18n-dict.js 字典（启用英文才懒加载，
  // 中文用户零开销）。按已渲染文本整串替换，模型输出/用户内容不在翻译范围；覆盖主路径，
  // 未覆盖的仍显示中文（可增量补字典，`node tooling/scripts/check-i18n.mjs` 审计缺口）。切换会整页刷新。
  function mountI18nCard() {
    window.slotRegistry.declareCard({
      id: 'i18nCard',
      slotId: 'setAppearanceThemeSlot',
      build: function (slot) {
        var shell = window.cardShell.createCardShell({
          id: 'i18nCard',
          title: '界面语言',
          desc: '英文界面是<b>运行时翻译插件</b>（beta）：按字典把界面文案替换成英文 —— 模型输出、消息内容、角色名不会被翻译。已覆盖主路径；个别未覆盖的文案仍显示中文，可增量补字典。切换语言会刷新页面。',
          extra: '<div class="rowline"><div class="toggle"><input type="checkbox" id="i18nEnToggle"><label for="i18nEnToggle">English UI（beta，部分文案未覆盖）</label></div></div>'
        });
        var card = shell.card;
        slot.appendChild(card);
        var sa = window.settingsAppearance; // services/ui/settings-appearance.ts
        window.bindEl.bindToggle(card, '#i18nEnToggle', {
          key: sa ? sa.UI_LANG_KEY : 'cfw_ui_lang_v1',
          read: sa ? function () { return sa.langIsEn(localStorage.getItem(sa.UI_LANG_KEY)); } : null,
          write: sa ? function (on) { localStorage.setItem(sa.UI_LANG_KEY, sa.langValue(on)); } : null,
          fallbackGet: null,
          fallbackSet: null,
          onChange: function () { location.reload(); },
        });
        return card;
      }
    });
  }

  // ─── §外观. 内容面板（2026-11-26）───
  // 右栏标签宿的两个外部地址。沙盘根地址的键、http(s) 校验、路径拼接与提示全部在
  // services/sandbox/views.ts（唯一真源）；这里只负责输入框与写盘。GEO 仍是独立外部源。
  // 改动后派发 panel:config-changed：panel-host 重扫目录，手机壳重渲染工作台。
  function mountPanelToolsCard() {
    window.slotRegistry.declareCard({
      id: 'panelToolsCard',
      slotId: 'setAppearanceThemeSlot',
      build: function (slot) {
        var MAP_KEY = 'cfw_panel_map_url_v1';
        var viewsApi = window.sandboxViews;
        var SANDBOX_KEY = viewsApi ? viewsApi.baseKey : '';
        var inputStyle = 'flex:1;min-width:0;padding:8px 10px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;';
        // Both URL sections carry their own nested settings-tip, so the tips ride in `extra`
        // verbatim instead of the shell's standard trailing tip block.
        var shell = window.cardShell.createCardShell({
          id: 'panelToolsCard',
          title: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4.5" width="18" height="15" rx="2.4"/><path d="M9 4.5v15"/></svg>内容面板',
          desc: '左栏「工作台」和右栏「+」打开的是<b>同一份目录</b>（public/tools/*/tool.json），标签都在右栏里切。下面两个是外部页面地址，<b>仅本设备生效</b>；留空表示未配置。',
          extra: '<div style="margin-top:10px;"><div style="font-size:12px;color:var(--muted);margin-bottom:6px;">沙盘地址（独立仓）</div>'
            + '<div class="rowline" style="align-items:center;gap:8px;"><input type="text" id="panelSandboxUrl" maxlength="300" placeholder="http://127.0.0.1:8000/" style="' + inputStyle + '"><button class="smallbtn" id="panelSandboxUrlSave" type="button">保存</button><button class="smallbtn" id="panelSandboxUrlClear" type="button">清除</button></div>'
            + '<div class="settings-tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg><span>沙盘不在本仓：在沙盘仓库目录执行 <code>cd OwnChat-Sandbox &amp;&amp; npm run dev</code>，默认地址 <code>http://127.0.0.1:8000/</code>。这里填<b>根地址</b>；「沙盘」标签默认打开星系→行星→地图，配置后另出现「星图」页（3D 飞行页不挂）。手机访问需局域网 IP 或独立部署。</span></div></div>'
            + '<div style="margin-top:14px;"><div style="font-size:12px;color:var(--muted);margin-bottom:6px;">GEO 地图地址（外部源）</div>'
            + '<div class="rowline" style="align-items:center;gap:8px;"><input type="text" id="panelMapUrl" maxlength="300" placeholder="http://127.0.0.1:8796/map-viewer/" style="' + inputStyle + '"><button class="smallbtn" id="panelMapUrlSave" type="button">保存</button><button class="smallbtn" id="panelMapUrlClear" type="button">清除</button></div>'
            + '<div class="settings-tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg><span>先启动 GEO-Agent（它的启动器会拉起 8795 / 8796）。未填时右栏不出现 GEO 地图入口——不占位、不显示引导。</span></div></div>'
        });
        var card = shell.card, q = shell.q;
        slot.appendChild(card);

        function notify() {
          try { window.dispatchEvent(new CustomEvent('panel:config-changed')); } catch (e) {}
        }
        function bind(inputId, saveId, clearId, key, normalize) {
          var input = q(inputId);
          var save = q(saveId);
          var clear = q(clearId);
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
        return card;
      }
    });
  }

  // 2026-11-13 A34: 会话自动命名开关。两个开关都只写本设备 LS，模块运行时读同一对键，
  // 因此这里不依赖 __convAutoname 是否已加载（脚本顺序 / 老页面刷新都安全）。
  function mountConvAutonameCard() {
    window.slotRegistry.declareCard({
      id: 'convAutonameCard',
      slotId: 'setChatSlot',
      build: function (slot) {
        var shell = window.cardShell.createCardShell({
          id: 'convAutonameCard',
          title: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6.5h16M4 12h10M4 17.5h7"/><circle cx="18.5" cy="16.5" r="3"/></svg>会话自动命名',
          desc: '新建会话默认叫「新对话」。开启后，发出第一条消息就会用本地规则截取一个短名，首轮回复后再让模型精炼成更贴切的名称。<b>仅本设备生效</b>。',
          extra: '<div class="rowline"><div class="toggle"><input type="checkbox" id="convAutonameToggle"><label for="convAutonameToggle">新对话自动命名（本地即时，零请求）</label></div></div>'
            + '<div class="rowline"><div class="toggle"><input type="checkbox" id="convAutonameAiToggle"><label for="convAutonameAiToggle">首轮回复后用 AI 精炼标题（每个新会话多一次轻量模型调用）</label></div></div>',
          tip: '只作用于名字仍是「新对话」的会话；你手动改过的名字不会被覆盖，「主对话」保持原名，已有历史会话不动。'
        });
        var card = shell.card;
        slot.appendChild(card);
        // 2026-11-18 服务层搬迁：主从联动（键/极性/禁用门）在 services/ui/settings-autoname.ts
        //（window.settingsAutoname）；键与 conv/autoname.ts 同源，测试锁住漂移。
        // The master/sub gating stays hand-written: the master write repaints the sub toggle's
        // checked/disabled state, which is not the single-control shape bindToggle covers.
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
        return card;
      }
    });
  }

// 20-base.js — 基座与内容：行为准则 / 基座提示词 / 基座目录 / 联网 / 人物模板 / 静态卡总装。
// 由 settings.js 宿主的 init()/mountStaticSettingsCards() 调用；函数声明在同一 IIFE 内提升。
  // ─── §基座. 基础行为准则卡（2026-10-05 新增）───
  // 锁定态注入 src/prompts/bases/locked/ 里那套准则；解锁后本卡隐藏（data-locked-only + index.html 的反向 CSS 规则），
  // 槽位由「基座提示词」卡顶上 —— 两张卡都 prepend 进 #setChatSlot，隐藏的那张不占位，
  // 所以视觉上永远是「该状态的那一张」在首卡位置（对应服务端的两套注册表）。
  // 文案纪律：本卡**只在锁定态可见**，所以字面上一律不提「解锁 / 解限 / 私人模式」——
  // 锁定态是伪装态，任何"存在一个隐藏开关"的暗示都属于泄底（与 data-nsfw 那套隐藏同一理由）。
  // 反过来，两边互斥这件事写在「基座提示词」卡的提示里（那张卡只有解锁后才看得到）。
  function mountNeutralCard() {
    // 2026-11-28 card-shell batch 2: the pick/claim/getElementById boilerplate moved into
    // slotRegistry.declareCard and the card/h4/p/tip skeleton into cardShell.createCardShell.
    // The card keeps its data-locked-only attribute and its prepend placement (first card while
    // locked); the select keeps its id and the settings-base-id wiring is unchanged.
    window.slotRegistry.declareCard({
      id: 'neutralCard',
      slotId: 'setChatSlot',
      build: function (slot) {
        var esc = window.escapeSvc.esc;
        var shell = window.cardShell.createCardShell({
          id: 'neutralCard',
          title: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/></svg>基础行为准则',
          desc: '给助手定的 system 行为准则——语言口吻、事实与诚实、扮演与创作、代码与技术、排版格式。',
          extra: '<div style="margin-top:10px;"><select id="neutralIdSel" style="width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;"></select></div>',
          tip: '文件放在 <code>src/prompts/bases/locked/</code>（规则与 <code>bases/unlocked/</code> 一致：任意 <code>.md</code>/<code>.txt</code>/子目录，id = 文件名）。<b>默认</b> = 排序第一份。切换后<b>下一轮</b>生效。往那里放一个新文件、部署，这里自动多一项。'
        });
        var card = shell.card, q = shell.q;
        card.setAttribute('data-locked-only', '');
        slot.prepend(card);
        var bs = q('neutralIdSel');
        if (!bs) return card;
        // 2026-11-25 C2：选择键与默认值归 services/ui/settings-base-id.ts（与 prompt-profile 读侧对拍）
        var sel = window.settingsBaseId;
        var KB = sel.NEUTRAL_ID_KEY;
        var ids = Array.isArray(window.APP_NEUTRAL_IDS) ? window.APP_NEUTRAL_IDS : [];
        bs.innerHTML = '<option value="">默认</option>' + ids.map(function (id) {
          return '<option value="' + esc(id) + '">' + esc(id) + '</option>';
        }).join('');
        try { bs.value = sel.readSelection(KB); } catch (e) {}
        bs.addEventListener('change', function () {
          try { sel.writeSelection(KB, bs.value); } catch (e) {}
        });
        return card;
      }
    });
  }

  // ─── §基座. 基座提示词版本卡(2026-10-05 从「聊天模型·自定义直连」卡里拆出,独立成卡)───
  // 为什么独立:基座提示词是 system 提示词的第一段,对全部聊天生效(内置模型与自定义直连都吃),
  // 本身与"直连"毫无关系 —— 塞在直连卡最底部、隔一条分割线时,没人能找到它。
  // 为什么放「对话」类目首卡:基座影响一切,理应排在该分类最上面(prepend 保证位置,不依赖挂载顺序)。
  // 锁定态整卡不显示:卡上带 data-nsfw,由 html:not(.unlocked) [data-nsfw]{display:none} 隐藏
  // —— 与 NSFW 主题同一套机制(未解锁=不渲染,而不是置灰)。
  function mountBaseIdCard() {
    // 2026-11-28 card-shell batch 2: shell + declareCard; data-nsfw and prepend stay on the card
    // and the __baseSwitchMode custom-registry dropdown below is untouched hand-written DOM.
    window.slotRegistry.declareCard({
      id: 'baseIdCard',
      slotId: 'setChatSlot',
      build: function (slot) {
        var esc = window.escapeSvc.esc;
        var shell = window.cardShell.createCardShell({
          id: 'baseIdCard',
          title: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/></svg>基座提示词',
          desc: '基座提示词是 system 提示词的第一段，所有聊天都吃它——内置模型与自定义直连一样。这里选的是它的版本。',
          extra: '<div style="margin-top:10px;"><select id="baseIdSel" style="width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;"></select></div>',
          tip: '选项就是 <code>src/prompts/bases/unlocked/</code> 里的文件名（<b>默认</b> = 排序第一份；想让某份当默认，就在它名字最前面加个数字）。切换后<b>下一轮</b>生效。往那里放一个新 <code>.md</code>，部署后这里自动多一项。锁定态走的是另一套「基础行为准则」（<code>bases/locked/</code>），与本卡互斥显示。'
        });
        var card = shell.card, q = shell.q;
        card.setAttribute('data-nsfw', '');
        slot.prepend(card);
        // 候选项来自 /config.js 的 APP_BASE_IDS(worker 侧 bases/index.js 自动发现的产物)。
        // 只存 id、不存文本;真正的取舍在服务端 resolveBaseId 白名单,前端这里只负责挑。
        var bs = q('baseIdSel');
        if (!bs) return card;
        // 2026-11-25 C2：cfw_base_id_v1 与 neutral/custom 同源归一化（services/ui/settings-base-id.ts）
        var sel = window.settingsBaseId;
        var KB = sel.BASE_ID_KEY;
        var ids = Array.isArray(window.APP_BASE_IDS) ? window.APP_BASE_IDS : [];
        // 2026-10-05: 下拉里**不加任何注释** —— 文件名本身就是标签(用户按名字分辨效果),
        // 旧版那张 HINTS 短注表(base-1=Pyrite / base-2=GLM…)已删,免得改名后表里说法变假。
        bs.innerHTML = '<option value="">默认</option>' + ids.map(function (id) {
          return '<option value="' + esc(id) + '">' + esc(id) + '</option>';
        }).join('');
        // 存了个已不存在的 id(文件被删/改名)时,浏览器会把 select 落回空 → 界面自动显示「默认」,
        // 与 worker 的白名单回落一致(那边也会回落到默认档)。
        try { bs.value = sel.readSelection(KB); } catch (e) {}
        bs.addEventListener('change', function () {
          try { sel.writeSelection(KB, bs.value); } catch (e) {}
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
            // 2026-11-25 服务层搬迁：cfw_custom_id_v1 读写内聚在 services/ui/settings-base-id.ts
            //（window.settingsBaseId），与 prompt-profile.currentCustomId 读侧同源。
            var bid = window.settingsBaseId;
            try { cs.value = bid ? bid.read() : (localStorage.getItem('cfw_custom_id_v1') || ''); } catch (e) {}
            cs.addEventListener('change', function () {
              if (bid) bid.write(cs.value);
              else try { if (cs.value) localStorage.setItem('cfw_custom_id_v1', cs.value); else localStorage.removeItem('cfw_custom_id_v1'); } catch (e) {}
            });
          }
          wrap.appendChild(cs);
          var host = bs.parentNode && bs.parentNode.parentNode;
          if (host) host.insertBefore(wrap, bs.parentNode.nextSibling);
        }
        return card;
      }
    });
  }

  // ─── §基座目录. 内置 / 自定义 两套目录的切换（2026-11-14 从顶栏按钮降级到这里）───
  // 为什么搬：顶栏 #personaToggle 原来同时承担「切目录」（内置 bases/ ↔ 自定义 custom/）
  // 与「切档位」两种语义，在用户认知里又长期和 unlock.js 的私人解锁混为一谈。
  // 2026-11-14 该按钮改为「工作 / 角色扮演」，目录切换就只剩这一个入口 ——
  // 写 cfw_base_registry_v1，prompt-profile 的 baseIdPayload 每次装配请求现读，不用重绘。
  // 只在公开渠道构建（window.__baseSwitchMode）出现：私有版只有一套目录，给了也是空下拉。
  // 与 mountBaseIdCard 同样带 data-nsfw：未解锁态整卡不渲染，避免「切了目录却看不到档位」。
  function mountBaseRegistryCard() {
    if (!window.__baseSwitchMode) return;
    // 2026-11-28 card-shell batch 2: shell + declareCard; the __baseSwitchMode guard stays ahead
    // of the declaration (private builds must not even log), data-nsfw and prepend unchanged.
    window.slotRegistry.declareCard({
      id: 'baseRegistryCard',
      slotId: 'setChatSlot',
      build: function (slot) {
        var shell = window.cardShell.createCardShell({
          id: 'baseRegistryCard',
          title: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 7.5h6l1.6 2h9.4v9a1.5 1.5 0 0 1-1.5 1.5H4.5A1.5 1.5 0 0 1 3 18.5v-11z"/><path d="M3.5 7.5V6a1.5 1.5 0 0 1 1.5-1.5h4"/></svg>基座目录',
          desc: '两套目录，二选一：<b>内置</b>读 <code>src/prompts/bases/</code>，<b>自定义</b>读 <code>src/prompts/custom/</code>。选定目录后再到下面「基座提示词」卡里挑具体哪一份。',
          extra: '<div style="margin-top:10px;"><select id="baseRegistrySel" style="width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;"><option value="">内置（src/prompts/bases/）</option><option value="custom">自定义（src/prompts/custom/）</option></select></div>',
          tip: '切换后<b>下一轮</b>生效。两套目录各自记住选择，来回切不会丢；目录为空时使用默认档。'
        });
        var card = shell.card, q = shell.q;
        card.setAttribute('data-nsfw', '');
        slot.prepend(card);
        var sel = q('baseRegistrySel');
        if (!sel) return card;
        // 2026-11-25 C2：目录开关只有 custom / 内置两态，归一化归 services/ui/settings-base-id.ts
        var svc = window.settingsBaseId;
        try { sel.value = svc.readRegistry(); } catch (e) {}
        sel.addEventListener('change', function () {
          try { svc.writeRegistry(sel.value); } catch (e) {}
        });
        return card;
      }
    });
  }

  // ─── §联网搜索卡（2026-10-07 新增）───
  // 背景：联网由本项目的 Worker 代查：免费 DuckDuckGo/Bing 兜底；勾「深度搜索」时优先 DeepSeek
  // 搜索 API（2026-10-17 上线，/v1/tools/search），未配 key 再用 Exa。
  // 开关默认关（不静默把查询外发）；只对普通聊天生效，Agent 模式本来就有 web_search 工具。
  function mountWebSearchCard() {
    // 2026-11-28 card-shell batch 2: shell + declareCard. The two toggles stay hand-written:
    // the deep toggle's disabled gate rides on the master switch (master/sub gating is not the
    // single-control shape bindToggle covers), exactly as before.
    window.slotRegistry.declareCard({
      id: 'webSearchCard',
      slotId: 'setChatSlot',
      build: function (slot) {
        var shell = window.cardShell.createCardShell({
          id: 'webSearchCard',
          title: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>联网搜索',
          desc: '开启后，普通聊天遇到需要实时信息的问题（新闻、价格、版本、赛事…）时会自己搜索再回答，并在引用处附来源链接。搜索由<b>你自己的 Worker</b> 执行 —— 官方 API 里没有内置搜索，这里是把搜索工具挂在聊天请求上、由 Worker 侧跑。',
          extra: '<div class="rowline"><div class="toggle"><input type="checkbox" id="webSearchToggle"><label for="webSearchToggle">启用联网搜索</label></div>'
            + '<div class="toggle" style="margin-top:6px;"><input type="checkbox" id="webSearchDeepToggle"><label for="webSearchDeepToggle">深度搜索（DeepSeek / Exa，按次计费；DeepSeek ≈¥0.005/次）</label></div></div>'
            + '<div id="webSearchStatus" style="font-size:11px;color:var(--muted);margin-top:8px;"></div>',
          tip: '默认走免费的 DuckDuckGo,它不通时自动改用 <b>Bing</b>(同样免费);勾了「深度搜索」且 Worker 侧配了 <code>DEEPSEEK_SEARCH_API_KEY</code>（或复用 <code>DEEPSEEK_API_KEY</code>）时优先走 DeepSeek 搜索（<code>wrangler secret put DEEPSEEK_SEARCH_API_KEY</code>）；否则配了 <code>EXA_API_KEY</code> 走 Exa；都没配或调用失败则自动降级。开了联网的回复会比平时慢一些——要多 1~2 轮「搜索 + 复述结果」。查询词会发到你自己的 Worker 再转给搜索服务;Agent 模式的 <code>web_search</code> 工具不受此开关影响。'
        });
        var card = shell.card, q = shell.q;
        slot.appendChild(card);
        var t = q('webSearchToggle');
        var d = q('webSearchDeepToggle');
        var st = q('webSearchStatus');
        // 2026-11-25 服务层搬迁：读写口径（两键 === '1'、关主开关清深搜）内聚在
        // services/ui/settings-web-search.ts（window.settingsWebSearch），与 prompt-profile 读侧同源。
        var ws = window.settingsWebSearch;
        function paint() {
          var s = ws ? ws.read() : { enabled: localStorage.getItem('cfw_web_search_v1') === '1', deep: localStorage.getItem('cfw_web_search_deep_v1') === '1' };
          t.checked = s.enabled; d.checked = s.deep;
          d.disabled = !s.enabled;
          if (st) st.textContent = !s.enabled ? '未启用（聊天只靠模型自身知识）' : (s.deep ? '已启用：深搜(DeepSeek/Exa)优先，未配 key 自动降级' : '已启用：免费搜索(DuckDuckGo)');
        }
        t.addEventListener('change', function () {
          if (ws) ws.writeEnabled(t.checked);
          else { localStorage.setItem('cfw_web_search_v1', t.checked ? '1' : '0'); if (!t.checked) localStorage.setItem('cfw_web_search_deep_v1', '0'); }
          paint();
        });
        d.addEventListener('change', function () {
          if (ws) ws.writeDeep(d.checked);
          else localStorage.setItem('cfw_web_search_deep_v1', d.checked ? '1' : '0');
          paint();
        });
        paint();
        return card;
      }
    });
  }

  // ─── M1: 网页自定义人物模板卡(#customPrompt) ───
  // 保存逻辑由 app.js 按 ID 接线；settings.js 仅在 openPanel 时回填 LS 值(见 initPanelToggle)。
  // 2026-11-14：卡里补一个「注入内置角色提示词」开关（#useBuiltinToggle / cfw_use_builtin）——
  // 这个能力原来只在顶栏 #personaToggle 上（私有版构建点一下切内置/自定义），
  // 该按钮改为「工作 / 角色扮演」后，这里是它唯一的入口。文案里原来说的
  // 「仅在顶栏切到自定义」已不成立，一并改掉。
  function mountPersonaCard() {
    // 2026-11-28 card-shell batch 3: shell + declareCard, through the shell's new `lead` field —
    // this card's body order (h4 → toggle row → p → textarea → tip) puts a control row AHEAD of
    // the description, which the fixed h4/p/extra/tip order cannot express byte-identically; lead
    // is the pre-desc fragment slot. personaTemplateCard becomes the declareCard mount marker: the
    // old claim/guard id ('customPrompt') sat on the inner textarea while the card element already
    // carried personaTemplateCard. The textarea keeps id customPrompt (app.js wires it there) and
    // the toggle keeps useBuiltinToggle — both untouched.
    window.slotRegistry.declareCard({
      id: 'personaTemplateCard',
      slotId: 'setChatSlot',
      build: function (slot) {
        var shell = window.cardShell.createCardShell({
          id: 'personaTemplateCard',
          title: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>网页自定义人物模板',
          lead: '<div class="rowline" style="margin-bottom:8px;"><div class="toggle"><input type="checkbox" id="useBuiltinToggle"><label for="useBuiltinToggle">注入内置角色提示词</label></div></div>',
          desc: '关掉上面的开关 = 不发送内置的角色提示词，只发下面这段（当前会话有角色卡时，角色卡仍然优先）。适合你想完全接管人设的场合。仅本设备。',
          extra: '<textarea id="customPrompt" rows="5" placeholder="输入自定义人物设定或全局指令…" style="width:100%;box-sizing:border-box;padding:8px 10px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;resize:vertical;"></textarea>',
          tip: '这段只在上面开关关掉时发送；留空 = 不追加任何内容。'
        });
        var card = shell.card;
        slot.appendChild(card);
        var ub = document.getElementById('useBuiltinToggle');
        if (!ub) return card;
        // 2026-11-25 C5：缺省=开的归一化归 services/ui/settings-persona.ts，与 app.js 读侧同源。
        var persona = window.settingsPersona;
        ub.checked = persona.readUseBuiltin();
        ub.addEventListener('change', function () {
          persona.writeUseBuiltin(ub.checked);
          // app.js 把 useBuiltin 缓存在模块变量里（请求装配要用），靠这个广播让它重读。
          try { window.dispatchEvent(new CustomEvent('cfw:external-settings')); } catch (e) {}
        });
        return card;
      }
    });
  }

  function mountStaticSettingsCards() {
    // 2026-11-18 服务层搬迁：挂载顺序表在 services/ui/settings-card-order.ts（每步带理由、可被锁
    // 审计），这里只做「按 plan 查映射表调函数」。未知/缺失的 id 由 plan 过滤，不占位。
    const MOUNTS = {
      mountConvAutonameCard: mountConvAutonameCard,
      mountContextCard: mountContextCard,
      mountMemoryCard: mountMemoryCard,
      mountAuthCard: mountAuthCard,
      mountLocalHistoryCard: mountLocalHistoryCard,
      mountSyncCard: mountSyncCard,
      mountTopbarCostCard: mountTopbarCostCard,
      mountDeployCard: mountDeployCard,
      mountThemeCard: mountThemeCard,
      mountAmbientCard: mountAmbientCard,
      mountBackgroundCard: mountBackgroundCard,
      mountDisplayCard: mountDisplayCard,
      mountAppFxCard: mountAppFxCard,
      mountI18nCard: mountI18nCard,
      mountPanelToolsCard: mountPanelToolsCard,
      mountNeutralCard: mountNeutralCard,
      mountStateLayerCard: mountStateLayerCard,
      mountWebSearchCard: mountWebSearchCard,
      mountBaseIdCard: mountBaseIdCard,
      mountBaseRegistryCard: mountBaseRegistryCard,
      mountChatModeCard: mountChatModeCard,
      mountAutopilotCard: mountAutopilotCard,
      mountAgentToolsCard: mountAgentToolsCard,
      mountMultiAgentCard: mountMultiAgentCard,
      mountDevToolsCard: mountDevToolsCard,
      mountPersonaCard: mountPersonaCard,
      mountPersonalizeCard: mountPersonalizeCard,
      mountByoCard: mountByoCard,
      mountDeepSeekKitCard: mountDeepSeekKitCard,
      mountCustomPricingCard: mountCustomPricingCard,
      mountGenParamsCard: mountGenParamsCard,
      mountDataBackupCard: mountDataBackupCard,
    };
    const plan = window.planCardMounts(Object.keys(MOUNTS));
    for (let i = 0; i < plan.length; i++) {
      const fn = MOUNTS[plan[i]];
      if (typeof fn === "function") fn();
    }
  }

// 30-chat.js — 对话与账号：状态层 / 对话模式 / 显示 / 账号 / 同步卡 / 对话数据 / 个性化 / 自驱叙事。
// 由 settings.js 宿主的 init()/mountStaticSettingsCards() 调用；函数声明在同一 IIFE 内提升。
  // ─── §对话. 角色状态层开关（2026-10-05 新增）───
  // 回答「为什么默认就是 RP」:判定只有一条 —— 有角色卡就注入 Layer2 的【当前状态】那一段
  // (关系/情绪/好感/场景/摘要)。这个开关就是那个手动把手:关掉后角色卡照旧,只是不再注入状态。
  // 为什么单独成卡而不是塞进「回复风格」卡:那卡只管排版取材,这个名字也对不上(旧账就是乱放被挑过)。
  function mountStateLayerCard() {
    // 2026-11-28 card-shell batch 2 (B-group): the old guard id sat on the inner toggle
    // (stateLayerToggle, read by the prompt layer at request time) and the card element had no id
    // at all. The card-level id stateLayerCard is new; the toggle keeps its id and wiring, so the
    // two ids coexist — same shape as the topbarCostCard precedent in 10-appearance.js.
    window.slotRegistry.declareCard({
      id: 'stateLayerCard',
      slotId: 'setChatSlot',
      build: function (slot) {
        var shell = window.cardShell.createCardShell({
          id: 'stateLayerCard',
          title: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20V10"/><path d="M6 20v-6"/><path d="M18 20V4"/></svg>角色状态层',
          desc: '有角色卡时，服务端会把「【当前状态】」那一段（关系 / 情绪 / 好感度 / 场景 / 剧情摘要）接在 system 末尾。<b>关掉后角色卡照旧生效，只是不再注入这些状态</b>——想让它纯按角色卡演、不吃好感度与场景提示时用。',
          extra: '<div class="rowline"><div class="toggle"><input type="checkbox" id="stateLayerToggle"><label for="stateLayerToggle">注入角色状态层（【当前状态】/ 场景 / 摘要）</label></div></div>',
          tip: '切换后<b>下一轮</b>生效。默认开 —— 不是按模型判的，就一条规则：有角色卡就注入。工具/Agent 那条路径本来就不吃状态层。'
        });
        slot.appendChild(shell.card);
        return shell.card;
      }
    });
  }

  // 2026-10-05: 标题由「互动模式(Roleplay Mode)」改成「回复风格」,并交出了两个显示 toggle
  // (隐藏小按钮/隐藏统计小字 → 搬进「外观·显示设置」卡)。卡名与内容对齐:它现在只管回复风格。
  // 守卫 ID 随之从 hideMsgActionsToggle 换成本卡仍有的 replyStyleSel —— 否则 toggle 搬走后守卫失效,会反复重挂。
  // 2026-10-05: 标题由「互动模式(Roleplay Mode)」改成「回复风格」,并交出了两个显示 toggle
  // (隐藏小按钮/隐藏统计小字 → 搬进「外观·显示设置」卡)。卡名与内容对齐:它现在只管回复风格。
  // 守卫 ID 随之从 hideMsgActionsToggle 换成本卡仍有的 replyStyleSel —— 否则 toggle 搬走后守卫失效,会反复重挂。
  function mountChatModeCard() {
    // 2026-11-28 card-shell batch 2 (B-group): card-level id chatModeCard is new; the select keeps
    // its replyStyleSel id (the mount guard used to sit on it) and the settings host still reads it
    // by ID. Double-id shape, topbarCostCard precedent.
    window.slotRegistry.declareCard({
      id: 'chatModeCard',
      slotId: 'setChatSlot',
      build: function (slot) {
        var shell = window.cardShell.createCardShell({
          id: 'chatModeCard',
          title: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 19l8.5-8.5"/><path d="M15 4.5l.9 2 2 .9-2 .9-.9 2-.9-2-2-.9 2-.9z"/><path d="M6.5 4.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z"/></svg>回复风格',
          desc: '控制 AI 回复的取材与排版。<span data-nsfw>内容尺度已改为跟随私人模式:解锁即固定拉满,锁定即关闭,不再有等级或开关(退出按钮在设置面板底部)。</span>',
          extra: '<div style="margin-top:10px;"><div style="font-size:12px;color:var(--muted);margin-bottom:8px;">回复风格</div><select id="replyStyleSel" style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--border, #333);background:transparent;color:inherit;font-size:13px;"><option value="default">默认（交由角色卡决定）</option><option value="wechat">微信连发（1-2 句一条，多气泡连发）</option><option value="verbose">长段叙事（小说式丰满段落，写小说）</option></select></div>',
          tip: '单人普通对话<b>没有字数限制</b>,写小说请选 <b>长段叙事</b> 档。字数限制(150-250 字)只存在于鱼缸接龙/讨论模式,保持多人轮转节奏。'
        });
        slot.appendChild(shell.card);
        return shell.card;
      }
    });
  }

  // 显示设置卡 = 聊天区呈现的唯一去处(字号 / 字体 / 内容里的显示开关)。
  // 2026-10-05: 「隐藏小按钮」「隐藏统计小字」两个 toggle 从「互动模式」卡搬来 ——
  // 显示类开关原本被拆在两个类目里(字号字体在外观、两个 toggle 在对话),现在收拢到一处。
  // 接线不受影响:它们由 ID 查元素(见本文件 initPanelToggle 区),不依赖父节点。
  function mountDisplayCard() {
    // 2026-11-28 card-shell batch 2 (B-group): card-level id chatDisplayCard is new (the card
    // element had no id; the mount guard sat on the chatFontSizeRange slider). Every control id is
    // unchanged — the initPanelToggle wiring and 60-sync.js read them by ID. Double-id shape,
    // topbarCostCard precedent. Named chatDisplayCard, not displayCard: 60-sync.js already uses a
    // local "displayCard" variable for this very card's element.
    window.slotRegistry.declareCard({
      id: 'chatDisplayCard',
      slotId: 'setAppearanceThemeSlot',
      build: function (slot) {
        var shell = window.cardShell.createCardShell({
          id: 'chatDisplayCard',
          title: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h8M16 7h4M4 12h2M10 12h10M4 17h6M14 17h6"/><circle cx="14" cy="7" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="12" cy="17" r="2"/></svg>显示设置',
          desc: '调整聊天区字号、字体，以及聊天内容里的显示开关。<b>仅本设备生效</b>(不进云同步)，刷新页面也会保留。',
          extra: `<div style="margin-top:8px;"><label for="chatFontSizeRange" style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:6px;"><span>聊天字号</span><span id="chatFontSizeLabel" style="font-variant-numeric:tabular-nums;">13px</span></label><input type="range" id="chatFontSizeRange" min="12" max="22" step="1" value="13" style="width:100%;"></div><div style="margin-top:14px;"><div style="font-size:12px;color:var(--muted);margin-bottom:6px;">聊天字体</div><select id="chatFontFamilySel" style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--border, #333);background:transparent;color:inherit;font-size:13px;"><option value="">系统默认（苹方/微软雅黑）</option><option value='"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif'>圆体（PingFang）</option><option value='"Noto Serif SC", "Source Han Serif SC", "SimSun", serif'>宋体（Noto Serif）</option><option value='"Kaiti SC", "STKaiti", KaiTi, serif'>楷体（Kaiti）</option><option value='FangSong, STFangsong, serif'>仿宋（FangSong）</option><option value='ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'>等宽（Monospace）</option><option value="__custom__">自定义字体…</option></select></div><div class="rowline" style="margin-top:8px;align-items:center;gap:8px;"><input type="text" id="chatFontCustom" maxlength="200" placeholder="自定义字体名，如 LXGW WenKai, serif" style="flex:1;min-width:0;padding:8px 10px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;"><button class="smallbtn" id="chatFontCustomApply" type="button">应用</button><button class="smallbtn" id="chatFontCustomClear" type="button">清除</button></div><div class="font-preview" id="chatFontPreview" data-text-fx="off"><div class="font-preview-label">字体与出字效果</div><div class="font-preview-line" id="chatFontPreviewLine">落霞与孤鹜齐飞，秋水共长天一色。</div><div class="font-preview-foot"><span class="font-preview-text">改字体或换效果，这句话会重新演示一遍</span><button type="button" class="font-preview-replay" id="chatFontPreviewReplay">再看一遍</button></div></div><div style="margin-top:14px;"><div style="font-size:12px;color:var(--muted);margin-bottom:6px;">文字特效</div><select id="chatTextFxSel" style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--border, #333);background:transparent;color:inherit;font-size:13px;"><option value="off">无（默认）</option><option value="soft">轻（柔和投影）</option><option value="strong">强（更清晰的文字层次）</option></select></div><div class="rowline" style="margin-top:14px;"><div class="toggle"><input type="checkbox" id="hideMsgActionsToggle"><label for="hideMsgActionsToggle">隐藏消息行下方的小按钮(重试/删除/复制)</label></div></div><div class="rowline"><div class="toggle"><input type="checkbox" id="hideStatsToggle"><label for="hideStatsToggle">隐藏统计小字(token / 速度 / 累计费用)</label></div></div>`,
          tip: '字体预览与文字特效<b>仅本设备生效</b>，特效只作用于聊天正文，不影响设置/按钮；主题请到「外观风格」卡切换。wechat 连发模式会自动隐藏小按钮(同时被上面的 toggle 接管)。'
        });
        slot.appendChild(shell.card);
        return shell.card;
      }
    });
  }

  // Pilot card for declareCard (2026-11-27): the three-line boilerplate — pick / claim /
  // getElementById guard — moved into the registry, which also stamps data-card="authCard" and
  // fences a build() failure into a visible placeholder instead of a silent vanish. authCard is
  // the cleanest migration sample: its guard id sits on the card element itself, and the two
  // buttons are bound in 60-sync.js by ID lookup, so the mount entry stays decoupled from wiring.
  function mountAuthCard() {
    window.slotRegistry.declareCard({
      id: 'authCard',
      slotId: 'setAccountSlot',
      build: function (slot) {
        var card = document.createElement('div');
        card.className = 'card';
        card.id = 'authCard';
        card.innerHTML = `<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/></svg>访问码</h4><p>云同步需要访问码。登录后请求自动带访问码；退出后以访客身份使用你自己的模型渠道与 API Key。</p><div class="rowline"><div class="btns"><button class="smallbtn" id="authLoginBtn" type="button">输入访问码</button><button class="smallbtn danger" id="authLogoutBtn" title="清除本地保存的访问码">退出登录</button></div></div><div id="authStatus"></div>`;
        slot.appendChild(card);
        return card;
      }
    });
  }

  function mountSyncCard() {
    // 2026-11-28 card-shell batch 2 (B-group): card-level id syncCard is new (the card element had
    // no id; the mount guard sat on the syncEnableToggle). The toggle and every button/status id
    // are unchanged — 60-sync.js wires them by ID. No trailing tip on this card: the hint line and
    // the exclude details block ride in extra verbatim. Double-id shape, topbarCostCard precedent.
    window.slotRegistry.declareCard({
      id: 'syncCard',
      slotId: 'setAccountSlot',
      build: function (slot) {
        var shell = window.cardShell.createCardShell({
          id: 'syncCard',
          title: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.5 18.5a4.5 4.5 0 0 1-.7-8.95A5.5 5.5 0 0 1 17 9.1 3.7 3.7 0 0 1 16.8 18.5z"/></svg>云同步',
          desc: '同步到 Cloudflare KV，换浏览器或设备都能自动看到角色卡、指令模块、亲密度、费用与对话。<b>打开即全同步</b>：改动 30 秒内自动上传，其他设备自动跟进；「强制刷新」只在怀疑不一致时用。<b>不同步：</b>访问码与同步状态。渠道（聊天/图像）与 API Key 也随账号同步，换设备不用重填。',
          extra: '<div class="rowline"><div class="toggle"><input type="checkbox" id="syncEnableToggle"><label for="syncEnableToggle">启用云同步（聊天、角色卡、设置全部跟随）</label></div></div><div class="btns"><button class="smallbtn" id="syncNowBtn" title="立即把本机改动推上云（平时 30 秒内会自动推）"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v3.5h-3.5"/></svg>立即上传</button><button class="smallbtn" id="syncPullBtn" title="诊断用：重新对齐本机与云端（平时不需要点，改动会自动同步）">强制刷新</button><button class="smallbtn" id="syncExportBtn" data-dev-only><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15.5V5"/><path d="M8 8.5L12 4.5l4 4"/><path d="M5 14.5v3.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5v-3.5"/></svg>导出备份</button><button class="smallbtn" id="syncImportBtn" data-dev-only><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4.5V15"/><path d="M8 11l4 4 4-4"/><path d="M5 14.5v3.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5v-3.5"/></svg>导入备份</button><input type="file" id="syncImportFile" accept=".json" style="display:none"><button class="smallbtn danger" id="syncWipeBtn" title="用本机数据覆盖云端：先清空云端副本，再把本机数据完整上传。其他设备重新打开后自动跟上；本机数据不受影响。"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 6.5h15"/><path d="M9 6.5V5.2A1.7 1.7 0 0 1 10.7 3.5h2.6A1.7 1.7 0 0 1 15 5.2V6.5"/><path d="M6.8 6.5l.7 12.2a1.8 1.8 0 0 0 1.8 1.7h5.4a1.8 1.8 0 0 0 1.8-1.7l.7-12.2"/></svg>覆盖云端</button></div></div><div style="font-size:11px;color:var(--muted);margin-top:6px;">角色卡已随统一存储同步（D1 即同步）——「立即上传 / 强制刷新」只搬运设置与对话，不再推送/拉取角色卡。</div><div id="syncStatus" style="font-size:11px;color:var(--muted);margin-top:8px;"></div><div id="syncRealtimeStatus" style="font-size:11px;color:var(--muted);margin-top:4px;"></div><div id="syncQuotaWarn" style="font-size:11px;color:#f80;margin-top:4px;display:none;"></div><details id="cloudExcludeSection" style="margin-top:10px;"><summary style="cursor:pointer;font-size:12px;color:var(--muted);"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.5 16.5a4.2 4.2 0 0 1-.6-8.35A5.2 5.2 0 0 1 16.5 8"/><path d="M14.5 14l5 5M19.5 14l-5 5"/></svg>按角色/会话 只清云端（保留本地）</summary><div style="font-size:11px;color:var(--muted);margin:6px 0;line-height:1.5;">只把选中项从云端 KV 抹掉,本地保留且本设备不再上传(tombstone)。<b>会话</b>的云端副本随云同步自动维护。<b>跨设备注意:</b>排除清单仅本设备生效,其他仍持有该数据且未排除的设备改动后可能把它推回。</div><div id="cloudExcludeList" style="display:flex;flex-direction:column;gap:6px;"></div></details>'
        });
        slot.appendChild(shell.card);
        return shell.card;
      }
    });
  }

  // ─── 部署卡（T4-C）：宿主级操作，排在云同步/费用之后 ───
  // 卡体、部署包执行与首连三选一在 services/ui/settings-deploy.ts + tooling/l0/wiring/settings-deploy.js；
  // 这里只提供 mountXxx 入口，让它进 MOUNTS 与挂载顺序表。
  function mountDeployCard() {
    if (!window.settingsDeploy || typeof window.settingsDeploy.mountCard !== "function") return;
    window.settingsDeploy.mountCard();
  }

  // ─── 对话数据卡(#clearHistory) ───
  // 2026-11-27（所有者）：旧「保留本机历史」开关已退役 —— 关掉后对话不落盘、刷新即失忆，
  // 与现在的会话存储/云同步语义冲突，且没有正常使用场景。历史恒为开；这张卡只保留
  // 「清空全部会话」这一个危险操作入口，并说清记录是自动保存、跟随云同步的。
  // 旧的 #promptKeep「追加自定义提示词」同样是死开关：它只 gate 早已没有保存按钮的 #customPrompt，
  // 2026-11-27 连同接线一并删除。
  function mountLocalHistoryCard() {
    // 2026-11-28: card-shell batch 2 (B-group) merged with origin/main's "对话数据" rework.
    // The two dead toggles are gone for good (owner, 2026-11-27): 保留本机历史 关掉=刷新失忆,
    // 与现在的会话存储/云同步语义冲突; 追加自定义提示词 只 gate 一个早已没有保存按钮的输入框。
    // History is always on, the prompt is always sent — this card now only owns the destructive
    // "clear everything" entry, and says plainly that records are saved and synced automatically.
    // declareCard moves the mount probe onto the card element; the clear button keeps its id
    // (app.js wires #clearHistory by ID). Origin's tip sits above the warning, so both ride in
    // extra verbatim to keep that order — the shell's tip field would emit after extra.
    window.slotRegistry.declareCard({
      id: 'localHistoryCard',
      slotId: 'setAccountSlot',
      build: function (slot) {
        var shell = window.cardShell.createCardShell({
          id: 'localHistoryCard',
          title: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="5.5" rx="7.5" ry="2.8"/><path d="M4.5 5.5v6c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-6"/><path d="M4.5 11.5v6c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-6"/></svg>对话数据',
          desc: '对话会自动保存在本机，并随「云同步」同步；刷新或重开会自动恢复。',
          extra: '<div class="settings-tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg><span>想清掉个别会话，到左栏「对话」里删；这里只保留清空全部会话的入口。</span></div>'
            + '<div class="settings-warn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg><span>清空全部会话会删除本设备所有会话的对话记录与剧情摘要，并同步删除云端备份，不可撤销。</span></div>'
            + '<div class="rowline" style="margin-top:8px;justify-content:flex-end;"><div class="btns"><button class="smallbtn danger" id="clearHistory">清空全部会话</button></div></div>'
        });
        slot.appendChild(shell.card);
        return shell.card;
      }
    });
  }

  // ─── 数据备份卡（T3-E）：全量 ZIP 导出 / 导入 ───
  // 卡体与两个平台出口在 tooling/l0/wiring/backup.js（window.backupCard / window.backupSvc）；
  // 这里只提供 mountXxx 入口，让它进 MOUNTS 与挂载顺序表（与 T4-C 的部署卡同一种接法）。
  function mountDataBackupCard() {
    if (!window.backupCard || typeof window.backupCard.mount !== 'function') return;
    window.backupCard.mount();
  }

  // ─── 2026-11-11: Agent 个性化（对齐 ZCode 设置 → 个性化）───
  // 独立于「网页自定义人物模板」：只作用于 Agent 模式的后续会话，不受顶栏「内置/自定义」和角色卡影响。
  // 字节预算/trim 空删除 + 读侧判定已下沉 services/ui/settings-personalize.ts（window.settingsPersonalize），
  // 与 engine/app.js 的请求注入共用同一套语义；本卡只留 textarea、计数标签与事件。
  function mountPersonalizeCard() {
    // 2026-11-28 card-shell batch 2 (B-group): the card element already carried id
    // agentPersonalizeCard; the mount guard sat on the inner agentPersonalize textarea. The probe
    // moves onto the card and the textarea keeps its id (the settings host reads card
    // .__agentPersonalizeReset and app-side code wires the textarea by ID). Double-id shape.
    window.slotRegistry.declareCard({
      id: 'agentPersonalizeCard',
      slotId: 'setPersonalizeSlot',
      build: function (slot) {
        var shell = window.cardShell.createCardShell({
          id: 'agentPersonalizeCard',
          title: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="3.4"/><path d="M5.5 19a6.5 6.5 0 0 1 13 0"/><path d="M18.6 5.1l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z"/></svg>个性化',
          desc: '添加自定义指令来个性化 Agent 的回复，指令会应用到你本机 Agent 的后续会话；远程设备需单独配置。仅本设备。',
          extra: '<textarea id="agentPersonalize" rows="10" spellcheck="false" style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;font:inherit;font-size:13px;line-height:1.65;resize:vertical;min-height:220px;"></textarea>'
            + '<div class="rowline" style="justify-content:space-between;align-items:center;margin-top:6px;gap:12px;"><span id="agentPersonalizeCount" style="font-size:11px;color:var(--muted);white-space:nowrap;">0 B / 100 KB</span><div class="btns"><button class="smallbtn" id="agentPersonalizeSave" type="button">保存</button><button class="smallbtn" id="agentPersonalizeCancel" type="button">取消</button></div></div>',
          tip: '保存后从下一条消息开始生效；清空并保存 = 关闭。指令只存本机，不上云。'
        });
        var card = shell.card;
        slot.appendChild(card);
        var ta = card.querySelector('#agentPersonalize');
        var countEl = card.querySelector('#agentPersonalizeCount');
        var saveBtn = card.querySelector('#agentPersonalizeSave');
        var cancelBtn = card.querySelector('#agentPersonalizeCancel');
        var _pers = window.settingsPersonalize;
        var saved = "";
        function renderCount() {
          var n = _pers.byteLen(ta.value);
          var over = _pers.isOverLimit(ta.value);
          if (countEl) {
            countEl.textContent = _pers.fmtBytes(n) + ' / 100 KB';
            countEl.style.color = over ? 'var(--danger, #e8607d)' : 'var(--muted)';
          }
          if (saveBtn) saveBtn.disabled = over;
        }
        // 每次打开设置都回读已保存值，同时把「取消」的基准线同步成 LS —— 否则上次的未保存文本会被当成基准。
        function resetFromLS() {
          saved = _pers.readRaw();
          ta.value = saved;
          renderCount();
        }
        card.__agentPersonalizeReset = resetFromLS;
        ta.addEventListener('input', renderCount);
        if (saveBtn) saveBtn.addEventListener('click', function () {
          var v = ta.value;
          var result = _pers.save(v);
          if (!result.stored) return;
          saved = v;
          try { if (window.feedbackSvc && window.feedbackSvc.toast) window.feedbackSvc.toast(result.trimmed ? '个性化指令已保存' : '个性化指令已清空', 1800); } catch (e) {}
        });
        if (cancelBtn) cancelBtn.addEventListener('click', function () {
          ta.value = saved;
          renderCount();
        });
        resetFromLS();
        return card;
      }
    });
  }

  // ─── 自驱叙事控制卡(autopilot.js 的入口 UI · 决策 O 默认半自动) ───
  // 写 cfw_autopilot_* + cfw_address_mode_v1 + cfw_choices_freq_v1;开始/停止直接调 window.autopilotSvc。仅本设备。挂 #setChatSlot。
  function mountAutopilotCard() {
    // 2026-11-28 card-shell batch 2: shell + declareCard; the guard id already sat on the card
    // element, so the declaration is direct. The six-key wiring below is unchanged hand-written
    // code (mode migration + start/stop are not single-control bind shapes).
    window.slotRegistry.declareCard({
      id: 'autopilotCard',
      slotId: 'setChatSlot',
      build: function (slot) {
        // 2026-11-25 C3：六个键与全部 default/clamp 归 services/agent/autopilot.ts
        //（window.autopilotCfg），卡片不再抄一份 key 表与夹取规则。
        var apCfg = window.autopilotCfg;
        var K = apCfg.LS;
        function g(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
        function set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
        // 字段材质归 .field-input 共享类（styles-controls.css）；SS/LB 内联串与类值逐字节相同，仅
        // flex:1 / min-width 留作变体类，渲染逐位不变。
        var shell = window.cardShell.createCardShell({
          id: 'autopilotCard',
          title: '自驱叙事',
          desc: '让 AI 自己一段段往下写,不用每次催。<b>半自动</b>每段停下给「继续 / 选项 / 自己写」,<b>全自动</b>按节拍连演。「一句话把活干完」的工作模式不在这,走 Agent。随时 <b>Shift+Esc</b> 全停。<b>仅本设备</b>。',
          extra: '<div class="rowline" style="align-items:center;gap:10px;"><label class="field-label field-label--w56">模式</label><select id="apMode" class="field-input field-input--grow"><option value="">关</option><option value="novel">小说叙事</option></select></div>'
            + '<div class="rowline" style="align-items:center;gap:10px;"><label class="field-label field-label--w56">推进</label><select id="apAuto" class="field-input field-input--grow"><option value="half">半自动（每段停一下）</option><option value="full">全自动（连续演）</option></select></div>'
            + '<div class="rowline" style="align-items:center;gap:10px;"><label class="field-label field-label--w56">视角</label><select id="apAddress" class="field-input field-input--grow"><option value="dialogue">对话（只对你说话）</option><option value="immersive">沉浸（带动作旁白）</option><option value="narration">小说（第三人称）</option></select></div>'
            + '<div class="rowline" style="align-items:center;gap:10px;"><label class="field-label field-label--w56">选项</label><select id="apChoices" class="field-input field-input--grow"><option value="off">不给选项</option><option value="fork">岔路口才给(默认)</option><option value="every">每段都给</option></select></div>'
            + '<div class="rowline" style="align-items:center;gap:10px;"><label class="field-label field-label--w56">最多段</label><input type="number" id="apMaxSeg" min="1" max="1000" class="field-input field-input--num" style="width:90px;"></div>'
            + '<div class="rowline"><div class="toggle"><input type="checkbox" id="apGateTts"><label for="apGateTts">读完一段再演下一段(仅桌面 TTS)</label></div></div>'
            + '<div class="rowline"><div></div><div class="btns"><button class="smallbtn" id="apStart" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.5 4.9v14.2L19.5 12z"/></svg>开始自驱</button><button class="smallbtn danger" id="apStop" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="1.8"/></svg>停止</button></div></div>'
            + '<div id="apStatus" style="font-size:11px;color:var(--muted);margin-top:8px;"></div>',
          tip: '半自动暂停时直接在输入框打字发送会自动接管。需 index.html 已引入 autopilot.js。'
        });
        var card = shell.card;
        slot.appendChild(card);
        function q(id) { return card.querySelector(id); }
        var mode = q('#apMode'), auto = q('#apAuto'), address = q('#apAddress'), choices = q('#apChoices'), maxSeg = q('#apMaxSeg'), gateTts = q('#apGateTts'), statusEl = q('#apStatus');
        // 2026-09-10: 老 LS 里存的 'rp' 下拉里已没这个 option,不归一的话 select 会变成空值(看着像「设置丢了」)
        var _mr = g(K.mode, '');
        if (apCfg.needsModeMigration(_mr)) set(K.mode, apCfg.modeOf(_mr));
        mode.value = apCfg.modeOf(_mr);
        auto.value = apCfg.autoOf(g(K.auto, null));
        address.value = apCfg.addressOf(g(K.address, null));
        choices.value = apCfg.choicesOf(g(K.choices, null));
        maxSeg.value = String(apCfg.maxSegments(g(K.maxSeg, null)));
        gateTts.checked = apCfg.gateTts(g(K.gateTts, null));
        mode.addEventListener('change', function () { set(K.mode, mode.value); });
        auto.addEventListener('change', function () { set(K.auto, auto.value); });
        address.addEventListener('change', function () { set(K.address, address.value); });
        choices.addEventListener('change', function () { set(K.choices, choices.value); });
        maxSeg.addEventListener('change', function () { var n = apCfg.maxSegments(maxSeg.value); maxSeg.value = String(n); set(K.maxSeg, String(n)); });
        gateTts.addEventListener('change', function () { set(K.gateTts, gateTts.checked ? '1' : '0'); });
        function setMsg(t) { if (statusEl) statusEl.textContent = t || ''; }
        q('#apStart').addEventListener('click', function () {
          if (!window.autopilotSvc) { setMsg('自驱引擎未加载(检查 index.html 是否引了 autopilot.js)'); return; }
          var r = window.autopilotSvc.start({ mode: mode.value });
          if (r && r.ok) setMsg('已开始：小说叙事 / ' + (auto.value === 'full' ? '全自动' : '半自动'));
          else setMsg('没开起来:' + ((r && r.reason) || '未知'));
        });
        q('#apStop').addEventListener('click', function () { if (window.autopilotSvc) window.autopilotSvc.stop('user-stop'); setMsg('已停止'); });
        try { if (window.autopilotSvc && window.autopilotSvc.onTick) window.autopilotSvc.onTick(function (st) { setMsg('状态:' + st.state + '，第 ' + st.seg + ' 段'); }); } catch (e) {}
        return card;
      }
    });
  }

  // ─── 2026-11-26 i18n v2：记忆/压缩卡的文案全部走 catalog（public/locales/<lang>.json）。
  // 卡片在 DOMContentLoaded 挂载，此时 catalog 通常已就位；copyReady 只是把「极端慢盘」这一种
  // 情况变成延后挂载，而不是把 key 画到页面上。key 的语义见 docs/i18n/rules.md。
  function copyReady(fn) {
    try {
      if (window.__i18n && typeof window.__i18n.whenReady === "function") { window.__i18n.whenReady(fn); return; }
    } catch (e) { /* 引擎缺席时照旧直画（legacy 字典兜底） */ }
    fn();
  }
  function T(key, params) {
    try { return window.__i18n.t(key, params); } catch (e) { return key; }
  }

  // ─── 2026-11-25：上下文压缩参数（触发条数 / 保留条数 / token 水位比例）───
  // 键、默认值、夹取范围都在 services/chat/context.ts 的 COMPACT_* 表；这里只画卡与写回。
  // 卡片取一个只用于配置的 context 实例（compactConfig 不读会话/DOM）。
  function mountContextCard() {
    copyReady(mountContextCardNow);
  }

  function mountContextCardNow() {
    // 2026-11-28 card-shell batch 2: shell + declareCard. The __context guard stays ahead of the
    // declaration: the old code warned and skipped silently when the engine was absent, and a
    // build() inside declareCard would instead fence an error card.
    if (!window.__context) { console.warn('[settings] 缺少 __context，上下文压缩卡未挂载'); return; }
    window.slotRegistry.declareCard({
      id: 'contextCompactCard',
      slotId: 'setChatSlot',
      build: function (slot) {
        var ctxApi = window.__context.create({});
        var cfg = ctxApi.compactConfig();
        var shell = window.cardShell.createCardShell({
          id: 'contextCompactCard',
          title: T('settings.compact.title'),
          desc: T('settings.compact.intro'),
          extra: '<div class="rowline"><div class="toggle"><input type="checkbox" id="ctxCompactEnabled"><label for="ctxCompactEnabled">' + T('settings.compact.enabled') + '</label></div></div>'
            + '<div class="rowline" style="align-items:center;gap:10px;"><label class="field-label field-label--w72">' + T('settings.compact.trigger') + '</label><input type="number" id="ctxTrigger" min="10" max="200" step="1" class="field-input field-input--num field-input--w96"><span style="font-size:11px;color:var(--muted);">' + T('settings.compact.triggerHint') + '</span></div>'
            + '<div class="rowline" style="align-items:center;gap:10px;"><label class="field-label field-label--w72">' + T('settings.compact.keep') + '</label><input type="number" id="ctxKeep" min="2" max="50" step="1" class="field-input field-input--num field-input--w96"><span style="font-size:11px;color:var(--muted);">' + T('settings.compact.keepHint') + '</span></div>'
            + '<div class="rowline" style="align-items:center;gap:10px;"><label class="field-label field-label--w72">' + T('settings.compact.ratio') + '</label><input type="number" id="ctxRatio" min="0.3" max="0.95" step="0.05" class="field-input field-input--num field-input--w96"><span style="font-size:11px;color:var(--muted);">' + T('settings.compact.ratioHint') + '</span></div>',
          tip: T('settings.compact.tip')
        });
        var card = shell.card;
        slot.appendChild(card);
        var enabled = card.querySelector('#ctxCompactEnabled');
        var trigger = card.querySelector('#ctxTrigger');
        var keep = card.querySelector('#ctxKeep');
        var ratio = card.querySelector('#ctxRatio');
        function paint(c) {
          enabled.checked = c.enabled;
          trigger.value = String(c.trigger);
          keep.value = String(c.keep);
          ratio.value = String(c.ratio);
        }
        paint(cfg);
        enabled.addEventListener('change', function () { paint(ctxApi.setCompactConfig({ enabled: enabled.checked })); });
        trigger.addEventListener('change', function () { paint(ctxApi.setCompactConfig({ trigger: trigger.value })); });
        keep.addEventListener('change', function () { paint(ctxApi.setCompactConfig({ keep: keep.value })); });
        ratio.addEventListener('change', function () { paint(ctxApi.setCompactConfig({ ratio: ratio.value })); });
        return card;
      }
    });
  }

  // ─── 2026-11-25：角色记忆参数（总开关 / 向量腿 / 召回与注入上限 / 自动写入）───
  // 默认值与夹取在 services/memory/config.ts；卡片通过 __memCore.config 读写，读侧同一张表。
  function mountMemoryCard() {
    copyReady(mountMemoryCardNow);
  }

  function mountMemoryCardNow() {
    // 2026-11-28 card-shell batch 2: shell + declareCard; the __memCore guard stays ahead of the
    // declaration (old code warned and skipped silently — see mountContextCardNow).
    var mem = window.__memCore;
    if (!mem || !mem.config) { console.warn('[settings] 缺少 __memCore.config，角色记忆卡未挂载'); return; }
    window.slotRegistry.declareCard({
      id: 'memorySettingsCard',
      slotId: 'setChatSlot',
      build: function (slot) {
        var api = mem.config;
        var c = api.read();
        var lim = api.limits;
        var shell = window.cardShell.createCardShell({
          id: 'memorySettingsCard',
          title: T('settings.memory.title'),
          desc: T('settings.memory.intro'),
          extra: '<div class="rowline"><div class="toggle"><input type="checkbox" id="memEnabledToggle"><label for="memEnabledToggle">' + T('settings.memory.enabled') + '</label></div></div>'
            + '<div class="rowline"><div class="toggle"><input type="checkbox" id="memVecToggle"><label for="memVecToggle">' + T('settings.memory.vecEnabled') + '</label></div></div>'
            + '<div class="rowline" style="align-items:center;gap:10px;"><label class="field-label field-label--w72">' + T('settings.memory.recallK') + '</label><input type="number" id="memRecallK" min="' + lim.recallK.min + '" max="' + lim.recallK.max + '" step="1" class="field-input field-input--num field-input--w88"><span style="font-size:11px;color:var(--muted);">' + T('settings.memory.recallKHint') + '</span></div>'
            + '<div class="rowline" style="align-items:center;gap:10px;"><label class="field-label field-label--w72">' + T('settings.memory.injectChunks') + '</label><input type="number" id="memInjectChunks" min="' + lim.injectMaxChunks.min + '" max="' + lim.injectMaxChunks.max + '" step="1" class="field-input field-input--num field-input--w88"><span style="font-size:11px;color:var(--muted);">' + T('settings.memory.injectChunksHint') + '</span></div>'
            + '<div class="rowline" style="align-items:center;gap:10px;"><label class="field-label field-label--w72">' + T('settings.memory.injectChars') + '</label><input type="number" id="memInjectChars" min="' + lim.injectMaxChars.min + '" max="' + lim.injectMaxChars.max + '" step="50" class="field-input field-input--num field-input--w88"><span style="font-size:11px;color:var(--muted);">' + T('settings.memory.injectCharsHint') + '</span></div>'
            + '<div class="rowline"><div class="toggle"><input type="checkbox" id="memAutoWrite"><label for="memAutoWrite">' + T('settings.memory.autoWrite') + '</label></div></div>',
          tip: T('settings.memory.tip')
        });
        var card = shell.card;
        slot.appendChild(card);
        var enabled = card.querySelector('#memEnabledToggle');
        var vec = card.querySelector('#memVecToggle');
        var recallK = card.querySelector('#memRecallK');
        var chunks = card.querySelector('#memInjectChunks');
        var chars = card.querySelector('#memInjectChars');
        var auto = card.querySelector('#memAutoWrite');
        function paint(next) {
          enabled.checked = next.enabled;
          vec.checked = next.vecEnabled;
          recallK.value = String(next.recallK);
          chunks.value = String(next.injectMaxChunks);
          chars.value = String(next.injectMaxChars);
          auto.checked = next.autoWrite;
        }
        paint(c);
        enabled.addEventListener('change', function () { paint(api.write({ enabled: enabled.checked })); });
        vec.addEventListener('change', function () { paint(api.write({ vecEnabled: vec.checked })); });
        recallK.addEventListener('change', function () { paint(api.write({ recallK: recallK.value })); });
        chunks.addEventListener('change', function () { paint(api.write({ injectMaxChunks: chunks.value })); });
        chars.addEventListener('change', function () { paint(api.write({ injectMaxChars: chars.value })); });
        auto.addEventListener('change', function () { paint(api.write({ autoWrite: auto.checked })); });
        return card;
      }
    });
  }

// 40-agent.js — Agent 与开发：多智能体 / 开发工具 / 工具集档位 / 生成参数读取。
// 由 settings.js 宿主的 init()/mountStaticSettingsCards() 调用；函数声明在同一 IIFE 内提升。
  // ─── 多智能体编排（2026-10-08 从「Agent 工作模式」卡拆出）───
  // 用户口径：编排玩法与工作能力是两件事，各占一张卡。工具是否注册由 tools.js 的 MA_GATED
  // 三重条件共同决定：① 侧栏「多智能体」模式开着 ② 本卡对应开关开着 ③ 当前不是子 agent 档。
  function mountMultiAgentCard() {
    // 2026-11-28 card-shell batch 3: the pick/claim/getElementById boilerplate moved into
    // slotRegistry.declareCard (the guard id already sat on the card element) and the card/h4/p/
    // rows/tip skeleton into cardShell.createCardShell. The bindEl calls below are byte-for-byte
    // the ones batch 2 landed — only the shell around them changed.
    window.slotRegistry.declareCard({
      id: 'multiAgentCard',
      slotId: 'setAgentSlot',
      build: function (slot) {
        var SS = 'flex:1;padding:7px 9px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;';
        var shell = window.cardShell.createCardShell({
          id: 'multiAgentCard',
          title: '多智能体编排',
          // 本段刻意写成"整句单文本节点"（不带 <b> 内联标签）：双语引擎按文本节点整串匹配，
          // 带标签的句子会被切成碎片、字典键难对（这是上一批翻译踩过的坑）。
          desc: '先在侧栏打开「多智能体」模式，再按下面开关逐个放行；模式关闭时 = 单 agent，不挂任何编排工具。平级 agent = 你配置好的角色卡（各有独立上下文）；子 agent = 主 agent 现造的临时工（最小权限、任务完成即回收，不进聊天记录）。',
          extra: '<div class="rowline"><div class="toggle"><input type="checkbox" id="maDelegate"><label for="maDelegate">主子分派（允许派子 agent 干活）</label></div></div>'
            + '<div class="rowline"><div class="toggle"><input type="checkbox" id="maMeeting"><label for="maMeeting">私下小会（向角色私下征询，结论不进时间线）</label></div></div>'
            + '<div class="rowline"><div class="toggle"><input type="checkbox" id="maInvite"><label for="maInvite">请角色上台（角色可直接在时间线回答）</label></div></div>'
            + '<div class="rowline" style="align-items:center;gap:8px;flex-wrap:wrap;"><label style="font-size:12px;color:var(--muted);min-width:52px;">小会</label>'
            + '<input id="maMeetMax" type="number" min="1" max="6" step="1" style="' + SS + 'max-width:76px;" title="每次小会最多几位角色（每位都是一次独立计费调用）"> <span style="font-size:11px;color:var(--muted);">人数上限</span>'
            + '<input id="maMeetRounds" type="number" min="1" max="2" step="1" style="' + SS + 'max-width:76px;" title="2 = 第二轮参与者能看到彼此答案、互相补充或反驳（成本约翻倍）"> <span style="font-size:11px;color:var(--muted);">轮数</span>'
            + '<input id="maCtxMsgs" type="number" min="0" max="400" step="10" style="' + SS + 'max-width:88px;" title="每位角色带多少条自己的上下文（0 = 全带；条数越多越贵）"> <span style="font-size:11px;color:var(--muted);">上下文条数</span></div>',
          tip: '成本提示：小会里每位角色都是一次独立计费调用，轮数 2 约等于翻倍；子 agent 继承最小权限，不碰你的数据与时间线。'
        });
        var card = shell.card;
        slot.appendChild(card);

        // 2026-11-25 服务层搬迁：六键的默认值与 clamp 内聚在 services/ui/settings-multi-agent.ts
        //（window.settingsMultiAgent），读侧 peer-calls.cfg() 用同一套口径——修掉「卡片默认 3、引擎默认 6」
        // 的漂移。localStorage 原样保留作服务缺席时的回落（旧缓存页行为不丢）。
        // 2026-11-27 绑定微原语：六控件的手写五步（查元素/回显/监听/写/回落）收敛为 bindToggle/bindNumber
        // 调用（window.bindEl）。键名、默认值、clamp 区间与「键没值=开/默认」口径原样保留；服务/LS 双路径
        // 由 opts 的两条函数对表达——ma 在场传 read/write，缺席传 null 走 fallback（bind 原语负责选路）。
        var ma = window.settingsMultiAgent;
        // 开关与上限（tools.js 的 MA_GATED / app.js 的 _maCfg 读这些键；键"没值"= 开/默认，
        // 这样老用户不用先来这里点一遍）
        function swBind(sel, key) {
          return window.bindEl.bindToggle(card, sel, {
            key: key,
            read: ma ? function () { return ma.readSwitch(key); } : null,
            write: ma ? function (on) { ma.writeSwitch(key, on); } : null,
            fallbackGet: function () { try { var v = localStorage.getItem(key); return v == null ? true : v === '1'; } catch (e) { return true; } },
            fallbackSet: function (on) { try { localStorage.setItem(key, on ? '1' : '0'); } catch (e) {} },
          });
        }
        swBind('#maDelegate', 'cfw_ma_delegate_v1');
        swBind('#maMeeting', 'cfw_ma_meeting_v1');
        swBind('#maInvite', 'cfw_ma_invite_v1');
        function capBind(sel, key, def, lo, hi) {
          return window.bindEl.bindNumber(card, sel, {
            key: key, min: lo, max: hi, default: def, parse: null,
            read: ma ? function () { return ma.readCap(key, def, lo, hi); } : null,
            write: ma ? function (raw) { return ma.writeCap(key, raw, def, lo, hi); } : null,
            fallbackGet: function () { try { return localStorage.getItem(key); } catch (e) { return null; } },
            fallbackSet: function (text) { try { localStorage.setItem(key, text); } catch (e) {} },
          });
        }
        capBind('#maMeetMax', 'cfw_ma_meeting_max_v1', 3, 1, 6);
        capBind('#maMeetRounds', 'cfw_ma_meeting_rounds_v1', 1, 1, 2);
        capBind('#maCtxMsgs', 'cfw_ma_ctx_msgs_v1', 60, 0, 400);
        return card;
      }
    });
  }

  // ─── 2026-11-06：开发工具卡（源码/产物检索；本地 source-server） ───
  function mountDevToolsCard() {
    // 2026-11-28 card-shell batch 3: shell + declareCard. The old mount never claimed its card id
    // (plain pick + guard); declareCard records the claim on a successful mount — a ledger-only
    // difference, the DOM path is unchanged. The card has no settings-tip: its tail (rows + test
    // button + status line) rides in `extra` verbatim.
    window.slotRegistry.declareCard({
      id: 'sourceToolsCard',
      slotId: 'setCostSlot',
      build: function (slot) {
        // 2026-11-08 修(审查 P0/P1): ① id 改名 sourceToolsCard —— 旧 id 与 dev.js 的开发者工具卡
        // 冲突(同名 id 静默互吞,本卡永不出现); ② 补本地 SS(旧版引用未定义变量,潜伏 ReferenceError)
        var SS = 'flex:1;padding:7px 9px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;';
        var shell = window.cardShell.createCardShell({
          id: 'sourceToolsCard',
          title: '开发工具 · 源码/产物检索',
          desc: '给 agent 的 <code>list_source / search_source / read_source / list_artifacts / read_artifact</code> 提供本地只读服务。先在本机运行：<code>node tooling/scripts/dev/source-server.mjs --root .</code>（可选 <code>--artifacts 目录</code>）。服务只绑 127.0.0.1，不上传数据。',
          extra: '<div class="rowline" style="align-items:center;gap:10px;"><label style="font-size:12px;color:var(--muted);min-width:72px;">源码服务</label><input id="devSrcUrl" type="text" placeholder="http://127.0.0.1:8797" style="' + SS + '"></div>'
            + '<div class="rowline" style="align-items:center;gap:10px;margin-top:8px;"><label style="font-size:12px;color:var(--muted);min-width:72px;">产物 URL</label><input id="devArtUrl" type="text" placeholder="http://127.0.0.1:8796/artifacts" style="' + SS + '"></div>'
            + '<div class="rowline" style="margin-top:8px;"><div class="toggle"><input type="checkbox" id="devToolsOn"><label for="devToolsOn">启用（下次开 Agent 生效）</label></div></div>'
            + '<div class="btns" style="margin-top:6px;"><button class="smallbtn" id="devToolsTest">测试连接</button></div>'
            + '<div id="devToolsStatus" style="font-size:11px;color:var(--muted);margin-top:6px;"></div>'
        });
        var card = shell.card;
        slot.appendChild(card);
        var u = card.querySelector('#devSrcUrl'), a = card.querySelector('#devArtUrl'), on = card.querySelector('#devToolsOn'), st = card.querySelector('#devToolsStatus');
        // 2026-11-25 服务层搬迁：三键读写与归一化内聚在 services/ui/settings-dev-tools.ts
        //（window.settingsDevTools），读侧 source-tools.ts 用同一套 normalizeSourceToolsOn。
        var dst = window.settingsDevTools;
        function read() {
          // 服务返回 sourceToolsOn 布尔（已按 hostname 归一）；回落路径保留原始三态字符串 '1'/'0'/''。
          if (dst) { var s = dst.read(); return { u: s.sourceUrl, a: s.artifactUrl, on: s.sourceToolsState === '' ? '' : (s.sourceToolsOn ? '1' : '0') }; }
          try { return { u: localStorage.getItem('cfw_source_url_v1') || '', a: localStorage.getItem('cfw_artifact_url_v1') || '', on: localStorage.getItem('cfw_source_tools_on_v1') || '' }; } catch (e) { return { u: '', a: '', on: '' }; }
        }
        function paint() {
          var c = read(); u.value = c.u; a.value = c.a; on.checked = c.on === '1';
          st.textContent = c.on === '1' ? '已启用（服务未启动时工具会报不可达）。' : (c.on === '0' ? '已关闭。' : '未设置：localhost 默认开、线上默认关。');
        }
        function save() {
          if (dst) dst.write({ sourceUrl: u.value, artifactUrl: a.value, sourceToolsOn: on.checked });
          else try {
            localStorage.setItem('cfw_source_url_v1', u.value.trim());
            localStorage.setItem('cfw_artifact_url_v1', a.value.trim());
            localStorage.setItem('cfw_source_tools_on_v1', on.checked ? '1' : '0');
          } catch (e) {}
          paint();
        }
        u.addEventListener('change', save); a.addEventListener('change', save); on.addEventListener('change', save);
        card.querySelector('#devToolsTest').addEventListener('click', async function () {
          var url = (u.value.trim() || 'http://127.0.0.1:8797').replace(/\/+$/, '');
          st.textContent = '测试中…';
          try {
            var r = await fetch(url + '/health', { cache: 'no-store' });
            var j = await r.json();
            st.textContent = j && j.ok ? ('连接成功：roots=' + (j.roots || []).join(', ')) : '返回异常';
          } catch (e) { st.textContent = '连不上：' + String((e && e.message) || e); }
        });
        paint();
        return card;
      }
    });
  }

  // ─── Agent 工具集档位(对应 shared/agent/tools.js 里的 CORE_TOOLS 门控 · LS cfw_agent_tools_v1) ───
  // 两档: core(常用) / full(全量,自检时才开)。档位数在卡内动态点数（作者会持续加工具）。
  function mountAgentToolsCard() {
    // 2026-09-14:Agent 配置独立成分类(工具档位 / 轮数 / 工作模式);旧页面回落 #setChatSlot
    // 2026-11-28 card-shell batch 3: the pick/claim/getElementById boilerplate moved into
    // slotRegistry.declareCard (the guard id already sat on the card element) and the card/h4/p/
    // rows/tip skeleton into cardShell.createCardShell; the wiring body below is untouched.
    window.slotRegistry.declareCard({
      id: 'agentToolsCard',
      slotId: 'setAgentSlot',
      build: function (slot) {
        // 工具档位/工作模式/轮数的读写规则已下沉 services/ui/settings-agent-tools.ts
        //（window.settingsAgentTools），与 services/agent/registry.ts 读侧共用同一口径。
        var _at = window.settingsAgentTools;
        var SS = 'flex:1;padding:7px 9px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;';
        var shell = window.cardShell.createCardShell({
          id: 'agentToolsCard',
          title: 'Agent 工作模式',
          desc: '决定 Agent 执行动作时的放行尺度。<b>仅本设备</b>。',
          extra: '<div class="rowline" style="align-items:center;gap:10px;"><label style="font-size:12px;color:var(--muted);min-width:42px;">模式</label><select id="agentWorkMode" style="' + SS + '">'
            + '<option value="confirm">变更前确认：有副作用的操作先问我</option>'
            + '<option value="auto">自动编辑：文件类操作直接做，其余仍问</option>'
            + '<option value="plan">计划模式：先出计划，不动手</option>'
            + '<option value="full">完全访问：不再确认</option>'
            + '</select></div>'
            + '<div id="agentWorkDesc" style="font-size:11px;color:var(--muted);margin-top:8px;line-height:1.6;"></div>'
            + '<div class="rowline" style="align-items:center;gap:10px;margin-top:12px;"><label style="font-size:12px;color:var(--muted);min-width:42px;">工具</label>'
            + '<select id="agentToolsSel" style="' + SS + '"></select></div>'
            + '<div class="rowline" style="align-items:center;gap:10px;margin-top:8px;"><label style="font-size:12px;color:var(--muted);min-width:42px;">轮数</label>'
            + '<input id="agentMaxRounds" type="number" min="0" max="1000" step="1" style="' + SS + '" placeholder="不限" title="一次回复里模型最多可以「思考→调工具」多少个来回；留空/0 = 不限（实务上限 1000）">'
            + '</div>'
            + '<div id="agentRoundsDesc" style="font-size:11px;color:var(--muted);margin-top:8px;line-height:1.6;">留空 = 不限；填 1~1000 可自设一次回复的最大工具轮数。改完下一次开 Agent 生效。</div>'
            // 4.70 本地能力:工作目录。**并进这张卡**而不是另开一张 ——
            // index.html 的注释写明 Agent 分类由本卡注入主要配置；多智能体编排 2026-10-08 起已拆走
            // （mountMultiAgentCard），因为"工作能力"与"编排玩法"是两件事，混在一张卡里互相干扰阅读。
            + '<div class="rowline" style="align-items:center;gap:10px;margin-top:12px;"><label style="font-size:12px;color:var(--muted);min-width:42px;">工作目录</label>'
            + '<input id="agentWorkdirPath" type="text" readonly style="' + SS + 'cursor:default;" placeholder="尚未设置">'
            + '<button id="agentWorkdirPick" style="padding:7px 12px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;cursor:pointer;white-space:nowrap;">选择…</button></div>'
            + '<div id="agentLocalStatus" style="font-size:11px;color:var(--muted);margin-top:6px;line-height:1.6;"></div>'
            + '<div id="agentToolsDesc" style="font-size:11px;color:var(--muted);margin-top:8px;line-height:1.6;"></div>',
          tip: '文件工具(list/search/read/write/edit/delete/export)与联网工具(搜索 / 抓网页)由各自模块单独注册,<b>两档都有</b>,不受这里影响：先 search_file 定位、read_file 按行分页读(大文件不怕截断)、长文 fetch_page 可续读 —— 由模型按需灵活组合。改完<b>下一次开 Agent 生效</b>(当前正在跑的不变)。<br>轮数决定一次回复能跑多少来回:读写多个文件、多轮检索这类任务要调大;<b>现在默认不限</b>(留空即可)——只有手填了具体数,才会在中途被"已达最大轮数"截断。'
        });
        var card = shell.card;
        slot.appendChild(card);
        var sel = card.querySelector('#agentToolsSel'), desc = card.querySelector('#agentToolsDesc');
        // 档位标签**不带工具条数**（origin/main 2026-11-27）：注册表随版本增减，界面上写死的数字只会过期。
        sel.innerHTML = '<option value="core">常用</option><option value="full">全量</option>';
        var TXT = {
          core: '给选项 / 载技能 / 角色卡增删改 / 发图 / 好感度 / 朗读，外加多智能体编排（分派 / 小会 / 请角色上台，见「多智能体编排」卡）。文件与联网工具两档都有。',
          full: '在常用基础上再加：设定集 / 指令模块 / 换主题 / 换模型 / 改设置 / 开编辑器 / 查费用 / 生成视频故事。其中视频故事一跑就是一两小时且不能关页 —— 只建议临时开。'
        };
        function render() { if (desc) desc.textContent = TXT[sel.value] || ''; }
        sel.value = _at.readTools(); render();
        sel.addEventListener('change', function () { _at.writeTools(sel.value); render(); });
        // 2026-09-14:工作模式(放行尺度)—— 与工具档位、轮数同属 Agent 分类
        var wmEl = card.querySelector('#agentWorkMode'), wdEl = card.querySelector('#agentWorkDesc');
        var WORK_TXT = {
          confirm: '有副作用的工具(写文件、改角色卡/设定集/指令模块、改设置、换主题换模型等)执行前会弹确认,由你放行或拒绝。最安全,但会打断节奏。',
          auto: '文件类工具(写文件等)直接执行不打断;改设置/换模型这类影响全局的仍然确认。适合"我只想让它干活、别问太多"。',
          plan: 'Agent 只做只读调查(抓网页/搜索/读文件),**不会真的动手改**;先给你一份计划,你确认后再切到别的模式执行。',
          full: '所有工具直接执行、完全不确认。快,但写错就是写错了 —— 只在你完全信任当前任务时用。'
        };
        function renderWork() { if (wdEl) wdEl.textContent = WORK_TXT[wmEl.value] || ''; }
        if (wmEl) {
          wmEl.value = _at.readMode(); renderWork();
          wmEl.addEventListener('change', function () { _at.writeMode(wmEl.value); renderWork(); });
        }

        // 2026-09-14:最大工具轮数(原来写死 8)—— 复杂任务会被中途截断,这里放开可调
        var roundsEl = card.querySelector('#agentMaxRounds');
        if (roundsEl) {
          var _curR = _at.readRounds();
          roundsEl.value = (_curR == null) ? '' : String(_curR);
          roundsEl.addEventListener('change', function () {
            // 留空/0/非法 = 不限 → 服务删键；有效值夹到 1000 后回写输入框
            var next = _at.writeRounds(roundsEl.value);
            roundsEl.value = (next == null) ? '' : String(next);
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
        var inv = window.tauriSvc ? window.tauriSvc.invokeOrNull() : null;
        if (!inv) {
          if (wdEl) wdEl.placeholder = '仅桌面端可用';
          if (wdBtn) { wdBtn.disabled = true; wdBtn.style.opacity = '0.5'; wdBtn.style.cursor = 'default'; }
          if (wdSt) wdSt.textContent = '网页版没有本地文件/命令能力,这部分在桌面 App 里生效。';
        } else {
          var refreshWd = function () {
            inv('local_env_info').then(function (i) {
              // 移动端(Tauri for Android/iOS)同样走 tauriSvc,所以不能只看它 ——
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

        // 2026-11-19 B2 C-4：工具目录模式（full/directory）行 → services/ui/tool-mode-card.ts
        //（window.settingsToolMode）；directory 仅在 toolModeSvc 就位时可选，行内显示生效模式。
        try { if (window.settingsToolMode && typeof window.settingsToolMode.attach === 'function') window.settingsToolMode.attach(card); } catch (e) {}
        return card;
      }
    });
  }

  // ─── 4.83: 生成参数（temperature / max_tokens）───
  // 归「模型 API」分类。核心设计:**留空 = 不干预** —— 未填的字段根本不发给模型，
  // 由上游用自己的默认值。这样既不会因我们猜错默认值而让输出质量退化，
  // 也不会覆盖上游针对模型做的调校。
  // 落库 key 与 app.js 的 LS_GEN_PARAMS 一致；app.js 通过 genParamPayload() 展开进 /api/chat body
  // （worker 侧早就支持 temperature/top_p/max_tokens 透传，只是此前没有正式 UI 入口）。
  // 2026-11-17 服务层搬迁：读写/夹取/预设进 services/ui/settings-gen-params.ts（window.settingsGenParams）。
  // 存储键与 app.js 的 LS_GEN_PARAMS 相同——两侧必须同步，键本身只在该服务里定义。
  function readGenParams() { return window.settingsGenParams.read(); }
  function writeGenParams(o) { window.settingsGenParams.write(o || {}); }
  function mountGenParamsCard() {
    // 2026-11-28 card-shell batch 3: the pick/claim/getElementById boilerplate moved into
    // slotRegistry.declareCard (the guard id already sat on the card element) and the card/h4/p/
    // rows/tips skeleton into cardShell.createCardShell. This card carries TWO sibling
    // settings-tip blocks: the first rides in `extra` verbatim (nested tip, the same escape hatch
    // panelToolsCard uses), the trailing one goes through the shell's standard `tip` field — the
    // assembled bytes are identical either way.
    window.slotRegistry.declareCard({
      id: 'genParamsCard',
      slotId: 'setModelApiSlot',
      build: function (slot) {
        var inp = 'style="width:110px;padding:6px 8px;border-radius:7px;border:1px solid var(--border,#2a2a2a);background:rgba(127,127,127,.08);color:inherit;font-size:13px;"';
        var row = 'style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;"';
        var shell = window.cardShell.createCardShell({
          id: 'genParamsCard',
          title: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h8M16 7h4M4 12h2M10 12h10M4 17h6M14 17h6"/><circle cx="14" cy="7" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="12" cy="17" r="2"/></svg>生成参数',
          desc: '微调模型的发挥风格。<b>留空 = 不干预</b>：该字段不会发给模型，由模型用自己的默认值 —— 不确定就别填。',
          extra: '<div class="rowline" ' + row + '><label for="genTemp" style="font-size:12.5px;min-width:152px;">温度（temperature）</label><input id="genTemp" type="number" min="0" max="2" step="0.1" placeholder="默认" ' + inp + '><span style="font-size:11px;color:var(--muted);">越高越有创意，越低越稳</span></div>'
            + '<div class="rowline" ' + row + '><label for="genMax" style="font-size:12.5px;min-width:152px;">最长输出（max_tokens）</label><input id="genMax" type="number" min="1" step="256" placeholder="默认" ' + inp + '><span style="font-size:11px;color:var(--muted);">写长文 / 开思考时要留足</span></div>'
            + '<div class="rowline" ' + row + '><span style="font-size:12px;color:var(--muted);">快速预设：</span><button class="smallbtn" data-genpreset="rp" type="button">角色扮演</button><button class="smallbtn" data-genpreset="write" type="button">长文写作</button><button class="smallbtn" data-genpreset="code" type="button">编程 / 工具</button><button class="smallbtn danger" data-genpreset="reset" type="button">全部恢复默认</button></div>'
            + '<div class="settings-tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg><span>留空是推荐状态。开思考时 max_tokens 会被推理内容占用，设小了会出现正文被截断或空白 —— 写长文建议 8192。温度设 0 不等于更准，长对话会明显重复；若换模型后服务商报错，回来清空或调低。</span></div>',
          tip: '<b>默认基准（"恢复默认"回到的就是这些）：</b>温度 1.0（0~2）；max_tokens 不传时 非思考 8K / 思考 64K（DeepSeek 官方文档；免费档 NIM 为 vLLM 系，温度默认同为 1.0）。注意：<b>思考模式下温度参数无效</b>，思考中的风格由模型自己决定。'
        });
        var card = shell.card;
        slot.appendChild(card);

        var tEl = card.querySelector('#genTemp');
        var mEl = card.querySelector('#genMax');
        function sync() {
          var g = readGenParams();
          tEl.value = (typeof g.temperature === 'number') ? g.temperature : '';
          mEl.value = (typeof g.maxTokens === 'number') ? g.maxTokens : '';
        }
        function save(syncBack) {
          // 夹取与「空值 = 删键」的语义在服务里（mergeGenInputs）；这里只负责把输入框原样交出去。
          window.settingsGenParams.applyInputs(tEl.value, mEl.value);
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
        // 预设值也在服务里（GEN_PRESETS）：角色扮演偏创意 / 长文写作留足输出 / 编程求稳。
        card.querySelectorAll('[data-genpreset]').forEach(function (b) {
          b.addEventListener('click', function () {
            var k = b.dataset.genpreset;
            if (k === 'reset') { window.settingsGenParams.reset(); sync(); return; }
            window.settingsGenParams.applyPreset(k); sync();
          });
        });
        sync();
        return card;
      }
    });
  }

// 50-models.js — 模型渠道：DeepSeek 全家桶 / 渠道管理 / 自定义定价。
// 由 settings.js 宿主的 init()/mountStaticSettingsCards() 调用；函数声明在同一 IIFE 内提升。
  // ─── §模型API. DeepSeek 全家桶卡（2026-11-25 服务端内置工具）───
  // read_url / safety_check 是聊天请求里的服务端内置工具（worker 只在 DeepSeek 渠道挂）。
  // 联网搜索主站已有独立卡，这里不重复造。云端语音在「语音」分类，本卡只指向它。
  function mountDeepSeekKitCard() {
    // 2026-11-28 card-shell batch 2: shell + declareCard. Two specials carried over verbatim:
    // the card's tip is a bare span WITHOUT the info glyph, so it rides in extra (the shell's
    // standard tip block always emits the glyph — cloudTtsCard precedent), and the scoped <style>
    // injection stays (rules are unchanged; hoisting them is not part of this batch).
    window.slotRegistry.declareCard({
      id: 'deepseekKitCard',
      slotId: 'setModelApiSlot',
      build: function (slot) {
        // 2026-11-25 C5：键与「只有 "1" 算开」的归一化归 services/ui/settings-deepseek-kit.ts，
        // 与 prompt-profile.deepseekKitPayload 读侧同源。
        var kit = window.settingsDeepSeekKit;
        var KIT = kit.KEYS;
        var shell = window.cardShell.createCardShell({
          id: 'deepseekKitCard',
          title: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/></svg>DeepSeek 全家桶',
          desc: '服务端内置工具，选 DeepSeek 渠道即自动生效：<b>读链接</b>把消息里的网址交给服务端抓取；<b>安全校验</b>对输入输出做基础筛查。按量计费，Key 只在你的 Worker 里。<b>仅本设备</b>。',
          extra: '<div class="ds-kit-sec"><div class="ds-kit-hd">服务端工具</div>'
            + '<label class="ds-kit-row"><input type="checkbox" id="dsReadUrl"><span>读链接 <span style="opacity:.6">— 模型自行抓取消息里的 URL</span></span></label>'
            + '<label class="ds-kit-row"><input type="checkbox" id="dsSafety"><span>安全校验 <span style="opacity:.6">— 输入输出基础筛查，按次计费</span></span></label></div>'
            + '<div id="kitStatus" style="font-size:11px;color:var(--muted);margin-top:8px;"></div>'
            + '<div class="settings-tip"><span>联网搜索用「对话」分类的「联网搜索」卡，那里已支持 DeepSeek 搜索，不在这里重复。<b>云端语音</b>在「语音」分类，网页版与访客都能用。</span></div>'
        });
        var card = shell.card;
        var css = document.createElement('style');
        css.textContent = [
          '#deepseekKitCard .ds-kit-sec{margin-top:12px;border-top:1px solid var(--border-soft,var(--border,#333));padding-top:10px}',
          '#deepseekKitCard .ds-kit-hd{font-size:12px;color:var(--muted);margin-bottom:4px}',
          '#deepseekKitCard .ds-kit-row{display:flex;align-items:flex-start;gap:8px;cursor:pointer;font-size:12.5px;line-height:1.5;margin-top:7px}',
          '#deepseekKitCard .ds-kit-row input{flex:0 0 auto;margin:2px 0 0;accent-color:var(--ac)}'
        ].join('\n');
        card.appendChild(css);
        slot.appendChild(card);
        var st = shell.q('kitStatus');
        function status(msg) { if (st) st.textContent = msg || ''; }
        // Bind primitives: the two checkboxes are the plain reflect/listen/write shape, so they
        // collapse into bindToggle with the status message on onChange (appFx/i18n precedent).
        window.bindEl.bindToggle(card, '#dsReadUrl', {
          key: KIT.readUrl,
          read: function () { return kit.read(KIT.readUrl); },
          write: function (on) { kit.write(KIT.readUrl, on); },
          fallbackGet: null,
          fallbackSet: null,
          onChange: function (on) { status(on ? '已开启读链接' : '已关闭读链接'); },
        });
        window.bindEl.bindToggle(card, '#dsSafety', {
          key: KIT.safety,
          read: function () { return kit.read(KIT.safety); },
          write: function (on) { kit.write(KIT.safety, on); },
          fallbackGet: null,
          fallbackSet: null,
          onChange: function (on) { status(on ? '已开启安全校验' : '已关闭安全校验'); },
        });
        return card;
      }
    });
  }

  // ─── §模型API. 模型渠道管理卡（批 E1b：预设组 + 自定义组统一注册表）───
  // 数据层 = window.providersSvc（/js/text/data/providers.js，cfw_providers_v3）；本卡只做 DOM/接线。
  //   · 预设渠道：服务端注册表（GET /api/providers），Key 在 Worker env，UI 只读状态；
  //   · 自定义渠道：本机 endpoint/apiKey，走 /api/custom-endpoint/models 代理拉模型（解 CORS/GFW）；
  //   · 每模型开关：勾选 = 出现在顶栏模型下拉；切走渠道 = 聊天即走它。
  function mountByoCard() {
    var slot = window.slotRegistry.pick('setModelApiSlot');
    if (slot) window.slotRegistry.claim({ cardId: 'byoProviderCard', slotId: 'setModelApiSlot' });
    if (!slot || document.getElementById('byoProviderCard')) return;
    if (!window.providersSvc) return; // providers.js 未加载(旧缓存页兜底):不挂卡,不炸
    var P = window.providersSvc;
    var _guest = false;
    try { _guest = !!(window.authSvc && window.authSvc.getToken && !window.authSvc.getToken()); } catch (e) {}
    var toastFn = (window.feedbackSvc && window.feedbackSvc.toast) || function (m) { try { console.warn('[providers]', m); } catch (e) {} };
    var esc = window.escapeSvc.esc;
    function curMode() { try { return normalizeMode(localStorage.getItem(SETTINGS_PAGE_KEYS.mode)); } catch (e) { return 'free'; } }
    function parseKey(key) {
      var s = String(key || '');
      if (s.indexOf('preset:') === 0) return { kind: 'preset', id: s.slice(7) };
      if (s.indexOf('custom:') === 0) return { kind: 'custom', id: s.slice(7) };
      return null;
    }
    var INP = 'width:100%;box-sizing:border-box;padding:7px 9px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;';
    var LBL = 'font-size:12px;color:var(--muted);display:block;margin-bottom:4px;';
    var BTN = 'cursor:pointer;text-align:left;width:100%;padding:7px 9px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:12px;line-height:1.5;';

    var card = document.createElement('div'); card.className = 'card'; card.id = 'byoProviderCard';
    card.innerHTML = '<h4>聊天模型 · 渠道管理</h4>'
      + '<p>聊天走哪个模型渠道，这里说了算。左侧选渠道（点击即切换），右侧看详情：拉取模型列表、<b>勾选要用的模型</b>（未勾选的不会出现在顶栏下拉里）。'
      + '「预设渠道」的 Key 在服务端 Worker 里（本页只见状态）；「自定义渠道」可接任意 OpenAI 兼容端点（云厂商 / 本地 vLLM、ollama、LM Studio），<b>API Key 随账号同步</b>（存在你自己的 Cloudflare KV，换设备不用重填）。</p>'
      + '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:10px;align-items:flex-start;">'
      +   '<div id="provList" style="flex:0 0 190px;min-width:158px;display:flex;flex-direction:column;gap:4px;"></div>'
      +   '<div id="provDetail" style="flex:1;min-width:230px;border-left:1px solid var(--border,#333);padding-left:12px;"></div>'
      + '</div>';
    // 2026-11-11: 这块面板原来全是内联样式 —— 没法写 hover、间距各写各的，50 个模型一摊就显脏。
    // 改成卡片内一份 scoped 样式表（类名统一 prov- 前缀，不影响别处），下面只写 class。
    var cardCss = document.createElement('style');
    cardCss.textContent = [
      '#byoProviderCard .prov-sec{margin-top:14px}',
      '#byoProviderCard .prov-sec-hd{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '#byoProviderCard .prov-sec-title{font-size:12.5px;font-weight:600}',
      '#byoProviderCard .prov-chip{font-size:11px;line-height:18px;color:var(--muted);border:1px solid var(--border,#333);border-radius:999px;padding:0 8px;white-space:nowrap}',
      '#byoProviderCard .prov-toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:8px}',
      '#byoProviderCard .prov-hint{font-size:11px;color:var(--muted)}',
      '#byoProviderCard .prov-box{margin-top:8px;border:1px solid var(--border,#333);border-radius:8px;max-height:260px;overflow:auto}',
      '#byoProviderCard .prov-grp{display:flex;justify-content:space-between;gap:8px;padding:8px 10px 3px;font-size:11px;color:var(--muted);border-top:1px solid var(--border-soft,var(--border,#333))}',
      '#byoProviderCard .prov-grp:first-child{border-top:0}',
      '#byoProviderCard .prov-row{display:flex;align-items:center;gap:8px;padding:4px 10px;font-size:12.5px;cursor:pointer}',
      '#byoProviderCard .prov-row:hover{background:var(--ac-soft)}',
      '#byoProviderCard .prov-row input{accent-color:var(--ac);margin:0;flex:0 0 auto}',
      '#byoProviderCard .prov-row span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '#byoProviderCard .prov-empty{padding:10px;font-size:12px;color:var(--muted)}',
      '#byoProviderCard .prov-meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin-top:8px;font-size:12.5px}',
      '#byoProviderCard .prov-code{font-size:11.5px;color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}',
    ].join('\n');
    card.appendChild(cardCss);
    slot.appendChild(card);
    var listEl = card.querySelector('#provList'), detailEl = card.querySelector('#provDetail');
    var selKey = P.effectiveKey(curMode()) || ((P.channels()[0] && P.channels()[0].key) || '');

    function activeKey() { return P.read().activeId; }
    function findChannel(key) {
      var chs = P.channels();
      for (var i = 0; i < chs.length; i++) if (chs[i].key === key) return chs[i];
      return null;
    }
    function keyTag(c) {
      if (c.kind === 'preset') {
        var m = c.detail || {};
        return (m.configured === true ? 'Key 已配置' : m.configured === false ? 'Key 未配置' : '') ;
      }
      var p = c.detail || {};
      return p.model ? ('模型 ' + p.model) : '未选模型';
    }

    function renderList() {
      var chs = P.channels(), act = activeKey(), eff = P.effectiveKey(curMode());
      var html = '';
      if (_guest) html += '<div style="font-size:11px;color:var(--muted);margin:0 0 6px;">访客模式：预设渠道已关闭，请新增自己的自定义渠道。</div>';
      var curKind = '';
      chs.forEach(function (c) {
        if (c.kind !== curKind) {
          curKind = c.kind;
          html += '<div style="font-size:11px;color:var(--muted);margin:' + (html ? '8px' : '0') + ' 0 2px;">' + (c.kind === 'preset' ? '预设渠道（服务端 Key）' : '自定义直连（账号同步）') + '</div>';
        }
        var isAct = act === c.key, isEff = !act && eff === c.key, isSel = selKey === c.key;
        var badge = isAct ? '<span style="color:var(--accent,#7aa2f7);">　● 使用中</span>' : (isEff ? '<span style="color:var(--muted);">　○ 跟随免费/快速</span>' : '');
        html += '<button type="button" data-key="' + esc(c.key) + '" style="' + BTN + (isSel ? 'border-color:var(--accent,#7aa2f7);' : '') + '">'
          + '<b style="font-size:12.5px;">' + esc(c.name) + badge + '</b>'
          + '<small style="color:var(--muted);font-size:11px;display:block;margin-top:1px;word-break:break-all;">' + esc(keyTag(c)) + '</small></button>';
      });
      html += '<button type="button" data-new="1" style="' + BTN + 'border-style:dashed;color:var(--muted);">＋ 新增自定义渠道</button>';
      listEl.innerHTML = html;
    }

    function modelsBlock(key) {
      var all = P.modelsAll(key);
      // 2026-11-11: 免费档放宽到 50 个模型后，平铺一列没法用 —— 按厂商分组 + 批量按钮。
      // 行内只显示短名（"/" 之后那段），完整 id 放 title；厂商在分组标题里，不重复占宽度。
      var groups = [], gi = {};
      all.forEach(function (m) {
        var v = String(m.id).indexOf('/') >= 0 ? String(m.id).split('/')[0] : '';
        if (!gi[v]) { gi[v] = { vendor: v, rows: [] }; groups.push(gi[v]); }
        gi[v].rows.push(m);
      });
      var onCount = all.filter(function (m) { return m.enabled; }).length;
      var body = all.length
        ? groups.map(function (g) {
            var head = '<div class="prov-grp"><span>' + esc(g.vendor || '默认') + '</span><span>' + g.rows.length + '</span></div>';
            return head + g.rows.map(function (m) {
              var id = String(m.id);
              var short = id.indexOf('/') >= 0 ? id.slice(id.indexOf('/') + 1) : id;
              return '<label class="prov-row" title="' + esc(id) + '">'
                + '<input type="checkbox" data-mid="' + esc(id) + '"' + (m.enabled ? ' checked' : '') + '>'
                + '<span>' + esc(short) + '</span></label>';
            }).join('');
          }).join('')
        : '<div class="prov-empty">还没拉取过模型列表 · 点右上「拉取模型列表」（拉不到可手填）</div>';
      var toolbar = all.length
        ? '<div class="prov-toolbar">'
          + '<button class="smallbtn" type="button" id="provSelAll">全选</button>'
          + '<button class="smallbtn" type="button" id="provSelRec">恢复推荐</button>'
          + '<button class="smallbtn" type="button" id="provSelNone">清空</button>'
          + '<span class="prov-hint">勾选 = 出现在顶栏下拉</span>'
          + '</div>'
        : '';
      return '<div class="prov-sec">'
        + '<div class="prov-sec-hd">'
          + '<span class="prov-sec-title">模型列表</span>'
          + (all.length ? '<span class="prov-chip">已启用 ' + onCount + ' / ' + all.length + '</span>' : '')
          + '<span style="flex:1;"></span>'
          + '<button class="smallbtn" type="button" id="provFetch">拉取模型列表</button>'
        + '</div>'
        + toolbar
        + '<div class="prov-box">' + body + '</div>'
        + '<div id="provFetchMsg" class="prov-hint" style="margin-top:6px;"></div>'
        + '</div>';
    }

    function useBtn(key, usable, why) {
      var isAct = activeKey() === key;
      if (isAct) return '<span style="font-size:12px;color:var(--accent,#7aa2f7);">● 当前渠道</span>';
      return '<button class="smallbtn" type="button" id="provUse"' + (usable ? '' : ' disabled title="' + esc(why || '') + '"') + '>使用此渠道</button>';
    }

    function renderDetail() {
      var c = findChannel(selKey);
      if (!c) { var chs = P.channels(); c = chs[0] || null; if (c) selKey = c.key; }
      if (!c) { detailEl.innerHTML = ''; return; }
      if (c.kind === 'preset') {
        var m = c.detail || {};
        var confText = m.configured === true ? '<span style="color:#4caf50;">✓ 已配置</span>'
          : m.configured === false ? '<span style="color:#e57373;">✗ 未配置</span>（部署侧执行 wrangler secret put ' + esc(m.keyEnv || '') + '）'
          : '<span style="color:var(--muted);">状态未知（没连上服务端）</span>';
        detailEl.innerHTML = '<div style="font-weight:600;font-size:14px;">' + esc(c.name) + '<span style="font-size:11px;color:var(--muted);font-weight:400;">　预设渠道 · ' + esc(m.label || '') + '</span></div>'
          + '<div style="font-size:12px;color:var(--muted);margin-top:4px;">服务端渠道：API Key 存在 Worker 环境变量（' + esc(m.keyEnv || '') + '），本页面不见 Key、不能改。</div>'
          + '<div style="margin-top:10px;"><label style="' + LBL + '">Endpoint（只读）</label><input readonly value="' + esc(m.endpoint || '') + '" style="' + INP + 'color:var(--muted);font-size:12px;"></div>'
          // 状态与默认模型原来挤在同一行、长 id 一换行就散架 → 拆成可换行的信息行
          + '<div class="prov-meta">'
            + '<span>' + confText + '</span>'
            + '<span class="prov-hint">默认模型</span>'
            + '<code class="prov-code">' + esc(m.defaultModel || '（无）') + '</code>'
          + '</div>'
          + modelsBlock(selKey)
          + '<div class="btns" style="margin-top:12px;">' + useBtn(selKey, true) + '</div>';
      } else {
        var p = c.detail || {};
        var enabled = P.enabledModels(selKey);
        var selOpts = enabled.map(function (mm) { return '<option value="' + esc(mm.id) + '"' + (p.model === mm.id ? ' selected' : '') + '>' + esc(mm.id) + '</option>'; }).join('');
        detailEl.innerHTML = '<div style="font-weight:600;font-size:14px;">' + esc(p.name || c.id) + '<span style="font-size:11px;color:var(--muted);font-weight:400;">　自定义直连 · Key 随账号同步</span></div>'
          + '<div style="margin-top:10px;"><label style="' + LBL + '">名称</label><input id="provName" value="' + esc(p.name || '') + '" style="' + INP + '"></div>'
          + '<div style="margin-top:8px;"><label style="' + LBL + '">Endpoint（/v1/chat/completions 全路径，或 /v1 base）</label><input id="provEndpoint" value="' + esc(p.endpoint || '') + '" placeholder="https://integrate.api.nvidia.com/v1/chat/completions" style="' + INP + '"></div>'
          + '<div style="margin-top:8px;"><label style="' + LBL + '">API Key（本地 vLLM/ollama/LM Studio 可留空）</label><input id="provKey" type="password" value="' + esc(p.apiKey || '') + '" placeholder="Bearer Token" style="' + INP + '"></div>'
          + '<div class="rowline" style="margin-top:8px;align-items:center;gap:8px;"><label style="' + LBL + 'margin:0;min-width:34px;">模型</label><select id="provModelSel" style="' + INP + 'flex:1;min-width:0;">'
          + (selOpts || '<option value="">— 启用模型为空 —</option>') + '</select></div>'
          + '<div style="margin-top:6px;"><input id="provModelText" value="' + esc(p.model || '') + '" placeholder="手填 fallback：gpt-4o / glm-4-plus / qwen-max ..." style="' + INP + '"></div>'
          + '<div class="rowline" style="margin-top:8px;align-items:center;gap:8px;"><label style="' + LBL + 'margin:0;min-width:64px;">思考支持</label><select id="provThinkingStyle" style="' + INP + 'flex:1;min-width:0;">'
          + '<option value="none"' + (!p.supportsThinking ? ' selected' : '') + '>不支持思考</option>'
          + '<option value="onoff"' + (p.supportsThinking && p.thinkingStyle === 'vllm' ? ' selected' : '') + '>支持 · vLLM / NIM 接口</option>'
          + '<option value="levels"' + (p.supportsThinking && p.thinkingStyle !== 'vllm' && p.thinkingStyle !== 'effort' ? ' selected' : '') + '>支持 · DeepSeek 接口</option>'
          // 2026-11-13: 第三种方言 —— 只发 reasoning_effort、不发 thinking（AMD Token Factory 这类端点收到 thinking 会 400）
          + '<option value="effort"' + (p.supportsThinking && p.thinkingStyle === 'effort' ? ' selected' : '') + '>支持 · 仅 reasoning_effort（AMD 等）</option>'
          + '</select></div>'
          + modelsBlock(selKey)
          + '<div class="btns" style="margin-top:12px;">' + useBtn(selKey, !!(p.endpoint && p.model), '先保存端点与模型，再启用') + '<button class="smallbtn" type="button" id="provSave">保存此渠道</button><button class="smallbtn danger" type="button" id="provDelete">删除</button></div>';
      }
      renderedKey = selKey; // 记下这次真正渲染的渠道（滚动保持要比对它）
    }

    // 未保存的编辑（草稿）：任何重渲染前先收走、渲染后回填 —— 拉取/事件刷新不会清空正在填的表单。
    // 只回填到同一个渠道（key 一致）；切到别的渠道 = 放弃草稿（有保存按钮有提示，行为可预期）。
    function captureDraft() {
      if (!detailEl) return null;
      var k = parseKey(selKey); if (!k || k.kind !== 'custom') return null;
      var g = function (id) { var el = detailEl.querySelector('#' + id); return el ? el.value : undefined; };
      if (g('provName') === undefined && g('provEndpoint') === undefined) return null;
      return { key: selKey, name: g('provName'), endpoint: g('provEndpoint'), apiKey: g('provKey'), model: g('provModelText'), sel: g('provModelSel'), thinkingStyle: g('provThinkingStyle') };
    }
    function restoreDraft(d) {
      if (!d || d.key !== selKey) return;
      var s = function (id, v) { var el = detailEl.querySelector('#' + id); if (el && v != null) el.value = v; };
      s('provName', d.name); s('provEndpoint', d.endpoint); s('provKey', d.apiKey); s('provModelText', d.model);
      if (d.sel != null) { var selEl = detailEl.querySelector('#provModelSel'); if (selEl) { try { selEl.value = d.sel; } catch (e) {} } }
      s('provThinkingStyle', d.thinkingStyle);
    }
    // 需要数据动作（拉取/启用）前，把当前渠道正在填的草稿落盘 —— 用户不用先记着点保存
    function commitDraftIfCurrent() {
      var d = captureDraft(); if (!d || d.key !== selKey) return;
      var k = parseKey(selKey); if (!k || k.kind !== 'custom') return;
      var _ts = d.thinkingStyle || 'levels';
      P.saveCustom(k.id, {
        name: (d.name || '').trim() || '未命名服务商',
        endpoint: (d.endpoint || '').trim(),
        apiKey: (d.apiKey || '').trim(),
        model: ((d.model || '') || (d.sel || '')).trim(),
        supportsThinking: _ts !== 'none',
        thinkingStyle: _ts === 'onoff' ? 'vllm' : (_ts === 'none' ? 'none' : (_ts === 'effort' ? 'effort' : 'deepseek')),
        needsReasoningHistory: _ts !== 'none',
      });
    }
    // 2026-11-11: 滚动位置保持 —— 勾一个模型会走 toggleModel→write→emit→renderAll，
    // 整块 detail 重建后滚动容器是新 DOM，scrollTop 归零（用户看到的就是"点一下就跳回顶部"）。
    // 关键是比"这次渲染的是不是同一个渠道"（renderedKey），而不是比 selKey ——
    // 切渠道时 selKey 在渲染前就变了，用 selKey 比会把上个渠道的偏移套到新渠道上。
    var renderedKey = '';
    function captureScroll() {
      var b = detailEl.querySelector('.prov-box');
      return { key: renderedKey, top: b ? b.scrollTop : 0 };
    }
    function restoreScroll(c) {
      if (!c || !c.top || c.key !== renderedKey || !c.key) return;
      var b = detailEl.querySelector('.prov-box');
      if (b) b.scrollTop = c.top;
    }
    function renderAll() { var d = captureDraft(); var sc = captureScroll(); renderList(); renderDetail(); restoreDraft(d); restoreScroll(sc); }

    // —— 左栏：点击即切换 ——
    listEl.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.hasAttribute('data-new')) {
        var id = P.newCustom();
        selKey = 'custom:' + id;
        renderAll();
        toastFn('已新建自定义渠道 · 填好端点与模型后点「保存此渠道」', 3200);
        return;
      }
      var key = b.getAttribute('data-key'); if (!key) return;
      commitDraftIfCurrent(); // 切走前把正在填的（若就是当前渠道）落盘
      selKey = key;
      var k = parseKey(key), c = findChannel(key);
      if (activeKey() !== key) {
        if (k && k.kind === 'custom' && c && (!(c.detail || {}).endpoint || !(c.detail || {}).model)) {
          toastFn('这个渠道还没填端点/模型 · 先在右侧填好，再启用', 3200);
        } else {
          P.setActive(key);
          toastFn('已切到「' + ((c && c.name) || key) + '」后续聊天走它', 2600);
        }
      }
      renderAll();
    });

    // —— 右栏：拉取 / 勾选 / 保存 / 删除 / 启用 ——
    detailEl.addEventListener('click', async function (e) {
      var t = e.target;
      // 2026-11-11(C): 批量勾选。走 setAllModels 一次写盘，不逐条 toggle（否则重渲染 N 次）
      if (t.id === 'provSelAll' || t.id === 'provSelNone' || t.id === 'provSelRec') {
        var pickRec = t.id === 'provSelRec';
        var n = P.setAllModels(selKey, t.id !== 'provSelNone', { onlyRecommended: pickRec });
        toastFn(t.id === 'provSelNone' ? '已全部取消勾选（下拉只剩渠道默认模型）'
          : (pickRec ? '已恢复推荐：勾上 ' + n + ' 个（DeepSeek / Nemotron）'
                     : '已全选 ' + n + ' 个模型'), 2200);
        renderAll();
        return;
      }
      if (t.id === 'provFetch') {
        t.disabled = true;
        var msgEl = detailEl.querySelector('#provFetchMsg');
        if (msgEl) msgEl.textContent = '拉取中…（经 Worker 代理）';
        commitDraftIfCurrent(); // 先落盘，拉取后的重渲染才丢不掉
        var k = parseKey(selKey) || {};
        var opts = {};
        if (k.kind === 'custom') {
          opts.endpoint = (detailEl.querySelector('#provEndpoint') || {}).value || '';
          opts.apiKey = (detailEl.querySelector('#provKey') || {}).value || '';
        }
        var r = await P.fetchModels(selKey, opts);
        if (r.ok) toastFn('拉到 ' + r.count + ' 个模型' + (r.title ? '（' + r.title + '）' : '') + ' · 勾选要用的', 2600);
        else toastFn('没拉到模型：' + (r.error || '未知原因') + ' · 可手填模型名', 4200);
        renderAll();
        return;
      }
      if (t.id === 'provSave') {
        var pid = (parseKey(selKey) || {}).id;
        var nameEl = detailEl.querySelector('#provName'), epEl = detailEl.querySelector('#provEndpoint'), kyEl = detailEl.querySelector('#provKey');
        var selEl = detailEl.querySelector('#provModelSel'), mdEl = detailEl.querySelector('#provModelText'), styleEl = detailEl.querySelector('#provThinkingStyle');
        var model = ((mdEl && mdEl.value) || (selEl && selEl.value) || '').trim();
        var thinkStyle = (styleEl && styleEl.value) || 'deepseek';
        P.saveCustom(pid, {
          name: (nameEl.value || '').trim() || '未命名服务商',
          endpoint: (epEl.value || '').trim(),
          apiKey: (kyEl.value || '').trim(),
          model: model,
          supportsThinking: thinkStyle !== 'none',
          thinkingStyle: thinkStyle === 'onoff' ? 'vllm' : (thinkStyle === 'none' ? 'none' : (thinkStyle === 'effort' ? 'effort' : 'deepseek')),
          needsReasoningHistory: thinkStyle !== 'none',
        });
        toastFn('已保存此渠道', 1800);
        renderAll();
        return;
      }
      if (t.id === 'provDelete') {
        var c2 = findChannel(selKey);
        var okDel = window.feedbackSvc && window.feedbackSvc.confirm
          ? await window.feedbackSvc.confirm({ title: '删除渠道', message: '删除「' + ((c2 && c2.name) || '') + '」？本机保存的 Key 一并删除。', danger: true, okText: '删除' })
          : window.confirm('删除这个渠道？');
        if (!okDel) return;
        P.deleteCustom((parseKey(selKey) || {}).id);
        selKey = P.effectiveKey(curMode());
        renderAll();
        return;
      }
      if (t.id === 'provUse') {
        commitDraftIfCurrent(); // 启用前先落盘草稿
        P.setActive(selKey);
        var c3 = findChannel(selKey);
        toastFn('已切到「' + ((c3 && c3.name) || selKey) + '」', 2200);
        renderAll();
        return;
      }
    });
    detailEl.addEventListener('change', function (e) {
      var t = e.target;
      if (t && t.hasAttribute && t.hasAttribute('data-mid')) {
        P.toggleModel(selKey, t.getAttribute('data-mid'), !!t.checked);
        renderAll();
        return;
      }
      if (t && t.id === 'provModelSel') {
        var mdEl = detailEl.querySelector('#provModelText');
        if (mdEl) mdEl.value = t.value;
      }
    });

    P.on(function () { try { renderAll(); } catch (e) {} });
    renderAll();
    // 首屏数据：刷新预设元数据；当前选中的预设渠道「没清单 / 清单过期」时静默拉一次
    P.refreshPresets().then(function () {
      renderAll();
      var k = parseKey(selKey);
      if (k && k.kind === 'preset' && (!P.modelsAll(selKey).length || P.modelsStale(selKey))) {
        P.fetchModels(selKey).then(function () { renderAll(); });
      }
    });
  }

  // ─── §模型API. 自定义模型定价 ───
  // 写 cfw_custom_pricing_v1；app.js calcCost 每次实时合并，因此保存后立即生效。
  // 该 key 已加入 sync.js 主同步白名单，可跨端同步；不含 API Key。
  function mountCustomPricingCard() {
    // 2026-11-28 card-shell batch 2: shell + declareCard; the guard id already sat on the card
    // element. No settings-tip on this card; the read/write fallback pair below is unchanged.
    window.slotRegistry.declareCard({
      id: 'customPricingCard',
      slotId: 'setModelApiSlot',
      build: function (slot) {
        // 2026-11-25 服务层搬迁：定价表的 JSON 守卫与价格校验内聚在
        // services/ui/settings-custom-pricing.ts（window.settingsCustomPricing），与 cost/ledger 读侧对拍同源。
        // localStorage 原样保留作服务缺席时的回落。
        var K = 'cfw_custom_pricing_v1';
        var cp = window.settingsCustomPricing;
        function read() {
          if (cp) return cp.table();
          try { var o = JSON.parse(localStorage.getItem(K) || '{}'); return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {}; } catch (e) { return {}; }
        }
        function write(o) {
          if (cp) { try { localStorage.setItem(K, JSON.stringify(o || {})); } catch (e) {} return; }
          try { localStorage.setItem(K, JSON.stringify(o || {})); } catch (e) {}
        }
        var esc = window.escapeSvc.esc;
        var shell = window.cardShell.createCardShell({
          id: 'customPricingCard',
          title: '自定义模型定价',
          desc: '给自定义直连或候选池里的新模型补价格。单位是 <b>¥ / 百万 token</b>；保存后费用估算立即生效，并随云同步跨端保存。',
          extra: '<div class="settings-grid-2">'
            + '<label><span>模型 ID</span><input id="cpModel" type="text" placeholder="deepseek-v4-flash / qwen-max / gpt-4o ..."></label>'
            + '<label><span>缓存命中输入价</span><input id="cpCache" type="number" min="0" step="0.001" placeholder="0.02"></label>'
            + '<label><span>普通输入价</span><input id="cpInput" type="number" min="0" step="0.001" placeholder="1.00"></label>'
            + '<label><span>输出价</span><input id="cpOutput" type="number" min="0" step="0.001" placeholder="2.00"></label>'
            + '</div>'
            + '<div class="rowline" style="margin-top:10px;"><div id="cpStatus" style="font-size:11px;color:var(--muted);flex:1;"></div><div class="btns"><button class="smallbtn" id="cpUseCurrent" type="button">填当前模型</button><button class="smallbtn" id="cpSave" type="button">保存定价</button><button class="smallbtn danger" id="cpDelete" type="button">删除此模型</button></div></div>'
            + '<div id="cpList" class="settings-mini-list"></div>'
        });
        var card = shell.card;
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
            var byo = window.byoProviderSvc && window.byoProviderSvc.get && window.byoProviderSvc.get();
            id = (byo && byo.model) || (document.getElementById('modelSel') && document.getElementById('modelSel').value) || '';
          } catch (e) {}
          fill(id);
          setMsg(id ? '已填入当前模型' : '没有可用的当前模型');
        });
        card.querySelector('#cpSave').addEventListener('click', function () {
          var id = (model.value || '').trim();
          // parsePrice 返回 null 表示非法；转成 NaN 让下面的 >= 0 校验照旧拦下（null>=0 在 JS 里为真）。
          function pr(s) { var v = cp ? cp.parsePrice(s) : parseFloat(s); return v === null ? NaN : v; }
          var p = { cache_hit: pr(cache.value), input: pr(input.value), output: pr(output.value) };
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
        return card;
      }
    });
  }

// 60-sync.js — 云同步与思考显示：同步聊天开关 / KV 配额 / Auth UI / 思考显示 / 外部回灌。
// 由 settings.js 宿主的 init()/mountStaticSettingsCards() 调用；函数声明在同一 IIFE 内提升。
  // ─── 5. 同步聊天历史 toggle ───
  // 2026-11-13: 「同步聊天历史」开关已撤（跟随云同步总开关，旧值由 sync.js 一次性归一）。
  // 空壳保留，避免旧调用点与历史文档引用报错。
  function initSyncChatToggle() {}

  // ─── 6. 覆盖云端按钮（2026-11-13：原「清空云端」）───
  function initSyncWipeBtn() {
    const wb = document.getElementById('syncWipeBtn');
    if (!wb) return;
    wb.addEventListener('click', async () => {
      const sync = window.syncSvc;
      if (!sync || typeof sync.wipeCloud !== 'function') { await uiAlert('云同步模块未就绪'); return; }
      const st = (sync.getStatus && sync.getStatus()) || {};
      if (!st.enabled || !st.hasToken) { await uiAlert('请先启用云同步（需要访问码）再覆盖云端'); return; }
      if (!(await uiConfirm('用本机数据覆盖云端吗？\n\n过程：先清空云端副本，再把本机数据完整上传一次。\n影响：其他设备的云端内容会被替换成本机这份（它们重新打开页面后自动跟上）。\n注意：本机数据不受影响；执行期间请勿关闭页面。', { title: '覆盖云端', okText: '覆盖云端', danger: true }))) return;
      const old = wb.textContent; wb.disabled = true; wb.textContent = '覆盖中…';
      try {
        await sync.wipeCloud();
        wb.textContent = '已覆盖';
        const s = document.getElementById('syncStatus');
        if (s) s.textContent = '云端已用本机数据覆盖 · ' + new Date().toLocaleTimeString();
        setTimeout(() => { wb.textContent = old; wb.disabled = false; }, 2000);
      } catch (e) {
        wb.textContent = old; wb.disabled = false;
        await uiAlert('覆盖云端失败:' + (e && e.message || e));
      }
    });
  }

  // ─── 7. KV 配额告警 + cloudExcludeSection ───
  function initCloudExcludeSection() {
    function wireWarn() {
      if (!window.syncSvc || !window.syncSvc.onStatus) { setTimeout(wireWarn, 500); return; }
      window.syncSvc.onStatus((s, d) => {
        if (s !== 'warn' || !d || d.reason !== 'kv-quota') return;
        const w = document.getElementById('syncQuotaWarn');
        if (w) { w.style.display = 'block'; w.textContent = '今日已 push ' + d.count + ' 次到 KV (免费层 1000/日上限),可点顶栏暂停同步避免超额'; }
      });
    }
    wireWarn();
    const listEl = document.getElementById('cloudExcludeList');
    if (!listEl) return;
    var esc = window.escapeSvc.esc;
    function cards() { try { return (window.characterSvc && window.characterSvc.listAllCards) ? (window.characterSvc.listAllCards() || []) : []; } catch(e) { return []; } }
    function slots() { try { const raw = localStorage.getItem(SETTINGS_PAGE_KEYS.chatSession); if (!raw) return []; const m = JSON.parse(raw); return (m && typeof m === 'object' && !Array.isArray(m)) ? Object.keys(m) : []; } catch(e) { return []; } }
    function excluded() { try { return (window.syncSvc && window.syncSvc.getExcluded) ? window.syncSvc.getExcluded() : { roles: [], sessions: [] }; } catch(e) { return { roles: [], sessions: [] }; } }
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
      const sync = window.syncSvc;
      if (!sync || !sync.wipeCloudEntity) { await uiAlert('云同步模块未就绪'); return; }
      const st = (sync.getStatus && sync.getStatus()) || {};
      if (!st.enabled || !st.hasToken) { await uiAlert('请先启用云同步(需密码)'); return; }
      const act = b.getAttribute('data-act'), kind = b.getAttribute('data-kind'), id = b.getAttribute('data-id');
      const old = b.textContent; b.disabled = true; b.textContent = '处理中…';
      try {
        if (act === 'wipe') {
          if (!(await uiConfirm('确定只把这一' + (kind === 'session' ? '个会话' : '个角色') + '从云端清除吗?\n本地保留,且本设备不再上传它。', { title: '只清云端', okText: '清除', danger: true }))) { b.disabled = false; b.textContent = old; return; }
          await sync.wipeCloudEntity(kind, id);
        } else { await sync.restoreCloudEntity(kind, id); }
        render();
      } catch(err) { b.disabled = false; b.textContent = old; await uiAlert('操作失败:' + (err && err.message || err)); }
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
    const syncPullBtn       = document.getElementById('syncPullBtn');
    const syncExportBtn     = document.getElementById('syncExportBtn');
    const syncImportBtn     = document.getElementById('syncImportBtn');
    const syncImportFile    = document.getElementById('syncImportFile');
    const syncStatusEl      = document.getElementById('syncStatus');
    const syncRealtimeToggle = document.getElementById('syncRealtimeToggle');
    const syncRealtimeStatus = document.getElementById('syncRealtimeStatus');
    const authLoginBtn      = document.getElementById('authLoginBtn');
    const authLogoutBtn     = document.getElementById('authLogoutBtn');
    const authStatusEl      = document.getElementById('authStatus');
    if (!syncEnableToggle) return;

    // 未配访问码的部署（公开版默认状态）：登录框永远不会成功，先说明白。
    // 只问一位布尔值，不猜、不试密码；网络失败就保持沉默，不伪造状态。
    let unlockConfigured = null;
    fetch('/api/unlock').then(r => r.json()).then(d => {
      if (!d || typeof d.configured !== 'boolean') return;
      unlockConfigured = d.configured;
      if (!d.configured) refreshAuthUI();
    }).catch(function () {});

    function fmtTime(ms) {
      if (!ms) return '—';
      try { return new Date(ms).toLocaleString('zh-CN', { hour12: false }); } catch { return String(ms); }
    }
    function refreshAuthUI() {
      if (!window.authSvc) return;
      const hasToken = !!window.authSvc.getToken();
      if (authStatusEl) authStatusEl.textContent = unlockConfigured === false
        ? '未检测到访问码配置（Cloudflare Secret CHAT_PASSWORD 未设置），登录功能暂不可用。'
        : hasToken
          ? '已登录（访问码已保存在本机）'
          : '访客模式 · 使用你自己的模型渠道与 API Key';
      if (authLogoutBtn) authLogoutBtn.disabled = !hasToken;
    }
    function refreshSyncUI() {
      if (!window.syncSvc) return;
      const s = window.syncSvc.getStatus();
      syncEnableToggle.checked = s.enabled;
      const parts = [s.enabled ? '已启用' : '未启用'];
      if (s.lastPush) parts.push('上次推送 ' + fmtTime(s.lastPush));
      if (syncStatusEl) syncStatusEl.textContent = parts.join('，');
      if (syncRealtimeToggle) syncRealtimeToggle.checked = !!(window.chatRealtimeSvc && window.chatRealtimeSvc.enabled && window.chatRealtimeSvc.enabled());
      if (syncRealtimeStatus) {
        var rt = null;
        try { rt = (window.chatRealtimeSvc && window.chatRealtimeSvc.status) ? window.chatRealtimeSvc.status() : null; } catch (e) {}
        var map = { connected: '已连接 · 1.5 秒轮询', reconnecting: '重连中', offline: '离线', manual: '不可用 · 已自动回落整段同步', error: '错误' };
        syncRealtimeStatus.textContent = '实时消息同步：' + (rt ? (map[rt.state] || rt.state) : '未加载') + (rt && rt.error ? ' · ' + rt.error : '');
      }
    }

    window.__settingsRefreshAuth = refreshAuthUI;
    window.__settingsRefreshSync = refreshSyncUI;
    if (syncRealtimeToggle) {
      syncRealtimeToggle.addEventListener('change', function () {
        try {
          if (window.chatRealtimeSvc && window.chatRealtimeSvc.setEnabled) window.chatRealtimeSvc.setEnabled(!!syncRealtimeToggle.checked);
        } catch (e) {}
        refreshSyncUI();
      });
    }
    window.addEventListener('chat-realtime-status', function () { try { refreshSyncUI(); } catch (e) {} });

    if (window.syncSvc) {
      window.syncSvc.onStatus((st, detail) => {
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
      if (!window.syncSvc || !window.authSvc) return;
      if (syncEnableToggle.checked) {
        if (!window.authSvc.getToken()) {
          try {
            const pw = await window.authSvc.promptForPassword({
              title: '启用云同步',
              hint: '输入 Cloudflare Secret <code>CHAT_PASSWORD</code> 的值。密码会保存在本地浏览器，下次自动登录。',
            });
            window.authSvc.setToken(pw);
          } catch { syncEnableToggle.checked = false; return; }
        }
        window.syncSvc.setSyncEnabled(true);
        refreshAuthUI(); refreshSyncUI();
        window.syncSvc.pullOnStartup();
        try { if (window.chatRealtimeSvc && window.chatRealtimeSvc.start) window.chatRealtimeSvc.start(); } catch (e) {}
      } else {
        window.syncSvc.setSyncEnabled(false);
        try { if (window.chatRealtimeSvc && window.chatRealtimeSvc.stop) window.chatRealtimeSvc.stop(); } catch (e) {}
        refreshSyncUI();
      }
    });

    syncNowBtn.addEventListener('click', async () => {
      // 4.75 立即同步反馈修复:原版点了无任何按钮级反馈(只往 #syncStatus 写一行小字),看着像"没反应"。
      // 现加:未登录直接提示 + 按钮态 同步中…/✓ 已同步/同步失败,与"清空云端"按钮一致。
      if (!window.syncSvc) { await uiAlert('云同步模块未就绪'); return; }
      var st = (window.syncSvc.getStatus && window.syncSvc.getStatus()) || {};
      if (!st.hasToken) { await uiAlert('请先在上方打开「启用云同步」并输入密码,再点立即同步'); return; }
      var _old = syncNowBtn.innerHTML;
      syncNowBtn.disabled = true;
      syncNowBtn.textContent = '上传中…';
      try {
        await window.syncSvc.pushNow();
        // 4.78: 立即同步同时补推独立通道(pushNow 只推 main blob;聊天走 /sync/chat)。
        // 2026-11-28 T3-B: 角色卡已迁到统一存储(数据面 chars 表),D1 本身就是同步 —— 这里不再
        // 调用 pushCharsNow 搬运旧 IndexedDB blob;端点与旧客户端通道保留在原处(sync.ts)。
        const _chat = window.syncSvc.pushChatNow ? await window.syncSvc.pushChatNow() : null;
        // 2026-10-07: 如实回报 —— 对话通道没开/没推成时必须说清楚,不再一律"✓ 已同步"(那条假成功让"什么都没同步"看起来像成功了)
        const _when = new Date().toLocaleString('zh-CN', { hour12: false });
        if (_chat && _chat.skipped === 'chat-off') {
          syncNowBtn.textContent = '✓ 已上传(不含对话)';
          if (syncStatusEl) syncStatusEl.textContent = '对话历史未同步，本次只上传了设置与资料 · ' + _when;
        } else if (_chat && _chat.skipped === 'sync-off') {
          syncNowBtn.textContent = '✓ 已上传(不含对话)';
          if (syncStatusEl) syncStatusEl.textContent = '未启用云同步/缺密码:对话未同步，' + _when;
        } else if (_chat && _chat.error) {
          syncNowBtn.textContent = '部分失败';
          if (syncStatusEl) syncStatusEl.textContent = '其余数据已同步,对话同步失败:' + _chat.error + '，' + _when;
        } else {
          syncNowBtn.textContent = '✓ 已上传';
          if (syncStatusEl) syncStatusEl.textContent = '上传完成(含对话 ' + ((_chat && _chat.slots) || 0) + ' 条会话)，' + _when;
        }
      } catch (e) {
        syncNowBtn.textContent = '上传失败';
        await uiAlert('上传失败: ' + (e && e.message || e));
      } finally {
        setTimeout(function () { syncNowBtn.innerHTML = _old; syncNowBtn.disabled = false; }, 1800);
      }
    });
    if (syncPullBtn) syncPullBtn.addEventListener('click', async () => {
      if (!window.syncSvc) { await uiAlert('云同步模块未就绪'); return; }
      var st = (window.syncSvc.getStatus && window.syncSvc.getStatus()) || {};
      if (!st.hasToken) { await uiAlert('请先在上方打开「启用云同步」并输入访问码'); return; }
      var _old = syncPullBtn.innerHTML;
      syncPullBtn.disabled = true;
      syncPullBtn.textContent = '刷新中…';
      try {
        // 主数据：pullOnStartup 在云端更新时会恢复并 reload（预期行为）
        await window.syncSvc.pullOnStartup();
        // 2026-11-13: 强制刷新走全量 3-way 合并（不复用实时补事件），这才是「对齐」的语义
        var c = window.syncSvc.pullChatNow ? await window.syncSvc.pullChatNow({ full: true }) : null;
        // 2026-11-28 T3-B: 角色卡不再从 /sync/chars 拉取 —— 它已经在统一存储里,数据面即真源。
        var _when = new Date().toLocaleString('zh-CN', { hour12: false });
        if (c && c.skipped === 'chat-off') {
          syncPullBtn.textContent = '✓ 已刷新(不含对话)';
          if (syncStatusEl) syncStatusEl.textContent = '对话同步被旧开关关闭过，未拉取对话，' + _when;
        } else if (c && c.error) {
          syncPullBtn.textContent = '部分失败';
          if (syncStatusEl) syncStatusEl.textContent = '主数据已对齐，对话拉取失败:' + c.error + '，' + _when;
        } else {
          syncPullBtn.textContent = '✓ 已刷新';
          if (syncStatusEl) syncStatusEl.textContent = '已与云端对齐，' + _when;
        }
      } catch (e) {
        syncPullBtn.textContent = '拉取失败';
        await uiAlert('拉取失败: ' + (e && e.message || e));
      } finally {
        setTimeout(function () { syncPullBtn.innerHTML = _old; syncPullBtn.disabled = false; }, 1800);
      }
    });
    if (syncExportBtn) syncExportBtn.addEventListener('click', async () => {
      if (!window.syncSvc) return;
      try { await window.syncSvc.exportJSON(); } catch (e) { await uiAlert('导出失败: ' + e.message); }
    });
    if (syncImportBtn) syncImportBtn.addEventListener('click', () => { syncImportFile && syncImportFile.click(); });
    if (syncImportFile) syncImportFile.addEventListener('change', async e => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      if (!(await uiConfirm('导入将覆盖本地所有数据（角色卡 / 历史 / 指令模块 / 费用日志）。确认？', { title: '导入备份', okText: '覆盖导入', danger: true }))) { syncImportFile.value = ''; return; }
      try {
        await window.syncSvc.importJSON(file);
        await uiAlert('导入成功，即将刷新页面…', { okText: '好' });
        setTimeout(() => location.reload(), 400);
      } catch (err) { await uiAlert('导入失败: ' + err.message); }
      syncImportFile.value = '';
    });

    if (authLoginBtn) authLoginBtn.addEventListener('click', async () => {
      if (!window.authSvc) return;
      try {
        const pw = await window.authSvc.promptForPassword({
          title: '输入访问码',
          hint: '输入访问码（与私密模式解锁时相同）。',
        });
        if (!pw) return;
        window.authSvc.setToken(pw);
        try {
          localStorage.setItem('cfw_unlocked_v1', '1');
          localStorage.setItem('cfw_unlock_token_v1', pw);
          localStorage.setItem('cfw_nsfw_mode_v1', '3');
          localStorage.setItem('cfw_auth_token_v1', pw);
        } catch (e) {}
        location.reload();
      } catch (e) {}
    });

    if (authLogoutBtn) authLogoutBtn.addEventListener('click', async () => {
      if (!window.authSvc) return;
      if (!(await uiConfirm('退出登录会清除本地访问码、退出私密模式，并关闭云同步。确认？', { title: '退出登录', okText: '退出', danger: true }))) return;
      window.authSvc.clearToken();
      if (window.syncSvc) window.syncSvc.setSyncEnabled(false);
      try {
        localStorage.removeItem('cfw_unlocked_v1');
        localStorage.removeItem('cfw_unlock_token_v1');
        localStorage.removeItem('cfw_nsfw_mode_v1');
        localStorage.removeItem('cfw_dev_mode_v1');
      } catch (e) {}
      refreshAuthUI(); refreshSyncUI();
      setTimeout(function () { location.reload(); }, 250);
    });
  }

  // ─── 9. 思考过程显示下拉 ───
  // 2026-10-05: 宿主改成「外观 · 显示设置」卡(它和字号/字体同属"聊天区怎么呈现")。
  // 旧实现靠 #historyKeep 反查宿主,而那张卡(本地对话记忆)后来挪进了「账号」类目 ——
  // 这一行就跟着寄生到与它毫无关系的分类里(用户实测反馈)。宿主判定改为:显示设置卡 > #localHistoryCard > #customPrompt,
  // 回落链保留只为老页面(缺显示设置卡时仍能显示,不会整行消失)。2026-11-27：历史开关退役后
  // 旧锚点换成同卡的 #localHistoryCard（卡 id 未变，只是不再有开关元素）。
  function setupThinkDisplaySetting() {
    if (document.getElementById('thinkDisplaySel')) return;
    const fontEl = document.getElementById('chatFontSizeRange');
    const displayCard = (fontEl && fontEl.closest) ? fontEl.closest('.card') : null;
    const displayTip  = displayCard ? displayCard.querySelector('.settings-tip') : null;
    const localHistoryCard = document.getElementById('localHistoryCard');
    const customPromptEl = document.getElementById('customPrompt');
    const legacyHost = (localHistoryCard && localHistoryCard.parentNode) || (customPromptEl && customPromptEl.parentNode);
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
    label.title = '解限/思考模式下模型产生的思考内容如何呈现';
    const sel = document.createElement('select');
    sel.id = 'thinkDisplaySel';
    sel.style.cssText = 'padding:4px 8px;border-radius:6px;';
    // 2026-11-17：三态与存储键的唯一家是 services/chat/reasoning.ts（__reasoning 门面），
    // 下拉只负责渲染选项与回调（选项表也来自服务，标签不会与读取规则漂移）。
    const MODES = (window.__reasoning && window.__reasoning.THINK_DISPLAY_MODES) || [['collapse', '折叠(默认)']];
    MODES.forEach((m) => {
      const o = document.createElement('option');
      o.value = Array.isArray(m) ? m[0] : m.value;
      o.textContent = Array.isArray(m) ? m[1] : m.label;
      sel.appendChild(o);
    });
    function getVal() { return window.__reasoning.getThinkDisplay(); }
    sel.value = getVal();
    sel.addEventListener('change', () => {
      window.__reasoning.setThinkDisplay(sel.value);
      if (window.hostApi.app && window.hostApi.app.applyAllThinkDisplay) {
        window.hostApi.app.applyAllThinkDisplay();
      } else {
        document.querySelectorAll('.reasoning-block').forEach(el => {
          try { if (window.hostApi.app && window.hostApi.app.applyThinkDisplay) window.hostApi.app.applyThinkDisplay(el); } catch(e) {}
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

  // ─── 2026-10-08 外部改动（云同步回灌 / 别的标签页）后：把设置面板里这些开关/输入的值回读一遍 ───
  // 面板的卡片是"挂载一次"的（各 mount* 用 id 存在与否做守卫），旧版不会因为远端设置变化而更新 ——
  // 用户会看到"设置里显示关着、实际云端是开着的"。这里按"元素 id ← LS 键"的清单逐个回读。
  // （只处理会被同步的、且已直接落到 LS 的开关；内容型数据如角色卡/预设由各自通道的合并逻辑刷新。）
  // 2026-11-25 C6：清单与「缺省=开」回读规则归 services/ui/settings-page.ts
  //（SYNCED_CONTROLS / syncedCheckboxChecked），本文件只遍历并写 DOM。
  function syncSettingsControlsFromLS() {
    if (!document.getElementById("settingsMask")) return;
    SYNCED_CONTROLS.forEach(function (pair) {
      var el = document.getElementById(pair[0]);
      if (!el) return;
      try {
        var v = localStorage.getItem(pair[1]);
        if (el.type === "checkbox") el.checked = syncedCheckboxChecked(v);
        else if (v != null) el.value = v;
      } catch (e) {}
    });
    // 下拉类（值域与默认值各不同）单独回读：
    try { var ag = document.getElementById("agentWorkMode"); var w = localStorage.getItem(SETTINGS_PAGE_KEYS.agentWorkMode); if (ag && w) ag.value = w; } catch (e) {}
    try { var at = document.getElementById("agentToolsSel"); var t = localStorage.getItem(SETTINGS_PAGE_KEYS.agentTools); if (at && t) at.value = t; } catch (e) {}
  }

// 70-images.js — 图像与语音卡：槽位 / 画风 / Key / 额度 / 立绘 / 缓存 / 画廊 / 本地与云端语音。
// 由 settings.js 宿主的 init()/mountStaticSettingsCards() 调用；函数声明在同一 IIFE 内提升。
  // ─── 10. 图像模块设置卡挂载 ───
  function getSlot() {
    return window.slotRegistry.pick('settingsImageSlot');
  }

  // 4.71: 语音 tab slot
  function getVoiceSlot() {
    return window.slotRegistry.pick('settingsVoiceSlot') || null;
  }

  function mountImageCards() {
    if (_imgCardsMounted) return;
    if (!getSlot()) return;
    mountImgStyleCard();
    mountImgKeyCard();
    mountImgQuotaCard();
    // 2026-11-06: 发图扩写器卡已移除 —— 画面描述直接用主模型的结构化信号，不再多调一次免费模型。
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

  function mountVoiceCards() {
    if (_voiceCardsMounted) return;
    if (!getVoiceSlot()) return;
    mountCloudTtsCard(); // 云端语音：网页版/访客也能用，语音 tab 因它而对非壳内可见
    mountTtsCard();      // 本地 GPT-SoVITS：仅桌面壳
    _voiceCardsMounted = true;
  }

  // 2026-11-25 C4：画风表归 services/image/portrait.ts（portraitSvc.styles()），卡面不再抄一份；
  // 新增一档只改服务，两个下拉自动出现。
  function styleOpts(pt) {
    var rows = (pt && pt.styles) ? pt.styles() : [];
    return rows.map(function (p) { return '<option value="' + p.key + '">' + p.label + '</option>'; }).join('');
  }

  function mountImgStyleCard() {
    var pt=window.portraitSvc; if(!pt)return;
    window.slotRegistry.declareCard({
      id: 'imgStyleCard',
      slotId: 'settingsImageSlot',
      build: function (slot) {
        var shell=window.cardShell.createCardShell({
          id: 'imgStyleCard',
          title: '全局画风',
          desc: '统一控制<b>所有自动出图</b>的画风，工坊手动文生图不受影响，仅本设备。',
          extra: '<div class="rowline" style="align-items:center;gap:10px;margin-top:6px;"><label style="font-size:12px;opacity:.6;">画风</label><select id="imgStyleSelect" style="flex:1;padding:8px 10px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;">'+styleOpts(pt)+'</select></div>'
        });
        var card=shell.card;
        if(slot.firstChild)slot.insertBefore(card,slot.firstChild); else slot.appendChild(card);
        // Bind primitive: the select's reflect/listen/write collapses into bindText (service path
        // only — portraitSvc is guaranteed past the guard above); the cross-card repaint keeps
        // riding the imagestyle:changed event as before.
        var bound=window.bindEl.bindText(card,'#imgStyleSelect',{
          key: 'imgStyleSelect',
          read: function(){return pt.getStyle();},
          write: function(raw){pt.setStyle(raw);return raw;},
          fallbackGet: null,
          fallbackSet: null,
          onChange: null,
        });
        var sel=bound?bound.el:null;
        if(sel){window.addEventListener('imagestyle:changed',function(e){var v=(e&&e.detail&&e.detail.style)||pt.getStyle();if(sel.value!==v)sel.value=v;});}
        return card;
      }
    });
  }

  function mountImgKeyCard() {
    // 2026-06-24: 图像 API Key 归「模型 API」分类(setModelApiSlot),原在「发图」settingsImageSlot
    // 2026-11-06: 升级为「图像渠道」卡(渠道=数据, Gitee 只是内置预设)，由 image-channels-ui.js 挂载；
    // 旧版单 Key 卡仅在新 UI 未加载时兜底。
    if (document.documentElement.dataset.imageChannelsUi === "1") {
      try { document.dispatchEvent(new CustomEvent("cfw:mount-image-channels")); } catch (e) {}
      return;
    }
    var slot=window.slotRegistry.pick('setModelApiSlot')||getSlot(); if(!slot||document.getElementById('imgKeyCard'))return; if (slot) window.slotRegistry.claim({ cardId: 'imgKeyCard', slotId: 'setModelApiSlot' });
    var K='cfw_image_key_v1';
    var card=document.createElement('div'); card.className='card'; card.id='imgKeyCard';
    card.innerHTML='<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>图像 API Key</h4><p>图像工坊（生图/改图）调用 <code>ai.gitee.com</code>，需要单独的 Gitee API Key，不进云同步。</p><div class="rowline"><input type="password" id="imgKeyInput" placeholder="Bearer Token" style="flex:1;padding:8px 10px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;"></div><div class="rowline" style="margin-top:8px;"><div></div><div class="btns"><button class="smallbtn" id="imgKeySave">保存</button><button class="smallbtn danger" id="imgKeyClear">清除</button></div></div><div id="imgKeyStatus" style="font-size:11px;color:var(--muted);margin-top:8px;"></div>';
    slot.appendChild(card);
    var inp=document.getElementById('imgKeyInput'),sts=document.getElementById('imgKeyStatus');
    try{inp.value=localStorage.getItem(K)||'';}catch(e){}
    function setMsg(){try{sts.textContent=localStorage.getItem(K)?'已保存 Key':'未设置 Key';}catch(e){}}
    setMsg();
    document.getElementById('imgKeySave').addEventListener('click',function(){try{localStorage.setItem(K,(inp.value||'').trim());}catch(e){}setMsg();});
    document.getElementById('imgKeyClear').addEventListener('click',function(){try{localStorage.removeItem(K);}catch(e){}inp.value='';setMsg();});
  }

  function mountImgQuotaCard() {
    // 2026-11-28 card-shell batch 2: shell + declareCard. The __imageQuota guard stays ahead of the
    // declaration (old code skipped silently when the quota engine was absent); the wiring below is
    // unchanged hand-written code — the limit input has no mount-time reflect (renderCard paints
    // it), which is not the bindNumber shape.
    var q=window.__imageQuota; if(!q)return;
    window.slotRegistry.declareCard({
      id: 'imgQuotaCard',
      slotId: 'settingsImageSlot',
      build: function (slot) {
        var shell=window.cardShell.createCardShell({
          id: 'imgQuotaCard',
          title: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="2"/><path d="M7 16v-4M12 16V8M17 16v-6"/></svg>图像额度计数',
          desc: 'Gitee 免费图像额度每天约 <b>100 次</b>。本站发图成功时按图片张数累加，<b>仅本设备本地统计</b>；直连渠道与本地 ComfyUI 不计入。',
          extra: '<div id="imgQuotaDisplay" style="margin:6px 0 8px;"></div><div style="height:6px;border-radius:4px;background:rgba(127,127,127,.2);overflow:hidden;margin-bottom:12px;"><div id="imgQuotaBar" style="height:100%;width:0;transition:width .25s;"></div></div><div class="rowline" style="align-items:center;gap:10px;"><label style="font-size:12px;color:var(--muted);">每日额度</label><input type="number" id="imgQuotaLimit" min="1" max="9999" style="width:90px;padding:5px 8px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;"><div class="btns"><button class="smallbtn" id="imgQuotaMinus">-1</button><button class="smallbtn" id="imgQuotaPlus">+1</button><button class="smallbtn danger" id="imgQuotaReset">今日归零</button></div></div>'
        });
        var card=shell.card;
        slot.appendChild(card);
        var lim=document.getElementById('imgQuotaLimit'); if(lim)lim.addEventListener('change',function(){q.setLimit(lim.value);});
        var qp=document.getElementById('imgQuotaPlus'); if(qp)qp.addEventListener('click',function(){q.add(1);});
        var qm=document.getElementById('imgQuotaMinus'); if(qm)qm.addEventListener('click',function(){q.add(-1);});
        var qr=document.getElementById('imgQuotaReset'); if(qr)qr.addEventListener('click',function(){q.reset();});
        if(q.renderCard)q.renderCard();
        return card;
      }
    });
  }

  function mountImgPortraitCard(){
    // 2026-11-28 card-shell batch 2: shell + declareCard. The portraitSvc guard stays ahead of the
    // declaration (old code skipped silently when the service was absent). Bind primitive: the
    // style select collapses into bindText with the cross-card repaint on imagestyle:changed — the
    // exact shape mountImgStyleCard already uses (batch-1 precedent); the generate/set/clear wiring
    // stays hand-written.
    var pt=window.portraitSvc; if(!pt)return;
    window.slotRegistry.declareCard({
      id: 'imgPortraitCard',
      slotId: 'settingsImageSlot',
      build: function (slot) {
        var opts=styleOpts(pt);
        var shell=window.cardShell.createCardShell({
          id: 'imgPortraitCard',
          title: '角色立绘 → 发图基准图',
          desc: '用当前选中<b>角色卡</b>自动拼提示词，z-image 出一张半身立绘，一键设为<b>微信发图基准图</b>。消耗 1 次图像额度，<b>仅本设备</b>。',
          extra: '<div id="imgPortraitWho" style="font-size:13px;margin:4px 0;"></div><div class="rowline" style="align-items:center;gap:10px;margin-top:8px;"><label style="font-size:12px;opacity:.6;">画风</label><select id="imgPortraitStyle" style="flex:1;padding:6px 8px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;">'+opts+'</select></div><div class="rowline" style="margin-top:10px;"><div></div><div class="btns"><button class="smallbtn" id="imgPortraitGen">生成立绘</button><button class="smallbtn" id="imgPortraitSet" disabled>设为基准图</button><button class="smallbtn danger" id="imgPortraitClear">清除基准图</button></div></div><div id="imgPortraitStatus" style="font-size:11px;opacity:.6;margin-top:8px;"></div><div id="imgPortraitPreview" style="margin-top:10px;display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;"></div>'
        });
        var card=shell.card;
        slot.appendChild(card);
        var genBtn=document.getElementById('imgPortraitGen'),setBtn=document.getElementById('imgPortraitSet'),delBtn=document.getElementById('imgPortraitClear'),status=document.getElementById('imgPortraitStatus'),preview=document.getElementById('imgPortraitPreview');
        var esc = window.escapeSvc.esc; // merge 修: refreshWho 用 esc 但本函数未定义（aee803f 收口漏了这处）
        // Bind primitive (imgStyleCard precedent): reflect/listen/write for the style select; the
        // imagestyle:changed repaint rides the bound handle's element as before.
        var bound=window.bindEl.bindText(card,'#imgPortraitStyle',{
          key: 'imgPortraitStyle',
          read: function(){return pt.getStyle();},
          write: function(raw){pt.setStyle(raw);return raw;},
          fallbackGet: null,
          fallbackSet: null,
          onChange: null,
        });
        var sel=bound?bound.el:null;
        if(sel){window.addEventListener('imagestyle:changed',function(e){var v=(e&&e.detail&&e.detail.style)||pt.getStyle();if(sel.value!==v)sel.value=v;});}
        function setMsg(t){if(status)status.textContent=t||'';}
        function activeCard(){try{return window.characterSvc&&window.characterSvc.getActiveCard&&window.characterSvc.getActiveCard();}catch(e){return null;}}
        function refreshWho(){var who=document.getElementById('imgPortraitWho'),c=activeCard();if(who)who.innerHTML=c?'当前角色：<b>'+esc(((c.icon?c.icon+' ':'')+(c.name||'(未命名)')))+'</b>':'<span style="color:#e5484d;">未选择角色卡 — 先去左侧「角色卡」选一个</span>';try{if(window.chatImageSvc&&window.chatImageSvc.getBaseImage&&c){Promise.resolve(window.chatImageSvc.getBaseImage({characterId:c.id||'default'})).then(function(b){if(b&&preview&&!preview.querySelector('[data-gen]'))preview.innerHTML='<div style="text-align:center;"><img src="'+b+'" style="max-width:140px;border-radius:8px;display:block;"><div style="font-size:11px;opacity:.6;margin-top:4px;">当前基准图</div></div>';}).catch(function(){});}}catch(e){}}
        if(genBtn)genBtn.addEventListener('click',async function(){genBtn.disabled=true;setMsg('生成中…（约 10-30 秒）');try{var r=await pt.generateForActive();if(preview)preview.innerHTML='<div style="text-align:center;"><img data-gen="1" src="'+r.url+'" style="max-width:160px;border-radius:8px;display:block;"><div style="font-size:11px;opacity:.6;margin-top:4px;">新立绘：'+(r.name||'')+'</div></div>';if(setBtn)setBtn.disabled=false;setMsg('生成完成，点「设为基准图」锁定。');}catch(e){setMsg('错误：'+((e&&e.message)||e));}genBtn.disabled=false;});
        if(setBtn)setBtn.addEventListener('click',async function(){setBtn.disabled=true;setMsg('保存基准图中…');try{await pt.setAsBase();setMsg('已设为当前角色的发图基准图。');}catch(e){setMsg('错误：'+((e&&e.message)||e));setBtn.disabled=false;}});
        if(delBtn)delBtn.addEventListener('click',async function(){if(!(window.chatImageSvc&&window.chatImageSvc.clearBaseImage)){setMsg('发图模块未就绪');return;}if(!(await uiConfirm('清除当前角色的发图基准图？', { title: '清除基准图', okText: '清除', danger: true })))return;var c=activeCard();delBtn.disabled=true;setMsg('清除中…');try{await window.chatImageSvc.clearBaseImage({characterId:(c&&c.id)||'default'});if(preview)preview.innerHTML='';if(setBtn)setBtn.disabled=true;setMsg('已清除。');}catch(e){setMsg('错误：'+((e&&e.message)||e));}delBtn.disabled=false;});
        refreshWho(); window.addEventListener('character:changed',refreshWho);
        return card;
      }
    });
  }

  function mountImgCacheCard(){
    var cache=window.__imageCache; if(!cache)return;
    window.slotRegistry.declareCard({
      id: 'imgCacheCard',
      slotId: 'settingsImageSlot',
      build: function (slot) {
        var shell=window.cardShell.createCardShell({
          id: 'imgCacheCard',
          title: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>提示词缓存去重',
          desc: '相同提示词在短期内再次生成时，直接复用上次的图，<b>不再消耗当日额度</b>。仅文生图，缓存 6 小时，<b>仅本设备</b>。',
          extra: '<label class="rowline" style="align-items:center;gap:8px;cursor:pointer;"><input type="checkbox" id="imgCacheToggle"><span>启用缓存去重</span></label><div id="imgCacheStats" style="font-size:12px;opacity:.75;margin-top:8px;"></div><div class="rowline" style="margin-top:8px;"><div></div><div class="btns"><button class="smallbtn danger" id="imgCacheClear">清空缓存</button></div></div>'
        });
        var card=shell.card, q=shell.q;
        slot.appendChild(card);
        // Bind primitive: the toggle's reflect/listen/write collapses into bindToggle; the
        // imagecache:changed repaint goes through the handle's refresh(), which re-reads the same
        // cache.isEnabled() the old hand-written refresh set into .checked.
        var tog=window.bindEl.bindToggle(card,'#imgCacheToggle',{
          key: 'imgCacheToggle',
          read: function(){return cache.isEnabled();},
          write: function(on){cache.setEnabled(on);},
          fallbackGet: null,
          fallbackSet: null,
          onChange: null,
        });
        var clr=q('imgCacheClear'),st=q('imgCacheStats');
        function refresh(){if(tog)tog.refresh();if(st){var s=cache.stats();st.textContent='已缓存 '+s.count+' 条，累计省下 '+s.saved+' 次生成';}}
        if(clr)clr.addEventListener('click',function(){cache.clear();});
        window.addEventListener('imagecache:changed',refresh); refresh();
        return card;
      }
    });
  }

  function mountImgAlbumCard(){
    var album=window.imageAlbumSvc; if(!album)return;
    window.slotRegistry.declareCard({
      id: 'imgAlbumCard',
      slotId: 'settingsImageSlot',
      build: function (slot) {
        var shell=window.cardShell.createCardShell({
          id: 'imgAlbumCard',
          title: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="M4 17.5l5-5 3.2 3.2 3.2-3.8 4.1 5"/></svg>本地画廊',
          desc: '工坊/立绘/发图生成的图会自动收进本地相册（浏览器 IndexedDB，最多 60 张）。每张可一键：设为基准图 / 插入对话 / 再改一张 / 下载 / 删除，<b>仅本设备</b>。',
          extra: '<div id="imgAlbumStat" style="font-size:12px;opacity:.75;margin:6px 0;"></div><div class="rowline"><div></div><div class="btns"><button class="smallbtn" id="imgAlbumOpen">打开画廊</button><button class="smallbtn danger" id="imgAlbumClear">清空</button></div></div>'
        });
        var q=shell.q;
        slot.appendChild(shell.card);
        var stat=q('imgAlbumStat');
        function refresh(){album.list().then(function(a){if(stat)stat.textContent='已收藏 '+a.length+' 张';});}
        var ob=q('imgAlbumOpen'); if(ob)ob.addEventListener('click',function(){album.open();});
        var cb=q('imgAlbumClear'); if(cb)cb.addEventListener('click',async function(){ if(await uiConfirm('清空本地画廊？', { title:'清空画廊', okText:'清空', danger:true })) album.clear(); });
        window.addEventListener('imagealbum:changed',refresh); refresh();
        return shell.card;
      }
    });
  }

  function mountTtsCard(){
    if(!window.tauriSvc || !window.tauriSvc.has())return;
    var slot=getVoiceSlot(); if(!slot||document.getElementById('omniTtsCard'))return; // 语音 slot(本地 GPT-SoVITS 是本机服务、非外接 API,留「语音」tab)
    var tts=window.omniTtsSvc; if(!tts)return;
    var c=tts.cfg();
    var LR='cfw_tts_ref_audio_v1',LP='cfw_tts_prompt_text_v1',LA='cfw_tts_autoplay_v1',LSPD='cfw_tts_speed_v1';
    function lsSet(k,v){try{localStorage.setItem(k,v);}catch(e){}}
    var card=document.createElement('div'); card.className='card'; card.id='omniTtsCard';
    card.innerHTML='<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>本地语音</h4><p>用本机 GPT-SoVITS 把 AI 回复读出来，仅桌面版可用。先在托盘「语音启动服务」，再填参考音频。<b>仅本设备</b>。</p><div style="margin-top:8px;"><label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;">参考音频完整路径 (.wav)</label><div style="display:flex;gap:6px;"><input id="omniTtsRef" type="text" style="flex:1;box-sizing:border-box;padding:7px 9px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;"><button class="smallbtn" id="omniTtsRefPick" type="button">选择…</button></div></div><div style="margin-top:10px;"><label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;">参考音频对应文字 (可留空)</label><input id="omniTtsPrompt" type="text" style="width:100%;box-sizing:border-box;padding:7px 9px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;"></div><div style="margin-top:10px;"><label for="omniTtsSpeed" style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:4px;"><span>语速</span><span id="omniTtsSpeedLabel" style="font-variant-numeric:tabular-nums;">1.00×</span></label><input id="omniTtsSpeed" type="range" min="0.5" max="1.5" step="0.05" value="1" style="width:100%;"><div style="font-size:11px;color:var(--muted);margin-top:4px;">向左变慢、向右变快(1.00× 为模型原速)。觉得太快就拉到 0.85～0.9。</div></div><div class="rowline" style="margin-top:10px;"><div class="toggle"><input type="checkbox" id="omniTtsAuto"><label for="omniTtsAuto">自动朗读每条 AI 回复(默认关)</label></div><div class="btns"><button class="smallbtn" id="omniTtsTest" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.5 4.9v14.2L19.5 12z"/></svg>试听</button></div></div><div style="margin-top:12px;border-top:1px solid rgba(127,127,127,.12);padding-top:10px;"><label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;">音色模型（底模，扫描热切，免重启）</label><div class="rowline" style="margin-top:10px;align-items:center;gap:8px;"><select id="omniTtsScanSovits" style="flex:1;padding:6px 8px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:12px;"><option value="">SoVITS(.pth) — 点扫描列出</option></select><select id="omniTtsScanGpt" style="flex:1;padding:6px 8px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:12px;"><option value="">GPT(.ckpt) — 可选</option></select></div><div class="rowline" style="margin-top:6px;"><div style="font-size:11px;color:var(--muted);flex:1;">扫 GPT-SoVITS 目录下 GPT_weights*/SoVITS_weights*,仿 WebUI 列出全部已装底模,免手敲路径</div><div class="btns"><button class="smallbtn" id="omniTtsScan" type="button">扫描已装</button><button class="smallbtn" id="omniTtsScanApply" type="button">应用所选</button></div></div></div><div style="margin-top:12px;border-top:1px solid rgba(127,127,127,.12);padding-top:10px;"><label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;">稳定音色 / 多参考（可选）</label><div id="omniTtsAuxList" style="display:flex;flex-direction:column;gap:6px;"></div><div class="rowline" style="margin-top:8px;gap:6px;"><input id="omniTtsAuxInput" type="text" placeholder="手填 .wav 路径,可一次多条(用 ; 或 | 分隔);或点「选择文件」多选" style="flex:1;padding:6px 8px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:12px;"><div class="btns"><button class="smallbtn" id="omniTtsAuxPick" type="button">选择文件(可多选)</button><button class="smallbtn" id="omniTtsAuxAdd" type="button">＋ 添加</button><button class="smallbtn danger" id="omniTtsAuxClear" type="button">清空全部</button></div></div><div style="font-size:11px;color:var(--muted);margin-top:6px;">多丢几条同一个人的干净 .wav,api_v2 融合多条参考、音色更稳不漂。留空=只用单条主参考。<br>「选择文件」可按住 Ctrl/Shift 一次多选;「添加」是把上面输入框里手填/粘贴的路径入列(选文件已自动入列,不用再点添加)。</div></div><div id="omniTtsStatus" style="font-size:11px;color:var(--muted);margin-top:8px;"></div>';
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
    // ── 稳定音色·多参考:管理辅助参考音列表(omniTtsSvc.getAuxRefs/setAuxRefs),synthWith 自动带 aux_ref_audio_paths ──
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

  // ─── §语音. 云端语音卡（2026-11-25 访客/网页可见）───
  // 云端语音走 Worker /api/tts（key 只在 env），网页版与访客也能用，所以挂在「语音」分类而不是
  // 藏在模型 API 里。语音 tab 此前仅在壳内显示——云端服务一加载就把门控打开（见 settings-cat-nav）。
  function mountCloudTtsCard() {
    var cloud = window.cloudTtsSvc; if (!cloud) return;
    window.slotRegistry.declareCard({
      id: 'cloudTtsCard',
      slotId: 'settingsVoiceSlot',
      build: function (slot) {
        var ready = false;
        try {
          var P = window.providersSvc;
          var ch = P && typeof P.channels === 'function' ? P.channels() : [];
          for (var i = 0; i < ch.length; i++) {
            if (ch[i].kind === 'preset' && ch[i].key === 'preset:deepseek') { ready = ch[i].detail && ch[i].detail.configured === true; break; }
          }
        } catch (e) {}
        var c = cloud.cfg();
        // The card's former inline <style> moved to styles.css under the [data-card="cloudTtsCard"]
        // scope (the W2 per-card stylesheet precedent); the six rules are unchanged apart from the
        // selector prefix. The bare tip (no info glyph) rides in extra verbatim — the shell's
        // standard tip block always carries the glyph.
        var shell = window.cardShell.createCardShell({
          id: 'cloudTtsCard',
          title: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/></svg>云端语音',
          desc: '用服务端 DeepSeek 语音合成把 AI 回复读出来，<b>无需本机启动语音服务</b>，网页版和访客也能用。按量计费（约 ¥0.01/千字符），Key 只在你的 Worker 里。<b>仅本设备</b>。',
          extra: (ready ? ''
            : '<div class="settings-warn"><span>服务端未配置 <code>DEEPSEEK_API_KEY</code>，云端语音不可用。部署侧执行 <code>wrangler secret put DEEPSEEK_API_KEY</code> 后刷新本页。</span></div>')
            + '<div class="ds-kit-sec"><div class="ds-kit-hd">朗读引擎'
            + '<div class="ds-kit-seg"><button type="button" data-engine="off">不朗读</button><button type="button" data-engine="cloud">云端</button><button type="button" data-engine="local">本地</button></div></div>'
            + '<div id="dsKitTtsOpts" style="margin-top:8px;"><div class="rowline"><div class="toggle"><input type="checkbox" id="cloudTtsAuto"><label for="cloudTtsAuto">自动朗读每条 AI 回复</label></div>'
            + '<div class="btns"><select id="cloudTtsVoice" style="padding:6px 8px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:12px;">'
            + '<option value="stella">stella · 女声</option><option value="tide">tide · 男声</option></select>'
            + '<button class="smallbtn" id="cloudTtsTest" type="button">试听</button></div></div></div></div>'
            + '<div id="cloudTtsStatus" style="font-size:11px;color:var(--muted);margin-top:8px;"></div>'
            + '<div class="settings-tip"><span>本地引擎=同分类的 GPT-SoVITS（仅桌面版），云端引擎网页版可用，两者同一句只走一种。朗读按钮在每条 AI 回复左下角。</span></div>'
        });
        var card = shell.card;
        slot.appendChild(card);
        var auto = card.querySelector('#cloudTtsAuto'), voice = card.querySelector('#cloudTtsVoice'), test = card.querySelector('#cloudTtsTest'), st = card.querySelector('#cloudTtsStatus');
        function status(msg) { if (st) st.textContent = msg || ''; }
        function localOn() { try { return normalizeAutoplay(localStorage.getItem(SETTINGS_PAGE_KEYS.autoplay)); } catch (e) { return false; } }
        function localSet(on) { try { localStorage.setItem(SETTINGS_PAGE_KEYS.autoplay, on ? '1' : '0'); } catch (e) {} }
        function currentEngine() { return c.enabled ? 'cloud' : (localOn() ? 'local' : 'off'); }
        function paintEngine() {
          var eng = currentEngine();
          var btns = card.querySelectorAll('.ds-kit-seg button');
          for (var j = 0; j < btns.length; j++) {
            var b = btns[j];
            b.setAttribute('data-on', b.getAttribute('data-engine') === eng ? '1' : '0');
            if (!ready && b.getAttribute('data-engine') === 'cloud') { b.disabled = true; b.style.opacity = '.4'; b.style.cursor = 'not-allowed'; }
          }
          var opts = card.querySelector('#dsKitTtsOpts');
          if (opts) opts.style.display = eng === 'cloud' ? '' : 'none';
          if (auto) auto.checked = c.enabled;
        }
        var segs = card.querySelectorAll('.ds-kit-seg button');
        for (var k = 0; k < segs.length; k++) {
          segs[k].addEventListener('click', function () {
            if (this.disabled) return;
            var eng = this.getAttribute('data-engine');
            cloud.setEnabled(eng === 'cloud');
            localSet(eng === 'local');
            c = cloud.cfg();
            paintEngine();
            status(eng === 'cloud' ? '已切到云端语音' : eng === 'local' ? '已切到本地语音（桌面版需启动 GPT-SoVITS）' : '朗读已关闭');
          });
        }
        paintEngine();
        if (!ready) return card;
        if (auto) auto.addEventListener('change', function () { cloud.setEnabled(auto.checked); if (auto.checked) localSet(false); c = cloud.cfg(); paintEngine(); status(auto.checked ? '已开启云端朗读' : '已关闭'); });
        if (voice) voice.addEventListener('change', function () { cloud.setVoice(voice.value); status('音色已切换为 ' + (voice.value === 'tide' ? 'tide · 男声' : 'stella · 女声')); });
        if (test) test.addEventListener('click', function () {
          status('合成中…');
          cloud.stop();
          cloud.speak('你好，这是 DeepSeek 云端语音的试听。');
          var wait = setInterval(function () { if (!cloud.isPlaying()) { clearInterval(wait); status(cloud.lastError() ? ('失败：' + cloud.lastError()) : '试听完成'); } }, 300);
        });
        return card;
      }
    });
  }

/* l0-wiring-part: closes the shared IIFE; parsed as part of public/services/ui/settings.js */
/**
 * tooling/l0/wiring/settings.js — browser wiring host for services/ui/settings.ts
 *
 * 2026-11-26 拆件：卡片与规则函数在 tooling/l0/wiring/settings/*.js（10-appearance / 20-base / 30-chat /
 * 40-agent / 50-models / 60-sync / 70-images）；本文件只保留分类导航、面板开关、开关接线、
 * init() 与收口。片段由 tooling/l0/emit.mjs 按 WIRING_PARTS 顺序拼接，仍是同一个 IIFE、零新全局。
 */
  // ─── 1. 分类标签切换 ───
  function initCatNav() {
    const nav = document.querySelector('.settings-cat-nav');
    if (!nav) return;
    const items = Array.from(nav.querySelectorAll('.scn-item'));
    const cats  = Array.from(document.querySelectorAll('.set-cat'));
    // 2026-11-17 服务层搬迁：可见性门（devOnly / voice 仅壳内）与「保存的分类失效就回落首个可见」
    // 的决策在 services/ui/settings-cat-nav.ts（window.settingsCatNav），这里只应用计划。
    const plan = window.settingsCatNav.plan(items.map(it => ({ cat: it.dataset.cat, devOnly: !!it.dataset.devOnly })));
    items.forEach(it => {
      if (plan.hidden.indexOf(it.dataset.cat) >= 0) it.style.display = 'none';
    });
    function switchTo(cat) {
      items.forEach(it => it.classList.toggle('active', it.dataset.cat === cat));
      cats.forEach(c  => c.classList.toggle('active',  c.dataset.cat  === cat));
      window.settingsCatNav.save(cat);
    }
    switchTo(plan.active);
    items.forEach(it => it.addEventListener('click', () => switchTo(it.dataset.cat)));
  }

  function initPanelToggle() {
    const settingsBtn    = document.getElementById('settingsBtn');
    const settingsMask   = document.getElementById('settingsMask');
    const closeSettingsBtn = document.getElementById('closeSettings');
    const customPromptEl = document.getElementById('customPrompt');
    const agentPersonalizeEl = document.getElementById('agentPersonalize');
    // 2026-11-25 C6：页面级键与归一化归 services/ui/settings-page.ts（与本接线同一产物）。
    // 2026-11-27: historyKeep 开关退役，打开面板不再回填本机历史开关。
    const LS_CUSTOM      = SETTINGS_PAGE_KEYS.customPrompt;

    function openPanel() {
      if (!settingsMask) return;
      // 2026-10-09: 手机端抽屉(z20) > 设置遮罩(z10) —— 抽屉开着时从它上方点齿轮,
      // 面板会开在抽屉底下,看起来"没反应"。开面板前先收抽屉。
      try { document.body.classList.remove('drawer-open'); } catch (e) {}
      settingsMask.style.display = 'flex';
      mountImageCards();
      mountVoiceCards(); // 4.71
      if (customPromptEl) customPromptEl.value   = localStorage.getItem(LS_CUSTOM) || '';
      // 2026-11-11: 关闭设置时的未保存编辑不保留 —— 每次打开都回读已保存的 Agent 个性化指令。
      if (agentPersonalizeEl) {
        var apCard = document.getElementById('agentPersonalizeCard');
        if (apCard && typeof apCard.__agentPersonalizeReset === 'function') apCard.__agentPersonalizeReset();
        else {
          agentPersonalizeEl.value = localStorage.getItem(SETTINGS_PAGE_KEYS.personalize) || '';
          try { agentPersonalizeEl.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
        }
      }
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
    // 键与极性在 services/ui/settings-toggles.ts（与 app.js 的 stateLayerPayload 同键）。
    el.checked = window.settingsToggles.read('stateLayer');
    el.addEventListener('change', () => {
      window.settingsToggles.write('stateLayer', el.checked);
    });
  }

  // ─── 3. 顶栏组件开关 ───
  function initTopbarToggles() {
    const html = document.documentElement;
    const t = document.getElementById('showTopbarCostToggle');
    if (!t) return;
    const on = window.settingsToggles.read('topbarCost');
    t.checked = on;
    // 这个开关是反极性的：类在「关」时加（hide-topbar-cost），由服务的 planClass 决定。
    const applyCost = (v) => {
      const p = window.settingsToggles.planClass('topbarCost', v);
      if (p.className) html.classList.toggle(p.className, p.add);
    };
    applyCost(on);
    t.addEventListener('change', () => {
      window.settingsToggles.write('topbarCost', t.checked);
      applyCost(t.checked);
    });
  }

  // ─── 4. 对话个性化 toggles / selects ───
  function initChatToggles() {
    const html = document.documentElement;
    const hideMsgEl = document.getElementById('hideMsgActionsToggle');
    if (hideMsgEl) {
      hideMsgEl.checked = window.settingsToggles.read('hideMsgActions');
      hideMsgEl.addEventListener('change', () => {
        window.settingsToggles.write('hideMsgActions', hideMsgEl.checked);
        const p = window.settingsToggles.planClass('hideMsgActions', hideMsgEl.checked);
        if (p.className) html.classList.toggle(p.className, p.add);
      });
    }
    const hideStEl = document.getElementById('hideStatsToggle');
    if (hideStEl) {
      hideStEl.checked = window.settingsToggles.read('hideStats');
      hideStEl.addEventListener('change', () => {
        window.settingsToggles.write('hideStats', hideStEl.checked);
        const p = window.settingsToggles.planClass('hideStats', hideStEl.checked);
        if (p.className) html.classList.toggle(p.className, p.add);
      });
    }
    // 2026-09-10 精简: 删掉「严格角色扮演」toggle 与「NSFW 等级」四档单选。
    //   · 尺度改由锁态派生: unlock.js 写 cfw_nsfw_mode_v1(解锁=3 / 锁定=0),worker 侧按 unlocked 硬算,UI 上不再有可调项;
    //   · 原四档单选配上 theme.js 的自动覆写 = 「选了没用 + 刷新就回弹」,这次一并拔除;
    //   · 严格角色扮演(cfw_strict_roleplay_v1)与强制顺从(cfw_dev_force_comply_v1)两个键已彻底作废（2026-10-05 删掉对应提示词层）。
    // 注: cfw_nsfw_mode_v1 这个 key 不能删 —— chat-image.js / theme.js / tools.js / index.html 的 data-nsfw 都在读它。
    // 2026-11-25 服务层搬迁：回复风格三值白名单（default/wechat/verbose）与缺省 default 内聚在
    // services/ui/settings-reply-style.ts（window.settingsReplyStyle），与 chat/request、peer-calls、
    // app-mode 三处读侧对拍同源。localStorage 原样保留作服务缺席时的回落。
    const replyStyleEl = document.getElementById('replyStyleSel');
    if (replyStyleEl) {
      const rs = window.settingsReplyStyle;
      replyStyleEl.value = rs ? rs.read() : (localStorage.getItem('cfw_reply_style_v1') || 'default');
      replyStyleEl.addEventListener('change', () => {
        if (rs) rs.write(replyStyleEl.value);
        else localStorage.setItem('cfw_reply_style_v1', replyStyleEl.value);
      });
    }
    const fontSizeEl = document.getElementById('chatFontSizeRange');
    const fontSizeLb = document.getElementById('chatFontSizeLabel');
    if (fontSizeEl) {
      let fs = normalizeFontSize(localStorage.getItem(SETTINGS_PAGE_KEYS.fontSize));
      if (!(fs >= 12 && fs <= 22)) fs = 13;
      fontSizeEl.value = String(fs);
      if (fontSizeLb) fontSizeLb.textContent = fs + 'px';
      // range 滑块用 input 事件实时反馈 + 同步 label(原 index.html 显示设置卡内联迁入)
      fontSizeEl.addEventListener('input', () => {
        const v = parseInt(fontSizeEl.value, 10) || 13;
        if (fontSizeLb) fontSizeLb.textContent = v + 'px';
        html.style.setProperty('--chat-font-size', v + 'px');
        localStorage.setItem(SETTINGS_PAGE_KEYS.fontSize, String(v));
      });
    }
    // 2026-11-12 主题与文字：字体预览 + 自定义字体 + 三档文字特效。
    // 纯逻辑在 chat-appearance.js（先于 settings.js 加载）；这里只做控件回填/交互。
    const A = window.__chatAppearance;
    const fontFamilyEl = document.getElementById('chatFontFamilySel');
    const customFontEl = document.getElementById('chatFontCustom');
    const customApply = document.getElementById('chatFontCustomApply');
    const customClear = document.getElementById('chatFontCustomClear');
    const fontPreview = document.getElementById('chatFontPreview');
    const previewLine = document.getElementById('chatFontPreviewLine');
    const previewReplay = document.getElementById('chatFontPreviewReplay');
    const fxEl = document.getElementById('chatTextFxSel');
    const LS_FONT = SETTINGS_PAGE_KEYS.fontFamily;
    const LS_FX = SETTINGS_PAGE_KEYS.textFx;
    function currentFont() {
      if (A) return A.readFont();
      try { return localStorage.getItem(LS_FONT) || ''; } catch (e) { return ''; }
    }
    function currentFx() {
      if (A) return A.readFx();
      try { const v = localStorage.getItem(LS_FX) || 'off'; return (v === 'soft' || v === 'strong') ? v : 'off'; } catch (e) { return 'off'; }
    }
    function applyFontLocal(v) {
      const s = String(v == null ? '' : v).trim();
      if (A) return A.setFont(s);
      try { if (s) localStorage.setItem(LS_FONT, s); else localStorage.removeItem(LS_FONT); } catch (e) {}
      if (s) html.style.setProperty('--chat-font-family', s);
      else html.style.removeProperty('--chat-font-family');
      return s;
    }
    function presetFor(v) {
      if (A) return A.presetFor(v);
      if (!fontFamilyEl || !v) return null;
      return Array.from(fontFamilyEl.options).find(o => o.value === v && o.value !== '__custom__') || null;
    }
    function syncFontUI() {
      const v = currentFont();
      const p = presetFor(v);
      if (fontFamilyEl) fontFamilyEl.value = p ? p.value : (v ? '__custom__' : '');
      if (customFontEl) customFontEl.value = p ? '' : v;
    }
    function syncFxUI() {
      const fx = currentFx();
      if (fxEl) fxEl.value = fx;
      if (fontPreview) fontPreview.setAttribute('data-text-fx', fx);
    }
    // 预览重放：换字体/换效果后，让那句示例诗按当前效果重新出一遍字。
    function replayPreview() {
      if (!previewLine) return;
      previewLine.classList.remove('is-replay');
      void previewLine.offsetWidth; // 强制回流，动画才能重跑
      previewLine.classList.add('is-replay');
    }
    if (previewReplay) previewReplay.addEventListener('click', replayPreview);
    if (fontFamilyEl) {
      fontFamilyEl.addEventListener('change', () => {
        const v = fontFamilyEl.value;
        if (v === '__custom__') { if (customFontEl) customFontEl.focus(); return; }
        applyFontLocal(v);
        if (customFontEl) customFontEl.value = '';
        syncFontUI();
        replayPreview();
      });
    }
    if (customApply && customFontEl) {
      customApply.addEventListener('click', () => {
        const v = applyFontLocal(customFontEl.value);
        if (!v) { customFontEl.focus(); return; }
        syncFontUI();
        replayPreview();
      });
      customFontEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); customApply.click(); }
      });
    }
    if (customClear) {
      customClear.addEventListener('click', () => {
        applyFontLocal('');
        if (customFontEl) customFontEl.value = '';
        syncFontUI();
        replayPreview();
      });
    }
    if (fxEl) {
      fxEl.addEventListener('change', () => {
        const v = fxEl.value;
        if (A) A.setFx(v);
        else {
          try { localStorage.setItem(LS_FX, v); } catch (e) {}
          if (v === 'soft' || v === 'strong') html.setAttribute('data-text-fx', v);
          else html.removeAttribute('data-text-fx');
        }
        syncFxUI();
        replayPreview();
      });
    }
    syncFontUI();
    syncFxUI();
    replayPreview();
  }

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

  window.addEventListener("cfw:external-settings", syncSettingsControlsFromLS);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

globalThis.SETTINGS_PAGE_KEYS = SETTINGS_PAGE_KEYS;
globalThis.SYNCED_CONTROLS = SYNCED_CONTROLS;
globalThis.normalizeHistoryKeep = normalizeHistoryKeep;
globalThis.normalizePromptKeep = normalizePromptKeep;
globalThis.normalizeFontSize = normalizeFontSize;
globalThis.normalizeMode = normalizeMode;
globalThis.normalizeAutoplay = normalizeAutoplay;
globalThis.syncedCheckboxChecked = syncedCheckboxChecked;
})();
