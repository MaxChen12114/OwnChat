// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/image/avatar.ts; this file owns the
// frozen global name, the storage key, the avatar change event, the chat-image edit call and the
// whole settings card (that UI has no other consumer, so it ships with the adapter).
//
// The edit call is what files the result into the local gallery — this file must not post the image
// anywhere else, or one generation lands twice.
(function () {
  if (window.__avatar) return;

  var LS_AV = "cfw_char_avatar_v1";

  function headSlot() {
    return window.slotRegistry.pick("settingsImageSlot");
  }

  function setStatus(m) {
    var el = document.getElementById("imgAvStatus");
    if (el) el.textContent = m || "";
  }

  function renderPreview() {
    var box = document.getElementById("imgAvPreview");
    if (!box) return;
    var url = avatar.get(avatar.activeId());
    box.innerHTML = "";
    if (!url) {
      box.textContent = "（当前角色还没有头像）";
      return;
    }
    var img = document.createElement("img");
    img.src = url;
    img.className = "av-img";
    img.addEventListener("click", function () { window.open(url, "_blank"); });
    box.appendChild(img);
  }

  var avatar = createAvatar({
    storage: {
      getItem: function () {
        try { return window.localStorage.getItem(LS_AV); } catch (e) { return null; }
      },
      setItem: function (k, v) {
        try { window.localStorage.setItem(k, v); } catch (e) {}
      }
    },
    hasEdit: function () {
      return !!(window.chatImageSvc && typeof window.chatImageSvc.editImage === "function");
    },
    edit: function (arg) { return window.chatImageSvc.editImage(arg); },
    activeCard: function () {
      try { return (window.characterSvc && window.characterSvc.getActiveCard) ? window.characterSvc.getActiveCard() : null; } catch (e) { return null; }
    },
    notify: function (id, url) {
      try { window.dispatchEvent(new window.CustomEvent("avatar:changed", { detail: { id: id, url: url } })); } catch (e) {}
    },
    status: setStatus,
    preview: renderPreview
  });

  window.__avatar = {
    generate: avatar.generate, get: avatar.get, getAll: avatar.getAll,
    set: avatar.set, clear: avatar.clear, list: avatar.list
  };

  function ensureStyles() {
    if (document.getElementById("avStyles")) return;
    var s = document.createElement("style");
    s.id = "avStyles";
    s.textContent = [
      "#imgAvPreview{margin-top:8px;min-height:20px;font-size:12px;opacity:.7;}",
      "#imgAvPreview .av-img{width:104px;height:104px;object-fit:cover;border-radius:12px;cursor:zoom-in;display:block;}",
      ".av-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:8px 0;}",
      ".av-row select,.av-row button{font-size:12px;padding:4px 10px;border-radius:8px;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;cursor:pointer;}"
    ].join("");
    document.head.appendChild(s);
  }

  function injectCard() {
    var settings = document.getElementById("settings");
    if (!settings || document.getElementById("imgAvatarCard")) return;
    // Mounted into the image slot explicitly. Falling back to the settings root was only for older
    // pages whose markup lacked that slot: the card still showed, just at the bottom of the panel.
    var slot = headSlot();
    ensureStyles();
    var card = document.createElement("div");
    card.className = "card";
    card.id = "imgAvatarCard";
    var opts = avatar.list.map(function (e) { return '<option value="' + e.key + '">' + e.key + "</option>"; }).join("");
    card.innerHTML = [
      '<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><circle cx="12" cy="10" r="2.8"/><path d="M6.5 19.5a5.5 5.5 0 0 1 11 0"/></svg>角色头像</h4>',
      '<p>以发图基准图为底，裁一张近景头像（可选表情），保存为当前角色头像。当前角色：<b id="imgAvWho"></b>。</p>',
      '<div class="av-row"><label style="font-size:12px;opacity:.8;">表情</label><select id="imgAvExpr">' + opts + '</select><button id="imgAvGen" style="font-weight:600;">生成头像</button><button id="imgAvBase">设为基准图</button><button id="imgAvDl">下载</button><button id="imgAvClear">清除</button></div>',
      '<div id="imgAvStatus" style="font-size:12px;opacity:.75;min-height:16px;"></div>',
      '<div id="imgAvPreview"></div>'
    ].join("");
    slot.appendChild(card);
    var who = document.getElementById("imgAvWho");
    if (who) who.textContent = avatar.activeName();
    renderPreview();
    document.getElementById("imgAvGen").addEventListener("click", function () {
      var sel = document.getElementById("imgAvExpr");
      avatar.generate({ expression: sel ? sel.value : undefined });
    });
    document.getElementById("imgAvBase").addEventListener("click", function () {
      var url = avatar.get(avatar.activeId());
      if (!url) { setStatus("还没有头像"); return; }
      if (window.chatImageSvc && window.chatImageSvc.setBaseImage) {
        window.chatImageSvc.setBaseImage({ characterId: avatar.activeId(), imageUrl: url });
        setStatus("已把头像设为该角色发图基准图");
      }
    });
    document.getElementById("imgAvDl").addEventListener("click", function () {
      var url = avatar.get(avatar.activeId());
      if (!url) { setStatus("还没有头像"); return; }
      var a = document.createElement("a");
      a.href = url;
      a.download = "avatar.png";
      a.target = "_blank";
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
    document.getElementById("imgAvClear").addEventListener("click", function () {
      avatar.clear(avatar.activeId());
      renderPreview();
      setStatus("已清除当前角色头像");
    });
    window.addEventListener("character:changed", function () {
      var w = document.getElementById("imgAvWho");
      if (w) w.textContent = avatar.activeName();
      renderPreview();
    });
  }

  function init() { injectCard(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
