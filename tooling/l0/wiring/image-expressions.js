// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/image/expressions.ts; this file owns
// the chat-image edit call, the thumbnail strip and the settings card (that UI has no other
// consumer, so it ships with the adapter). The frozen global is retired; the engine is a factory.
(function () {
  function setStatus(msg) {
    var el = document.getElementById("imgExprStatus");
    if (el) el.textContent = msg || "";
  }

  function addResult(key, imageUrl) {
    var wrap = document.getElementById("imgExprResults");
    if (!wrap) return;
    var fig = document.createElement("div");
    fig.className = "expr-thumb";
    var img = document.createElement("img");
    img.src = imageUrl;
    img.alt = key;
    img.title = key;
    img.addEventListener("click", function () { window.open(imageUrl, "_blank"); });
    var cap = document.createElement("div");
    cap.className = "expr-cap";
    cap.textContent = key;
    fig.appendChild(img);
    fig.appendChild(cap);
    wrap.insertBefore(fig, wrap.firstChild);
  }

  var expressions = createExpressions({
    hasEdit: function () {
      return !!(window.chatImageSvc && typeof window.chatImageSvc.editImage === "function");
    },
    edit: function (arg) { return window.chatImageSvc.editImage(arg); },
    activeCard: function () {
      try { return (window.characterSvc && window.characterSvc.getActiveCard) ? window.characterSvc.getActiveCard() : null; } catch (e) { return null; }
    },
    status: setStatus,
    onResult: addResult
  });

  function activeCharName() {
    try {
      var c = window.characterSvc && window.characterSvc.getActiveCard ? window.characterSvc.getActiveCard() : null;
      return (c && c.name) || "当前角色";
    } catch (e) { return "当前角色"; }
  }

  function ensureStyles() {
    if (document.getElementById("exprStyles")) return;
    var s = document.createElement("style");
    s.id = "exprStyles";
    s.textContent = [
      ".expr-btns{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0;}",
      ".expr-btns button{font-size:12px;padding:4px 10px;border-radius:8px;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;cursor:pointer;}",
      ".expr-btns button:hover{background:rgba(127,127,127,.15);}",
      ".expr-results{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;}",
      ".expr-thumb{width:96px;}",
      ".expr-thumb img{width:96px;height:120px;object-fit:cover;border-radius:8px;display:block;cursor:zoom-in;}",
      ".expr-cap{font-size:11px;opacity:.7;text-align:center;margin-top:2px;}"
    ].join("");
    document.head.appendChild(s);
  }

  function injectCard() {
    // 2026-11-28 card-shell batch 2: shell + declareCard (the old guard checked #settings and its
    // own id by hand; declareCard owns the mount-once probe and the root fallback). The wiring
    // below is unchanged — it reads its controls by document id.
    window.slotRegistry.declareCard({
      id: "imgExprCard",
      slotId: "settingsImageSlot",
      build: function (slot) {
        ensureStyles();
        var btns = expressions.list.map(function (e) { return '<button data-expr="' + e.key + '">' + e.key + "</button>"; }).join("");
        var shell = window.cardShell.createCardShell({
          id: "imgExprCard",
          title: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8.5 15c.8-1.2 2-2 3.5-2s2.7.8 3.5 2"/><circle cx="9" cy="9.5" r=".9"/><circle cx="15" cy="9.5" r=".9"/></svg>表情差分包',
          desc: '基于当前角色的发图基准图，只改表情、其余（姿势/穿着/背景）不变。当前角色：<b id="imgExprWho"></b>。生成的图自动存入本地画廊。',
          extra: '<div class="expr-btns">' + btns + '<button data-expr="__all__" style="font-weight:600;">生成全套</button></div>'
            + '<div id="imgExprStatus" style="font-size:12px;opacity:.75;min-height:16px;"></div>'
            + '<div class="expr-results" id="imgExprResults"></div>'
        });
        var card = shell.card;
        slot.appendChild(card);
        var who = document.getElementById("imgExprWho");
        if (who) who.textContent = activeCharName();
        card.querySelectorAll(".expr-btns button").forEach(function (b) {
          b.addEventListener("click", function () {
            var k = b.getAttribute("data-expr");
            if (k === "__all__") expressions.generateAll();
            else expressions.generate(k);
          });
        });
        window.addEventListener("character:changed", function () {
          var w = document.getElementById("imgExprWho");
          if (w) w.textContent = activeCharName();
        });
        return card;
      }
    });
  }

  function init() { injectCard(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
