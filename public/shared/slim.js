// public/shared/slim.js — 精简模式（批 I）：一键隐藏"角色扮演/出图向"入口
// ─────────────────────────────────────────────────────────────────────
// 干什么：界面精简开关。开 → <html> 挂 .slim 类，CSS（styles-2.css 末段）隐藏：
//   设置「发图」分类、左栏「图像(生/改)」、模型 API 图像 Key 卡、角色卡「发图基准图」段、
//   工作台三件（创作工坊/写作台/音频工作台）；tools.js 同步不上架 send_image。
// 只管入口不删功能：/tools/ 页面直链照常可达；关掉开关全部即时恢复。
// 开关：LS `cfw_slim_mode_v1`（'1'/'0'）；未设时用 SLIM_DEFAULT_ON（主线默认关）。
// 加载：index.html <head> 内（尽早挂类防"闪一下酒馆入口"）；只碰 documentElement，无 DOM 依赖。
// ─────────────────────────────────────────────────────────────────────
(function () {
  "use strict";
  if (window.__slim) return;
  var LS_KEY = "cfw_slim_mode_v1";
  var SLIM_DEFAULT_ON = false; // 主线默认关；geo 版可在其分支置 true

  function read() {
    try {
      var v = localStorage.getItem(LS_KEY);
      if (v === "1") return true;
      if (v === "0") return false;
    } catch (e) {}
    return SLIM_DEFAULT_ON;
  }
  function apply(on) {
    try { document.documentElement.classList.toggle("slim", !!on); } catch (e) {}
  }

  apply(read());

  window.__slim = {
    __v: 1,
    on: read,
    set: function (on) {
      try { localStorage.setItem(LS_KEY, on ? "1" : "0"); } catch (e) {}
      apply(on);
      try { window.dispatchEvent(new CustomEvent("slim:changed", { detail: { on: !!on } })); } catch (e) {}
    },
    toggle: function () { var nx = !read(); window.__slim.set(nx); return nx; },
  };
})();
