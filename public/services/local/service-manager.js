(function () {
/**
 * Local service manager: the settings card that lists the services bundled with the desktop shell
 * (state dot, name, port, description, "start on launch", start/stop).
 *
 * Every entry point is pure. The shell probe, the invoke port, the status line, the mount and the
 * poll timer live in the wiring, because none of them exist in a browser tab — this card only ever
 * appears in the desktop app.
 *
 * Row markup is generated here rather than in the wiring so the four states (running / stopped,
 * available / unavailable) stay testable without a DOM. The reason line is gated on `available`
 * alone, not on `running`: the shell's availability verdict is the only thing the reason explains.
 * @module services/local/service-manager
 */

/** Poll interval for the card while the window is visible; the shell is the source of truth. */
const SVC_POLL_MS = 10000;

/** One service as the shell reports it, with every field narrowed to the type the markup needs. */
                           
                                                                            
             
                      
               
                                                    
               
                                                                                       
               
                           
                   
                                                                                         
                     
                                          
                   
                                                                     
                 
 

/** What one click should invoke: the command, its argument object and the status line to show. */
                             
                            
                  
                                                     
                                         
                                                                    
                 
 

/** Read-side bridge from unknown to a plain record; arrays and scalars yield an empty one. */
function recOf(v         )                          {
  const out                          = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

function arrOf(v         )            {
  return Array.isArray(v) ? v : [];
}

/** String form of a field, matching the escaping helper's own `null`/`undefined` handling. */
function strOf(v         )         {
  return v == null ? "" : String(v);
}

/** HTML-escape the five characters that can break out of an attribute or a text node. */
function svcEsc(v         )         {
  return strOf(v).replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

/**
 * Narrow one shell record. Truthiness is kept as-is rather than compared to `true`: the shell
 * serializes booleans today, and a stricter read would silently flip a future `1` to "stopped".
 */
function svcEntryOf(raw         )           {
  const r = recOf(raw);
  return {
    id: strOf(r.id),
    name: strOf(r.name),
    desc: strOf(r.desc),
    port: strOf(r.port),
    running: !!r.running,
    available: !!r.available,
    enabled: !!r.enabled,
    reason: strOf(r.reason),
  };
}

/**
 * One row: state dot, name, port, description, "start on launch" checkbox and the start/stop button.
 *
 * @returns HTML for a single service row; unknown fields render as empty strings, never as
 *   `undefined`.
 */
function svcRowHtml(raw         )         {
  const s = svcEntryOf(raw);
  const dot = s.running ? "●" : "○";
  const color = s.running ? "#3fb950" : "rgba(127,127,127,.55)";
  const reason = (!s.available && s.reason)
    ? '<div style="font-size:11px;color:var(--danger,#e8607d);margin-top:2px;">' + svcEsc(s.reason) + "</div>"
    : "";
  return '<div class="rowline" data-svc="' + svcEsc(s.id) + '" style="align-items:center;gap:8px;padding:8px 0;border-top:1px solid rgba(127,127,127,.12);">'
    + '<div style="flex:1;min-width:0;">'
    + '<div style="font-size:12.5px;"><span style="color:' + color + '">' + dot + "</span> <b>" + svcEsc(s.name) + "</b>"
    + '<span style="opacity:.55;font-size:11px;"> · :' + svcEsc(s.port) + "</span></div>"
    + '<div style="font-size:11px;opacity:.6;">' + svcEsc(s.desc) + "</div>"
    + reason
    + "</div>"
    + '<div class="btns" style="flex:none;align-items:center;gap:8px;">'
    + '<label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;opacity:.75;" title="启用后随 App 启动">'
    + '<input type="checkbox" data-act="enable" data-id="' + svcEsc(s.id) + '"' + (s.enabled ? " checked" : "") + ">随 App 启动</label>"
    + (s.running
      ? '<button class="smallbtn" data-act="stop" data-id="' + svcEsc(s.id) + '">停止</button>'
      : '<button class="smallbtn" data-act="start" data-id="' + svcEsc(s.id) + '"' + (s.available ? "" : " disabled") + ">启动</button>")
    + "</div></div>";
}

/**
 * @returns the rows joined in the order the shell reported them, or `""` when the list is empty or
 *   not an array (the card then shows no rows rather than a broken one).
 */
function svcListHtml(raw         )         {
  const list = arrOf(raw);
  return list.length ? list.map(svcRowHtml).join("") : "";
}

/** The card skeleton; the list box, refresh button and status line are filled in by the wiring. */
function svcCardHtml()         {
  return "<h4>本地服务</h4>"
    + "<p>随 App 打包的本机服务：勾选「随 App 启动」的会在打开 App 时自动运行，退出 App 时统一关闭。</p>"
    + '<div id="svcListBox" style="margin-top:4px;"></div>'
    + '<div class="btns" style="margin-top:10px;"><button class="smallbtn" id="svcRefreshBtn">刷新状态</button></div>'
    + '<div id="svcStatusLine" style="font-size:11.5px;margin-top:8px;min-height:16px;"></div>';
}

/**
 * Map one row interaction to the shell command it should run.
 *
 * @param enabled Checkbox state for `enable`; ignored by the other actions, and coerced to a real
 *   boolean because the shell command takes a bool, not a DOM value.
 * @returns The plan, or `null` for an unknown action (the caller then does nothing but refresh).
 */
function svcActPlan(action         , id         , enabled         )                    {
  const sid = strOf(id);
  if (action === "start") return { command: "svc_start", args: { id: sid }, status: "正在启动…" };
  if (action === "stop") return { command: "svc_stop", args: { id: sid }, status: "正在停止…" };
  if (action === "enable") return { command: "svc_set_enabled", args: { id: sid, enabled: !!enabled }, status: "" };
  return null;
}

/** Read one property off an unknown value without an assertion; `message` on `Error` is not enumerable. */
function fieldOf(v         , k        )          {
  if (!v || typeof v !== "object" || !(k in v)) return undefined;
  return Reflect.get(v, k);
}

/**
 * Build a status line from a failure.
 *
 * @param prefix Caller-owned sentence such as the list-read prefix; kept here only so both call
 *   sites render identically.
 * @returns `prefix` plus the error message when the rejection carries one, else the value itself —
 *   a rejected string prints verbatim; `String()` keeps a `null`/`undefined` rejection visible as
 *   such instead of collapsing it to an empty tail.
 */
function svcErrorText(prefix        , err         )         {
  return prefix + String(fieldOf(err, "message") || err);
}

// Browser adapter, appended by l0/emit.mjs. Engine: services/local/service-manager.ts (row markup,
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

globalThis.SVC_POLL_MS = SVC_POLL_MS;
globalThis.svcEsc = svcEsc;
globalThis.svcEntryOf = svcEntryOf;
globalThis.svcRowHtml = svcRowHtml;
globalThis.svcListHtml = svcListHtml;
globalThis.svcCardHtml = svcCardHtml;
globalThis.svcActPlan = svcActPlan;
globalThis.svcErrorText = svcErrorText;
})();
