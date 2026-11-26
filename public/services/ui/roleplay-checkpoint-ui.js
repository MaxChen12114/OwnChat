(function () {
/**
 * Roleplay checkpoint UI flow: the save / restore / list decisions behind the message-row entry.
 *
 * The store and the plan module already own persistence and row shaping; this module owns the
 * order of the calls and every user-facing outcome. DOM, toasts and the list dialog arrive through
 * {@link CheckpointUiPorts}, so a vm can drive the whole flow with fake ports and no document.
 *
 * The plan functions are separate emit products bridged on globalThis; they are declared, not
 * imported, because the emit channel only carries import-free sources.
 * @module services/ui/roleplay-checkpoint-ui
 */

                                                                                         
                                                                                   
                                                                               
                                                                                           

/** One row the list presenter receives; structurally the plan's entry view. */
                                 
                      
                        
                           
                        
                                 
                       
 

/** Result envelope shared by `put` / `get` / `list`; missing fields are treated as failure. */
                                   
                        
                          
                             
                                   
 

/** The `__checkpoints` surface this flow consumes. */
                                  
                                          
                          
                                                                                                                                     
                                                                
                                                                                                    
                                                                   
 

/** What the wiring must provide: the store, the active conversation, the clock and the surfaces. */
                                    
                      
                                                                         
                           
                                                                 
                
                                                      
                     
                                                               
                                            
                                                                                            
                                                                           
 

/** Callbacks the presenter uses; closing is the presenter's own concern. */
                              
                            
 

/** Public surface; mirrors the old `window.roleplayCheckpointUi` methods. */
                                  
                            
                                             
                            
                           
 

/**
 * Create the checkpoint UI flow. Nothing runs until one of the three methods is called; a missing
 * conversation stops each flow with a toast instead of throwing.
 * @param ports - store, conversation source, clock, toast and list presenter from the wiring.
 * @returns The three entry points plus the refusal text the wiring exposes.
 */
function createCheckpointUi(ports                   )                  {
  function errorOf(res                                     )         {
    return res && typeof res.error === "string" && res.error ? res.error : "未知";
  }

  async function saveHere()                {
    const cid = ports.conversationId();
    if (!cid) {
      ports.toast("当前没有会话，无法存档");
      return;
    }
    const captured = ports.cp.captureRoleplay(ports.cp.roleplayHost());
    const res = await ports.cp.put("roleplay", cid, captured, {
      kind: "manual",
      subject: "手动存档 @" + ports.timeText(),
    });
    if (res && res.ok) ports.toast("已存档（" + cid + "）");
    else ports.toast("存档失败：" + errorOf(res));
  }

  async function restoreTo(targetId        )                {
    const cid = ports.conversationId();
    if (!cid) {
      ports.toast("当前没有会话");
      return;
    }
    const captured = ports.cp.captureRoleplay(ports.cp.roleplayHost());
    const plan = preRestorePlan(cid, targetId, captured, ports.now());
    if (!plan.ok) {
      ports.toast("error" in plan ? plan.error : "回退目标缺失");
      return;
    }
    const putRes = await ports.cp.put(plan.plan.scope, plan.plan.scopeId, plan.plan.payload, plan.plan.opts);
    if (!putRes || !putRes.ok) {
      ports.toast("恢复前自动存档失败：" + errorOf(putRes));
      return;
    }
    const got = await ports.cp.get(targetId);
    if (!got || !got.ok) {
      ports.toast("回退目标不可用：" + errorOf(got));
      return;
    }
    const ok = await ports.cp.applyRoleplay(got.payload, ports.cp.roleplayHost());
    if (!ok) {
      ports.toast(RESTORE_REFUSAL);
      return;
    }
    ports.toast("已回退；要撤销就再回退到「恢复前自动存档」");
  }

  async function openList()                {
    const cid = ports.conversationId();
    if (!cid) {
      ports.toast("当前没有会话");
      return;
    }
    const res = await ports.cp.list("roleplay", cid, 30);
    const rows = res && res.ok ? sortEntries(res.checkpoints || []) : [];
    const views                   = [];
    for (let i = 0; i < rows.length; i++) views.push(entryView(rows[i]));
    ports.presentList(views, { restore: restoreTo });
  }

  return { saveHere: saveHere, restoreTo: restoreTo, openList: openList, refusal: RESTORE_REFUSAL };
}

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

  // Row decoration: two small actions appended to each row's .stats.
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

globalThis.createCheckpointUi = createCheckpointUi;
})();
