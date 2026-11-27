// @ts-check
/* public/shell/mobile-entry.js
 * ─────────────────────────────────────────────────────────────────────
 * 手机壳 shell bundle v0.5.1
 *
 * 目标：在**不改 index.html 结构、不改 app.js** 的前提下，加一层可拆卸的手机 UI，
 *      同时验证 core 架构计划里「slot registry + 节点搬家」这条路走不走通。
 *
 * v0.5.1（2026-11-26）· 职责与可读材质修正：
 *   ① 插槽解析认 window.slotRegistry，再退到 data-slot 与 id —— rightSidebar 不在
 *      15 项 slot 表里（它是静态 id 容器），旧代码读错了全局名，等于永远走
 *      属性兜底；现在 setConsole 首次打开必定把桌面右栏整块搬进 #shConsoleBody。
 *   ② 两个面写死在页头：沙盘 = 内容台面（agent 挂载页/地图/图片/文档 + #shStage），
 *      控制台 = 桌面右栏的 活动/群聊/状态；沙盘页不渲染控制台内容，两者不合并。
 *   ③ 底栏「控制台」仍是覆盖式抽屉（不切当前页），点「沙盘」才切页。
 *   ④ 控制台在未打开前保持空；打开时若右栏真的缺失，正文给可读提示而不是一块白板。
 *
 * v0.5.0（2026-11-26）· 与桌面共用标签状态机 + 独立沙盘：
 *   右栏标签（services/panel/tab-state.ts → window.panelTabs）成为桌面与手机共用的一份
 *   内容状态机：打开去重、关闭落到邻居、最近关闭都是同一套规则。目录统一读
 *   window.toolCatalog（tool.json 的唯一一次解析），不再手抄 BUILTIN 清单。内置幻想沙盘
 *   从目录摘除，改为外部 URL（cfw_panel_sandbox_url_v1；未配置时舞台显示启动引导）；
 *   GEO 地图只在配了 cfw_panel_map_url_v1 时由宿主页提供。手机只保留一个前台舞台，
 *   切标签按目标标签重建 iframe —— 后台标签不进内存。
 *
 * v0.4.1（2026-11-15）· stage_open 真链路修通：
 *   v0.4.0 把 __panel.open 写成「只入索引 + 点亮 tab 圆点」，但桌面有顶栏 ⊞ 可展开，
 *   手机没有 —— 结果 agent 调 stage_open 返回成功，state() 却报画布空、舞台上什么也没有，
 *   用户点进沙盘还得再点一次卡片。现在 open 立即把 spec 记为当前内容（不抢屏、不切页），
 *   点沙盘 tab / stage_view('canvas') 直接铺开；顺带补 stage_call 的 iframe 转发，
 *   手机端沙盘从「只能看」变成「能驱动」。
 *
 * v0.4.0（2026-11-15）· 沙盘页 + 三 tab 等宽：
 *   ① 命名：「产物」→「沙盘」。旧名只装得下「生成的一张图」，装不下 agent 挂上来的
 *      展示页、地图、讨论区、文档 —— 这些和图片一样，都是「摆在台面上给人看的东西」。
 *      桌面右栏内容画布（__panel.open）就是同一个面，内置第一项甚至就叫「沙盘（幻想地图）」。
 *   ② 落点：手机端 panel-host 在 <1024px 直接 return，__panel.open 恒回「画布未装配」，
 *      agent 的 stage_open 挂的东西无处可去。壳在手机态补齐 __panel 的 open/close/state/tools，
 *      把内容路由到沙盘页的覆盖式 iframe 视图；桌面态原样还原，一个字节不改 panel-host。
 *   ③ 视觉：底栏三个按钮改回等宽。v0.2.0 用 78px 窄钮 + 分隔线表达「控制台是从属面板」，
 *      语义成立但与另两个 tab 并排时宽窄不一，实际看着别扭；现在三者同宽同形，
 *      控制台仍是覆盖式抽屉（不切走当前页），靠 .on 高亮与遮罩表达开合。
 *
 * v0.3.0（2026-11-14）· 顶栏状态胶囊：
 *   手机顶栏原来并排放「免费/快速」按钮 + 模型下拉，390px 宽下模型条吃掉 188px，
 *   剩下挤到「工作/角色扮演」和设置键没地方。现在把这两个控件**搬进**胶囊弹层，
 *   顶栏只留一枚胶囊（显示「免费 · 模型名」），点开才是本体。
 *   搬的是真节点（不是复制），事件绑定、app.js 的 applyMode/fitModelSelectWidth
 *   全部照旧；桌面 ≥1024px 自动搬回原位，桌面完全无感。
 *
 * v0.2.0（2026-11-14）· 底栏与页面组织重构：
 *   ① 主题：CSS 令牌改挂主站四主题真实覆盖的变量（详见 mobile-shell.css 头注释）。
 *      代码侧不再注入任何硬编码颜色。
 *   ② 视觉：dock 与页头统一到 #topbar 的语言（直角贴边 / 1px 边 / blur / 9px 控件）。
 *   ③ 命名：「演示台」→「控制台」（它搬的是右栏 活动/群聊/状态，本就是控制台，
 *      而桌面「演示台 / stage」指的是内容展示画布，两者语义撞车）；
 *      「作品」→「产物」（展示面就叫产物），页内分段改成类型维度（全部/图片/地图），
 *      不再出现「作品 > 产物」这种容器与子项同义反复。
 *   ④ 组织：对话、产物是**页面**，控制台是**当前会话的从属面板** —— 从底部升起，
 *      不切走当前页、不打断上下文。底栏因此是 2 个等宽页面 tab + 1 个窄面板钮，
 *      用形态差异表达层级，而不是把三种不同性质的东西摆成三个平级 tab。
 *
 * 三条纪律：
 *   1. 插槽只经 slot() 读 —— L1b slot registry 就绪后只改这一个函数
 *   2. 跨模块只经 api() 取 —— L1a hostApi 收口 93 个 window.__* 后只改这一个函数
 *   3. 布局只搬节点、不写业务状态 —— core 不需要知道壳存在
 *
 * 开关：
 *   ?shell=off     完全停用（保留旧四 tab 底栏）
 *   ?shell=mobile  桌面窗口也强制启用（调试用）
 *   ?page=work     / ?page=sandbox   直达沙盘页（work 是 v0.2.0 旧参数，保留兼容）
 *   ?page=console  / ?page=stage     打开控制台面板（stage 是 v0.1.0 的旧参数，保留兼容）
 *   ?cap=1         开壳时直接展开状态胶囊（调试用）
 *
 * 接线：index.html 的 boot 清单末位，别处零改动。
 * ─────────────────────────────────────────────────────────────────────
 */
(function () {
  'use strict';

  var VERSION = '0.5.1';
  var params = new URLSearchParams(location.search);
  if (params.get('shell') === 'off') return;

  var FORCE = params.get('shell') === 'mobile';
  var MQ = window.matchMedia('(max-width: 1023px)');
  var html = document.documentElement;
  var built = false;
  /** @type {'chat'|'work'} */
  var current = 'chat';
  var consoleOpen = false;
  var capOpen = false;
  var capObserver = null;
  // 直达参数只吃一次，避免 resize 触发 apply() 时把用户手动关掉的面板又掀开
  var bootParam = params.get('page');
  if (bootParam === 'work' || bootParam === 'sandbox') current = 'work';
  var bootConsole = (bootParam === 'console' || bootParam === 'stage');
  var bootCap = params.get('cap') === '1';

  var CSS_HREF = '/shell/mobile-shell.css?v=' + VERSION;

  /* ── 契约适配层 ─────────────────────────────────────────────── */

  /** L1b：插槽解析。registry 不在就用属性兜底。 */
  function slot(name) {
    var host = /** @type {any} */ (window);
    // L1b 的唯一注册表全局就是 slotRegistry，不再引入新的契约名。
    var reg = host.slotRegistry;
    var el = reg && typeof reg.get === 'function' ? reg.get(name) : null;
    if (el) return /** @type {HTMLElement|null} */ (el);
    var marked = document.querySelector('[data-slot="' + name + '"]');
    if (marked) return /** @type {HTMLElement|null} */ (marked);
    // 静态 id 容器（rightSidebar）不在 15 项 slot 表里，按 id 兜底。
    return /** @type {HTMLElement|null} */ (document.getElementById(name));
  }

  /** L1a：全局对象代理。hostApi 不在就退回旧的 window 全局（__ 前缀）。 */
  function api(name) {
    var host = /** @type {any} */ (window).__host;
    return (host && host[name]) || /** @type {any} */ (window)['__' + name];
  }

  /* ── 样式注入（bundle 自带资源，不写 index.html） ─────────────── */

  function injectCss() {
    if (document.querySelector('link[data-shell-css]')) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CSS_HREF;
    link.setAttribute('data-shell-css', '1');
    document.head.appendChild(link);
  }

  /* ── 搬家 ─────────────────────────────────────────────────────── */

  /** @param {HTMLElement} el */
  function remember(el) {
    var any = /** @type {any} */ (el);
    if (!any.__home) any.__home = { parent: el.parentNode, next: el.nextSibling };
  }

  /** @param {HTMLElement} el @param {HTMLElement} host */
  function moveTo(el, host) {
    remember(el);
    var y = el.scrollTop;
    host.appendChild(el);
    if (y) requestAnimationFrame(function () { el.scrollTop = y; });
  }

  /** @param {HTMLElement} el */
  function moveHome(el) {
    var any = /** @type {any} */ (el);
    var home = any.__home;
    if (!home || !home.parent) return;
    var y = el.scrollTop;
    home.parent.insertBefore(el, home.next);
    if (y) requestAnimationFrame(function () { el.scrollTop = y; });
  }

  /** 控制台 = 桌面右栏整块搬过来（活动 / 群聊 / 状态 三栏 tab 随之可用，不用重写内容） */
  function placeStage() {
    var aside = slot('rightSidebar');
    var host = document.getElementById('shConsoleBody');
    if (!host) return false;
    var missing = host.querySelector('[data-sh-console-missing]');
    if (!aside) {
      // 右栏是静态 #rightSidebar，正常不会缺；真缺时给一句可读提示，别让用户盯空抽屉。
      if (!host.childElementCount) {
        host.innerHTML = '<div class="sh-hint" data-sh-console-missing><b>桌面右栏未就绪</b>' +
          '控制台读取的是桌面右栏「活动 / 群聊 / 状态」。右栏挂载后重新打开控制台即可。</div>';
      }
      return false;
    }
    if (missing) missing.remove();
    if (aside.parentNode !== host) moveTo(aside, host);
    return true;
  }

  function homeStage() {
    var aside = slot('rightSidebar');
    if (aside) moveHome(aside);
  }

  /* ── 顶栏状态胶囊（v0.3.0） ─────────────────────────────────────
   * 搬的是**真节点**：#modeToggle 与 .model-pill 进弹层，桌面自动搬回。
   * 只搬不复制 —— app.js / channel-mode.js 的引用与事件绑定全部保持有效。
   */

  /** 胶囊上的摘要文字：模式 · 模型名（模型名缺失时给占位，别留空） */
  function capsuleText() {
    var mode = document.getElementById('modeToggle');
    var selEl = document.getElementById('modelSel');
    var sel = selEl instanceof HTMLSelectElement ? selEl : null;
    var modeTxt = '';
    if (mode) {
      var t = mode.querySelector('.btn-text');
      modeTxt = ((t ? t.textContent : mode.textContent) || '').trim();
    }
    var modelTxt = '';
    try {
      if (sel && sel.selectedIndex >= 0 && sel.options[sel.selectedIndex]) {
        modelTxt = (sel.options[sel.selectedIndex].textContent || '').trim();
      }
    } catch (e) {}
    if (!modelTxt) modelTxt = '选择模型';
    return (modeTxt ? modeTxt + ' · ' : '') + modelTxt;
  }

  function syncCapsule() {
    var btn = document.getElementById('shCapsule');
    if (!btn) return;
    var txt = capsuleText();
    var label = btn.querySelector('.sh-cap-text');
    if (label && label.textContent !== txt) label.textContent = txt;
    if (btn.title !== txt) btn.title = txt;
    var mode = document.getElementById('modeToggle');
    var mt = '';
    if (mode) {
      var t = mode.querySelector('.btn-text');
      mt = ((t ? t.textContent : mode.textContent) || '').trim();
    }
    btn.classList.toggle('is-fast', mt.indexOf('快速') >= 0);
  }

  /** 手机态：把两个控件搬进弹层，胶囊插到原 modeToggle 的位置 */
  function placeCapsule() {
    var inner = document.querySelector('.topbar-inner');
    if (!inner) return;
    var cap = document.getElementById('shCapsule');
    if (!cap) {
      cap = document.createElement('button');
      cap.id = 'shCapsule';
      cap.className = 'sh-capsule';
      cap.setAttribute('aria-haspopup', 'dialog');
      cap.setAttribute('aria-expanded', 'false');
      cap.innerHTML =
        '<span class="sh-cap-dot" aria-hidden="true"></span>' +
        '<span class="sh-cap-text"></span>' +
        '<svg class="sh-cap-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
      cap.addEventListener('click', function () { setCapsule(!capOpen); });
    }
    if (cap.parentNode !== inner) {
      var anchor = document.getElementById('modeToggle');
      inner.insertBefore(cap, anchor && anchor.parentNode === inner ? anchor : inner.firstChild);
    }
    var body = document.getElementById('shCapsuleBody');
    var mode = document.getElementById('modeToggle');
    // querySelector 返回 Element，moveTo 要 HTMLElement —— 用 instanceof 收窄，别用 as 断言
    var found = document.querySelector('.model-pill');
    var pill = found instanceof HTMLElement ? found : null;
    if (body && mode && mode.parentNode !== body) moveTo(mode, body);
    if (body && pill && pill.parentNode !== body) moveTo(pill, body);
    syncCapsule();
    // 模型清单是异步拉的（"正在等待拉取" → 真实名字），没有事件可听，只能盯 DOM
    if (!capObserver && window.MutationObserver) {
      capObserver = new MutationObserver(syncCapsule);
      if (mode) capObserver.observe(mode, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'title'] });
      var sel = document.getElementById('modelSel');
      if (sel) capObserver.observe(sel, { childList: true, subtree: true, characterData: true, attributes: true });
    }
  }

  /** 桌面态：两个控件搬回原位，停掉观察 */
  function homeCapsule() {
    if (!built) return; // 桌面从未建壳：没搬过东西，也就不必为此建一份壳 DOM
    setCapsule(false);
    var found = document.querySelector('.model-pill');
    var pill = found instanceof HTMLElement ? found : null;
    var mode = document.getElementById('modeToggle');
    if (pill) moveHome(pill);
    if (mode) moveHome(mode);
    if (capObserver) { capObserver.disconnect(); capObserver = null; }
  }

  /** @param {boolean} open */
  function setCapsule(open) {
    if (!built) return;
    capOpen = !!open;
    html.classList.toggle('shell-cap-open', capOpen);
    var pop = document.getElementById('shCapPop');
    var btn = document.getElementById('shCapsule');
    if (pop) {
      pop.setAttribute('aria-hidden', capOpen ? 'false' : 'true');
      if (capOpen) {
        // 弹层贴着顶栏下沿：顶栏是 sticky 且高度会随字号变，硬编码会错位
        var bar = document.getElementById('topbar');
        var bottom = bar ? Math.round(bar.getBoundingClientRect().bottom) : 52;
        pop.style.top = Math.max(0, bottom) + 'px';
        syncCapsule();
      }
    }
    if (btn) btn.setAttribute('aria-expanded', capOpen ? 'true' : 'false');
  }

  /* ── 建壳 ─────────────────────────────────────────────────────── */

  var ICONS = {
    // 对话：单气泡
    chat: '<path d="M20.5 11.3a7.7 7.7 0 0 1-11 6.96L4 19.5l1.26-5.34A7.7 7.7 0 1 1 20.5 11.3z"/>',
    // 沙盘：等距台面 + 分格 —— 地图、挂载页、图片、文档都摆在这个面上
    work: '<path d="M3 8.5l9-4 9 4-9 4z"/><path d="M3 8.5v7l9 4 9-4v-7"/><path d="M12 12.5v7"/><path d="M7.5 10.4l4.5 2 4.5-2"/>',
    // 控制台：三根滑杆（活动 / 群聊 / 状态的调节面，不是展示面）
    console: '<path d="M4 7h16M4 12h16M4 17h16"/><circle cx="9" cy="7" r="2.1"/><circle cx="15" cy="12" r="2.1"/><circle cx="8" cy="17" r="2.1"/>'
  };

  /** 关闭按钮（与顶栏 .iconbtn 同款 34×34 / 9px，见 CSS .sh-close） */
  var CLOSE_ICON =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  /* ── 沙盘：内容舞台（v0.4.0）──────────────────────────────────────
   * 桌面内容落在 __panel（panel-host.js 的右栏画布）；手机端 panel-host 在 <1024px
   * 直接 return，__panel.open 恒回「画布未装配」，agent 的 stage_open 挂的东西没处去。
   * 壳在手机态补齐同一份契约的 open/close/state/view/tools，把内容路由到沙盘页的
   * 覆盖式 iframe 视图；桌面态原样还原。不改 panel-host、不改 stage-tools、不新增全局。
   */

  var MAP_URL_KEY = 'cfw_panel_map_url_v1';
  var KIND_ICON = {
    map: ICONS.work,
    mount: '<rect x="4" y="3.5" width="16" height="17" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17l5-4 4 3 3-2 4 3"/>',
    doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>'
  };
  var EMPTY = {
    all: ['沙盘是什么', 'agent 挂上来的展示页、地图、讨论区与文档，都摆在这个内容台面上；点卡片在页内打开，不跳走对话。控制台是另一块面：底栏「控制台」打开桌面右栏的活动 / 群聊 / 状态。'],
    mount: ['还没有挂载内容', 'agent 用 stage_open 挂上来的展示页会收在这里；桌面右栏与手机沙盘共用同一份标签状态机。'],
    map: ['地图入口', '沙盘是独立仓，地址在「设置 → 内容面板」里填；GEO 地图只有配了地址才出现。'],
    image: ['图片索引未接', '对话里生成的插图与形象卡暂时仍回对话查看；这里先留位，等产物索引落地再填，不造空清单。'],
    doc: ['文档索引未接', '导出的文档与报告暂时仍回对话或下载查看；这里先留位，等产物索引落地再填，不造空清单。']
  };

  // Shared tab state (services/panel/tab-state.ts): the mobile shell keeps its own single-stage UI
  // but the identity/dedupe/close rules are the desktop ones. No second catalogue here either —
  // window.toolCatalog is the single parse of tool.json, and host pages come from panelTabs.
  var tabs = window.panelTabs.empty();
  var stageSpec = null;   // what the stage currently shows (title/url/html/text/mode)
  var stageTabId = '';    // which tab owns the stage; empty = inline one-off content
  var pageSeq = 0;
  var workSeg = 'all';
  var panelOrig = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function iconSvg(paths, size) {
    var n = size || 22;
    return '<svg width="' + n + '" height="' + n + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
  }

  function readStoredUrl(key) {
    try { return String(localStorage.getItem(key) || '').trim(); } catch (e) { return ''; }
  }

  /** Catalog + host pages, the same merge the desktop host performs.
   *  Host pages consume window.sandboxViews (services/sandbox/views.ts): the sandbox tab defaults
   *  to demo/play.html and a second 星图 tab appears once the source is configured. */
  function pages() {
    var cat = window.toolCatalog && typeof window.toolCatalog.entries === 'function'
      ? window.toolCatalog.entries() : [];
    var fromCatalog = window.panelTabs.pagesFromCatalog(cat, { panel: true });
    var host = window.panelTabs.hostPages({ geoUrl: readStoredUrl(MAP_URL_KEY), views: window.sandboxViews });
    return window.panelTabs.mergePages(fromCatalog, host);
  }

  function specOf(tab) {
    if (!tab) return null;
    var c = window.panelTabs.contentOf(tab, pages());
    if (!c) return null;
    var spec = { title: String(c.title || tab.title), mode: c.mode };
    if (c.url) spec.url = c.url;
    if (c.html) spec.html = c.html;
    if (c.text) spec.text = c.text;
    return spec;
  }

  /** 卡片清单 = 已开标签 + 目录/宿主页（GEO 只在配了地址时由 hostPages 提供） */
  function allItems() {
    var list = [];
    tabs.tabs.forEach(function (t) {
      var c = window.panelTabs.contentOf(t, pages());
      var sub = c && c.url ? String(c.url) : (c && c.html ? '内联 HTML' : '纯文本');
      list.push({ id: t.id, title: t.title, sub: sub, kind: 'mount', url: c && c.url ? String(c.url) : '' });
    });
    pages().forEach(function (pg) {
      list.push({
        id: 'page:' + pg.id, title: pg.label,
        sub: pg.href || '未配置 · 打开看启动引导',
        kind: pg.id === 'sandbox' || pg.id === 'starmap' || pg.id === 'map' ? 'map' : 'mount',
        url: pg.href || ''
      });
    });
    return list;
  }

  function cardHtml(it) {
    return '<button type="button" class="sh-card" data-open="' + esc(it.id) + '">' +
      '<span class="th">' + iconSvg(KIND_ICON[it.kind] || KIND_ICON.mount) + '</span>' +
      '<span class="tt2">' + esc(it.title) + '</span>' +
      '<span class="ss">' + esc(it.sub) + '</span></button>';
  }

  function renderWork(which) {
    if (which) workSeg = which;
    var panes = document.getElementById('shWorkPanes');
    if (!panes) return;
    var items = allItems().filter(function (it) { return workSeg === 'all' || it.kind === workSeg; });
    var html = items.length ? '<div class="sh-grid">' + items.map(cardHtml).join('') + '</div>' : '';
    var e = EMPTY[workSeg] || EMPTY.all;
    html += '<div class="sh-hint"><b>' + esc(e[0]) + '</b>' + esc(e[1]) + '</div>';
    panes.innerHTML = html;
  }

  /** 新内容到了不抢屏：只在沙盘 tab 上点一个小圆点，跟桌面顶栏 ⊞ 一个语义 */
  function markNew(on) {
    var b = document.querySelector('.sh-item[data-page="work"]');
    if (b) b.classList.toggle('has-new', !!on);
  }

  /** stage_call 的手机实现：把调用转发进舞台 iframe，协议与 panel-frame 的 call/call-result 一致 */
  var callSeq = 0;
  function stageCall(fn, args, timeoutMs, id) {
    var name = String(fn || '').trim();
    if (!name) return Promise.reject(new Error('stage_call 需要 fn'));
    var target = id ? window.panelTabs.byId(tabs, id) : window.panelTabs.active(tabs);
    if (!target) return Promise.reject(new Error('画布是空的 —— 先用 stage_open 打开一个页面'));
    if (target.id !== tabs.activeId) {
      tabs = window.panelTabs.activate(tabs, target.id);
      renderWork();
      showTab(window.panelTabs.active(tabs));
    }
    var found = document.querySelector('#shStageBox iframe');
    var f = found instanceof HTMLIFrameElement ? found : null;
    var win = f && f.contentWindow;
    if (!win) return Promise.reject(new Error('沙盘画布还没就绪 —— 先在沙盘页打开这个内容'));
    var ms = Math.max(1000, Math.min(120000, parseInt(String(timeoutMs || 0), 10) || 15000));
    var callId = 'sh' + (++callSeq);
    return new Promise(function (resolve, reject) {
      function cleanup() { window.removeEventListener('message', onMsg); clearTimeout(timer); }
      function onMsg(ev) {
        var d = ev.data || {};
        if (!d || d.__panel !== 1 || d.type !== 'call-result' || !d.data || d.data.id !== callId) return;
        if (ev.source && ev.source !== win) return;
        cleanup();
        if (d.data.ok) resolve(d.data.result);
        else reject(new Error(d.data.error || '画布调用失败'));
      }
      var timer = setTimeout(function () {
        cleanup();
        reject(new Error('画布没有回应 ' + name + '（' + Math.round(ms / 1000) + ' 秒）'));
      }, ms);
      window.addEventListener('message', onMsg);
      try { win.postMessage({ __panel: 1, type: 'call', data: { id: callId, fn: name, args: args } }, '*'); }
      catch (e) { cleanup(); reject(e); }
    });
  }

  /**
   * 在沙盘页里打开一份内容。同一个标签重复进入不重载（沙盘世界不会莫名其妙换一张）；
   * 切标签时按目标标签重建 iframe —— 手机上永远只有一个前台舞台，后台标签不进内存。
   */
  function openStage(spec, tabId) {
    build();
    spec = spec || {};
    var host = document.getElementById('shStage');
    var box = document.getElementById('shStageBox');
    var titleEl = document.getElementById('shStageTitle');
    if (!host || !box) return;
    if (titleEl) titleEl.textContent = String(spec.title || '内容');
    var same = !!tabId && tabId === stageTabId && !!box.firstChild;
    if (!same) {
      stageTabId = tabId || '';
      box.innerHTML = '';
      if (spec.text != null && !spec.url && spec.html == null) {
        var pre = document.createElement('pre');
        pre.className = 'sh-stage-text';
        pre.textContent = String(spec.text);
        box.appendChild(pre);
      } else {
        var f = document.createElement('iframe');
        f.setAttribute('title', String(spec.title || '沙盘内容'));
        f.setAttribute('loading', 'lazy');
        // 自家页要读同源 localStorage 的主题，不套 sandbox；内联 HTML 与外链进隔离沙箱
        if (spec.mode === 'host-html' || spec.mode === 'external') f.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups');
        if (spec.url) f.src = String(spec.url);
        else f.srcdoc = String(spec.html || '');
        box.appendChild(f);
      }
    }
    stageSpec = spec;
    host.hidden = false;
  }

  /** @param {boolean} [clear] 真清空（stage_close）；否则只收起视图，iframe 留着复用 */
  function closeStage(clear) {
    var host = document.getElementById('shStage');
    if (host) host.hidden = true;
    if (!clear) return;
    var box = document.getElementById('shStageBox');
    if (box) box.innerHTML = '';
    stageSpec = null;
    stageTabId = '';
  }

  function openStageWindow() {
    if (!stageSpec || !stageSpec.url) return;
    try { window.open(String(stageSpec.url), '_blank', 'noopener'); } catch (e) {}
  }

  function showTab(tab) {
    var spec = specOf(tab);
    if (!spec) { closeStage(true); return; }
    openStage(spec, tab ? tab.id : '');
    markNew(false);
  }

  function openPageItem(pageId) {
    tabs = window.panelTabs.open(tabs, { pageId: pageId }, pages(), { now: Date.now(), seq: ++pageSeq });
    renderWork();
    showTab(window.panelTabs.active(tabs));
  }

  function openStageById(id) {
    var key = String(id || '');
    if (key.indexOf('page:') === 0) { openPageItem(key.slice(5)); return; }
    var next = window.panelTabs.activate(tabs, key);
    if (next !== tabs) { tabs = next; renderWork(); showTab(window.panelTabs.active(tabs)); return; }
    var page = window.panelTabs.findPageById(key, pages());
    if (page) openPageItem(page.id);
  }

  /** 手机态把 __panel 的空壳补成能用的画布；桌面态由 unpatchPanel 还原 */
  function patchPanel() {
    var p = api('panel');
    if (!p || p.v !== 1) return;
    if (!panelOrig) {
      panelOrig = {
        open: p.open, openPage: p.openPage, expand: p.expand, close: p.close,
        state: p.state, view: p.view, tools: p.tools, call: p.call
      };
    }
    p.open = function (spec) {
      spec = spec || {};
      tabs = window.panelTabs.open(tabs, spec, pages(), { now: Date.now(), seq: ++pageSeq });
      var tab = window.panelTabs.active(tabs);
      if (!tab) return { ok: false, error: '至少给 page / url / html / text 之一。' };
      var nextSpec = specOf(tab);
      renderWork();
      // 当前内容**立即生效**：桌面有顶栏 ⊞ 可展开，手机没有，所以 state/view/call
      // 必须马上认这份 spec；只是不切页、不弹 iframe（不抢用户的屏幕）。
      stageSpec = nextSpec;
      if (current === 'work') {
        if (nextSpec) openStage(nextSpec, tab.id);
        markNew(false);
      } else {
        markNew(true);               // 在对话里：只点亮 tab，点进沙盘即展开
      }
      return { ok: true, mode: nextSpec ? nextSpec.mode : '', title: tab.title, id: tab.id };
    };
    p.openPage = function (id) { return p.open({ pageId: id }); };
    p.expand = function () { go('work'); };
    p.close = function (id) {
      var target = id || tabs.activeId;
      if (!target) return { ok: true, id: '' };
      var next = window.panelTabs.close(tabs, target, { now: Date.now() });
      if (next === tabs) return { ok: false, error: '没有这个标签：' + target };
      tabs = next;
      renderWork();
      if (stageTabId === target) {
        var active = window.panelTabs.active(tabs);
        if (active) showTab(active); else closeStage(true);
      }
      markNew(false);
      return { ok: true, id: target };
    };
    p.state = function () {
      var tab = window.panelTabs.active(tabs);
      return {
        expanded: current === 'work', width: window.innerWidth,
        view: stageSpec ? 'canvas' : 'activity', tab: 'fishbowl',
        hasContent: tabs.tabs.length > 0, activeId: tabs.activeId,
        title: tab ? tab.title : '',
        tabs: tabs.tabs.map(function (t) {
          return { id: t.id, title: t.title, pageId: t.pageId, icon: t.icon, active: t.id === tabs.activeId };
        }),
        catalog: pages().map(function (pg) {
          return { id: pg.id, title: pg.label, url: pg.href || '', icon: pg.icon || '' };
        })
      };
    };
    p.view = function (name) {
      if (name !== 'canvas' || !stageSpec) return;
      go('work');
      var tab = window.panelTabs.active(tabs);
      if (tab) showTab(tab);
    };
    p.tools = function () {
      return pages().map(function (pg) {
        return { id: pg.id, title: pg.label, url: pg.href || '', icon: pg.icon || '' };
      });
    };
    p.call = stageCall;
  }

  function unpatchPanel() {
    var p = api('panel');
    if (!p || !panelOrig) return;
    Object.keys(panelOrig).forEach(function (k) { p[k] = panelOrig[k]; });
    panelOrig = null;
  }

  /**
   * v0.4.0：三个按钮同宽同形。控制台仍开覆盖式抽屉（不切走当前页），
   * 但从属层级改由 .on 高亮 + 遮罩表达，不再用 78px 窄钮制造宽窄不齐。
   * @param {'chat'|'work'|'console'} key
   * @param {string} label
   * @param {boolean} [panel]  点击时开抽屉而不是切页
   */
  function dockItem(key, label, panel) {
    var cls = 'sh-item' + (key === 'chat' && !panel ? ' on' : '');
    var attr = panel ? 'data-panel="console"' : 'data-page="' + key + '"';
    var aria = panel
      ? 'role="button" aria-label="控制台（桌面右栏 · 活动 / 群聊 / 状态，覆盖在当前页之上）" aria-expanded="false" aria-controls="shConsole"'
      : 'aria-label="' + label + '"';
    return '<button class="' + cls + '" ' + attr + ' ' + aria + '>' +
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[key] + '</svg>' +
      '<span>' + label + '</span></button>';
  }

  /** 页头：与 #topbar 同款，不再自造一套标题条语言 */
  function head(title, sub) {
    return '<div class="sh-head">' +
      '<h2>' + title + '</h2>' +
      (sub ? '<span class="sh-sub">' + sub + '</span>' : '') +
      '<button class="sh-close" data-back="1" aria-label="返回对话">' + CLOSE_ICON + '</button>' +
      '</div>';
  }

  function build() {
    if (built) return;
    injectCss();

    var wrap = document.createElement('div');
    wrap.id = 'mobileShell';
    wrap.innerHTML =
      '<div class="sh-body">' +
        '<section class="sh-page on" data-page="chat" aria-label="对话"></section>' +

        /* 沙盘：一个「摆给人看」的台面。agent 挂上来的展示页、地图、图片、文档都算内容，
           不再只有图片算产物。卡片由 renderWork() 按分段填，内容在页内 iframe 里打开。 */
        '<section class="sh-page" data-page="work" aria-label="沙盘">' +
          head('沙盘', '内容台面') +
          '<div class="sh-body-in" id="shWorkBody">' +
            '<div class="sh-seg" id="shWorkSeg">' +
              '<button data-seg="all" class="on">全部</button>' +
              '<button data-seg="mount">挂载</button>' +
              '<button data-seg="map">地图</button>' +
              '<button data-seg="image">图片</button>' +
              '<button data-seg="doc">文档</button>' +
            '</div>' +
            '<div class="sh-panes" id="shWorkPanes"></div>' +
          '</div>' +
          /* 内容舞台：覆盖在沙盘页之上，返回即回收藏起来的 iframe（不重载） */
          '<section class="sh-stage" id="shStage" hidden aria-label="沙盘内容">' +
            '<div class="sh-stage-bar">' +
              '<button class="sh-stage-btn" data-stage-back="1" aria-label="返回沙盘">返回</button>' +
              '<b id="shStageTitle">内容</b>' +
              '<button class="sh-stage-btn" data-stage-open="1" aria-label="在新窗口打开">新窗</button>' +
            '</div>' +
            '<div class="sh-stage-box" id="shStageBox"></div>' +
          '</section>' +
        '</section>' +

        /* 控制台：桌面右栏 活动/群聊/状态的覆盖式抽屉，从任何页面唤起，不切走当前页。
           注意：它不是沙盘 —— 沙盘摆 agent 的内容，控制台看过程与状态。 */
        '<div class="sh-scrim" data-close-console="1" aria-hidden="true"></div>' +
        '<section class="sh-console" id="shConsole" role="dialog" aria-label="控制台（桌面右栏：活动 / 群聊 / 状态）" aria-hidden="true">' +
          '<div class="sh-head">' +
            '<h2>控制台</h2><span class="sh-sub">活动 / 群聊 / 状态</span>' +
            '<button class="sh-close" data-close-console="1" aria-label="收起控制台">' + CLOSE_ICON + '</button>' +
          '</div>' +
          '<div class="sh-body-in" id="shConsoleBody"></div>' +
        '</section>' +
      '</div>' +
      /* 状态胶囊弹层：里面放的是顶栏搬过来的真控件（免费/快速 与 模型下拉） */
      '<div class="sh-cap-scrim" data-close-cap="1" aria-hidden="true"></div>' +
      '<section class="sh-cap-pop" id="shCapPop" role="dialog" aria-label="模式与模型" aria-hidden="true">' +
        '<div class="sh-head">' +
          '<h2>模式与模型</h2><span class="sh-sub">免费 / 快速 · 模型</span>' +
          '<button class="sh-close" data-close-cap="1" aria-label="收起">' + CLOSE_ICON + '</button>' +
        '</div>' +
        '<div class="sh-cap-body" id="shCapsuleBody"></div>' +
        '<div class="sh-cap-tip">顶栏放不下的控件收在这里，改完直接生效；桌面端会自动搬回顶栏原位。</div>' +
      '</section>' +
      '<nav class="sh-dock" aria-label="主导航">' +
        dockItem('chat', '对话') + dockItem('work', '沙盘') + dockItem('console', '控制台', true) +
      '</nav>';
    document.body.appendChild(wrap);

    wrap.addEventListener('click', function (e) {
      var t = /** @type {HTMLElement} */ (e.target);
      if (!t.closest) return;
      if (t.closest('[data-close-cap]')) { setCapsule(false); return; }
      var close = t.closest('[data-close-console]');
      if (close) { setConsole(false); return; }
      var panelBtn = t.closest('[data-panel]');
      if (panelBtn) { setConsole(!consoleOpen); return; }
      var card = t.closest('[data-open]');
      if (card) { openStageById(/** @type {HTMLElement} */ (card).dataset.open); return; }
      if (t.closest('[data-stage-back]')) { closeStage(false); return; }
      if (t.closest('[data-stage-open]')) { openStageWindow(); return; }
      var item = /** @type {HTMLElement} */ (t.closest('.sh-item'));
      if (item && item.dataset.page) { go(/** @type {'chat'|'work'} */ (item.dataset.page)); return; }
      if (t.closest('[data-back]')) { go('chat'); return; }
      var seg = t.closest('[data-seg]');
      if (seg) {
        var which = /** @type {HTMLElement} */ (seg).dataset.seg;
        var box = document.getElementById('shWorkBody');
        if (!box) return;
        box.querySelectorAll('[data-seg]').forEach(function (b) {
          b.classList.toggle('on', /** @type {HTMLElement} */ (b).dataset.seg === which);
        });
        renderWork(which);
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var stage = document.getElementById('shStage');
      if (stage && !stage.hidden) { closeStage(false); return; }
      if (capOpen) { setCapsule(false); return; }
      if (consoleOpen) setConsole(false);
    });

    built = true;
    renderWork('all');
  }

  /* ── 路由 ─────────────────────────────────────────────────────── */

  /** 控制台开合。右栏只在首次打开时搬一次，收起后留在面板里（显隐交给 CSS）。 */
  function setConsole(open) {
    build();
    consoleOpen = !!open;
    if (consoleOpen) { setCapsule(false); placeStage(); }
    html.classList.toggle('shell-console-open', consoleOpen);
    var panel = document.getElementById('shConsole');
    if (panel) panel.setAttribute('aria-hidden', consoleOpen ? 'false' : 'true');
    var btn = document.querySelector('[data-panel]');
    if (btn) btn.setAttribute('aria-expanded', consoleOpen ? 'true' : 'false');
    document.querySelectorAll('.sh-item[data-panel]').forEach(function (b) {
      b.classList.toggle('on', consoleOpen);
    });
  }

  /**
   * 切页。stage / console 是 v0.1.0 的旧调用与 ?page 参数，一律转成「打开控制台」；
   * sandbox 是 v0.4.0 起「沙盘」的正式名，work 是旧参数，两者都落到同一个页面。
   * @param {'chat'|'work'|'sandbox'|'stage'|'console'} page
   */
  function go(page) {
    if (page === 'stage' || page === 'console') { setConsole(true); return; }
    build();
    if (consoleOpen) setConsole(false);
    if (capOpen) setCapsule(false);
    var enteringWork = (page === 'work' || page === 'sandbox');
    current = enteringWork ? 'work' : 'chat';
    if (enteringWork) {
      // 桌面是「点顶栏 ⊞ 展开画布」，手机没有那个入口 —— 点沙盘 tab 就是这次点击：
      // 有新挂载时直接把内容铺上台面，不用让人再点一次卡片。
      var badge = document.querySelector('.sh-item[data-page="work"].has-new');
      if (badge && stageSpec) {
        var active = window.panelTabs.active(tabs);
        openStage(stageSpec, active ? active.id : '');
      }
      markNew(false);
    }
    var shell = document.getElementById('mobileShell');
    if (!shell) return;
    shell.querySelectorAll('.sh-page').forEach(function (p) {
      p.classList.toggle('on', /** @type {HTMLElement} */ (p).dataset.page === current);
    });
    shell.querySelectorAll('.sh-item[data-page]').forEach(function (b) {
      b.classList.toggle('on', /** @type {HTMLElement} */ (b).dataset.page === current);
    });
    // 对话页让原界面透出来，沙盘页真正盖住
    html.classList.toggle('shell-chat', current === 'chat');
  }

  /* ── 布局切换 ─────────────────────────────────────────────────── */

  function apply() {
    var on = FORCE || MQ.matches;
    if (!on) {
      html.classList.remove('shell-mobile', 'shell-chat', 'shell-console-open', 'shell-cap-open');
      // 抽屉的 aria/高亮与 .on 状态跟着壳一起复位，免得回到手机态还留着「已展开」。
      if (built) setConsole(false);
      consoleOpen = false;
      unpatchPanel();          // 桌面把 __panel 还给 panel-host，一个字节不改它的行为
      homeCapsule();
      homeStage();
      return;
    }
    build();
    html.classList.add('shell-mobile');
    go(current);
    placeCapsule();
    patchPanel();             // 手机端 panel-host 未起，补齐内容画布契约
    if (bootConsole) { setConsole(true); bootConsole = false; }
    if (bootCap) { setCapsule(true); bootCap = false; }
  }

  /* ── 放行卡联动（v0.4.0）────────────────────────────────────────
   * agent-console.js 有待放行请求时广播 cfw:perm-pending，决策后广播 cfw:perm-resolved。
   * 壳只收「这次由它自动顶起」的抽屉，用户自己打开的控制台不动；多张卡连发
   * pending 不覆盖首标记，免得第二张卡把「本来关着」记成「本来开着」。
   */
  var permSurfaced = false;
  window.addEventListener('cfw:perm-pending', function () {
    if (!html.classList.contains('shell-mobile')) return;
    if (!permSurfaced && !consoleOpen) permSurfaced = true;
    setConsole(true);                       // 首次打开时把右栏搬进抽屉
    var foundTab = document.querySelector('#rightSidebar .rs-tab[data-rs-tab="fishbowl"]');
    var tab = foundTab instanceof HTMLElement ? foundTab : null;
    if (tab && !tab.classList.contains('active')) tab.click();
  });
  window.addEventListener('cfw:perm-resolved', function () {
    if (!permSurfaced) return;
    permSurfaced = false;
    if (html.classList.contains('shell-mobile') && consoleOpen) setConsole(false);
  });

  /* Settings saved a sandbox/GEO root: pages() re-reads sandboxViews on the next call, so re-render
     the work grid and re-resolve the active stage instead of keeping a stale iframe URL. */
  window.addEventListener('panel:config-changed', function () {
    if (!html.classList.contains('shell-mobile') || current !== 'work') return;
    if (!window.panelTabs) return;
    renderWork(workSeg);
    var active = window.panelTabs.active(tabs);
    if (active) showTab(active);
  });

  var t = 0;
  function schedule() {
    window.clearTimeout(t);
    t = window.setTimeout(apply, 80);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply);
  } else {
    apply();
  }
  if (MQ.addEventListener) MQ.addEventListener('change', schedule);
  else if (MQ.addListener) MQ.addListener(schedule);

  /** 给其它 bundle / 控制台留的入口 */
  /** @type {any} */ (window).__shell = {
    version: VERSION,
    go: go,
    apply: apply,
    console: setConsole,
    capsule: setCapsule,
    syncCapsule: syncCapsule,
    slot: slot,
    api: api,
    /** 沙盘内容舞台：外部（agent 工具 / 调试）可直接挂一份内容进来 */
    stage: {
      open: function (spec) { go('work'); openStage(spec); },
      close: function () { closeStage(true); },
      state: function () { return { hasContent: !!stageSpec, title: stageSpec ? String(stageSpec.title || '') : '' }; },
      items: function () {
        return allItems().map(function (it) { return { id: it.id, title: it.title, kind: it.kind, url: it.url || '' }; });
      }
    },
    get page() { return current; },
    get consoleOpen() { return consoleOpen; },
    get capsuleOpen() { return capOpen; }
  };
})();
