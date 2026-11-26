// chat-extras.js —— 主聊天两个增强入口(接管左栏「文件上传」+「多开聊天」按钮)
// 路径: public/js/text/ui/chat-extras.js
// ① 文件上传:读纯文本/代码文件,内容以代码块注入输入框,随下条消息发给 AI(完全不碰发送核心)
// ② 多开聊天:同一角色的多条命名会话,列表式切换(底层走 window.hostApi.app 的会话槽 hooks)
(function () {
  // 2026-11-15 服务层搬迁：判定与截断口径在 services/ui/chat-extras.ts，本文件只剩 DOM 与 FileReader。
  var svc = createChatExtras();

  function $(id) { return document.getElementById(id); }
  var esc = window.escapeSvc.esc;
  // 2026-11-11：aee803f 曾误删本文件里两处定义（扩展名表与 maxChars），导致 handleFiles 全线
  // ReferenceError。扩展名表已随 2026-11-15 搬迁进 services/ui/chat-extras.ts，这里只留 maxChars。
  // 4.83: 阈值唯一真源在 attachments.js(attachSvc.ATT_MAX_CHARS),运行时读取防两处漂移
  function maxChars() {
    try { return (window.attachSvc && window.attachSvc.ATT_MAX_CHARS) || 20000; } catch (e) { return 20000; }
  }
  // 4.83: 截断可见反馈 —— 旧版只写 chip 的 title 悬浮提示,手机端无 hover 完全看不到
  function toast(msg) {
    try { if (window.feedbackSvc && window.feedbackSvc.toast) return window.feedbackSvc.toast(msg, { ms: 4200 }); } catch (e) {}
    alert(msg);
  }

  function readAsText(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result || "")); };
      fr.onerror = function () { reject(fr.error || new Error("读取失败")); };
      fr.readAsText(file);
    });
  }
  // 2026-09-14 附件重构:文本文件不再往输入框塞一行中文摘要,改为结构化附件
  // (window.attachSvc,见 attachments.js),输入框上方渲染可移除的文件 chip;
  // 全文存在消息的 files 字段上随 session 持久化,发送时才展开进 payload。
  function handleFiles(files) {
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    var att = window.attachSvc;
    if (!att) { alert("附件模块未就绪,请刷新页面重试"); return; }
    var MAX = maxChars();
    var skipped = [], truncatedNames = [];
    var jobs = list.map(function (f) {
      if (!svc.isTextFile(f)) { skipped.push(f.name); return Promise.resolve(null); }
      return readAsText(f).then(function (txt) {
        var r = svc.truncateForModel({ name: f.name, text: txt }, MAX);
        if (r && r.truncated) truncatedNames.push(f.name + "（" + r.chars + " 字）");
        return r;
      }).catch(function () { skipped.push(f.name + "(读取失败)"); return null; });
    });
    Promise.all(jobs).then(function (results) {
      results.filter(Boolean).forEach(function (r) { att.addText(r); });
      if (truncatedNames.length) toast("以下文件超过 " + MAX + " 字上限，仅前 " + MAX + " 字会发送给模型：\n" + truncatedNames.join("、"));
      if (skipped.length) alert("以下文件被跳过(仅支持纯文本/代码文件):\n" + skipped.join("\n"));
    });
  }
  var fileInput = null;
  function ensureFileInput() {
    if (fileInput) return fileInput;
    fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.multiple = true;
    fileInput.accept = ".txt,.md,.markdown,.json,.csv,.log,.yml,.yaml,.xml,.html,.css,.js,.ts,.jsx,.tsx,.vue,.py,.rb,.go,.rs,.java,.c,.h,.cpp,.cs,.php,.sh,.sql,text/*";
    fileInput.style.display = "none";
    fileInput.addEventListener("change", function () { handleFiles(fileInput.files); fileInput.value = ""; });
    document.body.appendChild(fileInput);
    return fileInput;
  }
  function openFilePicker() { ensureFileInput().click(); }

  // ───────── ①.5 聊天区回形针(2026-09-12):图片走多模态视觉,文档/代码沿用①的结构化附件 ─────────
  function toDataURL(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result || "")); };
      fr.onerror = function () { reject(fr.error || new Error("读取失败")); };
      fr.readAsDataURL(file);
    });
  }
  // 读取图片:dataURL(本轮渲染/发送)+ Blob(存 IndexedDB 供刷新后还原)+ 原始宽高(卡片比例)
  function readAsImage(file) {
    return toDataURL(file).then(function (durl) {
      var dim = new Promise(function (res) {
        var im = new Image();
        im.onload = function () { res({ w: im.naturalWidth || 0, h: im.naturalHeight || 0 }); };
        im.onerror = function () { res({ w: 0, h: 0 }); };
        im.src = durl;
      });
      return dim.then(function (d) {
        return { name: file.name || "图片", dataUrl: durl, blob: file, w: d.w, h: d.h };
      });
    });
  }
  // 2026-09-14 附件重构:图片统一进 window.attachSvc
  // (dataURL 留内存供本轮渲染/发送,Blob 存 IndexedDB 供刷新后还原);待发缩略图条由 attachments.js 渲染。
  var MAX_IMAGES = 4;
  function handleComposerAttach(files) {
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    var att = window.attachSvc;
    if (!att) { alert("附件模块未就绪,请刷新页面重试"); return; }
    var imgs = list.filter(function (f) { return svc.isImageFile(f); });
    var others = list.filter(function (f) { return !svc.isImageFile(f); });
    if (imgs.length) {
      // 2026-09-14 fix:图片配额只按「已附图片数」算。原用 att.count()(文件+图片总数)会让
      // 文本附件挤占图片名额 —— 先附 2 个文件后只能再加 2 张图,用户观感就是"只能传两张"。
      var used = (att.countImages ? att.countImages() : 0);
      var take = imgs.slice(0, svc.imageRoom(used, MAX_IMAGES).take);
      if (take.length < imgs.length) {
        alert("每条消息最多附 " + MAX_IMAGES + " 张图片,已加入前 " + take.length + " 张。");
      }
      take.forEach(function (f) {
        readAsImage(f).then(function (r) { att.addImage(r); })
          .catch(function () { alert("图片读取失败: " + f.name); });
      });
    }
    if (others.length) handleFiles(others); // 文本/代码/文档沿用①的结构化附件方案(不支持的格式会走 handleFiles 内的跳过提示)
  }
  function wireComposerAttach() {
    var btn = $("composerAttachBtn");
    var input = $("composerAttachInput");
    if (btn && input && !btn.__ceWired) {
      btn.__ceWired = true;
      btn.addEventListener("click", function () { input.click(); });
      input.addEventListener("change", function () { handleComposerAttach(input.files); input.value = ""; });
    }
  }

  // ───────── ② 共用:轻量弹窗样式 ─────────
  // (原「多开聊天」面板已移除 —— 会话列表搬到左栏常驻,见 ui/conv-list.js。
  //  这里保留 .ce-panel 主题样式供「聊天同步冲突」面板复用。)
  function app() { return window.hostApi.app || null; }
  function ensureStyles() {
    if ($("ceStyles")) return;
    var s = document.createElement("style");
    s.id = "ceStyles";
    // 2026-10-08 主题跟随修复：旧版 .ce-panel 每个主题各写一套硬编码底色，candle 还被后一条
    // （白底 rgba(255,255,255,.97)）盖掉 —— 深色烛夜主题里弹出纯白面板，正是"同步弹窗不跟随主题"。
    // 现在统一走主题变量（--bg/--border/文字继承），所有主题与明暗方案自动一致；只留一点描边强调。
    s.textContent = [
      ".ce-btn{font-size:12px;padding:6px 10px;border:1px solid rgba(127,127,127,.32);border-radius:8px;background:rgba(127,127,127,.06);color:inherit;cursor:pointer;}",
      ".ce-btn:hover{background:rgba(127,127,127,.16);}",
      ".ce-btn-primary{background:rgba(154,163,255,.16);border-color:rgba(154,163,255,.4);font-weight:600;}",
      ".ce-panel{width:min(440px,92vw);max-height:80vh;display:flex;flex-direction:column;border-radius:14px;overflow:hidden;background:var(--bg,#16161e);color:inherit;border:1px solid var(--border,rgba(127,127,127,.3));box-shadow:0 18px 50px rgba(0,0,0,.42);}"
    ].join("");
    document.head.appendChild(s);
  }

  // ───────── 4.76: 聊天同步冲突裁决面板 ─────────
  // 同一会话 slot 在两台设备都被改 → sync.js emit "chat-conflict" → 弹此面板让用户选保留哪份
  var cfMask = null, cfList = null, _cfResolvedAny = false;
  function ensureConflictModal() {
    if (cfMask) return cfMask;
    ensureStyles();
    cfMask = document.createElement("div");
    cfMask.id = "ceConflictMask";
    cfMask.style.cssText = "position:fixed;inset:0;z-index:10001;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.5);";
    var panel = document.createElement("div");
    panel.className = "ce-panel";
    var head = document.createElement("div");
    head.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px 16px;border-bottom:1px solid rgba(127,127,127,.18);";
    var title = document.createElement("div");
    title.style.cssText = "font-weight:600;font-size:15px;";
    title.textContent = "聊天同步冲突";
    var closeBtn = document.createElement("button");
    closeBtn.className = "ce-btn";
    closeBtn.textContent = "稍后处理";
    closeBtn.addEventListener("click", closeConflictModal);
    head.appendChild(title); head.appendChild(closeBtn);
    cfList = document.createElement("div");
    cfList.style.cssText = "overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:12px;";
    var note = document.createElement("div");
    note.style.cssText = "font-size:11px;opacity:.6;padding:0 16px 14px;line-height:1.6;";
    note.textContent = "同一会话在多台设备上都被修改了。请选择保留哪一份:「保留本机」用本设备版本,「保留云端」用另一台设备版本,「两个都留」会把云端版本另存为一条新会话。";
    panel.appendChild(head); panel.appendChild(cfList); panel.appendChild(note);
    cfMask.appendChild(panel);
    cfMask.addEventListener("click", function (e) { if (e.target === cfMask) closeConflictModal(); });
    document.body.appendChild(cfMask);
    return cfMask;
  }
  function previewOf(msgs) { return svc.previewOf(msgs); }
  // 2026-11-13 修：旧实现调用 a.getConvNameForSlot —— 该函数全仓库根本不存在，
  // 于是冲突面板永远只显示裸 id，用户无法判断"这是哪个会话"。改为直读会话注册表。
  function convMetaOf(slotKey) {
    var raw = null;
    try { raw = localStorage.getItem("cfw_conv_meta_v1") || "{}"; } catch (e) { return null; }
    return svc.convMetaOf(raw, slotKey);
  }
  function slotLabel(slotKey) {
    var raw = null;
    try { raw = localStorage.getItem("cfw_conv_meta_v1") || "{}"; } catch (e) { return "未命名会话"; }
    return svc.slotLabel(raw, slotKey);
  }
  function renderConflicts() {
    var sync = window.syncSvc;
    if (!cfList || !sync || !sync.getChatConflicts) return;
    var conflicts = sync.getChatConflicts() || [];
    if (!conflicts.length) { closeConflictModal(); if (_cfResolvedAny) { _cfResolvedAny = false; setTimeout(function () { location.reload(); }, 300); } return; }
    cfList.innerHTML = "";
    conflicts.forEach(function (c) {
      var box = document.createElement("div");
      box.style.cssText = "border:1px solid rgba(127,127,127,.22);border-radius:10px;padding:12px;";
      box.innerHTML =
        '<div style="font-weight:600;font-size:13px;margin-bottom:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(slotLabel(c.slotKey)) + '</div>' +
        '<div style="font-size:10.5px;opacity:.5;font-family:ui-monospace,Consolas,monospace;margin:0 0 8px;word-break:break-all;">' + esc(c.slotKey) + (convMetaOf(c.slotKey) ? '' : ' · 不在会话列表里（可能已被删除）') + '</div>' +
        '<div style="font-size:11.5px;opacity:.7;line-height:1.6;margin-bottom:4px;">本机:' + (c.localCount != null ? c.localCount : (c.localMsgs ? c.localMsgs.length : 0)) + ' 条 · ' + esc(previewOf(c.localMsgs)) + '</div>' +
        '<div style="font-size:11.5px;opacity:.7;line-height:1.6;margin-bottom:10px;">云端:' + (c.remoteCount != null ? c.remoteCount : (c.remoteMsgs ? c.remoteMsgs.length : 0)) + ' 条 · ' + esc(previewOf(c.remoteMsgs)) + '</div>' +
        '<div class="cf-acts" style="display:flex;gap:8px;flex-wrap:wrap;"></div>';
      var acts = box.querySelector(".cf-acts");
      [["保留本机", "local", true], ["保留云端", "remote", false], ["两个都留", "fork", false]].forEach(function (def) {
        var b = document.createElement("button");
        b.className = "ce-btn" + (def[2] ? " ce-btn-primary" : "");
        b.textContent = def[0];
        b.addEventListener("click", function () {
          try { window.syncSvc.resolveChatConflict(c.slotKey, def[1]); _cfResolvedAny = true; } catch (e) {}
          renderConflicts();
        });
        acts.appendChild(b);
      });
      cfList.appendChild(box);
    });
  }
  function openConflictPanel() { ensureConflictModal(); cfMask.style.display = "flex"; renderConflicts(); }
  function closeConflictModal() { if (cfMask) cfMask.style.display = "none"; }
  // 2026-11-13: 「刷新查看」提示条已彻底移除（showMergedToast 与 #ceMergedToast 均已删除）。
  // 同步收口为自动后它不再承载任何待办；只剩冲突面板仍需要人裁决。
  function wireSyncConflicts() {
    var sync = window.syncSvc;
    if (!sync || sync.__ceConflictWired) return;
    if (sync.onStatus) {
      sync.__ceConflictWired = true;
      sync.onStatus(function (status) {
        // 2026-11-11: chat-merged 不再弹提示条（会话改为手动拉取）。冲突仍需要用户裁决，保留面板。
        if (status === "chat-conflict") openConflictPanel();
      });
    }
    try { if (sync.getChatConflicts && sync.getChatConflicts().length) openConflictPanel(); } catch (e) {}
  }

  // ───────── 接线 ─────────
  // 2026-09-14:左栏「文件上传」「多开聊天」两个按钮已移除(前者由输入框回形针取代、
  // 后者由左栏常驻会话列表取代,见 ui/conv-list.js)。这里只留回形针与同步冲突面板。
  function wire() {
    wireComposerAttach();
    // 4.76: 等 sync.js 就绪后绑定聊天冲突事件(启动顺序不确定,轮询重试)
    var _cfTries = 0;
    (function tryWireCf() { if (window.syncSvc) wireSyncConflicts(); else if (_cfTries++ < 15) setTimeout(tryWireCf, 1000); })();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();