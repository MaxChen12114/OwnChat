// public/shared/council-tools.js — agent「三方会商」工具对（批 N · 依附 8798 geo 侧服务；2026-10-16 定位：不回移，保留为 dev 工具）
// ─────────────────────────────────────────────────────────────────────
// 模块自带 defineTools（同 source-tools.js 模式），app.js 在 agent 注册表构建处挂载。
// 两件套（都打 127.0.0.1:8798 的本地会商服务 geo-agent/tools/council_server.py）：
//   council_read   会商线程清单（含 geo 席位未读）/ 读某帖消息流
//   council_post   发帖（席位固定 geo = 应用内 agent）
// 席位：zcode（平台侧会话）/ dsh（工作台 harness）/ geo（应用内 agent）——本模块就是 geo 席位的腿。
// kind 枚举（与设计草案一致）：招呼 | 摸底 | 感受 | 意见 | 提案 | 取证 | 裁决
// 配置：默认 http://127.0.0.1:8798；可用 localStorage["cfw_council_url_v1"] 覆盖。
// 安全：8798 只绑 127.0.0.1、永不进隧道；正文疑似含密钥（nvapi-/sk-/AKIA）会被服务端拒收。
// 回移口径（2026-10-16 · 回移清单·半通用行）：席位与 8798 服务是本机 geo 生态件——回移后无服务时工具清晰报错即可，
// 端点可经 localStorage["cfw_council_url_v1"] 覆盖；并入主线无需改代码（或按"保留为 dev 工具"处置）。
// ─────────────────────────────────────────────────────────────────────
(function () {
  'use strict';
  if (window.__councilTools) return;

  var LS_KEY = 'cfw_council_url_v1';
  function base() {
    try { var v = String(localStorage.getItem(LS_KEY) || '').trim(); if (v) return v.replace(/\/+$/, ''); } catch (e) {}
    return 'http://127.0.0.1:8798';
  }
  function down(extra) {
    return '会商服务不可达（8798）。\n' +
      '启动："GEO-Agent 启动.bat" 第 5 步会自动起；或手动：python geo-agent\\tools\\council_server.py 8798\n' +
      '（地址可用 localStorage["' + LS_KEY + '"] 覆盖：' + base() + '）' +
      (extra ? '\n原始错误：' + extra : '');
  }
  async function api(method, path, params, body, timeoutMs) {
    var q = [];
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v === undefined || v === null || v === '') return;
      q.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    });
    var u = base() + path + (q.length ? '?' + q.join('&') : '');
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, timeoutMs || 20000) : null;
    var r;
    try {
      r = await fetch(u, {
        method: method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl ? ctl.signal : undefined,
      });
    } catch (e) {
      var m = String((e && e.message) || e);
      if (e && e.name === 'AbortError') throw new Error(down('请求超时'));
      throw new Error(down(m));
    } finally { if (timer) clearTimeout(timer); }
    var j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    if (!j || j.ok !== true) throw new Error('会商服务返回错误：' + ((j && j.error) || ('HTTP ' + r.status)));
    return j;
  }

  function fmtMsg(m) {
    var out = ['#' + m.idx + ' [' + m.kind + '] ' + m.from + ' · ' + (m.ts || '')];
    out.push(String(m.body || ''));
    if (m.refs && m.refs.length) out.push('↳ refs: ' + m.refs.join(' | '));
    if (m.reply_to) out.push('↳ 回复 ' + m.reply_to);
    return out.join('\n');
  }

  async function defineTools(registry) {
    if (!registry || typeof registry.define !== 'function') return;

    registry.define({
      name: 'council_read',
      description:
        '看「三方会商」留言板（ZCode 平台侧 / DSH 工作台 / 你 geo 三方共用；本机 8798）。' +
        '不传 thread：列线程清单 + 你的未读数（先看这个，知道自己错过了什么）。' +
        '传 thread：读该线程消息流（带序号，可 after 续读），读完自动把该线程标记为已读（peek=true 则只看不标）。' +
        '发言用 council_post。讨论纪律（022 定的）：先摸底再发言；断言要挂 refs（台账行/源码行/artifacts）。',
      parameters: {
        type: 'object',
        properties: {
          thread: { type: 'string', description: '线程名（可选），如 "认识"；不传=只看清单与未读' },
          after: { type: 'number', description: '可选：只取该序号之后的新帖（用于增量续读）' },
          peek: { type: 'boolean', description: '可选：true=读完不标记已读' },
        },
        additionalProperties: false,
      },
      run: async (args) => {
        try {
          var thread = String((args && args.thread) || '').trim();
          if (!thread) {
            const t = await api('GET', '/threads', {}, undefined, 15000);
            let unread = {};
            try { unread = (await api('GET', '/unread', { member: 'geo' }, undefined, 10000)).unread || {}; } catch (e) {}
            const list = t.threads || [];
            if (!list.length) return '会商还没有任何线程。可以 council_post(thread="认识", kind="招呼", body="…") 开个头。';
            const out = ['会商线程（共 ' + list.length + ' 个）：'];
            list.forEach((x) => {
              const u = unread[x.name] || 0;
              out.push('· ' + x.name + '（' + x.count + ' 帖' + (u ? '；你未读 ' + u : '') + '；最后 ' + (x.lastFrom || '?') + ' ' + String(x.lastTs || '').slice(5, 16).replace('T', ' ') + '）：' + (x.lastPreview || '').slice(0, 60));
            });
            out.push('读全文：council_read(thread="线程名")。');
            return out.join('\n');
          }
          const after = Math.max(0, parseInt((args && args.after) || 0, 10) || 0);
          const r = await api('GET', '/read', { thread: thread, after: after }, undefined, 20000);
          const msgs = r.messages || [];
          if (!msgs.length) return '线程「' + thread + '」没有新帖（共 ' + r.total + ' 帖，after=' + after + '）。';
          // 2026-11-09：把这条线程推进「多智能体讨论区」—— 会商与会议在同一个地方看，可切场次。
          try {
            if (window.__panel && typeof window.__panel.call === 'function' && window.__panel.state && window.__panel.state().hasContent) {
              window.__panel.call('importCouncil', [{
                thread: thread,
                title: '三方会商 · ' + thread,
                messages: msgs.map(function (m) { return { who: m.from, kind: m.kind, text: m.body, refs: m.refs }; })
              }], 4000).catch(function () {});
            }
          } catch (e) {}
          let text = '线程「' + thread + '」：本次 ' + msgs.length + ' 帖（总 ' + r.total + '，after=' + after + '）\n\n' +
            msgs.map(fmtMsg).join('\n---\n');
          if (text.length > 6000) text = text.slice(0, 6000) + '\n…（已截断，用 after 参数续读）';
          const lastIdx = msgs[msgs.length - 1].idx;
          if (!(args && args.peek)) {
            try { await api('POST', '/seen', {}, { member: 'geo', thread: thread, upTo: lastIdx }, 10000); } catch (e) {}
          }
          return text;
        } catch (e) { return String((e && e.message) || e); }
      },
    });

    registry.define({
      name: 'council_post',
      description:
        '往「三方会商」留言板发一帖（席位=geo，即你）。三方共用本机 8798，用户在演示台「会商」viewer 里实时围观。' +
        'kind 枚举：招呼（首次见面）/ 摸底 / 感受（主观印象、置信度、顾虑）/ 意见 / 提案（须答：是什么/为什么卡/怎么验收）/ 取证（须挂 refs）/ 裁决。' +
        '纪律：主观进"感受"，可引用进"意见"，断言必须挂 refs（如 "geo-agent/改造记录/022-…md#L15"）或标"无据存疑"；正文里不要出现任何密钥。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', description: '帖子类型：招呼|摸底|感受|意见|提案|取证|裁决' },
          body: { type: 'string', description: '正文（≤8000 字）' },
          thread: { type: 'string', description: '线程名；不传=发到最近活跃的线程' },
          refs: { type: 'array', items: { type: 'string' }, description: '可选：可核验的引用（台账行号/源码文件:行/artifacts 路径）' },
          reply_to: { type: 'string', description: '可选：所回帖的 id（如 "认识#1"）' },
        },
        required: ['kind', 'body'],
        additionalProperties: false,
      },
      run: async (args) => {
        try {
          var thread = String((args && args.thread) || '').trim();
          if (!thread) {
            const t = await api('GET', '/threads', {}, undefined, 15000);
            const list = t.threads || [];
            if (!list.length) return '还没有任何线程——请指定 thread（比如 "认识"）来开第一个。';
            thread = list[0].name;
          }
          const r = await api('POST', '/post', {}, {
            from: 'geo',
            thread: thread,
            kind: String((args && args.kind) || ''),
            body: String((args && args.body) || ''),
            refs: (args && args.refs) || [],
            reply_to: (args && args.reply_to) || '',
          }, 15000);
          const m = r.message || {};
          return '已发帖：线程「' + thread + '」#' + m.idx + '（' + m.kind + '，' + String(m.ts || '').slice(11, 16) + '）。正文前 80 字：' + String(m.body || '').slice(0, 80);
        } catch (e) { return String((e && e.message) || e); }
      },
    });
  }

  window.__councilTools = { defineTools: defineTools, __v: 1 };
})();
