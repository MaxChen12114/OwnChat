/**
 * Tool-page catalog: turns the build-injected `#toolsPageCatalog` block into sidebar entries.
 *
 * The engine owns the only decisions a broken catalog can get wrong — parsing, the defensive
 * re-sort, field coercion and the icon fallback. The wiring keeps every DOM lookup and append, so
 * this module can run in a vm with no document. A page exists because its directory carries a
 * `tool.json`; the renderer never keeps a hand-written id list.
 * @module services/ui/tools-pages
 */

/** One catalog record, as emitted by `tooling/l0/build.mjs` from `public/tools/<id>/tool.json`. */
export interface ToolPageRecord {
  id?: unknown;
  label?: unknown;
  href?: unknown;
  order?: unknown;
  icon?: unknown;
  desc?: unknown;
  page?: unknown;
  sidebar?: unknown;
  embed?: unknown;
  chrome?: unknown;
  singleton?: unknown;
  keepAlive?: unknown;
  requires?: unknown;
}

/** A record after coercion: every string the DOM needs is already a string. */
export interface ToolPageEntry {
  readonly id: string;
  readonly href: string;
  readonly title: string;
  readonly label: string;
  readonly iconHtml: string;
  /** Mountable as a right-column tab. */
  readonly page: boolean;
  /** Listed in the left sidebar. */
  readonly sidebar: boolean;
  /** Safe to render inside the 1024+ right column. */
  readonly embed: boolean;
}

/** Fixed icon table; a key missing here falls back instead of dropping the page. */
export const ICON_PATHS: Readonly<Record<string, string>> = {
  studio: '<path d="M4 20l4-1 9.6-9.6a2 2 0 0 0-2.8-2.8L5.4 16z"/><path d="M13.5 6.3l4.2 4.2"/>',
  write: '<path d="M7 3.5h7L18.5 8v12.5H7z"/><path d="M14 3.5V8h4.5"/><path d="M9.5 12.5h6M9.5 15.5h6M9.5 18h3.5"/>',
  flow: '<path d="M9 8l-4 4 4 4"/><path d="M15 8l4 4-4 4"/><path d="M13.2 5l-2.4 14"/>',
  coding: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M8 10l-2.2 2.2L8 14.4"/><path d="M13 9.5l-2 5.5"/>',
  audio: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
  sandbox: '<path d="M3 6.5l6-2 6 2 6-2v13l-6 2-6-2-6 2z"/><path d="M9 4.5v13M15 6.5v13"/>',
  // Right-column fixed views (services/panel/panel-host.ts PANEL_VIEWS): pulse line / two bubbles /
  // bars. They used to be inlined once in index.html and once in the panel bar.
  activity: '<path d="M3 12h4l2.5-6 4 12 2.5-6h5"/>',
  chat: '<path d="M4 5.5h11a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H8l-3.5 2.5V14.5H4A1.5 1.5 0 0 1 2.5 13V7A1.5 1.5 0 0 1 4 5.5z"/><path d="M17 8.5h3A1.5 1.5 0 0 1 21.5 10v5.5a1.5 1.5 0 0 1-1.5 1.5h-.5v2.5L16 17.5h-3"/>',
  status: '<path d="M4 19.5h16"/><path d="M7.5 19.5v-5.5"/><path d="M12 19.5V6.5"/><path d="M16.5 19.5v-8.5"/>',
  // Host pages and the council: the two glyphs that used to live in panel-host's if/else.
  users: '<circle cx="9" cy="8.2" r="3.2"/><path d="M3.4 19c0-3.1 2.5-5.2 5.6-5.2s5.6 2.1 5.6 5.2"/><circle cx="16.8" cy="9.4" r="2.4"/><path d="M15.6 13.6c2.6 0 4.8 1.7 4.8 4.4"/>',
  globe: '<circle cx="12" cy="12" r="8.2"/><path d="M3.8 12h16.4M12 3.8c2.2 2.3 3.3 5.1 3.3 8.2s-1.1 5.9-3.3 8.2c-2.2-2.3-3.3-5.1-3.3-8.2s1.1-5.9 3.3-8.2z"/>',
};

/** Fallback path for unknown icon keys: a plain rounded square. */
export const FALLBACK_ICON_PATH = '<rect x="4" y="4" width="16" height="16" rx="3"/>';

/** Shared SVG wrapper; `innerHTML` receives the wrapper plus the chosen path. */
export const SVG_OPEN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';

/** unknown -> a non-array object record, or null. The standard bridge used across services. */
function recOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  return out;
}

/**
 * Parse the catalog block. Malformed JSON, a missing block and a non-array `pages` all degrade to
 * an empty catalog — the sidebar hides instead of taking the whole boot down. Entries that are not
 * plain objects are dropped for the same reason: one bad record must not block the other pages.
 *
 * @param text - Raw text of the `#toolsPageCatalog` script block, or null/undefined when absent.
 * @returns The catalog in source order (sorting is a separate step).
 */
export function parseCatalog(text: string | null | undefined): ToolPageRecord[] {
  if (text === null || text === undefined) return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return [];
  }
  const rec = recOf(data);
  if (rec === null) return [];
  const pages = rec["pages"];
  if (!Array.isArray(pages)) return [];
  const out: ToolPageRecord[] = [];
  for (let i = 0; i < pages.length; i++) {
    const page = recOf(pages[i]);
    if (page !== null) out.push(page);
  }
  return out;
}

/**
 * Defensive re-sort: the build already sorts by `order`, but a hand-edited catalog block must not
 * reorder the sidebar. Equal orders fall back to a byte-comparison of the ids, the same rule the
 * build uses.
 *
 * @param pages - Records in source order.
 * @returns A new array sorted by `order` (non-numbers count as 0) and then by id.
 */
export function sortPages(pages: readonly ToolPageRecord[]): ToolPageRecord[] {
  const out = pages.slice();
  out.sort(function (a, b) {
    const oa = typeof a.order === "number" ? a.order : 0;
    const ob = typeof b.order === "number" ? b.order : 0;
    if (oa !== ob) return oa - ob;
    const ia = String(a.id);
    const ib = String(b.id);
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
  return out;
}

/**
 * Coerce one record into the exact strings the sidebar needs.
 *
 * @param page - A catalog record; missing fields become empty strings, never `undefined`.
 * @returns The id, href, label, hover title (description when present), icon markup and the three
 * visibility flags. `embed` falls back to "same-origin path" exactly like the build scanner.
 */
export function entryFor(page: ToolPageRecord): ToolPageEntry {
  const label = String(page.label);
  const desc = typeof page.desc === "string" && page.desc ? page.desc : label;
  const key = page.icon === null || page.icon === undefined ? "" : String(page.icon);
  const href = String(page.href);
  return {
    id: String(page.id),
    href: href,
    title: desc,
    label: label,
    iconHtml: SVG_OPEN + (ICON_PATHS[key] || FALLBACK_ICON_PATH) + "</svg>",
    page: page.page !== false,
    sidebar: page.sidebar !== false,
    embed: typeof page.embed === "boolean" ? page.embed : href.charAt(0) === "/",
  };
}
