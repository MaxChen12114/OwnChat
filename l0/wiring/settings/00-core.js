/* l0-wiring-part: opens the shared IIFE; parsed as part of public/services/ui/settings.js */
/**
 * l0/wiring/settings/00-core.js — settings 产品的共享外壳。
 *
 * 2026-11-26 拆件：原 2553 行 settings.js 按域拆成 7 个函数片段 + 本外壳 + 宿主。
 * 所有片段由 l0/emit.mjs 按 WIRING_PARTS 顺序拼进同一个 IIFE；函数声明整体提升，
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
