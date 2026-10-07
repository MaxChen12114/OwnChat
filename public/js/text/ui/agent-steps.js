// public/js/text/ui/agent-steps.js — Agent 工作流面板(仅 Agent 模式生效)· 2026-09-14
//
// 形态对齐 ZCode:一轮回复 = **一个**可折叠面板,内部是一条连续时间线:
//   第 1 轮 ─ 思考 ─ (前置话) ─ 工具卡片 ─ 工具卡片
//   第 2 轮 ─ 思考 ─ (前置话) ─ 工具卡片
//   …
// 跑完整体收起成一行摘要(✓ 已完成 · N 步 · 工具名 · 耗时),正文回答在面板下面。
//
// 关键点(都是踩过的坑):
//   · 思考**不是独立的顶部块**,而是切分进它所属于的那一轮(用户反馈"zcode 没有独立的思考")——
//     模型在第 N 轮想什么就显示在第 N 轮里,与紧随其后的工具调用相互衔接。
//   · 一个回合只出**一个**面板:多轮合并进同一面板,而不是每轮一个面板。
//   · 思考/前置话/工具结果都只进面板,绝不进正文气泡(正文只放最终回答)。
//
// 两种用法共用同一套 DOM:renderTurn(历史还原,默认收起) / mountLive(实时,跑完自动收起)。
(function () {
  "use strict";
  if (window.__agentSteps) return;

  var STYLE_ID = "agentStepsStyles";
  var CSS_TEXT = `
.ags-wrap{display:flex;flex-direction:column;gap:6px;max-width:100%;margin:0 0 8px;}
.ags-panel{border:1px solid var(--border,rgba(127,127,127,.22));border-radius:12px;background:var(--ag-hover,rgba(127,127,127,.05));overflow:hidden;}
.ags-hd{display:flex;align-items:center;gap:8px;padding:8px 11px;cursor:pointer;user-select:none;font-size:12.5px;}
.ags-hd:hover{background:var(--ag-hover,rgba(127,127,127,.09));}
.ags-hico{flex:none;display:inline-flex;width:14px;height:14px;align-items:center;justify-content:center;}
.ags-hico svg{width:14px;height:14px;}
.ags-panel[data-state="run"] .ags-hico{color:#7fb3d5;animation:agsSpin 1.1s linear infinite;}
.ags-panel[data-state="done"] .ags-hico{color:#5ec98a;}
.ags-panel[data-state="err"] .ags-hico{color:#e8607d;}
.ags-htx{flex:none;font-weight:600;color:inherit;}
.ags-hnames{flex:1;min-width:0;color:var(--muted,#9a9a9a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;opacity:.9;}
.ags-hms{flex:none;color:var(--muted,#9a9a9a);font-size:11px;font-variant-numeric:tabular-nums;opacity:.9;}
.ags-hchev{flex:none;display:inline-flex;align-items:center;color:var(--muted,#9a9a9a);transition:transform .18s ease;}
.ags-hchev svg{width:12px;height:12px;display:block;}
.ags-panel.open .ags-hchev{transform:rotate(90deg);}
.ags-bd{display:none;padding:2px 11px 10px;border-top:1px solid var(--border,rgba(127,127,127,.16));}
.ags-panel.open .ags-bd{display:block;}
/* 一轮 = 一个包裹块:轮次标题 + 该轮思考 + 前置话 + 工具行,顺序即时间顺序 */
.ags-rw{padding:5px 0 2px;}
.ags-rw + .ags-rw{border-top:1px dashed var(--border,rgba(127,127,127,.16));margin-top:3px;}
.ags-round{font-size:10.5px;font-weight:600;letter-spacing:.06em;color:var(--muted,#9a9a9a);opacity:.7;text-transform:uppercase;}
/* 思考:可折叠(标题行点击展开/收起)。运行中默认展开看进度,跑完由 setPanelDone 收起 */
.ags-think{padding:4px 0 2px;}
.ags-think-hd{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;padding:3px 2px;border-radius:6px;}
.ags-think-hd:hover{background:var(--ag-hover,rgba(127,127,127,.09));}
.ags-think-lb{font-size:10.5px;font-weight:600;letter-spacing:.06em;color:var(--muted,#9a9a9a);opacity:.7;text-transform:uppercase;}
.ags-think-hd .ags-caret{flex:none;display:inline-flex;align-items:center;color:var(--muted,#9a9a9a);transition:transform .15s;}
.ags-think-hd .ags-caret svg{width:11px;height:11px;display:block;}
.ags-think.open .ags-think-hd .ags-caret{transform:rotate(90deg);}
.ags-think-tx{display:none;font-size:12.5px;line-height:1.62;color:inherit;opacity:.78;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto;padding:3px 2px 0;border-left:2px solid var(--border,rgba(127,127,127,.18));margin:2px 0 2px 3px;padding-left:9px;}
.ags-think.open .ags-think-tx{display:block;}
.ags-preamble{font-size:12.5px;line-height:1.62;color:inherit;opacity:.88;padding:5px 0 3px;white-space:pre-wrap;}
/* 工具调用 = 平铺的一行(不再是个带边框的小盒子 —— 那是"气泡里套气泡"的来源);悬停才出底色 */
.ags-step{border-radius:7px;font-size:12.5px;margin:2px 0;}
.ags-head{display:flex;align-items:center;gap:7px;padding:5px 6px;cursor:pointer;user-select:none;border-radius:7px;}
.ags-head:hover{background:var(--ag-surface,rgba(127,127,127,.10));}
.ags-ico{flex:none;display:inline-flex;width:13px;height:13px;align-items:center;justify-content:center;opacity:.85;}
.ags-ico svg{width:13px;height:13px;}
.ags-step[data-state="run"] .ags-ico{color:#7fb3d5;animation:agsSpin 1.1s linear infinite;}
.ags-step[data-state="done"] .ags-ico{color:#5ec98a;}
.ags-step[data-state="err"] .ags-ico{color:#e8607d;}
.ags-name{flex:none;font-weight:600;font-family:ui-monospace,Menlo,Consolas,monospace;}
.ags-brief{flex:1;min-width:0;color:var(--muted,#9a9a9a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Menlo,Consolas,monospace;}
.ags-meta{flex:none;color:var(--muted,#9a9a9a);font-size:11px;font-variant-numeric:tabular-nums;opacity:.9;}
.ags-caret{flex:none;display:inline-flex;align-items:center;color:var(--muted,#9a9a9a);transition:transform .15s;}
.ags-caret svg{width:11px;height:11px;display:block;}
.ags-step.open .ags-caret{transform:rotate(90deg);}
/* 展开的明细:左侧一道细线 + 缩进,仍然是"平的",不再套一层盒子 */
.ags-body{display:none;padding:2px 0 6px 22px;}
.ags-step.open .ags-body{display:block;}
.ags-label{font-size:10.5px;font-weight:600;letter-spacing:.06em;color:var(--muted,#9a9a9a);opacity:.7;margin:7px 0 4px;text-transform:uppercase;}
.ags-body pre{margin:0;padding:8px 10px;border-radius:8px;background:var(--ag-surface,rgba(127,127,127,.10));max-height:260px;overflow:auto;white-space:pre-wrap;word-break:break-word;font:11.5px/1.6 ui-monospace,Menlo,Consolas,monospace;color:inherit;border-left:2px solid var(--border,rgba(127,127,127,.18));}
.ags-body pre code{background:none;border:0;padding:0;font:inherit;}
.ags-errtx{color:#e8607d;}
@keyframes agsSpin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.ags-panel[data-state="run"] .ags-ico,.ags-step[data-state="run"] .ags-ico{animation:none;}.ags-hchev,.ags-caret{transition:none;}}
`;
  function ensureCss() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS_TEXT;
    (document.head || document.documentElement).appendChild(s);
  }

  var ICON_SPIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9"/></svg>';
  var ICON_DONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
  var ICON_ERR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';
  // 折叠箭头用线性 SVG —— 别用 "▶"(U+25B6,部分平台按 emoji 呈现)这类裸文本符号
  var ICON_CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';

  var BRIEF_KEYS = ["path", "file", "file_path", "filename", "url", "query", "q", "keyword", "name", "pattern", "id", "topic", "text", "content"];
  function briefArgs(name, args) {
    if (!args || typeof args !== "object") return "";
    for (var i = 0; i < BRIEF_KEYS.length; i++) {
      var v = args[BRIEF_KEYS[i]];
      if (typeof v === "string" && v) return v.length > 90 ? v.slice(0, 90) + "…" : v;
    }
    var rest = Object.keys(args)
      .filter(function (k) { return BRIEF_KEYS.indexOf(k) < 0 && args[k] != null && args[k] !== ""; })
      .map(function (k) { return k + "=" + String(args[k]).slice(0, 40); });
    return rest.length ? rest.join(" ") : "";
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtResult(text) {
    var t = String(text == null ? "" : text);
    try {
      var j = JSON.parse(t);
      var pretty = JSON.stringify(j, null, 2);
      if (window.hljs && pretty.length < 40000) {
        try { return window.hljs.highlight(pretty, { language: "json", ignoreIllegals: true }).value; } catch (e) {}
      }
      return esc(pretty);
    } catch (e) {}
    return esc(t);
  }

  // ── 一张工具卡片 ──
  function makeStepEl(name) {
    var el = document.createElement("div");
    el.className = "ags-step";
    el.dataset.state = "run";
    el.dataset.tool = name || "";
    el.innerHTML =
      '<div class="ags-head">' +
        '<span class="ags-ico">' + ICON_SPIN + "</span>" +
        '<span class="ags-name">' + esc(name || "tool") + "</span>" +
        '<span class="ags-brief"></span>' +
        '<span class="ags-meta"></span>' +
        '<span class="ags-caret">' + ICON_CHEV + "</span>" +
      "</div>" +
      '<div class="ags-body"></div>';
    el.querySelector(".ags-head").addEventListener("click", function () { el.classList.toggle("open"); });
    return el;
  }
  function fillStep(el, info) {
    if (!el) return;
    var brief = el.querySelector(".ags-brief");
    var meta = el.querySelector(".ags-meta");
    var body = el.querySelector(".ags-body");
    var ico = el.querySelector(".ags-ico");
    var b = briefArgs(info.name, info.args);
    if (b) brief.textContent = b;
    if (info.ms != null) meta.textContent = info.ms + "ms";
    var st = (info.denied || info.ok === false) ? "err" : (info.ok === true ? "done" : "run");
    el.dataset.state = st;
    ico.innerHTML = st === "done" ? ICON_DONE : (st === "err" ? ICON_ERR : ICON_SPIN);
    if (st === "err") el.classList.add("open"); // 失败默认展开,别让用户去猜
    var html = "";
    if (info.args) html += '<div class="ags-label">参数</div><pre><code>' + esc(JSON.stringify(info.args, null, 2)) + "</code></pre>";
    if (info.error) html += '<div class="ags-label">错误</div><pre><code class="ags-errtx">' + esc(info.error) + "</code></pre>";
    else if (info.result != null && info.result !== "") html += '<div class="ags-label">结果</div><pre><code>' + fmtResult(info.result) + "</code></pre>";
    body.innerHTML = html;
  }

  // ── 轮次包裹块:标题 + 该轮思考 + 前置话 + 工具卡片 ──
  function makeRoundEl(n) {
    var rw = document.createElement("div");
    rw.className = "ags-rw";
    rw.dataset.round = String(n);
    var lb = document.createElement("div");
    lb.className = "ags-round";
    lb.textContent = "第 " + n + " 轮";
    rw.appendChild(lb);
    return rw;
  }
  // 思考块:标题行点击展开/收起(运行中默认展开看进度,跑完由 setPanelDone 收起)
  function thinkBlock(text) {
    var t = document.createElement("div");
    t.className = "ags-think open";
    var hd = document.createElement("div");
    hd.className = "ags-think-hd";
    var lb = document.createElement("span");
    lb.className = "ags-think-lb";
    lb.textContent = "思考";
    var chev = document.createElement("span");
    chev.className = "ags-caret";
    chev.innerHTML = ICON_CHEV;
    hd.appendChild(lb); hd.appendChild(chev);
    var tx = document.createElement("div");
    tx.className = "ags-think-tx";
    tx.textContent = String(text == null ? "" : text);
    hd.addEventListener("click", function () { t.classList.toggle("open"); });
    t.appendChild(hd); t.appendChild(tx);
    return t;
  }
  function preambleEl(text) {
    var p = document.createElement("div");
    p.className = "ags-preamble";
    p.textContent = String(text == null ? "" : text);
    return p;
  }
  // 把一段文本写进某轮的思考块(实时流式刷新时反复调用)
  function setRoundThinking(rw, text) {
    var val = String(text == null ? "" : text).trim();
    var cur = rw.querySelector(".ags-think");
    if (!val) { if (cur) cur.remove(); return; }
    if (!cur) { cur = thinkBlock(val); rw.insertBefore(cur, rw.querySelector(".ags-step")); }
    else cur.querySelector(".ags-think-tx").textContent = val;
  }

  // ── 面板壳 ──
  function makePanel() {
    var p = document.createElement("div");
    p.className = "ags-panel open";
    p.dataset.state = "run";
    p.innerHTML =
      '<div class="ags-hd">' +
        '<span class="ags-hico">' + ICON_SPIN + "</span>" +
        '<span class="ags-htx">运行中…</span>' +
        '<span class="ags-hnames"></span>' +
        '<span class="ags-hms"></span>' +
        '<span class="ags-hchev">' + ICON_CHEV + "</span>" +
      "</div>" +
      '<div class="ags-bd"></div>';
    p.querySelector(".ags-hd").addEventListener("click", function () { p.classList.toggle("open"); });
    return p;
  }
  function ensureWrap(anchor) {
    if (!anchor) return null;
    var host = anchor.parentNode || anchor;
    var wrap = host.querySelector(":scope > .ags-wrap");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.className = "ags-wrap";
      if (anchor.parentNode === host) host.insertBefore(wrap, anchor); // 过程块摆在气泡上方
      else host.appendChild(wrap);
    }
    return wrap;
  }
  function setPanelDone(p, ms) {
    if (!p) return;
    var steps = p.querySelectorAll(".ags-step");
    var names = [], err = 0;
    Array.prototype.forEach.call(steps, function (el) {
      var n = el.querySelector(".ags-name").textContent;
      if (names.indexOf(n) < 0) names.push(n);
      if (el.dataset.state === "err") err++;
    });
    var hasSteps = steps.length > 0;
    p.dataset.state = err ? "err" : "done";
    p.querySelector(".ags-hico").innerHTML = err ? ICON_ERR : ICON_DONE;
    // 没有工具调用时这不是"工作流"而是纯思考,别显示"已完成 · 0 步"
    p.querySelector(".ags-htx").textContent = hasSteps
      ? ((err ? "已结束" : "已完成") + " · " + steps.length + " 步")
      : "思考过程";
    p.querySelector(".ags-hnames").textContent = names.slice(0, 4).join("、") + (names.length > 4 ? " 等" : "");
    if (ms != null) p.querySelector(".ags-hms").textContent = ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : ms + "ms";
    // 跑完时思考也一并收起 —— 长思考展开着会淹没工具行
    Array.prototype.forEach.call(p.querySelectorAll(".ags-think.open"), function (t) { t.classList.remove("open"); });
    p.classList.remove("open"); // ★ 跑完自动收起 —— 只留一行摘要,正文回答在下面
  }

  // ── 历史还原 / 事后渲染(一个回合一个面板,默认收起) ──
  // turn = { rounds: [ { thinking, preamble, calls:[{name,args,ok,ms,error,result,denied}] } ] }
  // 也兼容单个 round 对象(没有 rounds 字段时当作一轮)
  function renderTurn(anchor, turn) {
    if (!anchor || !turn) return;
    var rounds = Array.isArray(turn.rounds) ? turn.rounds : [turn];
    var hasAny = rounds.some(function (r) { return r && ((r.calls || []).length || r.thinking || r.preamble); });
    if (!hasAny) return;
    ensureCss();
    var wrap = ensureWrap(anchor);
    if (!wrap) return;
    var p = makePanel();
    var bd = p.querySelector(".ags-bd");
    var totalMs = 0, hasErr = false;
    rounds.forEach(function (r, i) {
      if (!r) return;
      var rw = makeRoundEl(i + 1);
      if (r.thinking) rw.appendChild(thinkBlock(r.thinking));
      if (r.preamble) rw.appendChild(preambleEl(r.preamble));
      (r.calls || []).forEach(function (c) {
        var el = makeStepEl(c.name);
        fillStep(el, c);
        rw.appendChild(el);
        if (c.ms) totalMs += c.ms;
        if (c.denied || c.ok === false) hasErr = true;
      });
      bd.appendChild(rw);
    });
    setPanelDone(p, totalMs || null);
    if (hasErr) p.classList.add("open"); // 有失败时保持展开,让用户一眼看到哪一步挂了
    wrap.appendChild(p);
  }

  // ── 实时:控制器 ──
  function mountLive(anchor) {
    ensureCss();
    var wrap = ensureWrap(anchor);
    var panel = null, body = null, curRound = null, curStep = null, roundNo = 0;
    var started = Date.now();
    function ensurePanel() {
      if (panel) return panel;
      panel = makePanel();
      body = panel.querySelector(".ags-bd");
      wrap.appendChild(panel);
      return panel;
    }
    function ensureRound() {
      if (curRound) return curRound;
      ensurePanel();
      roundNo++;
      curRound = makeRoundEl(roundNo);
      body.appendChild(curRound);
      return curRound;
    }
    return {
      element: wrap,
      // 新一轮开始(内核在每次模型调用前发 model_call)
      model_call: function () { curRound = null; curStep = null; ensureRound(); },
      // 该轮的思考(流式刷新时反复调用 —— 思考切分到所属轮次,不再是独立顶部块)
      roundThinking: function (text) { setRoundThinking(ensureRound(), text); },
      // 该轮里"边说话边调工具"的前置话
      preamble: function (text) {
        if (!text || !String(text).trim()) return;
        ensureRound().appendChild(preambleEl(String(text).trim()));
      },
      tool_run: function (name, args) {
        var rw = ensureRound();
        curStep = makeStepEl(name);
        fillStep(curStep, { name: name, args: args });
        rw.appendChild(curStep);
      },
      tool_done: function (name, info) {
        var rw = curRound || ensureRound();
        if (!curStep || curStep.dataset.tool !== name) curStep = rw.querySelector('.ags-step[data-state="run"]');
        fillStep(curStep, Object.assign({ name: name }, info || {}));
        curStep = null;
      },
      tool_error: function (name, info) {
        var rw = curRound || ensureRound();
        if (!curStep || curStep.dataset.tool !== name) curStep = rw.querySelector('.ags-step[data-state="run"]');
        fillStep(curStep, Object.assign({ name: name, ok: false }, info || {}));
        curStep = null;
      },
      tool_denied: function (name, args) {
        var el = makeStepEl(name);
        fillStep(el, { name: name, args: args, ok: false, denied: true, error: "你拒绝了这次操作" });
        ensureRound().appendChild(el);
      },
      // 整轮结束:收起过程块 → 只留一行摘要
      finish: function () { if (panel) setPanelDone(panel, Date.now() - started); },
      hasContent: function () { return !!(panel && panel.querySelectorAll(".ags-step").length); },
    };
  }

  window.__agentSteps = { renderTurn: renderTurn, mountLive: mountLive, briefArgs: briefArgs };
})();
