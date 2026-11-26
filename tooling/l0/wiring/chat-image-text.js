// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/image/chat-text.ts; this file owns the
// settings storage, the photo bubble, the settings card and the call into the image module.
//
// The red line from the original stands: this never touches the image side's own files, and it
// never edits the core persona prompt — the capability text is appended as a separate segment.
(function () {
  "use strict";

  function lsGet(k, d) { try { var v = window.localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} }
  function lsGetNum(k, d) { return parseInt(lsGet(k, d), 10); }

  function isEnabled() { return lsGet(LS_ENABLED, "1") === "1"; }
  function cooldownSec() { return parseCooldown(lsGet(LS_COOLDOWN, String(DEFAULT_COOLDOWN))); }
  function capPerChat() { return parseCap(lsGet(LS_CAP, String(DEFAULT_CAP))); }
  function nsfwLevel() { return nsfwLevelOf(lsGet(NSFW_KEY, "0")); }

  function slotKey() {
    try {
      var c = window.characterSvc && window.characterSvc.getActiveCard && window.characterSvc.getActiveCard();
      return c && c.id ? c.id : "__none__";
    } catch (e) { return "__none__"; }
  }
  function getCounts() {
    try {
      var o = JSON.parse(lsGet(LS_COUNT, "{}"));
      return (o && typeof o === "object") ? o : {};
    } catch (e) { return {}; }
  }
  function chatCount() { return countOf(getCounts(), slotKey()); }
  // The service exports bumpCount/resetCount as pure transforms; these two are the write actions,
  // so they carry a different name instead of shadowing them.
  function bumpChatCount() { lsSet(LS_COUNT, JSON.stringify(bumpCount(getCounts(), slotKey()))); }
  function resetChatCount() { lsSet(LS_COUNT, JSON.stringify(resetCount(getCounts(), slotKey()))); }

  // The capability paragraph is appended to the system prompt as its own segment.
  function getInjection() {
    if (!isEnabled()) return "";
    return injectionFor(nsfwLevel());
  }

  // Base image: the image module wins; the local map is the fallback for a page without it.
  function getBaseImage(charId) {
    if (window.chatImageSvc && window.chatImageSvc.getBaseImage) {
      try { return Promise.resolve(window.chatImageSvc.getBaseImage({ characterId: charId })); } catch (e) {}
    }
    try {
      var o = JSON.parse(lsGet(LS_BASE, "{}"));
      return Promise.resolve((o && o[charId]) || null);
    } catch (e) { return Promise.resolve(null); }
  }
  function setBaseImage(charId, imageUrl) {
    if (window.chatImageSvc && window.chatImageSvc.setBaseImage) {
      try { return Promise.resolve(window.chatImageSvc.setBaseImage({ characterId: charId, imageUrl: imageUrl })); } catch (e) {}
    }
    try {
      var o = JSON.parse(lsGet(LS_BASE, "{}"));
      if (!o || typeof o !== "object") o = {};
      o[charId] = imageUrl;
      lsSet(LS_BASE, JSON.stringify(o));
    } catch (e) {}
    return Promise.resolve();
  }

  async function expandScene(scene, card, kind) {
    return kind === "scene" ? localExpandScene(scene) : localExpand(scene, card, nsfwLevel());
  }

  function callSendPhoto(charId, scenePrompt, baseImageUrl, kind) {
    if (window.chatImageSvc && window.chatImageSvc.sendPhoto) {
      return Promise.resolve(window.chatImageSvc.sendPhoto({ characterId: charId, scenePrompt: scenePrompt, baseImageUrl: baseImageUrl, kind: kind }));
    }
    return new Promise(function (resolve) {
      setTimeout(function () { resolve({ imageUrl: mockImage(scenePrompt), taskId: "mock-" + Date.now() }); }, 1500);
    });
  }

  function loadingHtml() {
    return '<div style="display:flex;align-items:center;gap:8px;opacity:.75;font-size:13px;"><span style="width:14px;height:14px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;display:inline-block;animation:ci-spin .8s linear infinite;"></span><span>正在发送图片…</span></div>';
  }

  function renderPhotoBubble(afterRow, card) {
    var chat = document.getElementById("chat");
    var spacer = document.getElementById("bottom-spacer");
    if (!chat) return null;
    ensureSpinCss();
    var row = document.createElement("div");
    row.className = "row ai chat-image-row";
    var avatar = document.createElement("div");
    avatar.className = "avatar bot";
    avatar.textContent = (card && card.icon) ? card.icon : "🙂";
    if (card && card.name) avatar.title = card.name;
    var content = document.createElement("div");
    content.className = "content";
    var meta = document.createElement("div");
    meta.className = "meta";
    if (card && card.name) meta.textContent = card.name;
    content.appendChild(meta);
    var bubble = document.createElement("div");
    bubble.className = "bubble ai chat-image-bubble";
    bubble.style.minWidth = "140px";
    bubble.innerHTML = loadingHtml();
    content.appendChild(bubble);
    row.appendChild(avatar);
    row.appendChild(content);
    try { if (window.characterSvc && window.characterSvc.decorateAiRow) window.characterSvc.decorateAiRow(row, card); } catch (e) {}
    if (afterRow && afterRow.parentNode === chat && afterRow.nextSibling) chat.insertBefore(row, afterRow.nextSibling);
    else if (spacer) chat.insertBefore(row, spacer);
    else chat.appendChild(row);
    scrollChat();
    return bubble;
  }

  function setBubbleImage(bubble, imageUrl) {
    if (!bubble) return;
    bubble.innerHTML = "";
    var img = document.createElement("img");
    img.src = imageUrl;
    img.alt = "AI 发来的照片";
    // A long conversation keeps every image decoded and resident; lazy/deferred keeps offscreen
    // photos cheap without changing what is on screen.
    try { img.loading = "lazy"; img.decoding = "async"; } catch (e) {}
    img.style.cssText = "max-width:220px;max-height:300px;border-radius:10px;display:block;cursor:zoom-in;";
    img.addEventListener("click", function () { window.open(imageUrl, "_blank"); });
    bubble.appendChild(img);
    scrollChat();
  }

  // A selfie with no base image is generated from the card alone, so say so instead of pretending.
  function setBubbleNotice(bubble, text) {
    if (!bubble) return;
    var n = document.createElement("div");
    n.className = "chat-image-notice";
    n.style.cssText = "margin-top:6px;font-size:11px;line-height:1.5;color:#b8860b;opacity:.9;max-width:220px;word-break:break-word;";
    n.textContent = "ⓘ " + text;
    bubble.appendChild(n);
    scrollChat();
  }

  function setBubbleError(bubble, retryFn, errMsg) {
    if (!bubble) return;
    bubble.innerHTML = "";
    var box = document.createElement("div");
    box.style.cssText = "display:flex;align-items:center;gap:8px;font-size:13px;color:#c66;flex-wrap:wrap;";
    var txt = document.createElement("span"); txt.textContent = "发送失败";
    var btn = document.createElement("button"); btn.textContent = "点重试"; btn.className = "smallbtn"; btn.style.cssText = "font-size:12px;padding:2px 8px;";
    btn.addEventListener("click", function () { if (retryFn) retryFn(); });
    box.appendChild(txt); box.appendChild(btn);
    var msg = errMsg && (errMsg.message || errMsg);
    if (msg) {
      var d = document.createElement("div");
      d.style.cssText = "width:100%;font-size:11px;opacity:.7;word-break:break-all;";
      d.textContent = String(msg);
      box.appendChild(d);
    }
    bubble.appendChild(box);
  }

  function ensureSpinCss() {
    if (document.getElementById("ci-spin-css")) return;
    var s = document.createElement("style"); s.id = "ci-spin-css";
    s.textContent = "@keyframes ci-spin{to{transform:rotate(360deg)}}";
    document.head.appendChild(s);
  }

  function scrollChat() {
    var hw = document.getElementById("history");
    if (hw) { try { hw.scrollTo({ top: hw.scrollHeight, behavior: "auto" }); } catch (e) { hw.scrollTop = hw.scrollHeight; } }
  }

  // Group orchestration and the fishbowl debate both run several characters in a row; the cooldown
  // would otherwise silence every one of them after the first.
  function inRapidMultiContext() {
    try { if (window.fishbowlSvc && window.fishbowlSvc.getMode && window.fishbowlSvc.getMode()) return true; } catch (e) {}
    try { if (window.multiSvc && window.multiSvc.isMulti && window.multiSvc.isMulti()) return true; } catch (e) {}
    return false;
  }

  // The main flow: a signal arrived, so produce the image. `manual` bypasses cooldown and cap.
  function handleSignal(opts) {
    var o = opts || {};
    var scene = o.scene;
    var card = o.card || (window.characterSvc && window.characterSvc.getActiveCard && window.characterSvc.getActiveCard()) || null;
    var afterRow = o.afterRow || null;
    var manual = !!o.manual;
    if (!scene) return;
    var kind = o.kind === "scene" ? "scene" : detectKind(scene);
    var now = Date.now();
    var allowed = shouldSend({
      enabled: isEnabled(),
      manual: manual,
      rapidMulti: inRapidMultiContext(),
      now: now,
      lastAt: parseInt(lsGet(LS_LAST_AT, "0"), 10) || 0,
      cooldownSec: cooldownSec(),
      cap: capPerChat(),
      count: chatCount()
    });
    if (!allowed) return;

    var charId = card && card.id ? card.id : "__none__";
    lsSet(LS_LAST_AT, String(Date.now()));
    if (!manual) bumpChatCount();

    var bubble = renderPhotoBubble(afterRow, card);
    var done = false, timer = null, timeoutMs = 30000, baseImg = null;

    function arm() {
      done = false;
      clearTimeout(timer);
      timer = setTimeout(function () {
        if (done) return;
        done = true;
        setBubbleError(bubble, retry, "出图超时(上游可能排队过久),点重试");
      }, timeoutMs);
    }
    function retry() { if (bubble) bubble.innerHTML = loadingHtml(); arm(); runSend(); }
    function runSend() {
      Promise.resolve(callSendPhoto(charId, o.scenePrompt || scene, baseImg || undefined, kind)).then(function (res) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        var url = res && res.imageUrl;
        if (url) {
          setBubbleImage(bubble, url);
          if (kind !== "scene" && !baseImg) {
            setBubbleNotice(bubble, "未设基准图:这张按角色卡即时生成,样貌可能和设定有出入。在设置「微信发图」卡上传基准图后,自拍会锁定长相。");
          }
        } else setBubbleError(bubble, retry, "出图无返回");
      }).catch(function (err) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        setBubbleError(bubble, retry, err);
      });
    }

    (kind === "scene" ? Promise.resolve(null) : Promise.resolve(getBaseImage(charId)).catch(function () { return null; }))
      .then(function (base) {
        baseImg = base;
        timeoutMs = timeoutFor(kind, !!base);
      })
      .then(function () { arm(); return expandScene(scene, card, kind); })
      .then(function (p) { o.scenePrompt = p; runSend(); })
      .catch(function () { o.scenePrompt = scene; runSend(); });
  }

  // One photo on demand, for the settings button.
  function requestManual(sceneText) {
    var scene = (sceneText && String(sceneText).trim()) || "随手自拍,自然表情";
    var rows = document.querySelectorAll("#chat .row.ai");
    var last = rows.length ? rows[rows.length - 1] : null;
    handleSignal({ scene: scene, afterRow: last, manual: true });
  }

  function mountCard() {
    var slot = window.slotRegistry.pick("setImageChatSlot");
    if (slot) window.slotRegistry.claim({ cardId: "ciEnableToggle", slotId: "setImageChatSlot" });
    if (!slot || document.getElementById("ciEnableToggle")) return;
    var card = document.createElement("div");
    card.className = "card";
    card.id = "chatImageCard";
    card.innerHTML = '<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="M4 17.5l5-5 3.2 3.2 3.2-3.8 4.1 5"/></svg>微信发图</h4>'
      + '<p>开启后 AI 会在合适时机往对话里"发"照片——自拍走基准图改图、场景/物品/宠物走文生图。消耗图像额度,<b>仅本设备</b>。</p>'
      + '<div class="rowline"><div class="toggle"><input type="checkbox" id="ciEnableToggle"><label for="ciEnableToggle">启用微信发图</label></div><div class="btns"><button class="smallbtn" id="ciManualBtn">手动来一张</button></div></div>'
      + '<div class="settings-grid-2"><label><span>冷却(秒)</span><input type="number" id="ciCooldown" min="0" max="600"></label><label><span>每会话上限</span><input type="number" id="ciCap" min="0" max="99"></label></div>'
      + '<div class="rowline" style="align-items:center;gap:10px;margin-top:10px;"><div style="font-size:12px;color:var(--muted);flex:1;min-width:0;">当前角色基准图</div><div class="btns"><button class="smallbtn" id="ciBasePick" type="button">选择图片…</button></div><input type="file" id="ciBaseUpload" accept="image/*" style="display:none;"></div>'
      + '<div id="ciBaseStatus" style="font-size:11px;color:var(--muted);margin-top:8px;"></div>'
      + '<div class="settings-tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg><span>每会话上限填 0 = 不限;冷却填 0 = 不限频。基准图用于"自拍"类发图把脸固定下来,场景/物品图不用基准图。</span></div>';
    slot.appendChild(card);
    wireSettings();
  }

  function wireSettings() {
    var en = document.getElementById("ciEnableToggle");
    if (en) { en.checked = isEnabled(); en.addEventListener("change", function () { lsSet(LS_ENABLED, en.checked ? "1" : "0"); }); }
    var cd = document.getElementById("ciCooldown");
    if (cd) { cd.value = cooldownSec(); cd.addEventListener("change", function () { lsSet(LS_COOLDOWN, String(parseInt(cd.value, 10) || DEFAULT_COOLDOWN)); }); }
    var cap = document.getElementById("ciCap");
    if (cap) { cap.value = capPerChat(); cap.addEventListener("change", function () { lsSet(LS_CAP, String(parseInt(cap.value, 10) || 0)); }); }
    var up = document.getElementById("ciBaseUpload");
    var pick = document.getElementById("ciBasePick");
    if (pick && up) pick.addEventListener("click", function () { up.click(); });
    if (up) up.addEventListener("change", function () {
      var f = up.files && up.files[0];
      if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        var charId = slotKey();
        setBaseImage(charId, rd.result);
        var st = document.getElementById("ciBaseStatus");
        if (st) st.textContent = "✓ 已为当前角色(" + charId + ")设置基准图";
      };
      rd.readAsDataURL(f);
      up.value = "";
    });
    var mq = document.getElementById("ciManualBtn");
    if (mq) mq.addEventListener("click", function () { requestManual(""); });
  }

  window.chatImageTextSvc = {
    getInjection: getInjection,
    extractSignal: extractSignal,
    stripSignalForDisplay: stripSignalForDisplay,
    handleSignal: handleSignal,
    requestManual: requestManual,
    getBaseImage: getBaseImage,
    setBaseImage: setBaseImage,
    isEnabled: isEnabled,
    resetChatCount: resetChatCount,
    _mock: mockImage
  };

  function _init() { mountCard(); }
  if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", _init);
  else _init();
})();
