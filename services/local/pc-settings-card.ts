/**
 * The "remote PC" card that sits under the agent category in Settings: card markup, placement, the
 * status line fed by `/api/pc/health` + `/api/pc/status`, the failure copy, and the three toggle
 * plans (allow the agent, skip the confirm card, store the bridge token).
 *
 * Everything decidable without a browser is here. localStorage reads, `fetch`, the shell probe and
 * every listener stay in `tooling/l0/wiring/pc-settings-card.js`, which also owns the card's outer element
 * and its insertion.
 *
 * The status line is built from health *and* an optional status payload because the second call is
 * allowed to fail on its own: a bridge that answers health but not status still gets a usable line,
 * so the caller swallows that failure and passes `null`. Health alone is not optional — a body that
 * is not an object yields `null` and the caller reports a read failure, where the old code let a
 * TypeError escape into the line.
 * @module services/local/pc-settings-card
 */

/** Desk front end used when the user has not overridden it in storage. */
const PC_DEFAULT_DESK = "https://desk.your-domain.example";

/** Colour family of the status line; anything but "bad" / "good" renders muted. */
export type PcStatusTone = "bad" | "good" | "";

/** Status line content: the text itself plus the tone it should be painted in. */
export interface PcStatusLine {
  text: string;
  tone: PcStatusTone;
}

/** Where the card belongs, or that the current mount is already correct. */
export type PcMountTarget = "agent" | "footer" | "settings" | "skip";

/** What the mount needs to know about the settings tree; booleans only, no DOM in this module. */
export interface PcMountInput {
  /** `.set-cat[data-cat="agent"]` was found. */
  hasAgentCat: boolean;
  /** A card is already a direct child of that category, so re-mounting would only churn nodes. */
  cardInAgentCat: boolean;
  /** `#settingsFooter` exists and is a direct child of `#settings`. */
  footerInSettings: boolean;
}

/** A request ready for `fetch`; the URL prefix and the method/header rules are decided here. */
export interface PcApiRequest {
  url: string;
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  };
}

/** The only two fields the card ever sets on a call. */
export interface PcApiOptions {
  method?: string;
  /** Presence means "POST with a JSON body" (even `null`); absence means "GET". */
  body?: unknown;
}

/** Storage write the caller should perform, plus the line to show right after. */
export interface PcTogglePlan {
  value: string;
  status: PcStatusLine;
}

/** Bridge-token plan: either store the trimmed value or clear the key. */
export interface PcBridgePlan {
  value: string;
  remove: boolean;
  status: PcStatusLine;
}

function recOf(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

/** String form for fields that must not print `null`/`undefined` (storage reads, escapes). */
function strOf(v: unknown): string {
  return v == null ? "" : String(v);
}

/** Read a possibly non-enumerable string field (`Error.message` is not in `Object.entries`). */
function fieldOf(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Status text of a thrown value, matching the old `String(e && e.message || e)`. */
function messageOf(err: unknown): string {
  if (err && typeof err === "object") {
    const m = fieldOf(Reflect.get(err, "message"));
    if (m) return m;
  }
  return strOf(err);
}

/** CSS colour for a tone. The literal fallbacks cover cached pages from before the tokens existed. */
export function pcStatusColor(tone: PcStatusTone): string {
  return tone === "bad" ? "var(--danger, #e57373)" : tone === "good" ? "var(--ok, #58c78a)" : "var(--muted)";
}

/** Desk URL from storage, falling back to {@link PC_DEFAULT_DESK} on empty or unreadable storage. */
export function pcDeskUrl(stored: unknown): string {
  return strOf(stored) || PC_DEFAULT_DESK;
}

/**
 * Unlock token: the private-mode token wins over the general auth token.
 *
 * @returns the stored token, or `""` when neither key holds one.
 */
export function pcToken(unlock: unknown, auth: unknown): string {
  return strOf(unlock) || strOf(auth) || "";
}

/**
 * Build the `fetch` call for `/api/pc<op>`.
 *
 * `content-type` is only added when a body is present, and the body is serialised here so the
 * caller never has to remember the shape.
 *
 * @param token bearer token from {@link pcToken}; the header is always sent, even when empty.
 */
export function pcApiRequest(op: string, opts: PcApiOptions, token: string): PcApiRequest {
  const headers: Record<string, string> = { authorization: "Bearer " + token };
  const init: PcApiRequest["init"] = {
    method: strOf(opts.method) || (opts.body !== undefined ? "POST" : "GET"),
    headers,
  };
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  return { url: "/api/pc" + op, init };
}

/**
 * Message for a failed response: the worker's `error` field when it carries one, else `HTTP <n>`.
 *
 * The result is thrown as the `Error` message and matched again by {@link pcStatusFailure}, so the
 * status code has to survive here for the 401/503/502 copy to fire.
 */
export function pcApiErrorText(httpStatus: number, payload: unknown): string {
  const err = recOf(payload).error;
  return err ? strOf(err) : "HTTP " + httpStatus;
}

/**
 * Status line for a successful refresh.
 *
 * @param health parsed `/health` body; a non-object means the bridge answered with something
 *   unusable and yields `null` so the caller can report a read failure.
 * @param status parsed `/status` body, or `null` when that call failed — the health bits still stand.
 * @returns the ` · `-joined line, or `null` when `health` is not an object.
 */
export function pcHealthBits(health: unknown, status: unknown): string | null {
  if (!health || typeof health !== "object" || Array.isArray(health)) return null;
  const h = recOf(health);
  const bits = ["在线"];
  if (h.readonly) bits.push("只读");
  if (h.panic) bits.push("已急停");
  bits.push("TTL " + String(h.ttlMin) + " 分钟");

  const s = recOf(status);
  if (s.screen) {
    const sc = recOf(s.screen);
    bits.push((s.locked ? "锁屏" : "未锁屏") + " · " + String(sc.width) + "x" + String(sc.height));
  }
  const fg = recOf(s.foreground);
  if (fg.title) bits.push("前台 " + String(fg.process) + " — " + String(fg.title));

  return bits.join(" · ");
}

/**
 * Map a thrown refresh error to the line the card shows. Order matters: 401 and 503 have their own
 * remedies, and only then does the tunnel case claim the 502 family.
 */
export function pcStatusFailure(err: unknown): PcStatusLine {
  const m = messageOf(err);
  if (/401/.test(m)) return { text: "未解锁或 token 失效（退出私密模式再重新解锁）", tone: "bad" };
  if (/503/.test(m)) return { text: "Worker 还没配 PC_* secrets（见 remote-desk/worker/worker.patch.md）", tone: "bad" };
  if (/502|隧道/.test(m)) return { text: "PC 隧道不可达：检查电脑上的 cloudflared 与 pc-bridge", tone: "bad" };
  return { text: "状态读取失败：" + m, tone: "bad" };
}

/**
 * Placement decision for one mount pass.
 *
 * A card already parented under the agent category means the mount is a no-op — the caller must not
 * remove it first, or every call would rebuild the card and drop the status line.
 */
export function pcMountTarget(input: PcMountInput): PcMountTarget {
  if (input.cardInAgentCat) return "skip";
  if (input.hasAgentCat) return "agent";
  if (input.footerInSettings) return "footer";
  return "settings";
}

/**
 * Card markup, minus the outer `.card` element the caller creates.
 *
 * @param isTauri renders the desktop-only bridge-token row; the shell is probed on every mount, so a
 *   tab that gains the shell later still gets the row.
 */
export function pcCardHtml(isTauri: boolean): string {
  return '<h4>远程电脑</h4>' +
    '<p>私密模式下，让 agent 用手机操作这台电脑（屏幕 / 控件树 / 键鼠 / 剪贴板）。' +
    '需要电脑上 <code>pc-bridge</code> 与 <code>cloudflared</code> 在跑；' +
    '远程桌面另走 Cloudflare Access 邮箱验证码。</p>' +
    '<div class="rowline">' +
    '  <div class="toggle"><input type="checkbox" id="pcRemoteEnable"><label for="pcRemoteEnable">允许 agent 操作</label></div>' +
    '  <div class="toggle"><input type="checkbox" id="pcSkipConfirm"><label for="pcSkipConfirm">操作免确认</label></div>' +
    '  <div class="btns">' +
    '    <button class="smallbtn" id="pcRemoteRefresh" type="button">刷新状态</button>' +
    '    <button class="smallbtn" id="pcRemoteDesk" type="button">打开远程桌面</button>' +
    '    <button class="smallbtn danger" id="pcRemotePanic" type="button">断开</button>' +
    '  </div>' +
    '</div>' +
    '<div id="pcRemoteStatus" style="font-size:11px;color:var(--muted);margin-top:8px;"></div>' +
    (isTauri ?
      '<div style="margin-top:10px;font-size:11.5px;color:var(--muted);line-height:1.5;">' +
      '桌面端直连：粘贴本机 <code>remote-desk/.pc-token</code> 的内容后，agent 工具优先直连 <code>127.0.0.1:8802</code>' +
      '（不经隧道；不填则走 Worker 通道）。' +
      '<div class="rowline" style="margin-top:6px;">' +
      '  <input type="password" id="pcBridgeTokenInput" placeholder="bridge token（.pc-token 内容）" style="flex:1;min-width:0;font:inherit;font-size:12px;padding:6px 8px;border:1px solid var(--border,rgba(127,127,127,.3));border-radius:8px;background:transparent;color:inherit;">' +
      '  <button class="smallbtn" id="pcBridgeTokenSave" type="button">保存</button>' +
      '</div></div>' : '');
}

/** Storage value plus line for the "allow the agent" checkbox. */
export function pcEnablePlan(checked: boolean): PcTogglePlan {
  return checked
    ? { value: "1", status: { text: "已允许 agent 操作（下一条消息生效）", tone: "good" } }
    : { value: "0", status: { text: "已禁止 agent 操作", tone: "" } };
}

/**
 * Storage value plus line for the "skip the confirm card" checkbox.
 *
 * The tones are lopsided on purpose: enabling the shortcut stays muted, restoring the permission
 * prompt is the state worth confirming in green.
 */
export function pcSkipPlan(checked: boolean): PcTogglePlan {
  return checked
    ? { value: "1", status: { text: "已免确认：远程电脑工具直接执行，不再弹放行卡", tone: "" } }
    : { value: "0", status: { text: "已恢复确认：远程电脑工具执行前会弹放行卡", tone: "good" } };
}

/** Whether the "open desktop" button stays: hidden only on an explicit stored `"0"`. */
export function pcDeskVisible(stored: unknown): boolean {
  return strOf(stored) !== "0";
}

/** Bridge-token save: trim, then either store or clear. Empty input is the clear path. */
export function pcBridgePlan(raw: unknown): PcBridgePlan {
  const value = strOf(raw).trim();
  return value
    ? { value, remove: false, status: { text: "已保存 bridge token（agent 工具将直连本机 bridge）", tone: "good" } }
    : { value: "", remove: true, status: { text: "已清空（走 Worker 通道）", tone: "" } };
}
