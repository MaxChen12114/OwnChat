// public/shared/stage-tools.js — agent 的「内容画布」工具组（2026-11-09 · 面板 T3）
// ─────────────────────────────────────────────────────────────────────
// 三个工具，把右栏画布暴露给 agent：
//   stage_open   挂内容（url / html / text）
//   stage_close  清空画布
//   stage_view   切到活动/状态视图（agent 一般不用，只在"你先看过程"时使用）
//
// 设计纪律（写进描述里，因为描述就是行为）：
//   · 有现成页面（地图/回放/报告/产物）→ 用 url，不要手搓 html 重画。
//   · html 只用于"没有现成页面的一次性可视化"（图表/表格/流程图）。
//   · html 在隔离沙箱里跑（host-html 档），碰不到父页；不要试图读 parent/localStorage。
//
// 依赖：window.__panel（panel-host.js）。面板没起（手机端 / 未加载）时 defineTools 直接返回，
// 零占用——与 source-tools / io-tools 的"未启用即不注册"约定一致。
// ─────────────────────────────────────────────────────────────────────
(function () {
  'use strict';
  if (window.__stageTools) return;

  var MAX_HTML = 400000; // 单个 html 上限（约 400KB）；超过建议落成文件用 url 打开
  var MAX_RET = 8000;    // stage_call 返回值的字符上限（防止 agent 被一张 dataURL 灌爆上下文）

  function panel() {
    return (window.__panel && window.__panel.v === 1) ? window.__panel : null;
  }

  function brief(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  async function defineTools(registry) {
    if (!registry || typeof registry.define !== 'function') return;
    if (!panel()) return; // 画布没起 → 不注册（零占用）

    registry.define({
      name: 'stage_list',
      description:
        '列出右栏画布**能打开什么**：站内工具（沙盘地图等）+ 当前正在显示的内容。\n' +
        '规则：用户说"打开地图 / 看看沙盘 / 打开那个页面"时，**先调这个**，不要自己去搜源码、也不要手写 HTML 重画。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => {
        const p = panel();
        if (!p) return '内容画布未就绪。';
        const ts = (typeof p.tools === 'function') ? p.tools() : [];
        const st = p.state();
        const lines = [];
        if (ts.length) {
          lines.push('站内工具（用 stage_open({url}) 直接打开）：');
          ts.forEach((t) => {
            lines.push('· ' + (t.title || t.id) + ' → ' + (t.url || '（未配置，点了会给引导页）'));
          });
        } else {
          lines.push('站内没有注册任何工具。');
        }
        lines.push('当前画布：' + (st.hasContent ? ('有内容（' + (st.title || '未命名') + '），宽度 ' + st.width + 'px）') : '空'));
        lines.push('也可以用 stage_open({html}) 放一次性内容（图表/表格）。');
        return lines.join('\n');
      },
    });

    registry.define({
      name: 'stage_open',
      description:
        '把内容挂到右栏画布上，用户可以直接看到（可拖宽、可拉出独立窗口）。三种用法，按优先级选：\n' +
        '① {url} 打开一个现成网页——**站内已有**沙盘地图（/tools/sandbox/index.html）、以及 agent 之前挂过的页面。**优先用这个**。\n' +
        '② {html} 打开一段自包含 HTML——只用于"没有现成页面的一次性可视化"：图表、表格、流程图、小演示。\n' +
        '③ {text} 纯文本（日志、纯文本产物）。\n' +
        '纪律：\n' +
        '· 用户要"地图 / 沙盘"时先 stage_list 看有哪些站内工具，**不要搜源码、也不要手写 HTML 重画地图**。\n' +
        '· html 在隔离沙箱里执行（origin 为 null）：可以跑脚本、画 canvas，但**读不到父页**（parent/localStorage 会抛 SecurityError），不要把页面状态塞进 html 里传。\n' +
        '· 打开后画布保持收起状态（只在顶栏 ⊞ 上点一个小圆点），用户自己决定什么时候看。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要打开的网页地址（http/https/相对路径）' },
          html: { type: 'string', description: '自包含 HTML 片段（仅当没有现成页面时用）' },
          text: { type: 'string', description: '纯文本内容' },
          title: { type: 'string', description: '画布标题（简短，用于窗口标题与无障碍名）' },
          mode: {
            type: 'string',
            description: '安全档（一般不用传）：trusted=自家页 / host-html=隔离沙箱 / external=外链。不传时按内容自动推断（html→host-html，url→trusted）。',
          },
        },
        additionalProperties: false,
      },
      run: async (args) => {
        const p = panel();
        if (!p) return '内容画布未就绪（手机端不启用，或页面未加载 panel-host）。';
        args = args || {};
        const hasHtml = args.html != null && String(args.html) !== '';
        if (!args.url && !hasHtml && args.text == null) return '至少给 url / html / text 之一。';
        if (hasHtml && String(args.html).length > MAX_HTML) {
          return 'html 太大（' + String(args.html).length + ' 字符，上限 ' + MAX_HTML + '）。建议先落成文件，再用 url 打开。';
        }
        try {
          const r = p.open({
            url: args.url ? String(args.url) : undefined,
            html: hasHtml ? String(args.html) : undefined,
            text: args.text != null ? String(args.text) : undefined,
            title: String(args.title || ''),
            mode: args.mode ? String(args.mode) : undefined,
          });
          if (!r || !r.ok) return '打开失败：' + ((r && r.error) || '未知原因');
          const st = p.state();
          return '已挂到右栏画布：' + (args.title || brief(args.url || '内联内容', 60)) +
            '（安全档 ' + r.mode + '，宽 ' + st.width + 'px）。';
        } catch (e) {
          return '打开出错：' + String((e && e.message) || e);
        }
      },
    });

    registry.define({
      name: 'stage_close',
      description: '清空右栏画布（内容看完就收，别让它一直占着用户的屏幕）。画布本身保持展开状态，用户点顶栏按钮可收起整个面板。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => {
        const p = panel();
        if (!p) return '内容画布未就绪。';
        try { p.close(); return '画布已清空。'; }
        catch (e) { return '清空出错：' + String((e && e.message) || e); }
      },
    });

    registry.define({
      name: 'stage_view',
      description:
        '切换右栏画布的视图：canvas=内容画布（默认）/ activity=活动（多智能体交互时间线）/ status=状态（上下文、计费、系统）。' +
        '一般不需要调用——用户自己会点。只有一种情况用得上：你想让用户"先看过程"（activity）再回来看结果。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'canvas | activity | status' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      run: async (args) => {
        const p = panel();
        if (!p) return '内容画布未就绪。';
        const name = String((args && args.name) || '');
        if (['canvas', 'activity', 'status'].indexOf(name) === -1) return '未知视图：' + name + '（可选 canvas / activity / status）';
        try { p.view(name); return '已切到视图：' + name; }
        catch (e) { return '切换出错：' + String((e && e.message) || e); }
      },
    });

    // 2026-11-09：画布回调。stage_open 只能「打开」，打开之后页面就是只读的 ——
    // 沙盘能看不能改，agent 想自己划地盘、推战线、换数据都做不到。
    // 这条通道让画布页用 window.__stage 自己声明能力，agent 按名字调用。
    // 只认函数名，宿主不 eval 任何字符串。
    registry.define({
      name: 'stage_call',
      description:
        '调用右栏画布当前页面自己注册的函数（页面用 window.__stage = { 函数名: (参数) => 结果 } 声明），用来驱动它：改地图、推战线、换数据、重算。\n' +
        '什么时候用：用户要「让页面动起来 / 更新它 / 按你说的改」时。**只打开不驱动 = 页面停在初始那一帧。**\n' +
        '参数形状：args 是**按位置的参数列表**，等价于 fn(...args)。\n' +
        '  · 无参：省略 args 或写 []\n' +
        '  · 单参数且该参数是个数组：要再包一层，例 setOwners 传 args=[网格数组]\n' +
        '  · 例：{fn:"setOwner", args:[48,10,1]} → setOwner(48,10,1)\n' +
        '函数名不对会返回该页面实际可用的函数清单，照着清单再调一次即可。\n' +
        '沙盘（/tools/sandbox）注册的函数：state / setOwners / setOwner / applyDiff / setResources / editCell / setSeed / setSkin / toggleRun / terrainDataURL。\n' +
        '画布是空的时候先 stage_open 再调。',
      parameters: {
        type: 'object',
        properties: {
          fn: { type: 'string', description: '函数名（页面 window.__stage 的键）' },
          args: { description: '传给该函数的入参（任意 JSON）。不需要参数可省略。' },
          timeoutMs: { type: 'number', description: '超时毫秒（默认 15000，上限 120000）' },
        },
        required: ['fn'],
        additionalProperties: false,
      },
      run: async (args) => {
        const p = panel();
        if (!p) return '内容画布未就绪。';
        if (typeof p.call !== 'function') return '画布回调通道不可用（panel-host 版本太旧，需要 v>=20）。';
        const fn = String((args && args.fn) || '').trim();
        if (!fn) return '需要 fn（画布页注册的函数名）。';
        let out;
        try {
          out = await p.call(fn, args && ('args' in args ? args.args : undefined), args && args.timeoutMs);
        } catch (e) {
          return '调用失败：' + String((e && e.message) || e);
        }
        if (out === undefined) return '已执行 ' + fn + '（无返回值）。';
        let s;
        try { s = JSON.stringify(out); } catch (e) { s = String(out); }
        if (s == null) s = String(out);
        if (s.length > MAX_RET) {
          return fn + ' 返回了 ' + s.length + ' 字符，超过上限 ' + MAX_RET + '，已截断：\n' + s.slice(0, MAX_RET);
        }
        return fn + ' → ' + s;
      },
    });
  }

  window.__stageTools = { defineTools: defineTools, __v: 1 };
})();
