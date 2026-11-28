/**
 * Settings card shell factory: one function owns the markup skeleton that every `mount*Card()`
 * used to hand-string — the `div.card` wrapper, the `<h4>` title, the optional pre-desc `lead`
 * fragment, the optional `<p>` description, the body markup and the `settings-tip` block with its
 * info glyph — plus the per-card `q(id)` query helper that used to be re-declared inside each card.
 *
 * Boundary with the mount API (core/slot-registry declareCard): the shell owns "what a card looks
 * like", declareCard owns "where it lands, mount-once, the error fence". They compose at the call
 * site — `slotRegistry.declareCard({ id, slotId, build: (slot) => { … createCardShell … return
 * card; } })` — and never call each other: the shell has no slot knowledge, and declareCard's
 * fence must see the caller's build as one unit (a shell-internal declareCard would nest the
 * fence inside the fence). The shell deliberately has NO append port: it cannot mount anything,
 * so "the factory never places the card" is enforced by its own surface, not by convention.
 *
 * Byte stability is the contract: the assembled markup is byte-identical to the hand-written
 * `card.innerHTML` strings this factory replaces, so the bilingual engine's whole-text-node
 * matching and every CSS selector keep working unchanged. That is why the spec fields carry
 * repository-authored HTML fragments (icons included) and why the shell writes through an
 * `innerHTML` port instead of `textContent`: the card titles embed inline SVG, which textContent
 * cannot express. The content is authored markup, never user input — same trust level as the
 * hand-written strings.
 *
 * The tip block: `tip` is the span TEXT and the shell always emits the standard info glyph, the
 * shape 26 of the 28 existing settings-tips use. The two bare-span tips (no glyph) pass their
 * tip `<div>` verbatim through `extra` instead — one escape hatch beats a second tip field.
 *
 * Ports follow the SlotRuntimePorts pattern (the wiring passes the real document, tests pass
 * stubs): make/setAttr for the wrapper, html for the authored markup, query for `q`. Every port
 * call is a guarded no-op on a bad handle, same fail-closed posture as bind.js — a broken port
 * must degrade to "content missing", never throw inside a card mount.
 * @module services/ui/settings-card
 */

/** DOM port: the only surface the factory touches; the wiring injects the real document verbs. */
export interface CardShellPorts {
  /** `document.createElement(tag)`. */
  make(tag: string): unknown;
  /** `el.setAttribute(name, value)`; a no-op on a non-element handle, never a throw. */
  setAttr(el: unknown, name: string, value: string): void;
  /** `el.innerHTML = value`; repository-authored markup only, never user input. */
  html(el: unknown, value: string): void;
  /** `el.querySelector(selector)`; `null` when the root is unusable or the selector misses. */
  query(el: unknown, selector: string): unknown;
}

/** One card's shell spec. Fields mirror the hand-written skeleton: h4 / lead / p / body / settings-tip. */
export interface CardShellSpec {
  /**
   * The card element id — also the declareCard mount marker, so it must equal the `id` of the
   * surrounding declareCard call. A card whose old guard id sat on an inner control takes a fresh
   * card-level id here; the control keeps its own id and its external wiring.
   */
  id: string;
  /** `<h4>` inner HTML, verbatim — icon SVG plus label, exactly as the card had it. */
  title: string;
  /**
   * Pre-desc body fragment: emitted right after the `<h4>`, before the `<p>`, verbatim. Exists for
   * the one card whose old body order puts a control row ahead of the description (personaCard:
   * h4 → toggle row → p → textarea → tip) — the fixed h4/p/extra/tip order cannot express that
   * byte-identically. Absent or empty emits nothing, same rule as desc/extra.
   */
  lead?: string;
  /** `<p>` inner HTML. Absent or empty means the node is NOT emitted — never an empty `<p>`. */
  desc?: string;
  /** Body markup between the description and the tip, verbatim; absent emits nothing. */
  extra?: string;
  /** settings-tip span text; the shell emits the standard block with the info glyph around it. */
  tip?: string;
}

/** One built shell. `q` is the factory edition of the per-card `var q = function(id){…}` helper. */
export interface CardShell {
  /** The card element — built but unattached; placing it is the caller's (build's) job. */
  card: unknown;
  /** Look up `#<id>` inside this card; a miss returns `null`, never throws. */
  q(id: string): unknown;
}

/** What the wiring assigns to `window.cardShell`. Published as a non-`__` global. */
export interface CardShellApi {
  createCardShell(spec: CardShellSpec): CardShell;
}

/** The info glyph every standard settings-tip opens with; one home instead of one copy per card. */
const TIP_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg>';

/**
 * Build the shell factory. The port set is the only IO surface; the document never appears here.
 * @param ports - DOM access from the wiring.
 */
export function createCardShellFactory(ports: CardShellPorts): CardShellApi {
  function createCardShell(spec: CardShellSpec): CardShell {
    const card = ports.make("div");
    ports.setAttr(card, "class", "card");
    ports.setAttr(card, "id", spec.id);
    // Assembled in one string so the output is byte-comparable against the hand-written innerHTML
    // this replaces. Optional sections drop out entirely — a missing desc/tip must not leave an
    // empty node behind (the old hand-written strings simply omitted those chunks too).
    let markup = "<h4>" + spec.title + "</h4>";
    if (spec.lead) markup += spec.lead;
    if (spec.desc) markup += "<p>" + spec.desc + "</p>";
    if (spec.extra) markup += spec.extra;
    if (spec.tip) {
      markup += '<div class="settings-tip">' + TIP_ICON + "<span>" + spec.tip + "</span></div>";
    }
    ports.html(card, markup);
    function q(id: string): unknown {
      return ports.query(card, "#" + id);
    }
    return { card: card, q: q };
  }
  return { createCardShell: createCardShell };
}
