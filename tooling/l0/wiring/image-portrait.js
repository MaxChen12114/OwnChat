// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/image/portrait.ts; this file owns the
// frozen global name, the localStorage key, the style change event and the two image-module calls.
//
// The generation fallback (direct provider call when the workshop module is absent) lives here on
// purpose: it reads the channel key, the auth token and the endpoint, none of which a
// realm-neutral service should know about.
(function () {
  if (window.portraitSvc) return;

  function readLS(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }

  function directGenerate(prompt) {
    var key = readLS("cfw_image_key_v1") || readLS("moark_api_key") || "";
    if (!key) return Promise.reject(new Error("请先在设置 → 模型 API → 图像渠道填写当前渠道的 Key"));
    var headers = { "Authorization": "Bearer " + key, "Content-Type": "application/json" };
    try {
      var token = (window.authSvc && window.authSvc.getToken && window.authSvc.getToken()) || readLS("cfw_auth_token_v1") || "";
      if (token) headers["X-Sync-Token"] = token;
    } catch (e) {}
    return window.fetch("/img/v1/images/generations", {
      method: "POST",
      headers: headers,
      body: JSON.stringify({ prompt: prompt, model: "z-image-turbo", n: 1, size: "768x1024" })
    }).then(function (r) {
      if (!r.ok) throw new Error("生成失败 " + r.status);
      return r.json().then(function (j) {
        var first = (j && j.data && j.data[0]) || null;
        if (!first) throw new Error("无返回");
        return first.url || (first.b64_json ? "data:image/png;base64," + first.b64_json : null);
      });
    });
  }

  var portrait = createPortrait({
    storage: {
      getItem: function (k) { return readLS(k); },
      setItem: function (k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} }
    },
    notify: function (style) {
      try { window.dispatchEvent(new window.CustomEvent("imagestyle:changed", { detail: { style: style } })); } catch (e) {}
    },
    activeCard: function () {
      try { return (window.characterSvc && window.characterSvc.getActiveCard) ? window.characterSvc.getActiveCard() : null; } catch (e) { return null; }
    },
    generate: function (prompt) {
      if (window.imageStudioSvc && typeof window.imageStudioSvc.generate === "function") {
        return window.imageStudioSvc.generate({ prompt: prompt, n: 1, size: "768x1024" }).then(function (data) {
          var d = (data && data[0]) || null;
          if (!d) return null;
          return d.url || (d.b64_json ? "data:image/png;base64," + d.b64_json : null);
        });
      }
      return directGenerate(prompt);
    },
    setBaseImage: function (arg) {
      if (!window.chatImageSvc || typeof window.chatImageSvc.setBaseImage !== "function") return Promise.resolve(false);
      return Promise.resolve(window.chatImageSvc.setBaseImage(arg)).then(function () { return true; });
    }
  });

  window.portraitSvc = {
    generateForActive: portrait.generateForActive, setAsBase: portrait.setAsBase,
    buildPrompt: portrait.buildPrompt, getStyle: portrait.getStyle, setStyle: portrait.setStyle,
    getStyleTags: portrait.getStyleTags, getLastImage: portrait.getLastImage, styles: portrait.styles
  };
})();
