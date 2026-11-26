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

export const ACCESS_TOKEN_KEY = "cfw_auth_token_v1";

/** Whether the wrapper should consider adding the token to this URL. */
export function needsAuth(url: string): boolean {
  return url.indexOf("/sync") === 0 || url.indexOf("/api/") === 0;
}

/**
 * The `Authorization` value for a URL, or an empty string when none should be added. An empty token
 * means a guest: the wrapper then leaves the request untouched and the server answers 401.
 */
export function authorizationFor(url: string, token: string): string {
  if (!needsAuth(url)) return "";
  if (!token) return "";
  return "Bearer " + token;
}

export interface PasswordOutcome {
  ok: boolean;
  /** Shown inside the dialog when the attempt is rejected; empty when accepted. */
  message: string;
}

export function passwordOutcome(status: number): PasswordOutcome {
  if (status === 401) return { ok: false, message: "密码错误" };
  // 500 means the password passed but the KV store is unbound, which is still a valid password.
  if ((status >= 200 && status < 300) || status === 500) return { ok: true, message: "" };
  return { ok: false, message: "网络异常 (HTTP " + status + ")，请稍后重试" };
}
