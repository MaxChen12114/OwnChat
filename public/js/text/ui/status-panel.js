// public/js/text/ui/status-panel.js — 「状态」面板(上下文容量 / 最近请求 / 系统状态)· 2026-09-14 UI第二轮
// 双挂载:桌面右栏第三 tab(#statusPanelDesktop)+ 手机底栏(#mobileTabPanel-status),共用一套渲染。
// 数据源全部只读复用既有能力:
//   __app.estimateTokens / getSessionMessages / getLastRequestStats(app.js UI第二轮新增导出)
//   __lorebook.getActiveEntries({text,cardId})(世界书真实匹配逻辑,输入=最近 6 条消息,与发送路径一致)
//   __skills.buildCatalogPrompt / __character.getActiveCard
//   __sync.getStatus / __cost.getCostStats
// 刷新策略(沿用 cost-widget 成熟模式):2s interval 仅面板可见时重算 + storage/focus/visibilitychange 即时刷。
// 估算口径说明:客户端只能看到 payload 各组成块,worker 侧系统底座/合规层不可见 —— 面板里如实标注。
(function(){
  "use strict";
  if (window.__statusPanel) return;

  const LS_CTX_WINDOW = "cfw_ctx_window_v1";
  const DEFAULT_CTX = 131072;
  const REFRESH_MS = 2000;
  const STYLE_ID = "statusPanelStyles";

  const CSS_TEXT = `
/* 4.83: .sp-host 不再自带 display:flex —— 注入样式表挂在 head 末尾,会以同特异性覆盖
   styles-2.css 的 .mobile-tab-panel{display:none},导致手机端状态面板未激活时也参与文档流,
   聊天区下滑到底后经滚动链把面板带进视口(用户报告的"下滑直接出现状态面板")。
   display 改为按宿主显式声明: 桌面宿主常显;手机宿主只在 .active 时 flex。 */
.sp-host{padding:10px 12px calc(12px + env(safe-area-inset-bottom,0px));box-sizing:border-box;font-family:var(--chat-font-family,ui-sans-serif,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif);}
#statusPanelDesktop{display:flex;flex-direction:column;gap:10px;}
.mobile-tab-panel.sp-host.active{display:flex;flex-direction:column;gap:10px;}
.sp-card{background:var(--bubble-ai,#141414);border:1px solid var(--border,#222);border-radius:14px;padding:12px 14px;box-sizing:border-box;}
.sp-row{display:flex;align-items:center;justify-content:space-between;gap:8px;}
.sp-title{font-size:11px;font-weight:700;letter-spacing:.06em;color:var(--muted,#9a9a9a);text-transform:uppercase;white-space:nowrap;min-width:0;overflow:hidden;text-overflow:ellipsis;}
.sp-head{margin-bottom:1px;}
.sp-pct{font-size:11px;font-weight:600;color:var(--muted,#9a9a9a);font-variant-numeric:tabular-nums;}
.sp-big{font-size:19px;font-weight:800;color:inherit;font-variant-numeric:tabular-nums;letter-spacing:.01em;margin:2px 0 0;white-space:nowrap;}
.sp-ctxline{display:flex;align-items:center;gap:6px;margin-top:11px;padding-top:10px;border-top:1px solid var(--border,rgba(127,127,127,.16));}
.sp-ctx-lb{flex:none;font-size:10.5px;color:var(--muted,#9a9a9a);}
.sp-ctxline .sp-ctx-input{flex:1;min-width:0;}
.sp-ctxline .sp-ctx-auto{flex:none;}
.sp-bar{height:8px;border-radius:6px;background:rgba(127,127,127,.16);overflow:hidden;margin:8px 0 10px;}
.sp-bar-fill{height:100%;border-radius:6px;background:#7fb3d5;width:0;transition:width .5s ease,background .3s ease;}
.sp-cat{display:flex;align-items:center;gap:8px;padding:3px 0;font-size:12px;line-height:1.4;}
.sp-dot{width:8px;height:8px;border-radius:50%;flex:none;}
.sp-cat-name{opacity:.92;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.sp-cat-val{margin-left:auto;color:var(--muted,#9a9a9a);font-variant-numeric:tabular-nums;white-space:nowrap;}
.sp-kv{display:flex;justify-content:space-between;gap:10px;padding:3px 0;font-size:12px;line-height:1.5;}
.sp-kv .k{color:var(--muted,#9a9a9a);white-space:nowrap;}
.sp-kv .v{font-variant-numeric:tabular-nums;text-align:right;word-break:break-all;}
.sp-note{font-size:10.5px;line-height:1.55;color:var(--muted,#9a9a9a);margin-top:9px;opacity:.85;}
.sp-ctx-auto{background:transparent;border:none;color:var(--muted,#9a9a9a);cursor:pointer;font:inherit;font-size:10.5px;padding:2px 4px;border-radius:5px;text-decoration:underline;text-underline-offset:2px;}
.sp-ctx-auto:hover{color:inherit;background:rgba(127,127,127,.14);}
.sp-note code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10px;background:rgba(127,127,127,.14);padding:1px 4px;border-radius:4px;word-break:break-all;}
.sp-empty{font-size:12px;color:var(--muted,#9a9a9a);padding:6px 0 2px;line-height:1.6;}
.sp-warn{color:#ffb648;}
:root{--sp-c1:#7fb3d5;--sp-c2:#c39bd3;--sp-c3:#5ec98a;--sp-c4:#e5c07b;--sp-c5:#61afef;--sp-c6:#ff9f6e;--sp-c7:#8a8f98;--sp-c8:#4ec9b0;}
html[data-scheme="light"]:not([data-theme]){--sp-c1:#0969da;--sp-c2:#8250df;--sp-c3:#1a7f37;--sp-c4:#953800;--sp-c5:#0550ae;--sp-c6:#bc4c00;--sp-c7:#6e7781;--sp-c8:#0f8a67;}
@media (prefers-reduced-motion:reduce){.sp-bar-fill{transition:none;}}
`;

  function ensureCss(){
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS_TEXT;
    (document.head || document.documentElement).appendChild(s);
  }

  // ───── 工具 ─────
  // 2026-09-14:数字统一 k/M 缩写(原来用 万/亿,与模型圈习惯不符且看着杂),并去掉 ≈ 前缀
  function fmtTok(n){
    if (n == null || isNaN(n)) return "—";
    n = Math.round(n);
    if (n >= 1e6) { const v = n / 1e6; return (v < 10 ? v.toFixed(1) : String(Math.round(v))) + "M"; }
    if (n >= 1e3) { const v = n / 1e3; return (v < 10 ? v.toFixed(1) : String(Math.round(v))) + "k"; }
    return String(n);
  }
  function fmtPct(p){ return (p * 100).toFixed(p > 0 && p < 0.01 ? 2 : 1) + "%"; }
  function fmtAgo(ts){ if (!ts) return "—"; const s = Math.max(0, Math.round((Date.now() - ts) / 1000)); return s < 60 ? s + " 秒前" : s < 3600 ? Math.round(s / 60) + " 分钟前" : Math.round(s / 3600) + " 小时前"; }
  // 上下文窗口识别：只信任 worker 下发的 APP_CTX_EXACT / APP_CTX_HINTS（源是 src/model/data.js，经 /config.js 下发）
  //   → 默认值。用户手填的永远最高。
  //   （2026-10-06 修：这里原写着「见 src/config.js + 客户端内置兜底表」—— 那个文件与那份兜底表都已删除。）
  // 为什么上游给不了:实测 NVIDIA NIM / DeepSeek 官方的 /v1/models 都只返回 {id,label},不含窗口长度,
  // 所以只能按厂商/家族映射 —— 表放在 worker 配置里单点维护,前端不再各写一份。
  // 2026-09-14:这里**不再放硬拷贝的兜底表** —— 上一版我抄了一份,与 worker 配置会静默漂移。
  // 现在唯一来源是 worker /config.js 下发的 APP_CTX_EXACT / APP_CTX_HINTS(见 src/model/data.js);
  // 两者都没有(配置未加载)就返回 0,由调用方回落到 DEFAULT_CTX 并如实提示"未能识别"。
  function detectCtx(modelId) {
    const s = String(modelId || "");
    if (!s) return 0;
    const exact = window.APP_CTX_EXACT || {};
    if (exact[s]) return exact[s];
    const hints = Array.isArray(window.APP_CTX_HINTS) ? window.APP_CTX_HINTS : [];
    for (let i = 0; i < hints.length; i++) {
      try { if (new RegExp(hints[i][0], "i").test(s)) return hints[i][1]; } catch (e) {}
    }
    return 0;
  }
  function currentModelId() {
    const sel = document.getElementById("modelSel");
    if (sel && sel.value) return sel.value;
    try { return localStorage.getItem("cfw_model") || ""; } catch (e) { return ""; }
  }
  function ctxManual() { const v = parseInt(localStorage.getItem(LS_CTX_WINDOW), 10); return (v && v >= 1024) ? v : 0; }
  function ctxWindow(){
    const manual = ctxManual();
    if (manual) return manual;
    return detectCtx(currentModelId()) || DEFAULT_CTX;
  }
  // 2026-09-14: 上限输入解析 —— 原来用 type="number",浏览器直接拒收「万」字(输入「100万」会被吞成「100」或空),
  // 解析失败又静默回落默认值 → 用户填的数字凭空消失。改为文本框 + 显式解析,支持 1000000 / 100万 / 1m / 128k 等写法。
  function parseCtxInput(raw){
    const s = String(raw == null ? "" : raw).trim().toLowerCase().replace(/[\s,_]/g, "");
    if (!s) return NaN;
    const m = s.match(/^([0-9]*\.?[0-9]+)(万|千|m|k|w)?$/);
    if (!m) return NaN;
    const n = parseFloat(m[1]);
    if (!isFinite(n)) return NaN;
    const u = m[2];
    const mult = (u === "万" || u === "w") ? 1e4 : (u === "m") ? 1e6 : (u === "千" || u === "k") ? 1e3 : 1;
    return Math.round(n * mult);
  }
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ───── 数据收集(一次 collect,两个宿主共用)─────
  function collect(){
    const app = window.__app || {};
    const est = (t) => { try { return app.estimateTokens ? app.estimateTokens(String(t || "")) : 0; } catch (e) { return 0; } };
    const msgs = app.getSessionMessages ? (app.getSessionMessages() || []) : [];
    const card = (window.__character && window.__character.getActiveCard) ? window.__character.getActiveCard() : null;
    const last6 = msgs.slice(-6).map(m => String((m && m.content) || "")).join("\n");

    let loreTokens = 0, loreCount = 0;
    try {
      const entries = (window.__lorebook && window.__lorebook.getActiveEntries)
        ? window.__lorebook.getActiveEntries({ text: last6, cardId: (card && card.id) || "" }) : [];
      loreCount = entries.length;
      loreTokens = est(entries.map(e => ((e && e.name) || "") + "\n" + ((e && e.content) || "")).join("\n"));
    } catch (e) {}

    let skillsText = "";
    try { skillsText = (window.__skills && window.__skills.buildCatalogPrompt) ? window.__skills.buildCatalogPrompt() : ""; } catch (e) {}
    let presetsText = "";
    try {
      const arr = JSON.parse(localStorage.getItem("cfw_prompt_presets_v1") || "[]");
      presetsText = (Array.isArray(arr) ? arr : []).filter(p => p && p.enabled).map(p => p.content || "").join("\n");
    } catch (e) {}

    let msgTokens = 0, reasoningTokens = 0, attTokens = 0;
    // 4.83: 上传文档计入上下文 —— 全文在 m.files[].text(截断后的量=实际发送量),
    // 复用 app.js 的 attFileTokens(与实时统计/发给模型的口径完全一致)。
    const attTk = app.attFileTokens || null;
    msgs.forEach(m => {
      msgTokens += est(m && m.content);
      if (m && typeof m.reasoning_content === "string") reasoningTokens += est(m.reasoning_content);
      if (attTk) { try { attTokens += attTk(m) || 0; } catch (e) {} }
    });
    // 4.83: 待发送的附件也计入 —— 用户传完文档还没点发送,容量卡就该看到它;
    // 发送后 takePending 清空待发、全文转入 session.files,由上面的口径无缝接管(不重复计)。
    try {
      const pend = (window.__attach && window.__attach.list) ? (window.__attach.list() || []) : [];
      pend.forEach(p => { if (p && p.kind === "text") attTokens += est("【文件:" + (p.name || "") + "】" + (p.text || "")); });
    } catch (e) {}
    const sumTokens  = est(localStorage.getItem("cfw_prior_summary_v1") || "");
    const cardTokens = est(card ? JSON.stringify(card) : "");
    const presetTokens = est(presetsText), skillTokens = est(skillsText);
    const total = msgTokens + attTokens + sumTokens + loreTokens + cardTokens + presetTokens + skillTokens + reasoningTokens;

    let cost = null;
    try { cost = (window.__cost && window.__cost.getCostStats) ? window.__cost.getCostStats() : null; } catch (e) {}
    let sync = null;
    try { sync = (window.__sync && window.__sync.getStatus) ? window.__sync.getStatus() : null; } catch (e) {}

    return {
      total, msgs: msgs.length, msgTokens, reasoningTokens, sumTokens, loreTokens, loreCount,
      attTokens,
      cardTokens, presetTokens, skillTokens,
      summaryTrigger: parseInt(localStorage.getItem("cfw_summary_trigger") || "30", 10) || 30,
      lastReq: app.getLastRequestStats ? app.getLastRequestStats() : null,
      sync, cost,
      mode: localStorage.getItem("cfw_mode") === "fast" ? "快速" : "免费",
      model: (document.getElementById("modelSel") || {}).value || "—",
    };
  }

  const CATS = [
    { key: "msgTokens",     name: "消息历史",  c: "var(--sp-c1)" },
    { key: "attTokens",     name: "上传文档",  c: "var(--sp-c8)" },
    { key: "sumTokens",     name: "记忆摘要",  c: "var(--sp-c2)" },
    { key: "loreTokens",    name: "设定集",    c: "var(--sp-c3)", lore: true },
    { key: "cardTokens",    name: "角色卡·人设", c: "var(--sp-c4)" },
    { key: "presetTokens",  name: "预设·技能", c: "var(--sp-c5)" },
    { key: "reasoningTokens", name: "思考归档", c: "var(--sp-c7)" },
  ];

  const SKELETON = `
    <div class="sp-card">
      <div class="sp-row sp-head"><span class="sp-title">上下文容量</span><span class="sp-pct" data-sp="bigSub"></span></div>
      <div class="sp-big" data-sp="big">—</div>
      <div class="sp-bar"><div class="sp-bar-fill" data-sp="bar"></div></div>
      <div data-sp="cats"></div>
      <div class="sp-ctxline">
        <span class="sp-ctx-lb">上限</span>
        <input class="sp-ctx-input" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" placeholder="131k" title="上下文窗口上限(tokens)。默认按当前模型自动识别;想手动指定可直接改(可用 1000000 / 1m / 128k 等写法),改后点「自动」恢复识别">
        <button class="sp-ctx-auto" type="button" title="恢复按当前模型自动识别">自动</button>
      </div>
      <div class="sp-note" data-sp="ctxsrc"></div>
      <div class="sp-note">估算仅含客户端可见的 payload 组成块,服务端系统底座与合规层不计入;实际以发送时 worker 装配为准。</div>
    </div>
    <div class="sp-card">
      <div class="sp-row"><span class="sp-title">最近一次请求</span></div>
      <div data-sp="lastreq"><div class="sp-empty">发送一条消息后显示真实 usage / 耗时。</div></div>
    </div>
    <div class="sp-card">
      <div class="sp-row"><span class="sp-title">系统</span></div>
      <div data-sp="sys"></div>
    </div>`;

  function catRowsHtml(s){
    const ctx = ctxWindow();
    return CATS.map(c => {
      const v = s[c.key] || 0;
      const sub = (c.lore && s.loreCount) ? ` · ${s.loreCount}条` : "";
      return `<div class="sp-cat"><span class="sp-dot" style="background:${c.c}"></span>`
        + `<span class="sp-cat-name">${c.name}${sub}</span>`
        + `<span class="sp-cat-val">${fmtTok(v)} · ${fmtPct(ctx ? v / ctx : 0)}</span></div>`;
    }).join("");
  }

  function lastReqHtml(lr){
    if (!lr) return '<div class="sp-empty">发送一条消息后显示真实 usage / 耗时。</div>';
    const rows = [];
    rows.push(["模型", esc(lr.model || "—") + " · " + esc(lr.mode || "—")]);
    if (lr.est) {
      rows.push(["输出", fmtTok(lr.outEstimate) + " tok(估算)"]);
      rows.push(["Prompt/Completion", "上游未回 usage"]);
    } else {
      rows.push(["Prompt / Completion", fmtTok(lr.prompt) + " / " + fmtTok(lr.completion)]);
      rows.push(["Total", fmtTok(lr.total) + " tok"]);
      if (lr.cacheHit != null && lr.prompt) rows.push(["缓存命中", Math.round(lr.cacheHit / Math.max(1, lr.prompt) * 100) + "%"]);
    }
    if (lr.ms) rows.push(["耗时", lr.ms + " ms"]);
    rows.push(["时间", fmtAgo(lr.at)]);
    return rows.map(r => `<div class="sp-kv"><span class="k">${r[0]}</span><span class="v">${r[1]}</span></div>`).join("");
  }

  function sysHtml(s){
    const rows = [];
    const sc = s.sync;
    if (sc) {
      const st = !sc.enabled ? "关" : (sc.paused ? "已暂停" : "开启");
      rows.push(["云同步", esc(st) + (sc.enabled ? " · push " + (sc.pushCount || 0) + "/1000" : "")]);
      if (sc.enabled && sc.lastPush) rows.push(["上次推送", fmtAgo(sc.lastPush)]);
    }
    const cost = s.cost;
    rows.push(["今日费用", s.mode === "快速" && cost ? "¥" + Number(cost.today || 0).toFixed(4) : "免费模式 · 不计费"]);
    rows.push(["会话消息", s.msgs + " 条"]);
    const left = s.summaryTrigger - s.msgs;
    rows.push(["历史压缩", s.msgs + "/" + s.summaryTrigger + " 条" + (left <= 0 ? ' <span class="sp-warn">将触发摘要</span>' : "")]);
    return rows.map(r => `<div class="sp-kv"><span class="k">${r[0]}</span><span class="v">${r[1]}</span></div>`).join("");
  }

  function renderInto(host, s){
    if (!host || !host.__spDone) return;
    const ctx = ctxWindow();
    const pct = ctx ? Math.min(1, s.total / ctx) : 0;
    host.querySelector("[data-sp=\"big\"]").textContent = fmtTok(s.total) + " / " + fmtTok(ctx);
    host.querySelector("[data-sp=\"bigSub\"]").textContent = "(" + fmtPct(s.total / (ctx || 1)) + ")";
    const bar = host.querySelector("[data-sp=\"bar\"]");
    bar.style.width = Math.min(100, pct * 100) + "%";
    bar.style.background = pct > 0.9 ? "#e8607d" : pct > 0.7 ? "#ffb648" : "#7fb3d5";
    host.querySelector("[data-sp=\"cats\"]").innerHTML = catRowsHtml(s);
    host.querySelector("[data-sp=\"lastreq\"]").innerHTML = lastReqHtml(s.lastReq);
    host.querySelector("[data-sp=\"sys\"]").innerHTML = sysHtml(s);
    // 上限来源提示:自动识别时说明是按哪个模型认出来的;手动时提示可恢复
    const srcEl = host.querySelector("[data-sp=\"ctxsrc\"]");
    if (srcEl) {
      const mid = currentModelId();
      if (ctxManual()) {
        srcEl.innerHTML = '上限为手动指定 · 点右上「自动」改回按模型识别';
      } else {
        const hit = detectCtx(mid);
        srcEl.innerHTML = hit
          ? '上限按当前模型自动识别:<code>' + esc(mid) + '</code> → ' + fmtTok(hit)
          : '未能识别当前模型 <code>' + esc(mid || "—") + '</code> 的窗口,暂用默认值 ' + fmtTok(DEFAULT_CTX) + '(可手动指定)';
      }
      // 输入框跟随(用户没在编辑时)
      const inp = host.querySelector(".sp-ctx-input");
      if (inp && document.activeElement !== inp) inp.value = ctx;
    }
  }

  // ───── 挂载 / 刷新 ─────
  let hosts = [];
  function mountAll(){
    ensureCss();
    hosts = [document.getElementById("statusPanelDesktop"), document.getElementById("mobileTabPanel-status")].filter(Boolean);
    hosts.forEach(h => {
      if (h.__spDone) return;
      h.__spDone = true;
      h.classList.add("sp-host");
      h.innerHTML = SKELETON;
      const input = h.querySelector(".sp-ctx-input");
      input.value = ctxWindow();
      const commit = () => {
        const v = parseCtxInput(input.value);
        if (isFinite(v) && v >= 1024) {
          input.value = v;
          try { localStorage.setItem(LS_CTX_WINDOW, String(v)); } catch (e) {}
        } else {
          // 解析失败:还原成当前生效值(而非静默改成默认值,避免用户填的数字凭空消失)
          input.value = ctxWindow();
        }
        tick();
      };
      input.addEventListener("change", commit);
      // 回车即提交(文本框不再有 number 的原生行为)
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); input.blur(); } });
      // 「自动」:清掉手填值 → 回落到按当前模型自动识别
      const autoBtn = h.querySelector(".sp-ctx-auto");
      if (autoBtn) autoBtn.addEventListener("click", () => {
        try { localStorage.removeItem(LS_CTX_WINDOW); } catch (e) {}
        input.value = ctxWindow();
        tick();
      });
    });
  }

  // 4.83: 可见性判定不能用 offsetParent —— position:fixed 元素的 offsetParent 恒为 null,
  // 手机端激活后的面板(fixed 抽屉)会被误判为不可见,tick 永远跳过渲染
  // (旧版靠级联泄漏的静态布局"碰巧"能用,泄漏修复后暴露)。改用 getClientRects。
  function hostVisible(h){ return !!(h && h.getClientRects && h.getClientRects().length > 0); }
  function anyVisible(){ return hosts.some(hostVisible); }
  function tick(){
    if (document.hidden) return; // 2026-10-07 (E-D)：页面不可见时不收集不出力（后台零开销）
    if (!anyVisible()) return;
    const s = collect();
    hosts.forEach(h => { if (hostVisible(h)) renderInto(h, s); });
  }

  function start(){
    mountAll();
    tick();
    setInterval(tick, REFRESH_MS);
    window.addEventListener("storage", tick);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    // tab 切换/面板显隐即时刷新(桌面 rs-panel 的 hidden 属性 + 手机面板的 .active class),不必等下一个周期 tick
    const seen = new Set();
    hosts.forEach(h => {
      [h, h.parentElement].forEach(t => {
        if (!t || seen.has(t)) return;
        seen.add(t);
        new MutationObserver(tick).observe(t, { attributes: true, attributeFilter: ["class", "style", "hidden"] });
      });
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();

  window.__statusPanel = { refresh: tick, collect };
})();
