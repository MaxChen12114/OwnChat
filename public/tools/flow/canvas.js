// 路径: public/flow/canvas.js
/* 代码台 · 画布层 (canvas.js)
   Drawflow 画布 + 调色板 + 「Drawflow 导出 → NodeEngine 图」适配器。
   这是唯一与具体画布库耦合的一层 —— 以后换 React Flow 只重写本文件。
   依赖:window.Drawflow(CDN)、window.NodeEngine、节点包已注册。 */
(function () {
  var E = window.NodeEngine;
  if (!E) { alert('节点引擎未加载'); return; }
  var $ = function (s, r) { return (r || document).querySelector(s); };
  if (!window.Drawflow) { var w = $('#cdnWarn'); if (w) w.style.display = 'block'; return; }

  var container = $('#canvas');
  var editor = new Drawflow(container);
  editor.reroute = true;
  editor.start();

  var LS_GRAPH = 'cfw_coding_graph_v1';
  var LS_MODEL = 'cfw_coding_model_v1';

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function models() {
    var free = (window.APP_MODELS_FREE && window.APP_MODELS_FREE.length) ? window.APP_MODELS_FREE : ['deepseek-ai/deepseek-v4-pro', 'z-ai/glm-5.1', 'openai/gpt-oss-120b'];
    var fast = (window.APP_MODELS_FAST && window.APP_MODELS_FAST.length) ? window.APP_MODELS_FAST : ['deepseek-v4-flash', 'deepseek-v4-pro'];
    var seen = {}, out = [];
    free.concat(fast).forEach(function (m) {
      if (!m) return;
      // config.js 下发的是 { id, label } 对象;fallback 是字符串。统一成 { id, label }
      var id = (typeof m === 'string') ? m : (m.id || '');
      var label = (typeof m === 'string') ? m : (m.label || m.id || '');
      if (!id || seen[id]) return;
      if (id.indexOf("__") === 0) return; // 2026-09-14:占位模型("__xx_placeholder__")不是可选项
      seen[id] = 1;
      out.push({ id: id, label: label });
    });
    return out;
  }

  function nodeHtml(def) {
    var h = '<div class="nd">';
    h += '<div class="nd-head">' + esc(def.title) + '</div>';
    if (def.desc) h += '<div class="nd-desc">' + esc(def.desc) + '</div>';
    if (def.params && def.params.length) {
      h += '<div class="nd-body">';
      def.params.forEach(function (p) {
        h += '<label class="nd-field"><span>' + esc(p.label) + '</span>';
        if (p.type === 'textarea') {
          h += '<textarea df-' + p.key + ' rows="3" placeholder="' + esc(p.placeholder || '') + '"></textarea>';
        } else if (p.type === 'select') {
          var opts = '';
          if (p.options === '__models__') {
            models().forEach(function (m) { opts += '<option value="' + esc(m.id) + '">' + esc(m.label) + '</option>'; });
          } else if (Array.isArray(p.options)) {
            p.options.forEach(function (o) { opts += '<option value="' + esc(o) + '">' + esc(o) + '</option>'; });
          }
          h += '<select df-' + p.key + '>' + opts + '</select>';
        } else if (p.type === 'number') {
          h += '<input df-' + p.key + ' type="number" placeholder="' + esc(p.placeholder || '') + '">';
        } else {
          h += '<input df-' + p.key + ' type="text" placeholder="' + esc(p.placeholder || '') + '">';
        }
        h += '</label>';
      });
      h += '</div>';
    }
    h += '<div class="nd-out" data-node-out></div>';
    h += '</div>';
    return h;
  }

  function defaultData(def) {
    var d = {};
    (def.params || []).forEach(function (p) {
      if (p['default'] != null) d[p.key] = p['default'];
      else if (p.type === 'select' && p.options === '__models__') d[p.key] = localStorage.getItem(LS_MODEL) || (models()[0] && models()[0].id) || '';
      else d[p.key] = '';
    });
    return d;
  }

  var addCount = 0;
  function addNode(type, x, y) {
    var def = E.getType(type);
    if (!def) return;
    addCount++;
    var px = (x == null) ? (40 + (addCount % 5) * 26) : x;
    var py = (y == null) ? (40 + (addCount % 5) * 26) : y;
    editor.addNode(type, (def.inputs || []).length, (def.outputs || []).length, px, py, 'ndwrap', defaultData(def), nodeHtml(def));
  }

  function buildPalette() {
    var pal = $('#palette');
    pal.innerHTML = '';
    E.listGroups().forEach(function (grp) {
      var sec = document.createElement('div');
      sec.className = 'pal-group';
      sec.innerHTML = '<div class="pal-title">' + esc(grp.group) + '</div>';
      grp.types.forEach(function (def) {
        var btn = document.createElement('button');
        btn.className = 'pal-item'; btn.type = 'button';
        btn.title = def.desc || ''; btn.textContent = def.title;
        btn.addEventListener('click', function () { addNode(def.type); });
        sec.appendChild(btn);
      });
      pal.appendChild(sec);
    });
  }

  // ── Drawflow 导出 → 引擎图 ──
  function toGraph() {
    var ex = editor.export();
    var home = ex.drawflow.Home.data;
    var nodes = [], edges = [];
    Object.keys(home).forEach(function (id) {
      var n = home[id];
      var def = E.getType(n.name);
      if (!def) return;
      nodes.push({ id: String(id), type: n.name, params: n.data || {} });
      var outs = n.outputs || {};
      Object.keys(outs).forEach(function (outKey) {
        var oi = parseInt(outKey.split('_')[1], 10) - 1;
        var outName = (def.outputs[oi] || {}).name;
        (outs[outKey].connections || []).forEach(function (c) {
          var tn = home[c.node];
          var tdef = tn ? E.getType(tn.name) : null;
          if (!tdef) return;
          var ii = parseInt(String(c.output).split('_')[1], 10) - 1;
          var inName = (tdef.inputs[ii] || {}).name;
          edges.push({ from: { node: String(id), output: outName }, to: { node: String(c.node), input: inName } });
        });
      });
    });
    return { nodes: nodes, edges: edges };
  }

  // ── 选 mode:选中的是 FAST(DeepSeek 官方)模型 → fast 走稳定付费线;否则 free(NVIDIA NIM)。 ──
  // 修正远古遗留 bug:旧版写死 mode:'free',即便在节点里选了 fast 模型,worker 也会把它静默降级回免费默认模型,
  // 全程走 NVIDIA 免费线;免费线不稳定时整条流跑空,下游 AI 节点报「输入为空 / AI 无输入」。
  function modeForModel(model) {
    var fast = window.APP_MODELS_FAST || [];
    for (var i = 0; i < fast.length; i++) {
      var id = (typeof fast[i] === 'string') ? fast[i] : (fast[i] && fast[i].id);
      if (id && id === model) return 'fast';
    }
    return 'free';
  }

  // ── /api/chat 流式(与 studio/write 同契约) ──
  async function chat(opts) {
    var model = opts.model || '';
    var body = {
      mode: modeForModel(model), model: model,
      promptProfile: 'assist',
      use_builtin_persona: false, custom_system_prompt: opts.system || '',
      thinking: 'disabled', messages: [{ role: 'user', content: opts.user || '' }]
    };
    var resp = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!resp.ok || !resp.body) throw new Error('请求失败 HTTP ' + resp.status);
    var reader = resp.body.getReader();
    var dec = new TextDecoder();
    var buf = '', full = '';
    while (true) {
      var r = await reader.read();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      var lines = buf.split('\n');
      buf = lines.pop();
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line || line.indexOf('data:') !== 0) continue;
        var data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          var j = JSON.parse(data);
          var delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
          if (delta) full += delta;
        } catch (e) {}
      }
    }
    // 空输出兜底:线路抽风返回空流时直接抛清晰错误,而不是静默返回空串骗到下游(旧版即因此报「AI 无输入」)
    if (!full.trim()) throw new Error('模型未返回任何内容（线路可能不稳定，换个模型或重试）');
    return full;
  }

  // ── 运行 ──
  var running = false, aborter = null;
  function logLine(msg) {
    var el = $('#console');
    var p = document.createElement('div');
    p.className = 'log-line'; p.textContent = msg;
    el.appendChild(p); el.scrollTop = el.scrollHeight;
  }
  function clearConsole() { $('#console').innerHTML = ''; }

  // ── 产物（生成的代码/文本整理成文件）+ 输出台/产物 标签切换 + 高度拉伸 ──
  var lastArtifacts = [];
  var LS_CONSOLE_H = 'cfw_coding_console_h_v1';

  function switchTab(which) {
    var showLog = which !== 'art';
    var log = $('#console'), art = $('#artifacts'), tl = $('#tabLog'), ta = $('#tabArt');
    if (log) log.hidden = !showLog;
    if (art) art.hidden = showLog;
    if (tl) tl.classList.toggle('active', showLog);
    if (ta) ta.classList.toggle('active', !showLog);
  }

  function primaryVal(res) {
    if (!res || typeof res !== 'object') return '';
    var k = Object.keys(res);
    return k.length ? res[k[0]] : '';
  }
  function extFromLang(lang) {
    var map = { html: 'html', xml: 'xml', css: 'css', js: 'js', javascript: 'js', jsx: 'jsx', ts: 'ts', typescript: 'ts', json: 'json', py: 'py', python: 'py', md: 'md', markdown: 'md', sh: 'sh', bash: 'sh', sql: 'sql', yaml: 'yml', yml: 'yml', java: 'java', c: 'c', cpp: 'cpp', go: 'go', rs: 'rs', vue: 'vue' };
    return map[String(lang || '').toLowerCase()] || 'txt';
  }
  function sniffExt(text) {
    var t = String(text || '').trim();
    if (/^<!doctype html|^<html[\s>]|<\/html>/i.test(t)) return 'html';
    if (/^\s*[{\[]/.test(t)) { try { JSON.parse(t); return 'json'; } catch (e) {} }
    if (/(^|\n)\s*(function|const |let |var |=>|import |export )/.test(t)) return 'js';
    if (/[#.@][\w-]+\s*\{[\s\S]*\}/.test(t) && /:[^;]+;/.test(t)) return 'css';
    return 'txt';
  }
  function sanitizeName(s) {
    return String(s || 'output').replace(/[^\w一-龥.-]+/g, '_').replace(/^_+|_+$/g, '') || 'output';
  }
  function artifactsFromText(title, text) {
    var out = [], re = /```([\w+\-]*)\s*\n([\s\S]*?)```/g, m, idx = 0;
    while ((m = re.exec(text)) !== null) {
      var body = m[2].replace(/\s+$/, '');
      if (!body.trim()) continue;
      idx++;
      out.push({ name: sanitizeName(title) + (idx > 1 ? ('-' + idx) : '') + '.' + extFromLang(m[1]), code: body });
    }
    if (!out.length) {
      var t = String(text || '').trim();
      if (t) out.push({ name: sanitizeName(title) + '.' + sniffExt(t), code: t });
    }
    return out;
  }
  function collectArtifacts(graph, outputs) {
    var hasOut = {};
    (graph.edges || []).forEach(function (e) { hasOut[e.from.node] = 1; });
    var arts = [], seen = {};
    (graph.nodes || []).forEach(function (n) {
      var def = E.getType(n.type);
      var terminal = !hasOut[n.id];
      if (n.type !== 'output' && !terminal) return;
      var v = primaryVal(outputs[n.id]);
      var text = String(v == null ? '' : v);
      if (!text.trim()) return;
      var title = (def && def.title) ? def.title : n.type;
      artifactsFromText(title, text).forEach(function (a) {
        var nm = a.name, i = 1;
        while (seen[nm]) { i++; nm = a.name.replace(/(\.[^.]+)$/, '_' + i + '$1'); }
        seen[nm] = 1; a.name = nm; arts.push(a);
      });
    });
    return arts;
  }
  function fallbackCopy(text) {
    try { var ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); } catch (e) {}
  }
  function copyText(text, btn) {
    var old = btn ? btn.textContent : '';
    var done = function () { if (btn) { btn.textContent = '已复制'; setTimeout(function () { btn.textContent = old; }, 1200); } };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    else { fallbackCopy(text); done(); }
  }
  function downloadFile(name, text) {
    try {
      var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    } catch (e) { logLine('下载失败:' + (e && e.message || e)); }
  }
  async function downloadAll(arts) {
    for (var i = 0; i < arts.length; i++) { downloadFile(arts[i].name, arts[i].code); await new Promise(function (r) { setTimeout(r, 300); }); }
  }
  function renderArtifacts(arts) {
    lastArtifacts = arts || [];
    var box = $('#artifacts'); if (!box) return;
    var cnt = $('#artCount'); if (cnt) cnt.textContent = String(lastArtifacts.length);
    var dla = $('#downloadAllBtn'); if (dla) dla.hidden = lastArtifacts.length === 0;
    box.innerHTML = '';
    if (!lastArtifacts.length) {
      var empty = document.createElement('div');
      empty.className = 'art-empty';
      empty.textContent = '运行后,生成的代码/文本会被整理成文件显示在这里,可单独复制或下载,不再挤在输出台。';
      box.appendChild(empty);
      return;
    }
    lastArtifacts.forEach(function (a) {
      var card = document.createElement('div'); card.className = 'art-card';
      var head = document.createElement('div'); head.className = 'art-head';
      var left = document.createElement('div'); left.className = 'art-info';
      var nm = document.createElement('span'); nm.className = 'art-name'; nm.textContent = a.name;
      var meta = document.createElement('span'); meta.className = 'art-meta'; meta.textContent = a.code.length + ' 字';
      left.appendChild(nm); left.appendChild(meta);
      var btns = document.createElement('div'); btns.className = 'art-btns';
      var cp = document.createElement('button'); cp.className = 'btn'; cp.type = 'button'; cp.textContent = '复制';
      cp.addEventListener('click', function () { copyText(a.code, cp); });
      var dl = document.createElement('button'); dl.className = 'btn'; dl.type = 'button'; dl.textContent = '下载';
      dl.addEventListener('click', function () { downloadFile(a.name, a.code); });
      btns.appendChild(cp); btns.appendChild(dl);
      head.appendChild(left); head.appendChild(btns);
      var pre = document.createElement('pre'); pre.className = 'art-code'; pre.textContent = a.code;
      card.appendChild(head); card.appendChild(pre);
      box.appendChild(card);
    });
  }
  function initConsoleResize() {
    var pane = $('#consolePane'), handle = $('#consoleResize');
    if (!pane || !handle) return;
    var saved = parseInt(localStorage.getItem(LS_CONSOLE_H), 10);
    if (saved && saved >= 120) pane.style.height = saved + 'px';
    var dragging = false, startY = 0, startH = 0;
    handle.addEventListener('pointerdown', function (e) {
      dragging = true; startY = e.clientY; startH = pane.getBoundingClientRect().height;
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
      document.body.style.userSelect = 'none';
    });
    handle.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dy = e.clientY - startY;
      var h = Math.max(120, Math.min(window.innerHeight * 0.8, startH - dy));
      pane.style.height = h + 'px';
    });
    function end() {
      if (!dragging) return;
      dragging = false; document.body.style.userSelect = '';
      try { localStorage.setItem(LS_CONSOLE_H, String(Math.round(pane.getBoundingClientRect().height))); } catch (_) {}
    }
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  function setNodeOut(id, text) {
    var nodeEl = $('#node-' + id);
    if (!nodeEl) return;
    var slot = nodeEl.querySelector('[data-node-out]');
    if (slot) slot.textContent = text ? ('→ ' + (text.length > 200 ? text.slice(0, 200) + '…' : text)) : '';
  }

  async function runGraph() {
    if (running) return;
    var graph = toGraph();
    if (!graph.nodes.length) { logLine('画布为空,先从左侧添加节点。'); return; }
    running = true; aborter = new AbortController();
    $('#runBtn').disabled = true; $('#stopBtn').hidden = false;
    clearConsole();
    logLine('开始运行 · ' + graph.nodes.length + ' 节点 / ' + graph.edges.length + ' 连线');
    var ctx = {
      chat: chat, log: logLine, signal: aborter.signal,
      emit: function (label, val) {
        var s = String(val == null ? '' : val);
        logLine('【' + label + '】' + (s.length > 120 ? (s.slice(0, 120) + '…（' + s.length + ' 字,完整内容见「产物」标签）') : s));
      },
      onNodeDone: function (id, res) { var k = res && Object.keys(res)[0]; setNodeOut(id, k ? String(res[k]) : ''); }
    };
    try {
      var result = await E.run(graph, ctx);
      logLine('✓ 运行完成');
      var arts = collectArtifacts(graph, (result && result.outputs) || {});
      renderArtifacts(arts);
      if (arts.length) { switchTab('art'); logLine('整理出 ' + arts.length + ' 个产物文件,可在「产物」标签复制或导出。'); }
    } catch (e) {
      logLine('✕ 终止:' + (e && e.message || e));
    } finally {
      running = false; $('#runBtn').disabled = false; $('#stopBtn').hidden = true;
    }
  }

  // ── 保存 / 载入 ──
  var flashT = null;
  function flash(msg) {
    var s = $('#saveState'); if (!s) return;
    s.textContent = msg; clearTimeout(flashT);
    flashT = setTimeout(function () { s.textContent = '节点工作流'; }, 1500);
  }
  function save() {
    try { localStorage.setItem(LS_GRAPH, JSON.stringify(editor.export())); flash('已保存'); }
    catch (e) { flash('保存失败'); }
  }
  function load() {
    try { var raw = localStorage.getItem(LS_GRAPH); if (raw) editor.import(JSON.parse(raw)); } catch (e) {}
  }

  var saveT = null;
  ['nodeCreated', 'nodeRemoved', 'nodeDataChanged', 'connectionCreated', 'connectionRemoved', 'nodeMoved'].forEach(function (ev) {
    editor.on(ev, function () { clearTimeout(saveT); saveT = setTimeout(save, 800); });
  });

  // ── 接线 ──
  buildPalette();
  load();
  $('#runBtn').addEventListener('click', runGraph);
  $('#stopBtn').addEventListener('click', function () { if (aborter) aborter.abort(); });
  $('#saveBtn').addEventListener('click', save);
  $('#clearBtn').addEventListener('click', function () {
    if (confirm('清空画布?此操作不可撤销。')) { editor.clear(); clearConsole(); save(); }
  });
  var clr = $('#clearLogBtn'); if (clr) clr.addEventListener('click', clearConsole);
  var tl = $('#tabLog'); if (tl) tl.addEventListener('click', function () { switchTab('log'); });
  var ta = $('#tabArt'); if (ta) ta.addEventListener('click', function () { switchTab('art'); });
  var dla = $('#downloadAllBtn'); if (dla) dla.addEventListener('click', function () { if (lastArtifacts && lastArtifacts.length) downloadAll(lastArtifacts); });
  initConsoleResize();
  renderArtifacts([]);

  // 画布为空时给个最小起步示例
  if (!localStorage.getItem(LS_GRAPH)) {
    addNode('text-input', 60, 90);
    addNode('ai-generate', 380, 90);
    addNode('output', 720, 90);
  }
})();
