(function () {
/**
 * The security half of the content-canvas iframe host: which sandbox a payload gets, and the message
 * envelope the frame speaks.
 *
 * Three modes, and the difference between them is the whole point:
 *   trusted     own plugins      `allow-scripts allow-same-origin allow-forms`
 *   host-html   agent-generated  `srcdoc` + **only** `allow-scripts`
 *   external    third-party URL  `allow-scripts allow-same-origin allow-forms` + `no-referrer`
 *
 * `host-html` must never gain `allow-same-origin`. Scripts plus same-origin makes the sandbox
 * meaningless: the framed script can read `window.parent.localStorage`, which holds API keys, role
 * cards and every conversation. An opaque origin still allows canvas, fetch and events — it only
 * severs the parent. For the same reason generated HTML is rendered through `srcdoc`, never a
 * `blob:` URL: `blob:` inherits the creator's origin, so it would be same-origin by construction.
 *
 * The mode is inferred from the payload, not from the caller: any non-empty `html` means `host-html`.
 * The original default (trusted) both handed generated content same-origin rights and, because the
 * trusted branch only sets `src`, silently rendered nothing at all.
 *
 * Mounting, timers, theme reading and the frame element itself stay in `l0/wiring/panel-frame.js`.
 * One pane = one box element; the tab host owns those boxes, so `mount` never has to know how many
 * frames exist. Background panes stay mounted but are told to pause:
 * `{__panel:1,type:"visibility",data:{visible:false}}` is the freeze signal, and a page that ignores
 * it is destroyed by the host's live-frame cap rather than trusted to behave.
 *
 * Lock: `test/panel-frame.test.mjs` (written with the migration, run against both implementations)
 * and `test/tab-state.test.mjs` for the visibility envelope.
 * @module services/panel/panel-frame
 */

                                                             

                                 
                
                 
                 
                  
                 
 

                               
                  
                                                           
                                
 

                                
                  
               
               
                                
             
 

const PANEL_FRAME_VERSION = 1;
const PANEL_HOST_ORIGIN = "panel-host";
/** The freeze/resume message type sent to every pane whose visibility changes. */
const PANEL_MSG_VISIBILITY = "visibility";
/** The function-name call the agent's `stage_call` reaches a page with. */
const PANEL_MSG_CALL = "call";

const PANEL_SANDBOX_SCRIPT_ONLY = "allow-scripts";
const PANEL_SANDBOX_OWN = "allow-scripts allow-same-origin allow-forms";

/**
 * Injected into every framed page so `stage_call` works without the page author doing anything.
 * A real page was written that skipped this and every call timed out after 15 s, with the agent
 * misdiagnosing it as a cross-origin problem.
 */
const PANEL_BOOTSTRAP =
  "(function(){if(window.__stageCall)return;window.__stageCall=1;" +
  "window.addEventListener('message',function(e){var d=e.data;" +
  "if(!d||d.__panel!==1||d.type!=='call')return;" +
  "var id=d.data&&d.data.id,fn=d.data&&d.data.fn;" +
  "var r=function(ok,v){try{parent.postMessage({__panel:1,type:'call-result',data:{id:id,ok:ok,result:ok?v:undefined,error:ok?undefined:String((v&&v.message)||v)}},'*')}catch(_e){}};" +
  "var f=window.__stage&&window.__stage[fn];" +
  "if(typeof f!=='function')return r(false,'这个页面没有注册函数「'+fn+'」。可用：'+(Object.keys(window.__stage||{}).join(' / ')||'（无）'));" +
  "try{var a=d.data.args,o=f.apply(null,(a==null)?[]:(Array.isArray(a)?a:[a]));" +
  "if(o&&typeof o.then==='function')o.then(function(x){r(true,x)},function(er){r(false,er)});else r(true,o)}catch(er){r(false,er)}" +
  "});})();";

function text(value         )         {
  return value == null ? "" : typeof value === "string" ? value : String(value);
}

function recOf(value         )                          {
  const out                          = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) out[k] = v;
  }
  return out;
}

/** True when the payload is plain text with no url and no html — rendered as `<pre>`, no iframe. */
function isTextOnlySpec(spec         )          {
  const s = recOf(spec);
  return s.text != null && !s.url && s.html == null;
}

/**
 * Picks the security mode.
 * @returns an explicit valid `mode` if the caller gave one, otherwise `host-html` for any non-empty
 * `html` and `trusted` for everything else.
 */
function inferPanelMode(spec         )            {
  const s = recOf(spec);
  const m = s.mode;
  if (m === "host-html" || m === "external" || m === "trusted") return m;
  const hasHtml = s.html != null && text(s.html) !== "";
  return hasHtml ? "host-html" : "trusted";
}

/**
 * The sandbox attributes for a mode.
 * @returns the `sandbox` value plus `referrerpolicy` (`null` = do not set). `host-html` is the only
 * mode that gets `allow-scripts` alone; adding `allow-same-origin` there would defeat the sandbox.
 */
function panelSandbox(mode           )               {
  if (mode === "host-html") return { sandbox: PANEL_SANDBOX_SCRIPT_ONLY, referrerpolicy: null };
  if (mode === "external") return { sandbox: PANEL_SANDBOX_OWN, referrerpolicy: "no-referrer" };
  return { sandbox: PANEL_SANDBOX_OWN, referrerpolicy: null };
}

/** Message envelope. The `__panel` version field keeps old plugin messages from being misread. */
function panelEnvelope(type        , data          , at         )                {
  return {
    __panel: PANEL_FRAME_VERSION,
    from: PANEL_HOST_ORIGIN,
    type: type,
    data: recOf(data),
    at: typeof at === "number" ? at : Date.now(),
  };
}

/**
 * The pause/resume signal for a background pane.
 * @returns the exact envelope the bootstrap and page authors read: `visible:false` means "you are
 * not on screen — stop animations and timers"; `visible:true` is sent on every activation so a
 * page has a single resume path instead of guessing from resize events.
 */
function visibilityEnvelope(visible         )                {
  return panelEnvelope(PANEL_MSG_VISIBILITY, { visible: visible === true }, undefined);
}

/** The srcdoc body for `host-html`: the bootstrap first, then the payload verbatim. */
function panelSrcDoc(html         )         {
  return "<script>" + PANEL_BOOTSTRAP + "</scr" + "ipt>" + text(html);
}

// ── Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name ──
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

globalThis.PANEL_FRAME_VERSION = PANEL_FRAME_VERSION;
globalThis.PANEL_HOST_ORIGIN = PANEL_HOST_ORIGIN;
globalThis.PANEL_MSG_VISIBILITY = PANEL_MSG_VISIBILITY;
globalThis.PANEL_MSG_CALL = PANEL_MSG_CALL;
globalThis.PANEL_BOOTSTRAP = PANEL_BOOTSTRAP;
globalThis.isTextOnlySpec = isTextOnlySpec;
globalThis.inferPanelMode = inferPanelMode;
globalThis.panelSandbox = panelSandbox;
globalThis.panelEnvelope = panelEnvelope;
globalThis.visibilityEnvelope = visibilityEnvelope;
globalThis.panelSrcDoc = panelSrcDoc;
})();
