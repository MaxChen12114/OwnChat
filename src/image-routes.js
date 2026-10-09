/**
 * image-routes.js — 图像侧统一代理，挂进主 Worker。
 * 上游：Gitee AI (https://ai.gitee.com/v1)。密钥由前端以 Bearer 透传（维持现状，服务端不托管）。
 *
 * 路由（在主 worker.js 的 fetch 里优先匹配，未命中返回 null 交回主逻辑）：
 *   /img/v1/*      -> 代理到 https://ai.gitee.com/v1/<path>
 *   /img/dl?url=   -> 下载代理（带 Range，剥 CSP/X-Frame，解决跨域下载）
 *   /img/r2/save   -> 转存图片到 R2 拿同源直链（POST，鉴权用云同步 token）
 *   /img/r2/get    -> 读 R2 图片（画廊/基准图同源直链）
 *   /img/gallery   -> 云画廊列表（R2 + KV）
 *
 * 用法（主 worker.js）：
 *   import { handleImageRequest } from "./image-routes.js";
 *   const img = await handleImageRequest(request, env);
 *   if (img) return img;
 */

const UPSTREAM = "https://ai.gitee.com/v1";

import { isPrivateHost } from "./net-guard.js";

/** 内网地址拦截的统一 403(与 /api/fetch 的 400 拒绝语义区分开:这里是明确禁止) */
function json403() {
  return new Response(JSON.stringify({ error: "Blocked: private/reserved address" }), { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders() } });
}

export async function handleImageRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/img/dl" || path === "/img/dl/") return handleDownload(request, url, env);
  if (path.startsWith("/img/v1/")) return handleProxy(request, url, env);
  return null; // 不是图像路由，交回主 Worker
}

async function handleProxy(request, url, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (!checkSync(request, env)) return jsonResp({ error: "Unauthorized" }, 401);
  const rest = url.pathname.slice("/img/v1/".length);
  const target = new URL(`${UPSTREAM}/${rest}`);
  target.search = url.search;
  const headers = new Headers(request.headers);
  for (const k of ["host", "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "x-forwarded-for", "x-forwarded-proto", "x-real-ip"]) headers.delete(k);
  const init = { method: request.method, headers, redirect: "follow", cache: "no-store" };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
  const upstream = await fetch(target.toString(), init);
  const respHeaders = applyCors(stripCache(new Headers(upstream.headers)));
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: respHeaders });
}

async function handleDownload(request, url, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (!checkSync(request, env)) return jsonResp({ error: "Unauthorized" }, 401);
  const target = url.searchParams.get("url") || "";
  if (!target || !(target.startsWith("https://") || target.startsWith("http://"))) {
    return new Response(JSON.stringify({ error: "Invalid or missing url param" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders() } });
  }
  // 2026-10-05(A-5): 与 /api/fetch 同样的内网拦截 —— 原来 isPrivateHost 只护了文本侧,
  // 这里接受任意 url 却不查主机,防护不一致。共享实现见 src/net-guard.js。
  try { if (isPrivateHost(new URL(target).hostname)) return json403(); } catch { /* URL 解析失败走下面的正常抓取报错 */ }
  const h = new Headers();
  const range = request.headers.get("Range");
  if (range) h.set("Range", range);
  const upstream = await fetch(target, { method: "GET", headers: h, redirect: "follow", cache: "no-store" });
  const respHeaders = stripCache(new Headers(upstream.headers));
  respHeaders.delete("Content-Security-Policy");
  respHeaders.delete("X-Frame-Options");
  applyCors(respHeaders);
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: respHeaders });
}

// 与文本侧云同步同源鉴权: 设了 env.CHAT_PASSWORD 时要求 X-Sync-Token(或 Authorization)等于它;
// 未设密码则放行(本地/内网部署)。
// 2026-10-09: /img/v1 与 /img/dl 重新挂上本校验 —— 这两条是"拿你的 Worker 当免费代理"的两个面
// (代理上游 + 任意 URL 下载),之前无消费方时等于对全网开放。前端在应用登录态下会带 X-Sync-Token。
// 不用 Authorization 做判断面:那个头被"上游 Gitee Key 透传"占着,拿它当密码校验会误伤正常生图。
function checkSync(request, env) {
  if (!env || !env.CHAT_PASSWORD) return true;
  const auth = request.headers.get("Authorization") || "";
  const tok = auth.replace(/^Bearer\s+/i, "").trim();
  const alt = request.headers.get("X-Sync-Token") || "";
  return tok === env.CHAT_PASSWORD || alt === env.CHAT_PASSWORD;
}
function jsonResp(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { "Content-Type": "application/json", ...corsHeaders() } });
}

// 2026-10-05(C-2): 删除 /img/r2/save、/img/r2/get、/img/gallery 三个路由 ——
// wrangler.toml 从未声明 IMAGES_BUCKET/IMAGES_SYNC 绑定,线上一直是 501,
// 且前端零调用方(grep 无命中),属于从未接线的死代码。随删的还有它们的
// 鉴权面问题(/img/r2/get 原本连 checkSync 都没有)。/img/dl 与 /img/v1 在用,保留。
// 若将来要做图像云同步,从 git 历史恢复本段(提交 54cfbff 之后的下一个提交)。

function stripCache(h) {
  for (const k of ["Cache-Control", "ETag", "Last-Modified", "Expires", "Age", "Vary"]) h.delete(k);
  h.set("Cache-Control", "no-store, no-cache, must-revalidate");
  h.set("Pragma", "no-cache");
  return h;
}
function corsHeaders() {
  return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS", "Access-Control-Allow-Headers": "*", "Access-Control-Max-Age": "86400" };
}
function applyCors(h) { for (const [k, v] of Object.entries(corsHeaders())) h.set(k, v); return h; }