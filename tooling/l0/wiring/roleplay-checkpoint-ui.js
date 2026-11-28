// Browser wiring for services/ui/roleplay-checkpoint-ui.ts: the message-row entry, the list dialog
// and the toast surface. The flow (save -> put, pre-restore -> get -> apply) and every outcome
// string live in the service; this file only does DOM and __checkpoints calls.
// Global name: window.roleplayCheckpointUi — deliberately not on the frozen window.__* surface.
(function () {
  "use strict";
  if (typeof window === "undefined") return;
  var CP = window.__checkpoints;
  if (!CP) return;

  var app = function () { return window.appSvc || null; };
  function conversationId() {
    var a = app();
    try { return a && a.getActiveConvId ? String(a.getActiveConvId() || "") : ""; } catch (e) { return ""; }
  }

  function toast(msg, ms) {
    var t = document.createElement("div");
    t.textContent = msg;
    t.style.cssText = "position:fixed;left:50%;bottom:76px;transform:translateX(-50%);z-index:99999;background:var(--panel,#1c1c1c);color:var(--text,#eee);border:1px solid var(--border,#333);border-radius:8px;padding:8px 14px;font-size:12.5px;";
    document.body.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, ms || 2600);
  }

  function closeList(box) {
    if (box && box.parentNode) box.parentNode.removeChild(box);
  }

  function presentList(rows, actions) {
    var box = document.createElement("div");
    box.id = "cpListDialog";
    box.style.cssText = "position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;";
    var panel = document.createElement("div");
    panel.style.cssText = "background:var(--panel,#1c1c1c);color:var(--text,#eee);border:1px solid var(--border,#333);border-radius:10px;padding:14px 16px;max-width:460px;width:92%;max-height:70vh;overflow:auto;font-size:12.5px;";
    var h = document.createElement("div");
    h.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;";
    var title = document.createElement("b");
    title.textContent = "存档列表（" + rows.length + "）";
    var x = document.createElement("button");
    x.className = "smallbtn";
    x.textContent = "关闭";
    x.addEventListener("click", function () { closeList(box); });
    h.appendChild(title);
    h.appendChild(x);
    panel.appendChild(h);
    if (!rows.length) {
      var empty = document.createElement("div");
      empty.style.cssText = "color:var(--muted,#888);padding:8px 0;";
      empty.textContent = "这个会话还没有存档。点消息行下的「存档」即可创建。";
      panel.appendChild(empty);
    }
    for (var i = 0; i < rows.length; i++) {
      var view = rows[i];
      var line = document.createElement("div");
      line.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 0;border-top:1px solid var(--border,#2a2a2a);";
      var left = document.createElement("span");
      left.innerHTML = view.isPreRestore
        ? '<b style="color:var(--muted,#888);">[恢复前自动存档]</b> ' + view.time
        : "<b>[" + view.tag + "]</b> " + view.time + (view.subject ? " · " + view.subject : "");
      var btn = document.createElement("button");
      btn.className = "smallbtn";
      btn.textContent = "回退到此";
      btn.dataset.cpTarget = view.id;
      btn.addEventListener("click", function () {
        var id = this.dataset.cpTarget;
        closeList(box);
        actions.restore(id);
      });
      line.appendChild(left);
      line.appendChild(btn);
      panel.appendChild(line);
    }
    box.appendChild(panel);
    box.addEventListener("click", function (e) { if (e.target === box) closeList(box); });
    document.body.appendChild(box);
  }

  var ui = createCheckpointUi({
    cp: CP,
    conversationId: conversationId,
    now: function () { return Date.now(); },
    timeText: function () { return new Date().toLocaleTimeString(); },
    toast: toast,
    presentList: presentList,
  });

  // Row decoration: two icon actions appended to the row's existing action row (.my-action-btns).
  // They used to be text buttons inside .stats. That put them on a second line, in a different
  // container from copy/delete, in a different visual language. Same container, same shell now.
  var CP_ICON_SAVE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 4.2h11a1.3 1.3 0 0 1 1.3 1.3v15.2l-6.8-4.1-6.8 4.1V5.5a1.3 1.3 0 0 1 1.3-1.3Z"/></svg>';
  var CP_ICON_RESTORE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9h9.5a5.5 5.5 0 0 1 0 11H9"/><path d="m8.5 4.5-4.5 4.5 4.5 4.5"/></svg>';

  // .my-action-btns is created by chat-ux on window load, i.e. after this observer first fires.
  // Retry briefly instead of leaving the row undecorated, and only mark it done once appended.
  function decorateRow(row, attempt) {
    if (!row || row.dataset.cpDone === "1") return;
    var content = row.querySelector(".content");
    var wrap = content ? content.querySelector(".my-action-btns") : null;
    if (!wrap) {
      if ((attempt || 0) < 15) setTimeout(function () { decorateRow(row, (attempt || 0) + 1); }, 150);
      return;
    }
    row.dataset.cpDone = "1";
    var save = document.createElement("button");
    save.className = "msg-action-btn icon-only";
    save.setAttribute("data-cp-act", "save");
    save.setAttribute("title", "存档：把当前状态存为一份快照");
    save.setAttribute("aria-label", "存档");
    save.innerHTML = CP_ICON_SAVE;
    var restore = document.createElement("button");
    restore.className = "msg-action-btn icon-only";
    restore.setAttribute("data-cp-act", "restore");
    restore.setAttribute("data-sidx", row.dataset.sidx || "");
    restore.setAttribute("title", "回退到这条消息时的状态");
    restore.setAttribute("aria-label", "回退");
    restore.innerHTML = CP_ICON_RESTORE;
    wrap.appendChild(save);
    wrap.appendChild(restore);
  }

  function decorateAll() {
    var rows = document.querySelectorAll("#chat .row[data-sidx]");
    for (var i = 0; i < rows.length; i++) decorateRow(rows[i]);
  }

  // New rows appear on every render/restore; decorate lazily instead of hooking the renderer.
  var ob = new MutationObserver(function () { decorateAll(); });
  function start() {
    var chat = document.getElementById("chat");
    if (!chat) { setTimeout(start, 300); return; }
    decorateAll();
    try { ob.observe(chat, { childList: true, subtree: false }); } catch (e) {}
    document.addEventListener("click", onClick);
  }

  function onClick(e) {
    var b = e.target && e.target.closest ? e.target.closest("[data-cp-act]") : null;
    if (!b) return;
    e.preventDefault();
    if (b.dataset.cpAct === "save") { ui.saveHere(); return; }
    if (b.dataset.cpAct === "restore") { ui.openList(); }
  }

  window.roleplayCheckpointUi = {
    decorateAll: decorateAll,
    saveHere: ui.saveHere,
    restoreTo: ui.restoreTo,
    openList: ui.openList,
    refusal: ui.refusal,
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
