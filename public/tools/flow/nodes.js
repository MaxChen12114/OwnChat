// 路径: public/flow/nodes.js
/* 代码台 · 节点包 (nodes.js)
   往 NodeEngine 注册具体节点类型。两个包:
   - 「酒馆 · AI 工具」:文本输入 / 模板拼接 / AI 生成 / 抽取角色卡 / 输出
   - 「洪都 · GIS(占位)」:GeoJSON 输入 / 缓冲区 / 质心 —— 演示节点包扩展点,
     执行函数现为本地占位(标注待接 Turf.js),数据结构与端口已就位。
   纯数据 + 纯 JS,框架中立。 */
(function () {
  var E = window.NodeEngine;
  if (!E) { console.error('[nodes] NodeEngine 未加载'); return; }

  var G_BASE = '基础';
  var G_AI = 'AI · 生成';
  var G_CODE = '代码 · 处理';
  var G_TAVERN = '酒馆 · 专用';
  var G_GIS = '洪都 · GIS(占位)';
  var SLOT = '{' + '{in}' + '}';

  function asText(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); }
  }

  // ── 文本输入(通用起点:需求 / 素材 / 任意文本) ──
  E.register({
    type: 'text-input', title: '文本输入', group: G_BASE,
    desc: '手填一段文本,作为下游起点。可当「需求」「素材」等任意通用输入,接到任何节点。',
    inputs: [], outputs: [{ name: 'text', label: '文本' }],
    params: [{ key: 'text', label: '文本', type: 'textarea', placeholder: '在此输入起始文本(需求 / 素材 / 任意内容)…' }],
    run: function (inputs, params) { return { text: params.text || '' }; }
  });

  // ── 合并文本(把两路文本拼一起) ──
  E.register({
    type: 'merge-text', title: '合并文本', group: G_BASE,
    desc: '把 A、B 两路文本按分隔符拼成一段(A 在前,B 在后)。',
    inputs: [{ name: 'a', label: 'A' }, { name: 'b', label: 'B' }], outputs: [{ name: 'text', label: '文本' }],
    params: [{ key: 'sep', label: '分隔符', type: 'text', placeholder: '默认换行;也可填空格或 ---' }],
    run: function (inputs, params) {
      var sep = (params.sep != null && params.sep !== '') ? params.sep : '\n';
      var parts = [asText(inputs.a), asText(inputs.b)].filter(function (s) { return s !== ''; });
      return { text: parts.join(sep) };
    }
  });

  // ── 模板拼接 ──
  E.register({
    type: 'template', title: '模板拼接', group: G_BASE,
    desc: '用 ' + SLOT + ' 占位把上游文本嵌进模板。',
    inputs: [{ name: 'in', label: '输入' }], outputs: [{ name: 'text', label: '文本' }],
    params: [{ key: 'tpl', label: '模板', type: 'textarea', placeholder: '例如:请润色下面内容\n' + SLOT }],
    run: function (inputs, params) {
      var tpl = params.tpl || SLOT;
      return { text: tpl.split(SLOT).join(asText(inputs.in)) };
    }
  });

  // ── AI 生成 ──
  E.register({
    type: 'ai-generate', title: 'AI 生成', group: G_AI,
    desc: '把输入作为用户消息发给模型,产出文本。',
    inputs: [{ name: 'prompt', label: '提示' }], outputs: [{ name: 'text', label: '结果' }],
    params: [
      { key: 'system', label: '系统提示', type: 'textarea', placeholder: '(可选)角色/风格约束' },
      { key: 'model', label: '模型', type: 'select', options: '__models__' }
    ],
    run: async function (inputs, params, ctx) {
      if (!ctx || !ctx.chat) throw new Error('运行环境未提供 chat 通道');
      var user = asText(inputs.prompt);
      if (!user.trim()) throw new Error('AI 生成:输入提示为空');
      var out = await ctx.chat({ system: params.system || '', user: user, model: params.model || '' });
      return { text: out };
    }
  });

  // ── 抽取角色卡(JSON) ──
  E.register({
    type: 'extract-card', title: '抽取角色卡', group: G_TAVERN,
    desc: '让模型把上游文本整理成角色卡 JSON。',
    inputs: [{ name: 'text', label: '素材' }], outputs: [{ name: 'json', label: '角色卡JSON' }],
    params: [{ key: 'model', label: '模型', type: 'select', options: '__models__' }],
    run: async function (inputs, params, ctx) {
      if (!ctx || !ctx.chat) throw new Error('运行环境未提供 chat 通道');
      var sys = '你是角色卡抽取器。读用户给的素材,输出一个 JSON 对象,字段:name、identity、personality、speakingStyle、openingLine。只输出 JSON,不要解释,不要代码块围栏。';
      var out = await ctx.chat({ system: sys, user: asText(inputs.text), model: params.model || '' });
      return { json: out };
    }
  });

  // ── 输出 ──
  E.register({
    type: 'output', title: '输出', group: G_BASE,
    desc: '终点节点:把上游结果收集到输出台。',
    inputs: [{ name: 'in', label: '输入' }], outputs: [],
    params: [{ key: 'label', label: '标签', type: 'text', placeholder: '(可选)给这个输出起个名' }],
    run: function (inputs, params, ctx) {
      var val = asText(inputs.in);
      if (ctx && ctx.emit) ctx.emit(params.label || '输出', val);
      return { value: val };
    }
  });

  // ════ 代码 · 工具(让「代码台」名副其实的真代码节点) ════
  // ── JS 变换(代码节点) ──
  E.register({
    type: 'js-transform', title: 'JS 变换', group: G_CODE,
    desc: '写一段 JS 处理上游数据:input 是上游文本,return 的值即输出。',
    inputs: [{ name: 'in', label: '输入' }], outputs: [{ name: 'out', label: '结果' }],
    params: [{ key: 'code', label: 'JS 代码', type: 'textarea', placeholder: '// input 为上游文本\nreturn input.trim().toUpperCase();' }],
    run: function (inputs, params) {
      var code = params.code || 'return input;';
      var fn = new Function('input', code);
      var r = fn(asText(inputs.in));
      return { out: (typeof r === 'string') ? r : asText(r) };
    }
  });

  // ── 正则提取 / 替换 ──
  E.register({
    type: 'regex', title: '正则提取/替换', group: G_CODE,
    desc: '填替换文本=替换;留空=提取所有匹配(每行一个,有捕获组取组1)。',
    inputs: [{ name: 'in', label: '输入' }], outputs: [{ name: 'text', label: '结果' }],
    params: [
      { key: 'pattern', label: '正则', type: 'text', placeholder: '\\d+' },
      { key: 'flags', label: '标志', type: 'text', placeholder: 'g' },
      { key: 'replace', label: '替换为(留空=提取)', type: 'text', placeholder: '(可选)' }
    ],
    run: function (inputs, params) {
      var src = asText(inputs.in);
      var flags = params.flags || 'g';
      var re = new RegExp(params.pattern || '', flags);
      if (params.replace != null && params.replace !== '') {
        return { text: src.replace(re, params.replace) };
      }
      if (flags.indexOf('g') < 0) { var m0 = src.match(re); return { text: m0 ? m0[0] : '' }; }
      var out = [], m, guard = 0;
      while ((m = re.exec(src)) !== null && guard++ < 10000) {
        out.push(m[1] != null ? m[1] : m[0]);
        if (m.index === re.lastIndex) re.lastIndex++;
      }
      return { text: out.join('\n') };
    }
  });

  // ── HTTP 请求(GET) ──
  E.register({
    type: 'http-fetch', title: 'HTTP 请求', group: G_CODE,
    desc: 'GET 一个 URL 取回文本(受浏览器 CORS 限制)。上游可覆盖 URL。',
    inputs: [{ name: 'url', label: 'URL(可选)' }], outputs: [{ name: 'text', label: '响应文本' }],
    params: [{ key: 'url', label: 'URL', type: 'text', placeholder: 'https://...' }],
    run: async function (inputs, params, ctx) {
      var u = (asText(inputs.url) || params.url || '').trim();
      if (!u) throw new Error('HTTP 请求:URL 为空');
      var resp = await fetch(u, { signal: ctx && ctx.signal });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return { text: await resp.text() };
    }
  });

  // ══ 控制流 · 分支 / 循环 / JSON 提取 ══
  // ── 条件分支 ──
  E.register({
    type: 'branch', title: '条件分支', group: G_CODE,
    desc: '按条件把输入分到「真」或「假」出口,另一出口为空。条件用 input 变量写 JS 表达式。',
    inputs: [{ name: 'in', label: '输入' }],
    outputs: [{ name: 'yes', label: '真' }, { name: 'no', label: '假' }],
    params: [{ key: 'cond', label: '条件(JS 表达式)', type: 'textarea', placeholder: "// input 为上游文本\ninput.includes('错误')" }],
    run: function (inputs, params) {
      var val = asText(inputs.in);
      var expr = (params.cond || '').trim() || 'input.length > 0';
      var ok;
      try { ok = !!(new Function('input', 'return (' + expr + ');')(val)); }
      catch (e) { throw new Error('条件分支：表达式出错 ' + e.message); }
      return ok ? { yes: val, no: '' } : { yes: '', no: val };
    }
  });

  // ── 循环处理(对列表逐项套用模板 / JS) ──
  E.register({
    type: 'loop-map', title: '循环处理', group: G_CODE,
    desc: '把输入拆成多项,对每项套用模板或 JS 后合并。模板用 %item% 和 %i%；JS 用 item、i 变量并 return。',
    inputs: [{ name: 'in', label: '列表文本' }],
    outputs: [{ name: 'text', label: '结果' }, { name: 'count', label: '项数' }],
    params: [
      { key: 'split', label: '拆分方式', type: 'select', options: ['按行', 'JSON 数组', '逗号', '自定义分隔符'] },
      { key: 'sep', label: '自定义分隔符', type: 'text', placeholder: '选「自定义分隔符」时生效' },
      { key: 'mode', label: '处理方式', type: 'select', options: ['模板', 'JS 表达式'] },
      { key: 'tpl', label: '模板 / JS', type: 'textarea', placeholder: '模板：第 %i% 项=%item%\nJS：return item.toUpperCase();' },
      { key: 'join', label: '合并分隔符', type: 'text', placeholder: '默认换行' }
    ],
    run: function (inputs, params) {
      var src = asText(inputs.in);
      var how = params.split || '按行', items;
      if (how === 'JSON 数组') {
        try { var arr = JSON.parse(src); items = Array.isArray(arr) ? arr : [arr]; }
        catch (e) { throw new Error('循环处理：JSON 数组解析失败 ' + e.message); }
      } else if (how === '逗号') { items = src.split(','); }
      else if (how === '自定义分隔符') { items = src.split((params.sep != null && params.sep !== '') ? params.sep : '\n'); }
      else { items = src.split(/\r?\n/); }
      items = items.map(function (x) { return (typeof x === 'string') ? x : asText(x); });
      if (how !== 'JSON 数组') { items = items.filter(function (s) { return s.trim() !== ''; }); }
      var mode = params.mode || '模板', tpl = params.tpl || '';
      var out = items.map(function (item, i) {
        if (mode === 'JS 表达式') {
          try { var r = new Function('item', 'i', tpl || 'return item;')(item, i); return (typeof r === 'string') ? r : asText(r); }
          catch (e) { throw new Error('循环处理：第 ' + (i + 1) + ' 项 JS 出错 ' + e.message); }
        }
        return tpl.split('%item%').join(item).split('%i%').join(String(i));
      });
      var join = (params.join != null && params.join !== '') ? params.join : '\n';
      return { text: out.join(join), count: items.length };
    }
  });

  // ── JSON 提取(按路径取值) ──
  E.register({
    type: 'json-extract', title: 'JSON 提取', group: G_CODE,
    desc: '解析上游 JSON,按路径取值(如 user.name 或 items[0].id)。路径留空=整体格式化输出。',
    inputs: [{ name: 'in', label: 'JSON' }],
    outputs: [{ name: 'value', label: '取出的值' }],
    params: [{ key: 'path', label: '路径', type: 'text', placeholder: 'user.name 或 items[0].id（留空=全部）' }],
    run: function (inputs, params) {
      var src = asText(inputs.in), data;
      try { data = JSON.parse(src); }
      catch (e) { throw new Error('JSON 提取：输入不是合法 JSON ' + e.message); }
      var path = (params.path || '').trim();
      if (!path) return { value: asText(data) };
      var keys = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(function (k) { return k !== ''; });
      var node = data;
      for (var i = 0; i < keys.length; i++) {
        if (node == null) throw new Error('JSON 提取：路径「' + path + '」在第 ' + (i + 1) + ' 段中断');
        node = node[keys[i]];
      }
      return { value: asText(node) };
    }
  });

  // ── 代码生成(AI) ──
  E.register({
    type: 'code-gen', title: '代码生成', group: G_AI,
    desc: '按需求生成指定语言代码,只输出代码本体。「需求」需由上游连入(如 基础·文本输入),为空会报错。',
    inputs: [{ name: 'spec', label: '需求' }], outputs: [{ name: 'code', label: '代码' }],
    params: [
      { key: 'lang', label: '语言', type: 'select', options: ['JavaScript', 'TypeScript', 'Python', 'HTML', 'CSS', 'SQL', 'Shell'] },
      { key: 'model', label: '模型', type: 'select', options: '__models__' }
    ],
    run: async function (inputs, params, ctx) {
      if (!ctx || !ctx.chat) throw new Error('运行环境未提供 chat 通道');
      var spec = asText(inputs.spec);
      if (!spec.trim()) throw new Error('代码生成:需求为空');
      var lang = params.lang || 'JavaScript';
      var sys = '你是代码生成器。用 ' + lang + ' 实现用户需求。只输出代码本体,不要任何解释、注释说明或 Markdown 代码块围栏。';
      var out = await ctx.chat({ system: sys, user: spec, model: params.model || '' });
      return { code: out };
    }
  });

  // ════ 洪都 GIS 占位包(演示节点包扩展点) ════
  E.register({
    type: 'gis-geojson', title: 'GeoJSON 输入', group: G_GIS,
    desc: '粘贴一段 GeoJSON,作为空间分析起点。',
    inputs: [], outputs: [{ name: 'geojson', label: 'GeoJSON' }],
    params: [{ key: 'geojson', label: 'GeoJSON', type: 'textarea', placeholder: '{"type":"FeatureCollection","features":[]}' }],
    run: function (inputs, params) {
      var raw = params.geojson || '';
      try { return { geojson: raw ? JSON.parse(raw) : { type: 'FeatureCollection', features: [] } }; }
      catch (e) { throw new Error('GeoJSON 解析失败:' + e.message); }
    }
  });

  E.register({
    type: 'gis-buffer', title: '缓冲区分析', group: G_GIS,
    desc: '(占位)对要素做缓冲。正式版接 Turf.js buffer。',
    inputs: [{ name: 'geojson', label: 'GeoJSON' }], outputs: [{ name: 'geojson', label: 'GeoJSON' }],
    params: [{ key: 'radius', label: '半径(米)', type: 'number', placeholder: '500' }],
    run: function (inputs, params) {
      var fc = inputs.geojson || { type: 'FeatureCollection', features: [] };
      return { geojson: { __op: 'buffer', radius: Number(params.radius) || 0, source: fc } };
    }
  });

  E.register({
    type: 'gis-centroid', title: '质心', group: G_GIS,
    desc: '(占位)求要素质心。正式版接 Turf.js centroid。',
    inputs: [{ name: 'geojson', label: 'GeoJSON' }], outputs: [{ name: 'geojson', label: '质心点' }],
    params: [],
    run: function (inputs) {
      var fc = inputs.geojson || { type: 'FeatureCollection', features: [] };
      return { geojson: { __op: 'centroid', source: fc } };
    }
  });
})();