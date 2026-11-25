/**
 * The right-side content panel's state machine — two modes, four views, one persisted record.
 *
 * Fixed mode is a symmetric 240 px column with two text tabs (activity / status). Expanded mode is a
 * resizable 240–1200 px column whose body is the content canvas; activity and status are temporary
 * overlays you step back out of. Nothing here draws anything: which section is visible, how the bar
 * lays itself out and where the iframe lives are all `l0/wiring/panel-host.js`.
 *
 * Three rules that are easy to get wrong and are therefore pure functions here:
 *   · `view` is **not** persisted. The expanded panel always comes back to the canvas; restoring the
 *     last overlay is how "I clicked activity once and now every open starts on activity" happens.
 *   · Width is clamped on both read and write, and `0` means "no opinion" rather than "zero pixels".
 *   · Built-in pages (sandbox, council) are tools, not generated content, so they never enter the
 *     recent-content history — they would push the artifacts a user wants to revisit out of the list.
 *
 * Lock: `test/panel-host.test.mjs` (state transitions dual-run against the classic implementation).
 * @module services/panel/panel-host
 */

export type PanelView = "canvas" | "activity" | "chat" | "status";
export type PanelTab = "fishbowl" | "chat" | "status";

export interface PanelState {
  expanded: boolean;
  width: number;
  view: PanelView;
  tab: PanelTab;
}

export interface PanelTool {
  id: string;
  title?: string;
  icon?: string;
  url?: string;
  chrome?: string;
}

export interface HistoryEntry {
  title: string;
  at: number;
  spec: unknown;
}

export const PANEL_VERSION = 1;
export const PANEL_LS_STATE = "cfw_panel_state_v1";
export const PANEL_LS_CURRENT = "cfw_panel_current_v1";
export const PANEL_LS_MAP_URL = "cfw_panel_map_url_v1";

export const PANEL_W_MIN = 240;
/** Raised from 640: at 1440 px the middle column wants ~720, so 640 stranded the drag short. */
export const PANEL_W_MAX = 1200;
export const PANEL_W_DEFAULT = 460;
export const PANEL_DESKTOP_MIN = 1024;
export const PANEL_HISTORY_MAX = 10;
export const PANEL_TOPBAR_TIGHT = 560;

export const PANEL_DEFAULT_STATE: PanelState = { expanded: false, width: PANEL_W_DEFAULT, view: "canvas", tab: "fishbowl" };

/** Built-in canvas pages. They are tools, not content: they never enter the history. */
export const PANEL_BUILTIN_TOOLS: PanelTool[] = [
  { id: "sandbox", title: "沙盘（幻想地图）", icon: "map", url: "/tools/sandbox/index.html?v=19", chrome: "map" },
  // The council page exists because meeting results used to go only to the main agent, leaving the UI
  // blank — the agent then wrote its own HTML page and role-played every participant in one context.
  { id: "council", title: "多智能体讨论区", icon: "users", url: "/tools/council/index.html?v=3" },
  { id: "map", title: "GEO 地图（真实地图，外部源）", icon: "globe", url: "" },
];

/** Chrome bar definitions per tool; `seg` is a segmented control, everything else a button. */
export const PANEL_CHROMES: Record<string, Array<Record<string, unknown>>> = {
  map: [
    {
      type: "seg",
      items: [
        { cmd: "skin", val: "A", text: "像素" },
        { cmd: "skin", val: "B", text: "等距" },
      ],
    },
    { cmd: "regen", text: "换世界" },
    { cmd: "run", text: "跑图", toggle: true },
  ],
};

function recOf(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) out[k] = v;
  }
  return out;
}

function text(value: unknown): string {
  return value == null ? "" : typeof value === "string" ? value : String(value);
}

/** `Math.round(w) || default` — a width of 0 means "no opinion", not "zero pixels". */
export function clampPanelWidth(w: unknown): number {
  const n = Math.round(Number(w)) || PANEL_W_DEFAULT;
  return Math.max(PANEL_W_MIN, Math.min(PANEL_W_MAX, n));
}

/**
 * Rebuilds the state from the persisted record.
 * @returns the default state when the record is missing or unparseable. `view` always resets to
 * `canvas` — see the module note on why overlays must not be remembered.
 */
export function loadPanelState(raw: unknown): PanelState {
  let o: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text(raw) || "{}");
    o = recOf(parsed);
  } catch (e) {
    return { expanded: false, width: PANEL_W_DEFAULT, view: "canvas", tab: "fishbowl" };
  }
  const width = Math.max(PANEL_W_MIN, Math.min(PANEL_W_MAX, parseInt(text(o.width), 10) || PANEL_W_DEFAULT));
  return {
    expanded: o.expanded === true,
    width: width,
    view: "canvas",
    tab: o.tab === "status" ? "status" : "fishbowl",
  };
}

export function isPanelView(name: unknown): name is PanelView {
  return name === "canvas" || name === "activity" || name === "chat" || name === "status";
}

/** Maps a tab's `data-rs-tab` to the stored tab, defaulting to the fishbowl (the historical name). */
export function tabFromName(name: unknown): PanelTab {
  const n = text(name);
  if (n === "chat") return "chat";
  if (n === "status") return "status";
  return "fishbowl";
}

/** View name → the `data-rs-panel` key of the section that renders it. */
export function panelKeyOf(view: unknown): string {
  if (view === "activity") return "fishbowl";
  if (view === "chat") return "chat";
  if (view === "status") return "status";
  return "canvas";
}

/** The section that should be visible, given the mode. */
export function activeKeyOf(state: PanelState, expanded: boolean): string {
  if (expanded) return panelKeyOf(state.view);
  if (state.tab === "status") return "status";
  if (state.tab === "chat") return "chat";
  return "fishbowl";
}

/** @returns a new state; expanding always snaps the view back to the canvas. */
export function expandedState(state: PanelState, on: unknown): PanelState {
  const next: PanelState = { expanded: !!on, width: state.width, view: state.view, tab: state.tab };
  if (next.expanded) next.view = "canvas";
  return next;
}

/**
 * Switches the view.
 * @returns the same state object when the name is not a view — callers rely on identity to skip a
 * re-render. In fixed mode the view also drives which tab is highlighted.
 */
export function viewState(state: PanelState, name: unknown): PanelState {
  if (!isPanelView(name)) return state;
  const next: PanelState = { expanded: state.expanded, width: state.width, view: name, tab: state.tab };
  if (!state.expanded) next.tab = name === "status" ? "status" : name === "chat" ? "chat" : "fishbowl";
  return next;
}

export function widthState(state: PanelState, w: unknown): PanelState {
  return { expanded: state.expanded, width: clampPanelWidth(w), view: state.view, tab: state.tab };
}

export function tabState(state: PanelState, name: unknown): PanelState {
  const tab = tabFromName(name);
  return {
    expanded: state.expanded,
    width: state.width,
    // In expanded mode the tab picks the overlay; the canvas is not reachable from a tab.
    view: state.expanded ? (tab === "status" ? "status" : "activity") : state.view,
    tab: tab,
  };
}

/** Display title for a spec: explicit title, else "页面" for a URL, else "内联内容". */
export function contentTitleOf(spec: unknown): string {
  const s = recOf(spec);
  const t = text(s.title).trim();
  if (t) return t;
  return s.url ? "页面" : "内联内容";
}

/**
 * Whether a URL belongs to a built-in tool page (compared without query string and without the
 * trailing `index.html`, so both `/tools/sandbox/` and `/tools/sandbox/index.html?v=19` match).
 */
export function isBuiltinPage(url: unknown, tools: unknown): boolean {
  const s = text(url).split("?")[0];
  if (!s) return false;
  const list = Array.isArray(tools) ? tools : [];
  for (let i = 0; i < list.length; i++) {
    const t = recOf(list[i]);
    const u = text(t.url);
    if (!u) continue;
    const b = u.split("?")[0].replace(/index\.html$/, "");
    if (s === b || s.indexOf(b) === 0) return true;
  }
  return false;
}

/**
 * Prepends a spec to the history.
 * @returns a new array, or the input array untouched when the entry is skipped (a built-in tool, or a
 * URL that belongs to one). Entries are deduplicated by title and capped at
 * {@link PANEL_HISTORY_MAX}.
 */
export function nextHistory(list: unknown, spec: unknown, at: unknown, tools: unknown): HistoryEntry[] {
  const arr = Array.isArray(list) ? list : [];
  const s = recOf(spec);
  // Skipped entries return the *same array* so the caller can tell "nothing changed" by identity.
  if (spec && s._builtin) return arr;
  if (spec && isBuiltinPage(s.url, tools)) return arr;
  const prev = arr.map((x) => {
    const e = recOf(x);
    return { title: text(e.title), at: Number(e.at) || 0, spec: e.spec };
  });
  const title = contentTitleOf(spec);
  const out = prev.filter((e) => e.title !== title);
  out.unshift({ title: title, at: typeof at === "number" ? at : Date.now(), spec: spec });
  if (out.length > PANEL_HISTORY_MAX) out.length = PANEL_HISTORY_MAX;
  return out;
}

/** `HH:MM` in local time. */
export function fmtClock(ts: unknown): string {
  const d = new Date(Number(ts));
  return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
}

/** `stage_call` timeout: default 15 s, clamped to 1–120 s. */
export function callTimeoutMs(raw: unknown): number {
  return Math.max(1000, Math.min(120000, parseInt(text(raw), 10) || 15000));
}

/** Icon markup for a tool id; unknown ids get a neutral square. */
export function toolIcon(name: unknown): string {
  if (name === "map") {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4L3.5 6v14L9 18l6 2 5.5-2V4L15 6 9 4z"/><path d="M9 4v14M15 6v14"/></svg>';
  }
  if (name === "globe") {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.2"/><path d="M3.8 12h16.4M12 3.8c2.2 2.3 3.3 5.1 3.3 8.2s-1.1 5.9-3.3 8.2c-2.2-2.3-3.3-5.1-3.3-8.2s1.1-5.9 3.3-8.2z"/></svg>';
  }
  if (name === "users") {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8.2" r="3.2"/><path d="M3.4 19c0-3.1 2.5-5.2 5.6-5.2s5.6 2.1 5.6 5.2"/><circle cx="16.8" cy="9.4" r="2.4"/><path d="M15.6 13.6c2.6 0 4.8 1.7 4.8 4.4"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/></svg>';
}

/** The "GEO map not connected" guide page, shown when the external map URL is unset. */
export function geoGuideHtml(): string {
  return '<div style="margin:0;padding:20px 18px;font:12.5px/1.75 system-ui,\'Microsoft YaHei\',sans-serif;color:#c9d3de">' +
    '<div style="font-size:13px;font-weight:600;color:#eaf2fa;margin-bottom:6px">GEO 地图未连接</div>' +
    '<div style="color:#8595a6;margin-bottom:14px">这里是 GEO-Agent 提供的真实地图（OSM/卫星），属于外部源，需要先把 GEO-Agent 跑起来。</div>' +
    '<div style="color:#8595a6;margin-bottom:6px">1. 启动 GEO-Agent（它的启动器会拉起 8795 / 8796）</div>' +
    '<div style="color:#8595a6;margin-bottom:6px">2. 在控制台执行一次（只需一次）：</div>' +
    '<pre style="margin:0 0 12px;padding:9px 11px;background:#111820;border:1px solid #243040;border-radius:8px;' +
    'font:11px/1.6 ui-monospace,Consolas,monospace;color:#9fc0e0;overflow:auto;white-space:pre-wrap">' +
    "localStorage.setItem('cfw_panel_map_url_v1', 'http://127.0.0.1:8796/map-viewer/')</pre>" +
    '<div style="color:#6f8194;font-size:11px">配置后重新点这个图标。沙盘不需要这一步，随时可开。</div>' +
    '</div>';
}
