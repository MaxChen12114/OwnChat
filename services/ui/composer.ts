/**
 * Composer input rules, minus the DOM: which shape the send button takes, where an `@` mention query
 * begins and ends, how a picked name is written back, how the candidate list is filtered and
 * stepped, how the keyboard inset is measured and where the popup is placed.
 *
 * Three rules carry the history:
 *  - An `@` opens the popup only at a line start or after whitespace, so an address (`a@b`) never
 *    turns into a mention query.
 *  - The send button becomes stop only while a turn runs **and** the box is empty. Text in the box
 *    means the press is an interjection, not an interrupt — the same button, two meanings.
 *  - The keyboard inset is clamped at 0 and rounded: an unbounded negative value would lift the
 *    composer off-screen on the WebViews that shrink the layout viewport instead of the visual one.
 *
 * Everything here is pure. The caller owns the textarea, the popup node, the CSS variable and the
 * "value unchanged, skip the write" decision — that last one is state, not a rule.
 * @module services/ui/composer
 */

/** What the send button means right now. */
export type ComposerSendMode = "stop" | "send";

/** The `@` fragment under the caret: `start`/`end` bracket the name, the `@` sits at `start - 1`. */
export interface ComposerMentionQuery {
  query: string;
  start: number;
  end: number;
}

/** The only card fields the mention popup depends on. */
export interface ComposerCard {
  name?: string;
  icon?: string;
}

export interface ComposerInsertion {
  value: string;
  caret: number;
}

export interface ComposerMenuColors {
  background: string;
  border: string;
  color: string;
  highlight: string;
}

/** Line start or whitespace, then `@`, then a run with no whitespace and no second `@`. */
const MENTION_QUERY_RE = /(^|\s)@([^\s@]*)$/;

export function composerSendMode(running: boolean, value: string): ComposerSendMode {
  const hasText = String(value || "").trim().length > 0;
  return running && !hasText ? "stop" : "send";
}

export function composerAtQuery(value: string, caret: number): ComposerMentionQuery | null {
  const text = String(value || "");
  const pos = typeof caret === "number" && caret >= 0 ? caret : 0;
  const left = text.slice(0, pos);
  const m = MENTION_QUERY_RE.exec(left);
  if (!m) return null;
  const query = m[2];
  return { query: query, start: pos - query.length - 1, end: pos };
}

/**
 * Candidates for the popup. An empty query keeps every truthy card; a query keeps cards whose name
 * contains it, case-insensitively, and drops nameless ones (they cannot be matched or inserted).
 */
export function composerFilterCards(cards: ComposerCard[], query: string): ComposerCard[] {
  const q = String(query || "").toLowerCase();
  const out: ComposerCard[] = [];
  for (const card of cards || []) {
    if (!card) continue;
    if (q) {
      const name = typeof card.name === "string" ? card.name : "";
      if (!name || name.toLowerCase().indexOf(q) < 0) continue;
    }
    out.push(card);
  }
  return out;
}

/**
 * Writes `@name ` over the query fragment and leaves the text after the caret untouched. Returns
 * `null` when there is nothing to replace (no query, or a card without a name).
 */
export function composerMentionInsertion(
  value: string,
  range: ComposerMentionQuery,
  name: string,
): ComposerInsertion | null {
  if (!range) return null;
  const text = String(value || "");
  const insert = "@" + String(name || "") + " ";
  if (!String(name || "").length) return null;
  const before = text.slice(0, range.start);
  const after = text.slice(range.end);
  return { value: before + insert + after, caret: (before + insert).length };
}

/** Arrow-key stepping over the candidate list; both directions wrap, an out-of-range index restarts. */
export function composerStepIndex(index: number, length: number, delta: number): number {
  if (!length || length < 1) return -1;
  const from = index >= 0 && index < length ? index : 0;
  return (((from + delta) % length) + length) % length;
}

/**
 * Keyboard inset in CSS pixels. `offsetTop` is the visual viewport's own scroll offset — without it
 * a page scrolled under a shrunken viewport reports an inset that scrolls the composer twice.
 */
export function composerKbInset(innerHeight: number, viewportHeight: number, viewportOffsetTop: number): number {
  const raw = (Number(innerHeight) || 0) - (Number(viewportHeight) || 0) - (Number(viewportOffsetTop) || 0);
  return Math.max(0, Math.round(raw));
}

/**
 * Popup placement in page coordinates. Prefers sitting above the box; flips below when the top edge
 * would be clipped by the viewport's 8px margin. `menuHeight` falls back to 200 when the node has
 * not been measured yet.
 */
export function composerMenuPlacement(
  rectTop: number,
  rectBottom: number,
  rectLeft: number,
  menuHeight: number,
  scrollY: number,
  scrollX: number,
): { top: number; left: number } {
  const h = Number(menuHeight) > 0 ? Number(menuHeight) : 200;
  let top = (Number(rectTop) || 0) - h - 6;
  if (top < 8) top = (Number(rectBottom) || 0) + 6;
  return { top: top + (Number(scrollY) || 0), left: (Number(rectLeft) || 0) + (Number(scrollX) || 0) };
}

/** The popup palette as a light/dark pair; both schemes are declared here so neither can drift. */
export function composerMenuColors(light: boolean): ComposerMenuColors {
  return light
    ? { background: "#ffffff", border: "1px solid #ddd", color: "#222", highlight: "#eaeaea" }
    : { background: "#1c1c22", border: "1px solid #3a3a44", color: "#eee", highlight: "#33333d" };
}
