// public/shared/topbar-cost.js — 顶栏计费按钮的账单卡（2026-11-09）
// ─────────────────────────────────────────────────────────────────────
// 背景：原来的计费是 inline 长文本「今日: ¥x | 总计: ¥y」，把顶栏右侧的按钮组挤得很远，
// 中间留一大段空。改成紧凑按钮（¥x），明细点开看。
//
// 数据来源：app.js 的 updateCostDisplay() 把今日/总计写进 #costDisplay 的 dataset。
// 本文件只负责交互与渲染，不碰计费逻辑。
// ─────────────────────────────────────────────────────────────────────
(function () {
  "use strict";
  if (window.__topbarCost) return;

  function ready() {
    var btn = document.getElementById("costDisplay");
    var pop = document.getElementById("billPop");
    if (!btn || !pop) return;

    // #topbar 有 backdrop-filter:blur() —— 它会创建包含块，让 position:fixed 的子元素
    // 相对 topbar（而非视口）定位。弹层必须挂在 body 下，left/top 才是视口坐标。
    if (pop.parentElement !== document.body) document.body.appendChild(pop);

    function fmt(v) {
      var n = Number(v);
      if (!isFinite(n)) return "0.0000";
      return n.toFixed(4);
    }

    function render() {
      var t = btn.dataset.today;
      var total = btn.dataset.total;
      if (t == null && total == null) {
        pop.innerHTML = '<div class="bill-empty">当前不计费</div>' +
          '<div class="bill-note">免费模式不产生费用；切到「快速」模式后按 token 计费。</div>';
        return;
      }
      pop.innerHTML =
        '<div class="bill-big">¥' + fmt(t) + "</div>" +
        '<div class="bill-sub">今日 · 累计 ¥' + fmt(total) + "</div>" +
        '<div class="bill-note">仅快速模式计费。明细随对话实时更新。</div>';
    }

    function place() {
      // 先归零再量：刚 unhide 时如果残留上一次的 left，offsetWidth 会受其影响
      pop.style.left = "0px";
      pop.style.top = "0px";
      var r = btn.getBoundingClientRect();
      var w = pop.getBoundingClientRect().width || 220;
      var left = r.left;
      if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
      if (left < 8) left = 8;
      pop.style.left = Math.round(left) + "px";
      pop.style.top = Math.round(r.bottom + 8) + "px";
    }

    function open() {
      render();
      pop.hidden = false;
      place();
    }

    function close() { pop.hidden = true; }

    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (pop.hidden) open(); else close();
    });
    btn.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (pop.hidden) open(); else close();
      }
    });
    document.addEventListener("click", function (e) {
      if (pop.hidden) return;
      if (pop.contains(e.target)) return;
      close();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !pop.hidden) close();
    });
    window.addEventListener("resize", function () { if (!pop.hidden) place(); });
    // 开着时跟随数据刷新（app.js 会周期性更新 dataset）
    setInterval(function () { if (!pop.hidden) render(); }, 2000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready);
  else ready();

  window.__topbarCost = { __v: 1 };
})();
