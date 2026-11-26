/**
 * The private-mode gate, minus the DOM: which level the content-mode key is derived to, what an
 * unlock writes, what a relock removes, whether a chat body needs the unlock token, and how many taps
 * on the version tag count as "asked for the passphrase".
 *
 * The content-mode key is deliberately *derived*, never edited: locked writes `0`, unlocked writes
 * `3`, and this runs on every load so an earlier session's value cannot survive a relock. Several
 * modules read that key (themes, the image side, `data-nsfw` in the page), which is why it may not be
 * dropped altogether — only overwritten.
 *
 * An unlock also seeds the access token, because one passphrase is both the private-mode key and the
 * app password. Relock therefore has two shapes and the caller must pick one: keep the access token
 * (a mode switch — the user stays signed in and can switch back without retyping), or drop it
 * (a logout). The content gate stays closed in both, because a locked client stops putting
 * `unlockToken` on chat bodies and the worker only picks the private registry from that token.
 * @module services/auth/unlock
 */

export const UNLOCK_FLAG_KEY = "cfw_unlocked_v1";
export const UNLOCK_TOKEN_KEY = "cfw_unlock_token_v1";
export const AUTH_TOKEN_KEY = "cfw_auth_token_v1";
export const CONTENT_MODE_KEY = "cfw_nsfw_mode_v1";
export const DEV_MODE_KEY = "cfw_dev_mode_v1";
export const THEME_KEY = "cfw_theme_v1";

/** Themes that only exist for the private mode; a relock falls back to the plain one. */
export const PRIVATE_THEMES = ["lewd-peach", "lewd-doll", "candle"];
export const FALLBACK_THEME = "minimal";

/** Taps on the version tag, and how long a gap still counts as the same run. */
export const UNLOCK_TAPS = 7;
export const TAP_WINDOW_MS = 1500;

/** The content-mode value implied by the lock state. */
export function contentMode(unlocked: boolean): string {
  return unlocked ? "3" : "0";
}

export interface Write {
  key: string;
  value: string;
}

/** What a successful unlock persists: the flag, both token keys, and the debug panel. */
export function unlockWrites(token: string): Write[] {
  return [
    { key: UNLOCK_FLAG_KEY, value: "1" },
    { key: UNLOCK_TOKEN_KEY, value: token },
    { key: AUTH_TOKEN_KEY, value: token },
    { key: DEV_MODE_KEY, value: "1" },
  ];
}

/**
 * The access token to copy into the auth key at startup, or an empty string when there is nothing to
 * copy. Only fills a gap: an auth key the user already has is never replaced by the unlock token.
 */
export function seedAuthToken(flag: string, unlockToken: string, authToken: string): string {
  if (flag !== "1" || !unlockToken) return "";
  if (authToken) return "";
  return unlockToken;
}

export interface RelockPlan {
  /** Keys to remove; the content-mode key is not one of them, it is overwritten instead. */
  remove: string[];
  /** Theme to fall back to, or an empty string when the current theme is fine. */
  theme: string;
  contentMode: string;
}

/**
 * What leaving private mode removes.
 *
 * @param keepAuth - `true` keeps the access token, so the switch is reversible without retyping the
 *   passphrase; `false` drops it as well, which is a logout. Defaults to the destructive shape: a
 *   caller that has not thought about it must not leave a live token behind a locked-looking UI.
 */
export function relockPlan(theme: string, keepAuth: boolean = false): RelockPlan {
  const remove = [UNLOCK_FLAG_KEY, UNLOCK_TOKEN_KEY, DEV_MODE_KEY];
  if (!keepAuth) remove.push(AUTH_TOKEN_KEY);
  return {
    remove,
    theme: PRIVATE_THEMES.indexOf(theme) >= 0 ? FALLBACK_THEME : "",
    contentMode: contentMode(false),
  };
}

/**
 * Whether the switch may reopen private mode without asking for the passphrase again.
 *
 * True only while locked and holding an access token: the token is proof the passphrase was already
 * accepted on this device, so prompting again would be ceremony. A locked client with no token gets
 * `false` and must go through the passphrase dialog.
 */
export function canResume(authToken: string, flag: string): boolean {
  return flag !== "1" && !!authToken;
}

/**
 * What reopening writes: the flag, the content token taken from the access token already held, and
 * the debug panel — the same end state a passphrase unlock reaches.
 *
 * The content token is copied, not derived: the worker compares it to `CHAT_PASSWORD`, so any value
 * other than the access token would be rejected at the first chat.
 */
export function resumeWrites(authToken: string): Write[] {
  return [
    { key: UNLOCK_FLAG_KEY, value: "1" },
    { key: UNLOCK_TOKEN_KEY, value: authToken },
    { key: DEV_MODE_KEY, value: "1" },
  ];
}

/**
 * The chat body with `unlockToken` added, or an empty string when the body should be left alone.
 *
 * Left alone means: not a chat request, still locked, no token, a body that is not JSON text, or a
 * body that does not parse. The wrapper then sends the original bytes untouched — a malformed body is
 * the server's call to reject, not ours to rewrite.
 */
export function chatBodyWithUnlock(url: string, unlocked: boolean, token: string, body: unknown): string {
  if (url.indexOf("/api/chat") < 0) return "";
  if (!unlocked || !token) return "";
  if (typeof body !== "string") return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    return "";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) out[k] = v;
  out.unlockToken = token;
  return JSON.stringify(out);
}

export interface TapState {
  count: number;
  last: number;
}

/**
 * One tap folded into the run. A gap longer than the window starts a new run at 1, so a user who taps
 * four times in the morning and three times in the evening never opens the passphrase dialog.
 */
export function nextTap(state: TapState, now: number, windowMs: number): TapState {
  const sameRun = state.last > 0 && now - state.last <= windowMs;
  return { count: sameRun ? state.count + 1 : 1, last: now };
}

export function tapFires(state: TapState): boolean {
  return state.count >= UNLOCK_TAPS;
}
