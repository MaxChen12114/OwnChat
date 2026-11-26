// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/ui/cost-log.ts; this file owns the
// slot mount, the card insertion, the three buttons, the clipboard/confirm dialogs and every host
// read (the cost facade, the sync facade, localStorage). All folding and markup live in the engine.
//
// The card is mounted on `load` rather than at parse time because the settings drawer may not have
// built its slots yet; the slot lookup claims occupancy before checking the DOM so a page that still
// ships a static #costSummary keeps the claim without mounting a second copy.
(function () {
  "use strict";

  var LS_COST_LOG = "cfw_cost_log_v1";

  function costApi() {
    return window.hostApi && window.hostApi.cost ? window.hostApi.cost : null;
  }

  function readLog() {
    var api = costApi();
    return api && typeof api.loadCostLog === "function" ? api.loadCostLog() : {};
  }

  function refreshTopbar() {
    var api = costApi();
    if (api && typeof api.refreshTopbar === "function") api.refreshTopbar();
  }

  // Cheap enough to run on every settings open: one storage read plus one pass over the log.
  function render() {
    var api = costApi();
    var now = Date.now();
    var aggregate = costLogAggregate(readLog(), {
      today: costDateKey(new Date(now)),
      weekStart: costWeekStart(now),
      deviceId: api && typeof api.getDeviceId === "function" ? api.getDeviceId() : null,
      sumDay: api && typeof api.sumCostDay === "function" ? api.sumCostDay : undefined,
    });
    var summary = document.getElementById("costSummary");
    if (summary) summary.innerHTML = costSummaryHtml(aggregate);
    var daily = document.getElementById("costDailyList");
    if (daily) daily.innerHTML = costDailyListHtml(aggregate);
  }

  function mount() {
    var slot = window.slotRegistry.pick("setCostSlot");
    if (slot) window.slotRegistry.claim({ cardId: "costSummary", slotId: "setCostSlot" });
    if (!slot || document.getElementById("costSummary")) return;
    var card = document.createElement("div");
    card.className = "card";
    card.id = "costLogCard";
    card.innerHTML = costCardHtml();
    slot.appendChild(card);
  }

  function wireExport() {
    var btn = document.getElementById("costExportBtn");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var json = costLogJson(readLog());
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(json).then(
          function () { alert("已导出到剪贴板"); },
          function () { prompt("复制下方 JSON：", json); }
        );
      } else {
        prompt("复制下方 JSON：", json);
      }
    });
  }

  function wireClear() {
    var btn = document.getElementById("costClearBtn");
    if (!btn) return;
    btn.addEventListener("click", function () {
      if (!confirm("确定清空所有费用日志？此操作不可恢复。\n建议先导出备份。")) return;
      try { localStorage.removeItem(LS_COST_LOG); } catch (e) {}
      render();
      refreshTopbar();
    });
  }

  // Cloud sync is optional: without the facade or a password-backed token the button explains what
  // is missing instead of failing silently. The label doubles as the progress indicator.
  function wireSync() {
    var btn = document.getElementById("costSyncNowBtn");
    if (!btn) return;
    btn.addEventListener("click", async function () {
      var sync = window.syncSvc;
      if (!sync || !sync.pushCostNow) { alert("云同步模块未就绪"); return; }
      var status = (sync.getStatus && sync.getStatus()) || {};
      if (!status.hasToken) { alert("请先在设置里启用云同步（需密码）后再同步费用"); return; }
      var label = btn.textContent;
      btn.disabled = true;
      btn.textContent = "同步中…";
      try {
        await sync.pushCostNow();
        if (sync.pullCostOnStartup) await sync.pullCostOnStartup();
        render();
        refreshTopbar();
        btn.textContent = "✓ 已同步";
        setTimeout(function () { btn.textContent = label; btn.disabled = false; }, 1800);
      } catch (err) {
        btn.textContent = label;
        btn.disabled = false;
        alert("费用同步失败：" + ((err && err.message) || err));
      }
    });
  }

  window.addEventListener("load", function () {
    mount();
    wireExport();
    wireClear();
    wireSync();
    // The sync engine calls this after pulling remote buckets, so the card needs no poll of its own.
    var api = costApi();
    if (api) api.refreshSettings = render;
    render();
    // Background turns can bill between drawer opens; repaint when the settings button is pressed.
    var settingsBtn = document.getElementById("settingsBtn");
    if (settingsBtn) settingsBtn.addEventListener("click", render);
  });
})();
