/**
 * The right-column tab state machine: which tabs exist, which one is active, what each tab is
 * allowed to mount, and the versioned record that survives a reload.
 *
 * A tab is identified by what it will show, never by its position: catalog-backed pages use
 * `p:<pageId>`, ad-hoc URLs use `u:<normalised url>`, and inline html/text stays session-only
 * (`t:<seq>`). Identity is what makes `stage_open` idempotent — the second call focuses the tab the
 * first one created instead of stacking a duplicate.
 *
 * Three rules that are easy to get wrong and therefore live here as pure functions:
 *   · Page resolution happens at mount time, not open time. The sandbox tab stores `pageId:
 *     "sandbox"`; a changed `cfw_panel_sandbox_url_v1` must take effect on the next activation, and
 *     a removed catalog entry must not resurrect a dead tab after a reload.
 *   · Inline html is never persisted. Its whole payload is untrusted agent output; persisting it
 *     turns `localStorage` into an agent-writable content store that reloads executable frames.
 *   · Closing is the only operation that feeds "recently closed", and only for reopenable content —
 *     a closed inline page has no source to rebuild from.
 *
 * Lock: `test/tab-state.test.mjs` (open/close/activate, dedupe, persistence and migration, host
 * pages, the live-frame cap). The DOM half lives in `tooling/l0/wiring/panel-host.js`.
 * @module services/panel/tab-state
 */

export const PANEL_TABS_VERSION = 1;
export const PANEL_LS_TABS = "cfw_panel_tabs_v1";
/** Hard ceiling on tabs; opening past it drops the oldest inactive, non-keepAlive tab record. */
export const PANEL_TAB_MAX = 12;
/** Live iframes (active + background) before the oldest background tab is torn down. */
export const PANEL_TAB_LIVE_MAX = 5;
/** How many recently closed tabs the "+" menu remembers. */
export const PANEL_TAB_CLOSED_MAX = 8;
export const PANEL_MAP_URL_KEY = "cfw_panel_map_url_v1";
/** What a page can put in a pane. `html` is only ever rendered by the host-html sandbox tier. */
export interface PanelPageSpec {
  url?: string;
  html?: string;
  text?: string;
  mode?: string;
  chrome?: string;
}

/**
 * One mountable page. Catalog records and host-owned pages (sandbox, GEO) share this shape so the
 * tab machine never needs to know which list a page came from.
 */
export interface PanelPage {
  id: string;
  label: string;
  icon?: string;
  href?: string;
  chrome?: string;
  singleton?: boolean;
  keepAlive?: boolean;
  spec?: PanelPageSpec;
}

export interface PanelTab {
  id: string;
  /** Empty for ad-hoc URL tabs and inline content. */
  pageId: string;
  title: string;
  icon: string;
  /** Resolved payload at open time; page-backed tabs re-resolve through {@link contentOf}. */
  url: string;
  mode: string;
  chrome: string;
  html: string;
  text: string;
  /** Inline content: never persisted, never listed in "recently closed". */
  transient: boolean;
  keepAlive: boolean;
  createdAt: number;
}

export interface ClosedTab {
  pageId: string;
  url: string;
  title: string;
  icon: string;
  at: number;
}

export interface TabSet {
  version: number;
  tabs: PanelTab[];
  activeId: string;
  closed: ClosedTab[];
}

export interface TabContent {
  url: string;
  html: string;
  text: string;
  mode: string;
  chrome: string;
  title: string;
}

/** Options carried by every mutation: the host injects clock, origin and a sequence seed. */
export interface TabOptions {
  now?: unknown;
  origin?: unknown;
  seq?: unknown;
}

export interface TabSetOptions {
  now?: unknown;
  origin?: unknown;
}

function recOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  return out;
}

function arrOf(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  const out: unknown[] = [];
  for (let i = 0; i < value.length; i++) out.push(value[i]);
  return out;
}

function text(value: unknown): string {
  return value == null ? "" : typeof value === "string" ? value : String(value);
}

function num(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Strip the origin, the fragment, a trailing `index.html` and a trailing slash; keep the query. */
function normalizeHref(raw: unknown, origin?: unknown): string {
  let s = text(raw).trim();
  if (!s) return "";
  const o = text(origin).trim().replace(/\/+$/, "");
  if (o && s.toLowerCase().indexOf(o.toLowerCase()) === 0) s = s.slice(o.length) || "/";
  const hash = s.indexOf("#");
  if (hash >= 0) s = s.slice(0, hash);
  const q = s.indexOf("?");
  const query = q >= 0 ? s.slice(q) : "";
  if (q >= 0) s = s.slice(0, q);
  s = s.replace(/\/index\.html$/i, "/");
  if (s.length > 1 && s.charAt(s.length - 1) === "/") s = s.slice(0, -1);
  return (s || "/") + query;
}

/** `normalizeHref` without the query: page identity must not depend on a cache-buster. */
function basePathOf(raw: unknown, origin?: unknown): string {
  const s = normalizeHref(raw, origin);
  const q = s.indexOf("?");
  return q >= 0 ? s.slice(0, q) : s;
}

function findPage(rawUrl: unknown, pages: unknown, origin?: unknown): PanelPage | null {
  const target = basePathOf(rawUrl, origin);
  if (!target) return null;
  const list = arrOf(pages);
  for (let i = 0; i < list.length; i++) {
    const page = pageOf(list[i]);
    if (page === null) continue;
    const base = basePathOf(page.href, origin);
    if (!base) continue;
    if (target === base || target.indexOf(base + "/") === 0) return page;
  }
  return null;
}

function findPageById(id: unknown, pages: unknown): PanelPage | null {
  const want = text(id).trim();
  if (!want) return null;
  const list = arrOf(pages);
  for (let i = 0; i < list.length; i++) {
    const page = pageOf(list[i]);
    if (page !== null && page.id === want) return page;
  }
  return null;
}

/** Coerce one page record; `null` when it has no usable id (one bad record must not kill the list). */
function pageOf(value: unknown): PanelPage | null {
  const rec = recOf(value);
  if (rec === null) return null;
  const id = text(rec["id"]).trim();
  if (!id) return null;
  const specRec = recOf(rec["spec"]);
  const spec: PanelPageSpec = {};
  if (specRec !== null) {
    if (specRec["url"] != null) spec.url = text(specRec["url"]);
    if (specRec["html"] != null) spec.html = text(specRec["html"]);
    if (specRec["text"] != null) spec.text = text(specRec["text"]);
    if (specRec["mode"] != null) spec.mode = text(specRec["mode"]);
    if (specRec["chrome"] != null) spec.chrome = text(specRec["chrome"]);
  }
  return {
    id: id,
    label: text(rec["label"]) || id,
    icon: text(rec["icon"]),
    href: text(rec["href"]),
    chrome: text(rec["chrome"]),
    singleton: rec["singleton"] !== false,
    keepAlive: rec["keepAlive"] === true,
    spec: spec,
  };
}

/** The payload a page resolves to right now (settings-backed URLs are read by the caller). */
function pageSpecOf(page: PanelPage): PanelPageSpec {
  const spec = page.spec || {};
  const url = text(spec.url) || text(page.href);
  const html = text(spec.html);
  const textValue = text(spec.text);
  let mode = text(spec.mode);
  if (!mode) mode = url ? "trusted" : html ? "host-html" : "trusted";
  return { url: url, html: html, text: textValue, mode: mode, chrome: text(spec.chrome) || text(page.chrome) };
}

function emptyContent(): TabContent {
  return { url: "", html: "", text: "", mode: "trusted", chrome: "", title: "" };
}

/**
 * What a tab should show right now.
 * @returns a page-backed tab's current page payload (a changed sandbox URL takes effect here), or
 * the tab's own stored payload for URL/inline tabs. Unknown page ids fall back to the stored
 * payload rather than throwing: a catalog removed between reload and activation must not blank the
 * whole canvas.
 */
function contentOf(tab: unknown, pages: unknown): TabContent {
  const rec = recOf(tab);
  if (rec === null) return emptyContent();
  const pageId = text(rec["pageId"]);
  const page = pageId ? findPageById(pageId, pages) : null;
  if (page !== null) {
    const ps = pageSpecOf(page);
    return {
      url: ps.url || "",
      html: ps.html || "",
      text: ps.text || "",
      mode: ps.mode || text(rec["mode"]),
      chrome: ps.chrome || text(rec["chrome"]),
      title: page.label || text(rec["title"]),
    };
  }
  return {
    url: text(rec["url"]),
    html: text(rec["html"]),
    text: text(rec["text"]),
    mode: text(rec["mode"]) || "trusted",
    chrome: text(rec["chrome"]),
    title: text(rec["title"]),
  };
}

function emptyTabs(): TabSet {
  return { version: PANEL_TABS_VERSION, tabs: [], activeId: "", closed: [] };
}

/** True for a set this module produced (version + the three fields). Keeps identity on no-ops. */
function isTabSet(value: unknown): value is TabSet {
  const rec = recOf(value);
  if (rec === null) return false;
  return rec["version"] === PANEL_TABS_VERSION &&
    Array.isArray(rec["tabs"]) &&
    typeof rec["activeId"] === "string" &&
    Array.isArray(rec["closed"]);
}

/** Accepts anything and returns a structurally valid TabSet (the host's own record is guarded). */
function normalizeSet(state: unknown): TabSet {
  if (isTabSet(state)) return state;
  const rec = recOf(state);
  if (rec === null) return emptyTabs();
  const tabs: PanelTab[] = [];
  const list = arrOf(rec["tabs"]);
  for (let i = 0; i < list.length; i++) {
    const tab = tabOf(list[i]);
    if (tab !== null) tabs.push(tab);
  }
  const closed: ClosedTab[] = [];
  const closedList = arrOf(rec["closed"]);
  for (let i = 0; i < closedList.length; i++) {
    const c = recOf(closedList[i]);
    if (c === null) continue;
    closed.push({
      pageId: text(c["pageId"]),
      url: text(c["url"]),
      title: text(c["title"]),
      icon: text(c["icon"]),
      at: num(c["at"], 0),
    });
  }
  const activeId = text(rec["activeId"]);
  return {
    version: PANEL_TABS_VERSION,
    tabs: tabs,
    activeId: tabs.some((t) => t.id === activeId) ? activeId : tabs.length ? tabs[0].id : "",
    closed: closed,
  };
}

function tabOf(value: unknown): PanelTab | null {
  const rec = recOf(value);
  if (rec === null) return null;
  const id = text(rec["id"]);
  if (!id) return null;
  return {
    id: id,
    pageId: text(rec["pageId"]),
    title: text(rec["title"]) || "内容",
    icon: text(rec["icon"]),
    url: text(rec["url"]),
    mode: text(rec["mode"]),
    chrome: text(rec["chrome"]),
    html: text(rec["html"]),
    text: text(rec["text"]),
    transient: rec["transient"] === true,
    keepAlive: rec["keepAlive"] === true,
    createdAt: num(rec["createdAt"], 0),
  };
}

/** Public read of one tab record; `null` when absent. */
function tabById(state: unknown, id: unknown): PanelTab | null {
  const want = text(id).trim();
  if (!want) return null;
  const s = normalizeSet(state);
  for (let i = 0; i < s.tabs.length; i++) if (s.tabs[i].id === want) return s.tabs[i];
  return null;
}

function activeTabOf(state: unknown): PanelTab | null {
  const s = normalizeSet(state);
  return tabById(s, s.activeId);
}

/** The dedupe key for a request: page identity first, then normalised URL, then empty (inline). */
function tabKeyOf(request: unknown, pages: unknown, origin?: unknown): string {
  const req = recOf(request) || {};
  const wanted = text(req["pageId"] || req["page"]).trim();
  const page = wanted ? findPageById(wanted, pages) : findPage(req["url"], pages, origin);
  if (page !== null) return "p:" + page.id;
  const url = text(req["url"]).trim();
  return url ? "u:" + normalizeHref(url, origin) : "";
}

function focus(s: TabSet, id: string): TabSet {
  if (s.activeId === id) return s;
  return { version: s.version, tabs: s.tabs, activeId: id, closed: s.closed };
}

function lastSegment(url: string): string {
  const base = basePathOf(url);
  const parts = base.split("/");
  for (let i = parts.length - 1; i >= 0; i--) if (parts[i]) return parts[i];
  return "";
}

/**
 * Opens (or focuses) a tab.
 *
 * @param state - The current set; garbage is normalised, never thrown on.
 * @param request - `{ pageId | page, url, html, text, title, mode, chrome }`; all fields untrusted.
 * @param pages - Catalog + host pages in resolution order (host pages win on id collisions).
 * @param options - `now` (clock), `origin` (same-origin prefix to strip), `seq` (id salt).
 * @returns a new set with the tab active. Identity is preserved only when the same tab was already
 * active — callers use that to skip a re-render. An empty request returns the input unchanged.
 */
function openTab(state: TabSet, request: unknown, pages: unknown, options?: TabOptions): TabSet {
  const s = normalizeSet(state);
  const opts = options || {};
  const origin = text(opts.origin);
  const now = num(opts.now, Date.now());
  const seq = num(opts.seq, s.tabs.length + 1);

  const req = recOf(request) || {};
  const wantedId = text(req["pageId"] || req["page"]).trim();
  const urlReq = text(req["url"]).trim();
  const htmlReq = text(req["html"]);
  const textReq = text(req["text"]);
  if (!wantedId && !urlReq && htmlReq === "" && textReq === "") return s;

  let page = wantedId ? findPageById(wantedId, pages) : null;
  if (page === null && urlReq) page = findPage(urlReq, pages, origin);
  // An unknown page id with no payload would create a tab that can never mount: refuse it rather
  // than leaving a dead strip entry. With a payload the id still pins identity (late catalogue).
  if (wantedId && page === null && !urlReq && htmlReq === "" && textReq === "") return s;
  const pageId = page !== null ? page.id : wantedId;
  const singleton = page !== null ? page.singleton !== false : true;
  const url = page !== null ? pageSpecOf(page).url || "" : urlReq;
  const key = pageId ? "p:" + pageId : url ? "u:" + normalizeHref(url, origin) : "";

  if (key && singleton) {
    const found = s.tabs.filter((t) => t.id === key)[0];
    if (found) return focus(s, found.id);
  }

  const html = page !== null ? pageSpecOf(page).html || "" : htmlReq;
  const rawText = page !== null ? pageSpecOf(page).text || "" : textReq;
  const transient = !pageId && !url;
  const id = key ? (singleton ? key : key + ":" + now.toString(36) + "-" + seq) : "t:" + now.toString(36) + "-" + seq;
  const title = text(req["title"]).trim() ||
    (page !== null ? page.label : "") ||
    (url ? lastSegment(url) || "页面" : "内联内容");
  const mode = text(req["mode"]) || (page !== null ? pageSpecOf(page).mode || "" : "") ||
    (html ? "host-html" : url ? "trusted" : "trusted");

  const tab: PanelTab = {
    id: id,
    pageId: pageId,
    title: title,
    icon: page !== null ? page.icon || "" : "",
    url: url,
    mode: mode,
    chrome: text(req["chrome"]) || (page !== null ? pageSpecOf(page).chrome || "" : ""),
    html: html,
    text: rawText,
    transient: transient,
    keepAlive: page !== null ? page.keepAlive === true : false,
    createdAt: now,
  };

  let tabs = s.tabs.concat([tab]);
  if (tabs.length > PANEL_TAB_MAX) {
    const victim = tabs.filter((t) => t.id !== id && !t.keepAlive && t.id !== s.activeId)[0];
    if (victim) tabs = tabs.filter((t) => t.id !== victim.id);
    if (tabs.length > PANEL_TAB_MAX) tabs = tabs.slice(tabs.length - PANEL_TAB_MAX);
  }
  return { version: s.version, tabs: tabs, activeId: id, closed: s.closed };
}

/** Switches the active tab; unknown ids and the current id return the input unchanged. */
function activateTab(state: unknown, id: unknown): TabSet {
  const s = normalizeSet(state);
  const want = text(id).trim();
  if (!want || !s.tabs.some((t) => t.id === want)) return s;
  return focus(s, want);
}

/**
 * Closes a tab.
 * @returns a new set. When the active tab closes, its right neighbour takes over, else its left
 * neighbour, else the set becomes empty (`activeId: ""`). Inline tabs are not remembered in
 * "recently closed" — there is no source to rebuild them from.
 */
function closeTab(state: unknown, id: unknown, options?: TabOptions): TabSet {
  const s = normalizeSet(state);
  const want = text(id).trim();
  const idx = s.tabs.findIndex((t) => t.id === want);
  if (idx < 0) return s;
  const tab = s.tabs[idx];
  const tabs = s.tabs.slice(0, idx).concat(s.tabs.slice(idx + 1));
  let activeId = s.activeId;
  if (activeId === tab.id) {
    const next = tabs[idx] || tabs[idx - 1] || null;
    activeId = next ? next.id : "";
  }
  let closed = s.closed;
  if (!tab.transient && (tab.pageId || tab.url)) {
    const identity = tab.pageId || tab.url;
    const at = num(options && options.now, Date.now());
    const kept = closed.filter((c) => (c.pageId || c.url) !== identity);
    closed = [{ pageId: tab.pageId, url: tab.url, title: tab.title, icon: tab.icon, at: at }].concat(kept);
    if (closed.length > PANEL_TAB_CLOSED_MAX) closed = closed.slice(0, PANEL_TAB_CLOSED_MAX);
  }
  return { version: s.version, tabs: tabs, activeId: activeId, closed: closed };
}

/** Drops one "recently closed" entry (after reopening it). */
function forgetClosed(state: unknown, identity: unknown): TabSet {
  const s = normalizeSet(state);
  const want = text(identity);
  const closed = s.closed.filter((c) => (c.pageId || c.url) !== want);
  if (closed.length === s.closed.length) return s;
  return { version: s.version, tabs: s.tabs, activeId: s.activeId, closed: closed };
}

/**
 * The persisted record: `{ v, activeId, tabs: [{ pageId?, url?, title, icon, mode }] }`.
 * Inline tabs are excluded by construction; a transient active tab hands `activeId` to the first
 * persisted tab so a reload does not land on a tab that cannot come back.
 */
function serializeTabs(state: unknown): string {
  const s = normalizeSet(state);
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < s.tabs.length; i++) {
    const t = s.tabs[i];
    if (t.transient) continue;
    const row: Record<string, unknown> = { title: t.title, icon: t.icon, mode: t.mode };
    if (t.pageId) row.pageId = t.pageId;
    else if (t.url) row.url = t.url;
    else continue;
    rows.push(row);
  }
  const persisted = s.tabs.filter((t) => !t.transient).map((t) => t.id);
  const activeId = persisted.indexOf(s.activeId) >= 0 ? s.activeId : persisted[0] || "";
  return JSON.stringify({ v: PANEL_TABS_VERSION, activeId: activeId, tabs: rows });
}

function tabFromRecord(rec: Record<string, unknown>, pages: unknown, origin: string, createdAt: number): PanelTab | null {
  const pageId = text(rec["pageId"]).trim();
  if (pageId) {
    const page = findPageById(pageId, pages);
    if (page === null) return null;
    const ps = pageSpecOf(page);
    return {
      id: "p:" + page.id,
      pageId: page.id,
      title: text(rec["title"]).trim() || page.label,
      icon: text(rec["icon"]) || page.icon || "",
      url: ps.url || "",
      mode: ps.mode || "trusted",
      chrome: ps.chrome || "",
      html: "",
      text: "",
      transient: false,
      keepAlive: page.keepAlive === true,
      createdAt: createdAt,
    };
  }
  const url = text(rec["url"]).trim();
  if (!url) return null;
  const found = findPage(url, pages, origin);
  if (found !== null) {
    const ps = pageSpecOf(found);
    return {
      id: "p:" + found.id,
      pageId: found.id,
      title: text(rec["title"]).trim() || found.label,
      icon: text(rec["icon"]) || found.icon || "",
      url: ps.url || url,
      mode: ps.mode || "trusted",
      chrome: ps.chrome || "",
      html: "",
      text: "",
      transient: false,
      keepAlive: found.keepAlive === true,
      createdAt: createdAt,
    };
  }
  const id = "u:" + normalizeHref(url, origin);
  return {
    id: id,
    pageId: "",
    title: text(rec["title"]).trim() || lastSegment(url) || "页面",
    icon: text(rec["icon"]),
    url: url,
    mode: text(rec["mode"]) || "trusted",
    chrome: "",
    html: "",
    text: "",
    transient: false,
    keepAlive: false,
    createdAt: createdAt,
  };
}

/**
 * Rebuilds the set from `cfw_panel_tabs_v1`.
 *
 * Migrations: a bare array (v0) is read as page ids, and a record without `v` is read as v0. A
 * version newer than this build is treated as unreadable (empty set) rather than guessed at; old
 * inline payloads can never enter through this path because only `url`/`pageId` records resolve.
 *
 * @returns an empty set for bad JSON. Page-backed tabs whose page no longer exists are dropped —
 * a tab that can never mount is worse than a missing tab.
 */
function deserializeTabs(raw: unknown, pages: unknown, options?: TabSetOptions): TabSet {
  const source = text(raw).trim();
  if (!source) return emptyTabs();
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (e) {
    return emptyTabs();
  }
  const origin = text(options && options.origin);
  const now = num(options && options.now, Date.now());
  let records: unknown[] = [];
  let activeId = "";
  const asArray = Array.isArray(parsed);
  const rec = recOf(parsed);
  if (asArray) {
    records = arrOf(parsed);
    activeId = text(records[0]) ? "p:" + text(records[0]) : "";
  } else if (rec !== null) {
    const v = num(rec["v"], 0);
    if (v > PANEL_TABS_VERSION) return emptyTabs();
    records = arrOf(rec["tabs"]);
    activeId = text(rec["activeId"]);
  } else {
    return emptyTabs();
  }

  const tabs: PanelTab[] = [];
  for (let i = 0; i < records.length && tabs.length < PANEL_TAB_MAX; i++) {
    const item = records[i];
    const itemRec = recOf(item);
    const row: Record<string, unknown> = itemRec !== null ? itemRec : { pageId: text(item) };
    const tab = tabFromRecord(row, pages, origin, now + i);
    if (tab === null) continue;
    if (tabs.some((t) => t.id === tab.id)) continue;
    tabs.push(tab);
  }
  if (activeId && activeId.indexOf("u:") !== 0 && activeId.indexOf("t:") !== 0) {
    // Page ids are stored both as `p:<id>` (v1) and bare (migrated); normalise the bare shape.
    if (activeId.indexOf("p:") !== 0) activeId = "p:" + activeId;
  }
  return {
    version: PANEL_TABS_VERSION,
    tabs: tabs,
    activeId: tabs.some((t) => t.id === activeId) ? activeId : tabs.length ? tabs[0].id : "",
    closed: [],
  };
}

/** Catalog records → mountable pages. `page:false` and `embed:false` never become tabs. */
function pagesFromCatalog(entries: unknown, caps?: unknown): PanelPage[] {
  const capRec = recOf(caps);
  const out: PanelPage[] = [];
  const list = arrOf(entries);
  for (let i = 0; i < list.length; i++) {
    const rec = recOf(list[i]);
    if (rec === null) continue;
    if (rec["page"] === false || rec["embed"] === false) continue;
    const id = text(rec["id"]).trim();
    if (!id) continue;
    const requires = arrOf(rec["requires"]);
    if (capRec !== null && requires.length) {
      let ok = true;
      for (let r = 0; r < requires.length; r++) {
        const bit = text(requires[r]);
        if (bit && !capRec[bit]) { ok = false; break; }
      }
      if (!ok) continue;
    }
    out.push({
      id: id,
      label: text(rec["label"]) || id,
      icon: text(rec["icon"]),
      href: text(rec["href"]),
      chrome: text(rec["chrome"]),
      singleton: rec["singleton"] !== false,
      keepAlive: rec["keepAlive"] === true,
    });
  }
  return out;
}

interface SandboxViewPlanLike {
  readonly ok: boolean;
  readonly url: string;
  readonly reason: string;
  readonly warnings: readonly string[];
}

/** Read one plan from the injected views port. Unknown shapes are "not configured", never a throw. */
function viewPlanOf(views: unknown, kind: string): SandboxViewPlanLike | null {
  const rec = recOf(views);
  if (rec === null) return null;
  const fn = rec[kind];
  if (typeof fn !== "function") return null;
  let raw: unknown;
  try {
    raw = fn({});
  } catch (e) {
    return null;
  }
  const plan = recOf(raw);
  if (plan === null) return null;
  return {
    ok: plan["ok"] === true,
    url: text(plan["url"]),
    reason: text(plan["reason"]),
    warnings: arrOf(plan["warnings"]).map(text).filter((w) => w !== ""),
  };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Host-owned pages that are not tools: the sandbox's two 2D views and (only when configured) GEO.
 *
 * The sandbox root URL, the `demo/play.html` vs `demo/starmap.html` split and every parameter
 * validation live in `services/sandbox/views.ts`. This function only turns two plans into pages:
 * the main "沙盘" page defaults to the play flow (galaxy → planet → 96×64 map), and a second
 * "星图" page appears once the source is configured. The 3D fly/terrain pages are deliberately not
 * exposed.
 */
function hostPages(config: unknown): PanelPage[] {
  const rec = recOf(config) || {};
  const views = rec["views"];
  const play = viewPlanOf(views, "play");
  const playUrl = play !== null && play.ok ? play.url : "";
  const out: PanelPage[] = [
    {
      id: "sandbox",
      label: "沙盘",
      icon: "sandbox",
      href: playUrl,
      spec: playUrl
        ? { url: playUrl, mode: "external" }
        : { html: sandboxGuideHtml(play), mode: "host-html" },
    },
  ];
  if (playUrl) {
    const starmap = viewPlanOf(views, "starmap");
    if (starmap !== null && starmap.ok && starmap.url) {
      out.push({
        id: "starmap",
        label: "星图",
        icon: "sandbox",
        href: starmap.url,
        spec: { url: starmap.url, mode: "external" },
      });
    }
  }
  const geoUrl = text(rec["geoUrl"]).trim();
  if (geoUrl) {
    out.push({
      id: "map",
      label: "GEO 地图",
      icon: "globe",
      href: geoUrl,
      chrome: "map",
      spec: { url: geoUrl, mode: "external" },
    });
  }
  return out;
}

/** Catalog first, host pages last: a host page always wins an id collision with a tool.json. */
function mergePages(catalog: unknown, host: unknown): PanelPage[] {
  const byId: Record<string, PanelPage> = {};
  const order: string[] = [];
  const lists = [catalog, host];
  for (let l = 0; l < lists.length; l++) {
    const list = arrOf(lists[l]);
    for (let i = 0; i < list.length; i++) {
      const page = pageOf(list[i]);
      if (page === null) continue;
      if (!byId[page.id]) order.push(page.id);
      byId[page.id] = page;
    }
  }
  const out: PanelPage[] = [];
  for (let i = 0; i < order.length; i++) out.push(byId[order[i]]);
  return out;
}

/**
 * Which mounted tabs must be torn down to stay under the live-frame cap.
 * @returns ids in destruction order (oldest background tab first). The active tab and `keepAlive`
 * tabs are never selected; when the cap cannot be met the list is short rather than wrong.
 */
function liveToDestroy(state: unknown, mountedIds: unknown, max?: unknown): string[] {
  const s = normalizeSet(state);
  const mounted = arrOf(mountedIds).map(text);
  const cap = Math.max(1, num(max, PANEL_TAB_LIVE_MAX));
  let live = s.tabs.filter((t) => mounted.indexOf(t.id) >= 0);
  const out: string[] = [];
  while (live.length > cap) {
    const victim = live.filter((t) => t.id !== s.activeId && !t.keepAlive)[0];
    if (!victim) break;
    out.push(victim.id);
    live = live.filter((t) => t.id !== victim.id);
  }
  return out;
}

/** The standalone sandbox's setup page, shown when the views port has no usable source. */
function sandboxGuideHtml(plan: SandboxViewPlanLike | null): string {
  const reason = plan !== null && plan.reason ? plan.reason : "未配置沙盘根地址";
  const warnings = plan !== null ? plan.warnings : [];
  const warningHtml = warnings.length
    ? '<ul style="margin:0 0 12px;padding-left:18px;color:#8595a6">' + warnings.map((w) => '<li>' + escapeHtml(w) + '</li>').join('') + '</ul>'
    : "";
  return '<div style="margin:0;padding:20px 18px;font:12.5px/1.75 system-ui,\'Microsoft YaHei\',sans-serif;color:#c9d3de">' +
    '<div style="font-size:13px;font-weight:600;color:#eaf2fa;margin-bottom:6px">沙盘是独立项目</div>' +
    '<div style="color:#8595a6;margin-bottom:10px">内置沙盘已从本仓库摘除入口。沙盘在自己的仓库里跑，这里只负责把它的 2D 页面挂成一页：默认打开「星系 → 行星 → 地图」；配置后还会出现「星图」页。3D 飞行/地形页不挂。</div>' +
    '<div style="color:#e0a96d;margin-bottom:10px">' + escapeHtml(reason) + '</div>' +
    warningHtml +
    '<div style="color:#8595a6;margin-bottom:6px">1. 在沙盘仓库目录执行：</div>' +
    '<pre style="margin:0 0 12px;padding:9px 11px;background:#111820;border:1px solid #243040;border-radius:8px;' +
    'font:11px/1.6 ui-monospace,Consolas,monospace;color:#9fc0e0;overflow:auto;white-space:pre-wrap">cd OwnChat-Sandbox\nnpm run dev</pre>' +
    '<div style="color:#8595a6;margin-bottom:6px">2. 默认地址为 <b>http://127.0.0.1:8000/</b>。到「设置 → 内容面板」把根地址填进去（手机访问需局域网 IP 或独立部署）。</div>' +
    '<div style="color:#6f8194;font-size:11px">配置后重新打开这一页。</div>' +
    '</div>';
}

/** The frozen surface the wiring consumes; one non-`__` global keeps the contract list unchanged. */
export const panelTabs = {
  version: PANEL_TABS_VERSION,
  lsKey: PANEL_LS_TABS,
  open: openTab,
  close: closeTab,
  activate: activateTab,
  forgetClosed: forgetClosed,
  active: activeTabOf,
  byId: tabById,
  contentOf: contentOf,
  keyOf: tabKeyOf,
  serialize: serializeTabs,
  deserialize: deserializeTabs,
  pagesFromCatalog: pagesFromCatalog,
  hostPages: hostPages,
  mergePages: mergePages,
  liveToDestroy: liveToDestroy,
  findPage: findPage,
  findPageById: findPageById,
  normalizeHref: normalizeHref,
  empty: emptyTabs,
};
