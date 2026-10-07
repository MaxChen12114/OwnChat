// 路径: public/flow/help.js
/* 代码台 · 使用指南 (help.js)
   纯前端、零依赖:往顶栏注入「帮助」按钮 + 一个说明 Modal。
   面向普通用户,讲清「加节点 → 连线 → 运行」三步和每个节点干什么。
   样式复用 index.html 的 :root 变量(--ac/--panel...),不污染全局。 */
(function () {
  if (document.getElementById('codingHelpModal')) return;

  // ── 注入隔离样式 ──
  var css = [
    '#codingHelpMask{position:fixed;inset:0;background:rgba(0,0,0,.55);backdrop-filter:blur(2px);display:none;z-index:9999;}',
    '#codingHelpMask.show{display:flex;align-items:center;justify-content:center;}',
    '#codingHelpModal{width:min(680px,92vw);max-height:86vh;overflow-y:auto;background:var(--panel,#16161e);border:1px solid var(--border,rgba(255,255,255,.1));border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.6);color:var(--text,#e7e7ef);}',
    '#codingHelpModal .hp-head{position:sticky;top:0;background:var(--panel,#16161e);display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--border,rgba(255,255,255,.1));}',
    '#codingHelpModal .hp-head h2{margin:0;font-size:16px;font-weight:700;}',
    '#codingHelpModal .hp-close{background:none;border:none;color:var(--muted,#9a9aab);font-size:22px;line-height:1;cursor:pointer;padding:0 4px;}',
    '#codingHelpModal .hp-close:hover{color:var(--text,#e7e7ef);}',
    '#codingHelpModal .hp-body{padding:18px 22px 26px;font-size:13.5px;line-height:1.75;}',
    '#codingHelpModal h3{font-size:14px;font-weight:700;margin:22px 0 8px;color:var(--ac,#7d6cff);}',
    '#codingHelpModal h3:first-child{margin-top:0;}',
    '#codingHelpModal p{margin:6px 0;color:#d3d3de;}',
    '#codingHelpModal ol,#codingHelpModal ul{margin:6px 0;padding-left:22px;}',
    '#codingHelpModal li{margin:5px 0;}',
    '#codingHelpModal code{background:var(--ac-soft,rgba(125,108,255,.16));border:1px solid var(--border,rgba(255,255,255,.1));border-radius:5px;padding:1px 6px;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;color:var(--text,#e7e7ef);}',
    '#codingHelpModal .hp-flow{display:flex;flex-wrap:wrap;align-items:center;gap:6px;background:var(--panel2,#1d1d27);border:1px solid var(--border,rgba(255,255,255,.1));border-radius:10px;padding:12px 14px;margin:10px 0;}',
    '#codingHelpModal .hp-chip{background:var(--ac-soft,rgba(125,108,255,.16));border:1px solid rgba(125,108,255,.4);border-radius:7px;padding:4px 10px;font-size:12.5px;}',
    '#codingHelpModal .hp-arrow{color:var(--ac,#7d6cff);font-weight:700;}',
    '#codingHelpModal .hp-node{border:1px solid var(--border,rgba(255,255,255,.1));border-radius:9px;padding:9px 12px;margin:7px 0;background:var(--panel2,#1d1d27);}',
    '#codingHelpModal .hp-node b{color:var(--text,#e7e7ef);}',
    '#codingHelpModal .hp-node span{color:var(--muted,#9a9aab);font-size:12.5px;}',
    '#codingHelpModal .hp-tip{font-size:12.5px;color:var(--muted,#9a9aab);background:var(--ac-soft,rgba(125,108,255,.10));border-radius:9px;padding:10px 12px;margin-top:12px;line-height:1.7;}',
    '#codingHelpBtn{display:inline-flex;align-items:center;gap:6px;}'
  ].join('');
  var st = document.createElement('style');
  st.id = 'codingHelpStyles';
  st.textContent = css;
  document.head.appendChild(st);

  // ── Modal DOM ──
  var SLOT = '{' + '{in}' + '}';
  var html = [
    '<div id="codingHelpModal" role="dialog" aria-modal="true" aria-label="代码台使用指南">',
      '<div class="hp-head"><h2>代码台 · 使用指南</h2><button class="hp-close" id="codingHelpClose" aria-label="关闭">×</button></div>',
      '<div class="hp-body">',

        '<h3>这是什么</h3>',
        '<p>把「输入 → 处理 → AI → 输出」像搭积木一样<b>连成一条流水线</b>。你不用写完整程序,拖几个方块、连上线,点运行,它就按顺序自动跑完。</p>',

        '<h3>三步上手</h3>',
        '<ol>',
          '<li><b>加节点</b>:点左侧任意节点,它会出现在中间画布上。</li>',
          '<li><b>连线</b>:按住一个节点<b>右侧的小圆点</b>,拖到下一个节点<b>左侧的小圆点</b>松手 —— 上游的结果就会流给下游。</li>',
          '<li><b>运行</b>:点右上角紫色「运行」,结果显示在底部<b>输出台</b>。每个节点下方也会显示它这一步的产出。</li>',
        '</ol>',

        '<h3>照着搭一个(最小例子)</h3>',
        '<div class="hp-flow"><span class="hp-chip">文本输入</span><span class="hp-arrow">→</span><span class="hp-chip">AI 生成</span><span class="hp-arrow">→</span><span class="hp-chip">输出</span></div>',
        '<p>在「文本输入」里写一句话(例如<code>帮我把这段话改得更礼貌:晚点再说</code>),连到「AI 生成」,再连到「输出」,点运行即可。想加风格约束,就在「AI 生成」的<b>系统提示</b>里写。</p>',

        '<h3>节点速查</h3>',
        '<p style="color:var(--muted,#9a9aab);font-size:12.5px;margin-top:0;">酒馆 · AI 工具</p>',
        '<div class="hp-node"><b>文本输入</b> <span>— 手填一段文字,作为流程起点。</span></div>',
        '<div class="hp-node"><b>模板拼接</b> <span>— 用 <code>' + SLOT + '</code> 占位,把上游文本嵌进你写的模板里。</span></div>',
        '<div class="hp-node"><b>AI 生成</b> <span>— 把输入发给模型产出文本,可选系统提示和模型。</span></div>',
        '<div class="hp-node"><b>抽取角色卡</b> <span>— 让模型把上游文本整理成角色卡 JSON。</span></div>',
        '<div class="hp-node"><b>输出</b> <span>— 终点,把结果收集到输出台。</span></div>',
        '<p style="color:var(--muted,#9a9aab);font-size:12.5px;margin:14px 0 0;">代码 · 工具</p>',
        '<div class="hp-node"><b>JS 变换</b> <span>— 写一段 JS 处理数据:<code>input</code> 是上游文本,<code>return</code> 的值就是输出。例:<code>return input.trim().toUpperCase();</code></span></div>',
        '<div class="hp-node"><b>正则提取/替换</b> <span>— 填替换文本=替换;留空=把所有匹配抠出来(每行一个)。</span></div>',
        '<div class="hp-node"><b>HTTP 请求</b> <span>— GET 一个网址取回文本(受浏览器跨域 CORS 限制,不是所有站都能拿)。</span></div>',
        '<div class="hp-node"><b>代码生成</b> <span>— 选语言,让 AI 按需求只吐代码本体。</span></div>',
        '<p style="color:var(--muted,#9a9aab);font-size:12.5px;margin:14px 0 0;">洪都 · GIS(占位)</p>',
        '<div class="hp-node"><b>GeoJSON 输入 / 缓冲区 / 质心</b> <span>— 地理分析演示节点,目前是占位(待接 Turf.js),先了解即可。</span></div>',

        '<h3>小贴士</h3>',
        '<div class="hp-tip">',
          '· 画布会<b>自动保存</b>到本地,也能点「保存」手动存;「清空」会清掉整张画布(不可撤销)。<br>',
          '· 一个节点可以连给多个下游;有环(首尾相连)会报错。<br>',
          '· AI 类节点用的是酒馆同一套免费模型,出错多半是模型/网络问题,看输出台的红色提示。<br>',
          '· 想中途停下,点「停止」。',
        '</div>',

      '</div>',
    '</div>'
  ].join('');

  var mask = document.createElement('div');
  mask.id = 'codingHelpMask';
  mask.innerHTML = html;
  document.body.appendChild(mask);

  function open() { mask.classList.add('show'); }
  function close() { mask.classList.remove('show'); }

  mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
  document.getElementById('codingHelpClose').addEventListener('click', close);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

  // ── 顶栏注入「帮助」按钮(放在「返回酒馆」前) ──
  function injectBtn() {
    var bar = document.querySelector('.topbar');
    if (!bar || document.getElementById('codingHelpBtn')) return;
    var btn = document.createElement('button');
    btn.className = 'btn'; btn.type = 'button'; btn.id = 'codingHelpBtn';
    btn.title = '使用指南';
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.3 2.1-2.3 3.6"/><path d="M12 17.2h.01"/></svg>帮助';
    btn.addEventListener('click', open);
    var link = bar.querySelector('.top-link');
    if (link) bar.insertBefore(btn, link); else bar.appendChild(btn);
  }
  injectBtn();

  window.__codingHelp = { open: open, close: close };
})();