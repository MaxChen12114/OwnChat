(function () {
/**
 * The conversation-list rules, minus the DOM: relative-time formatting, the content signature
 * that gates redraws, preview/title copy, the ⋯-menu placement geometry, and the cheap raw-
 * snapshot gate.
 *
 * Two gates keep the list cheap and non-intrusive. The RAW gate (2026-10-07 E-D) compares the
 * raw localStorage strings of the session store and slot metadata first — unchanged strings skip
 * even the full-store JSON.parse inside listConversations. The SIG gate compares a projection of
 * the rendered fields only; unchanged content means no repaint, so hover states and an in-flight
 * rename are never disturbed. A cleared lastSig ("" after explicit user actions or events) always
 * forces a repaint.
 *
 * Menu placement: anchor below the ⋯ button, flip above when the menu would overflow the bottom,
 * and clamp inside the viewport with an 8px margin — all pure math so tests can lock it.
 * @module services/ui/conv-list
 */

/** Poll interval. Instant refresh comes from 4 event listeners + focus; polling is the fallback. */
const CL_POLL_MS = 8000;

/** localStorage keys whose raw bytes feed the cheap gate. */
const CL_LS_SESSION_KEY = "cfw_chat_session_v1";
const CL_LS_META_KEY = "cfw_chat_slot_meta_v1";

/** Rename input max length (also the guard against pasting a novel into the sidebar). */
const CL_NAME_MAX = 60;

/** Relative time label. `now` is injected for testability; the wiring passes Date.now().
 * Beyond 7 days the label switches to an absolute M/D date — "51 天前" reads worse than "4/12". */
function clFmtAgo(ts         , now        )         {
  if (!ts) return "";
  const s = Math.max(0, Math.round((now - Number(ts)) / 1000));
  if (s < 60) return "刚刚";
  if (s < 3600) return Math.round(s / 60) + " 分钟前";
  if (s < 86400) return Math.round(s / 3600) + " 小时前";
  if (s < 86400 * 7) return Math.round(s / 86400) + " 天前";
  const d = new Date(Number(ts));
  return d.getMonth() + 1 + "/" + d.getDate();
}

function rec(v         )                          {
  const out                          = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

/** Content signature over exactly the fields the row renders. Including charAvatar's presence
 * (not its URL) and running's boolean shape keeps the signature stable against irrelevant churn;
 * preview is truncated to 24 chars so a growing stream does not retrigger paints per poll. */
function clSigOf(list           )         {
  return JSON.stringify(
    list.map((rawItem) => {
      const c = rec(rawItem);
      const preview = typeof c["preview"] === "string" ? c["preview"] : "";
      return [
        c["convId"],
        c["name"],
        c["count"],
        c["updatedAt"],
        c["active"],
        c["charIcon"],
        Boolean(c["charAvatar"]),
        preview.slice(0, 24),
        Boolean(c["running"]),
      ];
    }),
  );
}

/** Cheap gate: skip the render entirely (no parse, no list call) when nothing the list reads has
 * changed on disk. First frame (lastSig === "") and explicit refreshes always pass through —
 * lastSig is cleared by every user action / event precisely so this gate cannot swallow them. */
function clRawSkip(
  force         ,
  lastSig        ,
  childCount        ,
  raw               ,
  lastRaw               ,
  metaRaw               ,
  lastMetaRaw               ,
)          {
  return Boolean(
    !force &&
      lastSig !== "" &&
      childCount > 0 &&
      raw === lastRaw &&
      metaRaw === lastMetaRaw,
  );
}

/** Signature gate: skip the repaint when the rendered projection is unchanged and the list has
 * content. An empty DOM (childCount 0) always repaints so a cleared sidebar rebuilds. */
function clSigSkip(sig        , lastSig        , childCount        )          {
  return sig === lastSig && childCount > 0;
}

/** Preview line: with messages show the stored preview (placeholder when it is blank), without
 * messages show "暂无消息". */
function clPreviewOf(count         , preview         )         {
  return count ? String(preview || "(无文字内容)") : "暂无消息";
}

/** Row tooltip: name (+ character) / message count / running marker. */
function clRowTitle(c         )         {
  const item = rec(c);
  const name = typeof item["name"] === "string" ? item["name"] : "";
  const charName = typeof item["charName"] === "string" ? item["charName"] : "";
  const count = item["count"];
  return (
    name +
    (charName ? " · " + charName : "") +
    "\n" +
    (count ? count + " 条消息" : "暂无消息") +
    (item["running"] ? "\n后台生成中…" : "")
  );
}

/** Menu placement for the ⋯ menu: below the anchor, flipped above when it would overflow the
 * bottom (keeping at least 8px from the top edge), and clamped horizontally with an 8px margin. */
function clMenuPos(
  anchor                                                ,
  menuW        ,
  menuH        ,
  winW        ,
  winH        ,
)                                {
  const left = Math.min(anchor.right - menuW, winW - menuW - 8);
  let top = anchor.bottom + 4;
  if (top + menuH > winH - 8) top = Math.max(8, anchor.top - menuH - 4);
  return { left: Math.max(8, left), top };
}

/** Commit decision for a rename: a non-empty value that actually differs. Returning null means
 * "just repaint" — do not call renameConversation with a no-op or an empty name. */
function clRenameCommit(oldName         , input         )                {
  const v = typeof input === "string" ? input.trim() : "";
  if (v && v !== oldName) return v;
  return null;
}

// Browser adapter, appended by l0/emit.mjs. Engine: services/ui/conv-list.ts; this file owns the
// DOM: the sidebar mount, the stylesheet, row/menu/rename construction and the poll/event wiring.
// Every decision lives in the engine — relative-time labels, the content signature, both redraw
// gates, preview/title copy, menu placement geometry, and the rename commit rule.
//
// Backstory: the old "multi-open chat" was a modal and conversations were slotted per character
// card, so only the current character's sessions were visible (none in multi-agent mode), and the
// sidebar "new conversation" button just wiped all history. This module provides a proper,
// always-on conversation list. It inserts a plain .sidebar-section-title + content; the foldable
// group wrapper is sidebar-groups.js's job.
//
// Refresh strategy: 8s poll + signature comparison (unchanged content means no repaint, so hover
// and in-flight renames are never disturbed), plus immediate repaints on character:changed /
// multi-agent:changed / chat-merged / chat-conflict / cfw:conv-turns / focus / visibility.
(function () {
  "use strict";
  if (window.__convList) return;

  var STYLE_ID = "convListStyles";
  var LIST_MAX = "40vh";
  var POLL_MS = CL_POLL_MS;
  // E-D: the 2.5s poll dropped to 8s — instant refresh is the events' job and the real saving is
  // the raw-snapshot gate in render() (unchanged strings skip even the store's JSON.parse).

  var CSS_TEXT = `
/* 2026-09-14 slimming: this used to be the visually heaviest part of the sidebar (dashed borders,
   large text, 26px avatars, dark fills). Now one notch lighter — the "new conversation" row lost
   its dashed border and went muted (brightens on hover); row height/avatar/font tightened. */
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
.conv-run{flex:none;width:6px;height:6px;border-radius:50%;background:var(--accent,#7fa4c9);box-shadow:0 0 0 3px rgba(127,164,201,.14);}
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

  var esc = window.__ownEscape.esc;
  function ensureCss() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS_TEXT;
    (document.head || document.documentElement).appendChild(s);
  }
  function app() { return window.__app || null; }
  function fmtAgo(ts) {
    return clFmtAgo(ts, Date.now());
  }
  var ICON_NEW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  var ICON_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5.5h16a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-9l-4.5 3.5V16.5H4A1.5 1.5 0 0 1 2.5 15V7A1.5 1.5 0 0 1 4 5.5z"/></svg>';

  // ───────── Mount: insert a "conversations" group (title + list) at the top of the left sidebar ─────────
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
    // Top of the nav: conversation switching is the most-used navigation; sidebar-groups.js wraps
    // it into the foldable group afterwards.
    nav.insertBefore(listEl, nav.firstChild);
    nav.insertBefore(title, listEl);
    return listEl;
  }

  // ───────── Render ─────────
  var lastSig = "";
  var _lastRaw = null;      // raw session-store string snapshot (E-D: skip the full-store parse when unchanged)
  var _lastMetaRaw = null;  // raw slot-metadata string snapshot
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

  function render(force) {
    var el = mount();
    if (!el) return;
    // While hidden, do no work (zero cost in the background) — but the skeleton must exist first:
    // everything in the group (including the "new conversation" button) is built by render, and a
    // background reload returning to the foreground used to show a title-only group. 2026-10-09:
    // skip only when the skeleton already exists; the first frame always renders it.
    if (document.hidden && !force && el.querySelector(".conv-new")) return;
    var a = app();
    if (!a || !a.listConversations) return;
    // E-D cheap gate: unchanged raw strings for both stores → skip even the JSON.parse.
    var raw = null, metaRaw = null;
    try { raw = localStorage.getItem(CL_LS_SESSION_KEY); } catch (e) {}
    try { metaRaw = localStorage.getItem(CL_LS_META_KEY); } catch (e) {}
    if (clRawSkip(Boolean(force), lastSig, el.childElementCount, raw, _lastRaw, metaRaw, _lastMetaRaw)) return;
    _lastRaw = raw; _lastMetaRaw = metaRaw;
    var list;
    try { list = a.listConversations() || []; } catch (e) { return; }
    var sig = clSigOf(list);
    if (clSigSkip(sig, lastSig, el.childElementCount)) return; // unchanged content → no repaint (keeps hover/rename)
    lastSig = sig;
    if (renaming || menuEl) return; // no repaint while renaming or with the menu open

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
      row.title = clRowTitle(c);
      row.innerHTML = avatarHtml(c)
        + '<span class="conv-main">'
        + '<span class="conv-top"><span class="conv-name">' + esc(c.name) + '</span>' + (c.running ? '<span class="conv-run" title="后台生成中"></span>' : '') + '<span class="conv-time">' + esc(fmtAgo(c.updatedAt || c.createdAt)) + "</span></span>"
        + '<span class="conv-prev">' + clPreviewOf(c.count, c.preview) + "</span>"
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

  // ───────── ⋯ menu: rename / delete ─────────
  function openMenu(row, c) {
    closeMenu();
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
    // Anchor next to the ⋯ button; flip above when it would overflow the viewport (engine math).
    var r = row.querySelector(".conv-more").getBoundingClientRect();
    var mw = menuEl.offsetWidth, mh = menuEl.offsetHeight;
    var pos = clMenuPos({ right: r.right, bottom: r.bottom, top: r.top }, mw, mh, window.innerWidth, window.innerHeight);
    menuEl.style.left = pos.left + "px";
    menuEl.style.top = pos.top + "px";
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
    input.maxLength = CL_NAME_MAX;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    var done = false;
    function commit(save) {
      if (done) return;
      done = true;
      renaming = false;
      if (save) {
        // The engine decides: non-empty AND actually different, or null → repaint only.
        var v = clRenameCommit(c.name, input.value);
        if (v !== null) { try { app().renameConversation(c.convId, v); } catch (e) {} }
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

  // ───────── Start ─────────
  function start() {
    mount();
    render(true); // 2026-10-09: first frame is forced — a background reload / cold start must still draw the skeleton
    setInterval(render, POLL_MS); // signature-gated; unchanged content does not repaint
    // 2026-10-05(A-4): dropped "conversations:changed" — no dispatcher anywhere in the repo, dead
    // listener. Instant refresh is these four (all with real dispatchers) plus the poll fallback.
    ["character:changed", "multi-agent:changed", "chat-merged", "chat-conflict", "cfw:conv-turns"].forEach(function (ev) {
      window.addEventListener(ev, function () { lastSig = ""; render(); });
    });
    // 2026-10-09: focus used to pass render directly (the event object became the force argument,
    // accidentally correct because truthy) → now explicit; visibilitychange added so returning
    // from a background reload repaints immediately instead of waiting out the 8s poll.
    window.addEventListener("focus", function () { render(true); });
    document.addEventListener("visibilitychange", function () { if (!document.hidden) render(true); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();

  window.__convList = { refresh: function () { lastSig = ""; render(true); }, mount: mount };
})();

globalThis.CL_POLL_MS = CL_POLL_MS;
globalThis.CL_LS_SESSION_KEY = CL_LS_SESSION_KEY;
globalThis.CL_LS_META_KEY = CL_LS_META_KEY;
globalThis.CL_NAME_MAX = CL_NAME_MAX;
globalThis.clFmtAgo = clFmtAgo;
globalThis.clSigOf = clSigOf;
globalThis.clRawSkip = clRawSkip;
globalThis.clSigSkip = clSigSkip;
globalThis.clPreviewOf = clPreviewOf;
globalThis.clRowTitle = clRowTitle;
globalThis.clMenuPos = clMenuPos;
globalThis.clRenameCommit = clRenameCommit;
})();
