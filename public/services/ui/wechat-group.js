(function () {
/**
 * Group-chat panel rules: membership diff, group-name handling, the active-group predicate and
 * every HTML fragment. The wiring owns DOM creation, stylesheet injection, events and the frozen
 * global facade.
 *
 * All markup is escaped through an injected port: card names and group names come from user data
 * and are inserted into attribute and text positions, so the caller MUST supply the shared esc.
 * @module services/ui/wechat-group
 */

const WG_LS_NAME = "cfw_wechat_group_name_v1";
const WX_GREEN = "#07c160";
const WX_GREEN_SOFT = "rgba(7,193,96,.14)";
/** Linear chat-bubble icon; member avatars keep their emoji. */
const WG_SVG_CHAT = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-3px;margin-right:6px"><path d="M20 12.5a7.5 7.5 0 0 1-7.5 7.5H7l-3 2v-6.2A7.4 7.4 0 0 1 3.5 12 7.5 7.5 0 0 1 11 4.5h1.5a7.5 7.5 0 0 1 7.5 7.5z"/></svg>';

                         
             
                
                
 

/** @returns the stored group name, trimmed; a missing or non-string value is empty. */
function wgGroupName(raw         )         {
  return String(raw ?? "").trim();
}

/** @returns the value to persist; non-string input clears the name. */
function wgNameForWrite(n         )         {
  return typeof n === "string" ? n : "";
}

/** A group exists only in multi-agent mode with at least two stage members. */
function wgIsGroupActive(isMulti         , sceneCount        )          {
  return isMulti && sceneCount >= 2;
}

/**
 * @returns members to remove (current order) and to add (requested order). Duplicates in the
 * requested list are intentionally not de-duplicated here: the caller owns the Set.
 */
function wgDiffMembers(ids          , cur          )                                      {
  const want = new Set(ids);
  const remove           = [];
  const add           = [];
  for (const id of cur) if (!want.has(id)) remove.push(id);
  for (const id of ids) if (cur.indexOf(id) < 0) add.push(id);
  return { remove, add };
}

/** @returns the selection after toggling one id, without mutating the input. */
function wgToggle(sel          , id        )           {
  const out = sel.filter((x) => x !== id);
  if (sel.indexOf(id) < 0) out.push(id);
  return out;
}

/** @returns the selected-count label shown in the builder. */
function wgCountText(n        )         {
  return n + " 人已选";
}

/** A group needs at least two members. */
function wgCanCreate(n        )          {
  return n >= 2;
}

/** @returns one card button; esc is injected so no import is needed in the classic artifact. */
function wgCardHtml(c        , on         , esc                       )         {
  return '<button type="button" class="wg-card' + (on ? " on" : "") + '" data-id="' + esc(c.id) + '">'
    + '<span class="wg-card-ava">' + esc(c.icon || "🙂") + '</span>'
    + '<span class="wg-card-name">' + esc(c.name || "未命名") + '</span>'
    + '<span class="wg-card-mark">' + (on ? "✓" : "+") + '</span>'
    + '</button>';
}

/** @returns the builder panel markup. The caller binds the card/cancel/create handlers. */
function wgBuilderHtml(cards          , sel          , name        , esc                       )         {
  const itemsHtml = cards.map((c) => wgCardHtml(c, sel.indexOf(c.id) >= 0, esc)).join("");
  return '<div class="wg-bd-head">' + WG_SVG_CHAT + '群聊</div>'
    + '<div class="wg-bd-body">'
    + '<div class="wg-desc">把不同世界观的角色拉进同一个群,他们能看到彼此发言、相互 @、自动接话,产生戏剧效果。勾选 ≥2 个成员即可建群。</div>'
    + '<div class="wg-flabel">群名称</div>'
    + '<input id="wgName" type="text" maxlength="24" placeholder="例如:跨次元茶话会" value="' + esc(name) + '" class="wg-name">'
    + '<div class="wg-selrow"><span class="wg-flabel" style="margin:0;">选择成员(可跨世界观)</span><span id="wgCount" class="wg-count"></span></div>'
    + '<div id="wgGrid" class="wg-grid">' + itemsHtml + '</div>'
    + '<div class="wg-foot">'
    + '<button id="wgCancel" type="button" class="wg-btn">取消</button>'
    + '<button id="wgCreate" type="button" class="wg-btn wg-btn-go">建群并进入</button>'
    + '</div>'
    + '</div>';
}

/** @returns the first five avatars plus the "+N" overflow marker. */
function wgAvatarsHtml(cards          , esc                       )         {
  return cards.slice(0, 5)
    .map((c) => '<span class="wg-h-av" title="' + esc(c.name || "") + '">' + esc(c.icon || "🙂") + '</span>')
    .join("")
    + (cards.length > 5 ? '<span class="wg-h-extra">+' + (cards.length - 5) + '</span>' : '');
}

/** @returns the sticky header markup; an empty group name falls back to the default label. */
function wgHeaderHtml(cards          , name        , esc                       )         {
  return '<div class="wg-h-avs">' + wgAvatarsHtml(cards, esc) + '</div>'
    + '<div class="wg-h-title">' + esc(name || "群聊") + '<small>(' + cards.length + ')</small></div>'
    + '<div class="wg-h-menu" id="wgMenu">'
    + '<button class="wg-h-btn" id="wgMenuBtn" title="更多" aria-label="更多">⋯</button>'
    + '<div class="wg-h-pop">'
    + '<button class="wg-h-item" id="wgManageBtn">管理成员 / 改群名</button>'
    + '<button class="wg-h-item" id="wgLeaveBtn">退出群聊</button>'
    + '</div>'
    + '</div>';
}

/** A running or paused fishbowl must be stopped before the group chat takes over. */
function wgShouldStopFishbowl(state         )          {
  return state === "running" || state === "paused";
}

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

globalThis.WG_LS_NAME = WG_LS_NAME;
globalThis.WX_GREEN = WX_GREEN;
globalThis.WX_GREEN_SOFT = WX_GREEN_SOFT;
globalThis.WG_SVG_CHAT = WG_SVG_CHAT;
globalThis.wgGroupName = wgGroupName;
globalThis.wgNameForWrite = wgNameForWrite;
globalThis.wgIsGroupActive = wgIsGroupActive;
globalThis.wgDiffMembers = wgDiffMembers;
globalThis.wgToggle = wgToggle;
globalThis.wgCountText = wgCountText;
globalThis.wgCanCreate = wgCanCreate;
globalThis.wgCardHtml = wgCardHtml;
globalThis.wgBuilderHtml = wgBuilderHtml;
globalThis.wgAvatarsHtml = wgAvatarsHtml;
globalThis.wgHeaderHtml = wgHeaderHtml;
globalThis.wgShouldStopFishbowl = wgShouldStopFishbowl;
})();
