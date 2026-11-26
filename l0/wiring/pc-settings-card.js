// Browser adapter, appended by l0/emit.mjs. Engine: services/local/pc-settings-card.ts (card markup,
// placement, health line, failure copy, the three toggle plans); this file owns localStorage, the
// fetch call, the shell probe and every listener.
(function (g) {
  "use strict";

  var LS_UNLOCKED = "cfw_unlocked_v1";
  var LS_ENABLED = "cfw_pc_enabled_v1";
  var LS_SKIP = "cfw_pc_skip_confirm_v1";
  var LS_TOKEN = "cfw_unlock_token_v1";
  var LS_AUTH = "cfw_auth_token_v1";
  var LS_DESK = "cfw_desk_url_v1";
  var LS_DESK_ON = "cfw_desk_enabled_v1";
  var LS_BRIDGE = "cfw_pc_bridge_token_v1";

  function ls(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function lsSet(key, value) { try { localStorage.setItem(key, value); } catch (e) {} }
  function lsDel(key) { try { localStorage.removeItem(key); } catch (e) {} }
  function $(id) { return document.getElementById(id); }
  function isTauri() {
    try {
      return !!(window.tauriSvc && window.tauriSvc.available());
    } catch (e) { return false; }
  }

  function toast(msg) {
    try {
      if (window.feedbackSvc && window.feedbackSvc.toast) return window.feedbackSvc.toast(msg, { ms: 2200 });
      var el = $("pcRemoteStatus");
      if (el) el.textContent = msg;
    } catch (e) {}
  }

  function setStatus(line) {
    var el = $("pcRemoteStatus");
    if (!el) return;
    el.textContent = line.text;
    el.style.color = pcStatusColor(line.tone);
  }

  function api(op, opts) {
    var req = pcApiRequest(op, opts || {}, pcToken(ls(LS_TOKEN), ls(LS_AUTH)));
    return fetch(req.url, req.init).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (d) {
        if (!r.ok) throw new Error(pcApiErrorText(r.status, d));
        return d;
      });
    });
  }

  async function refresh() {
    if (ls(LS_UNLOCKED) !== "1") return;
    setStatus({ text: "读取状态…", tone: "" });
    try {
      var h = await api("/health");
      var s = null;
      try { s = await api("/status"); } catch (e) {}
      var bits = pcHealthBits(h, s);
      if (bits === null) throw new Error("健康接口返回非对象");
      setStatus({ text: bits, tone: "good" });
    } catch (e) {
      setStatus(pcStatusFailure(e));
    }
  }

  function mount() {
    if (ls(LS_UNLOCKED) !== "1") return;
    var settings = $("settings");
    if (!settings) return;
    var agentCat = settings.querySelector('.set-cat[data-cat="agent"]');
    var existing = $("pcRemoteCard");
    var footer = $("settingsFooter");
    var target = pcMountTarget({
      hasAgentCat: !!agentCat,
      cardInAgentCat: !!(existing && agentCat && existing.parentNode === agentCat),
      footerInSettings: !!(footer && footer.parentNode === settings)
    });
    if (target === "skip") return;
    if (existing) existing.remove();

    var card = document.createElement("div");
    card.className = "card";
    card.id = "pcRemoteCard";
    card.innerHTML = pcCardHtml(isTauri());
    if (target === "agent") agentCat.appendChild(card);
    else if (target === "footer") settings.insertBefore(card, footer);
    else settings.appendChild(card);

    var cb = card.querySelector("#pcRemoteEnable");
    cb.checked = ls(LS_ENABLED) === "1";
    cb.addEventListener("change", function () {
      var plan = pcEnablePlan(cb.checked);
      lsSet(LS_ENABLED, plan.value);
      setStatus(plan.status);
      if (window.__pcTools && typeof window.__pcTools.setEnabled === "function") window.__pcTools.setEnabled(cb.checked);
    });

    var skipCb = card.querySelector("#pcSkipConfirm");
    skipCb.checked = ls(LS_SKIP) === "1";
    skipCb.addEventListener("change", function () {
      var plan = pcSkipPlan(skipCb.checked);
      lsSet(LS_SKIP, plan.value);
      setStatus(plan.status);
    });

    card.querySelector("#pcRemoteRefresh").addEventListener("click", refresh);

    var deskBtn = card.querySelector("#pcRemoteDesk");
    if (!pcDeskVisible(ls(LS_DESK_ON)) && deskBtn) { deskBtn.remove(); deskBtn = null; }
    if (deskBtn) deskBtn.addEventListener("click", function () {
      try { g.open(pcDeskUrl(ls(LS_DESK)), "_blank", "noopener"); } catch (e) { toast("打开失败：" + e.message); }
    });

    card.querySelector("#pcRemotePanic").addEventListener("click", async function () {
      try {
        await api("/panic", { body: {} });
        setStatus({ text: "已急停：输入通道关闭，重启 pc-bridge 才恢复。", tone: "bad" });
      } catch (e) { setStatus({ text: "急停失败：" + ((e && e.message) || e), tone: "bad" }); }
    });

    // Desktop-only row; the shell probe decides whether the node exists at all.
    var btIn = card.querySelector("#pcBridgeTokenInput");
    if (btIn) {
      var btSave = card.querySelector("#pcBridgeTokenSave");
      btIn.value = ls(LS_BRIDGE) || "";
      btSave.addEventListener("click", function () {
        var plan = pcBridgePlan(btIn.value);
        if (plan.remove) lsDel(LS_BRIDGE);
        else lsSet(LS_BRIDGE, plan.value);
        setStatus(plan.status);
      });
    }

    refresh();
  }

  // The panel may be opened long after boot; the gear click buys one more mount pass.
  function wire() {
    var btn = $("settingsBtn");
    if (btn && !btn.dataset.pcWired) {
      btn.dataset.pcWired = "1";
      btn.addEventListener("click", function () { setTimeout(mount, 250); });
    }
    mount();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { setTimeout(wire, 900); });
  } else {
    setTimeout(wire, 900);
  }
})(window);
