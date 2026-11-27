(() => {
  // public/shell/mobile-entry.js
  (function() {
    "use strict";
    var VERSION = "0.6.0";
    var params = new URLSearchParams(location.search);
    var FORCE = params.get("shell") === "mobile";
    var MQ = window.matchMedia("(max-width: 1023px)");
    var html = document.documentElement;
    var built = false;
    var current = "chat";
    var consoleOpen = false;
    var capOpen = false;
    var capObserver = null;
    var bootParam = params.get("page");
    if (bootParam === "work" || bootParam === "sandbox") current = "work";
    var bootConsole = bootParam === "console" || bootParam === "stage";
    var bootCap = params.get("cap") === "1";
    var CSS_HREF = "/shell/mobile-shell.css?v=" + VERSION;
    function slot(name) {
      var host = (
        /** @type {any} */
        window
      );
      var reg = host.slotRegistry;
      var el = reg && typeof reg.get === "function" ? reg.get(name) : null;
      if (el) return (
        /** @type {HTMLElement|null} */
        el
      );
      var marked = document.querySelector('[data-slot="' + name + '"]');
      if (marked) return (
        /** @type {HTMLElement|null} */
        marked
      );
      return (
        /** @type {HTMLElement|null} */
        document.getElementById(name)
      );
    }
    function api(name) {
      var host = (
        /** @type {any} */
        window.__host
      );
      return host && host[name] || /** @type {any} */
      window["__" + name];
    }
    function injectCss() {
      if (document.querySelector('link[data-shell-css], link[href*="/shell/mobile-shell.css"]')) return;
      var link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = CSS_HREF;
      link.setAttribute("data-shell-css", "1");
      document.head.appendChild(link);
    }
    function remember(el) {
      var any = (
        /** @type {any} */
        el
      );
      if (!any.__home) any.__home = { parent: el.parentNode, next: el.nextSibling };
    }
    function moveTo(el, host) {
      remember(el);
      var y = el.scrollTop;
      host.appendChild(el);
      if (y) requestAnimationFrame(function() {
        el.scrollTop = y;
      });
    }
    function moveHome(el) {
      var any = (
        /** @type {any} */
        el
      );
      var home = any.__home;
      if (!home || !home.parent) return;
      var y = el.scrollTop;
      home.parent.insertBefore(el, home.next);
      if (y) requestAnimationFrame(function() {
        el.scrollTop = y;
      });
    }
    function placeStage() {
      var aside = slot("rightSidebar");
      var host = document.getElementById("shConsoleBody");
      if (!host) return false;
      var missing = host.querySelector("[data-sh-console-missing]");
      if (!aside) {
        if (!host.childElementCount) {
          host.innerHTML = '<div class="sh-hint" data-sh-console-missing><b>\u684C\u9762\u53F3\u680F\u672A\u5C31\u7EEA</b>\u63A7\u5236\u53F0\u8BFB\u53D6\u7684\u662F\u684C\u9762\u53F3\u680F\u300C\u6D3B\u52A8 / \u7FA4\u804A / \u72B6\u6001\u300D\u3002\u53F3\u680F\u6302\u8F7D\u540E\u91CD\u65B0\u6253\u5F00\u63A7\u5236\u53F0\u5373\u53EF\u3002</div>';
        }
        return false;
      }
      if (missing) missing.remove();
      if (aside.parentNode !== host) moveTo(aside, host);
      return true;
    }
    function homeStage() {
      var aside = slot("rightSidebar");
      if (aside) moveHome(aside);
    }
    function capsuleText() {
      var mode = document.getElementById("modeToggle");
      var selEl = document.getElementById("modelSel");
      var sel = selEl instanceof HTMLSelectElement ? selEl : null;
      var modeTxt = "";
      if (mode) {
        var t2 = mode.querySelector(".btn-text");
        modeTxt = ((t2 ? t2.textContent : mode.textContent) || "").trim();
      }
      var modelTxt = "";
      try {
        if (sel && sel.selectedIndex >= 0 && sel.options[sel.selectedIndex]) {
          modelTxt = (sel.options[sel.selectedIndex].textContent || "").trim();
        }
      } catch (e) {
      }
      if (!modelTxt) modelTxt = "\u9009\u62E9\u6A21\u578B";
      return (modeTxt ? modeTxt + " \xB7 " : "") + modelTxt;
    }
    function syncCapsule() {
      var btn = document.getElementById("shCapsule");
      if (!btn) return;
      var txt = capsuleText();
      var label = btn.querySelector(".sh-cap-text");
      if (label && label.textContent !== txt) label.textContent = txt;
      if (btn.title !== txt) btn.title = txt;
      var mode = document.getElementById("modeToggle");
      var mt = "";
      if (mode) {
        var t2 = mode.querySelector(".btn-text");
        mt = ((t2 ? t2.textContent : mode.textContent) || "").trim();
      }
      btn.classList.toggle("is-fast", mt.indexOf("\u5FEB\u901F") >= 0);
    }
    function placeCapsule() {
      var inner = document.querySelector(".topbar-inner");
      if (!inner) return;
      var cap = document.getElementById("shCapsule");
      if (!cap) {
        cap = document.createElement("button");
        cap.id = "shCapsule";
        cap.className = "sh-capsule";
        cap.setAttribute("aria-haspopup", "dialog");
        cap.setAttribute("aria-expanded", "false");
        cap.innerHTML = '<span class="sh-cap-dot" aria-hidden="true"></span><span class="sh-cap-text"></span><svg class="sh-cap-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
        cap.addEventListener("click", function() {
          setCapsule(!capOpen);
        });
      }
      if (cap.parentNode !== inner) {
        var anchor = document.getElementById("modeToggle");
        inner.insertBefore(cap, anchor && anchor.parentNode === inner ? anchor : inner.firstChild);
      }
      var body = document.getElementById("shCapsuleBody");
      var mode = document.getElementById("modeToggle");
      var found = document.querySelector(".model-pill");
      var pill = found instanceof HTMLElement ? found : null;
      if (body && mode && mode.parentNode !== body) moveTo(mode, body);
      if (body && pill && pill.parentNode !== body) moveTo(pill, body);
      syncCapsule();
      if (!capObserver && window.MutationObserver) {
        capObserver = new MutationObserver(syncCapsule);
        if (mode) capObserver.observe(mode, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "title"] });
        var sel = document.getElementById("modelSel");
        if (sel) capObserver.observe(sel, { childList: true, subtree: true, characterData: true, attributes: true });
      }
    }
    function homeCapsule() {
      if (!built) return;
      setCapsule(false);
      var found = document.querySelector(".model-pill");
      var pill = found instanceof HTMLElement ? found : null;
      var mode = document.getElementById("modeToggle");
      if (pill) moveHome(pill);
      if (mode) moveHome(mode);
      if (capObserver) {
        capObserver.disconnect();
        capObserver = null;
      }
    }
    function setCapsule(open) {
      if (!built) return;
      capOpen = !!open;
      html.classList.toggle("shell-cap-open", capOpen);
      var pop = document.getElementById("shCapPop");
      var btn = document.getElementById("shCapsule");
      if (pop) {
        pop.setAttribute("aria-hidden", capOpen ? "false" : "true");
        if (capOpen) {
          var bar = document.getElementById("topbar");
          var bottom = bar ? Math.round(bar.getBoundingClientRect().bottom) : 52;
          pop.style.top = Math.max(0, bottom) + "px";
          syncCapsule();
        }
      }
      if (btn) btn.setAttribute("aria-expanded", capOpen ? "true" : "false");
    }
    var ICONS = {
      // 对话：单气泡
      chat: '<path d="M20.5 11.3a7.7 7.7 0 0 1-11 6.96L4 19.5l1.26-5.34A7.7 7.7 0 1 1 20.5 11.3z"/>',
      // 沙盘：等距台面 + 分格 —— 地图、挂载页、图片、文档都摆在这个面上
      work: '<path d="M3 8.5l9-4 9 4-9 4z"/><path d="M3 8.5v7l9 4 9-4v-7"/><path d="M12 12.5v7"/><path d="M7.5 10.4l4.5 2 4.5-2"/>',
      // 控制台：三根滑杆（活动 / 群聊 / 状态的调节面，不是展示面）
      console: '<path d="M4 7h16M4 12h16M4 17h16"/><circle cx="9" cy="7" r="2.1"/><circle cx="15" cy="12" r="2.1"/><circle cx="8" cy="17" r="2.1"/>'
    };
    var CLOSE_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    var MAP_URL_KEY = "cfw_panel_map_url_v1";
    var KIND_ICON = {
      map: ICONS.work,
      mount: '<rect x="4" y="3.5" width="16" height="17" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
      image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17l5-4 4 3 3-2 4 3"/>',
      doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>'
    };
    var EMPTY = {
      all: ["\u6C99\u76D8\u662F\u4EC0\u4E48", "agent \u6302\u4E0A\u6765\u7684\u5C55\u793A\u9875\u3001\u5730\u56FE\u3001\u8BA8\u8BBA\u533A\u4E0E\u6587\u6863\uFF0C\u90FD\u6446\u5728\u8FD9\u4E2A\u5185\u5BB9\u53F0\u9762\u4E0A\uFF1B\u70B9\u5361\u7247\u5728\u9875\u5185\u6253\u5F00\uFF0C\u4E0D\u8DF3\u8D70\u5BF9\u8BDD\u3002\u63A7\u5236\u53F0\u662F\u53E6\u4E00\u5757\u9762\uFF1A\u5E95\u680F\u300C\u63A7\u5236\u53F0\u300D\u6253\u5F00\u684C\u9762\u53F3\u680F\u7684\u6D3B\u52A8 / \u7FA4\u804A / \u72B6\u6001\u3002"],
      mount: ["\u8FD8\u6CA1\u6709\u6302\u8F7D\u5185\u5BB9", "agent \u7528 stage_open \u6302\u4E0A\u6765\u7684\u5C55\u793A\u9875\u4F1A\u6536\u5728\u8FD9\u91CC\uFF1B\u684C\u9762\u53F3\u680F\u4E0E\u624B\u673A\u6C99\u76D8\u5171\u7528\u540C\u4E00\u4EFD\u6807\u7B7E\u72B6\u6001\u673A\u3002"],
      map: ["\u5730\u56FE\u5165\u53E3", "\u6C99\u76D8\u662F\u72EC\u7ACB\u4ED3\uFF0C\u5730\u5740\u5728\u300C\u8BBE\u7F6E \u2192 \u5185\u5BB9\u9762\u677F\u300D\u91CC\u586B\uFF1BGEO \u5730\u56FE\u53EA\u6709\u914D\u4E86\u5730\u5740\u624D\u51FA\u73B0\u3002"],
      image: ["\u56FE\u7247\u7D22\u5F15\u672A\u63A5", "\u5BF9\u8BDD\u91CC\u751F\u6210\u7684\u63D2\u56FE\u4E0E\u5F62\u8C61\u5361\u6682\u65F6\u4ECD\u56DE\u5BF9\u8BDD\u67E5\u770B\uFF1B\u8FD9\u91CC\u5148\u7559\u4F4D\uFF0C\u7B49\u4EA7\u7269\u7D22\u5F15\u843D\u5730\u518D\u586B\uFF0C\u4E0D\u9020\u7A7A\u6E05\u5355\u3002"],
      doc: ["\u6587\u6863\u7D22\u5F15\u672A\u63A5", "\u5BFC\u51FA\u7684\u6587\u6863\u4E0E\u62A5\u544A\u6682\u65F6\u4ECD\u56DE\u5BF9\u8BDD\u6216\u4E0B\u8F7D\u67E5\u770B\uFF1B\u8FD9\u91CC\u5148\u7559\u4F4D\uFF0C\u7B49\u4EA7\u7269\u7D22\u5F15\u843D\u5730\u518D\u586B\uFF0C\u4E0D\u9020\u7A7A\u6E05\u5355\u3002"]
    };
    var tabs = window.panelTabs.empty();
    var stageSpec = null;
    var stageTabId = "";
    var pageSeq = 0;
    var workSeg = "all";
    var panelOrig = null;
    function esc(s) {
      return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }
    function iconSvg(paths, size) {
      var n = size || 22;
      return '<svg width="' + n + '" height="' + n + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + "</svg>";
    }
    function readStoredUrl(key) {
      try {
        return String(localStorage.getItem(key) || "").trim();
      } catch (e) {
        return "";
      }
    }
    function pages() {
      var cat = window.toolCatalog && typeof window.toolCatalog.entries === "function" ? window.toolCatalog.entries() : [];
      var fromCatalog = window.panelTabs.pagesFromCatalog(cat, { panel: true });
      var host = window.panelTabs.hostPages({ geoUrl: readStoredUrl(MAP_URL_KEY), views: window.sandboxViews });
      return window.panelTabs.mergePages(fromCatalog, host);
    }
    function specOf(tab) {
      if (!tab) return null;
      var c = window.panelTabs.contentOf(tab, pages());
      if (!c) return null;
      var spec = { title: String(c.title || tab.title), mode: c.mode };
      if (c.url) spec.url = c.url;
      if (c.html) spec.html = c.html;
      if (c.text) spec.text = c.text;
      return spec;
    }
    function allItems() {
      var list = [];
      tabs.tabs.forEach(function(t2) {
        var c = window.panelTabs.contentOf(t2, pages());
        var sub = c && c.url ? String(c.url) : c && c.html ? "\u5185\u8054 HTML" : "\u7EAF\u6587\u672C";
        list.push({ id: t2.id, title: t2.title, sub, kind: "mount", url: c && c.url ? String(c.url) : "" });
      });
      pages().forEach(function(pg) {
        list.push({
          id: "page:" + pg.id,
          title: pg.label,
          sub: pg.href || "\u672A\u914D\u7F6E \xB7 \u6253\u5F00\u770B\u542F\u52A8\u5F15\u5BFC",
          kind: pg.id === "sandbox" || pg.id === "starmap" || pg.id === "map" ? "map" : "mount",
          url: pg.href || ""
        });
      });
      return list;
    }
    function cardHtml(it) {
      return '<button type="button" class="sh-card" data-open="' + esc(it.id) + '"><span class="th">' + iconSvg(KIND_ICON[it.kind] || KIND_ICON.mount) + '</span><span class="tt2">' + esc(it.title) + '</span><span class="ss">' + esc(it.sub) + "</span></button>";
    }
    function renderWork(which) {
      if (which) workSeg = which;
      var panes = document.getElementById("shWorkPanes");
      if (!panes) return;
      var items = allItems().filter(function(it) {
        return workSeg === "all" || it.kind === workSeg;
      });
      var html2 = items.length ? '<div class="sh-grid">' + items.map(cardHtml).join("") + "</div>" : "";
      var e = EMPTY[workSeg] || EMPTY.all;
      html2 += '<div class="sh-hint"><b>' + esc(e[0]) + "</b>" + esc(e[1]) + "</div>";
      panes.innerHTML = html2;
    }
    function markNew(on) {
      var b = document.querySelector('.sh-item[data-page="work"]');
      if (b) b.classList.toggle("has-new", !!on);
    }
    var callSeq = 0;
    function stageCall(fn, args, timeoutMs, id) {
      var name = String(fn || "").trim();
      if (!name) return Promise.reject(new Error("stage_call \u9700\u8981 fn"));
      var target = id ? window.panelTabs.byId(tabs, id) : window.panelTabs.active(tabs);
      if (!target) return Promise.reject(new Error("\u753B\u5E03\u662F\u7A7A\u7684 \u2014\u2014 \u5148\u7528 stage_open \u6253\u5F00\u4E00\u4E2A\u9875\u9762"));
      if (target.id !== tabs.activeId) {
        tabs = window.panelTabs.activate(tabs, target.id);
        renderWork();
        showTab(window.panelTabs.active(tabs));
      }
      var found = document.querySelector("#shStageBox iframe");
      var f = found instanceof HTMLIFrameElement ? found : null;
      var win = f && f.contentWindow;
      if (!win) return Promise.reject(new Error("\u6C99\u76D8\u753B\u5E03\u8FD8\u6CA1\u5C31\u7EEA \u2014\u2014 \u5148\u5728\u6C99\u76D8\u9875\u6253\u5F00\u8FD9\u4E2A\u5185\u5BB9"));
      var ms = Math.max(1e3, Math.min(12e4, parseInt(String(timeoutMs || 0), 10) || 15e3));
      var callId = "sh" + ++callSeq;
      return new Promise(function(resolve, reject) {
        function cleanup() {
          window.removeEventListener("message", onMsg);
          clearTimeout(timer);
        }
        function onMsg(ev) {
          var d = ev.data || {};
          if (!d || d.__panel !== 1 || d.type !== "call-result" || !d.data || d.data.id !== callId) return;
          if (ev.source && ev.source !== win) return;
          cleanup();
          if (d.data.ok) resolve(d.data.result);
          else reject(new Error(d.data.error || "\u753B\u5E03\u8C03\u7528\u5931\u8D25"));
        }
        var timer = setTimeout(function() {
          cleanup();
          reject(new Error("\u753B\u5E03\u6CA1\u6709\u56DE\u5E94 " + name + "\uFF08" + Math.round(ms / 1e3) + " \u79D2\uFF09"));
        }, ms);
        window.addEventListener("message", onMsg);
        try {
          win.postMessage({ __panel: 1, type: "call", data: { id: callId, fn: name, args } }, "*");
        } catch (e) {
          cleanup();
          reject(e);
        }
      });
    }
    function openStage(spec, tabId) {
      build();
      spec = spec || {};
      var host = document.getElementById("shStage");
      var box = document.getElementById("shStageBox");
      var titleEl = document.getElementById("shStageTitle");
      if (!host || !box) return;
      if (titleEl) titleEl.textContent = String(spec.title || "\u5185\u5BB9");
      var same = !!tabId && tabId === stageTabId && !!box.firstChild;
      if (!same) {
        stageTabId = tabId || "";
        box.innerHTML = "";
        if (spec.text != null && !spec.url && spec.html == null) {
          var pre = document.createElement("pre");
          pre.className = "sh-stage-text";
          pre.textContent = String(spec.text);
          box.appendChild(pre);
        } else {
          var f = document.createElement("iframe");
          f.setAttribute("title", String(spec.title || "\u6C99\u76D8\u5185\u5BB9"));
          f.setAttribute("loading", "lazy");
          if (spec.mode === "host-html" || spec.mode === "external") f.setAttribute("sandbox", "allow-scripts allow-forms allow-popups");
          if (spec.url) f.src = String(spec.url);
          else f.srcdoc = String(spec.html || "");
          box.appendChild(f);
        }
      }
      stageSpec = spec;
      host.hidden = false;
    }
    function closeStage(clear) {
      var host = document.getElementById("shStage");
      if (host) host.hidden = true;
      if (!clear) return;
      var box = document.getElementById("shStageBox");
      if (box) box.innerHTML = "";
      stageSpec = null;
      stageTabId = "";
    }
    function openStageWindow() {
      if (!stageSpec || !stageSpec.url) return;
      try {
        window.open(String(stageSpec.url), "_blank", "noopener");
      } catch (e) {
      }
    }
    function showTab(tab) {
      var spec = specOf(tab);
      if (!spec) {
        closeStage(true);
        return;
      }
      openStage(spec, tab ? tab.id : "");
      markNew(false);
    }
    function openPageItem(pageId) {
      tabs = window.panelTabs.open(tabs, { pageId }, pages(), { now: Date.now(), seq: ++pageSeq });
      renderWork();
      showTab(window.panelTabs.active(tabs));
    }
    function openStageById(id) {
      var key = String(id || "");
      if (key.indexOf("page:") === 0) {
        openPageItem(key.slice(5));
        return;
      }
      var next = window.panelTabs.activate(tabs, key);
      if (next !== tabs) {
        tabs = next;
        renderWork();
        showTab(window.panelTabs.active(tabs));
        return;
      }
      var page = window.panelTabs.findPageById(key, pages());
      if (page) openPageItem(page.id);
    }
    function patchPanel() {
      var p = api("panel");
      if (!p || p.v !== 1) return;
      if (!panelOrig) {
        panelOrig = {
          open: p.open,
          openPage: p.openPage,
          expand: p.expand,
          close: p.close,
          state: p.state,
          view: p.view,
          tools: p.tools,
          call: p.call
        };
      }
      p.open = function(spec) {
        spec = spec || {};
        tabs = window.panelTabs.open(tabs, spec, pages(), { now: Date.now(), seq: ++pageSeq });
        var tab = window.panelTabs.active(tabs);
        if (!tab) return { ok: false, error: "\u81F3\u5C11\u7ED9 page / url / html / text \u4E4B\u4E00\u3002" };
        var nextSpec = specOf(tab);
        renderWork();
        stageSpec = nextSpec;
        if (current === "work") {
          if (nextSpec) openStage(nextSpec, tab.id);
          markNew(false);
        } else {
          markNew(true);
        }
        return { ok: true, mode: nextSpec ? nextSpec.mode : "", title: tab.title, id: tab.id };
      };
      p.openPage = function(id) {
        return p.open({ pageId: id });
      };
      p.expand = function() {
        go("work");
      };
      p.close = function(id) {
        var target = id || tabs.activeId;
        if (!target) return { ok: true, id: "" };
        var next = window.panelTabs.close(tabs, target, { now: Date.now() });
        if (next === tabs) return { ok: false, error: "\u6CA1\u6709\u8FD9\u4E2A\u6807\u7B7E\uFF1A" + target };
        tabs = next;
        renderWork();
        if (stageTabId === target) {
          var active = window.panelTabs.active(tabs);
          if (active) showTab(active);
          else closeStage(true);
        }
        markNew(false);
        return { ok: true, id: target };
      };
      p.state = function() {
        var tab = window.panelTabs.active(tabs);
        return {
          expanded: current === "work",
          width: window.innerWidth,
          view: stageSpec ? "canvas" : "activity",
          tab: "fishbowl",
          hasContent: tabs.tabs.length > 0,
          activeId: tabs.activeId,
          title: tab ? tab.title : "",
          tabs: tabs.tabs.map(function(t2) {
            return { id: t2.id, title: t2.title, pageId: t2.pageId, icon: t2.icon, active: t2.id === tabs.activeId };
          }),
          catalog: pages().map(function(pg) {
            return { id: pg.id, title: pg.label, url: pg.href || "", icon: pg.icon || "" };
          })
        };
      };
      p.view = function(name) {
        if (name !== "canvas" || !stageSpec) return;
        go("work");
        var tab = window.panelTabs.active(tabs);
        if (tab) showTab(tab);
      };
      p.tools = function() {
        return pages().map(function(pg) {
          return { id: pg.id, title: pg.label, url: pg.href || "", icon: pg.icon || "" };
        });
      };
      p.call = stageCall;
    }
    function unpatchPanel() {
      var p = api("panel");
      if (!p || !panelOrig) return;
      Object.keys(panelOrig).forEach(function(k) {
        p[k] = panelOrig[k];
      });
      panelOrig = null;
    }
    function dockItem(key, label, panel) {
      var cls = "sh-item" + (key === "chat" && !panel ? " on" : "");
      var attr = panel ? 'data-panel="console"' : 'data-page="' + key + '"';
      var aria = panel ? 'role="button" aria-label="\u63A7\u5236\u53F0\uFF08\u684C\u9762\u53F3\u680F \xB7 \u6D3B\u52A8 / \u7FA4\u804A / \u72B6\u6001\uFF0C\u8986\u76D6\u5728\u5F53\u524D\u9875\u4E4B\u4E0A\uFF09" aria-expanded="false" aria-controls="shConsole"' : 'aria-label="' + label + '"';
      return '<button class="' + cls + '" ' + attr + " " + aria + '><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[key] + "</svg><span>" + label + "</span></button>";
    }
    function head(title, sub) {
      return '<div class="sh-head"><h2>' + title + "</h2>" + (sub ? '<span class="sh-sub">' + sub + "</span>" : "") + '<button class="sh-close" data-back="1" aria-label="\u8FD4\u56DE\u5BF9\u8BDD">' + CLOSE_ICON + "</button></div>";
    }
    function build() {
      if (built) return;
      injectCss();
      var wrap = document.createElement("div");
      wrap.id = "mobileShell";
      wrap.innerHTML = '<div class="sh-body"><section class="sh-page on" data-page="chat" aria-label="\u5BF9\u8BDD"></section><section class="sh-page" data-page="work" aria-label="\u6C99\u76D8">' + head("\u6C99\u76D8", "\u5185\u5BB9\u53F0\u9762") + '<div class="sh-body-in" id="shWorkBody"><div class="sh-seg" id="shWorkSeg"><button data-seg="all" class="on">\u5168\u90E8</button><button data-seg="mount">\u6302\u8F7D</button><button data-seg="map">\u5730\u56FE</button><button data-seg="image">\u56FE\u7247</button><button data-seg="doc">\u6587\u6863</button></div><div class="sh-panes" id="shWorkPanes"></div></div><section class="sh-stage" id="shStage" hidden aria-label="\u6C99\u76D8\u5185\u5BB9"><div class="sh-stage-bar"><button class="sh-stage-btn" data-stage-back="1" aria-label="\u8FD4\u56DE\u6C99\u76D8">\u8FD4\u56DE</button><b id="shStageTitle">\u5185\u5BB9</b><button class="sh-stage-btn" data-stage-open="1" aria-label="\u5728\u65B0\u7A97\u53E3\u6253\u5F00">\u65B0\u7A97</button></div><div class="sh-stage-box" id="shStageBox"></div></section></section><div class="sh-scrim" data-close-console="1" aria-hidden="true"></div><section class="sh-console" id="shConsole" role="dialog" aria-label="\u63A7\u5236\u53F0\uFF08\u684C\u9762\u53F3\u680F\uFF1A\u6D3B\u52A8 / \u7FA4\u804A / \u72B6\u6001\uFF09" aria-hidden="true"><div class="sh-head"><h2>\u63A7\u5236\u53F0</h2><span class="sh-sub">\u6D3B\u52A8 / \u7FA4\u804A / \u72B6\u6001</span><button class="sh-close" data-close-console="1" aria-label="\u6536\u8D77\u63A7\u5236\u53F0">' + CLOSE_ICON + '</button></div><div class="sh-body-in" id="shConsoleBody"></div></section></div><div class="sh-cap-scrim" data-close-cap="1" aria-hidden="true"></div><section class="sh-cap-pop" id="shCapPop" role="dialog" aria-label="\u6A21\u5F0F\u4E0E\u6A21\u578B" aria-hidden="true"><div class="sh-head"><h2>\u6A21\u5F0F\u4E0E\u6A21\u578B</h2><span class="sh-sub">\u514D\u8D39 / \u5FEB\u901F \xB7 \u6A21\u578B</span><button class="sh-close" data-close-cap="1" aria-label="\u6536\u8D77">' + CLOSE_ICON + '</button></div><div class="sh-cap-body" id="shCapsuleBody"></div><div class="sh-cap-tip">\u9876\u680F\u653E\u4E0D\u4E0B\u7684\u63A7\u4EF6\u6536\u5728\u8FD9\u91CC\uFF0C\u6539\u5B8C\u76F4\u63A5\u751F\u6548\uFF1B\u684C\u9762\u7AEF\u4F1A\u81EA\u52A8\u642C\u56DE\u9876\u680F\u539F\u4F4D\u3002</div></section><nav class="sh-dock" aria-label="\u4E3B\u5BFC\u822A">' + dockItem("chat", "\u5BF9\u8BDD") + dockItem("work", "\u6C99\u76D8") + dockItem("console", "\u63A7\u5236\u53F0", true) + "</nav>";
      document.body.appendChild(wrap);
      wrap.addEventListener("click", function(e) {
        var t2 = (
          /** @type {HTMLElement} */
          e.target
        );
        if (!t2.closest) return;
        if (t2.closest("[data-close-cap]")) {
          setCapsule(false);
          return;
        }
        var close = t2.closest("[data-close-console]");
        if (close) {
          setConsole(false);
          return;
        }
        var panelBtn = t2.closest("[data-panel]");
        if (panelBtn) {
          setConsole(!consoleOpen);
          return;
        }
        var card = t2.closest("[data-open]");
        if (card) {
          openStageById(
            /** @type {HTMLElement} */
            card.dataset.open
          );
          return;
        }
        if (t2.closest("[data-stage-back]")) {
          closeStage(false);
          return;
        }
        if (t2.closest("[data-stage-open]")) {
          openStageWindow();
          return;
        }
        var item = (
          /** @type {HTMLElement} */
          t2.closest(".sh-item")
        );
        if (item && item.dataset.page) {
          go(
            /** @type {'chat'|'work'} */
            item.dataset.page
          );
          return;
        }
        if (t2.closest("[data-back]")) {
          go("chat");
          return;
        }
        var seg = t2.closest("[data-seg]");
        if (seg) {
          var which = (
            /** @type {HTMLElement} */
            seg.dataset.seg
          );
          var box = document.getElementById("shWorkBody");
          if (!box) return;
          box.querySelectorAll("[data-seg]").forEach(function(b) {
            b.classList.toggle(
              "on",
              /** @type {HTMLElement} */
              b.dataset.seg === which
            );
          });
          renderWork(which);
        }
      });
      document.addEventListener("keydown", function(e) {
        if (e.key !== "Escape") return;
        var stage = document.getElementById("shStage");
        if (stage && !stage.hidden) {
          closeStage(false);
          return;
        }
        if (capOpen) {
          setCapsule(false);
          return;
        }
        if (consoleOpen) setConsole(false);
      });
      built = true;
      renderWork("all");
    }
    function setConsole(open) {
      build();
      consoleOpen = !!open;
      if (consoleOpen) {
        setCapsule(false);
        placeStage();
      }
      html.classList.toggle("shell-console-open", consoleOpen);
      var panel = document.getElementById("shConsole");
      if (panel) panel.setAttribute("aria-hidden", consoleOpen ? "false" : "true");
      var btn = document.querySelector("[data-panel]");
      if (btn) btn.setAttribute("aria-expanded", consoleOpen ? "true" : "false");
      document.querySelectorAll(".sh-item[data-panel]").forEach(function(b) {
        b.classList.toggle("on", consoleOpen);
      });
    }
    function go(page) {
      if (page === "stage" || page === "console") {
        setConsole(true);
        return;
      }
      build();
      if (consoleOpen) setConsole(false);
      if (capOpen) setCapsule(false);
      var enteringWork = page === "work" || page === "sandbox";
      current = enteringWork ? "work" : "chat";
      if (enteringWork) {
        var badge = document.querySelector('.sh-item[data-page="work"].has-new');
        if (badge && stageSpec) {
          var active = window.panelTabs.active(tabs);
          openStage(stageSpec, active ? active.id : "");
        }
        markNew(false);
      }
      var shell = document.getElementById("mobileShell");
      if (!shell) return;
      shell.querySelectorAll(".sh-page").forEach(function(p) {
        p.classList.toggle(
          "on",
          /** @type {HTMLElement} */
          p.dataset.page === current
        );
      });
      shell.querySelectorAll(".sh-item[data-page]").forEach(function(b) {
        b.classList.toggle(
          "on",
          /** @type {HTMLElement} */
          b.dataset.page === current
        );
      });
      html.classList.toggle("shell-chat", current === "chat");
    }
    function apply() {
      var on = FORCE || MQ.matches;
      if (!on) {
        html.classList.remove("shell-mobile", "shell-chat", "shell-console-open", "shell-cap-open");
        if (built) setConsole(false);
        consoleOpen = false;
        unpatchPanel();
        homeCapsule();
        homeStage();
        return;
      }
      build();
      html.classList.add("shell-mobile");
      go(current);
      placeCapsule();
      patchPanel();
      if (bootConsole) {
        setConsole(true);
        bootConsole = false;
      }
      if (bootCap) {
        setCapsule(true);
        bootCap = false;
      }
    }
    var permSurfaced = false;
    window.addEventListener("cfw:perm-pending", function() {
      if (!html.classList.contains("shell-mobile")) return;
      if (!permSurfaced && !consoleOpen) permSurfaced = true;
      setConsole(true);
      var foundTab = document.querySelector('#rightSidebar .rs-tab[data-rs-tab="fishbowl"]');
      var tab = foundTab instanceof HTMLElement ? foundTab : null;
      if (tab && !tab.classList.contains("active")) tab.click();
    });
    window.addEventListener("cfw:perm-resolved", function() {
      if (!permSurfaced) return;
      permSurfaced = false;
      if (html.classList.contains("shell-mobile") && consoleOpen) setConsole(false);
    });
    window.addEventListener("panel:config-changed", function() {
      if (!html.classList.contains("shell-mobile") || current !== "work") return;
      if (!window.panelTabs) return;
      renderWork(workSeg);
      var active = window.panelTabs.active(tabs);
      if (active) showTab(active);
    });
    var t = 0;
    function schedule() {
      window.clearTimeout(t);
      t = window.setTimeout(apply, 80);
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", apply);
    } else {
      apply();
    }
    if (MQ.addEventListener) MQ.addEventListener("change", schedule);
    else if (MQ.addListener) MQ.addListener(schedule);
    window.__shell = {
      version: VERSION,
      go,
      apply,
      console: setConsole,
      capsule: setCapsule,
      syncCapsule,
      slot,
      api,
      /** 沙盘内容舞台：外部（agent 工具 / 调试）可直接挂一份内容进来 */
      stage: {
        open: function(spec) {
          go("work");
          openStage(spec);
        },
        close: function() {
          closeStage(true);
        },
        state: function() {
          return { hasContent: !!stageSpec, title: stageSpec ? String(stageSpec.title || "") : "" };
        },
        items: function() {
          return allItems().map(function(it) {
            return { id: it.id, title: it.title, kind: it.kind, url: it.url || "" };
          });
        }
      },
      get page() {
        return current;
      },
      get consoleOpen() {
        return consoleOpen;
      },
      get capsuleOpen() {
        return capOpen;
      }
    };
  })();
})();
