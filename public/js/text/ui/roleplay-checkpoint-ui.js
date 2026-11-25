// Browser wiring for services/ui/roleplay-checkpoint-plan.ts: the save/restore entry on message
// rows, the list dialog and the restore flow (pre-restore snapshot -> get -> apply).
// Global name: window.roleplayCheckpointUi — deliberately not on the frozen window.__* surface
// (the plan module carries the decisions; this file only does DOM and __checkpoints calls).
// public/js/text/ui/roleplay-checkpoint-ui.js — roleplay 存档/回退 UI 的 DOM 胶水（boot 胶水形态）。
// 纯决策在 services/ui/roleplay-checkpoint-plan.ts（emit 产物桥接到全局：sortEntries/entryView/
// preRestorePlan/RESTORE_REFUSAL）；本文件只做行装饰、列表对话框与 __checkpoints 调用。
// 全局名 window.roleplayCheckpointUi —— 非 __ 前缀，不扩冻结面。
(function () {
  "use strict";
  if (typeof window === "undefined") return;
  var CP = window.__checkpoints;
  if (!CP) return;

  var app = function () { return window.__app || null; };
  var convId = function () {
    var a = app();
    try { return a && a.getActiveConvId ? String(a.getActiveConvId() || "") : ""; } catch (e) { return ""; }
  };

  // ── row decoration: two small actions appended to each row's .stats ──
  function decorateRow(row) {
    if (!row || row.dataset.cpDone === "1") return;
    var stats = row.querySelector(".stats");
    if (!stats) return;
    row.dataset.cpDone = "1";
    var span = document.createElement("span");
    span.className = "cp-actions";
    span.style.cssText = "margin-left:8px;opacity:.75;";
    span.innerHTML =
      '<button class="smallbtn" data-cp-act="save" title="把当前状态存为存档">存档</button>' +
      '<button class="smallbtn" data-cp-act="restore" data-sidx="' + row.dataset.sidx + '" title="回退到这条消息时的状态">回退</button>';
    stats.appendChild(span);
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

  function toast(msg, ms) {
    var t = document.createElement("div");
    t.textContent = msg;
    t.style.cssText = "position:fixed;left:50%;bottom:76px;transform:translateX(-50%);z-index:99999;background:var(--panel,#1c1c1c);color:var(--text,#eee);border:1px solid var(--border,#333);border-radius:8px;padding:8px 14px;font-size:12.5px;";
    document.body.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, ms || 2600);
  }

  // ── save: capture the live state and put it as a manual checkpoint ──
  async function saveHere() {
    var cid = convId();
    if (!cid) { toast("当前没有会话，无法存档"); return; }
    var captured = CP.captureRoleplay(CP.roleplayHost());
    var res = await CP.put("roleplay", cid, captured, { kind: "manual", subject: "手动存档 @" + new Date().toLocaleTimeString() });
    if (res && res.ok) toast("已存档（" + cid + "）");
    else toast("存档失败：" + ((res && res.error) || "未知"));
  }

  // ── restore: pre-restore snapshot -> get -> apply; refusal means a turn is live ──
  async function restoreTo(targetId) {
    var cid = convId();
    if (!cid) { toast("当前没有会话"); return; }
    var captured = CP.captureRoleplay(CP.roleplayHost());
    var plan = preRestorePlan(cid, targetId, captured, Date.now());
    if (!plan.ok) { toast(plan.error); return; }
    var putRes = await CP.put(plan.plan.scope, plan.plan.scopeId, plan.plan.payload, plan.plan.opts);
    if (!putRes || !putRes.ok) { toast("恢复前自动存档失败：" + ((putRes && putRes.error) || "未知")); return; }
    var got = await CP.get(targetId);
    if (!got || !got.ok) { toast("回退目标不可用：" + ((got && got.error) || "未知")); return; }
    var ok = await CP.applyRoleplay(got.payload, CP.roleplayHost());
    if (!ok) { toast(RPC_PLAN_REFUSAL); return; }
    toast("已回退；要撤销就再回退到「恢复前自动存档」");
  }

  // ── list dialog ──
  function closeList(box) {
    if (box && box.parentNode) box.parentNode.removeChild(box);
  }
  async function openList() {
    var cid = convId();
    if (!cid) { toast("当前没有会话"); return; }
    var res = await CP.list("roleplay", cid, 30);
    var list = res && res.ok ? sortEntries(res.checkpoints || []) : [];
    var box = document.createElement("div");
    box.id = "cpListDialog";
    box.style.cssText = "position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;";
    var panel = document.createElement("div");
    panel.style.cssText = "background:var(--panel,#1c1c1c);color:var(--text,#eee);border:1px solid var(--border,#333);border-radius:10px;padding:14px 16px;max-width:460px;width:92%;max-height:70vh;overflow:auto;font-size:12.5px;";
    var h = document.createElement("div");
    h.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;";
    var title = document.createElement("b");
    title.textContent = "存档列表（" + list.length + "）";
    var x = document.createElement("button");
    x.className = "smallbtn";
    x.textContent = "关闭";
    x.addEventListener("click", function () { closeList(box); });
    h.appendChild(title); h.appendChild(x);
    panel.appendChild(h);
    if (!list.length) {
      var empty = document.createElement("div");
      empty.style.cssText = "color:var(--muted,#888);padding:8px 0;";
      empty.textContent = "这个会话还没有存档。点消息行下的「存档」即可创建。";
      panel.appendChild(empty);
    }
    for (var i = 0; i < list.length; i++) {
      var view = entryView(list[i]);
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
        window.roleplayCheckpointUi.restoreTo(id);
      });
      line.appendChild(left); line.appendChild(btn);
      panel.appendChild(line);
    }
    box.appendChild(panel);
    box.addEventListener("click", function (e) { if (e.target === box) closeList(box); });
    document.body.appendChild(box);
  }

  // ── delegated click for the row buttons ──
  function onClick(e) {
    var b = e.target && e.target.closest ? e.target.closest("[data-cp-act]") : null;
    if (!b) return;
    e.preventDefault();
    if (b.dataset.cpAct === "save") { saveHere(); return; }
    if (b.dataset.cpAct === "restore") { openList(); }
  }

  var RPC_PLAN_REFUSAL = RESTORE_REFUSAL || "有回复正在生成，先停止再回退";
  window.roleplayCheckpointUi = {
    decorateAll: decorateAll,
    saveHere: saveHere,
    restoreTo: restoreTo,
    openList: openList,
    refusal: RPC_PLAN_REFUSAL,
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
