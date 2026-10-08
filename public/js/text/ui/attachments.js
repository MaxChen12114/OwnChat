// public/js/text/ui/attachments.js — 聊天附件统一层(文本 chip / 图片卡片 / 灯箱 / IDB 持久化)· 2026-09-14
//
// 背景(为什么要有这个模块):
//   旧实现把「附件」摊成两个裸内存全局 —— window.__agentPendingFileBlocks(文本全文数组)与
//   window.__agentPendingImage(图片 dataURL)。它们发送后即清空、刷新即消失,且聊天气泡只显示一行
//   中文摘要;一旦点「重试」(chat-ux.js 从气泡文字重建消息)或刷新,session 里那条含全文的消息被删掉,
//   附件内容就再也传不到模型了。图片同样完全不持久化,刷新后消失。
//
// 新模型:
//   · 待发状态:window.__attach.pending = [{id, kind:'text'|'image', name, chars, text?, truncated?, dataUrl?, blob?, w?, h?}]
//   · 消息落库:user 消息上挂结构化字段 files:[{name,chars,truncated,text}] / images:[{id,name,w,h}]
//     (照抄 assistant 消息 speakerId/speakerName/speakerIcon 那套「整对象随 session 持久化」的先例)
//   · content 保持「用户实际打的字」,不含文件全文 → 气泡重渲染时渲染 chip 而不是几万字原文
//   · 请求装配时才把全文/图片展开进 payload(app.js expandAttachmentMessages)
//   · 图片 Blob 存 IndexedDB(cfw_chat_images / blobs,外键),localStorage 只留 {id,name} 元数据
//     —— localStorage 只有 2MB,一张截图 base64 就能撑爆,绝不能进 cfw_chat_session_v1
//
// 依赖:无(零依赖 IIFE,自注入 CSS)。被 chat-extras.js 写入、被 app.js/chat-ux.js 读取。
(function () {
  "use strict";
  if (window.__attach) return;

  // ───────── IndexedDB:聊天图片 Blob 存储 ─────────
  // 刻意新开一个 DB:复用 cfw_image_gallery 需要升版本号(与现存 v1 打开方冲突、老用户读到 null),
  // 复用 cfw_image_album 则会被它自己的「清空画廊」按钮误删聊天图片。新 DB 独立、零冲突。
  var IDB_NAME = "cfw_chat_images";
  var IDB_STORE = "blobs";
  var _db = null;
  function idb() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (resolve) {
      try {
        var req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = function () { try { req.result.createObjectStore(IDB_STORE); } catch (e) {} };
        req.onsuccess = function () { _db = req.result; resolve(_db); };
        req.onerror = function () { resolve(null); };
        req.onblocked = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
  }
  function putBlob(id, blob) {
    return idb().then(function (db) {
      if (!db || !blob) return false;
      return new Promise(function (res) {
        try {
          var tx = db.transaction(IDB_STORE, "readwrite");
          tx.objectStore(IDB_STORE).put(blob, id);
          tx.oncomplete = function () { res(true); };
          tx.onerror = function () { res(false); };
          tx.onabort = function () { res(false); };
        } catch (e) { res(false); }
      });
    }).catch(function () { return false; });
  }
  function getBlob(id) {
    return idb().then(function (db) {
      if (!db) return null;
      return new Promise(function (res) {
        try {
          var r = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(id);
          r.onsuccess = function () { res(r.result || null); };
          r.onerror = function () { res(null); };
        } catch (e) { res(null); }
      });
    }).catch(function () { return null; });
  }
  function delBlob(id) {
    return idb().then(function (db) {
      if (!db) return;
      try { db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE).delete(id); } catch (e) {}
    }).catch(function () {});
  }
  if (indexedDB.databases) {
    // 启动时清一次孤儿缩略图(删消息后遗留的 blob):只保留当前 session 里引用的 id
    setTimeout(function () { gcOrphanBlobs(); }, 4000);
  }
  function gcOrphanBlobs() {
    try {
      var keep = {};
      var arr = (window.__app && window.__app.getSessionMessages) ? window.__app.getSessionMessages() : [];
      (arr || []).forEach(function (m) {
        (m && m.images ? m.images : []).forEach(function (im) { if (im && im.id) keep[im.id] = 1; });
        // 4.83: 文档全文也已迁入 IDB(消息 files 带 id) —— 不加入保留清单会被当孤儿删掉,
        // 表现为"刷新后文档内容消失/发送时模型收到空文档"
        (m && m.files ? m.files : []).forEach(function (f) { if (f && f.id) keep[f.id] = 1; });
      });
      // 待发附件(刚添加还没点发送)同样不能被当孤儿清掉
      try {
        (window.__attach && window.__attach.list ? window.__attach.list() : []).forEach(function (p) {
          if (p && p.id) keep[p.id] = 1;
        });
      } catch (e2) {}
      idb().then(function (db) {
        if (!db) return;
        try {
          var os = db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE);
          os.openCursor().onsuccess = function (e) {
            var c = e.target.result;
            if (!c) return;
            if (!keep[c.key]) { try { c.delete(); } catch (e2) {} }
            c.continue();
          };
        } catch (e) {}
      });
    } catch (e) {}
  }

  // ───────── 工具 ─────────
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function uid() { return "att_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function fmtChars(n) {
    n = parseInt(n, 10) || 0;
    if (n >= 10000) return (Math.round(n / 1000) / 10) + " 万字";
    if (n >= 1000) return (Math.round(n / 100) / 10) + " 千字";
    return n + " 字";
  }
  function fmtBytes(n) {
    n = parseInt(n, 10) || 0;
    if (n >= 1048576) return (Math.round(n / 104857.6) / 10) + "MB";
    if (n >= 1024) return Math.round(n / 102.4) / 10 + "KB";
    return n + "B";
  }
  function extOf(name) {
    var m = String(name || "").match(/\.([A-Za-z0-9]{1,6})$/);
    return m ? m[1].toLowerCase() : "";
  }
  // 文件类型配色(对齐 ZCode 那种「彩色文档图标 + 文件名」的胶囊 chip,不写死单一灰)
  var TYPE_COLORS = [
    [/^(pdf)$/, "#e0453a"],
    [/^(docx?|rtf|odt|pages)$/, "#2b6cb0"],
    [/^(pptx?|key)$/, "#d9480f"],
    [/^(xlsx?|csv|tsv|ods|numbers)$/, "#2f9e44"],
    [/^(md|markdown|mdx|rst|txt|text|log)$/, "#6b7280"],
    [/^(json|jsonc|json5|ya?ml|toml|ini|conf|env|xml)$/, "#a16207"],
    [/^(html?|css|scss|less|vue|svelte)$/, "#0891b2"],
    [/^(js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cc|cs|php|sh|bash|zsh|sql|graphql|gql|lua|dart|swift|r|pl)$/, "#7c3aed"]
  ];
  function typeColor(name) {
    var e = extOf(name);
    for (var i = 0; i < TYPE_COLORS.length; i++) {
      if (TYPE_COLORS[i][0].test(e)) return TYPE_COLORS[i][1];
    }
    return "#6b7280";
  }
  var DOC_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';

  // ───────── CSS(自注入,配色全走主题令牌) ─────────
  var STYLE_ID = "attachStyles";
  var CSS_TEXT = `
.att-strip{pointer-events:auto;width:100%;max-width:var(--content-max);margin:0 auto 8px;display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start;}
.att-strip:empty{display:none;}
.att-chip{position:relative;display:inline-flex;align-items:center;gap:8px;max-width:min(250px,72vw);padding:8px 14px;border-radius:999px;background:var(--bubble-ai,rgba(127,127,127,.10));border:1px solid var(--border,rgba(127,127,127,.24));box-shadow:0 1px 6px rgba(0,0,0,.10);font-size:12.5px;line-height:1.2;color:inherit;}
.att-chip-ico{flex:none;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;}
.att-chip-ico svg{width:18px;height:18px;display:block;}
.att-chip-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;}
.att-chip-trunc{flex:none;font-size:10px;font-weight:700;line-height:1;padding:3px 6px;border-radius:999px;color:#ffb648;border:1px solid rgba(255,182,72,.45);background:rgba(255,182,72,.12);}
.att-x{flex:none;width:19px;height:19px;border:none;border-radius:999px;background:rgba(127,127,127,.18);color:inherit;cursor:pointer;font-size:13px;line-height:1;padding:0;display:inline-flex;align-items:center;justify-content:center;opacity:.65;transition:opacity .15s,background .15s;}
.att-x:hover{opacity:1;background:rgba(232,96,125,.28);}
.att-wrap{display:flex;flex-direction:column;gap:6px;max-width:100%;margin:0 0 6px;}
.att-wrap:empty{display:none;}
.att-chips{display:flex;flex-wrap:wrap;gap:6px;}
.att-cards{display:flex;flex-wrap:wrap;gap:6px;}
.att-cards:empty{display:none;}
.att-card{position:relative;flex:none;height:96px;border-radius:10px;overflow:hidden;border:1px solid var(--border,rgba(127,127,127,.28));cursor:zoom-in;background:rgba(127,127,127,.12);transition:transform .15s ease,box-shadow .15s ease;}
.att-card:hover{transform:translateY(-1px);box-shadow:0 6px 18px rgba(0,0,0,.28);}
.att-card img{display:block;height:100%;width:auto;max-width:min(320px,60vw);object-fit:cover;}
.att-card.att-missing{display:flex;align-items:center;justify-content:center;width:120px;cursor:default;color:var(--muted,#9a9a9a);font-size:10.5px;text-align:center;padding:0 8px;line-height:1.4;}
.att-card .att-x{position:absolute;right:4px;top:4px;background:rgba(20,20,20,.72);color:#fff;}
#attLightbox{position:fixed;inset:0;background:rgba(0,0,0,.86);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;z-index:9990;padding:24px;box-sizing:border-box;animation:attFade .16s ease;}
#attLightbox img{max-width:92vw;max-height:86vh;object-fit:contain;border-radius:10px;box-shadow:0 30px 80px rgba(0,0,0,.6);}
.att-lb-bar{position:absolute;top:14px;right:16px;display:flex;gap:8px;}
.att-lb-bar a,.att-lb-bar button{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border-radius:9px;border:1px solid rgba(255,255,255,.22);background:rgba(30,30,30,.7);color:#fff;font-size:12px;text-decoration:none;cursor:pointer;font-family:inherit;}
.att-lb-bar a:hover,.att-lb-bar button:hover{background:rgba(60,60,60,.85);}
@keyframes attFade{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){.att-card{transition:none;}#attLightbox{animation:none;}}
@media (max-width:640px){.att-card{height:76px;}#attLightbox{padding:12px;}}
`;
  function ensureCss() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS_TEXT;
    (document.head || document.documentElement).appendChild(s);
  }

  // ───────── 灯箱 ─────────
  var lbEl = null;
  function closeLightbox() {
    if (!lbEl) return;
    if (lbEl.parentNode) lbEl.parentNode.removeChild(lbEl);
    lbEl = null;
    document.removeEventListener("keydown", lbKey, true);
  }
  function lbKey(e) { if (e.key === "Escape") { e.stopPropagation(); closeLightbox(); } }
  function openLightbox(src, name) {
    ensureCss();
    closeLightbox();
    lbEl = document.createElement("div");
    lbEl.id = "attLightbox";
    var img = document.createElement("img");
    img.src = src;
    img.alt = name || "附件图片";
    var bar = document.createElement("div");
    bar.className = "att-lb-bar";
    var dl = document.createElement("a");
    dl.href = src; dl.download = name || "image"; dl.textContent = "下载";
    var op = document.createElement("button");
    op.type = "button"; op.textContent = "新标签打开";
    op.addEventListener("click", function (e) { e.stopPropagation(); try { window.open(src, "_blank"); } catch (e2) {} });
    var cl = document.createElement("button");
    cl.type = "button"; cl.textContent = "关闭";
    bar.appendChild(dl); bar.appendChild(op); bar.appendChild(cl);
    lbEl.appendChild(img); lbEl.appendChild(bar);
    lbEl.addEventListener("click", function (e) { if (e.target === lbEl || e.target === cl) closeLightbox(); });
    document.body.appendChild(lbEl);
    document.addEventListener("keydown", lbKey, true);
  }

  // ───────── 待发状态 ─────────
  var pending = [];
  function list() { return pending.slice(); }
  function clear() { pending = []; renderPendingBar(); }
  // 4.83 根治: 文档全文不再随 session 进 localStorage(2MB blob 超限会从最旧裁消息=真丢)。
  // 全文双写: IDB(putBlob,刷新/跨设备会话还原后仍可读) + 本页内存备忘 _textMemo(覆盖 IDB 异步写入完成前的发送竞态)。
  // 消息里只存 {id,name,chars,truncated} 元数据;展开时经 fileFullText(f) 取回全文。
  var _textMemo = new Map();
  function addText(item) {
    var id = uid();
    var text = String(item.text == null ? "" : item.text);
    _textMemo.set(id, text);
    try { putBlob(id, new Blob([text], { type: "text/plain;charset=utf-8" })); } catch (e) {}
    pending.push({
      id: id, kind: "text", name: item.name || "未命名",
      chars: parseInt(item.chars, 10) || 0,
      truncated: !!item.truncated
    });
    renderPendingBar();
  }
  function addImage(item) {
    var p = {
      id: uid(), kind: "image", name: item.name || "图片",
      dataUrl: item.dataUrl || "", blob: item.blob || null,
      w: item.w || 0, h: item.h || 0
    };
    pending.push(p);
    if (p.blob) putBlob(p.id, p.blob);
    renderPendingBar();
    return p;
  }
  function remove(id) {
    for (var i = 0; i < pending.length; i++) {
      if (pending[i].id === id) { pending.splice(i, 1); break; }
    }
    renderPendingBar();
  }
  function takePending() {
    var files = [], images = [], filesMeta = [], imagesMeta = [];
    pending.forEach(function (p) {
      if (p.kind === "text") {
        // 4.83: 只带元数据(全文在 IDB/内存备忘,经 fileFullText 取回) —— 会话存储不再被文档全文撑爆
        files.push({ id: p.id, name: p.name, chars: p.chars, truncated: p.truncated });
      } else {
        images.push(p);
        imagesMeta.push({ id: p.id, name: p.name, w: p.w || 0, h: p.h || 0 });
      }
    });
    pending = [];
    renderPendingBar();
    return {
      files: files.length ? files : undefined,
      images: imagesMeta.length ? imagesMeta : undefined,
      _memImages: images // 仅供本次渲染取 dataUrl,不进 session
    };
  }
  function count() { return pending.length; }
  // 只数图片:图片有独立配额(视觉请求体/token 成本),不能被文本附件挤占
  function countImages() {
    var n = 0;
    pending.forEach(function (p) { if (p.kind === "image") n++; });
    return n;
  }

  // ───────── 渲染:文本 chip ─────────
  // 胶囊形 + 彩色文档图标 + 文件名截断(对齐 ZCode)
  // 4.83: 截断时追加可见「已截断」徽标 —— 旧版只有 title 悬浮提示,手机端无 hover 完全看不到
  function makeChipEl(f, onRemove) {
    var el = document.createElement("span");
    el.className = "att-chip";
    el.title = f.name + " · " + fmtChars(f.chars) + (f.truncated ? "(已截断)" : "");
    var ico = document.createElement("span");
    ico.className = "att-chip-ico";
    ico.style.color = typeColor(f.name);
    ico.innerHTML = DOC_SVG;
    var nm = document.createElement("span");
    nm.className = "att-chip-name";
    nm.textContent = f.name;
    el.appendChild(ico);
    el.appendChild(nm);
    if (f.truncated) {
      var tg = document.createElement("span");
      tg.className = "att-chip-trunc";
      tg.textContent = "已截断";
      tg.title = "原文 " + fmtChars(f.chars) + ",超过 " + ATT_MAX_CHARS + " 字上限,仅前 " + ATT_MAX_CHARS + " 字会发送";
      el.appendChild(tg);
    }
    if (onRemove) {
      var x = document.createElement("button");
      x.type = "button"; x.className = "att-x"; x.textContent = "×"; x.title = "移除";
      x.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); onRemove(); });
      el.appendChild(x);
    }
    return el;
  }

  // ───────── 渲染:图片卡片(+ 灯箱) ─────────
  // srcOf:内存里有 dataUrl 直接用;历史还原时按 id 从 IDB 取 Blob 并转 objectURL(带缓存,限量回收)
  var _urlCache = new Map();
  var URL_CACHE_MAX = 40;
  function cachedUrl(id, blob) {
    if (_urlCache.has(id)) return _urlCache.get(id);
    var u = URL.createObjectURL(blob);
    _urlCache.set(id, u);
    if (_urlCache.size > URL_CACHE_MAX) {
      var firstKey = _urlCache.keys().next().value;
      try { URL.revokeObjectURL(_urlCache.get(firstKey)); } catch (e) {}
      _urlCache.delete(firstKey);
    }
    return u;
  }
  function makeCardEl(meta, src, onRemove) {
    if (!src) {
      var ph = document.createElement("div");
      ph.className = "att-card att-missing";
      ph.textContent = "图片不可用(未同步到本设备)";
      ph.title = meta && meta.name ? meta.name : "";
      if (onRemove) {
        var x0 = document.createElement("button");
        x0.type = "button"; x0.className = "att-x"; x0.textContent = "×";
        x0.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); onRemove(); });
        ph.appendChild(x0);
      }
      return ph;
    }
    var card = document.createElement("div");
    card.className = "att-card";
    var img = document.createElement("img");
    img.src = src;
    img.alt = (meta && meta.name) || "附件图片";
    // 2026-10-08 内存:历史还原时整条会话的附件图都会被解码 —— 屏外的先不加载/不解码
    try { img.loading = "lazy"; img.decoding = "async"; } catch (e) {}
    card.appendChild(img);
    card.addEventListener("click", function () { openLightbox(src, (meta && meta.name) || ""); });
    if (onRemove) {
      var x = document.createElement("button");
      x.type = "button"; x.className = "att-x"; x.textContent = "×"; x.title = "移除";
      x.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); onRemove(); });
      card.appendChild(x);
    }
    return card;
  }
  // 统一的「塞一张图片卡片」:有 dataUrl 直接用;只有 id 时先放占位、从 IDB 取到 Blob 再换成真图
  function appendImageCard(container, meta, onRemove) {
    var inner = makeCardEl(meta, (meta && meta.dataUrl) || "", onRemove);
    container.appendChild(inner);
    if (meta && !meta.dataUrl && meta.id) {
      getBlob(meta.id).then(function (blob) {
        if (!blob) return; // 取不到(未同步到本设备/已清理) → 保留占位卡
        var real = makeCardEl(meta, cachedUrl(meta.id, blob), onRemove);
        if (inner.parentNode === container) container.replaceChild(real, inner);
      });
    }
    return inner;
  }
  // 把一组 {files, images, _memImages} 渲染进容器。
  // opts.before: 把附件块插到该元素「之前」(聊天里=插在气泡前面,与 ZCode 一样是气泡上方的独立一块);
  //              不传则追加到容器末尾(待发条用)。
  function renderInto(container, att, opts) {
    if (!container || !att) return container;
    ensureCss();
    opts = opts || {};
    var host = (opts.before && opts.before.parentNode) ? opts.before.parentNode : container;
    var wrap = host.querySelector(":scope > .att-wrap");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.className = "att-wrap";
      if (opts.before && opts.before.parentNode === host) host.insertBefore(wrap, opts.before);
      else host.appendChild(wrap);
    }
    // 顺序对齐 ZCode:图片缩略卡片在上,文件 chip 在下一行,气泡在最下
    var imgs = (att._memImages && att._memImages.length) ? att._memImages : (att.images || []);
    if (imgs.length) {
      var cards = document.createElement("div");
      cards.className = "att-cards";
      wrap.appendChild(cards);
      imgs.forEach(function (m) {
        appendImageCard(cards, m, opts.onRemoveImage ? function () { opts.onRemoveImage(m); } : null);
      });
    }
    if (att.files && att.files.length) {
      var row = document.createElement("div");
      row.className = "att-chips";
      att.files.forEach(function (f) {
        row.appendChild(makeChipEl(f, opts.onRemoveFile ? function () { opts.onRemoveFile(f); } : null));
      });
      wrap.appendChild(row);
    }
    return container;
  }

  // ───────── 待发条(输入框上方) ─────────
  var stripEl = null;
  function mountStrip() {
    ensureCss();
    if (stripEl && stripEl.parentNode) return stripEl;
    var anchor = document.getElementById("composer");
    var floating = document.querySelector(".input-floating");
    if (!anchor && !floating) return null;
    stripEl = document.createElement("div");
    stripEl.id = "attachStrip";
    stripEl.className = "att-strip";
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(stripEl, anchor);
    else floating.insertBefore(stripEl, floating.firstChild);
    return stripEl;
  }
  function renderPendingBar() {
    var el = mountStrip();
    if (!el) return;
    el.textContent = "";
    if (!pending.length) { el.style.display = "none"; return; }
    el.style.display = "";
    // 与聊天里一致:图片在上、文件 chip 在下(逐条可移除)
    var imgs = pending.filter(function (p) { return p.kind === "image"; });
    var files = pending.filter(function (p) { return p.kind === "text"; });
    if (imgs.length) {
      var cards = document.createElement("div");
      cards.className = "att-cards";
      imgs.forEach(function (p) { appendImageCard(cards, p, function () { remove(p.id); }); });
      el.appendChild(cards);
    }
    if (files.length) {
      var row = document.createElement("div");
      row.className = "att-chips";
      files.forEach(function (p) { row.appendChild(makeChipEl(p, function () { remove(p.id); })); });
      el.appendChild(row);
    }
  }
  // 把一条已发送消息上的附件重新放回待发(供「重试」:旧实现从气泡文字重建消息,
  // 附件内容就此永久丢失 —— 这是「换模型后点重试附件就不传了」的根因)
  function restage(msg) {
    if (!msg) return 0;
    var n = 0;
    (msg.files || []).forEach(function (f) {
      // 4.83: 新格式(files 带 id,全文在 IDB/备忘)复用原 id,不重复入库;
      // 旧格式(带 text)保留原样进待发,展开时按 f.text 兼容读取
      if (f.id) {
        pending.push({ id: f.id, kind: "text", name: f.name || "未命名", chars: parseInt(f.chars, 10) || 0, truncated: !!f.truncated });
      } else {
        pending.push({
          id: uid(), kind: "text", name: f.name || "未命名",
          chars: parseInt(f.chars, 10) || 0, truncated: !!f.truncated,
          text: String(f.text == null ? "" : f.text)
        });
      }
      n++;
    });
    (msg.images || []).forEach(function (im) {
      // 复用原 id → 图片 Blob 已在 IndexedDB 里,发送时能直接取回 dataURL
      pending.push({ id: im.id || uid(), kind: "image", name: im.name || "图片", dataUrl: "", blob: null, w: im.w || 0, h: im.h || 0 });
      n++;
    });
    if (n) renderPendingBar();
    return n;
  }

  // ───────── 发送装配:把附件展开进 payload ─────────
  // 把 dataURL 取齐(内存优先,否则 IDB blob → dataURL),供 vision 数组用
  function blobToDataUrl(blob) {
    return new Promise(function (res) {
      if (!blob) return res("");
      try {
        var fr = new FileReader();
        fr.onload = function () { res(String(fr.result || "")); };
        fr.onerror = function () { res(""); };
        fr.readAsDataURL(blob);
      } catch (e) { res(""); }
    });
  }
  function imageDataUrl(meta) {
    if (!meta) return Promise.resolve("");
    if (meta.dataUrl) return Promise.resolve(meta.dataUrl);
    if (meta.id) return getBlob(meta.id).then(blobToDataUrl);
    return Promise.resolve("");
  }
  // 4.83: 取回文档全文 —— 内存备忘(本页添加的,覆盖 IDB 异步写竞态) → 旧格式 f.text(兼容历史会话) → IDB
  async function fileFullText(f) {
    if (!f) return "";
    if (f.id && _textMemo.has(f.id)) return _textMemo.get(f.id) || "";
    if (typeof f.text === "string") return f.text;
    if (f.id) {
      try { var b = await getBlob(f.id); if (b) return await b.text(); } catch (e) {}
    }
    return "";
  }

  // 4.83: 截断阈值唯一真源(原先 chat-extras.js 与 app.js 各硬编码一份 20000 会漂移)。
  // 全文迁移 IndexedDB 后会话存储不再被文档撑爆,阈值从 20000 提到 100000
  // (10 万汉字 ≈ 10 万 token,已接近 128K 上游上下文的八成,再高单文档就放不进上下文了)。
  var ATT_MAX_CHARS = 100000;

  window.__attach = {
    list: list, count: count, countImages: countImages, clear: clear, remove: remove,
    addText: addText, addImage: addImage,
    takePending: takePending, restage: restage,
    renderInto: renderInto,
    renderPendingBar: renderPendingBar,
    openLightbox: openLightbox,
    putBlob: putBlob, getBlob: getBlob, delBlob: delBlob,
    imageDataUrl: imageDataUrl,
    fileFullText: fileFullText,
    fmtChars: fmtChars, fmtBytes: fmtBytes, esc: esc,
    ATT_MAX_CHARS: ATT_MAX_CHARS
  };
})();
