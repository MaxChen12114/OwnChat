// public/js/text/core/auth.js
// 鉴权中间层：
// 1. 拦截全局 fetch，给 /sync 和 /api/* 自动注入 Authorization: Bearer <token> header
// 2. 提供 promptForPassword() 弹框 UI（设置面板调用）
// 3. 提供 setToken / getToken / clearToken / chatProtect 开关 API
// 最早加载：index.html 中第一个 script
(() => {
  const TOKEN_KEY = "cfw_auth_token_v1";
  const CHAT_PROTECT_KEY = "cfw_chat_protect_v1"; // 聊天密码保护开关（1=开）

  function getToken() { return localStorage.getItem(TOKEN_KEY) || ""; }
  function setToken(t) {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  }
  function clearToken() { localStorage.removeItem(TOKEN_KEY); }

  function chatProtectOn() { return localStorage.getItem(CHAT_PROTECT_KEY) === "1"; }
  function setChatProtect(on) { localStorage.setItem(CHAT_PROTECT_KEY, on ? "1" : "0"); }

  // ─── 全局 fetch 拦截：/sync 永远带；chatProtect 开启时 /api/* 也带 ───
  const realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    init = init || {};
    let url = "";
    if (typeof input === "string") url = input;
    else if (input && input.url) url = input.url;

    const needsAuth =
      url.startsWith("/sync") ||
      (chatProtectOn() && url.startsWith("/api/"));

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
  function promptForPassword(opts) {
    opts = opts || {};
    return new Promise((resolve, reject) => {
      const mask = document.createElement("div");
      mask.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);";
      const box = document.createElement("div");
      box.style.cssText = "background:#1f2128;color:#eee;padding:24px;border-radius:12px;max-width:90vw;width:380px;box-shadow:0 12px 48px rgba(0,0,0,.5);font-family:inherit;";
      box.innerHTML = `
        <h3 style="margin:0 0 8px;font-size:16px;">${opts.title || "\ud83d\udd12 \u8f93\u5165\u5bc6\u7801"}</h3>
        <div style="font-size:12px;color:#999;margin-bottom:16px;line-height:1.5;">${opts.hint || "\u8bf7\u8f93\u5165\u4e0e Cloudflare Secret <code>CHAT_PASSWORD</code> \u4e00\u81f4\u7684\u5bc6\u7801"}</div>
        <input type="password" id="__authPwInput" placeholder="\u5bc6\u7801" style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #444;background:#15171c;color:#eee;font-size:14px;margin-bottom:8px;">
        <div id="__authPwErr" style="font-size:12px;color:#e57373;margin-bottom:12px;min-height:16px;"></div>
        <div style="display:flex;justify-content:flex-end;gap:8px;">
          <button id="__authPwCancel" style="padding:8px 16px;border:none;border-radius:6px;background:#3a3d45;color:#eee;cursor:pointer;">\u53d6\u6d88</button>
          <button id="__authPwOk" style="padding:8px 16px;border:none;border-radius:6px;background:#4a9eff;color:#fff;cursor:pointer;">${opts.confirmText || "\u786e\u8ba4"}</button>
        </div>
      `;
      mask.appendChild(box);
      document.body.appendChild(mask);
      const input = box.querySelector("#__authPwInput");
      const err = box.querySelector("#__authPwErr");
      const ok = box.querySelector("#__authPwOk");
      const cancel = box.querySelector("#__authPwCancel");
      setTimeout(() => input.focus(), 50);

      let validating = false;
      async function close(result, error) {
        try { document.body.removeChild(mask); } catch {}
        if (error) reject(error); else resolve(result);
      }
      async function confirm() {
        if (validating) return;
        const v = input.value;
        if (!v) { err.textContent = "\u8bf7\u8f93\u5165\u5bc6\u7801"; return; }
        validating = true;
        err.textContent = "\u6b63\u5728\u9a8c\u8bc1\u2026";
        ok.disabled = true;
        try {
          // 临时不走拦截器【避免拿旧 token】，手工带 header
          const r = await realFetch("/sync", { headers: { "Authorization": "Bearer " + v } });
          if (r.status === 401) {
            err.textContent = "\u5bc6\u7801\u9519\u8bef";
            validating = false; ok.disabled = false;
            return;
          }
          // 2026-11-08 修(审查 P1): 只有 200 / 500(KV 未绑定) 算校验通过 —— 旧版把 404/429/502
          // 等一切非 401 都当"密码正确"落 token,服务端故障期间错误密码也能进
          if (r.ok || r.status === 500) {
            close(v);
          } else {
            err.textContent = "\u7f51\u7edc\u5f02\u5e38 (HTTP " + r.status + ")\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5";
            validating = false; ok.disabled = false;
          }
        } catch (e) {
          err.textContent = "\u7f51\u7edc\u9519\u8bef: " + e.message;
          validating = false; ok.disabled = false;
        }
      }
      ok.addEventListener("click", confirm);
      cancel.addEventListener("click", () => close(null, new Error("\u7528\u6237\u53d6\u6d88")));
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); confirm(); }
        else if (e.key === "Escape") close(null, new Error("\u7528\u6237\u53d6\u6d88"));
      });
      mask.addEventListener("click", (e) => {
        if (e.target === mask) close(null, new Error("\u7528\u6237\u53d6\u6d88"));
      });
    });
  }

  window.__auth = {
    getToken,
    setToken,
    clearToken,
    promptForPassword,
    chatProtectOn,
    setChatProtect,
  };
})();