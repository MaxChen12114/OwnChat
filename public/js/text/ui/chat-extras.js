// chat-extras.js —— 主聊天两个增强入口(接管左栏「文件上传」+「多开聊天」按钮)
// 路径: public/js/text/ui/chat-extras.js
// ① 文件上传:读纯文本/代码文件,内容以代码块注入输入框,随下条消息发给 AI(完全不碰发送核心)
// ② 多开聊天:同一角色的多条命名会话,列表式切换(底层走 window.__app 的会话槽 hooks)
(function () {
  if (window.__chatExtras) return;

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

  // ───────── ① 文件上传 ─────────
  var TEXT_EXT = /\.(txt|text|md|markdown|mdx|rst|json|jsonc|json5|csv|tsv|log|ya?ml|toml|ini|conf|env|xml|html?|css|scss|less|js|mjs|cjs|jsx|ts|tsx|vue|svelte|py|rb|go|rs|java|kt|c|h|cpp|hpp|cc|cs|php|sh|bash|zsh|sql|graphql|gql|lua|dart|swift|r|pl)$/i;
  // 4.83: 阈值唯一真源在 attachments.js(__attach.ATT_MAX_CHARS),运行时读取防两处漂移
  function maxChars() {
    try { return (window.__attach && window.__attach.ATT_MAX_CHARS) || 20000; } catch (e) { return 20000; }
  }
  // 4.83: 截断可见反馈 —— 旧版只写 chip 的 title 悬浮提示,手机端无 hover 完全看不到
  function toast(msg) {
    try { if (window.__feedback && window.__feedback.toast) return window.__feedback.toast(msg, { ms: 4200 }); } catch (e) {}
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
  // (window.__attach,见 attachments.js),输入框上方渲染可移除的文件 chip;
  // 全文存在消息的 files 字段上随 session 持久化,发送时才展开进 payload。
  function handleFiles(files) {
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    var att = window.__attach;
    if (!att) { alert("附件模块未就绪,请刷新页面重试"); return; }
    var MAX = maxChars();
    var skipped = [], truncatedNames = [];
    var jobs = list.map(function (f) {
      if (!TEXT_EXT.test(f.name) && !/^text\//.test(f.type || "")) { skipped.push(f.name); return Promise.resolve(null); }
      return readAsText(f).then(function (txt) {
        var truncated = false;
        var charCount = txt.length;
        if (txt.length > MAX) { txt = txt.slice(0, MAX); truncated = true; truncatedNames.push(f.name + "（" + charCount + " 字）"); }
        return { name: f.name, text: txt, chars: charCount, truncated: truncated };
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
  var IMG_TYPE = /^image\//i;
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
  // 2026-09-14 附件重构:图片不再走 window.__agentPendingImage,统一进 window.__attach
  // (dataURL 留内存供本轮渲染/发送,Blob 存 IndexedDB 供刷新后还原);待发缩略图条由 attachments.js 渲染。
  var MAX_IMAGES = 4;
  function handleComposerAttach(files) {
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    var att = window.__attach;
    if (!att) { alert("附件模块未就绪,请刷新页面重试"); return; }
    var imgs = list.filter(function (f) { return IMG_TYPE.test(f.type || ""); });
    var others = list.filter(function (f) { return !IMG_TYPE.test(f.type || ""); });
    if (imgs.length) {
      // 2026-09-14 fix:图片配额只按「已附图片数」算。原用 att.count()(文件+图片总数)会让
      // 文本附件挤占图片名额 —— 先附 2 个文件后只能再加 2 张图,用户观感就是"只能传两张"。
      var used = (att.countImages ? att.countImages() : 0);
      var room = Math.max(0, MAX_IMAGES - used);
      var take = imgs.slice(0, room);
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
  function app() { return window.__app || null; }
  function ensureStyles() {
    if ($("ceStyles")) return;
    var s = document.createElement("style");
    s.id = "ceStyles";
    s.textContent = [
      ".ce-btn{font-size:12px;padding:6px 10px;border:1px solid rgba(127,127,127,.32);border-radius:8px;background:rgba(127,127,127,.06);color:inherit;cursor:pointer;}",
      ".ce-btn:hover{background:rgba(127,127,127,.16);}",
      ".ce-btn-primary{background:rgba(154,163,255,.16);border-color:rgba(154,163,255,.4);font-weight:600;}",
      ".ce-panel{width:min(440px,92vw);max-height:80vh;display:flex;flex-direction:column;border-radius:14px;overflow:hidden;background:#16161e;color:#eaeaea;border:1px solid rgba(127,127,127,.25);box-shadow:0 12px 40px rgba(0,0,0,.4);}",
      "html:not([data-theme]):not([data-scheme=\"dark\"]) .ce-panel{background:#fff;color:#37352f;border-color:#e9e9e7;box-shadow:0 30px 80px rgba(15,15,15,.16);}",
      "html[data-theme=\"glass\"] .ce-panel{background:rgba(255,255,255,.97);color:#1a1f2e;border-color:rgba(15,30,60,.1);box-shadow:0 30px 80px rgba(60,80,140,.28);}",
      "html[data-theme=\"candle\"] .ce-panel{background:rgba(26,8,16,.97);color:#FFE8EF;border-color:rgba(255,107,157,.32);box-shadow:0 30px 80px rgba(0,0,0,.7),0 0 60px rgba(255,107,157,.18);}",
      "html[data-theme=\"candle\"] .ce-panel{background:rgba(255,255,255,.97);color:#4A0820;border-color:rgba(139,0,51,.22);box-shadow:0 30px 80px rgba(139,0,51,.3);}"
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
  function previewOf(msgs) {
    if (!Array.isArray(msgs) || !msgs.length) return "(空)";
    for (var i = msgs.length - 1; i >= 0; i--) {
      var m = msgs[i];
      if (m && typeof m.content === "string" && m.content.trim()) return m.content.trim().slice(0, 60);
    }
    return "(" + msgs.length + " 条)";
  }
  function slotLabel(slotKey) {
    var a = app();
    try { if (a && a.getConvNameForSlot) { var n = a.getConvNameForSlot(slotKey); if (n) return n; } } catch (e) {}
    return slotKey;
  }
  function renderConflicts() {
    var sync = window.__sync;
    if (!cfList || !sync || !sync.getChatConflicts) return;
    var conflicts = sync.getChatConflicts() || [];
    if (!conflicts.length) { closeConflictModal(); if (_cfResolvedAny) { _cfResolvedAny = false; setTimeout(function () { location.reload(); }, 300); } return; }
    cfList.innerHTML = "";
    conflicts.forEach(function (c) {
      var box = document.createElement("div");
      box.style.cssText = "border:1px solid rgba(127,127,127,.22);border-radius:10px;padding:12px;";
      box.innerHTML =
        '<div style="font-weight:600;font-size:13px;margin-bottom:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(slotLabel(c.slotKey)) + '</div>' +
        '<div style="font-size:11.5px;opacity:.7;line-height:1.6;margin-bottom:4px;">本机:' + (c.localCount != null ? c.localCount : (c.localMsgs ? c.localMsgs.length : 0)) + ' 条 · ' + esc(previewOf(c.localMsgs)) + '</div>' +
        '<div style="font-size:11.5px;opacity:.7;line-height:1.6;margin-bottom:10px;">云端:' + (c.remoteCount != null ? c.remoteCount : (c.remoteMsgs ? c.remoteMsgs.length : 0)) + ' 条 · ' + esc(previewOf(c.remoteMsgs)) + '</div>' +
        '<div class="cf-acts" style="display:flex;gap:8px;flex-wrap:wrap;"></div>';
      var acts = box.querySelector(".cf-acts");
      [["保留本机", "local", true], ["保留云端", "remote", false], ["两个都留", "fork", false]].forEach(function (def) {
        var b = document.createElement("button");
        b.className = "ce-btn" + (def[2] ? " ce-btn-primary" : "");
        b.textContent = def[0];
        b.addEventListener("click", function () {
          try { window.__sync.resolveChatConflict(c.slotKey, def[1]); _cfResolvedAny = true; } catch (e) {}
          renderConflicts();
        });
        acts.appendChild(b);
      });
      cfList.appendChild(box);
    });
  }
  function openConflictPanel() { ensureConflictModal(); cfMask.style.display = "flex"; renderConflicts(); }
  function closeConflictModal() { if (cfMask) cfMask.style.display = "none"; }
  // 4.77: 其他设备的新对话/更新已合并进本地(无冲突) → 底部提示并提供「刷新查看」,
  // 解决「手机端新建对话同步过来后桌面端不显示、没提示也没弹窗」。
  var mergedToast = null;
  function showMergedToast() {
    if (mergedToast) return; // 已有提示则不重复弹
    ensureStyles();
    mergedToast = document.createElement("div");
    mergedToast.id = "ceMergedToast";
    mergedToast.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:10002;display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:10px;background:rgba(20,20,28,.96);color:#eaeaea;border:1px solid rgba(154,163,255,.45);box-shadow:0 10px 30px rgba(0,0,0,.4);font-size:13px;max-width:92vw;";
    var txt = document.createElement("span");
    txt.textContent = "已从其他设备同步到对话更新";
    var refresh = document.createElement("button");
    refresh.className = "ce-btn ce-btn-primary";
    refresh.textContent = "刷新查看";
    refresh.addEventListener("click", function () { location.reload(); });
    var dismiss = document.createElement("button");
    dismiss.className = "ce-btn";
    dismiss.textContent = "稍后";
    dismiss.addEventListener("click", function () { if (mergedToast && mergedToast.parentNode) mergedToast.parentNode.removeChild(mergedToast); mergedToast = null; });
    mergedToast.appendChild(txt);
    mergedToast.appendChild(refresh);
    mergedToast.appendChild(dismiss);
    document.body.appendChild(mergedToast);
  }
  function wireSyncConflicts() {
    var sync = window.__sync;
    if (!sync || sync.__ceConflictWired) return;
    if (sync.onStatus) {
      sync.__ceConflictWired = true;
      sync.onStatus(function (status) {
        if (status === "chat-conflict") openConflictPanel();
        else if (status === "chat-merged") showMergedToast();
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
    (function tryWireCf() { if (window.__sync) wireSyncConflicts(); else if (_cfTries++ < 15) setTimeout(tryWireCf, 1000); })();
  }

  window.__chatExtras = { openFilePicker: openFilePicker, openConflicts: openConflictPanel };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();