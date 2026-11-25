// Browser adapter, appended by l0/emit.mjs. Engine: services/ui/wechat-group.ts
// (membership diff, name rules, active predicate and every HTML fragment); this file owns
// the stylesheet, DOM creation, event binding and the frozen global facade.
//
// Invariants: all user-supplied names go through the injected esc port; the builder needs
// at least two members; a running fishbowl is stopped before the group takes over.
(function () {
"use strict";
const LS_NAME = WG_LS_NAME;

function getGroupName() { return wgGroupName(localStorage.getItem(LS_NAME)); }
function setGroupName(n) { try { localStorage.setItem(LS_NAME, wgNameForWrite(n)); } catch (e) {} }
var safe = window.__ownEscape.esc;
function allCards() {
  try { return (window.__character && window.__character.listAllCards) ? (window.__character.listAllCards() || []) : []; }
  catch (e) { return []; }
}
function sceneCards() {
  try { return (window.__multi && window.__multi.getSceneCards) ? (window.__multi.getSceneCards() || []) : []; }
  catch (e) { return []; }
}
function groupActive() {
  const M = window.__multi;
  return wgIsGroupActive(!!(M && M.isMulti && M.isMulti()), sceneCards().length);
}
function applyMembers(ids) {
  const M = window.__multi;
  if (!M) return;
  const cur = (M.getSceneIds && M.getSceneIds()) || [];
  const plan = wgDiffMembers(ids, cur);
  plan.remove.forEach(id => { if (M.removeFromScene) M.removeFromScene(id); });
  plan.add.forEach(id => { if (M.addToScene) M.addToScene(id); });
}
function enterGroup(ids, name) {
  const M = window.__multi;
  if (!M) { alert("多人模块未就绪(multi-agent.js)"); return; }
  setGroupName(name || "");
  if (M.setMulti) M.setMulti(true);
  applyMembers(ids);
  try {
    if (window.__dev && window.__dev.setReplyStyle) window.__dev.setReplyStyle("wechat");
    else localStorage.setItem("cfw_reply_style_v1", "wechat");
  } catch (e) {}
  try { const sel = document.getElementById("replyStyleSel"); if (sel) sel.value = "wechat"; } catch (e) {}
  try {
    const fb = window.__fishbowl;
    if (fb) {
      const st = fb.getState ? fb.getState() : null;
      if (st && wgShouldStopFishbowl(st.state) && fb.stop) fb.stop();
      if (fb.getMode && fb.getMode() !== "orchestrate" && fb.setMode) fb.setMode("orchestrate");
    }
  } catch (e) {}
  try { if (window.__character && window.__character.setActiveId && ids[0]) window.__character.setActiveId(ids[0]); } catch (e) {}
  closeBuilder();
  renderHeader();
  try { const input = document.getElementById("msg"); if (input) input.focus(); } catch (e) {}
}

function ensureStyles() {
  if (document.getElementById("wgStyles")) return;
  const s = document.createElement("style");
  s.id = "wgStyles";
  s.textContent = [
    "#wgMask{position:fixed;inset:0;z-index:30;display:none;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.45);}",
    "#wgMask.open{display:flex;}",
    "#wgPanel{width:min(560px,94vw);max-height:86vh;overflow-y:auto;border-radius:16px;background:var(--bg);color:inherit;border:1px solid var(--border);box-shadow:0 30px 80px rgba(0,0,0,.45);font-family:inherit;}",
    "#wgPanel .wg-bd-head{display:flex;align-items:center;gap:8px;padding:15px 18px;border-bottom:1px solid var(--border);font-size:16px;font-weight:600;}",
    "#wgPanel .wg-bd-body{padding:16px 18px;}",
    ".wg-desc{font-size:12px;color:var(--muted);line-height:1.6;margin-bottom:14px;}",
    ".wg-flabel{font-size:12px;color:var(--muted);margin-bottom:6px;}",
    ".wg-name{width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--input-border);background:var(--input-bg);color:inherit;outline:none;font-size:14px;margin-bottom:16px;box-sizing:border-box;}",
    ".wg-name:focus{border-color:" + WX_GREEN + ";}",
    ".wg-selrow{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;}",
    ".wg-count{font-size:12px;color:" + WX_GREEN + ";font-weight:600;}",
    ".wg-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin-bottom:16px;}",
    ".wg-card{display:flex;align-items:center;gap:8px;padding:9px 11px;border-radius:12px;cursor:pointer;text-align:left;border:1px solid var(--border);background:var(--bubble-ai);color:inherit;transition:border-color .15s,background .15s;}",
    ".wg-card.on{border-color:" + WX_GREEN + ";background:" + WX_GREEN_SOFT + ";}",
    ".wg-card-ava{font-size:20px;flex:0 0 auto;}",
    ".wg-card-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;}",
    ".wg-card-mark{flex:0 0 auto;width:20px;height:20px;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;font-size:13px;color:var(--muted);border:1px solid var(--border);}",
    ".wg-card.on .wg-card-mark{color:#fff;background:" + WX_GREEN + ";border-color:" + WX_GREEN + ";}",
    ".wg-foot{display:flex;gap:10px;justify-content:flex-end;}",
    ".wg-btn{padding:9px 18px;border-radius:10px;cursor:pointer;font-size:14px;border:1px solid var(--border);background:transparent;color:inherit;}",
    ".wg-btn-go{border:none;background:" + WX_GREEN + ";color:#fff;font-weight:600;}",
    ".wg-btn-go:disabled{opacity:.45;cursor:not-allowed;}",
    "#wechatGroupHeader{position:sticky;top:0;z-index:3;display:flex;align-items:center;gap:10px;margin:0 0 10px;padding:9px 12px;border-radius:0 0 12px 12px;background:var(--bg);border-bottom:1px solid var(--border);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);}",
    "#wechatGroupHeader .wg-h-avs{display:flex;align-items:center;flex:0 0 auto;}",
    "#wechatGroupHeader .wg-h-av{width:24px;height:24px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;font-size:13px;background:var(--bubble-ai);border:1px solid var(--border);margin-left:-5px;}",
    "#wechatGroupHeader .wg-h-av:first-child{margin-left:0;}",
    "#wechatGroupHeader .wg-h-extra{font-size:11px;color:var(--muted);margin-left:4px;}",
    "#wechatGroupHeader .wg-h-title{flex:1;min-width:0;text-align:center;font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
    "#wechatGroupHeader .wg-h-title small{font-weight:400;color:var(--muted);font-size:12px;margin-left:3px;}",
    "#wechatGroupHeader .wg-h-menu{position:relative;flex:0 0 auto;}",
    "#wechatGroupHeader .wg-h-btn{width:30px;height:30px;border-radius:8px;border:1px solid var(--border);background:transparent;color:inherit;cursor:pointer;font-size:16px;line-height:1;}",
    "#wechatGroupHeader .wg-h-btn:hover{background:var(--bubble-ai);}",
    "#wechatGroupHeader .wg-h-pop{position:absolute;right:0;top:36px;min-width:140px;padding:4px;background:var(--bg);border:1px solid var(--border);border-radius:10px;box-shadow:0 12px 28px rgba(0,0,0,.35);display:none;flex-direction:column;gap:2px;z-index:6;}",
    "#wechatGroupHeader .wg-h-menu.open .wg-h-pop{display:flex;}",
    "#wechatGroupHeader .wg-h-item{padding:8px 10px;border-radius:7px;border:none;background:transparent;color:inherit;text-align:left;font-size:13px;cursor:pointer;}",
    "#wechatGroupHeader .wg-h-item:hover{background:var(--bubble-ai);}"
  ].join("");
  document.head.appendChild(s);
}

let _mask = null;
let _sel = new Set();
function ensureBuilder() {
  if (_mask) return _mask;
  ensureStyles();
  const mask = document.createElement("div");
  mask.id = "wgMask";
  mask.addEventListener("click", e => { if (e.target === mask) closeBuilder(); });
  const panel = document.createElement("div");
  panel.id = "wgPanel";
  mask.appendChild(panel);
  document.body.appendChild(mask);
  _mask = mask;
  return mask;
}
function closeBuilder() { if (_mask) _mask.classList.remove("open"); }
function updateCount() {
  const el = document.getElementById("wgCount");
  if (el) el.textContent = wgCountText(_sel.size);
  const go = document.getElementById("wgCreate");
  if (go) go.disabled = !wgCanCreate(_sel.size);
}
function openBuilder() {
  if (!allCards().length) { alert("还没有角色卡。先到 🎭 角色卡 里创建/导入几张,再来建群。"); return; }
  ensureBuilder();
  _sel = new Set((window.__multi && window.__multi.getSceneIds && window.__multi.getSceneIds()) || []);
  renderBuilder();
  _mask.classList.add("open");
}
function renderBuilder() {
  const panel = document.getElementById("wgPanel");
  panel.innerHTML = wgBuilderHtml(allCards(), Array.from(_sel), getGroupName(), safe);
  updateCount();
  panel.querySelectorAll(".wg-card").forEach(el => {
    el.addEventListener("click", () => {
      const id = el.dataset.id;
      const on = !_sel.has(id);
      _sel = new Set(wgToggle(Array.from(_sel), id));
      el.classList.toggle("on", on);
      const mk = el.querySelector(".wg-card-mark");
      if (mk) mk.textContent = on ? "✓" : "+";
      updateCount();
    });
  });
  const cancel = panel.querySelector("#wgCancel");
  if (cancel) cancel.addEventListener("click", closeBuilder);
  const create = panel.querySelector("#wgCreate");
  if (create) create.addEventListener("click", () => {
    const ids = Array.from(_sel);
    if (!wgCanCreate(ids.length)) { alert("至少选择 2 个成员才能建群。"); return; }
    const nm = (panel.querySelector("#wgName") || {}).value || "";
    enterGroup(ids, nm.trim());
  });
}
function renderHeader() {
  const chatEl = document.getElementById("chat");
  if (!chatEl) return;
  let header = document.getElementById("wechatGroupHeader");
  if (!groupActive()) {
    if (header && header.parentNode) header.parentNode.removeChild(header);
    return;
  }
  ensureStyles();
  if (!header) {
    header = document.createElement("div");
    header.id = "wechatGroupHeader";
    chatEl.insertBefore(header, chatEl.firstChild);
  } else if (header !== chatEl.firstChild) {
    chatEl.insertBefore(header, chatEl.firstChild);
  }
  const cards = sceneCards();
  const name = getGroupName() || "群聊";
  header.innerHTML = wgHeaderHtml(cards, name, safe);
  const menu = header.querySelector("#wgMenu");
  const menuBtn = header.querySelector("#wgMenuBtn");
  if (menuBtn) menuBtn.addEventListener("click", e => { e.stopPropagation(); if (menu) menu.classList.toggle("open"); });
  const mb = header.querySelector("#wgManageBtn");
  if (mb) mb.addEventListener("click", openBuilder);
  const lb = header.querySelector("#wgLeaveBtn");
  if (lb) lb.addEventListener("click", () => {
    if (window.__multi && window.__multi.setMulti) window.__multi.setMulti(false);
    renderHeader();
  });
}

function wire() {
  const btn = document.getElementById("wechatGroupBtn");
  if (btn) btn.addEventListener("click", openBuilder);
  renderHeader();
  window.addEventListener("multi-agent:changed", renderHeader);
  window.addEventListener("character:changed", renderHeader);
  document.addEventListener("click", () => { const m = document.getElementById("wgMenu"); if (m) m.classList.remove("open"); });
}

window.__wechatGroup = { open: openBuilder, enter: enterGroup, getGroupName, isActive: groupActive };

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
else wire();
})();