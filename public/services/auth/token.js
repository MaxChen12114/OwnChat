(function () {
/**
 * The rules behind the global fetch wrapper: which URLs carry the access token, what header the
 * wrapper may add, and how a password attempt is judged.
 *
 * The wrapper sits in front of every request in the app, so the two things it must never do are
 * decide too broadly and decide too kindly:
 *  - Only `/sync` and `/api/` get the token. A third-party URL inheriting it would leak the access
 *    password to whoever the page happens to call.
 *  - A request that already carries `Authorization` keeps its own value; the wrapper fills a gap, it
 *    does not overwrite.
 *
 * The password check treats exactly one status as "wrong password" (401) and exactly one as "right
 * password although the store is unbound" (500). An earlier version accepted everything that was not
 * 401, which let a wrong password through for as long as the backend was broken.
 * @module services/auth/token
 */

const ACCESS_TOKEN_KEY = "cfw_auth_token_v1";

/** Whether the wrapper should consider adding the token to this URL. */
function needsAuth(url        )          {
  return url.indexOf("/sync") === 0 || url.indexOf("/api/") === 0;
}

/**
 * The `Authorization` value for a URL, or an empty string when none should be added. An empty token
 * means a guest: the wrapper then leaves the request untouched and the server answers 401.
 */
function authorizationFor(url        , token        )         {
  if (!needsAuth(url)) return "";
  if (!token) return "";
  return "Bearer " + token;
}

                                  
              
                                                                                   
                  
 

function passwordOutcome(status        )                  {
  if (status === 401) return { ok: false, message: "密码错误" };
  // 500 means the password passed but the KV store is unbound, which is still a valid password.
  if ((status >= 200 && status < 300) || status === 500) return { ok: true, message: "" };
  return { ok: false, message: "网络异常 (HTTP " + status + ")，请稍后重试" };
}

// Browser adapter, appended by l0/emit.mjs. Engine: services/auth/token.ts; this file owns the token
// store, the global fetch wrapper and the password dialog.
//
// Loaded before everything else: any module that talks to /sync or /api/* relies on the header this
// wrapper injects. The dialog is the shared themed one from feedback.js; the fallback is
// window.prompt so a page without that bundle can still be unlocked.
//
// Public API: window.__auth = { getToken, setToken, clearToken, promptForPassword } — the name and the
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
    var fb = window.__feedback;
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

  window.__auth = {
    getToken: getToken,
    setToken: setToken,
    clearToken: clearToken,
    promptForPassword: promptForPassword,
  };
})();

globalThis.ACCESS_TOKEN_KEY = ACCESS_TOKEN_KEY;
globalThis.needsAuth = needsAuth;
globalThis.authorizationFor = authorizationFor;
globalThis.passwordOutcome = passwordOutcome;
})();
