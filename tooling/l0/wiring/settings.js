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