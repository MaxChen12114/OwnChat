// public/js/text/ui/choices.js —— 选项分支 / galgame 式「下一步」芯片条
// 路径: public/js/text/ui/choices.js
// 职责: 解析 AI 回复里的 [选项]…[/选项] 协议块 → 在输入框上方渲染可点芯片;
//       点击 = 以该选项文本作为用户消息发送(复用 #msg 输入框 + 回车, 零侵入 app.js)。
// 三个入口共用本模块:
//   ① 正常对话·agent 关: MutationObserver 扫描收尾的 AI 气泡里的 [选项] 标签(autoScan)
//   ② 正常对话·agent 开 / 自驱: 由 agent 工具 offer_choices 或 autopilot 显式调 renderChoices(options)
//   ③ 任意位置: parseAndRender(rawText, opts) 一步解析+渲染
// 暴露: window.__choices = { parseChoices, renderChoices, clearChoices, parseAndRender, autoScan }
(function () {
  if (window.__choices) return;

  var BAR_ID = "omniChoicesBar";
  var STYLE_ID = "omniChoicesStyle";
  var OPENS = ["[选项]", "[opt]", "[OPT]"];
  var CLOSES = { "[选项]": "[/选项]", "[opt]": "[/opt]", "[OPT]": "[/OPT]" };

  function $(id) { return document.getElementById(id); }

  function ensureStyle() {
    if ($(STYLE_ID)) return;
    var s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = [
      // 2026-09-10 手机端显示修复(三处):
      //   ① max-height + overflow-y —— 原来没高度上限,AI 一次给 5~6 条长选项就把输入框顶出屏幕外,手机上既看不到也打不了字;
      //   ② word-break/overflow-wrap —— 原来只有 max-width:100%,长句选项(尤其不带空格的中文长串)直接溢出芯片外;
      //   ③ 颜色改走主题变量 —— 原来写死 rgba(154,163,255)紫,切蜜桃/少女等主题时芯片颜色与全站脸。
      //   另: 多行文本下 border-radius:999px 会肨成椭圆,改 14px。
      // 2026-09-12 修复「选项弹窗透明/点不了」: 原来背景/边框全靠低透明度 rgba 兜底色,
      // 部分主题(尤其新版 OwnChat 壳)下 --card/--accent 未定义,兜底值几乎和背景融为一体——
      // 用户看不清芯片边界,点击自然经常点空/点偏(看起来像“点不了”)。
      // 改为:不透明纯色背板(借用全站已有的 --bubble-ai 实色面板变量,菜单/弹层同款)+ 实色描边 + 阴影 + 更高 z-index,
      // 与主题变量的缺省值脱钩也能保证可读可点。
// 2026-11-10（所有者要求：AI 选项弹窗跟随主题、借鉴 ZCode）：
      // 旧版是 wrap 芯片 + 半透明底(--bubble-ai) —— 烛光/玻璃主题下底几乎透明，文字与消息叠在一起。
      // 改为选项面板：实色 surface 背板 + 标题行 + 带序号的整行选项 + 底部动作条（ZCode 的选项列表形态）。
      "#" + BAR_ID + "{position:relative;z-index:30;flex:0 0 100%;width:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:6px;padding:10px 10px 8px;margin:0 0 8px;border-radius:14px;background:var(--surface-2,#1c1c22);border:1px solid var(--border,rgba(127,127,127,.35));box-shadow:0 10px 30px rgba(0,0,0,.28),inset 0 1px 0 rgba(255,255,255,.04);max-height:38vh;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;animation:ocFade .18s ease;pointer-events:auto;}",
      "@keyframes ocFade{from{opacity:0;transform:translateY(4px);}to{opacity:1;transform:none;}}",
      "#" + BAR_ID + " .oc-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 2px 4px;}",
      "#" + BAR_ID + " .oc-title{font-size:11.5px;font-weight:650;letter-spacing:.04em;color:var(--muted,#9a9a9a);}",
      "#" + BAR_ID + " .oc-hint{font-size:11px;opacity:.55;}",
      ".oc-chip{display:flex;align-items:center;gap:9px;width:100%;box-sizing:border-box;font-size:13px;line-height:1.4;padding:9px 10px;border-radius:10px;cursor:pointer;border:1px solid var(--border-soft,rgba(127,127,127,.3));background:rgba(127,127,127,.08);color:inherit;transition:background .15s,border-color .15s;text-align:left;white-space:normal;word-break:break-word;overflow-wrap:anywhere;pointer-events:auto;}",
      ".oc-chip:hover{background:rgba(127,127,127,.18);border-color:var(--accent,#7b82e8);}",
      ".oc-chip:active{transform:scale(.995);}",
      ".oc-idx{flex:none;width:18px;height:18px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:650;background:var(--accent-soft,rgba(127,127,127,.16));color:var(--accent,#7b82e8);}",
      "#" + BAR_ID + " .oc-foot{display:flex;flex-wrap:wrap;gap:4px;padding-top:5px;margin-top:2px;border-top:1px solid var(--border-soft,rgba(127,127,127,.18));}",
      ".oc-chip.oc-meta{display:inline-flex;width:auto;gap:6px;padding:6px 10px;border-style:solid;border-color:transparent;background:transparent;font-size:12px;color:var(--muted,#9a9a9a);}",
      ".oc-chip.oc-meta:hover{background:rgba(127,127,127,.14);border-color:transparent;color:inherit;}",
      ".oc-chip .oc-ico{display:inline-flex;vertical-align:-2px;margin-right:6px;}",
      ".oc-chip .oc-ico svg{width:13px;height:13px;display:block;}",
      "html[data-theme=\"glass\"] #" + BAR_ID + "{background:rgba(255,255,255,.90);border-color:rgba(255,255,255,.8);-webkit-backdrop-filter:blur(20px) saturate(170%);backdrop-filter:blur(20px) saturate(170%);box-shadow:0 14px 40px rgba(30,60,90,.18),inset 0 1px 0 rgba(255,255,255,.9);}",
      "html[data-theme=\"glass\"] .oc-chip{background:rgba(15,30,60,.05);border-color:rgba(15,30,60,.10);}",
      "html[data-theme=\"glass\"] .oc-chip:hover{background:rgba(63,111,143,.10);border-color:var(--accent,#3f6f8f);}",
      "html[data-theme=\"glass\"] #" + BAR_ID + " .oc-title{color:#5a6b78;}"
    ].join("");
    document.head.appendChild(s);
  }

  // 找到输入框上方的挂载锚点(优先 .input-floating, 回落 #msg 容器)
  function composerHost() {
    var fl = document.querySelector(".input-floating");
    if (fl) return fl;
    var msg = $("msg");
    return (msg && msg.parentElement) || null;
  }

  // 发送一条用户消息
  // 2026-09-10 修复: 优先走 app.sendOne 正式入口。原实现把「塞 #msg + 10ms 后派一个合成 Enter 键盘事件」
  // 当主路径,两个问题: ① 手机 WebView 对合成 KeyboardEvent 处理不一致,有的直接吞掉 → 表现为「点了选项没反应」;
  // ② 那 10ms 窗口里再点一下就发两条。回落链: sendOne → 点 #sendBtn → 合成 Enter(最后才用)。
  function sendAsUser(text) {
    if (window.__app && typeof window.__app.sendOne === "function") {
      try { window.__app.sendOne({ text: text }); return; } catch (e) {}
    }
    var msg = $("msg");
    if (!msg) return;
    msg.value = text;
    try { msg.dispatchEvent(new Event("input", { bubbles: true })); } catch (e) {}
    var btn = $("sendBtn");
    if (btn) { btn.click(); return; }
    try { msg.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); } catch (e) {}
  }

  // 用 indexOf 定位 [选项]…[/选项] 块(不用正则, 避免转义坑)
  function findBlock(src) {
    for (var i = 0; i < OPENS.length; i++) {
      var o = OPENS[i];
      var start = src.indexOf(o);
      if (start < 0) continue;
      var c = CLOSES[o];
      var end = src.indexOf(c, start + o.length);
      if (end < 0) continue;
      return { close: c, start: start, end: end, inner: src.slice(start + o.length, end) };
    }
    return null;
  }

  function stripBullet(t) {
    if (!t) return "";
    t = t.replace(/^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫]\s*/, "");
    t = t.replace(/^\d+[\.、\)]\s*/, "");
    t = t.replace(/^[-•*]\s*/, "");
    return t.trim();
  }

  // 解析 → { clean, options:[{label] }
  function parseChoices(text) {
    var src = String(text == null ? "" : text);
    var blk = findBlock(src);
    if (!blk) return { clean: src, options: [] };
    var options = [];
    blk.inner.split("\n").forEach(function (line) {
      var t = stripBullet(line.trim());
      if (t) options.push({ label: t });
    });
    var clean = (src.slice(0, blk.start) + src.slice(blk.end + blk.close.length)).trim();
    return { clean: clean, options: options };
  }

  // options: Array<{label,value?}> | Array<string>
  // opts: { onPick?(value,isMeta), includeMeta=true, metaActions?, autoSend=true }
  function renderChoices(options, opts) {
    options = options || [];
    opts = opts || {};
    var norm = options.map(function (o) {
      if (typeof o === "string") return { label: o, value: o };
      return { label: o.label, value: o.value != null ? o.value : o.label };
    }).filter(function (o) { return o.label; });
    var includeMeta = opts.includeMeta !== false;
    if (!norm.length && !includeMeta) { clearChoices(); return null; }

    ensureStyle();
    clearChoices();
    var host = composerHost();
    if (!host) return null;

    var bar = document.createElement("div");
    bar.id = BAR_ID;

    var head = document.createElement("div");
    head.className = "oc-head";
    var title = document.createElement("span");
    title.className = "oc-title";
    title.textContent = norm.length ? "AI 提供选项" : "继续";
    var hint = document.createElement("span");
    hint.className = "oc-hint";
    hint.textContent = norm.length ? "点一条直接发送 · 或继续打字" : "或自己打字";
    head.appendChild(title);
    head.appendChild(hint);
    bar.appendChild(head);

    function pick(value, isMeta) {
      try { if (typeof opts.onPick === "function" && opts.onPick(value, isMeta) === false) { clearChoices(); return; } } catch (e) {}
      if (opts.autoSend === false) { clearChoices(); return; }
      sendAsUser(value);
      clearChoices();
    }

    norm.forEach(function (o, i) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "oc-chip";
      var idx = document.createElement("span");
      idx.className = "oc-idx";
      idx.textContent = String(i + 1);
      b.appendChild(idx);
      b.appendChild(document.createTextNode(o.label));
      b.addEventListener("click", function () { pick(o.value, false); });
      bar.appendChild(b);
    });

    if (includeMeta) {
      // 2026-09-14:三个固定动作改用线性 SVG 图标 —— 原来「自己写」用的是 ✍️(U+270D + FE0F),
      // 带 emoji 呈现选择符,多数平台直接渲染成 emoji,与全站线性图标语言不一致、观感廉价。
      var META_ICONS = {
        "__compose__": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20l4-1 9.6-9.6a2 2 0 0 0-2.8-2.8L5.4 16z"/><path d="M13.5 6.3l4.2 4.2"/></svg>',
        "__continue__": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h13"/><path d="M13 7l5 5-5 5"/></svg>',
        "__another__": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h9a4 4 0 0 1 4 4v6"/><path d="M14 14l3 3 3-3"/></svg>'
      };
      var metas = opts.metaActions || [
        { label: "继续", value: "继续", icon: META_ICONS.__continue__ },
        { label: "换个走向", value: "换一个走向，给我新的发展", icon: META_ICONS.__another__ },
        { label: "自己写", value: "__compose__", icon: META_ICONS.__compose__ }
      ];
      var foot = document.createElement("div");
      foot.className = "oc-foot";
      metas.forEach(function (mAct) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "oc-chip oc-meta";
        var ic = mAct.icon || META_ICONS[mAct.value] || "";
        if (ic) b.innerHTML = '<span class="oc-ico">' + ic + "</span>";
        b.appendChild(document.createTextNode(mAct.label));
        b.addEventListener("click", function () {
          if (mAct.value === "__compose__") {
            // 2026-09-10 修复: 必须在点击手势的同一个同步栈里、并且在拆掉芯片条之前先 focus。
            // 原来是 clearChoices() → focus(),DOM 一变 iOS/Android WebView 就不弹软键盘(表现为「点了自己写没反应」)。
            var m = $("msg");
            if (m) {
              try { m.focus({ preventScroll: true }); m.setSelectionRange(m.value.length, m.value.length); }
              catch (e) { try { m.focus(); } catch (e2) {} }
            }
            clearChoices();
            try { if (m && m.scrollIntoView) m.scrollIntoView({ block: "center" }); } catch (e) {}
            return;
          }
          pick(mAct.value, true);
        });
        foot.appendChild(b);
      });
      bar.appendChild(foot);
    }

    // 挂在输入框上方(host 首子节点, 与 scene-strip 同款)
    if (host.firstChild) host.insertBefore(bar, host.firstChild);
    else host.appendChild(bar);
    return bar;
  }

  function clearChoices() {
    var bar = $(BAR_ID);
    if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
  }

  // 一步: 解析原始文本并渲染(autopilot / app.js 收尾钩子可直接调)
  function parseAndRender(rawText, opts) {
    var r = parseChoices(rawText);
    if (r.options.length) renderChoices(r.options, opts);
    return r;
  }

  // 从气泡显示里抹掉原始 [选项] 标签(协议块不该露给用户)
  // 2026-09-10 重写: 原实现在 innerHTML 字符串上 indexOf + slice,两个显示 bug 都出在这:
  //   ① markdown 渲染后标记可能被拆进不同标签或被转义([ → &#91; 等),indexOf 找不到 → 用户直接看到 [选项] 原文;
  //   ② 即使找到,按 HTML 字符下标切割会把标签切断(如正好落在 <p 中间),再赋回 innerHTML 会毁掉整段 DOM
  //     —— 这就是手机上时不时看到气泡镶嵌错乱 / 段落残缺的原因。
  // 现改为 TreeWalker 遍历文本节点、只删纯文本区间,永不触碰标签结构。
  function stripBlockText(el) {
    try {
      var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      var nodes = [], offsets = [], total = 0, n;
      while ((n = walker.nextNode())) { nodes.push(n); offsets.push(total); total += n.nodeValue.length; }
      if (!nodes.length) return;
      var full = nodes.map(function (x) { return x.nodeValue; }).join("");
      var blk = findBlock(full);
      if (!blk) return;
      var from = blk.start, to = blk.end + blk.close.length;
      for (var i = nodes.length - 1; i >= 0; i--) {
        var s = offsets[i], e = s + nodes[i].nodeValue.length;
        if (e <= from || s >= to) continue;
        var a = Math.max(from, s) - s, b = Math.min(to, e) - s;
        nodes[i].nodeValue = nodes[i].nodeValue.slice(0, a) + nodes[i].nodeValue.slice(b);
      }
    } catch (e) {}
  }

  var api = {
    parseChoices: parseChoices,
    renderChoices: renderChoices,
    clearChoices: clearChoices,
    parseAndRender: parseAndRender,
    // 2026-09-10: 最近一次扮到的选项缓存。标签一旦从气泡里抹掉,别人再 parseChoices(气泡文本) 就是空的,
    // autopilot 半自动暂停时就靠这份缓存拿回真选项(见 autopilot.js renderPauseExits)。
    lastOptions: [],
    getLastOptions: function () { return (api.lastOptions || []).slice(); },
    autoScan: true
  };

  // ① autoScan 兜底: 监听 #chat, 扫收尾 AI 气泡里的 [选项] 标签(agent 关时用)
  function scanLatestAiRow(chat) {
    if (!api.autoScan) return;
    var rows = chat.querySelectorAll(".row.ai");
    if (!rows.length) return;
    var row = rows[rows.length - 1];
    if (row.getAttribute("data-streaming") === "1") return; // 流式中, 等收尾
    if (row.dataset.ocDone === "1") return;
    var bubble = row.querySelector(".bubble.ai");
    if (!bubble) return;
    var raw = bubble.textContent || "";
    if (!findBlock(raw)) return;
    var r = parseChoices(raw);
    // 2026-09-10 修复: 原来先落 ocDone="1" 再判空,解析没出选项时这条气泡就永久不再被扮
    // —— 而流式刚收尾的瞬间正是最容易只扫到半个块的时候,直接造成「选项时有时无」。
    if (!r.options.length) return;
    row.dataset.ocDone = "1";
    row.dataset.ocRaw = raw;   // 留一份原文,供事后重建/排查
    api.lastOptions = r.options;
    stripBlockText(bubble);
    renderChoices(r.options, {});
  }

  function wire() {
    var chat = $("chat");
    if (!chat) { setTimeout(wire, 600); return; }
    var t = null;
    var _streamClearedFor = null; // 2026-09-12: 记录「已经为这条流式清过一次」的行,防止同一条流式期间反复清
    new MutationObserver(function () {
      clearTimeout(t);
      t = setTimeout(function () {
        // 2026-09-10 修复: 新回复一开始流式就先收掉旧芯片条。原来只在点发送/敲回车时清,
        // 自驱 / agent / 重试 这些「非用户手打」的发送会把一条过期选项留在输入框上方,点下去就乱。
        // 2026-09-12 修复: 不能在「同一条流式期间」反复清 —— Agent 模式下 offer_choices 工具会在
        // 本轮回复仍标 data-streaming="1" 期间(工具调用发生在最终文本流式结束之前)渲染芯片条,
        // 旧逻辑每 120ms 一有 DOM 变动就把刚渲染出来的芯片条清掉,表现为「弹了又立刻消失/根本没弹」。
        // 改为:每条新流式(新 AI row)只在「刚开始流式」那一刻清一次旧芯片,同一条流式期间
        // 后续的 DOM 变动(包括工具渲染芯片)不再触发清除。
        try {
          var streamingRow = chat.querySelector('.row.ai[data-streaming="1"]');
          if (streamingRow) {
            if (_streamClearedFor !== streamingRow) { _streamClearedFor = streamingRow; clearChoices(); }
            return;
          }
          _streamClearedFor = null;
        } catch (e) {}
        scanLatestAiRow(chat);
      }, 120);
    }).observe(chat, { childList: true, subtree: true, characterData: true });
    var sendBtn = $("sendBtn");
    if (sendBtn) sendBtn.addEventListener("click", clearChoices);
    var msg = $("msg");
    if (msg) msg.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) clearChoices(); });
  }

  window.__choices = api;

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();