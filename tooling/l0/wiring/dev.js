// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/dev/console.ts; this file owns every
// side effect around it: the fetch interception that feeds the capture ring, IndexedDB persistence,
// the Dev Panel / HUD rendering, the settings card, and the long-press entry points.
//
// Load order: after the auth wrapper (this patch must wrap the Authorization injection) and before
// the unlock gate (whose own patch stacks on top of this one). Two globals are assigned here and
// read elsewhere: the console handle (which app.js later spreads and overrides member by member,
// so the closure state below stays reachable even after that) and the I/O tool registrar consumed
// by the agent registry.
//
// UI strings stay Chinese on purpose: user-visible copy is not translated.
(function () {
  "use strict";
  var KEY = DEV_CONSOLE_MODE_KEY;
  var DBG = DEV_DEBUG_KEY;
  var IO_REC_KEY = IO_RECORD_KEY;
  var OVR_KEY = DEV_OVERRIDES_KEY;
  var HUD_KEY = DEV_HUD_KEY;
  var isOn = function () { return localStorage.getItem(KEY) === "1"; };

  var setLastPayload = function (p) {
    var requestBytes = 0;
    try { requestBytes = new Blob([JSON.stringify(p || {})]).size; } catch (e) { try { requestBytes = JSON.stringify(p || {}).length; } catch (_) {} }
    return recordPayload(p, Date.now(), requestBytes, isOn());
  };

  // Public handle. Member names and count are frozen: app.js spreads this object and overrides
  // its own members on top, so removing or renaming one here silently changes what survives.
  var api = {
    isOn: isOn,
    debug: localStorage.getItem(DBG) === "1",
    log: function (...a) { if (api.debug) console.log("[dev]", ...a); },
    enable: function () { localStorage.setItem(KEY, "1"); location.reload(); },
    disable: function () { localStorage.removeItem(KEY); location.reload(); },
    toggle: toggleDev,
    exportLS: exportCfwLs,
    setLastPayload: setLastPayload,
    openPanel: openPanel,
  };
  window.devSvc = api;

  // Unified toast: forward to the shared themed component when present, fall back to a bare
  // fixed-position div so a page without the feedback bundle still gets feedback.
  function toast(msg, ms) {
    if (window.feedbackSvc && window.feedbackSvc.toast) return window.feedbackSvc.toast(msg, { ms: ms });
    var t = document.createElement("div");
    t.textContent = msg;
    t.style.cssText = "position:fixed;left:50%;top:24px;transform:translateX(-50%);padding:10px 18px;background:rgba(0,0,0,.88);color:#fff;border-radius:10px;font-size:13px;font-weight:600;z-index:99999;box-shadow:0 6px 20px rgba(0,0,0,.4);backdrop-filter:blur(8px);";
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, ms || 1200);
    return t;
  }

  // Toggle with a 1s delayed reload so the toast is actually readable before the page goes away.
  function toggleDev() {
    var cur = isOn();
    if (cur) localStorage.removeItem(KEY); else localStorage.setItem(KEY, "1");
    try { navigator.vibrate && navigator.vibrate([30, 60, 30]); } catch {}
    toast((cur ? "[关] 开发者模式 OFF" : "[开] 开发者模式 ON") + " · 1 秒后刷新", 1000);
    setTimeout(function () { location.reload(); }, 1000);
  }

  // Every [data-dev-only] element is hidden unless the mode is on; the html class carries the rest.
  function applyVisibility() {
    document.documentElement.classList.toggle("dev-mode", isOn());
    document.querySelectorAll("[data-dev-only]").forEach(function (el) {
      el.style.display = isOn() ? "" : "none";
    });
  }

  // The badge is the topbar button (itself data-dev-only); short press opens the panel, a 1.5s
  // hold toggles the mode off. Any leftover fixed badge from the pre-4.18 layout is removed.
  function ensureBadge() {
    var old = document.getElementById("dev-badge");
    if (old) old.remove();
    var b = document.getElementById("devBadgeTopbar");
    if (!b) return;
    if (b.dataset.wired === "1") return;
    b.dataset.wired = "1";
    var t = null, fired = false;
    b.addEventListener("pointerdown", function () { fired = false; if (t) clearTimeout(t); t = setTimeout(function () { fired = true; toggleDev(); }, 1500); });
    b.addEventListener("pointerup", function () { if (t) { clearTimeout(t); t = null; } });
    b.addEventListener("pointerleave", function () { if (t) { clearTimeout(t); t = null; } });
    b.addEventListener("pointercancel", function () { if (t) { clearTimeout(t); t = null; } });
    b.addEventListener("click", function (e) { if (fired) { fired = false; e.preventDefault(); e.stopPropagation(); return; } openPanel(); });
  }

  // Easter egg: hold the GitHub button 1.2s to toggle. Visual charge-up (scale + expanding glow)
  // and three-stage vibration exist because the original silent 2s hold read as "nothing happened".
  function wireGithubLongPress() {
    var g = document.getElementById("githubBtn");
    if (!g) return;
    var lpT = null, lpF = false, vibT = null;
    var HOLD_MS = 1200;
    function start() {
      lpF = false;
      if (lpT) clearTimeout(lpT);
      g.style.transition = "transform .15s ease, box-shadow .15s ease";
      g.style.transform = "scale(0.92)";
      g.style.boxShadow = "0 0 0 0 rgba(127,164,201,.6)";
      requestAnimationFrame(function () {
        g.style.transition = "transform .15s ease, box-shadow " + HOLD_MS + "ms ease";
        g.style.boxShadow = "0 0 0 18px rgba(127,164,201,0)";
      });
      try { navigator.vibrate && navigator.vibrate(15); } catch {}
      vibT = setTimeout(function () { try { navigator.vibrate && navigator.vibrate(25); } catch {} }, 600);
      lpT = setTimeout(function () {
        lpF = true;
        try { navigator.vibrate && navigator.vibrate([40, 30, 40, 30, 80]); } catch {}
        toggleDev();
      }, HOLD_MS);
    }
    function cancel() {
      if (lpT) { clearTimeout(lpT); lpT = null; }
      if (vibT) { clearTimeout(vibT); vibT = null; }
      g.style.transform = "";
      g.style.boxShadow = "";
      g.style.transition = "";
    }
    g.addEventListener("pointerdown", start);
    g.addEventListener("pointerup", cancel);
    g.addEventListener("pointerleave", cancel);
    g.addEventListener("pointercancel", cancel);
    g.addEventListener("click", function (e) { if (lpF) { e.preventDefault(); e.stopPropagation(); lpF = false; } });
    g.addEventListener("contextmenu", function (e) { if (lpT || lpF) e.preventDefault(); });
  }

  // Topbar sync-pause button (dev-only): mirrors the sync engine's paused state as icon + title.
  function wireSyncPauseBtn() {
    var btn = document.getElementById("syncPauseBtn");
    if (!btn) return;
    var PAUSE_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5v14M15 5v14"/></svg>';
    var RESUME_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
    function refresh() {
      var paused = window.syncSvc && window.syncSvc.isPaused && window.syncSvc.isPaused();
      btn.innerHTML = paused ? RESUME_SVG : PAUSE_SVG;
      btn.title = paused ? "恢复同步(目前已暂停)" : "暂停同步(临时不推 KV,避免乱聊污染云端)";
      btn.style.background = paused ? "rgba(255,160,80,0.25)" : "";
    }
    btn.addEventListener("click", function () {
      if (!window.syncSvc) return;
      if (window.syncSvc.isPaused()) window.syncSvc.resume();
      else window.syncSvc.pause();
      refresh();
      toast(window.syncSvc.isPaused() ? "⏸ 同步已暂停" : "▶ 同步已恢复", 1200);
    });
    refresh();
  }

  // Per-panel-call overrides: the fetch layer reads them on every chat request; the only writer
  // today is the console (the panel editor for them is the dead section noted above).
  var ovr = (function () { try { return JSON.parse(localStorage.getItem(OVR_KEY) || "{}") || {}; } catch (e) { return {}; } })();
  var fault = null;
  var faultMs = 4000;
  var hud = { inflight: false, ms: 0, bytes: 0, at: 0, model: "" };

  function ioRecordOn() {
    try { return ioRecordEnabled(isOn(), localStorage.getItem(IO_REC_KEY)); } catch (e) { return false; }
  }

  var mask = null;

  // --- IndexedDB persistence (records survive reload; never cloud-synced: local debug data,
  // single entries can reach hundreds of KB and syncing them would only burn KV quota). ---
  var IO_DB = "cfw_dev_io_v1", IO_STORE = "entries";
  var IO_KEEP_ = IO_KEEP, IO_LOAD_ = IO_LOAD;
  var _ioDb = null, ioErr = "", histLoaded = false;
  function ioUpgrade(db) {
    if (db.objectStoreNames.contains(IO_STORE)) return;
    var os = db.createObjectStore(IO_STORE, { keyPath: "id" });
    try { os.createIndex("at", "at"); } catch (e) {}
  }
  function ioDb() {
    if (_ioDb) return Promise.resolve(_ioDb);
    return new Promise(function (res) {
      try {
        var r = indexedDB.open(IO_DB, 1);
        r.onupgradeneeded = function () { ioUpgrade(r.result); };
        r.onsuccess = function () {
          var db = r.result;
          // Store missing while the DB exists (interrupted upgrade / another instance created it
          // first): bump the version to re-run the upgrade, otherwise every transaction throws
          // NotFoundError and records are silently dropped.
          if (!db.objectStoreNames.contains(IO_STORE)) {
            var v = db.version + 1; db.close();
            var r2 = indexedDB.open(IO_DB, v);
            r2.onupgradeneeded = function () { ioUpgrade(r2.result); };
            r2.onsuccess = function () { _ioDb = r2.result; res(_ioDb); };
            r2.onerror = function () { ioErr = "IndexedDB 自愈失败,记录只留在内存"; res(null); };
            r2.onblocked = function () { ioErr = "IndexedDB 自愈被占用(关掉其它标签页再试)"; res(null); };
            return;
          }
          _ioDb = db; res(_ioDb);
        };
        r.onerror = function () { ioErr = "IndexedDB 打不开,记录只留在内存"; res(null); };
        r.onblocked = function () { ioErr = "IndexedDB 被其它标签页占用"; res(null); };
      } catch (e) { ioErr = "IndexedDB 不可用:" + e; res(null); }
    });
  }
  function ioTx(mode) { return ioDb().then(function (db) { return db ? db.transaction(IO_STORE, mode).objectStore(IO_STORE) : null; }).catch(function () { return null; }); }
  function ioReqP(r) { return new Promise(function (res) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { res(null); }; }); }
  // Oldest-first deletion by the `at` index once the store holds more than IO_KEEP.
  function ioTrimOld(os) {
    return ioReqP(os.count()).then(function (n) {
      if (!n || n <= IO_KEEP_) return null;
      var drop = n - IO_KEEP_;
      return new Promise(function (res) {
        var cur = os.index("at").openCursor();
        cur.onsuccess = function () { var c = cur.result; if (!c || drop <= 0) { res(null); return; } c.delete(); drop--; c.continue(); };
        cur.onerror = function () { res(null); };
      });
    });
  }
  // Fire-and-forget: persistence must never block or break the request it is recording.
  function ioPersist(e) {
    if (!e || e.fromHist || !ioRecordOn()) return;
    var rec = capIoRecord(shapeIoRecord(e));
    ioTx("readwrite").then(function (os) {
      if (!os) return null;
      return ioReqP(os.put(rec)).then(function () { return ioTrimOld(os); });
    }).catch(function (err) {
      ioErr = "写入失败:" + ((err && err.name) || err);
      try { if (mask && mask.style.display !== "none") renderPanel(); } catch (_) {}
    });
  }
  // Restores at most IO_LOAD records into the ring, once per page load.
  function ioLoadHistory() {
    if (histLoaded) return Promise.resolve();
    histLoaded = true;
    return ioTx("readonly").then(function (os) {
      if (!os) return null;
      var out = [];
      return new Promise(function (res) {
        var cur = os.index("at").openCursor(null, "prev"); // newest → oldest
        cur.onsuccess = function () { var c = cur.result; if (!c || out.length >= IO_LOAD_) { res(out); return; } out.push(c.value); c.continue(); };
        cur.onerror = function () { res(out); };
      }).then(function (recs) {
        mergeHistory(recs);
        try { if (mask && mask.style.display !== "none") renderPanel(); } catch (e) {}
      });
    }).catch(function (err) { ioErr = "读取失败:" + ((err && err.name) || err); });
  }
  function ioClear() {
    return ioTx("readwrite").then(function (os) {
      if (!os) return null;
      return ioReqP(os.clear()).then(function () {
        dropHistoryCaptures();
        try { if (mask && mask.style.display !== "none") renderPanel(); } catch (e) {}
        toast("已清空落盘记录(本次会话在内存里的还在)", 1600);
      });
    }).catch(function () { toast("清空失败", 1600); });
  }

  // --- I/O read-back tools for the agent (io_list / io_read / io_search), same store and shape as
  // the panel. Registration is gated on the same record switch: with the mode off, nothing is
  // registered and the tools cost nothing. Records carry full conversation payloads across all
  // conversations — the same visibility a human has when opening the panel. ---
  function ioReadAll(limit) {
    return ioTx("readonly").then(function (os) {
      if (!os) return [];
      return new Promise(function (res) {
        var out = [];
        var cur = os.index("at").openCursor(null, "prev");
        cur.onsuccess = function () { var c = cur.result; if (!c || out.length >= limit) { res(out); return; } out.push(c.value); c.continue(); };
        cur.onerror = function () { res(out); };
      });
    }).catch(function () { return []; });
  }
  function ioFmtRec(r) { return fmtRecord(r); }
  window.__ioTools = {
    defineTools: function (registry) {
      if (!registry || typeof registry.define !== "function") return;
      if (!ioRecordOn()) return;
      registry.define({
        name: "io_list",
        description: "列出已落盘的模型 I/O 记录(最近≤50 条,与 设置→开发者 Dev Panel 同一份数据)。查「上一轮实际发了什么/回了什么」的入口;单条详情用 io_read。",
        parameters: { type: "object", properties: { limit: { type: "number", description: "可选:最多列几条,默认 20,最大 50" } }, additionalProperties: false },
        run: async function (args) {
          var recs = await ioReadAll(Math.min(50, Math.max(1, parseInt((args && args.limit) || 20, 10) || 20)));
          if (!recs.length) return "没有落盘记录(开发者模式未开,或还没有请求)。";
          var out = ["共 " + recs.length + " 条(新→旧):"];
          recs.forEach(function (r) { out.push(ioFmtRec(r)); });
          out.push("读单条:io_read(传 # 后面的完整 id);找内容用 io_search。");
          return out.join("\n");
        }
      });
      registry.define({
        name: "io_read",
        description: "按 id 读单条落盘 I/O 记录。part=summary(默认:元信息+消息清单+回复摘录)/payload(完整出站请求 JSON)/content(回复正文)/reasoning(思考)/raw(入站原始流)。单条可达 40 万字符,超长用 start/len 分窗,按 nextStart 续读。",
        parameters: { type: "object", properties: { id: { type: "string", description: "记录 id(io_list 输出 # 后面的串,可只传前缀)" }, part: { type: "string", description: "可选:summary(默认)/payload/content/reasoning/raw" }, start: { type: "number", description: "可选:字符窗口起点,默认 1" }, len: { type: "number", description: "可选:窗口长度,默认 3000,最大 8000" } }, required: ["id"], additionalProperties: false },
        run: async function (args) {
          var recs = await ioReadAll(IO_KEEP_);
          var r = findByIdPrefix(recs, args && args.id);
          if (!r) return "找不到记录(用 io_list 查现有 id;库最多留 50 条,更旧的已被删)。";
          var part = String((args && args.part) || "summary").toLowerCase();
          if (part === "summary") {
            var out = [ioFmtRec(r)];
            var msgs = (recOf(r.payload) && arrOf(recOf(r.payload).messages)) || [];
            out.push("消息清单(" + msgs.length + " 条):");
            msgs.slice(0, 30).forEach(function (m, i) {
              var t = (recOf(m).content) == null ? "" : recOf(m).content;
              var preview = (typeof t === "string") ? t.replace(/\s+/g, " ").slice(0, 120) : ("[非文本内容 " + String((t && t.length) || 0) + " 段]");
              out.push("  [" + i + "] " + ((recOf(m).role) || "?") + ": " + preview);
            });
            if (msgs.length > 30) out.push("  …(还有 " + (msgs.length - 30) + " 条;完整请求用 part=payload)");
            if (r.error) out.push("错误:" + r.error + (r.errorBody ? (" / " + String(r.errorBody).slice(0, 300)) : ""));
            out.push("回复正文(" + String(r.content || "").length + " 字符):" + String(r.content || "").replace(/\s+/g, " ").slice(0, 1200));
            if (r.reasoning) out.push("思考(" + String(r.reasoning).length + " 字符):" + String(r.reasoning || "").replace(/\s+/g, " ").slice(0, 600));
            if (r.usage) out.push("usage:" + JSON.stringify(r.usage));
            return out.join("\n");
          }
          var body = null;
          if (part === "payload") { try { body = JSON.stringify(r.payload, null, 1); } catch (e) { body = String(e); } }
          else if (part === "content") body = r.content;
          else if (part === "reasoning") body = r.reasoning;
          else if (part === "raw") body = r.raw;
          if (body == null) return "未知 part:" + part + "(可用 summary/payload/content/reasoning/raw)";
          var w = ioWindow(body, args && args.start, args && args.len);
          return "[" + part + " 共 " + w.total + " 字符,本窗 " + w.text.length + " 字符" + (w.next ? (";续读 start=" + w.next) : "") + "]\n" + w.text;
        }
      });
      registry.define({
        name: "io_search",
        description: "在最近 ≤50 条落盘 I/O 记录里按关键词搜索(匹配请求 payload/回复正文/思考/原始流,不区分大小写)。排查「哪一轮提到过 X」时用;命中给记录行 + 上下文摘录。",
        parameters: { type: "object", properties: { query: { type: "string", description: "关键词(字面匹配,不区分大小写)" }, max: { type: "number", description: "可选:最多返回几条命中,默认 10,最大 20" } }, required: ["query"], additionalProperties: false },
        run: async function (args) {
          var q = String((args && args.query) || "").trim();
          if (!q) return "缺少 query";
          var cap = Math.min(20, Math.max(1, parseInt((args && args.max) || 10, 10) || 10));
          var needle = q.toLowerCase();
          var recs = await ioReadAll(IO_KEEP_);
          var hits = [];
          for (var i = 0; i < recs.length && hits.length < cap; i++) {
            var r = recs[i];
            var blob = "";
            try { blob = JSON.stringify(r.payload) || ""; } catch (e) { blob = ""; }
            blob += "\n" + (r.content || "") + "\n" + (r.reasoning || "") + "\n" + (r.raw || "");
            var idx = blob.toLowerCase().indexOf(needle);
            if (idx < 0) continue;
            var excerpt = blob.slice(Math.max(0, idx - 80), idx + needle.length + 120).replace(/\s+/g, " ");
            hits.push(ioFmtRec(r) + "\n  …" + excerpt + "…");
          }
          if (!hits.length) return "最近 " + recs.length + " 条记录里没有命中「" + q + "」。";
          return "命中 " + hits.length + " 条:\n" + hits.join("\n");
        }
      });
    }
  };

  // --- Fetch interception. Installed unconditionally: every /api/chat request is captured into the
  // ring (the ring itself is free; persistence is gated separately). The patch must wrap the auth
  // wrapper (it is loaded after it) so captured bodies are post-auth, and sits below the unlock
  // gate which stacks on top. ---
  (function patchFetch() {
    if (!window.fetch) return;
    var orig = window.fetch.bind(window);
    window.fetch = async function (input, init) {
      var isChat = false;
      var _curEntry = null;
      try {
        var url = typeof input === "string" ? input : (input && input.url) || "";
        isChat = url.indexOf("/api/chat") >= 0;
        if (isChat && init && init.body) {
          try {
            var b = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
            _curEntry = setLastPayload(b);
            // Dev panel echo: the server reflects the truly assembled prompt read-only, only for
            // requests that passed the access check; the reflection never modifies the prompt.
            if (isOn()) b._debugEcho = true;
            var dbgStream = localStorage.getItem(STREAM_PROBE_KEY) === "1";
            if (dbgStream) {
              var h = new Headers((init && init.headers) || {});
              h.set("X-Debug-Stream", "1");
              init = Object.assign({}, init, { headers: h });
            }
            if (_curEntry) _curEntry.debugStream = dbgStream;
            applySamplingOverrides(b, ovr);
            init = Object.assign({}, init, { body: JSON.stringify(b) });
            if (b && b.model) hud.model = b.model;
          } catch (e) {}
        }
      } catch (e) {}
      if (isChat && fault) {
        api.log("fault inject", fault);
        if (fault === "error") return Promise.reject(new TypeError("[dev] 故障注入:模拟网络中断"));
        if (fault === "http500") return new Response('{"error":"[dev] injected 500"}', { status: 500, statusText: "Dev Injected", headers: { "content-type": "application/json" } });
        if (fault === "slow") await new Promise(function (r) { setTimeout(r, faultMs); });
      }
      if (!isChat) return orig(input, init);
      var t0 = (window.performance && performance.now) ? performance.now() : Date.now();
      hud.inflight = true; try { updateHud(); } catch (e) {}
      var resp;
      try { resp = await orig(input, init); } catch (e) {
        hud.inflight = false;
        if (_curEntry) { _curEntry.done = true; _curEntry.status = "ERR"; _curEntry.error = (e && e.name ? e.name + ": " : "") + (e && e.message ? e.message : String(e)); _curEntry.ms = Math.round(((window.performance && performance.now) ? performance.now() : Date.now()) - t0); }
        try { ioPersist(_curEntry); } catch (_e) {}
        try { updateHud(); } catch (_) {}
        try { if (mask && mask.style.display !== "none") renderPanel(); } catch (_) {}
        throw e;
      }
      if (_curEntry) _curEntry.status = resp.status;
      // Cloning buffers a second copy of the whole response stream alongside the real read (peak
      // memory doubles). With the mode off nobody could open the panel to read the per-chunk
      // record, so skip the clone and keep only the status/latency level entry.
      try {
        if (_curEntry && !isOn()) {
          _curEntry.done = true;
          _curEntry.ms = Math.round(((window.performance && performance.now) ? performance.now() : Date.now()) - t0);
          hud.inflight = false; try { updateHud(); } catch (_) {}
          try { ioPersist(_curEntry); } catch (_e) {}
        } else {
          measureStream(resp.clone(), t0, _curEntry);
        }
      } catch (e) { hud.inflight = false; try { updateHud(); } catch (_) {} }
      return resp;
    };
  })();

  // Stream measurement: the wiring owns the reader and the raw cap; the parser accumulates
  // content / reasoning / usage / chunk count / the assembly echo into the capture entry.
  function measureStream(resp, t0, entry) {
    var rd = (resp && resp.body && resp.body.getReader) ? resp.body.getReader() : null;
    if (!rd) { hud.inflight = false; if (entry) entry.done = true; try { updateHud(); } catch (e) {} try { ioPersist(entry); } catch (e) {} return; }
    var dec = new TextDecoder();
    var bytes = 0, raw = "", firstAt = 0;
    var parser = createSseParser();
    function finalize(entryDone) {
      if (entry) {
        entry.bytes = bytes; entry.done = true; entry.raw = raw;
        entry.content = parser.content(); entry.reasoning = parser.reasoning(); entry.chunks = parser.chunks(); entry.usage = parser.usage();
        if (entryDone) { entry.ms = entryDone.ms; entry.ttfb = entryDone.ttfb; }
      }
      hud.bytes = bytes; hud.at = Date.now(); hud.inflight = false;
      try { updateHud(); } catch (e) {}
      try { if (mask && mask.style.display !== "none") renderPanel(); } catch (e) {}
      try { ioPersist(entry); } catch (e) {}
    }
    (function pump() {
      rd.read().then(function (o) {
        if (o.done) {
          var tail = dec.decode();
          if (tail) { if (raw.length < RAW_CAP) raw += tail; parser.feed(tail); }
          parser.finish();
          var t1 = (window.performance && performance.now) ? performance.now() : Date.now();
          var ms = Math.round(t1 - t0); hud.ms = ms;
          finalize({ ms: ms, ttfb: firstAt ? Math.round(firstAt - t0) : 0 });
          return;
        }
        if (!firstAt) firstAt = (window.performance && performance.now) ? performance.now() : Date.now();
        bytes += o.value ? o.value.length : 0;
        var txt = dec.decode(o.value, { stream: true });
        if (raw.length < RAW_CAP) raw += txt;
        parser.feed(txt);
        pump();
      }).catch(function (err) {
        if (entry) entry.error = (err && err.name ? err.name + ": " : "") + (err && err.message ? err.message : String(err));
        finalize(null);
      });
    })();
  }

  // --- localStorage export ---
  function exportCfwLs() {
    var obj = {};
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf("cfw_") === 0) obj[k] = localStorage.getItem(k);
    }
    navigator.clipboard.writeText(JSON.stringify(obj, null, 2));
    return obj;
  }
  function exportAllLs() {
    var obj = {};
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k) obj[k] = localStorage.getItem(k);
    }
    navigator.clipboard.writeText(JSON.stringify(obj, null, 2));
    return obj;
  }
  async function exportAllRecords() {
    var entries = [];
    for (var i = 0; i < captureCount(); i++) { var e = captureAt(i); if (e) entries.push(e); }
    if (!entries.length) { toast("还没有可导出的记录", 1200); return; }
    var out = exportBundle(entries, new Date().toISOString());
    var json = JSON.stringify(out, null, 2);
    var fname = "ownchat-dev-records-" + stampName(new Date()) + ".json";
    // Desktop shell (Tauri): an <a download>.click() often never writes to disk while the toast
    // lies about success — so the shell path uses the native export and reports the real path;
    // the web path keeps the download; both fall back to the clipboard.
    var inv = window.tauriSvc ? window.tauriSvc.invokeOrNull() : null;
    async function clip(tip) {
      try { await navigator.clipboard.writeText(json); toast(tip + " · 已复制到剪贴板(" + entries.length + "条)", 2600); }
      catch (_) { toast("写盘+剪贴板都失败,请从控制台取 dev 数据", 3000); }
    }
    if (inv) {
      try {
        var savedPath = await inv("export_text_file", { suggestedName: fname, content: json });
        if (savedPath) toast("已写盘 " + entries.length + " 条 → " + savedPath, 2600);
        else toast("已取消保存(未写盘)", 1400);
      } catch (e) { await clip("原生写盘失败:" + String(e).slice(0, 50)); }
      return;
    }
    try {
      var blob = new Blob([json], { type: "application/json" });
      var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = fname; a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
      toast("已导出 " + entries.length + " 条记录", 1400);
    } catch (e) { await clip("下载失败:" + String(e).slice(0, 50)); }
  }

  // --- HUD: a draggable mini overlay with live request/model/memory/sync readouts. ---
  var hudEl = null;
  function showHud() {
    if (!hudEl) {
      hudEl = document.createElement("div");
      hudEl.id = "dev-hud";
      hudEl.style.cssText = "position:fixed;left:12px;bottom:72px;z-index:9000;background:var(--bg,#16161e);color:inherit;border:1px solid var(--border,rgba(127,127,127,.35));border-radius:12px;padding:9px 11px;font:11px/1.5 ui-monospace,Menlo,Consolas,monospace;max-width:240px;box-shadow:0 8px 24px rgba(0,0,0,.4);backdrop-filter:blur(8px);cursor:move;";
      document.body.appendChild(hudEl);
      dragify(hudEl);
    }
    localStorage.setItem(HUD_KEY, "1");
    hudEl.style.display = "block";
    updateHud();
  }
  function hideHud() { localStorage.setItem(HUD_KEY, "0"); if (hudEl) hudEl.style.display = "none"; }
  function dragify(el) {
    var sx, sy, ox, oy, on = false;
    el.addEventListener("pointerdown", function (e) {
      if (e.target.closest && e.target.closest("[data-hud-x]")) return;
      on = true; sx = e.clientX; sy = e.clientY;
      var r = el.getBoundingClientRect(); ox = r.left; oy = r.top;
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
    });
    el.addEventListener("pointermove", function (e) {
      if (!on) return;
      el.style.left = (ox + e.clientX - sx) + "px";
      el.style.top = (oy + e.clientY - sy) + "px";
      el.style.bottom = "auto";
    });
    el.addEventListener("pointerup", function () { on = false; });
  }
  function updateHud() {
    if (!hudEl || hudEl.style.display === "none") return;
    var nsf = localStorage.getItem("cfw_nsfw_mode_v1") || "0";
    var th = localStorage.getItem("cfw_theme_v1") || "minimal";
    var think = (document.getElementById("thinkToggle") || {}).textContent || "";
    var sync = "—", push = "—";
    try {
      if (window.syncSvc && window.syncSvc.getStatus) {
        var s = window.syncSvc.getStatus();
        sync = s.enabled ? (s.paused ? "暂停" : "开") : "关";
        push = s.pushCount;
      }
    } catch (e) {}
    var spd = hud.ms ? (Math.round(hud.bytes / 1024 / (hud.ms / 1000) * 10) / 10 + "KB/s") : "—";
    // Memory numbers are the JS-side reading the owner compares across "restart shell → baseline →
    // use it a while → check task manager"; GPU process numbers only exist in the system one.
    var _mem = (function () { try { var m = performance.memory; if (!m || !m.usedJSHeapSize) return "—"; return Math.round(m.usedJSHeapSize / 1048576) + "MB"; } catch (e) { return "—"; } })();
    var _rows = (function () { try { return document.querySelectorAll("#chat .row").length; } catch (e) { return "—"; } })();
    hudEl.innerHTML = '<div style="display:flex;justify-content:space-between;gap:8px;"><b style="color:inherit;opacity:.65;letter-spacing:.04em;">DEV HUD</b><span data-hud-x style="cursor:pointer;color:#e8607d;">关闭</span></div><div>模型 ' + esc(hud.model || "—") + '</div><div>NSFW ' + nsf + ' · ' + esc(th) + '</div><div>' + esc(think) + '</div><div>同步 ' + sync + ' · push ' + push + '</div><div>堆 ' + _mem + ' · 消息行 ' + _rows + '</div><div>' + (hud.inflight ? '<span style="color:#fd6;">请求中…</span>' : ('上次 ' + (hud.ms || 0) + 'ms · ' + spd)) + '</div>' + (fault ? '<div style="color:#f66;">故障注入:' + fault + '</div>' : '');
    var x = hudEl.querySelector("[data-hud-x]");
    if (x) x.onclick = hideHud;
  }
  setInterval(function () { try { updateHud(); } catch (e) {} }, 2000);

  // Panel: bottom tools section. The sampling-override / fault-injection / HUD-switch block is NOT
  // rendered here on purpose: the original called a dtHud() that no longer exists, so
  // devToolsSectionHtml() threw and the panel swallowed it — that section has been dead UI since
  // the slim-down, and re-enabling it is a product decision, not a migration step. The fetch-side
  // override support below stays live (the overrides key can still be set from the console).
  function openPanel() {
    if (mask) { mask.style.display = "flex"; renderPanel(); try { ioLoadHistory(); } catch (e) {} return; }
    mask = document.createElement("div");
    mask.id = "dev-panel-mask";
    mask.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:99997;padding:20px;backdrop-filter:blur(6px);box-sizing:border-box;";
    var p = document.createElement("div");
    p.id = "dev-panel";
    p.style.cssText = "box-sizing:border-box;background:var(--bg,#0f0f0f);color:inherit;border:1px solid var(--border,#2a2a2a);border-radius:18px;padding:20px;max-width:760px;width:100%;max-height:85vh;overflow-y:auto;overflow-x:hidden;font-size:13px;line-height:1.6;box-shadow:0 30px 80px rgba(0,0,0,.5);font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;";
    mask.appendChild(p);
    document.body.appendChild(mask);
    mask.addEventListener("click", function (e) { if (e.target === mask) mask.style.display = "none"; });
    renderPanel();
    // Restore records from the previous session into the list (once per load; re-renders itself).
    try { ioLoadHistory(); } catch (e) {}
  }
  var esc = window.escapeSvc.esc;
  function fmtBytes(n) { n = n || 0; if (n < 1024) return n + "B"; if (n < 1048576) return (n / 1024).toFixed(1) + "KB"; return (n / 1048576).toFixed(2) + "MB"; }
  // Restored records can be days old; raw seconds are unreadable past a minute.
  function agoStr(at) {
    var s = Math.max(0, Math.floor((Date.now() - (at || 0)) / 1000));
    if (s < 60) return s + "s 前";
    if (s < 3600) return Math.floor(s / 60) + "m 前";
    if (s < 86400) return Math.floor(s / 3600) + "h 前";
    return Math.floor(s / 86400) + "d 前";
  }
  function kvRow(k, v) { return '<div style="display:flex;justify-content:space-between;gap:10px;padding:3px 0;border-bottom:1px solid rgba(127,127,127,.12);"><span style="color:var(--muted);">' + esc(k) + '</span><span style="text-align:right;word-break:break-all;max-width:62%;">' + esc(v) + '</span></div>'; }
  function preBox(s, mh) { return '<pre style="background:var(--bg,#000);color:inherit;padding:12px;border-radius:10px;border:1px solid var(--border,#242424);max-height:' + (mh || 360) + 'px;overflow:auto;white-space:pre-wrap;word-break:break-all;font-size:11px;line-height:1.55;font-family:ui-monospace,Menlo,Consolas,monospace;">' + esc(s) + '</pre>'; }
  function estCost(model, usage) { return estCostCNY(model, usage, window.DEEPSEEK_PRICING || {}); }
  function inspectorBody(lp) {
    if (!lp) return "";
    var tab = inspectTab, pay = lp.payload || {}, dbg = lp.dbg || null;
    if (tab === "overview") {
      var u = lp.usage || null, secs = lp.ms ? lp.ms / 1000 : 0;
      var html = '<div style="font-size:12px;line-height:1.6;">';
      html += kvRow("模型", (pay.model || "—") + "  (" + (pay.mode || "?") + ")");
      if (dbg) html += kvRow("上游 / 解锁", (dbg.upstream || "?") + " · " + (dbg.unlocked ? "已解锁" : "锁定态"));
      html += kvRow("思考", dbg ? dbg.thinking : (pay.thinking || "—"));
      html += kvRow("请求体体积", fmtBytes(lp.requestBytes || 0));
      html += kvRow("消息数 / token估算", (lp.msgCount || 0) + " 条 / ≈" + (lp.tokenEstimate || 0));
      html += kvRow("Worker 流模式", lp.debugStream ? "调试包装" : "纯透传");
      html += kvRow("TTFB 首字节", lp.ttfb ? lp.ttfb + "ms" : "—");
      html += kvRow("总耗时", lp.ms ? lp.ms + "ms" : (lp.done ? "—" : "进行中…"));
      if (lp.error) html += kvRow("流式/网络错误", lp.error);
      if (u && u.completion_tokens && secs) html += kvRow("输出速度", (u.completion_tokens / secs).toFixed(1) + " tok/s");
      else if (lp.content && secs) html += kvRow("输出速度", (lp.content.length / secs).toFixed(1) + " 字/s");
      html += kvRow("流分块数", lp.chunks != null ? String(lp.chunks) : "—");
      html += kvRow("响应字节", fmtBytes(lp.bytes || 0));
      if (lp.status && Number(lp.status) >= 400 && lp.raw) html += '<div style="color:#e8607d;margin-top:8px;font-size:11px;">HTTP 错误响应体</div>' + preBox((lp.raw || "").slice(0, 12000), 180);
      html += kvRow("正文 / 思考 字数", (lp.content ? lp.content.length : 0) + " / " + (lp.reasoning ? lp.reasoning.length : 0));
      if (u) {
        var cached = u.prompt_cache_hit_tokens || 0, prompt = u.prompt_tokens || 0, rate = prompt ? Math.round(cached / prompt * 100) : 0;
        html += kvRow("Token", "prompt " + prompt + " · completion " + (u.completion_tokens || 0) + " · total " + (u.total_tokens || 0));
        html += kvRow("缓存命中", cached + " / " + prompt + " prompt (" + rate + "%)");
        var c = estCost(pay.model, u); if (c != null) html += kvRow("本条估算费用", "¥" + c.toFixed(5));
      } else { html += '<div style="color:var(--muted);margin-top:6px;">usage 未捕获(免费/NVIDIA 路径常不回 usage,或仍在流式)。</div>'; }
      if (dbg && dbg.flags) {
        var f = dbg.flags;
        html += '<div style="margin-top:8px;color:var(--muted);">服务端实际标志位</div>';
        html += kvRow("基座提示词", f.useBuiltinPersona ? "ON" : "OFF");
        html += kvRow("回复风格 / profile", (f.replyStyle || "default") + " / " + (f.promptProfile || "?"));
        html += kvRow("system 装配", dbg.sysParts + " · " + dbg.sysChars + " 字 · " + dbg.msgCount + " 条消息");
      } else { html += '<div style="margin-top:8px;color:var(--muted);">未拿到服务端装配快照(需已解锁本人;dev 面板会自动带 _debugEcho,worker 只反射不改)。</div>'; }
      html += '</div>'; return html;
    }
    if (tab === "request") {
      return '<div style="color:var(--muted);font-size:11px;margin-bottom:6px;">前端实际 POST /api/chat 的 body(含 dev 注入的 _debugEcho / 采样覆盖):</div>' + preBox(JSON.stringify(pay, null, 2), 420) + '<div style="display:flex;gap:6px;margin-top:8px;"><button class="dev-btn" data-copy-payload>复制 body JSON</button><button class="dev-btn" data-copy-curl>复制 cURL</button></div>';
    }
    if (tab === "assembled") {
      if (!dbg) return '<div style="color:var(--muted);font-size:12px;padding:12px;background:var(--bubble-ai,#0a0a0a);border-radius:10px;border:1px dashed var(--border,#333);">这条没有服务端装配快照。<br><br>真实 prompt 回显仅对「已解锁(掌握访问码)的本人」生效——dev 面板自动带 _debugEcho,worker 只反射不改任何 prompt。锁定态不回显(伪装态不给装配快照)。<br><br>先解锁(连点版本号 7 下输入访问码)再发一条。</div>';
      var html2 = '<div style="color:var(--muted);font-size:11px;margin-bottom:6px;">服务端真正拼好、喂给模型的 system(' + dbg.sysChars + ' 字 · ' + dbg.sysParts + '):</div>' + preBox(dbg.systemContent || "", 300) + '<button class="dev-btn" data-copy-sys style="margin:8px 0;">复制 system</button>';
      html2 += '<div style="color:var(--muted);font-size:11px;margin:10px 0 6px;">最终 messages 数组(' + dbg.msgCount + ' 条,第 0 条即上面 system):</div><div style="display:flex;flex-direction:column;gap:6px;">';
      var msgs = Array.isArray(dbg.messages) ? dbg.messages : [];
      msgs.forEach(function (m, i) {
        var role = (m && m.role) || "?";
        var col = role === "system" ? "#c39bd3" : role === "user" ? "#7fb3d5" : role === "assistant" ? "#7dcea0" : "#aaa";
        var c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        html2 += '<details style="border:1px solid var(--border,#242424);border-radius:8px;overflow:hidden;"><summary style="padding:6px 10px;cursor:pointer;font-size:11px;"><span style="color:' + col + ';font-weight:600;">#' + i + ' ' + esc(role) + '</span> <span style="color:var(--muted);">· ' + (c ? c.length : 0) + ' 字</span></summary>' + preBox(c || "", 240) + '</details>';
      });
      html2 += '</div>'; return html2;
    }
    if (tab === "stream") {
      var html3 = '<div style="color:var(--muted);font-size:11px;margin-bottom:4px;">reasoning_content 流(模型思考 · ' + (lp.reasoning ? lp.reasoning.length : 0) + ' 字):</div>' + preBox(lp.reasoning || "(无)", 200);
      html3 += '<div style="color:var(--muted);font-size:11px;margin:10px 0 4px;">content 流(正文原始 · 未清洗 · ' + (lp.content ? lp.content.length : 0) + ' 字):</div>' + preBox(lp.content || "(无)", 240);
      html3 += '<div style="display:flex;gap:6px;margin:8px 0;"><button class="dev-btn" data-copy-content>复制原始正文</button><button class="dev-btn" data-copy-reason>复制思考</button></div>';
      html3 += '<details style="margin-top:6px;"><summary style="cursor:pointer;font-size:11px;color:var(--muted);">原始 SSE 字节流(' + fmtBytes(lp.bytes || 0) + ' · ' + (lp.chunks || 0) + ' 块)</summary>' + preBox((lp.raw || "").slice(0, 40000), 300) + '</details>';
      return html3;
    }
    if (tab === "pipeline") {
      if (!window.pipelineSvc || !window.pipelineSvc.trace) return '<div style="color:var(--muted);font-size:12px;padding:12px;">清洗管线探针未就绪(app.js pipeline 未加载)。</div>';
      if (!lp.content) return '<div style="color:var(--muted);font-size:12px;padding:12px;">这条还没有正文输出可追踪。</div>';
      var tr; try { tr = window.pipelineSvc.trace(lp.content, { wechat: (pay.replyStyle === "wechat") }); } catch (e) { return '<div style="color:#f66;">trace 失败: ' + esc(String(e)) + '</div>'; }
      var html4 = '<div style="color:var(--muted);font-size:11px;margin-bottom:8px;">原始正文依次跑过清洗各级——<span style="color:#e8607d;">红=该级裁掉</span>、<span style="color:#5ec98a;">绿=新增/改写</span>。重点看正文在哪一级被吃掉。</div>';
      (tr.stages || []).forEach(function (s, i) {
        var dc = s.delta < 0 ? "#e8607d" : s.delta > 0 ? "#5ec98a" : "var(--muted)";
        html4 += '<div style="border:1px solid var(--border,#242424);border-radius:10px;padding:10px 12px;margin-bottom:8px;"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center;"><span style="font-weight:600;font-size:12px;">' + i + '. ' + esc(s.name) + '</span><span style="font-size:11px;color:' + dc + ';">' + s.chars + ' 字 (' + (s.delta > 0 ? "+" : "") + s.delta + ')</span></div>';
        if (s.note) html4 += '<div style="color:var(--muted);font-size:10px;margin:2px 0 6px;">' + esc(s.note) + '</div>';
        if (s.removed) html4 += '<div style="font-size:11px;margin-top:4px;"><span style="color:#e8607d;">− 裁掉:</span> <span style="background:rgba(232,96,125,.12);padding:1px 4px;border-radius:4px;white-space:pre-wrap;word-break:break-all;">' + esc(s.removed.slice(0, 600)) + (s.removed.length > 600 ? "…" : "") + '</span></div>';
        if (s.added) html4 += '<div style="font-size:11px;margin-top:4px;"><span style="color:#5ec98a;">+ 新增:</span> <span style="background:rgba(94,201,138,.12);padding:1px 4px;border-radius:4px;word-break:break-all;">' + esc(s.added.slice(0, 600)) + '</span></div>';
        if (s.captured) html4 += '<div style="font-size:11px;margin-top:4px;color:var(--muted);">↳ 归档进思考折叠块: ' + esc(s.captured.slice(0, 300)) + (s.captured.length > 300 ? "…" : "") + '</div>';
        html4 += '</div>';
      });
      if (tr.inlineThink) html4 += '<div style="color:var(--muted);font-size:11px;margin-top:4px;">内联 think 捕获: ' + esc(tr.inlineThink.slice(0, 300)) + (tr.inlineThink.length > 300 ? "…" : "") + '</div>';
      html4 += '<div style="margin-top:8px;font-size:11px;"><b>最终正文(' + (tr.finalBody ? tr.finalBody.length : 0) + ' 字)</b></div>' + preBox(tr.finalBody || "", 200);
      return html4;
    }
    return "";
  }
  var inspectTab = "overview";
  function renderPanel() {
    var p = document.getElementById("dev-panel");
    if (!p) return;
    var lp = selectedCapture();
    var h = [];
    h.push(`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;border-bottom:1px solid var(--border,#2a2a2a);padding-bottom:12px;"><h3 style="margin:0;font-size:15px;font-weight:700;letter-spacing:.02em;display:flex;align-items:center;gap:9px;color:inherit;"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.4 2.4-2-2z"/></svg>Dev Panel</h3><button data-close style="background:var(--bubble-ai,#141414);color:inherit;border:1px solid var(--border,#2a2a2a);border-radius:8px;padding:5px 12px;font-size:12px;cursor:pointer;">关闭</button></div>`);
    h.push(`<div style="margin-bottom:12px;padding:14px 16px;background:var(--bubble-ai,#101010);border:1px solid var(--border,#242424);border-radius:14px;"><label style="display:flex;gap:8px;align-items:center;cursor:pointer;"><input type="checkbox" ${api.debug ? "checked" : ""} data-debug-toggle><span>Console verbose log <code style="font-size:11px;background:rgba(127,127,127,.16);padding:1px 6px;border-radius:5px;">debug 开关</code></span></label></div>`);
    // Cloud sync status + KV quota readout (read-only mirror of the sync engine's state).
    if (window.syncSvc && window.syncSvc.getStatus) {
      var ss = window.syncSvc.getStatus();
      var quotaColor = ss.pushCount >= 800 ? "#f60" : ss.pushCount >= 500 ? "#fc0" : "#888";
      h.push(`<div style="margin-bottom:12px;padding:14px 16px;background:var(--bubble-ai,#101010);border:1px solid var(--border,#242424);border-radius:14px;font-size:12px;line-height:1.7;"><div style="color:inherit;font-weight:600;margin-bottom:4px;letter-spacing:.02em;">云同步状态</div><div>启用: <code>${ss.enabled ? "YES" : "NO"}</code> · 暂停: <code>${ss.paused ? "YES" : "NO"}</code> · 同步聊天: <code>${ss.includeChat ? "YES" : "NO"}</code></div><div>今日 push: <code style="color:${quotaColor};">${ss.pushCount}</code> / 1000 (Cloudflare KV 免费层)</div></div>`);
    }
    h.push(`<div style="margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap;"><button class="dev-btn" data-export-cfw>复制 cfw_* localStorage</button><button class="dev-btn" data-export-all>复制全部 localStorage</button><button class="dev-btn danger" data-disable>关闭开发者模式</button></div>`);
    var histN = historyCount();
    h.push(`<div style="margin:4px 0 8px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;"><span style="font-weight:700;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted,#9a9aab);">请求 I/O 探查 · 最近 ${captureCount()}/${MAX_PAYLOADS} 条${histN ? `（⟲ 落盘恢复 ${histN} 条）` : ""}</span><span style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">${captureCount() ? `<button class="dev-btn" data-export-records style="font-size:11px;padding:4px 10px;">导出全部记录</button>` : ""}<label style="display:flex;gap:5px;align-items:center;font-size:11px;color:var(--muted,#9a9aab);cursor:pointer;" title="写进本机 IndexedDB（最近 50 条），刷新后打开面板仍在；不进云同步"><input type="checkbox" data-io-record ${ioRecordOn() ? "checked" : ""} style="accent-color:var(--btn-bg,#9aa3ff);">落盘</label><button class="dev-btn" data-clear-hist style="font-size:11px;padding:4px 10px;">清空落盘</button></span></div>`);
    if (ioErr) h.push(`<div style="margin:0 0 8px;font-size:11px;color:#e8a33d;">⚠ ${esc(ioErr)}</div>`);
    if (!captureCount()) {
      h.push(`<div style="color:var(--muted);font-size:12px;padding:12px;background:var(--bubble-ai,#0a0a0a);border-radius:10px;border:1px dashed var(--border,#333);">暂未捕获。发一条消息后再来——只拦 /api/chat:出站 body、入站 SSE 流(逐块/TTFB/usage)、服务端真实装配、正文清洗管线。</div>`);
    } else {
      h.push(`<div data-req-list style="display:flex;flex-direction:column;gap:3px;margin-bottom:10px;max-height:130px;overflow:auto;">`);
      for (var i = captureCount() - 1; i >= 0; i--) {
        var e = captureAt(i);
        var mdl = (e.payload && e.payload.model) || "—";
        var st = e.done ? (((e.status == null ? "" : ("HTTP " + e.status)) + (e.ms ? (" · " + e.ms + "ms") : "")).trim() || "完成") : "进行中…";
        var isSel = i === selectedIndex();
        h.push(`<button class="dev-btn" data-req="${i}" style="justify-content:space-between;${isSel ? "border-color:var(--btn-bg,#9aa3ff);background:rgba(127,127,127,.24);" : ""}"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:50%;">${e.fromHist ? "⟲ " : ""}#${i + 1} ${esc(String(mdl))}</span><span style="color:var(--muted);font-size:10px;white-space:nowrap;">${agoStr(e.at)} · ${esc(st)}${e.dbg ? " · 装配✓" : ""}${e.truncated ? " · 已截断" : ""}</span></button>`);
      }
      h.push(`</div>`);
      var TABS = [["overview", "概览"], ["request", "出站请求"], ["assembled", "真实Prompt"], ["stream", "入站流"], ["pipeline", "清洗管线"]];
      h.push(`<div data-itabs style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:10px;border-bottom:1px solid var(--border,#242424);padding-bottom:8px;">`);
      for (const tb of TABS) { h.push(`<button class="dev-btn" data-itab="${tb[0]}" style="${inspectTab === tb[0] ? "border-color:var(--btn-bg,#9aa3ff);background:rgba(127,127,127,.24);font-weight:600;" : ""}">${tb[1]}</button>`); }
      h.push(`</div>`);
      h.push(inspectorBody(lp));
    }
    h.push(`<style>#dev-panel,#dev-panel *{box-sizing:border-box;}#dev-panel code{color:inherit;}#dev-panel select,#dev-panel input,#dev-panel textarea{max-width:100%;}#dev-panel .dev-btn{display:inline-flex;align-items:center;gap:6px;background:rgba(127,127,127,.14);color:inherit;border:1px solid rgba(127,127,127,.3);border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer;transition:background .15s,border-color .15s;}#dev-panel .dev-btn:hover{background:rgba(127,127,127,.24);border-color:rgba(127,127,127,.5);}#dev-panel .dev-btn.danger{border-color:rgba(232,96,125,.4);background:rgba(232,96,125,.12);color:#e8607d;}#dev-panel .dev-btn.danger:hover{background:rgba(232,96,125,.22);border-color:rgba(232,96,125,.6);}#dev-panel input[type=checkbox]{accent-color:var(--btn-bg,#9aa3ff);}@media(max-width:640px){#dev-panel-mask{padding:0!important;align-items:stretch!important;height:100vh!important;height:100dvh!important;}#dev-panel{max-width:100%!important;width:100%!important;max-height:100vh!important;max-height:100dvh!important;height:100vh!important;height:100dvh!important;border-radius:0!important;border:none!important;padding:16px 14px calc(40px + env(safe-area-inset-bottom))!important;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;}}</style>`);
    p.innerHTML = h.join("");
    p.querySelector("[data-close]")?.addEventListener("click", function () { mask.style.display = "none"; });
    p.querySelector("[data-debug-toggle]")?.addEventListener("change", function (e) { api.debug = e.target.checked; localStorage.setItem(DBG, api.debug ? "1" : "0"); });
    p.querySelector("[data-export-cfw]")?.addEventListener("click", function () { var o = exportCfwLs(); toast("已复制 cfw_* · " + Object.keys(o).length + " 项", 1200); });
    p.querySelector("[data-export-all]")?.addEventListener("click", function () { var o = exportAllLs(); toast("已复制全部 · " + Object.keys(o).length + " 项", 1200); });
    p.querySelector("[data-export-records]")?.addEventListener("click", exportAllRecords);
    p.querySelector("[data-io-record]")?.addEventListener("change", function (e) { try { localStorage.setItem(IO_REC_KEY, e.target.checked ? "1" : "0"); } catch (_) {} toast(e.target.checked ? "I/O 记录会落盘(刷新后仍在)" : "I/O 记录只留在内存", 1600); });
    p.querySelector("[data-clear-hist]")?.addEventListener("click", function () { if (confirm("清空本机落盘的 I/O 记录?(本次会话在内存里的不受影响)")) ioClear(); });
    p.querySelector("[data-disable]")?.addEventListener("click", function () { if (confirm("关闭开发者模式并刷新?")) api.disable(); });
    p.querySelector("[data-copy-payload]")?.addEventListener("click", function () { navigator.clipboard.writeText(JSON.stringify(lp.payload, null, 2)); toast("payload 已复制", 1000); });
    p.querySelector("[data-req-list]")?.addEventListener("click", function (e) { var b = e.target.closest && e.target.closest("button[data-req]"); if (!b) return; var i = parseInt(b.dataset.req, 10); if (!isNaN(i)) { selectCapture(i); renderPanel(); } });
    p.querySelector("[data-itabs]")?.addEventListener("click", function (e) { var b = e.target.closest && e.target.closest("button[data-itab]"); if (!b) return; inspectTab = b.dataset.itab; renderPanel(); });
    p.querySelector("[data-copy-curl]")?.addEventListener("click", function () { var b = JSON.stringify(lp.payload); var c = "curl -X POST '" + location.origin + "/api/chat' -H 'content-type: application/json' --data '" + b.replace(/'/g, "'\\''") + "'"; navigator.clipboard.writeText(c); toast("cURL 已复制", 1000); });
    p.querySelector("[data-copy-sys]")?.addEventListener("click", function () { navigator.clipboard.writeText((lp.dbg && lp.dbg.systemContent) || ""); toast("system 已复制", 1000); });
    p.querySelector("[data-copy-content]")?.addEventListener("click", function () { navigator.clipboard.writeText(lp.content || ""); toast("原始正文已复制", 1000); });
    p.querySelector("[data-copy-reason]")?.addEventListener("click", function () { navigator.clipboard.writeText(lp.reasoning || ""); toast("思考已复制", 1000); });
  }

  // Self-mounted developer settings cards: index.html keeps only an empty setDevSlot div inside
  // the dev category; a missing slot or an already-mounted card is skipped silently so pages that
  // have not caught up with the slot contract keep working.
  function mountCard() {
    var slot = window.slotRegistry.pick("setDevSlot");
    if (slot) window.slotRegistry.claim({ cardId: "devToolsCard", slotId: "setDevSlot" });
    if (!slot || document.getElementById("devToolsCard")) return;
    var c1 = document.createElement("div"); c1.className = "card"; c1.id = "devToolsCard";
    c1.setAttribute("data-dev-only", "");
    c1.innerHTML = '<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.4 2.4-2-2z"/></svg>开发者工具</h4>'
      + '<p>打开调试面板——请求 I/O 探查、故障注入、参数覆盖、prompt 透视、清洗管线追踪。顶栏 Dev 按钮<b>长按 1.5 秒</b>可关闭开发者模式。</p>'
      + '<div class="rowline"><div class="btns">'
      + '<button class="smallbtn" id="devOpenPanelBtn">打开 Dev Panel</button>'
      + '<button class="smallbtn" id="devHudOnBtn">显示 HUD</button>'
      + '<button class="smallbtn danger" id="devDisableBtn">关闭开发者模式</button>'
      + '</div></div>'
      + '<div class="settings-tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg><span>长按 GitHub 按钮 1.2s 可切换开发者模式（无需打开设置）。</span></div>';
    slot.appendChild(c1);
    var c2 = document.createElement("div"); c2.className = "card"; c2.id = "devExportCard";
    c2.setAttribute("data-dev-only", "");
    c2.innerHTML = '<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V5"/><path d="M8 11l4 4 4-4"/><path d="M5 18v1.5A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V18"/></svg>一键导出</h4>'
      + '<p>把本地数据复制到剪贴板或下载为文件，方便迁移 / 调试 / 备份。</p>'
      + '<div class="rowline"><div class="btns">'
      + '<button class="smallbtn" id="exportCfwLsBtn">复制 cfw_* LS</button>'
      + '<button class="smallbtn" id="exportAllLsBtn">复制全部 LS</button>'
      + '<button class="smallbtn" id="exportRecordsBtn">下载 I/O 记录</button>'
      + '</div></div>';
    slot.appendChild(c2);
    var c3 = document.createElement("div"); c3.className = "card"; c3.id = "devIoCard";
    c3.setAttribute("data-dev-only", "");
    c3.innerHTML = '<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16v12H4z"/><path d="M8 10h8"/><path d="M8 14h5"/></svg>I/O 记录落盘</h4>'
      + '<p>把每次 /api/chat 的完整记录（出站 payload + 入站原始流 + 服务端装配回显）写进本机 IndexedDB，<b>刷新页面后打开 Dev Panel 仍在</b>（列表里标 ⟲）。</p>'
      + '<div class="rowline"><div class="btns">'
      + '<label class="smallbtn" style="display:inline-flex;align-items:center;gap:7px;cursor:pointer;"><input type="checkbox" id="devIoRecChk" style="accent-color:var(--btn-bg,#9aa3ff);">开启自动落盘</label>'
      + '</div></div>'
      + '<div class="settings-tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg><span>本机保留最近 50 条、单条响应侧封顶 400KB（超了先丢入站原始流、再截正文并标「已截断」）。<b>不进云同步</b>——这是本机调试数据，同步上去只会占 KV 配额。</span></div>';
    slot.appendChild(c3);
    var op = document.getElementById("devOpenPanelBtn"); if (op) op.addEventListener("click", openPanel);
    var hudBtn = document.getElementById("devHudOnBtn"); if (hudBtn) hudBtn.addEventListener("click", showHud);
    var dis = document.getElementById("devDisableBtn"); if (dis) dis.addEventListener("click", function () { if (confirm("关闭开发者模式并刷新?")) api.disable(); });
    var ex1 = document.getElementById("exportCfwLsBtn"); if (ex1) ex1.addEventListener("click", function () { var o = exportCfwLs(); toast("已复制 cfw_* · " + Object.keys(o).length + " 项", 1200); });
    var ex2 = document.getElementById("exportAllLsBtn"); if (ex2) ex2.addEventListener("click", function () { var o = exportAllLs(); toast("已复制全部 · " + Object.keys(o).length + " 项", 1200); });
    var ex3 = document.getElementById("exportRecordsBtn"); if (ex3) ex3.addEventListener("click", exportAllRecords);
    var iorec = document.getElementById("devIoRecChk");
    if (iorec) {
      iorec.checked = ioRecordOn();
      iorec.addEventListener("change", function () {
        try { localStorage.setItem(IO_REC_KEY, iorec.checked ? "1" : "0"); } catch (e) {}
        toast(iorec.checked ? "I/O 记录会落盘（刷新后仍在）" : "I/O 记录只留在内存", 1600);
      });
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    mountCard();
    applyVisibility();
    ensureBadge();
    wireGithubLongPress();
    wireSyncPauseBtn();
    try { if (localStorage.getItem(HUD_KEY) === "1" && isOn()) showHud(); } catch (e) {}
    api.log("dev console loaded · mode =", isOn() ? "ON" : "OFF");
  });
})();
