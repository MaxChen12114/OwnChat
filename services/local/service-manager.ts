/**
 * Local service manager: the settings card that lists the services bundled with the desktop shell
 * (state dot, name, port, description, "start on launch", start/stop).
 *
 * Every entry point is pure. The shell probe, the invoke port, the status line, the mount and the
 * poll timer live in the wiring, because none of them exist in a browser tab — this card only ever
 * appears in the desktop app.
 *
 * Row markup is generated here rather than in the wiring so the four states (running / stopped,
 * available / unavailable) stay testable without a DOM. The reason line is gated on `available`
 * alone, not on `running`: the shell's availability verdict is the only thing the reason explains.
 * @module services/local/service-manager
 */

/** Poll interval for the card while the window is visible; the shell is the source of truth. */
export const SVC_POLL_MS = 10000;

/** One service as the shell reports it, with every field narrowed to the type the markup needs. */
export interface SvcEntry {
  /** Stable id used by the invoke commands and the `data-id` attributes. */
  id: string;
  /** Display name. */
  name: string;
  /** One-line description, shown under the name. */
  desc: string;
  /** Listening port, rendered as `:port`; empty when the shell does not report one. */
  port: string;
  /** Process is up now. */
  running: boolean;
  /** Shell can start it (binary present, port free); false disables the start button. */
  available: boolean;
  /** "Start on launch" checkbox state. */
  enabled: boolean;
  /** Why it is unavailable, shown only when `available` is false. */
  reason: string;
}

/** What one click should invoke: the command, its argument object and the status line to show. */
export interface SvcActPlan {
  /** Tauri command name. */
  command: string;
  /** Argument object handed to the command as-is. */
  args: Record<string, string | boolean>;
  /** Status line to print before the call (empty = say nothing). */
  status: string;
}

/** Read-side bridge from unknown to a plain record; arrays and scalars yield an empty one. */
function recOf(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

function arrOf(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** String form of a field, matching the escaping helper's own `null`/`undefined` handling. */
function strOf(v: unknown): string {
  return v == null ? "" : String(v);
}

/** HTML-escape the five characters that can break out of an attribute or a text node. */
export function svcEsc(v: unknown): string {
  return strOf(v).replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

/**
 * Narrow one shell record. Truthiness is kept as-is rather than compared to `true`: the shell
 * serializes booleans today, and a stricter read would silently flip a future `1` to "stopped".
 */
export function svcEntryOf(raw: unknown): SvcEntry {
  const r = recOf(raw);
  return {
    id: strOf(r.id),
    name: strOf(r.name),
    desc: strOf(r.desc),
    port: strOf(r.port),
    running: !!r.running,
    available: !!r.available,
    enabled: !!r.enabled,
    reason: strOf(r.reason),
  };
}

/**
 * One row: state dot, name, port, description, "start on launch" checkbox and the start/stop button.
 *
 * @returns HTML for a single service row; unknown fields render as empty strings, never as
 *   `undefined`.
 */
export function svcRowHtml(raw: unknown): string {
  const s = svcEntryOf(raw);
  const dot = s.running ? "●" : "○";
  const color = s.running ? "#3fb950" : "rgba(127,127,127,.55)";
  const reason = (!s.available && s.reason)
    ? '<div style="font-size:11px;color:var(--danger,#e8607d);margin-top:2px;">' + svcEsc(s.reason) + "</div>"
    : "";
  return '<div class="rowline" data-svc="' + svcEsc(s.id) + '" style="align-items:center;gap:8px;padding:8px 0;border-top:1px solid rgba(127,127,127,.12);">'
    + '<div style="flex:1;min-width:0;">'
    + '<div style="font-size:12.5px;"><span style="color:' + color + '">' + dot + "</span> <b>" + svcEsc(s.name) + "</b>"
    + '<span style="opacity:.55;font-size:11px;"> · :' + svcEsc(s.port) + "</span></div>"
    + '<div style="font-size:11px;opacity:.6;">' + svcEsc(s.desc) + "</div>"
    + reason
    + "</div>"
    + '<div class="btns" style="flex:none;align-items:center;gap:8px;">'
    + '<label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;opacity:.75;" title="启用后随 App 启动">'
    + '<input type="checkbox" data-act="enable" data-id="' + svcEsc(s.id) + '"' + (s.enabled ? " checked" : "") + ">随 App 启动</label>"
    + (s.running
      ? '<button class="smallbtn" data-act="stop" data-id="' + svcEsc(s.id) + '">停止</button>'
      : '<button class="smallbtn" data-act="start" data-id="' + svcEsc(s.id) + '"' + (s.available ? "" : " disabled") + ">启动</button>")
    + "</div></div>";
}

/**
 * @returns the rows joined in the order the shell reported them, or `""` when the list is empty or
 *   not an array (the card then shows no rows rather than a broken one).
 */
export function svcListHtml(raw: unknown): string {
  const list = arrOf(raw);
  return list.length ? list.map(svcRowHtml).join("") : "";
}

/** The card skeleton; the list box, refresh button and status line are filled in by the wiring. */
export function svcCardHtml(): string {
  return "<h4>本地服务</h4>"
    + "<p>随 App 打包的本机服务：勾选「随 App 启动」的会在打开 App 时自动运行，退出 App 时统一关闭。</p>"
    + '<div id="svcListBox" style="margin-top:4px;"></div>'
    + '<div class="btns" style="margin-top:10px;"><button class="smallbtn" id="svcRefreshBtn">刷新状态</button></div>'
    + '<div id="svcStatusLine" style="font-size:11.5px;margin-top:8px;min-height:16px;"></div>';
}

/**
 * Map one row interaction to the shell command it should run.
 *
 * @param enabled Checkbox state for `enable`; ignored by the other actions, and coerced to a real
 *   boolean because the shell command takes a bool, not a DOM value.
 * @returns The plan, or `null` for an unknown action (the caller then does nothing but refresh).
 */
export function svcActPlan(action: unknown, id: unknown, enabled: unknown): SvcActPlan | null {
  const sid = strOf(id);
  if (action === "start") return { command: "svc_start", args: { id: sid }, status: "正在启动…" };
  if (action === "stop") return { command: "svc_stop", args: { id: sid }, status: "正在停止…" };
  if (action === "enable") return { command: "svc_set_enabled", args: { id: sid, enabled: !!enabled }, status: "" };
  return null;
}

/** Read one property off an unknown value without an assertion; `message` on `Error` is not enumerable. */
function fieldOf(v: unknown, k: string): unknown {
  if (!v || typeof v !== "object" || !(k in v)) return undefined;
  return Reflect.get(v, k);
}

/**
 * Build a status line from a failure.
 *
 * @param prefix Caller-owned sentence such as the list-read prefix; kept here only so both call
 *   sites render identically.
 * @returns `prefix` plus the error message when the rejection carries one, else the value itself —
 *   a rejected string prints verbatim; `String()` keeps a `null`/`undefined` rejection visible as
 *   such instead of collapsing it to an empty tail.
 */
export function svcErrorText(prefix: string, err: unknown): string {
  return prefix + String(fieldOf(err, "message") || err);
}
