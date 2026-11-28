/**
 * The right-side panel's mode/view machine — two modes, four views, one persisted record.
 *
 * Fixed mode is a symmetric 240 px column with two text tabs (activity / status). Expanded mode is a
 * resizable 240–1200 px column whose body is the tabbed content canvas; activity and status are
 * temporary overlays you step back out of. Nothing here draws anything: which section is visible, how
 * the bar lays itself out and where the panes live are all `tooling/l0/wiring/panel-host.js`.
 *
 * Two rules that are easy to get wrong and are therefore pure functions here:
 *   · `view` is **not** persisted. The expanded panel always comes back to the canvas; restoring the
 *     last overlay is how "I clicked activity once and now every open starts on activity" happens.
 *   · Width is clamped on both read and write, and `0` means "no opinion" rather than "zero pixels".
 *
 * Tab identity, persistence and the page catalogue moved to `services/panel/tab-state.ts`; this file
 * deliberately knows nothing about what is inside the canvas.
 * @module services/panel/panel-host
 */

export type PanelView = "canvas" | "activity" | "chat" | "status";
export type PanelTab = "fishbowl" | "chat" | "status";

/** One row of the right column's view list. */
export interface PanelViewDef {
  /** `data-pv` / `data-menu-pv`, and the value the state machine stores in `view`. */
  id: Exclude<PanelView, "canvas">;
  /** The fixed-mode tab (`data-rs-tab`) this view belongs to. */
  tab: PanelTab;
  /** User-visible label; the i18n dictionary carries the three strings. */
  label: string;
  /** Key into `ICON_PATHS` (services/ui/tools-pages.ts) — never an inline path here. */
  icon: string;
}

/**
 * Every view of the right column, in fixed-tab order. This table is the only place a view is
 * declared: the fixed strip (`#rsTabs`), the expanded bar's `data-pv` buttons and the "⋯" menu all
 * render from it, and `panelKeyOf` / `viewState` derive their view→tab mapping from it too. Adding
 * a view means one row here plus its `<section data-rs-panel>` in index.html.
 *
 * `chat` is the group-chat discussion area: multi-agent output mounts into `#fishbowlSlot` inside
 * that panel. It is permanent — it must NOT become a closable dynamic tab, because the discussion
 * content has nowhere else to render.
 */
export const PANEL_VIEWS: readonly PanelViewDef[] = [
  { id: "activity", tab: "fishbowl", label: "活动", icon: "activity" },
  { id: "chat", tab: "chat", label: "群聊", icon: "chat" },
  { id: "status", tab: "status", label: "状态", icon: "status" },
];

/** The table row for a view name, or null for `canvas` / an unknown name. */
function viewDefOf(view: unknown): PanelViewDef | null {
  for (let i = 0; i < PANEL_VIEWS.length; i++) {
    if (PANEL_VIEWS[i].id === view) return PANEL_VIEWS[i];
  }
  return null;
}

export interface PanelState {
  expanded: boolean;
  width: number;
  view: PanelView;
  tab: PanelTab;
}

export const PANEL_VERSION = 1;
export const PANEL_LS_STATE = "cfw_panel_state_v1";
export const PANEL_LS_CURRENT = "cfw_panel_current_v1";

export const PANEL_W_MIN = 240;
/** Raised from 640: at 1440 px the middle column wants ~720, so 640 stranded the drag short. */
export const PANEL_W_MAX = 1200;
export const PANEL_W_DEFAULT = 460;
export const PANEL_DESKTOP_MIN = 1024;
export const PANEL_TOPBAR_TIGHT = 560;

export const PANEL_DEFAULT_STATE: PanelState = { expanded: false, width: PANEL_W_DEFAULT, view: "canvas", tab: "fishbowl" };

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
  return name === "canvas" || viewDefOf(name) !== null;
}

/** Maps a tab's `data-rs-tab` to the stored tab, defaulting to the fishbowl (the historical name). */
export function tabFromName(name: unknown): PanelTab {
  const n = text(name);
  if (n === "chat") return "chat";
  if (n === "status") return "status";
  return "fishbowl";
}

/**
 * View name → the `data-rs-panel` key of the section that renders it. The section keys are the tab
 * names, so the mapping is the view's `tab`; `canvas` is its own section.
 */
export function panelKeyOf(view: unknown): string {
  const def = viewDefOf(view);
  return def ? def.tab : "canvas";
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
  const def = viewDefOf(name);
  const next: PanelState = { expanded: state.expanded, width: state.width, view: name, tab: state.tab };
  if (!state.expanded) next.tab = def ? def.tab : state.tab;
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

/** `HH:MM` in local time, for the "recently closed" rows. */
export function fmtClock(ts: unknown): string {
  const d = new Date(Number(ts));
  return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
}

/** `stage_call` timeout: default 15 s, clamped to 1–120 s. */
export function callTimeoutMs(raw: unknown): number {
  return Math.max(1000, Math.min(120000, parseInt(text(raw), 10) || 15000));
}
