// cost-log-ui.js — Phase 4 阶段 7 · 费用日志 UI（独立于本地历史）
// 拆自 index.html 内联 script（架构整理 · B 方案）
// 数据来源：window.__cost（由 app.js 暴露），LS key：cfw_cost_log_v1
(function () {
  window.addEventListener("load", function () {
    // ─── 4.71: 自挂载费用日志卡(从 index.html 收口) ───
    // index.html 仅保留 <div id="setCostSlot"></div> 空槽(放在「高级」分类内)。
    // 槽不存在 / 已有 #costSummary(静态卡还在)时静默跳过,兼容尚未改 index.html 的旧页面。
    (function mountCostCard() {
      var slot = document.getElementById("setCostSlot");
      if (!slot || document.getElementById("costSummary")) return;
      var card = document.createElement("div");
      card.className = "card";
      card.id = "costLogCard";
      card.innerHTML = '<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/><path d="M7 15h3"/></svg>费用日志（API 调用计费）</h4>'
        + '<p>快速模式（DeepSeek）按 token 实时计费,记录在本地(LS <code>cfw_cost_log_v1</code>)。开启云同步后费用会跨设备合并;下方按设备分桶汇总。免费模式(NVIDIA)不计费。</p>'
        + '<div id="costSummary" class="cost-summary"></div>'
        + '<div id="costDailyList" class="cost-daily"></div>'
        + '<div class="rowline" style="margin-top:10px;"><div></div><div class="btns">'
        + '<button class="smallbtn" id="costSyncNowBtn">同步费用</button>'
        + '<button class="smallbtn" id="costExportBtn">导出 JSON</button>'
        + '<button class="smallbtn danger" id="costClearBtn">清空日志</button>'
        + '</div></div>';
      slot.appendChild(card);
    })();
    function _ttoday() {
      var d = new Date();
      return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
    }
    function renderCostUI() {
      var log = (window.__cost && window.__cost.loadCostLog) ? window.__cost.loadCostLog() : {};
      var today = _ttoday();
      var monthPrefix = today.slice(0, 7);
      var wk = new Date(Date.now() - 6*86400000);
      var weekStr = wk.getFullYear() + "-" + String(wk.getMonth()+1).padStart(2,"0") + "-" + String(wk.getDate()).padStart(2,"0");
      // 4.50: 按设备分桶 → 用 window.__cost.sumCostDay 汇总每天(跨设备真求和);旧扁平也兼容
      function _sumDay(entry) {
        if (window.__cost && window.__cost.sumCostDay) return window.__cost.sumCostDay(entry);
        var o = { cost: 0, prompt: 0, completion: 0, requests: 0 };
        if (!entry || typeof entry !== "object") return o;
        var flat = (typeof entry.cost === "number" || typeof entry.requests === "number");
        var ks = flat ? [entry] : Object.keys(entry).map(function (k) { return entry[k]; });
        ks.forEach(function (e) { if (e && typeof e === "object") { o.cost += e.cost || 0; o.prompt += e.prompt || 0; o.completion += e.completion || 0; o.requests += e.requests || 0; } });
        return o;
      }
      // 4.53: 单设备桶求和(本机),用于区分「本机」与「全设备合计」
      var _devId = (window.__cost && window.__cost.getDeviceId) ? window.__cost.getDeviceId() : null;
      function _sumDayDev(entry, devId) {
        var o = { cost: 0, prompt: 0, completion: 0, requests: 0 };
        if (!entry || typeof entry !== "object" || !devId) return o;
        var flat = (typeof entry.cost === "number" || typeof entry.requests === "number");
        if (flat) { o.cost += entry.cost || 0; o.prompt += entry.prompt || 0; o.completion += entry.completion || 0; o.requests += entry.requests || 0; return o; }
        var e = entry[devId];
        if (e && typeof e === "object") { o.cost += e.cost || 0; o.prompt += e.prompt || 0; o.completion += e.completion || 0; o.requests += e.requests || 0; }
        return o;
      }
      function _isMulti(entry) {
        if (!entry || typeof entry !== "object") return false;
        var flat = (typeof entry.cost === "number" || typeof entry.requests === "number");
        if (flat) return false;
        return Object.keys(entry).length > 1;
      }
      var todayC = 0, weekC = 0, monthC = 0, totalC = 0, totalR = 0;
      var todayLocalC = 0, totalLocalC = 0;
      var anyMulti = false;
      var days = Object.keys(log).sort().reverse();
      days.forEach(function (d) {
        var e = _sumDay(log[d]);
        var le = _sumDayDev(log[d], _devId);
        if (_isMulti(log[d])) anyMulti = true;
        totalC += e.cost || 0;
        totalR += e.requests || 0;
        totalLocalC += le.cost || 0;
        if (d === today) { todayC += e.cost || 0; todayLocalC += le.cost || 0; }
        if (d >= weekStr) weekC += e.cost || 0;
        if (d.startsWith(monthPrefix)) monthC += e.cost || 0;
      });
      var sum = document.getElementById("costSummary");
      if (sum) {
        var todaySub = anyMulti ? '<span class="cost-sub">本机 ¥' + todayLocalC.toFixed(4) + '</span>' : '';
        var totalSub = anyMulti ? '<span class="cost-sub">本机 ¥' + totalLocalC.toFixed(4) + ' · ' + totalR + ' 次请求</span>' : '<span class="cost-sub">' + totalR + ' 次请求</span>';
        sum.innerHTML =
          '<div class="cost-cell"><span class="cost-label">今日' + (anyMulti ? '(合计)' : '') + '</span><span class="cost-val">¥' + todayC.toFixed(4) + '</span>' + todaySub + '</div>' +
          '<div class="cost-cell"><span class="cost-label">近 7 日</span><span class="cost-val">¥' + weekC.toFixed(4) + '</span></div>' +
          '<div class="cost-cell"><span class="cost-label">本月</span><span class="cost-val">¥' + monthC.toFixed(4) + '</span></div>' +
          '<div class="cost-cell total"><span class="cost-label">总计' + (anyMulti ? '(全设备)' : '') + '</span><span class="cost-val">¥' + totalC.toFixed(4) + '</span>' + totalSub + '</div>';
      }
      var list = document.getElementById("costDailyList");
      if (list) {
        if (!days.length) {
          list.innerHTML = '<div class="cost-empty">暂无数据。快速模式（DeepSeek）下发出第一条计费消息后开始记录。</div>';
        } else {
          list.innerHTML = days.map(function (d) {
            var e = _sumDay(log[d]);
            var multi = _isMulti(log[d]);
            var le = _sumDayDev(log[d], _devId);
            var localTag = multi ? '<span class="cost-meta">本机 ¥' + (le.cost||0).toFixed(5) + '</span>' : '';
            // 2026-09-14:去掉 🔗 emoji(多设备合计标记)。改用文字标记,避免混入 emoji 字体栈
            return '<div class="cost-row"><span class="cost-date">' + d + (multi ? ' <span class="cost-meta">· 多设备</span>' : '') + '</span>' +
              '<span class="cost-amt">¥' + (e.cost||0).toFixed(5) + '</span>' +
              '<span class="cost-meta">' + (e.requests||0) + ' 次 · in ' + (e.prompt||0) + ' / out ' + (e.completion||0) + '</span>' + localTag + '</div>';
          }).join("");
        }
      }
    }
    var exportBtn = document.getElementById("costExportBtn");
    if (exportBtn) {
      exportBtn.addEventListener("click", function () {
        var log = (window.__cost && window.__cost.loadCostLog) ? window.__cost.loadCostLog() : {};
        var json = JSON.stringify(log, null, 2);
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(json).then(
            function () { alert("已导出到剪贴板"); },
            function () { prompt("复制下方 JSON：", json); }
          );
        } else { prompt("复制下方 JSON：", json); }
      });
    }
    var clearBtn = document.getElementById("costClearBtn");
    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        if (!confirm("确定清空所有费用日志？此操作不可恢复。\n建议先导出备份。")) return;
        try { localStorage.removeItem("cfw_cost_log_v1"); } catch (e) {}
        renderCostUI();
        if (window.__cost && window.__cost.refreshTopbar) window.__cost.refreshTopbar();
      });
    }
    var costSyncBtn = document.getElementById("costSyncNowBtn");
    if (costSyncBtn) {
      costSyncBtn.addEventListener("click", async function () {
        var sync = window.__sync;
        if (!sync || !sync.pushCostNow) { alert("云同步模块未就绪"); return; }
        var st = (sync.getStatus && sync.getStatus()) || {};
        if (!st.hasToken) { alert("请先在设置里启用云同步（需密码）后再同步费用"); return; }
        var old = costSyncBtn.textContent;
        costSyncBtn.disabled = true;
        costSyncBtn.textContent = "同步中…";
        try {
          await sync.pushCostNow();
          if (sync.pullCostOnStartup) await sync.pullCostOnStartup();
          renderCostUI();
          if (window.__cost && window.__cost.refreshTopbar) window.__cost.refreshTopbar();
          costSyncBtn.textContent = "✓ 已同步";
          setTimeout(function () { costSyncBtn.textContent = old; costSyncBtn.disabled = false; }, 1800);
        } catch (e) {
          costSyncBtn.textContent = old;
          costSyncBtn.disabled = false;
          alert("费用同步失败：" + (e && e.message || e));
        }
      });
    }
    if (window.__cost) window.__cost.refreshSettings = renderCostUI;
    renderCostUI();
    // 打开 Settings 时刷新数字（防止后台有新计费）
    var sb = document.getElementById("settingsBtn");
    if (sb) sb.addEventListener("click", renderCostUI);
  });
})();