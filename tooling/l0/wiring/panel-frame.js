// ── Browser wiring (injected by tooling/l0/emit.mjs): binds the service to the frozen window contract name ──
// The security decisions moved to services/panel/panel-frame.ts (mode inference, sandbox attributes,
// envelope, bootstrap). This file owns the frame element itself: creating it, the load/timeout
// heuristics, injecting the bootstrap into a same-origin document, and the message subscription.
(function (global) {
  "use strict";

  if (global.panelSvcFrame && global.panelSvcFrame.v === 1) return;

  var V = PANEL_FRAME_VERSION;
  var LOAD_TIMEOUT_MS = 3500;
  var MODES = { trusted: "trusted", hostHtml: "host-html", external: "external" };

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

  // Write the iframe attributes per trust tier. Clear first, then set: a mode switch must not
  // leave a stale sandbox behind. What each tier grants lives in the service's panelSandbox().
  function applyMode(f, spec) {
    var mode = inferPanelMode(spec);
    var attrs = panelSandbox(mode);
    f.removeAttribute("srcdoc");
    f.removeAttribute("src");
    f.removeAttribute("referrerpolicy");
    f.setAttribute("sandbox", attrs.sandbox);
    if (attrs.referrerpolicy) f.setAttribute("referrerpolicy", attrs.referrerpolicy);
    if (mode === MODES.hostHtml) {
      f.srcdoc = panelSrcDoc(spec.html);
    } else {
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

  function injectBootstrap(f, mode) {
    if (!f) return;
    try {
      if (mode === MODES.trusted && f.contentDocument) {
        var d = f.contentDocument;
        if (d && d.documentElement && !d.documentElement.dataset.stageCall) {
          d.documentElement.dataset.stageCall = "1";
          var s = d.createElement("script");
          s.textContent = PANEL_BOOTSTRAP;
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

    // Plain text: no iframe — the smallest attack surface when no script is needed.
    if (isTextOnlySpec(spec)) {
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
      // Parent -> canvas: handshake, initial size, theme.
      post(box, panelEnvelope("ready", {
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

    // Timeout heuristic: a hint only, never a verdict — a cross-origin refusal cannot be probed.
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
    post(box, panelEnvelope("resize", { w: box.clientWidth, h: box.clientHeight }));
  }

  // Pause/resume signal for a background pane. Pages that animate or poll should listen for
  // `{__panel:1,type:"visibility",data:{visible}}`; a page that ignores it is still torn down by the
  // host's live-frame cap, so this is an optimisation, not the safety boundary.
  function setVisible(box, visible) {
    if (!box) return false;
    return post(box, visibilityEnvelope(visible === true));
  }

  function hasFrame(box) {
    return !!(box && box.querySelector("iframe.pframe"));
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

  global.panelSvcFrame = {
    v: V,
    MODES: MODES,
    mount: mount,
    unmount: unmount,
    current: current,
    post: post,
    resize: resize,
    setVisible: setVisible,
    hasFrame: hasFrame,
    on: on
  };
})(window);
