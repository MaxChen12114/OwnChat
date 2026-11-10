// public/shared/panel-frame.js — 右栏内容画布：iframe 宿主与安全分级
// ─────────────────────────────────────────────────────────────────────
// 职责只有三件：装内容、定安全档、报状态。不认识任何具体插件，也不碰面板布局。
// 上层是 panel-host.js（双态控制器），下层是浏览器 iframe。
//
// 安全三档（2026-11-09 定稿，见 右栏内容面板架构-20261109.md 第七节）：
//   trusted    自家插件      allow-scripts allow-same-origin allow-forms
//   host-html  agent 生成的   srcdoc + 只给 allow-scripts（origin 变 opaque，碰不到父页）
//   external   外链网页       allow-scripts allow-same-origin + referrerpolicy=no-referrer
//
// 为什么 host-html 绝不给 allow-same-origin：
//   iframe 与父页同源时，"允许脚本 + 允许同源" = sandbox 形同虚设——
//   框内脚本能直接读 window.parent.localStorage（里面有 API key、角色卡、全部会话）。
//   给 opaque origin 后，脚本照样能跑（canvas / fetch / 事件全可用），只是碰不到父页。
//
// 为什么不回落到 blob: URL 渲染 HTML：
//   blob: 继承创建者的 origin，同样同源。要隔离只能用 srcdoc 或 data:，这里选 srcdoc
//   （data: 有长度限制且编码开销大）。
//
// 拒内嵌检测的边界（如实写清，不夸大）：
//   X-Frame-Options / frame-ancestors 是浏览器层的拒绝，**跨域无法从父页探测**。
//   这里只能做"超时未 load"的启发式提示，会误报（慢网络）也会漏报（拒绝但 load 仍触发）。
//   所以提示语写成"可能"，并提供「新窗打开」作为出口，不做硬判定。
//
// 对外契约（window.__panelFrame）：
//   mount(box, spec)  spec = { url?, html?, text?, title?, mode? }
//   unmount(box)
//   current(box)      → { title, mode, url } | null
//   on(handler)       → unsubscribe（收来自画布的消息：ready/title/toast）
//   post(box, msg)    → 向画布发消息（resize/event/theme/focus）
// ─────────────────────────────────────────────────────────────────────
(function (global) {
  "use strict";

  if (global.__panelFrame && global.__panelFrame.v === 1) return;

  var V = 1;
  var LOAD_TIMEOUT_MS = 3500;
  var HOST_ORIGIN = "panel-host";

  var MODES = {
    trusted: "trusted",
    hostHtml: "host-html",
    external: "external"
  };

  var handlers = [];
  var winBound = false;

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function emit(ev) {
    for (var i = 0; i < handlers.length; i++) {
      try { handlers[i](ev); } catch (e) { /* 单个订阅者异常不打断其他订阅者 */ }
    }
  }

  // 每条消息带 v，防止旧版本插件的消息误判
  function envelope(type, data) {
    return { __panel: V, from: HOST_ORIGIN, type: type, data: data || {}, at: Date.now() };
  }

  function bindWindowOnce() {
    if (winBound) return;
    winBound = true;
    global.addEventListener("message", function (e) {
      var d = e.data;
      if (!d || typeof d !== "object" || d.__panel !== V) return;
      var type = String(d.type || "");
      if (!type) return;
      emit({ type: type, data: d.data || {}, origin: e.origin, source: e.source });
    });
  }

  // 按安全档写 iframe 属性。所有属性先清再设，避免模式切换时残留旧值。
  // 模式推断（2026-11-09 实测修正）：不传 mode 时按内容形态取安全默认——
  //   有 html（且非空）→ host-html（srcdoc，opaque origin）；
  //   其余 → trusted（自家插件的 url）。
  // 原实现默认 trusted：既让 agent 生成的内容拿到同源权限，又因为 trusted 分支只设 src
  // 导致 html 压根不渲染（src=about:blank）。两条都在浏览器里验过。
  function inferMode(spec) {
    var m = spec.mode;
    if (m === MODES.hostHtml || m === MODES.external || m === MODES.trusted) return m;
    var hasHtml = spec.html != null && String(spec.html) !== "";
    return hasHtml ? MODES.hostHtml : MODES.trusted;
  }

  function applyMode(f, spec) {
    var mode = inferMode(spec);
    f.removeAttribute("srcdoc");
    f.removeAttribute("src");
    f.removeAttribute("referrerpolicy");
    f.setAttribute("sandbox", "allow-scripts");
    if (mode === MODES.hostHtml) {
      // 只给 allow-scripts：origin 为 opaque，脚本可跑但无法触碰父页
      f.setAttribute("sandbox", "allow-scripts");
      f.srcdoc = "<script>" + BOOTSTRAP + "</scr" + "ipt>" + String(spec.html == null ? "" : spec.html);
    } else if (mode === MODES.external) {
      f.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
      f.setAttribute("referrerpolicy", "no-referrer");
      f.src = String(spec.url || "about:blank");
    } else {
      f.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
      f.src = String(spec.url || "about:blank");
    }
    return mode;
  }

  function clearBox(box) {
    if (!box) return;
    try { box.innerHTML = ""; } catch (e) {}
    delete box.dataset.pframeMode;
    delete box.dataset.pframeTitle;
  }

  function showNotice(box, text, actionLabel, actionFn) {
    var n = document.createElement("div");
    n.className = "pframe-notice";
    n.textContent = text;
    if (actionLabel && actionFn) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "pframe-notice-btn";
      b.textContent = actionLabel;
      b.addEventListener("click", actionFn);
      n.appendChild(document.createTextNode(" "));
      n.appendChild(b);
    }
    box.appendChild(n);
  }

  // ── 页面侧 stage_call 协议（2026-11-09） ────────────────────────────
  // 宿主 → 画布页调函数，页面上只需要挂 window.__stage = { 函数名: fn }。
  // 这段协议**不能**要求每个页面作者自己重写一遍：实测 agent 写了一个自包含页面，
  // 因为没实现消息监听，stage_call 直接 15 秒超时，它还把原因误判成"跨源"。
  // 所以由宿主注入：
  //   · host-html（srcdoc）→ 直接拼在内容前面（页面是 opaque origin，只能这样）
  //   · trusted（同源 URL）→ load 之后往它的 document 里塞一个 <script>
  //   · external（跨源）→ 注入不了，页面需自行引入 /shared/stage-call-client.js
  var BOOTSTRAP = "(function(){if(window.__stageCall)return;window.__stageCall=1;" +
    "window.addEventListener('message',function(e){var d=e.data;" +
    "if(!d||d.__panel!==1||d.type!=='call')return;" +
    "var id=d.data&&d.data.id,fn=d.data&&d.data.fn;" +
    "var r=function(ok,v){try{parent.postMessage({__panel:1,type:'call-result',data:{id:id,ok:ok,result:ok?v:undefined,error:ok?undefined:String((v&&v.message)||v)}},'*')}catch(_e){}};" +
    "var f=window.__stage&&window.__stage[fn];" +
    "if(typeof f!=='function')return r(false,'这个页面没有注册函数「'+fn+'」。可用：'+(Object.keys(window.__stage||{}).join(' / ')||'（无）'));" +
    "try{var a=d.data.args,o=f.apply(null,(a==null)?[]:(Array.isArray(a)?a:[a]));" +
    "if(o&&typeof o.then==='function')o.then(function(x){r(true,x)},function(er){r(false,er)});else r(true,o)}catch(er){r(false,er)}" +
    "});})();";

  function injectBootstrap(f, mode) {
    if (!f) return;
    try {
      if (mode === MODES.trusted && f.contentDocument) {
        var d = f.contentDocument;
        if (d && d.documentElement && !d.documentElement.dataset.stageCall) {
          d.documentElement.dataset.stageCall = "1";
          var s = d.createElement("script");
          s.textContent = BOOTSTRAP;
          (d.head || d.documentElement).appendChild(s);
        }
      }
    } catch (e) { /* 跨源读不到 document —— 按设计如此，页面自带 client 脚本即可 */ }
  }

  function mount(box, spec) {
    if (!box) return null;
    spec = spec || {};
    bindWindowOnce();
    clearBox(box);

    var title = String(spec.title || "");

    // 纯文本：不套 iframe（没有脚本需求时最小攻击面）
    if (spec.text != null && !spec.url && spec.html == null) {
      var pre = document.createElement("pre");
      pre.className = "pframe-text";
      pre.textContent = String(spec.text);
      box.appendChild(pre);
      box.dataset.pframeMode = "text";
      box.dataset.pframeTitle = title;
      return { mode: "text", title: title, url: "" };
    }

    var f = document.createElement("iframe");
    f.className = "pframe";
    f.setAttribute("title", title || "内容画布");
    f.setAttribute("loading", "lazy");
    var mode = applyMode(f, spec);

    var loaded = false;
    var timer = null;

    f.addEventListener("load", function () {
      loaded = true;
      if (timer) { clearTimeout(timer); timer = null; }
      box.dataset.pframeLoaded = "1";
      injectBootstrap(f, mode);
      // 父页 → 画布：握手 + 初始尺寸 + 主题
      post(box, envelope("ready", {
        title: title,
        mode: mode,
        w: box.clientWidth,
        h: box.clientHeight,
        theme: readTheme()
      }));
      emit({ type: "frame:load", data: { mode: mode, title: title } });
    });

    box.appendChild(f);
    box.dataset.pframeMode = mode;
    box.dataset.pframeTitle = title;
    delete box.dataset.pframeLoaded;

    // 超时启发式：只提示，不判定（跨域拒内嵌无法探测）
    if (mode !== MODES.hostHtml) {
      timer = setTimeout(function () {
        if (loaded) return;
        showNotice(box, "这块内容可能拒绝被嵌入（或网络较慢）。", "新窗打开", function () {
          try { global.open(String(spec.url || ""), "_blank", "noopener"); } catch (e) {}
        });
      }, LOAD_TIMEOUT_MS);
    }

    return { mode: mode, title: title, url: String(spec.url || "") };
  }

  function unmount(box) {
    if (!box) return;
    clearBox(box);
  }

  function current(box) {
    if (!box || !box.dataset.pframeMode) return null;
    return {
      mode: box.dataset.pframeMode,
      title: box.dataset.pframeTitle || "",
      loaded: box.dataset.pframeLoaded === "1"
    };
  }

  function post(box, msg) {
    if (!box) return false;
    var f = box.querySelector("iframe.pframe");
    if (!f || !f.contentWindow) return false;
    try { f.contentWindow.postMessage(msg, "*"); return true; } catch (e) { return false; }
  }

  function resize(box) {
    if (!box) return;
    post(box, envelope("resize", { w: box.clientWidth, h: box.clientHeight }));
  }

  function readTheme() {
    var out = {};
    try {
      var cs = getComputedStyle(document.documentElement);
      ["--bg", "--panel", "--border", "--text", "--muted", "--accent"].forEach(function (k) {
        var v = cs.getPropertyValue(k);
        if (v) out[k.replace(/^--/, "")] = v.trim();
      });
    } catch (e) {}
    return out;
  }

  function on(handler) {
    if (typeof handler !== "function") return function () {};
    handlers.push(handler);
    bindWindowOnce();
    return function () {
      var i = handlers.indexOf(handler);
      if (i >= 0) handlers.splice(i, 1);
    };
  }

  global.__panelFrame = {
    v: V,
    MODES: MODES,
    mount: mount,
    unmount: unmount,
    current: current,
    post: post,
    resize: resize,
    on: on
  };
})(window);
