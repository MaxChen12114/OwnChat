// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/auth/token.ts; this file owns the token
// store, the global fetch wrapper and the password dialog.
//
// Loaded before everything else: any module that talks to /sync or /api/* relies on the header this
// wrapper injects. The dialog is the shared themed one from feedback.js; the fallback is
// window.prompt so a page without that bundle can still be unlocked.
//
// Public API: window.authSvc = { getToken, setToken, clearToken, promptForPassword } — the name and the
// four members are frozen, other modules read them directly.
(function () {
  "use strict";

  function getToken() { return localStorage.getItem(ACCESS_TOKEN_KEY) || ""; }
  function setToken(t) {
    if (t) localStorage.setItem(ACCESS_TOKEN_KEY, t);
    else localStorage.removeItem(ACCESS_TOKEN_KEY);
  }
  function clearToken() { localStorage.removeItem(ACCESS_TOKEN_KEY); }

  // The wrapper keeps the original fetch: the password check has to bypass its own interceptor,
  // otherwise a stale token would be sent along with the password being verified.
  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    init = init || {};
    var url = typeof input === "string" ? input : (input && input.url) || "";
    var auth = authorizationFor(url, getToken());
    if (auth) {
      var headers = new Headers(init.headers || (typeof input === "object" && input.headers) || {});
      // Only fill the gap: a caller that set its own Authorization means it.
      if (!headers.has("Authorization")) headers.set("Authorization", auth);
      init.headers = headers;
    }
    return realFetch(input, init);
  };

  function promptForPassword(opts) {
    opts = opts || {};
    var plainHint = String(opts.hint || "请输入与 Cloudflare Secret CHAT_PASSWORD 一致的密码").replace(/<[^>]+>/g, "");
    var fb = window.feedbackSvc;
    if (!fb || !fb.dialog) {
      return new Promise(function (resolve, reject) {
        var v = window.prompt(plainHint, "");
        if (v == null) reject(new Error("用户取消")); else resolve(v);
      });
    }
    return fb.dialog({
      title: opts.title || "输入密码",
      message: plainHint,
      icon: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/></svg>',
      input: { type: "password", placeholder: "密码" },
      okText: opts.confirmText || "确认",
      cancelText: "取消",
      onOk: async function (v) {
        if (!v) return "请输入密码";
        try {
          var r = await realFetch("/sync", { headers: { "Authorization": "Bearer " + v } });
          var outcome = passwordOutcome(r.status);
          return outcome.ok ? true : outcome.message;
        } catch (e) {
          return "网络错误: " + e.message;
        }
      }
    }).then(function (v) {
      if (v == null) throw new Error("用户取消");
      return v;
    });
  }

  window.authSvc = {
    getToken: getToken,
    setToken: setToken,
    clearToken: clearToken,
    promptForPassword: promptForPassword,
  };
})();
