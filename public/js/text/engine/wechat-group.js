// public/js/text/engine/wechat-group.js — 群聊(打包层；文件名与内部标识保留 wechat 不动)
// 复用现有引擎,不重写:multi-agent.js(场景成员/多人开关) + fishbowl-engine.js(轮转) +
//   app.js(发言人头像气泡 / @点名 / [next:X] 自动接力) + wechat 回复风格(连发拆气泡)。
// 单一职责:① 一键建群入口(跨世界观勾选成员 + 起群名) ② 微信风群头部皮肤(sticky)。
// 4.55: UI 全程走 CSS 变量(var(--bg)/var(--border)/var(--input-bg)…),自动跟随四主题
//   以及「UI 配置」里自定义的 --bg 覆盖(修复:明亮界面下弹窗仍是黑底);头部改成更像微信的居中标题 + ⋯ 菜单。
// 依赖:window.__multi / window.__character / window.__fishbowl(可选) / window.__app / window.__dev(可选)
// 须在 app.js + fishbowl-engine.js 之后加载。
(function () {
"use strict";
const LS_NAME = "cfw_wechat_group_name_v1";
const WX_GREEN = "#07c160";
const WX_GREEN_SOFT = "rgba(7,193,96,.14)";

function getGroupName() { return (localStorage.getItem(LS_NAME) || "").trim(); }
function setGroupName(n) { try { localStorage.setItem(LS_NAME, typeof n === "string" ? n : ""); } catch (e) {} }
function safe(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
// 2026-11-06: 群聊面板去 emoji —— 成员头像改「有图用图，无图用名字首字」；标题改用线性 SVG。
function avaUrl(id) {
  if (!id) return "";
  try {
    if (window.__avatar && typeof window.__avatar.get === "function") { const u = window.__avatar.get(id); if (u) return u; }
    const raw = localStorage.getItem("cfw_char_avatar_v1");
    if (raw) { const m = JSON.parse(raw); if (m && m[id]) return m[id]; }
  } catch (e) {}
  return "";
}
function avaHtml(c, cls, withTitle) {
  const name = (c && c.name) || "";
  const url = avaUrl(c && c.id);
  const head = '<span class="' + cls + '"' + (withTitle ? ' title="' + safe(name) + '"' : '');
  if (url) return head + ' style="background-image:url(&quot;' + safe(url) + '&quot;);background-size:cover;background-position:center;"></span>';
  return head + '>' + safe(String(name).trim().slice(0, 1) || "?") + '</span>';
}
const SVG_CHAT = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-3px;margin-right:6px"><path d="M20 12.5a7.5 7.5 0 0 1-7.5 7.5H7l-3 2v-6.2A7.4 7.4 0 0 1 3.5 12 7.5 7.5 0 0 1 11 4.5h1.5a7.5 7.5 0 0 1 7.5 7.5z"/></svg>';
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
  if (!(M && M.isMulti && M.isMulti())) return false;
  return sceneCards().length >= 2;
}

function applyMembers(ids) {
  const M = window.__multi;
  if (!M) return;
  const want = new Set(ids);
  const cur = (M.getSceneIds && M.getSceneIds()) || [];
  cur.forEach(id => { if (!want.has(id) && M.removeFromScene) M.removeFromScene(id); });
  ids.forEach(id => { if (cur.indexOf(id) < 0 && M.addToScene) M.addToScene(id); });
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
      if (st && (st.state === "running" || st.state === "paused") && fb.stop) fb.stop();
      if (fb.getMode && fb.getMode() !== "orchestrate" && fb.setMode) fb.setMode("orchestrate");
    }
  } catch (e) {}
  try { if (window.__character && window.__character.setActiveId && ids[0]) window.__character.setActiveId(ids[0]); } catch (e) {}
  closeBuilder();
  renderHeader();
  try { const input = document.getElementById("msg"); if (input) input.focus(); } catch (e) {}
}

// ── 样式:一次性注入,全部走 CSS 变量(跟随主题 + UI 覆盖) ──
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
    ".wg-card-ava{width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;font-size:14px;border-radius:5px;overflow:hidden;flex:0 0 auto;}",
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

// ── 建群 / 管理 弹窗 ──
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
  if (el) el.textContent = _sel.size + " 人已选";
  const go = document.getElementById("wgCreate");
  if (go) go.disabled = _sel.size < 2;
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
  const cards = allCards();
  const itemsHtml = cards.map(c => {
    const on = _sel.has(c.id);
    return '<button type="button" class="wg-card' + (on ? " on" : "") + '" data-id="' + safe(c.id) + '">'
      + avaHtml(c, "wg-card-ava", false)
      + '<span class="wg-card-name">' + safe(c.name || "未命名") + '</span>'
      + '<span class="wg-card-mark">' + (on ? "✓" : "+") + '</span>'
      + '</button>';
  }).join("");
  panel.innerHTML =
    '<div class="wg-bd-head">' + SVG_CHAT + '群聊</div>'
    + '<div class="wg-bd-body">'
    +   '<div class="wg-desc">把不同世界观的角色拉进同一个群,他们能看到彼此发言、相互 @、自动接话,产生戏剧效果。勾选 ≥2 个成员即可建群。</div>'
    +   '<div class="wg-flabel">群名称</div>'
    +   '<input id="wgName" type="text" maxlength="24" placeholder="例如:跨次元茶话会" value="' + safe(getGroupName()) + '" class="wg-name">'
    +   '<div class="wg-selrow"><span class="wg-flabel" style="margin:0;">选择成员(可跨世界观)</span><span id="wgCount" class="wg-count"></span></div>'
    +   '<div id="wgGrid" class="wg-grid">' + itemsHtml + '</div>'
    +   '<div class="wg-foot">'
    +     '<button id="wgCancel" type="button" class="wg-btn">取消</button>'
    +     '<button id="wgCreate" type="button" class="wg-btn wg-btn-go">建群并进入</button>'
    +   '</div>'
    + '</div>';
  updateCount();
  panel.querySelectorAll(".wg-card").forEach(el => {
    el.addEventListener("click", () => {
      const id = el.dataset.id;
      const on = !_sel.has(id);
      if (on) _sel.add(id); else _sel.delete(id);
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
    if (ids.length < 2) { alert("至少选择 2 个成员才能建群。"); return; }
    const nm = (panel.querySelector("#wgName") || {}).value || "";
    enterGroup(ids, nm.trim());
  });
}

// ── 微信群头部皮肤(sticky 在聊天区顶端) ──
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
  const avatars = cards.slice(0, 5).map(c => avaHtml(c, "wg-h-av", true)).join("")
    + (cards.length > 5 ? '<span class="wg-h-extra">+' + (cards.length - 5) + '</span>' : '');
  header.innerHTML =
    '<div class="wg-h-avs">' + avatars + '</div>'
    + '<div class="wg-h-title">' + safe(name) + '<small>(' + cards.length + ')</small></div>'
    + '<div class="wg-h-menu" id="wgMenu">'
    +   '<button class="wg-h-btn" id="wgMenuBtn" title="更多" aria-label="更多">⋯</button>'
    +   '<div class="wg-h-pop">'
    +     '<button class="wg-h-item" id="wgManageBtn">管理成员 / 改群名</button>'
    +     '<button class="wg-h-item" id="wgLeaveBtn">退出群聊</button>'
    +   '</div>'
    + '</div>';
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
  // 点空白处关闭头部 ⋯ 菜单(全局只绑一次)
  document.addEventListener("click", () => { const m = document.getElementById("wgMenu"); if (m) m.classList.remove("open"); });
}

window.__wechatGroup = { open: openBuilder, enter: enterGroup, getGroupName, isActive: groupActive };

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
else wire();
})();