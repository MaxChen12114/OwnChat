// public/js/text/ui/conv-list.js — 左栏常驻「对话」会话列表 · 2026-09-14
//
// 为什么需要:旧「多开聊天」是个弹窗,而且会话按角色卡分槽(`<角色卡ID>#<会话ID>`),
// 只能看到当前角色的会话、多人模式下干脆没有;左栏「新对话」还是个清空全部历史的假按钮。
// 会话层已改成平铺(见 app.js 会话系统重做),这里提供正经软件那样的常驻会话列表:
//   参与角色头像 + 会话名 + 最后一条消息预览 + 相对时间 + 当前项高亮,点击即切,
//   悬停出「⋯」可重命名 / 删除。
//
// 刷新策略:2.5s 轮询 + 数据签名比对(内容没变就不重画,不打断悬停/重命名);
//           另监听 character:changed / multi-agent:changed / chat-merged 即时刷。
// 分组折叠:本模块只插入一个普通的 .sidebar-section-title + 内容,
//           由 sidebar-groups.js 统一包裹成可折叠分组(见该文件)。
(function () {
  "use strict";
  if (window.__convList) return;

  var STYLE_ID = "convListStyles";
  var LIST_MAX = "40vh";
  var POLL_MS = 2500;

  var CSS_TEXT = `
/* 2026-09-14 瘦身:这一组原来是列表区里视觉最重的部分(虚线边框 + 大字 + 26px 头像 + 深底色)。
   现在整体降一档 —— 「新建会话」去掉虚线边框、文字转 muted(悬停才提亮),行高/头像/字号同步收紧。 */
.conv-list{display:flex;flex-direction:column;gap:1px;max-height:${LIST_MAX};overflow-y:auto;overscroll-behavior:contain;padding:1px 0 3px;}
.conv-list::-webkit-scrollbar{width:6px;}
.conv-list::-webkit-scrollbar-thumb{background:rgba(127,127,127,.3);border-radius:3px;}
.conv-new{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;min-height:36px;padding:6px 8px;margin-bottom:1px;border:none;border-radius:9px;background:transparent;color:var(--muted,#9a9a9a);cursor:pointer;font:inherit;font-size:12.5px;text-align:left;transition:background .15s,color .15s;}
.conv-new:hover{background:rgba(127,127,127,.10);color:inherit;}
.conv-new svg{width:14px;height:14px;flex:none;opacity:.85;}
.conv-item{display:flex;align-items:center;gap:8px;padding:5px 7px;border-radius:9px;cursor:pointer;transition:background .15s;position:relative;}
.conv-item:hover{background:rgba(127,127,127,.09);}
.conv-item.active{background:rgba(127,127,127,.13);}
.conv-item.active .conv-name{font-weight:700;}
.conv-avatar{flex:none;width:22px;height:22px;border-radius:50%;overflow:hidden;display:inline-flex;align-items:center;justify-content:center;background:rgba(127,127,127,.14);font-size:12px;line-height:1;}
.conv-avatar img{width:100%;height:100%;object-fit:cover;display:block;}
.conv-avatar svg{width:12px;height:12px;opacity:.6;}
.conv-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:0;}
.conv-top{display:flex;align-items:baseline;gap:6px;min-width:0;}
.conv-name{flex:1;min-width:0;font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.conv-time{flex:none;font-size:9.5px;color:var(--muted,#9a9a9a);font-variant-numeric:tabular-nums;}
.conv-prev{font-size:10.5px;color:var(--muted,#9a9a9a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.3;}
.conv-more{flex:none;width:19px;height:19px;border:none;border-radius:6px;background:transparent;color:inherit;cursor:pointer;font-size:13px;line-height:1;padding:0;opacity:0;transition:opacity .15s,background .15s;}
.conv-item:hover .conv-more{opacity:.55;}
.conv-more:hover{opacity:1 !important;background:rgba(127,127,127,.2);}
.conv-rename{width:100%;box-sizing:border-box;font:inherit;font-size:12px;font-weight:600;padding:2px 5px;border-radius:6px;border:1px solid var(--btn-bg,rgba(127,127,127,.4));background:rgba(127,127,127,.12);color:inherit;}
.conv-rename:focus{outline:none;}
.conv-empty{font-size:11px;color:var(--muted,#9a9a9a);padding:5px 8px;line-height:1.5;}
.conv-menu{position:fixed;z-index:9995;min-width:112px;padding:4px;border-radius:10px;background:var(--bubble-ai,#16161e);border:1px solid var(--border,rgba(127,127,127,.3));box-shadow:0 12px 32px rgba(0,0,0,.35);display:flex;flex-direction:column;gap:1px;}
.conv-menu button{display:block;width:100%;text-align:left;padding:7px 10px;border:none;border-radius:7px;background:transparent;color:inherit;font:inherit;font-size:12.5px;cursor:pointer;}
.conv-menu button:hover{background:rgba(127,127,127,.16);}
.conv-menu button.danger{color:#e8607d;}
.conv-menu button.danger:hover{background:rgba(232,96,125,.16);}
`;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function ensureCss() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS_TEXT;
    (document.head || document.documentElement).appendChild(s);
  }
  function app() { return window.__app || null; }
  function fmtAgo(ts) {
    if (!ts) return "";
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return "刚刚";
    if (s < 3600) return Math.round(s / 60) + " 分钟前";
    if (s < 86400) return Math.round(s / 3600) + " 小时前";
    if (s < 86400 * 7) return Math.round(s / 86400) + " 天前";
    var d = new Date(ts);
    return (d.getMonth() + 1) + "/" + d.getDate();
  }
  var ICON_NEW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  var ICON_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5.5h16a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-9l-4.5 3.5V16.5H4A1.5 1.5 0 0 1 2.5 15V7A1.5 1.5 0 0 1 4 5.5z"/></svg>';

  // ───────── 挂载:往左栏插一个「对话」分组(标题 + 列表) ─────────
  var listEl = null;
  function mount() {
    ensureCss();
    if (listEl && listEl.parentNode) return listEl;
    var nav = document.querySelector("#leftSidebar .sidebar-nav") || document.querySelector(".sidebar-nav");
    if (!nav) return null;
    var title = document.createElement("div");
    title.className = "sidebar-section-title";
    title.textContent = "对话";
    listEl = document.createElement("div");
    listEl.className = "conv-list";
    listEl.id = "convList";
    // 放在最前面(会话切换是最常用的导航);sidebar-groups.js 会把它包成可折叠分组
    nav.insertBefore(listEl, nav.firstChild);
    nav.insertBefore(title, listEl);
    return listEl;
  }

  // ───────── 渲染 ─────────
  var lastSig = "";
  var renaming = false;
  var menuEl = null;

  function closeMenu() {
    if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
    menuEl = null;
  }

  function avatarHtml(item) {
    if (item.charAvatar) return '<span class="conv-avatar"><img src="' + esc(item.charAvatar) + '" alt=""></span>';
    if (item.charIcon) return '<span class="conv-avatar">' + esc(item.charIcon) + "</span>";
    return '<span class="conv-avatar">' + ICON_CHAT + "</span>";
  }

  function render() {
    var el = mount();
    if (!el) return;
    var a = app();
    if (!a || !a.listConversations) return;
    var list;
    try { list = a.listConversations() || []; } catch (e) { return; }
    var sig = JSON.stringify(list.map(function (c) {
      return [c.convId, c.name, c.count, c.updatedAt, c.active, c.charIcon, !!c.charAvatar, c.preview.slice(0, 24)];
    }));
    if (sig === lastSig && el.childElementCount) return; // 内容没变 → 不重画(不打断悬停/重命名)
    lastSig = sig;
    if (renaming || menuEl) return; // 正在重命名/开着菜单时不重画

    el.textContent = "";
    var nb = document.createElement("button");
    nb.type = "button";
    nb.className = "conv-new";
    nb.innerHTML = ICON_NEW + "<span>新建会话</span>";
    nb.addEventListener("click", function () {
      try { a.createConversation(""); } catch (e) {}
      lastSig = ""; render();
    });
    el.appendChild(nb);

    if (!list.length) {
      var em = document.createElement("div");
      em.className = "conv-empty";
      em.textContent = "还没有会话。点上方「新建会话」开始。";
      el.appendChild(em);
      return;
    }

    list.forEach(function (c) {
      var row = document.createElement("div");
      row.className = "conv-item" + (c.active ? " active" : "");
      row.dataset.conv = c.convId;
      row.title = c.name + (c.charName ? " · " + c.charName : "") + "\n" + (c.count ? c.count + " 条消息" : "暂无消息");
      row.innerHTML = avatarHtml(c)
        + '<span class="conv-main">'
        + '<span class="conv-top"><span class="conv-name">' + esc(c.name) + '</span><span class="conv-time">' + esc(fmtAgo(c.updatedAt || c.createdAt)) + "</span></span>"
        + '<span class="conv-prev">' + (c.count ? esc(c.preview || "(无文字内容)") : "暂无消息") + "</span>"
        + "</span>"
        + '<button type="button" class="conv-more" title="更多">⋯</button>';

      row.addEventListener("click", function (e) {
        if (e.target.closest(".conv-more")) return;
        if (row.querySelector(".conv-rename")) return;
        if (c.active) return;
        try { a.switchConversation(c.convId); } catch (err) {}
        lastSig = ""; render();
      });

      row.querySelector(".conv-more").addEventListener("click", function (e) {
        e.stopPropagation();
        openMenu(row, c);
      });

      el.appendChild(row);
    });
  }

  // ───────── 「⋯」菜单:重命名 / 删除 ─────────
  function openMenu(row, c) {
    closeMenu();
    var a = app();
    menuEl = document.createElement("div");
    menuEl.className = "conv-menu";
    var rn = document.createElement("button");
    rn.type = "button"; rn.textContent = "重命名";
    rn.addEventListener("click", function () { closeMenu(); startRename(row, c); });
    var del = document.createElement("button");
    del.type = "button"; del.className = "danger"; del.textContent = "删除会话";
    del.addEventListener("click", function () { closeMenu(); doDelete(c); });
    menuEl.appendChild(rn);
    menuEl.appendChild(del);
    document.body.appendChild(menuEl);
    // 贴着「⋯」定位,超出视口就翻到上方
    var r = row.querySelector(".conv-more").getBoundingClientRect();
    var mw = menuEl.offsetWidth, mh = menuEl.offsetHeight;
    var left = Math.min(r.right - mw, window.innerWidth - mw - 8);
    var top = r.bottom + 4;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
    menuEl.style.left = Math.max(8, left) + "px";
    menuEl.style.top = top + "px";
    setTimeout(function () {
      document.addEventListener("click", closeMenu, { once: true });
      document.addEventListener("keydown", function escOnce(ev) {
        if (ev.key === "Escape") { closeMenu(); document.removeEventListener("keydown", escOnce); }
      });
    }, 0);
  }

  function startRename(row, c) {
    renaming = true;
    var nameEl = row.querySelector(".conv-name");
    var input = document.createElement("input");
    input.className = "conv-rename";
    input.value = c.name || "";
    input.maxLength = 60;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    var done = false;
    function commit(save) {
      if (done) return;
      done = true;
      renaming = false;
      if (save) {
        var v = (input.value || "").trim();
        if (v && v !== c.name) { try { app().renameConversation(c.convId, v); } catch (e) {} }
      }
      lastSig = ""; render();
    }
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); commit(true); }
      else if (e.key === "Escape") { e.preventDefault(); commit(false); }
    });
    input.addEventListener("blur", function () { commit(true); });
    input.addEventListener("click", function (e) { e.stopPropagation(); });
  }

  function doDelete(c) {
    var fb = window.__feedback;
    var go = function () {
      try { app().deleteConversation(c.convId); } catch (e) {}
      lastSig = ""; render();
    };
    if (fb && fb.confirm) {
      fb.confirm({
        title: "删除会话",
        message: "确定删除「" + c.name + "」吗?" + (c.count ? "该会话的 " + c.count + " 条消息将被删除," : "") + "此操作不可撤销(云端备份同时删除)。",
        okText: "删除", cancelText: "取消", danger: true,
      }).then(function (ok) { if (ok) go(); });
    } else if (confirm("确定删除「" + c.name + "」吗?")) {
      go();
    }
  }

  // ───────── 启动 ─────────
  function start() {
    mount();
    render();
    setInterval(render, POLL_MS); // 带签名比对,内容没变不重画
    // 2026-10-05(A-4): 删掉 "conversations:changed" —— 全仓无任何 dispatch 处,死监听。
    // 即时刷新由其余 4 个事件(均有真实派发源) + 2.5s 轮询兜底。
    ["character:changed", "multi-agent:changed", "chat-merged", "chat-conflict"].forEach(function (ev) {
      window.addEventListener(ev, function () { lastSig = ""; render(); });
    });
    window.addEventListener("focus", render);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();

  window.__convList = { refresh: function () { lastSig = ""; render(); }, mount: mount };
})();
