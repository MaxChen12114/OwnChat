(function () {
/**
 * The "remote PC" card that sits under the agent category in Settings: card markup, placement, the
 * status line fed by `/api/pc/health` + `/api/pc/status`, the failure copy, and the three toggle
 * plans (allow the agent, skip the confirm card, store the bridge token).
 *
 * Everything decidable without a browser is here. localStorage reads, `fetch`, the shell probe and
 * every listener stay in `l0/wiring/pc-settings-card.js`, which also owns the card's outer element
 * and its insertion.
 *
 * The status line is built from health *and* an optional status payload because the second call is
 * allowed to fail on its own: a bridge that answers health but not status still gets a usable line,
 * so the caller swallows that failure and passes `null`. Health alone is not optional — a body that
 * is not an object yields `null` and the caller reports a read failure, where the old code let a
 * TypeError escape into the line.
 * @module services/local/pc-settings-card
 */

/** Desk front end used when the user has not overridden it in storage. */
const PC_DEFAULT_DESK = "https://desk.your-domain.example";

/** Colour family of the status line; anything but "bad" / "good" renders muted. */
                                               

/** Status line content: the text itself plus the tone it should be painted in. */
                               
               
                     
 

/** Where the card belongs, or that the current mount is already correct. */
                                                                     

/** What the mount needs to know about the settings tree; booleans only, no DOM in this module. */
                               
                                                
                       
                                                                                                  
                          
                                                                       
                            
 

/** A request ready for `fetch`; the URL prefix and the method/header rules are decided here. */
                               
              
         
                   
                                    
                  
    
 

/** The only two fields the card ever sets on a call. */
                               
                  
                                                                                   
                 
 

/** Storage write the caller should perform, plus the line to show right after. */
                               
                
                       
 

/** Bridge-token plan: either store the trimmed value or clear the key. */
                               
                
                  
                       
 

function recOf(v         )                          {
  const out                          = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

/** String form for fields that must not print `null`/`undefined` (storage reads, escapes). */
function strOf(v         )         {
  return v == null ? "" : String(v);
}

/** Read a possibly non-enumerable string field (`Error.message` is not in `Object.entries`). */
function fieldOf(v         )         {
  return typeof v === "string" ? v : "";
}

/** Status text of a thrown value, matching the old `String(e && e.message || e)`. */
function messageOf(err         )         {
  if (err && typeof err === "object") {
    const m = fieldOf(Reflect.get(err, "message"));
    if (m) return m;
  }
  return strOf(err);
}

/** CSS colour for a tone. The literal fallbacks cover cached pages from before the tokens existed. */
function pcStatusColor(tone              )         {
  return tone === "bad" ? "var(--danger, #e57373)" : tone === "good" ? "var(--ok, #58c78a)" : "var(--muted)";
}

/** Desk URL from storage, falling back to {@link PC_DEFAULT_DESK} on empty or unreadable storage. */
function pcDeskUrl(stored         )         {
  return strOf(stored) || PC_DEFAULT_DESK;
}

/**
 * Unlock token: the private-mode token wins over the general auth token.
 *
 * @returns the stored token, or `""` when neither key holds one.
 */
function pcToken(unlock         , auth         )         {
  return strOf(unlock) || strOf(auth) || "";
}

/**
 * Build the `fetch` call for `/api/pc<op>`.
 *
 * `content-type` is only added when a body is present, and the body is serialised here so the
 * caller never has to remember the shape.
 *
 * @param token bearer token from {@link pcToken}; the header is always sent, even when empty.
 */
function pcApiRequest(op        , opts              , token        )               {
  const headers                         = { authorization: "Bearer " + token };
  const init                       = {
    method: strOf(opts.method) || (opts.body !== undefined ? "POST" : "GET"),
    headers,
  };
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  return { url: "/api/pc" + op, init };
}

/**
 * Message for a failed response: the worker's `error` field when it carries one, else `HTTP <n>`.
 *
 * The result is thrown as the `Error` message and matched again by {@link pcStatusFailure}, so the
 * status code has to survive here for the 401/503/502 copy to fire.
 */
function pcApiErrorText(httpStatus        , payload         )         {
  const err = recOf(payload).error;
  return err ? strOf(err) : "HTTP " + httpStatus;
}

/**
 * Status line for a successful refresh.
 *
 * @param health parsed `/health` body; a non-object means the bridge answered with something
 *   unusable and yields `null` so the caller can report a read failure.
 * @param status parsed `/status` body, or `null` when that call failed — the health bits still stand.
 * @returns the ` · `-joined line, or `null` when `health` is not an object.
 */
function pcHealthBits(health         , status         )                {
  if (!health || typeof health !== "object" || Array.isArray(health)) return null;
  const h = recOf(health);
  const bits = ["在线"];
  if (h.readonly) bits.push("只读");
  if (h.panic) bits.push("已急停");
  bits.push("TTL " + String(h.ttlMin) + " 分钟");

  const s = recOf(status);
  if (s.screen) {
    const sc = recOf(s.screen);
    bits.push((s.locked ? "锁屏" : "未锁屏") + " · " + String(sc.width) + "x" + String(sc.height));
  }
  const fg = recOf(s.foreground);
  if (fg.title) bits.push("前台 " + String(fg.process) + " — " + String(fg.title));

  return bits.join(" · ");
}

/**
 * Map a thrown refresh error to the line the card shows. Order matters: 401 and 503 have their own
 * remedies, and only then does the tunnel case claim the 502 family.
 */
function pcStatusFailure(err         )               {
  const m = messageOf(err);
  if (/401/.test(m)) return { text: "未解锁或 token 失效（退出私密模式再重新解锁）", tone: "bad" };
  if (/503/.test(m)) return { text: "Worker 还没配 PC_* secrets（见 remote-desk/worker/worker.patch.md）", tone: "bad" };
  if (/502|隧道/.test(m)) return { text: "PC 隧道不可达：检查电脑上的 cloudflared 与 pc-bridge", tone: "bad" };
  return { text: "状态读取失败：" + m, tone: "bad" };
}

/**
 * Placement decision for one mount pass.
 *
 * A card already parented under the agent category means the mount is a no-op — the caller must not
 * remove it first, or every call would rebuild the card and drop the status line.
 */
function pcMountTarget(input              )                {
  if (input.cardInAgentCat) return "skip";
  if (input.hasAgentCat) return "agent";
  if (input.footerInSettings) return "footer";
  return "settings";
}

/**
 * Card markup, minus the outer `.card` element the caller creates.
 *
 * @param isTauri renders the desktop-only bridge-token row; the shell is probed on every mount, so a
 *   tab that gains the shell later still gets the row.
 */
function pcCardHtml(isTauri         )         {
  return '<h4>远程电脑</h4>' +
    '<p>私密模式下，让 agent 用手机操作这台电脑（屏幕 / 控件树 / 键鼠 / 剪贴板）。' +
    '需要电脑上 <code>pc-bridge</code> 与 <code>cloudflared</code> 在跑；' +
    '远程桌面另走 Cloudflare Access 邮箱验证码。</p>' +
    '<div class="rowline">' +
    '  <div class="toggle"><input type="checkbox" id="pcRemoteEnable"><label for="pcRemoteEnable">允许 agent 操作</label></div>' +
    '  <div class="toggle"><input type="checkbox" id="pcSkipConfirm"><label for="pcSkipConfirm">操作免确认</label></div>' +
    '  <div class="btns">' +
    '    <button class="smallbtn" id="pcRemoteRefresh" type="button">刷新状态</button>' +
    '    <button class="smallbtn" id="pcRemoteDesk" type="button">打开远程桌面</button>' +
    '    <button class="smallbtn danger" id="pcRemotePanic" type="button">断开</button>' +
    '  </div>' +
    '</div>' +
    '<div id="pcRemoteStatus" style="font-size:11px;color:var(--muted);margin-top:8px;"></div>' +
    (isTauri ?
      '<div style="margin-top:10px;font-size:11.5px;color:var(--muted);line-height:1.5;">' +
      '桌面端直连：粘贴本机 <code>remote-desk/.pc-token</code> 的内容后，agent 工具优先直连 <code>127.0.0.1:8802</code>' +
      '（不经隧道；不填则走 Worker 通道）。' +
      '<div class="rowline" style="margin-top:6px;">' +
      '  <input type="password" id="pcBridgeTokenInput" placeholder="bridge token（.pc-token 内容）" style="flex:1;min-width:0;font:inherit;font-size:12px;padding:6px 8px;border:1px solid var(--border,rgba(127,127,127,.3));border-radius:8px;background:transparent;color:inherit;">' +
      '  <button class="smallbtn" id="pcBridgeTokenSave" type="button">保存</button>' +
      '</div></div>' : '');
}

/** Storage value plus line for the "allow the agent" checkbox. */
function pcEnablePlan(checked         )               {
  return checked
    ? { value: "1", status: { text: "已允许 agent 操作（下一条消息生效）", tone: "good" } }
    : { value: "0", status: { text: "已禁止 agent 操作", tone: "" } };
}

/**
 * Storage value plus line for the "skip the confirm card" checkbox.
 *
 * The tones are lopsided on purpose: enabling the shortcut stays muted, restoring the permission
 * prompt is the state worth confirming in green.
 */
function pcSkipPlan(checked         )               {
  return checked
    ? { value: "1", status: { text: "已免确认：远程电脑工具直接执行，不再弹放行卡", tone: "" } }
    : { value: "0", status: { text: "已恢复确认：远程电脑工具执行前会弹放行卡", tone: "good" } };
}

/** Whether the "open desktop" button stays: hidden only on an explicit stored `"0"`. */
function pcDeskVisible(stored         )          {
  return strOf(stored) !== "0";
}

/** Bridge-token save: trim, then either store or clear. Empty input is the clear path. */
function pcBridgePlan(raw         )               {
  const value = strOf(raw).trim();
  return value
    ? { value, remove: false, status: { text: "已保存 bridge token（agent 工具将直连本机 bridge）", tone: "good" } }
    : { value: "", remove: true, status: { text: "已清空（走 Worker 通道）", tone: "" } };
}

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

globalThis.pcStatusColor = pcStatusColor;
globalThis.pcDeskUrl = pcDeskUrl;
globalThis.pcToken = pcToken;
globalThis.pcApiRequest = pcApiRequest;
globalThis.pcApiErrorText = pcApiErrorText;
globalThis.pcHealthBits = pcHealthBits;
globalThis.pcStatusFailure = pcStatusFailure;
globalThis.pcMountTarget = pcMountTarget;
globalThis.pcCardHtml = pcCardHtml;
globalThis.pcEnablePlan = pcEnablePlan;
globalThis.pcSkipPlan = pcSkipPlan;
globalThis.pcDeskVisible = pcDeskVisible;
globalThis.pcBridgePlan = pcBridgePlan;
})();
