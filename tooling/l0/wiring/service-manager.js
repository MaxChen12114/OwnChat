// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/local/service-manager.ts (row markup,
// list rule, card skeleton and the action plan); this file owns the shell probe, the invoke port,
// the status line, the mount and the poll timer.
(function (g) {
  "use strict";
  if (g.__svcMgr) return;

  function tauriInvoke() {
    try {
      return g.tauriSvc ? g.tauriSvc.invokeOrNull() : null;
    } catch (e) { return null; }
  }
  function $(id) { return document.getElementById(id); }
  function say(msg, isErr) {
    var el = $("svcStatusLine");
    if (!el) return;
    el.textContent = msg || "";
    el.style.color = isErr ? "var(--danger,#e8607d)" : "var(--muted,#8a8a8a)";
  }

  async function refresh() {
    var invoke = tauriInvoke();
    if (!invoke) return;
    try {
      var list = await invoke("svc_list");
      var box = $("svcListBox");
      if (box) box.innerHTML = svcListHtml(list);
    } catch (e) {
      say(svcErrorText("读取服务状态失败：", e), true);
    }
  }

  async function act(id, action, enabled) {
    var invoke = tauriInvoke();
    if (!invoke) return;
    try {
      var plan = svcActPlan(action, id, enabled);
      if (plan) {
        if (plan.status) say(plan.status);
        await invoke(plan.command, plan.args);
        if (plan.status) say("");
      }
    } catch (e) {
      say(svcErrorText("操作失败：", e), true);
    }
    refresh();
  }

  function mount() {
    if (!tauriInvoke()) return;
    var slot = $("setDevSlot");
    if (!slot || $("localServicesCard")) return;
    var card = document.createElement("div");
    card.className = "card";
    card.id = "localServicesCard";
    card.innerHTML = svcCardHtml();
    slot.appendChild(card);

    card.addEventListener("click", function (e) {
      var t = e.target;
      var b = (t && t.closest) ? t.closest("button[data-act]") : null;
      if (b) { act(b.getAttribute("data-id"), b.getAttribute("data-act")); return; }
      var cb = (t && t.matches && t.matches('input[type="checkbox"][data-act="enable"]')) ? t : null;
      if (cb) { act(cb.getAttribute("data-id"), "enable", cb.checked); }
    });
    $("svcRefreshBtn").addEventListener("click", refresh);

    refresh();
    setInterval(function () { if (document.visibilityState === "visible") refresh(); }, SVC_POLL_MS);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { setTimeout(mount, 1200); });
  else setTimeout(mount, 1200);
  // This name predates the frozen contract list and has no callers left; keep publishing it on the
  // same shape the original file used, so it never enters the allowlist as a new global.
  g.__svcMgr = { mount: mount, refresh: refresh };
})(window);
