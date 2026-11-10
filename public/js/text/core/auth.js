// public/js/text/core/auth.js
// 鉴权中间层：
// 1. 拦截全局 fetch，给 /sync 和 /api/* 自动注入 Authorization: Bearer <token> header
// 2. 提供 promptForPassword() 弹框 UI（设置面板调用）
// 3. 提供 setToken / getToken / clearToken API
// 最早加载：index.html 中第一个 script
(() => {
  const TOKEN_KEY = "cfw_auth_token_v1";

  function getToken() { return localStorage.getItem(TOKEN_KEY) || ""; }
  function setToken(t) {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  }
  function clearToken() { localStorage.removeItem(TOKEN_KEY); }

  // ─── 全局 fetch 拦截：已保存访问码时 /sync 与 /api/* 都带（访客=没有 token） ───
  const realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    init = init || {};
    let url = "";
    if (typeof input === "string") url = input;
    else if (input && input.url) url = input.url;

    const needsAuth =
      url.startsWith("/sync") ||
      url.startsWith("/api/");

    if (needsAuth) {
      const token = getToken();
      if (token) {
        const headers = new Headers(init.headers || (typeof input === "object" && input.headers) || {});
        if (!headers.has("Authorization")) {
          headers.set("Authorization", "Bearer " + token);
        }
        init.headers = headers;
      }
    }
    return realFetch(input, init);
  };

  // ─── 密码弹窗【注入验证用】───
  // 调用时：__auth.promptForPassword({ title?, hint? }) → Promise<password>
  // 验证逻辑：拿输入的密码去请 GET /sync，401 = 错；200/500 = 对（500 是 KV 未绑定但密码已过）
  // 2026-11-10: 改用 feedback.js 的统一主题弹窗。旧版是写死深色的自绘卡片
  // (#1f2128 底 / #4a9eff 蓝钮)，在亮色、玻璃、烛光主题下完全不搭，且没有主题描边。
  // 校验仍走 onOk 异步验证：401 = 密码错（弹窗内显示错误并保持打开），200/500 = 通过。
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
          // 临时不走拦截器【避免拿旧 token】，手工带 header
          var r = await realFetch("/sync", { headers: { "Authorization": "Bearer " + v } });
          if (r.status === 401) return "密码错误";
          // 2026-11-08 修(审查 P1): 只有 200 / 500(KV 未绑定) 算校验通过 —— 旧版把 404/429/502
          // 等一切非 401 都当"密码正确"落 token,服务端故障期间错误密码也能进
          if (r.ok || r.status === 500) return true;
          return "网络异常 (HTTP " + r.status + ")，请稍后重试";
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
    getToken,
    setToken,
    clearToken,
    promptForPassword,
  };
})();