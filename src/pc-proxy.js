// worker/pc-proxy.js — 主站 Worker 的 /api/pc/* 代理
// ─────────────────────────────────────────────────────────────
// 链路：手机 → /api/pc/* → 本文件 → CF Access 服务令牌 → cloudflared → pc-bridge
//
// 安全：
//   · 路由层必须先 checkAuth(request, env) === true（Bearer = CHAT_PASSWORD / unlock token）
//   · 服务令牌与本机 token 只在 Worker secret 里，不下发浏览器
//   · 只白名单下列端点；不透传 Authorization / Cookie
//   · /api/pc/shot 原样回 image/jpeg；其余按 JSON 回
//
// 需要的 Worker secrets：
//   PC_TUNNEL_URL            https://pc.your-domain.example
//   PC_ACCESS_CLIENT_ID      Access 服务令牌 Client ID
//   PC_ACCESS_CLIENT_SECRET  Access 服务令牌 Client Secret
//   PC_TOKEN                 remote-desk/.pc-token 的内容
// ─────────────────────────────────────────────────────────────

const GET_OPS = new Set(["/health", "/status", "/shot", "/ui", "/windows", "/clipboard", "/audit"]);
const POST_OPS = new Set(["/clipboard", "/click", "/type", "/key", "/scroll", "/focus", "/panic", "/arm", "/ls", "/read", "/grep"]);
const MAX_BODY = 64 * 1024;

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function opOf(url) {
  const p = url.pathname;
  if (p === "/api/pc" || p === "/api/pc/") return "/health";
  return p.slice("/api/pc".length);
}

export async function handlePcProxy(request, env) {
  const url = new URL(request.url);
  const op = opOf(url);

  const isGet = request.method === "GET";
  const isPost = request.method === "POST";
  if (isGet && !GET_OPS.has(op)) return json({ ok: false, error: "GET 不支持 " + op }, 405);
  if (isPost && !POST_OPS.has(op)) return json({ ok: false, error: "POST 不支持 " + op }, 405);
  if (!isGet && !isPost) return json({ ok: false, error: "只支持 GET/POST" }, 405);

  const base = String(env.PC_TUNNEL_URL || "").replace(/\/+$/, "");
  if (!base) return json({ ok: false, error: "PC_TUNNEL_URL 未配置" }, 503);
  if (!env.PC_ACCESS_CLIENT_ID || !env.PC_ACCESS_CLIENT_SECRET) {
    return json({ ok: false, error: "PC_ACCESS_CLIENT_ID/SECRET 未配置" }, 503);
  }
  if (!env.PC_TOKEN) return json({ ok: false, error: "PC_TOKEN 未配置" }, 503);

  let body;
  if (isPost) {
    body = await request.text();
    if (body.length > MAX_BODY) return json({ ok: false, error: "请求体过大" }, 413);
  }

  const headers = {
    "CF-Access-Client-Id": env.PC_ACCESS_CLIENT_ID,
    "CF-Access-Client-Secret": env.PC_ACCESS_CLIENT_SECRET,
    "X-PC-Token": env.PC_TOKEN,
    "X-Request-Id": crypto.randomUUID(),
    "accept": request.headers.get("accept") || "application/json",
  };
  if (isPost) headers["content-type"] = "application/json";

  let upstream;
  try {
    upstream = await fetch(base + "/pc" + op + url.search, {
      method: request.method,
      headers,
      body: isPost ? body : undefined,
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    return json({ ok: false, error: "PC 隧道不可达：" + String(e && e.message || e) }, 502);
  }

  const ct = upstream.headers.get("content-type") || "application/octet-stream";
  const outHeaders = { "content-type": ct, "cache-control": "no-store" };
  for (const h of ["x-pc-width", "x-pc-height", "x-pc-source-width", "x-pc-source-height"]) {
    const v = upstream.headers.get(h);
    if (v) outHeaders[h] = v;
  }
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}
