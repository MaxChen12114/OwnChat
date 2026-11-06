/**
 * image-embed.js · OwnChat 图像侧嵌入（Phase 2 · Wave 1：工坊）
 *
 * 自挂载模块：复用左栏「图像(生/改)」按钮 → 打开 Modal 工坊。
 * 仿 prompt-editor.js 壳：自注入 DOM + 自注入主题无关 CSS（currentColor）
 * + window.__image API + ESC/遮罩/✕ 关闭。
 *
 * 两个模式（渠道/模型由工坊顶部下拉决定，跟随 __imageChannels）：
 *   - 文生图  → image-common.genImage（站点代理 / 自定义 OpenAI 兼容 / 本地 ComfyUI）
 *   - 改图    → image-common.genEdit（需支持站点代理的 OpenAI 兼容渠道，如 Gitee 预设）
 *
 * 网络：统一委托 image-common.js（/img/v1/* 代理 + /img/dl 下载）。
 * Key：设置 → 模型 API → 图像渠道（LS cfw_image_channels_v1，迁移旧 cfw_image_key_v1）。
 * 主线 footprint：仅需一行 <script src=\"/image-embed.js\">；按钮启用由本模块运行时完成。
 *
 * 公开 API：window.__image = { open, close, switchMode, generate, abort }
 * 画廊 R2+跨设备同步（image-gallery.js）与插入聊天（image-album.js）均已上线。
 *
 * ── 统一管线（image-common 接入版）──
 * 依赖 window.__imageCommon（image-common.js）与 window.__imageChannels（image-channels.js），
 * 两者须在本模块前加载。鉴权 / 端点 / 下载 / 渠道分发全部下沉，本模块只保留工坊 UI 与状态条。
 */
(function () {
  'use strict';
  if (window.__image) return;

  // ── 统一管线：底层鉴权 / 端点 / 下载代理委托 image-common.js ──
  var IC = window.__imageCommon;
  if (!IC) { console.error('[image-embed] 缺少 image-common.js，请确认其在本模块前加载'); return; }
  // 渠道是数据：Gitee 只是内置预设，工坊里的下拉只负责选择/覆盖，不写死任何供应商。
  var C = window.__imageChannels;

  var MASK_ID = 'imageStudioMask';
  var KEY_LS = 'cfw_image_key_v1';
  var OLD_KEY_LS = 'moark_api_key';

  // 迁移旧 key（原独立工具用 moark_api_key）
  try {
    if (!localStorage.getItem(KEY_LS)) {
      var legacy = localStorage.getItem(OLD_KEY_LS);
      if (legacy) localStorage.setItem(KEY_LS, legacy);
    }
  } catch (e) {}

  var Z_RESOLUTIONS = {
    '1:1 (2048x2048)': [2048, 2048],
    '1:1 (1024x1024)': [1024, 1024],
    '3:4 (768x1024)': [768, 1024],
    '4:3 (1024x768)': [1024, 768],
    '16:9 (1024x576)': [1024, 576],
    '9:16 (576x1024)': [576, 1024]
  };
  var EDIT_TASK_TYPES = ['id', 'style', 'pose', 'layout', 'color', 'background'];
  var EDIT_DEFAULT_TYPES = { id: 1, style: 1 };

  var currentMode = 'z'; // 'z' | 'edit'
  var mask = null;
  var pollAbort = { aborted: false };

  function byId(id) { return document.getElementById(id); }
  // ── 渠道/模型下拉：数据来自 __imageChannels；不在此处写死供应商 ──
  function fillChannelSelect(sel, onlyEdit) {
    if (!sel || !C) return;
    sel.innerHTML = '';
    var list = C.list().filter(function (ch) { return !onlyEdit || C.hasEdit(ch); });
    list.forEach(function (ch) {
      var o = document.createElement('option');
      o.value = ch.id; o.textContent = ch.name + (ch.kind === 'comfyui' ? '（本地）' : '');
      sel.appendChild(o);
    });
    var want = C.activeId();
    if (!list.some(function (ch) { return ch.id === want; })) want = list[0] ? list[0].id : '';
    if (want) sel.value = want;
    return list;
  }
  function fillModelSelect(sel, ch, preferred) {
    if (!sel) return;
    sel.innerHTML = '';
    var list = (ch && ch.models) ? ch.models.slice() : [];
    if (preferred && list.indexOf(preferred) < 0) list.unshift(preferred);
    list.forEach(function (m) {
      var o = document.createElement('option'); o.value = m; o.textContent = m;
      sel.appendChild(o);
    });
    if (preferred) sel.value = preferred;
    else if (list.length) sel.value = list[0];
  }
  function selectedChannel() {
    if (!C) return null;
    var sel = byId('imgChannelSel');
    return (sel && sel.value) ? C.get(sel.value) : C.getActive();
  }
  // 鉴权委托 image-common（读 cfw_image_key_v1，校验，抛错消息与原版一致）
  function getKey() { return IC.getKey(); }
  function nowTs() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }
  function clampInt(v, lo, hi, dv) {
    var n = parseInt(String(v), 10);
    return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dv;
  }
  function clampFloat(v, lo, hi, dv) {
    var n = parseFloat(String(v));
    return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dv;
  }

  // ── 网络：端点常量委托 image-common；/img/dl 代理亦委托（自动处理 data:/同源直传）──
  function dlFetch(url, opts) { return IC.dlFetch(url, opts); }
  async function readJsonSafely(res) {
    var t = await res.text();
    try { return JSON.parse(t); } catch (e) { return { _text: t }; }
  }
  async function fetchAsBlob(url) {
    var r = await dlFetch(url);
    if (!r.ok) {
      var j = await readJsonSafely(r);
      throw new Error('下载失败 (' + r.status + '): ' + JSON.stringify(j).slice(0, 200));
    }
    var blob = await r.blob();
    return { blob: blob, objUrl: URL.createObjectURL(blob) };
  }

  // ── 状态条 ──
  function setStatus(text, kind) {
    var el = byId('imgStatusBadge');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'img-badge' + (kind ? ' img-badge-' + kind : '');
  }

  // ── 输出区 ──
  function addOutput(opts) {
    var out = byId('imgOutput');
    if (!out) return;
    var box = document.createElement('div');
    box.className = 'img-item';
    var h = document.createElement('h4');
    h.textContent = opts.title || '';
    box.appendChild(h);
    if (opts.meta) {
      var m = document.createElement('div');
      m.className = 'img-item-meta';
      m.textContent = opts.meta;
      box.appendChild(m);
    }
    if (opts.element) box.appendChild(opts.element);
    if (opts.download) {
      var row = document.createElement('div');
      row.className = 'img-item-row';
      var a = document.createElement('a');
      a.className = 'img-btn';
      a.textContent = '下载';
      a.href = opts.download.href;
      a.download = opts.download.filename || '';
      a.target = '_blank'; a.rel = 'noopener';
      row.appendChild(a);
      box.appendChild(row);
    }
    out.prepend(box);
    return box;
  }
  function clearOutput() { var o = byId('imgOutput'); if (o) o.innerHTML = ''; }

  // ── 文生图（渠道/模型由工坊下拉决定）──
  async function runZImage() {
    var ch = selectedChannel();
    if (ch && ch.kind === 'openai' && ch.transport === 'site' && !getKey()) {
      throw new Error('请先在 设置 → 模型 API → 图像渠道 填写当前渠道的 Key');
    }
    var prompt = (byId('imgZPrompt').value || '').trim();
    if (!prompt) throw new Error('请输入提示词');
    var n = clampInt(byId('imgZN').value, 1, 4, 1);
    var res = Z_RESOLUTIONS[byId('imgZRes').value] || [1024, 1024];
    var size = res[0] + 'x' + res[1];
    var mSel = byId('imgModelSel');
    var model = (mSel && mSel.value) || (ch && ch.model) || 'z-image-turbo';
    setStatus('文生图 生成中…（' + ((ch && ch.name) || '默认渠道') + ' / ' + model + '）');
    var urls;
    try {
      urls = await IC.genImage({ prompt: prompt, n: n, size: size, model: model, channel: ch || undefined });
    } catch (e) {
      setStatus('文生图 失败', 'err');
      addOutput({ title: '文生图失败', meta: (e && e.message) || String(e) });
      throw e;
    }
    if (!urls || !urls.length) { setStatus('文生图 无数据', 'err'); addOutput({ title: '返回无数据' }); return; }
    for (var i = 0; i < urls.length; i++) {
      var bi;
      try { bi = await fetchAsBlob(urls[i]); }
      catch (e) { addOutput({ title: '第 ' + (i + 1) + ' 张下载失败', meta: (e && e.message) || String(e) }); continue; }
      var img = document.createElement('img');
      img.src = bi.objUrl; img.className = 'img-out-img';
      addOutput({
        title: '文生图 #' + (i + 1),
        meta: '渠道=' + ((ch && ch.name) || '默认') + '，模型=' + model + '，size=' + size + '，n=' + n,
        element: img,
        download: { href: bi.objUrl, filename: 'gen-' + nowTs() + '-' + (i + 1) + '.png' }
      });
    }
    setStatus('文生图 成功', 'ok');
  }

  // ── 改图（渠道需支持站点代理改图；支持 1 或 2 张源图）──
  async function runEdit() {
    var ch = selectedChannel();
    if (C && ch && !C.hasEdit(ch)) {
      throw new Error('当前渠道不支持改图：请在设置里选择带站点代理的 OpenAI 兼容渠道（Gitee 预设）');
    }
    var f1 = (byId('imgEditImg1').files || [])[0];
    var f2 = (byId('imgEditImg2').files || [])[0];
    var prompt = (byId('imgEditPrompt').value || '').trim();
    if (!f1 || !prompt) throw new Error('请至少上传 1 张图片并输入提示词');
    var types = Array.prototype.slice.call(document.querySelectorAll('input[name="imgEditType"]:checked')).map(function (x) { return x.value; });
    if (!types.length) throw new Error('至少选择一个 task_type');
    var steps = clampInt(byId('imgEditSteps').value, 1, 50, 4);
    var guidance = clampFloat(byId('imgEditGuidance').value, 0, 10, 1.0);
    var mSel = byId('imgEditModelSel');
    var model = (mSel && mSel.value) || (ch && ch.editModel) || 'Qwen-Image-Edit-2511';
    pollAbort.aborted = false;
    var ticks = 0;
    setStatus('改图 创建任务…（' + ((ch && ch.name) || '默认渠道') + ' / ' + model + '）');
    var out;
    try {
      out = await IC.genEdit({
        blob: f1, filename: f1.name,
        image2: f2 || null, filename2: f2 ? f2.name : '',
        prompt: prompt, model: model, steps: steps, guidance: guidance,
        taskTypes: types, channel: ch || undefined,
        intervalMs: 6000,
        timeoutMs: 10 * 60 * 1000,
        isAborted: function () { return pollAbort.aborted; },
        onTick: function (status) {
          ticks++;
          setStatus('改图 轮询中… 第 ' + ticks + ' 次检查（' + (status || '处理中') + '），正常等待并非卡死');
        }
      });
    } catch (e) {
      var aborted = pollAbort.aborted || /已取消/.test((e && e.message) || '');
      setStatus('改图 ' + (aborted ? '已取消' : '失败'), aborted ? 'info' : 'err');
      addOutput({ title: '改图' + (aborted ? '已取消' : '失败'), meta: (e && e.message) || String(e) });
      return;
    }
    var fileUrl = out && out.fileUrl;
    var taskId = (out && out.taskId) || '';
    if (!fileUrl) { setStatus('改图 无 file_url', 'err'); addOutput({ title: '成功但无 file_url' }); return; }
    setStatus('改图 下载中…');
    var bi = await fetchAsBlob(fileUrl);
    var img = document.createElement('img');
    img.src = bi.objUrl; img.className = 'img-out-img';
    addOutput({
      title: '改图输出',
      meta: '渠道=' + ((ch && ch.name) || '默认') + '，模型=' + model + '，task=' + String(taskId).slice(0, 8) + '，' + (f2 ? '2 图' : '1 图') + '，' + types.join('+'),
      element: img,
      download: { href: bi.objUrl, filename: 'edit-' + nowTs() + '.png' }
    });
    setStatus('改图 成功', 'ok');
  }

  // ── Modal DOM ──
  function buildDom() {
    if (byId(MASK_ID)) return;
    ensureStyles();
    mask = document.createElement('div');
    mask.id = MASK_ID;
    mask.className = 'img-mask';
    mask.innerHTML = [
      '<div class=\"img-studio\" role=\"dialog\" aria-modal=\"true\" aria-label=\"图像工坊\">',
        '<div class=\"img-header\">',
          '<div class=\"img-title\"><svg viewBox=\"0 0 24 24\" width=\"17\" height=\"17\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><rect x=\"3.5\" y=\"4.5\" width=\"17\" height=\"15\" rx=\"2.2\"/><circle cx=\"8.5\" cy=\"9.5\" r=\"1.8\"/><path d=\"M4 17.5l5-5 3.2 3.2 3.2-3.8 4.1 5\"/></svg>图像工坊 <span class=\"img-badge-ver\">生图 / 改图</span></div>',
          '<button class=\"img-close\" id=\"imgCloseBtn\" title=\"关闭(ESC)\" aria-label=\"关闭\"><svg viewBox=\"0 0 24 24\" width=\"15\" height=\"15\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M6 6l12 12M18 6L6 18\"/></svg></button>',
        '</div>',
        '<div class=\"img-tabs\" role=\"tablist\">',
          '<button class=\"img-tab\" data-mode=\"z\" role=\"tab\"><svg viewBox=\"0 0 24 24\" width=\"14\" height=\"14\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M12 3l1.4 5.1 5.1 1.4-5.1 1.4L12 16l-1.4-5.1L5.5 9.5l5.1-1.4z\"/><path d=\"M19 15.5l.5 1.8 1.8.5-1.8.5-.5 1.8-.5-1.8-1.8-.5 1.8-.5.5-1.8z\"/></svg><span>文生图</span></button>',
          '<button class=\"img-tab\" data-mode=\"edit\" role=\"tab\"><svg viewBox=\"0 0 24 24\" width=\"14\" height=\"14\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M4 20h4.5L20 8.5a2.1 2.1 0 0 0-3-3L5.5 17 4 20z\"/><path d=\"M13.5 6.5l3 3\"/></svg><span>改图</span></button>',
        '</div>',
        '<div class=\"img-scroll\">',
          '<div class=\"img-body\" id=\"imgBody\"></div>',
          '<div class=\"img-statusbar\"><span class=\"img-badge\" id=\"imgStatusBadge\">准备就绪</span><button class=\"img-btn img-btn-ghost\" id=\"imgAbortBtn\">取消轮询</button></div>',
          '<div class=\"img-output-head\">输出 <button class=\"img-btn img-btn-ghost\" id=\"imgClearOut\">清空</button></div>',
          '<div class=\"img-output\" id=\"imgOutput\"></div>',
        '</div>',
      '</div>'
    ].join('');
    document.body.appendChild(mask);
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    byId('imgCloseBtn').addEventListener('click', close);
    byId('imgClearOut').addEventListener('click', clearOutput);
    byId('imgAbortBtn').addEventListener('click', function () { pollAbort.aborted = true; setStatus('已请求取消…', 'info'); });
    mask.querySelector('.img-tabs').addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('.img-tab');
      if (b) switchMode(b.getAttribute('data-mode'));
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && mask && mask.classList.contains('open')) close();
    });
  }

  function renderBody() {
    var body = byId('imgBody');
    if (!body) return;
    // 2026-10-06: 画廊面板(#galPanel,image-gallery.js 挂在 imgBody 里的 absolute 覆盖层)
    // 不能被 innerHTML 重写抹掉 —— 摘下 → 重写 → 原样挂回,面板开关状态保留。
    var galPanel = document.getElementById('galPanel');
    if (galPanel) galPanel.remove();
    if (currentMode === 'z') {
      body.innerHTML = [
        '<div class=\"img-grid2\">',
          '<div><label class=\"img-lab\">渠道</label><select class=\"img-input\" id=\"imgChannelSel\"></select></div>',
          '<div><label class=\"img-lab\">模型</label><select class=\"img-input\" id=\"imgModelSel\"></select></div>',
        '</div>',
        '<label class=\"img-lab\">提示词 Prompt</label>',
        '<textarea class=\"img-textarea\" id=\"imgZPrompt\" rows=\"5\" placeholder=\"例如：一只戴墨镜的柴犬，赛博朋克风，超清\"></textarea>',
        '<div class=\"img-grid2\">',
          '<div><label class=\"img-lab\">分辨率</label><select class=\"img-input\" id=\"imgZRes\"></select></div>',
          '<div><label class=\"img-lab\">张数 n (1-4)</label><input class=\"img-input\" id=\"imgZN\" type=\"number\" min=\"1\" max=\"4\" value=\"1\"></div>',
        '</div>',
        '<div class=\"img-row\"><button class=\"img-btn img-btn-primary\" id=\"imgZRun\">执行 / 生成</button></div>'
      ].join('');
      var sel = byId('imgZRes');
      Object.keys(Z_RESOLUTIONS).forEach(function (kk) {
        var o = document.createElement('option'); o.value = kk; o.textContent = kk; sel.appendChild(o);
      });
      sel.value = Object.keys(Z_RESOLUTIONS)[1]; // 默认 1024，避开 2048 高成本
      var chSel = byId('imgChannelSel'), mSel = byId('imgModelSel');
      fillChannelSelect(chSel, false);
      var initCh = selectedChannel();
      fillModelSelect(mSel, initCh, initCh && initCh.model);
      if (chSel) chSel.addEventListener('change', function () {
        if (C) C.setActive(this.value);
        var ch = selectedChannel();
        fillModelSelect(mSel, ch, ch && ch.model);
      });
      byId('imgZRun').addEventListener('click', function () {
        runZImage().catch(function (e) { setStatus('错误：' + e.message, 'err'); });
      });
    } else {
      body.innerHTML = [
        '<div class=\"img-grid2\">',
          '<div><label class=\"img-lab\">渠道（需支持改图）</label><select class=\"img-input\" id=\"imgChannelSel\"></select></div>',
          '<div><label class=\"img-lab\">改图模型</label><select class=\"img-input\" id=\"imgEditModelSel\"></select></div>',
        '</div>',
        '<div id=\"imgEditNoChannel\" style=\"display:none;font-size:12px;color:#e5484d;margin:0 0 10px;\">没有支持改图的渠道。请到 设置 → 模型 API → 图像渠道 选 Gitee 预设（站点代理 + Qwen-Image-Edit）。</div>',
        '<div class=\"img-grid2\">',
          '<div><label class=\"img-lab\">图1（必填）</label><input class=\"img-input\" id=\"imgEditImg1\" type=\"file\" accept=\"image/png,image/jpeg,image/webp\"></div>',
          '<div><label class=\"img-lab\">图2（可选）</label><input class=\"img-input\" id=\"imgEditImg2\" type=\"file\" accept=\"image/png,image/jpeg,image/webp\"></div>',
        '</div>',
        '<label class=\"img-lab\">提示词 Prompt</label>',
        '<textarea class=\"img-textarea\" id=\"imgEditPrompt\" rows=\"4\" placeholder=\"描述要的编辑效果，例如：把背景换成海边日落，保留人物\"></textarea>',
        '<label class=\"img-lab\">任务类型 task_types（可多选）</label>',
        '<div class=\"img-checks\" id=\"imgEditTypes\"></div>',
        '<div class=\"img-grid2\">',
          '<div><label class=\"img-lab\">steps (1-50)</label><input class=\"img-input\" id=\"imgEditSteps\" type=\"number\" min=\"1\" max=\"50\" value=\"4\"></div>',
          '<div><label class=\"img-lab\">guidance (0-10)</label><input class=\"img-input\" id=\"imgEditGuidance\" type=\"number\" min=\"0\" max=\"10\" step=\"0.5\" value=\"1\"></div>',
        '</div>',
        '<div class=\"img-row\"><button class=\"img-btn img-btn-primary\" id=\"imgEditRun\">执行 / 改图</button></div>'
      ].join('');
      var echSel = byId('imgChannelSel'), emSel = byId('imgEditModelSel');
      var editChs = C ? fillChannelSelect(echSel, true) : null;
      var noCh = byId('imgEditNoChannel');
      if (C && (!editChs || !editChs.length)) {
        if (noCh) noCh.style.display = '';
        if (emSel) emSel.innerHTML = '';
        var run0 = byId('imgEditRun'); if (run0) run0.disabled = true;
      } else {
        var initE = selectedChannel();
        fillModelSelect(emSel, initE, initE && initE.editModel);
        if (echSel) echSel.addEventListener('change', function () {
          if (C) C.setActive(this.value);
          var ch = selectedChannel();
          fillModelSelect(emSel, ch, ch && ch.editModel);
        });
      }
      var box = byId('imgEditTypes');
      EDIT_TASK_TYPES.forEach(function (t) {
        var lab = document.createElement('label'); lab.className = 'img-chk';
        var inp = document.createElement('input'); inp.type = 'checkbox'; inp.name = 'imgEditType'; inp.value = t;
        if (EDIT_DEFAULT_TYPES[t]) inp.checked = true;
        lab.appendChild(inp); lab.appendChild(document.createTextNode(' ' + t));
        box.appendChild(lab);
      });
      byId('imgEditRun').addEventListener('click', function () {
        runEdit().catch(function (e) { setStatus('错误：' + e.message, 'err'); });
      });
    }
    if (galPanel) body.appendChild(galPanel); // 画廊面板挂回(状态保留)
  }

  function refreshTabs() {
    if (!mask) return;
    mask.querySelectorAll('.img-tab').forEach(function (b) {
      // galToggleBtn(画廊页签)无 data-mode,不属于模式高亮,跳过 —— 否则它会被误熄灭
      if (!b.getAttribute('data-mode')) return;
      b.classList.toggle('active', b.getAttribute('data-mode') === currentMode);
    });
  }

  function open(mode) {
    buildDom();
    if (mode === 'z' || mode === 'edit') currentMode = mode;
    refreshTabs(); renderBody();
    mask.classList.add('open');
    document.body.classList.add('img-open');
    // 2026-10-06: 画廊面板是 absolute 覆盖层,上次开着时重开工坊会以透明鬼影叠在表单上 → 每次打开重置
    var gp = document.getElementById('galPanel');
    if (gp) gp.style.display = 'none';
  }
  function close() {
    if (!mask) return;
    mask.classList.remove('open');
    document.body.classList.remove('img-open');
  }
  function switchMode(mode) {
    if (mode !== 'z' && mode !== 'edit') return;
    currentMode = mode; refreshTabs(); renderBody();
  }

  // ── 程序化生成 API（供 形象/场景 调用）：跟随当前渠道，返回 [{url}] ──
  async function generate(opts) {
    opts = opts || {};
    var ch = opts.channel || (IC.getChannel && IC.getChannel());
    var urls = await IC.genImage({
      prompt: opts.prompt || '',
      n: opts.n || 1,
      size: opts.size || '1024x1024',
      model: opts.model || (ch && ch.model) || undefined,
      channel: ch || undefined
    });
    return (urls || []).map(function (u) { return { url: u }; });
  }
  function abort() { pollAbort.aborted = true; }

  // 图像 Key 卡已迁移至 settings.js 统一挂载(旧的 injectSettingsCard_REMOVED 死代码已于 4.82 删除,
  // 需要找回参考 git 历史)

  // ── 运行时启用左栏「图像(生/改)」按钮（避免改动主线 HTML）──
  function bindSidebarEntry() {
    var btns = document.querySelectorAll('.sidebar-btn');
    var target = null;
    Array.prototype.forEach.call(btns, function (b) {
      var lbl = b.querySelector('.sidebar-btn-label');
      if (lbl && /图像/.test(lbl.textContent || '')) target = b;
    });
    if (!target || target.__imgBound) return;
    target.__imgBound = true;
    target.removeAttribute('disabled');
    target.classList.remove('sidebar-btn-disabled');
    target.title = '🎨 图像工坊：文生图 / 改图';
    target.addEventListener('click', function (e) { e.preventDefault(); open(); });
  }

  function init() {
    bindSidebarEntry(); // 卡片由 settings.js 统一挂载
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // ── 自注入 CSS（2026-10-06 对齐提示词编辑器 ue-* 设计语言:强调色走 --ue-tab-accent 主题变量,
  //    pill 页签,线性 SVG,header 分带渐染,uePopIn 同款开卡动画,accent 聚焦环;四主题覆盖在 styles-2.css）──
  function ensureStyles() {
    if (byId('imgStudioStyles')) return;
    var s = document.createElement('style');
    s.id = 'imgStudioStyles';
    s.textContent = [
      '.img-mask{position:fixed;inset:0;z-index:40;display:none;align-items:center;justify-content:center;background:rgba(8,8,12,.66);backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);overflow:auto;padding:20px;}',
      '.img-mask.open{display:flex;}',
      '.img-studio{--img-accent:var(--ue-tab-accent,rgba(180,180,180,.75));--img-accent-soft:color-mix(in srgb,var(--ue-tab-accent,rgba(180,180,180,.75)) 16%,transparent);display:flex;flex-direction:column;width:100%;max-width:min(880px,96vw);max-height:90vh;background:var(--bg,#0f0f12);color:inherit;border:1px solid rgba(127,127,127,.3);border-radius:18px;box-shadow:0 30px 80px rgba(0,0,0,.6);overflow:hidden;}',
      '@keyframes imgPopIn{from{opacity:0;transform:translateY(14px) scale(.985);}to{opacity:1;transform:none;}}',
      '.img-mask.open .img-studio{animation:imgPopIn .22s ease;}',
      '.img-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;flex-shrink:0;border-bottom:1px solid rgba(127,127,127,.2);background:linear-gradient(135deg,var(--img-accent-soft),transparent 72%);}',
      '.img-title{font-size:16px;font-weight:700;letter-spacing:.01em;display:flex;align-items:center;gap:8px;}',
      '.img-title svg{color:var(--img-accent);flex:0 0 auto;}',
      '.img-badge-ver{font-size:11px;font-weight:500;opacity:.7;padding:2px 8px;border:1px solid currentColor;border-radius:999px;}',
      '.img-close{width:32px;height:32px;border-radius:8px;border:1px solid rgba(127,127,127,.3);background:transparent;color:inherit;cursor:pointer;line-height:1;flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;transition:background .15s,color .15s,border-color .15s;}',
      '.img-close:hover{background:rgba(255,80,80,.14);color:#ff7777;border-color:#ff7777;}',
      '.img-tabs{display:flex;flex-wrap:nowrap;flex-shrink:0;gap:6px;padding:14px 16px 12px;overflow-x:auto;border-bottom:1px solid rgba(127,127,127,.15);-webkit-overflow-scrolling:touch;scrollbar-width:none;}',
      '.img-tabs::-webkit-scrollbar{display:none;}',
      '.img-tab{display:inline-flex;align-items:center;justify-content:center;gap:6px;flex:0 0 auto;white-space:nowrap;padding:8px 16px;border:1px solid transparent;border-radius:10px;background:rgba(127,127,127,.07);color:inherit;cursor:pointer;font-size:13px;line-height:1.2;opacity:.6;transition:background .15s,opacity .15s,border-color .15s,box-shadow .15s;font-family:inherit;}',
      '.img-tab:hover{opacity:1;background:rgba(127,127,127,.1);}',
      '.img-tab.active{opacity:1;border-color:var(--img-accent);background:var(--img-accent-soft);color:var(--img-accent);font-weight:600;box-shadow:0 2px 10px rgba(0,0,0,.12);}',
      '.img-tab svg{flex:0 0 auto;}',
      '.img-scroll{flex:1;min-height:0;overflow-y:auto;padding:16px 24px 24px;}',
      /* 2026-10-06: 880 宽面板下内容限宽居中。!important 只锁水平边距 —— 组件自身的
         margin 简写(如 .img-statusbar 的 margin:16px 0 0)会把 auto 覆盖成 0 导致"上下错开" */
      '.img-scroll > *{max-width:720px;margin-left:auto !important;margin-right:auto !important;}',
      '.img-body{min-height:0;padding:0 0 8px;}',
      '.img-lab{display:block;font-size:12px;opacity:.65;margin:12px 0 5px;font-weight:500;}',
      '.img-input,.img-textarea{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid rgba(127,127,127,.35);background:rgba(0,0,0,.15);color:inherit;font:inherit;transition:border-color .15s,box-shadow .15s;}',
      '.img-input:focus,.img-textarea:focus{outline:none;border-color:var(--img-accent);box-shadow:0 0 0 3px var(--img-accent-soft);}',
      '.img-textarea{resize:vertical;min-height:80px;line-height:1.5;}',
      '.img-grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:6px;}',
      '.img-checks{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0;}',
      '.img-chk{font-size:12.5px;display:flex;align-items:center;gap:5px;cursor:pointer;padding:5px 10px;border-radius:8px;border:1px solid rgba(127,127,127,.25);transition:border-color .15s,background .15s;}',
      '.img-chk:hover{background:rgba(127,127,127,.10);}',
      '.img-row{margin-top:16px;}',
      '.img-btn{display:inline-flex;align-items:center;gap:5px;padding:6px 12px;border-radius:9px;border:1px solid rgba(127,127,127,.3);background:rgba(127,127,127,.06);color:inherit;cursor:pointer;font-size:13px;line-height:1.3;opacity:.92;text-decoration:none;transition:opacity .15s,background .15s,transform .1s;font-family:inherit;}',
      '.img-btn:hover{opacity:1;background:rgba(127,127,127,.12);}',
      '.img-btn:active{transform:translateY(1px);}',
      '.img-btn-primary{width:100%;justify-content:center;border:1px solid var(--img-accent);background:var(--img-accent);color:#fff;font-weight:600;font-size:14px;padding:11px 16px;opacity:1;}',
      '.img-btn-primary:hover{background:var(--btn-bg-hover,var(--img-accent));}',
      '.img-btn-ghost{border-color:rgba(127,127,127,.28);font-size:12px;padding:5px 11px;}',
      '.img-statusbar{display:flex;align-items:center;gap:10px;margin:16px 0 0;padding-top:12px;border-top:1px solid rgba(127,127,127,.14);}',
      '.img-statusbar .img-btn-ghost{padding:5px 11px;}', /* 2026-10-06: 与状态徽章等高(28px),桌面端两件对齐 */
      '.img-badge{font-size:12px;padding:5px 11px;border-radius:8px;border:1px solid rgba(127,127,127,.25);background:rgba(127,127,127,.06);opacity:.85;flex:1;}',
      '.img-badge-ok{border-color:rgba(37,194,160,.6);background:rgba(37,194,160,.10);}',
      '.img-badge-err{border-color:rgba(255,84,112,.6);background:rgba(255,84,112,.10);}',
      '.img-badge-info{border-color:var(--img-accent);background:var(--img-accent-soft);}',
      '.img-output-head{display:flex;align-items:center;justify-content:space-between;font-size:12.5px;opacity:.65;font-weight:600;margin:12px 0 8px;}',
      '.img-output{display:flex;flex-direction:column;gap:10px;}',
      '.img-item{border:1px solid rgba(127,127,127,.18);border-radius:12px;padding:12px;background:rgba(127,127,127,.04);}',
      '.img-item h4{margin:0 0 4px;font-size:13px;}',
      '.img-item-meta{font-size:11px;opacity:.55;margin-bottom:8px;word-break:break-all;}',
      '.img-out-img{max-width:100%;border-radius:10px;display:block;}',
      '.img-item-row{margin-top:10px;display:flex;gap:8px;}',
      '@media(max-width:640px){.img-grid2{grid-template-columns:1fr;}.img-studio{max-width:96vw;}}'
    ].join('\n');
    document.head.appendChild(s);
  }

  window.__image = { open: open, close: close, switchMode: switchMode, generate: generate, abort: abort };
})();