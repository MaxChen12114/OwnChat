// net-guard.js — 网络边界守卫（worker 侧共享）
// ─────────────────────────────────────────────────────────────
// 2026-10-05(A-5): 从 worker.js 提出 —— 原来 isPrivateHost 只护了 /api/fetch,
// 同一 worker 里的 /img/dl、/img/r2/save 接受任意 URL 却没有同样的拦截,
// 防护不一致。提为共享模块,所有"服务端代发任意 URL"的入口统一使用。
//
// 买到什么要说清(原注释保留):生产环境(Cloudflare 边缘)下 127.0.0.1 指边缘自身,
// 意义有限;但 wrangler dev --local 下 worker 就跑在本机,这是一条真实的本地端口
// 探测面。同时挡掉经开放代理发起的内网请求。
// 局限:只覆盖常见主机写法,不做完整 RFC 3986 规范化;DNS 重绑定不在覆盖范围。

/**
 * 主机名是否为私有/保留地址(应拒绝代理)。
 */
export function isPrivateHost(hostname) {
  let h = String(hostname || "").toLowerCase().trim();
  if (!h) return true;
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1); // IPv6 方括号
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "::") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // fc00::/7 唯一本地
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true; // fe80::/10 链路本地
  // 非点分写法(十进制 2130706433 / 十六进制 0x7f000001 / 纯整数)一律拒 —— 正常域名不会长这样
  if (/^(0x[0-9a-f]+|\d+)$/.test(h)) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false; // 普通域名放行
  const a = Number(m[1]), b = Number(m[2]);
  return a === 0 || a === 10 || a === 127
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)
    || a >= 224; // 组播/保留
}
