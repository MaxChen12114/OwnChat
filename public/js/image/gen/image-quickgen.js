// image-quickgen.js —— 一键生角色图 / 一键生场景图 / 一键改图（统一管线版）
// 底层出图/改图/鉴权/dlFetch/画风原料统一走 window.__imageCommon（image-common.js，必须先加载）。
// 本文件只保留「一键生改图」特有语义：提示词构建(免费/快速 LLM)、本地模板兜底、画风自然语言拼接、
// 改图参数(steps=4/guidance=1.0)、轮询 6000ms、右栏/移动端面板 UI。
// 设计要点:
// 1. prompt 来源 = 文本侧 /api/chat「免费模式(NVIDIA NIM)」, use_builtin_persona:false + 自定义 system,
//    => 零额外费用调文本模型把中文角色卡/场景压成自然语言中文出图 prompt;失败回退本地模板。
// 2. 出图经 image-common 走站点自有代理 /img/v1/*(image-routes.js),key 读 cfw_image_key_v1。
// 3. 结果「都要」:填进右栏 形象/场景 面板 + 移动端 tab 面板 + 可一键在大图工坊查看。
// 4. 一键改图:文本模型把口语指令翻成英文编辑指令,作用于当前 形象/场景 图(经 image-common.dlFetch 取源图字节)。
(function () {
  if (window.__imageQuick) return;
  var IC = window.__imageCommon;
  if (!IC) { console.error('[image-quickgen] 缺少 image-common.js，请确认其在本文件之前加载'); return; }

  function activeCard() {
    try { return (window.__character && window.__character.getActiveCard) ? window.__character.getActiveCard() : null; }
    catch (e) { return null; }
  }

  // ───── 上下文收集 ─────
  function cardToText(c) {
    if (!c) return '一个角色';
    var p = [];
    if (c.name) p.push('姓名:' + c.name);
    if (c.gender) p.push('性别:' + (c.gender === 'male' ? '男' : c.gender === 'female' ? '女' : c.gender));
    if (c.identity) p.push('身份:' + c.identity);
    if (c.personality) p.push('性格:' + c.personality);
    if (c.speakingStyle) p.push('说话风格:' + c.speakingStyle);
    if (c.openingLine) p.push('开场白:' + c.openingLine);
    return p.join('\n');
  }
  function gatherScene() {
    var rows = document.querySelectorAll('#chat .row');
    var arr = [];
    rows.forEach(function (r) {
      var b = r.querySelector('.bubble');
      if (!b || b.classList.contains('wechat-typing')) return;
      var who = r.classList.contains('user') ? '用户' : (r.querySelector('.meta') ? r.querySelector('.meta').textContent : '角色');
      var tx = (b.textContent || '').trim();
      if (tx) arr.push(who + ':' + tx);
    });
    var txt = arr.slice(-8).join('\n');
    var sum = '';
    try { sum = localStorage.getItem('cfw_prior_summary_v1') || ''; } catch (e) {}
    if (sum) txt = '[剧情摘要]' + sum + '\n' + txt;
    txt = txt.slice(-2000);
    return txt || '一个安静的室内场景';
  }

  // ───── 文本模型提示词构建(免费模式,零费用)─────
  // 免费/快速 双模式: 免费=gpt-oss(连接最稳), 断联可切快速 DeepSeek(稳但计费)
  var LS_MODE = 'cfw_quick_llm_mode_v1';
  function llmMode() { try { return localStorage.getItem(LS_MODE) || 'free'; } catch (e) { return 'free'; } }
  function setLlmMode(m) { try { localStorage.setItem(LS_MODE, m); } catch (e) {} updateModeUI(); }
  function pickFreeModel() {
    var list = window.APP_MODELS_FREE || [];
    for (var i = 0; i < list.length; i++) { if ((list[i].id || '').indexOf('gpt-oss') >= 0) return list[i].id; }
    return 'openai/gpt-oss-120b';
  }
  // 2026-10-05: 去掉 `|| window.DEFAULT_MODEL` —— 那个全局全仓库无人赋值,永远 undefined,
  // 属于死兜底(顺带核实末尾的 deepseek-ai/deepseek-v4-pro 是活 id:CTX 表/定价表/另三个工具页兜底列表里都有)。
  function pickFastModel() { return window.APP_DEFAULT_MODEL_FAST || 'deepseek-ai/deepseek-v4-pro'; }
  function updateModeUI() {
    var m = llmMode();
    document.querySelectorAll('[data-qg-mode]').forEach(function (b) {
      var on = b.getAttribute('data-qg-mode') === m;
      b.style.fontWeight = on ? '700' : '400';
      b.style.opacity = on ? '1' : '.5';
    });
  }
  // 4.47 #画风: z-image-turbo/Qwen 蒸馏模型吃自然语言长句(非 SD/booru tag soup),不支持负面词→全部正向中文描述,与 image-portrait.js buildPrompt 对齐
  var SYS = {
    character: 'You are an expert prompt engineer for a natural-language text-to-image model (z-image / Qwen, distilled). It understands flowing descriptive sentences, NOT booru tag soup, and does NOT support negative prompts. Given a Chinese roleplay character profile, output ONE cohesive Chinese descriptive sentence of the character appearance: 半身构图、性别与气质、发型发色、眼睛、服饰、表情与姿态，并附一句简短的环境与柔和打光。全部用正向自然语言描述，不要用逗号堆砸标签，不要出现 masterpiece / best quality / 1girl 这类 tag。只输出这句提示词本身，不要解释。',
    scene: 'You are an expert prompt engineer for a natural-language text-to-image model (z-image / Qwen). Given recent Chinese roleplay context, output ONE cohesive Chinese descriptive sentence depicting the current SCENE/environment: 地点、时间与光线、天气氛围、关键陈设与整体色调。聚焦环境而非人物面孔，必要时可写画面中没有人物。用正向自然语言描述，不要标签堆砸，不要出现 masterpiece / scenery 这类 tag。只输出这句提示词本身，不要解释。',
    edit: 'You translate a casual Chinese edit request for an existing image into ONE concise explicit editing instruction for an instruction-based image-edit model. 用自然语言说清楚要改什么、并保持其他部分不变。只输出这条指令本身，不要解释。'
  };
  async function llmBuildPrompt(userText, kind) {
    var mode = llmMode();
    var model = mode === 'fast' ? pickFastModel() : pickFreeModel();
    var res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: mode,
        model: model,
        promptProfile: 'assist',
        use_builtin_persona: false,
        custom_system_prompt: SYS[kind],
        replyStyle: 'default',
        messages: [{ role: 'user', content: userText }]
      })
    });
    if (!res.ok) throw new Error('llm ' + res.status);
    var reader = res.body.getReader();
    var dec = new TextDecoder();
    var out = '';
    while (true) {
      var step = await reader.read();
      if (step.done) break;
      var chunk = dec.decode(step.value, { stream: true });
      var lines = chunk.split('\n');
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.indexOf('data: ') !== 0) continue;
        var s = line.slice(6).trim();
        if (!s || s === '[DONE]') continue;
        try {
          var p = JSON.parse(s);
          var d = p.choices && p.choices[0] && p.choices[0].delta && p.choices[0].delta.content;
          if (d) out += d;
        } catch (e) {}
      }
    }
    out = out.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
    if (!out) throw new Error('empty');
    return out;
  }

  // ───── 本地模板兜底 ─────
  // 4.47 #画风: 兜底模板也改自然语言中文(与 image-portrait.js 对齐),不再 SD tag
  function tplCharacter(c) {
    var subj = '一位角色';
    var g = (c && c.gender) || '';
    if (g === 'female' || /女/.test(g)) subj = '一位女性角色';
    else if (g === 'male' || /男/.test(g)) subj = '一位男性角色';
    var parts = ['半身肖像，' + subj + '，单人，正面面向镜头'];
    if (c && c.age) parts.push('角色年龄：' + String(c.age).trim());
    if (c && c.identity) parts.push('身份与背景：' + c.identity);
    if (c && c.personality) parts.push('气质性格：' + c.personality);
    parts.push('柔和自然的打光，干净简洁的背景，精致的五官与有神的眼睛，构图均衡');
    parts.push('整体高品质、细节丰富、清晰锐利');
    return parts.filter(Boolean).join('，') + '。';
  }
  function tplScene(sceneText) {
    var s = String(sceneText || '一个安静的室内场景').replace(/\s+/g, ' ').slice(0, 200);
    return '一幅场景画面，描绘当前剧情发生的环境：' + s + '。画面聚焦环境与氛围，没有人物特写，柔和自然的光线，统一的色调，细节丰富、清晰锐利。';
  }
  async function resolvePrompt(kind, userText, fallback) {
    try { return await llmBuildPrompt(userText, kind); }
    catch (e) { return fallback; }
  }

  // ───── 出图 API（委托 image-common）─────
  // 4.47 #画风: 自然语言下用「。画风：…」拼接,而非英文逗号 tag 追加(画风原料读 image-common.styleSuffix)
  function withStyle(p) { var st = IC.styleSuffix(); if (!st) return p || ''; var base = (p || '').replace(/[。.\s]+$/, ''); return '画风（务必严格遵循）：' + st + '。画面内容：' + base + '。'; }
  async function genZImage(prompt, n) {
    return IC.genImage({ prompt: withStyle(prompt), n: n || 1, size: '1024x1024' });
  }
  async function genEdit(prompt, srcUrl, onTick) {
    // 本链改图参数 steps=4/guidance=1.0、轮询 6000ms（语义保持；统一数值属 Bug③另议）
    var res = await IC.genEdit({ prompt: withStyle(prompt), srcUrl: srcUrl, steps: 4, guidance: 1.0, intervalMs: 6000, filename: 'src.png', onTick: function (st) { if (onTick) onTick(st); } });
    return res.fileUrl;
  }

  // ───── 结果落地:面板 + 工坊 ─────
  var LS_IMG = { character: 'cfw_image_char_v1', scene: 'cfw_image_scene_v1' };
  function lastImage(kind) { try { return localStorage.getItem(LS_IMG[kind]) || ''; } catch (e) { return ''; } }
  function setLastImage(kind, url) { try { localStorage.setItem(LS_IMG[kind], url); } catch (e) {} }

  // 4.62: 右栏图标按钮去 emoji 换线性 SVG + 规整排布(主按钮整行 + 次按钮 2 列网格) + 加「清空」
  function svgIcon(paths) {
    return '<svg class="qg-ic" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
  }
  var QG_IC = {
    person: '<circle cx="12" cy="8" r="3.2"/><path d="M5.5 19a6.5 6.5 0 0 1 13 0"/>',
    scene: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="M5 17l4.5-4 3 2.5L16 11l3 3.5"/>',
    star: '<path d="M12 4.5l2.2 4.6 5 .7-3.6 3.5.9 5L12 15.9 7.6 18.3l.9-5L4.9 9.8l5-.7z"/>',
    pencil: '<path d="M4 20h4L19 9a2 2 0 0 0-3-3L5 17z"/><path d="M14 7l3 3"/>',
    pin: '<path d="M12 16.5v5"/><path d="M7.5 4h9l-1.4 6 2.4 2.3V14H6.5v-1.7L8.9 10z"/>',
    trash: '<path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6.5 7l1 13h9l1-13"/>'
  };
  function panelInner(kind, label) {
    var holderId = kind === 'character' ? 'qgCharImg' : 'qgSceneImg';
    var secondary =
      '<button data-qg="edit-' + kind + '" class="qg-btn">' + svgIcon(QG_IC.pencil) + '<span>改这张</span></button>' +
      '<button data-qg="fav-' + kind + '" class="qg-btn">' + svgIcon(QG_IC.star) + '<span>收藏</span></button>' +
      (kind === 'character' ? '<button data-qg="setbase-character" class="qg-btn qg-btn-full">' + svgIcon(QG_IC.pin) + '<span>设为发图基准图</span></button>' : '') +
      '<button data-qg="clear-' + kind + '" class="qg-btn qg-btn-full">' + svgIcon(QG_IC.trash) + '<span>清空</span></button>';
    return '<div style="display:flex;flex-direction:column;gap:8px;">' +
      '<button data-qg="gen-' + kind + '" class="qg-btn qg-btn-primary">' + svgIcon(kind === 'character' ? QG_IC.person : QG_IC.scene) + '<span>' + (kind === 'character' ? '一键生角色图' : '一键生场景图') + '</span></button>' +
      '<div class="qg-actions">' + secondary + '</div>' +
      '<div id="' + holderId + '" class="qg-holder"><span class="qg-hint">尚未生成' + label + '</span></div>' +
      '<div data-qg="status-' + kind + '" class="qg-status"></div>' +
      '</div>';
  }
  function ensureStyles() {
    if (document.getElementById('qgStyles')) return;
    var s = document.createElement('style');
    s.id = 'qgStyles';
    s.textContent = [
      '.qg-actions{display:grid;grid-template-columns:1fr 1fr;gap:6px;}',
      '.qg-modebar{display:flex;flex-direction:column;gap:6px;margin-bottom:10px;}',
      '.qg-mode-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;}',
      '.qg-modebar-label{font-size:11px;opacity:.55;letter-spacing:.02em;}',
      '.qg-mode-btn{font-size:11px;padding:6px 8px;}',
      '.qg-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;font-size:12px;padding:7px 10px;border:1px solid rgba(127,127,127,.22);border-radius:9px;background:transparent;color:inherit;cursor:pointer;opacity:.78;white-space:nowrap;transition:background .15s,border-color .15s,opacity .15s,transform .05s;}',
      '.qg-btn:hover{opacity:1;background:rgba(127,127,127,.10);border-color:rgba(127,127,127,.42);}',
      '.qg-btn:active{transform:translateY(1px);}',
      '.qg-btn .qg-ic{flex:0 0 auto;opacity:.85;}',
      '.qg-btn-full{grid-column:1 / -1;}',
      '.qg-btn-primary{width:100%;font-weight:600;padding:9px 10px;opacity:1;background:rgba(127,127,127,.12);border-color:rgba(127,127,127,.4);}',
      '.qg-btn-primary:hover{background:rgba(127,127,127,.2);border-color:currentColor;}',
      '.qg-holder{min-height:96px;border:1px solid rgba(127,127,127,.22);background:rgba(127,127,127,.05);border-radius:12px;display:flex;align-items:center;justify-content:center;padding:8px;overflow:hidden;}',
      '.qg-holder img{max-width:100%;border-radius:9px;cursor:zoom-in;box-shadow:0 2px 10px rgba(0,0,0,.18);transition:transform .15s;}',
      '.qg-holder img:hover{transform:scale(1.02);}',
      '.qg-hint{font-size:11px;opacity:.5;}',
      '.qg-status{font-size:11px;opacity:.7;min-height:14px;}',
      '.qg-sec{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:600;opacity:.85;margin-bottom:8px;letter-spacing:.02em;}',
      '.qg-sec .qg-ic{opacity:.8;}'
    ].join('\n');
    document.head.appendChild(s);
  }
  function statusEl(kind) { return document.querySelector('[data-qg="status-' + kind + '"]'); }
  function setStatus(kind, txt) {
    document.querySelectorAll('[data-qg="status-' + kind + '"]').forEach(function (e) { e.textContent = txt || ''; });
  }
  function placeIntoPanel(kind, url) {
    setLastImage(kind, url);
    var holderId = kind === 'character' ? 'qgCharImg' : 'qgSceneImg';
    document.querySelectorAll('#' + holderId).forEach(function (h) {
      h.innerHTML = '';
      var im = document.createElement('img');
      im.src = url;
      im.title = '点击在大图工坊查看';
      im.onclick = function () { openInStudio(url); };
      h.appendChild(im);
    });
    var out = document.getElementById('imgOutput');
    if (out) {
      var im2 = document.createElement('img');
      im2.src = url;
      im2.style.maxWidth = '100%';
      out.innerHTML = '';
      out.appendChild(im2);
    }
  }
  // 4.62: 清空当前面板图(角色/场景),回到「尚未生成」占位
  function clearPanel(kind) {
    setLastImage(kind, '');
    try { localStorage.removeItem(LS_IMG[kind]); } catch (e) {}
    var holderId = kind === 'character' ? 'qgCharImg' : 'qgSceneImg';
    document.querySelectorAll('#' + holderId).forEach(function (h) {
      h.innerHTML = '<span class="qg-hint">尚未生成' + (kind === 'character' ? '角色图' : '场景图') + '</span>';
    });
    setStatus(kind, '');
  }
  function openInStudio(url) {
    try {
      if (window.__image && window.__image.open) window.__image.open();
      var out = document.getElementById('imgOutput');
      if (out) {
        var im = document.createElement('img');
        im.src = url; im.style.maxWidth = '100%';
        out.innerHTML = ''; out.appendChild(im);
      }
    } catch (e) {}
  }

  // ───── 三个一键流程 ─────
  async function quickGenerate(kind) {
    var card = activeCard();
    if (kind === 'character' && !card) { alert('请先在「角色卡」里选择一个角色'); return; }
    setStatus(kind, '正在构建提示词…');
    var userText = kind === 'character' ? cardToText(card) : gatherScene();
    var fallback = kind === 'character' ? tplCharacter(card) : tplScene(gatherScene());
    var prompt = await resolvePrompt(kind, userText, fallback);
    lastPrompt[kind] = prompt;
    setStatus(kind, '正在出图… (' + prompt.slice(0, 40) + '…)');
    try {
      var urls = await genZImage(prompt, 1);
      placeIntoPanel(kind, urls[0]);
      setStatus(kind, '完成');
    } catch (e) {
      setStatus(kind, e.message);
    }
  }
  async function quickEdit(kind) {
    var src = lastImage(kind);
    if (!src) { alert('请先生成' + (kind === 'character' ? '角色图' : '场景图') + '再改'); return; }
    var instr = prompt('想怎么改?(用大白话说,例如:换成和服 / 改成夜晚 / 加点雪)');
    if (!instr || !instr.trim()) return;
    setStatus(kind, '正在理解指令…');
    var editPrompt = await resolvePrompt('edit', instr.trim(), instr.trim());
    lastPrompt[kind] = editPrompt;
    setStatus(kind, '正在改图…');
    try {
      var url = await genEdit(editPrompt, src, function (st) { setStatus(kind, '改图中… ' + st); });
      placeIntoPanel(kind, url);
      setStatus(kind, '改图完成');
    } catch (e) {
      setStatus(kind, e.message);
    }
  }

  // 📌 把当前面板里的角色图直接锁为该角色的「微信发图基准图」(省去进设置→立绘卡那趟)
  async function setAsBaseImg(kind) {
    var src = lastImage(kind);
    if (!src) { alert('请先生成角色图再设为基准图'); return; }
    var card = activeCard();
    var id = (card && card.id) || 'default';
    if (!(window.__chatImage && window.__chatImage.setBaseImage)) { alert('发图模块未就绪(image-chat.js)'); return; }
    setStatus(kind, '正在设为基准图…');
    try {
      await window.__chatImage.setBaseImage({ characterId: id, imageUrl: src });
      setStatus(kind, '已设为「' + ((card && card.name) || '当前角色') + '」的发图基准图,以后发图都以这张保持同一人');
    } catch (e) { setStatus(kind, ((e && e.message) || e)); }
  }

  // ───── UI 注入(桌面右栏 + 移动端 tab)─────
  function modeBar() {
    return '<div class="qg-modebar">' +
      '<span class="qg-modebar-label">提示词引擎</span>' +
      '<div class="qg-mode-grid">' +
      '<button data-qg-mode="free" class="qg-btn qg-mode-btn" title="免费模式：NVIDIA gpt-oss，连接最稳、零费用">免费 gpt-oss</button>' +
      '<button data-qg-mode="fast" class="qg-btn qg-mode-btn" title="快速模式：DeepSeek，稳定但计费">快速 DeepSeek</button>' +
      '</div>' +
      '</div>';
  }
  function bindMode(root) {
    root.querySelectorAll('[data-qg-mode]').forEach(function (b) {
      if (b.__qgMb) return;
      b.__qgMb = true;
      b.addEventListener('click', function () { setLlmMode(b.getAttribute('data-qg-mode')); });
    });
  }
  var lastPrompt = {};
  function favCurrent(kind) {
    var src = lastImage(kind);
    if (!src) { alert('请先生成' + (kind === 'character' ? '角色图' : '场景图')); return; }
    if (window.__gallery && window.__gallery.favorite) window.__gallery.favorite(src, { kind: kind, prompt: lastPrompt[kind] || '' });
    else alert('画廊模块未加载');
  }
  function bindButtons(root) {
    root.querySelectorAll('[data-qg]').forEach(function (btn) {
      var act = btn.getAttribute('data-qg');
      if (!/^(gen|edit|fav|setbase|clear)-/.test(act) || btn.__qgBound) return;
      btn.__qgBound = true;
      btn.addEventListener('click', function () {
        var parts = act.split('-');
        if (parts[0] === 'gen') quickGenerate(parts[1]);
        else if (parts[0] === 'edit') quickEdit(parts[1]);
        else if (parts[0] === 'setbase') setAsBaseImg(parts[1]);
        else if (parts[0] === 'clear') clearPanel(parts[1]);
        else favCurrent(parts[1]);
      });
    });
  }
  function injectDesktop() {
    var ph = document.querySelector('#rightSidebar .sidebar-slot-placeholder');
    if (!ph || ph.__qgDone) return;
    ph.__qgDone = true;
    ph.innerHTML = modeBar() + '<div class="qg-sec">' + svgIcon(QG_IC.person) + '<span>角色形象</span></div>' +
      panelInner('character', '角色图') +
      '<div style="height:14px;"></div>' +
      '<div class="qg-sec">' + svgIcon(QG_IC.scene) + '<span>场景图</span></div>' +
      panelInner('scene', '场景图');
    bindButtons(ph);
    bindMode(ph);
    updateModeUI();
  }
  // 2026-09-14 UI第二轮:形象/场景合并进单一「图像」tab(纵向堆叠,与桌面工坊结构一致)
  function injectMobile() {
    var ib = document.querySelector('#mobileBottomTabs .mobile-tab-btn[data-tab="image"]');
    if (ib) { ib.disabled = false; ib.removeAttribute('disabled'); }
    var p = document.getElementById('mobileTabPanel-image');
    if (p && !p.__qgDone) {
      p.__qgDone = true;
      p.innerHTML = modeBar()
        + '<div class="qg-sec">' + svgIcon(QG_IC.person) + '<span>角色形象</span></div>' + panelInner('character', '角色图')
        + '<div style="height:14px;"></div>'
        + '<div class="qg-sec">' + svgIcon(QG_IC.scene) + '<span>场景图</span></div>' + panelInner('scene', '场景图');
      p.style.textAlign = 'left';
      bindButtons(p); bindMode(p);
    }
  }
  function restoreLast() {
    ['character', 'scene'].forEach(function (k) {
      var u = lastImage(k);
      if (u) placeIntoPanel(k, u);
    });
  }

  function init() {
    ensureStyles();
    injectDesktop();
    injectMobile();
    restoreLast();
    updateModeUI();
  }

  window.__imageQuick = {
    generateCharacter: function () { return quickGenerate('character'); },
    generateScene: function () { return quickGenerate('scene'); },
    editCharacter: function () { return quickEdit('character'); },
    editScene: function () { return quickEdit('scene'); },
    buildPrompt: llmBuildPrompt,
    setMode: setLlmMode,
    getMode: llmMode
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();