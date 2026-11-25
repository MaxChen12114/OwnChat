/**
 * Character-card data layer: card CRUD, the active card, per-card relation and emotion, the
 * affection score and its threshold-event queue.
 *
 * Everything the browser owns arrives through {@link CharacterPorts}: the card store, key-value
 * storage, the change event, the uid clock and the best-effort hooks into sibling domains. This
 * file touches no `window`, `localStorage` or `document`; the adapter and the whole card panel
 * live in l0/wiring/character.js.
 *
 * Cards are opaque records. Other writers (agent tools, studio) own fields this module knows
 * nothing about, so a save normalizes only the fields listed on {@link CharacterCard} and lets
 * everything else ride along untouched.
 * Relation and emotion are keyed by card id because they follow the character, not the
 * conversation; a bare legacy string is still read as the value for the current card.
 * @module services/data/character
 */

/** Key-value storage port; the browser adapter wraps window.localStorage and swallows quota errors. */
export interface KvStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** A card exactly as stored. Fields this module does not own stay `unknown` on purpose. */
export type RawCard = Record<string, unknown>;

/**
 * Card store port: two object stores in the browser (cards keyed by `id`, affections keyed by
 * `cardId`), an in-memory map in the tests. `cardId` is typed `unknown` because the id read back
 * from storage is whatever a previous writer put there.
 */
export interface CardStore {
  all(): Promise<RawCard[]>;
  put(card: unknown): Promise<void>;
  remove(id: unknown): Promise<void>;
  /** `null` when the card has no row yet; a non-numeric row also reads as `null`. */
  getAffection(cardId: unknown): Promise<number | null>;
  putAffection(cardId: unknown, value: number): Promise<void>;
  removeAffection(cardId: unknown): Promise<void>;
}

/** Sibling-domain hooks. Every one of them is best-effort: the wiring layer swallows failures. */
export interface CharacterPorts {
  storage: KvStorage;
  cards: CardStore;
  /** Emit the change event; the left sidebar and the panel redraw on it. */
  notify(): void;
  /** Current timestamp, used as the uid suffix. */
  now(): number;
  /** Mark the card table dirty for cloud sync. */
  onCharsDirty(): void;
  /** Bump the per-card metadata stamp so sync uploads this one card. */
  onCardMetaBump(cardId: string): void;
  /** Queue a tombstone so the deletion propagates. */
  onCardTombstone(cardId: string): void;
  /** Ask the multi-agent scene to take this card in. */
  onSceneAdd(cardId: string): void;
  /** Drop this card from the multi-agent scene. */
  onSceneRemove(cardId: string): void;
  /** Delete the card's memory namespace (knowledge base and notebook). */
  onCardMemoryRemove(cardId: string): Promise<void>;
  /** Unbind the card's per-card lorebook entries, keeping them as global ones. */
  onLorebookUnbind(cardId: string): void;
}

/** One affection band; `max` is inclusive and the bands are checked in ascending order. */
export interface AffectionStage {
  max: number;
  label: string;
}

/** One example exchange; values are passed through as stored, which is not always a string. */
export interface ExamplePair {
  user: unknown;
  character: unknown;
}

/** The SillyTavern fields kept only so an export can hand them back unchanged. */
export interface CardSpec {
  specVersion: string;
  creator: string;
  creatorNotes: string;
  characterVersion: string;
  systemPrompt: string;
  postHistoryInstructions: string;
  alternateGreetings: string[];
  tags: string[];
  extensions: Record<string, unknown>;
  /** V3 `assets` entries (icon / background / emotion / embedded app), kept verbatim. Stored, never executed or rendered by this layer. */
  assets: unknown[];
}

/** The fields this layer owns; key order here is the write key order, so keep it stable. */
export interface CharacterCard {
  id: string;
  name: string;
  gender: string;
  age: string;
  identity: string;
  scenario: string;
  icon: string;
  /** Only an explicit `false` turns the affection system off. */
  enableAffection: boolean;
  personality: string;
  speakingStyle: string;
  rules: unknown[];
  openingLine: string;
  exampleQA: ExamplePair[];
  affectionThresholds: unknown[];
  avatar: string;
  spec: CardSpec | null;
}

/** Result of stripping a trailing score tag. `stripped` is the input itself when it is not a string. */
export interface AffectionTag {
  delta: number;
  stripped: unknown;
}

/** Public surface; the names match the frozen contract one for one. */
export interface CharacterApi {
  refresh(): Promise<void>;
  getActiveCard(): RawCard | null;
  setActiveId(id: string): void;
  getActiveRelation(): string;
  setActiveRelation(key: string): void;
  getActiveEmotion(): string;
  setActiveEmotion(emotion: unknown): void;
  getActiveAffection(): number | null;
  setActiveAffection(value: unknown): Promise<void>;
  adjustActiveAffection(delta: unknown): Promise<void>;
  resetActiveAffection(): Promise<void>;
  parseAffectionTag(text: unknown): AffectionTag;
  listAllCards(): RawCard[];
  getAllCards(): Promise<RawCard[]>;
  saveCard(input: unknown): Promise<CharacterCard>;
  deleteCard(id: string): Promise<void>;
  getPendingThresholdEvents(): unknown[];
  clearPendingThresholdEvents(): void;
  resetThresholdTriggers(cardId: string): void;
  reload(): Promise<void>;
  relations: string[];
  builtinEmotions: string[];
  affectionStages: AffectionStage[];
  affectionInit: number;
}

/** The only relation values the worker accepts; free text is mapped onto these. */
const RELATIONS = ["default", "friendly", "loving", "hostile", "fearful", "dom", "sub"];

/** The only emotions the prompt builder names; free text is stored as-is elsewhere. */
const EMOTIONS = ["neutral", "happy", "angry", "sad", "surprised"];

/** Must stay in step with the worker's own stage table, otherwise the bar and the prompt disagree. */
const AFFECTION_STAGES: AffectionStage[] = [
  { max: 15, label: "陌生人" },
  { max: 35, label: "熟人" },
  { max: 60, label: "好友" },
  { max: 80, label: "暧昧" },
  { max: 100, label: "灵魂伴侣" },
];

/** Every card starts here, and a reset returns here rather than to 0. */
const AFFECTION_INIT = 30;

const KEY_ACTIVE_ID = "tavern_active_char_id";
const KEY_RELATION = "tavern_active_relation";
const KEY_EMOTION = "tavern_active_emotion";
/** Queue of threshold instructions waiting to be injected; one shot each. */
const KEY_PENDING_EVENTS = "tavern_aff_pending_v1";
/** Per-card set of already-fired thresholds, so a band only fires once. */
const KEY_TRIGGERED_PREFIX = "tavern_aff_triggered_";
const KEY_CHAR_CAPS = "cfw_char_caps_v1";

/**
 * Budget for the V3 `assets` payload: entries are opaque blobs (often megabyte data URIs) that
 * ride inside the card row and into the cloud-sync payload. The budget is bytes-first; whatever
 * it drops is visible in the import report, which reads the kept count back from the saved card.
 */
const ASSET_MAX_COUNT = 40;
const ASSET_MAX_URI_CHARS = 1_500_000;
const ASSET_MAX_TOTAL_CHARS = 4_000_000;

/**
 * unknown -> plain-object copy. Arrays, null and scalars all become null. Copied through
 * Object.entries rather than indexed, because `typeof x === "object"` only narrows to object and
 * an index read off that would be `any`.
 */
function cardRecOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  return out;
}

/** unknown -> fresh array; anything else becomes an empty one. Elements are not inspected. */
function cardArrOf(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  const out: unknown[] = [];
  for (let i = 0; i < value.length; i++) out.push(value[i]);
  return out;
}

/** Strings pass through; everything else becomes "". */
function cardStrOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Trims a possibly-missing string field; non-strings read as "". */
function cardTrimmed(value: unknown): string {
  return cardStrOf(value).trim();
}

/**
 * Pick the affection band for a score. Out-of-range scores are clamped rather than rejected, and
 * a non-number yields `null` so the caller can decide; the last band ends at 100, so a clamped
 * score always matches.
 */
export function affectionStageFor(value: unknown): AffectionStage | null {
  if (typeof value !== "number" || isNaN(value)) return null;
  const x = Math.max(0, Math.min(100, value));
  for (let i = 0; i < AFFECTION_STAGES.length; i++) {
    if (x <= AFFECTION_STAGES[i].max) return AFFECTION_STAGES[i];
  }
  return null;
}

/**
 * Map free-form relation text onto the worker enum. Order matters: the first matching family
 * wins, so "又怕又爱" lands on `loving` because that test comes first.
 */
export function relationFromText(text: unknown): string {
  const s = cardStrOf(text);
  if (s === "") return "default";
  if (/友好|朋友|哥们|姐妹|同事|搭档/.test(s)) return "friendly";
  if (/爱|喜欢|恋人|暧昧|心动|喜爱|恋|情侣|伴侣/.test(s)) return "loving";
  if (/敌|讨厌|恨|对立|仇|不爽|厌恶/.test(s)) return "hostile";
  if (/怕|畏|惧|恐|害怕/.test(s)) return "fearful";
  if (/主导|支配|强势|dom|主人|支配者/i.test(s)) return "dom";
  if (/服从|被动|顺从|sub|奴|跟随/i.test(s)) return "sub";
  return "default";
}

/**
 * Strip a trailing hidden score tag `[好感+N]` / `[好感-N]` off a model reply.
 * Only the last match counts, the step is clamped to 0..50, and the stripped text loses the tag
 * plus any whitespace it left behind at the end.
 * @param text - the raw reply; anything that is not a non-empty string is returned untouched with `delta: 0`.
 * @returns The delta and the text with every tag removed, not just the last one.
 */
export function parseAffectionTag(text: unknown): AffectionTag {
  if (!text || typeof text !== "string") return { delta: 0, stripped: text };
  const re = /\[\s*好感\s*([+\-])\s*(\d{1,2})\s*\]/g;
  let hit: RegExpExecArray | null = null;
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    hit = m;
    m = re.exec(text);
  }
  if (hit === null) return { delta: 0, stripped: text };
  const sign = hit[1] === "-" ? -1 : 1;
  const step = Math.min(50, Math.max(0, parseInt(hit[2], 10) || 0));
  return { delta: sign * step, stripped: text.replace(re, "").replace(/\s+$/, "") };
}

/**
 * Create the character layer. It keeps the active card and its affection score in memory as a
 * cache; the card table itself is re-read on every mutation, so a second tab's write wins.
 * @param ports - storage, card store, change event, clock and the sibling-domain hooks.
 * @returns The public surface. Reads never throw; a failed write rejects only when the caller
 * awaits it, and the change event still fires so listeners resync.
 */
export function createCharacter(ports: CharacterPorts): CharacterApi {
  const storage = ports.storage;
  const cards = ports.cards;

  let active: RawCard | null = null;
  let affection: number | null = null;
  let allCards: RawCard[] = [];

  /** Parse a stored JSON value; corrupt or missing data degrades to `null`, never to a throw. */
  function readJson(key: string): unknown {
    const raw = storage.getItem(key);
    if (raw === null || raw === "") return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  /** Same as {@link readJson}, but a non-array result collapses to an empty array. */
  function readJsonArray(key: string): unknown[] {
    return cardArrOf(readJson(key));
  }

  /** The card-id-keyed map used by relation and emotion; a bare string predates the map format. */
  function kvMap(key: string): Record<string, unknown> | null {
    return cardRecOf(readJson(key));
  }

  /** Pre-map format: a plain string, recognised by not starting with "{". */
  function kvLegacy(key: string): string | null {
    const v = storage.getItem(key);
    return v !== null && v !== "" && v.charAt(0) !== "{" ? v : null;
  }

  function currentCardId(): string {
    return storage.getItem(KEY_ACTIVE_ID) || "";
  }

  function findCard(id: string): RawCard | null {
    for (let i = 0; i < allCards.length; i++) {
      if (allCards[i]["id"] === id) return allCards[i];
    }
    return null;
  }

  function isAffectionOn(): boolean {
    return active !== null && active["enableAffection"] !== false;
  }

  async function refresh(): Promise<void> {
    allCards = await cards.all();
    const id = currentCardId();
    if (id === "") {
      active = null;
      affection = null;
      return;
    }
    active = findCard(id);
    if (active === null) {
      // The id points at a card that is gone; drop it so the next read does not repeat the lookup
      storage.removeItem(KEY_ACTIVE_ID);
      affection = null;
      return;
    }
    const stored = await cards.getAffection(active["id"]);
    affection = stored === null ? AFFECTION_INIT : stored;
  }

  function getActiveCard(): RawCard | null {
    return active;
  }

  /**
   * Switch the active card and notify. The multi-agent scene is told as well, because picking a
   * card in the panel is how a scene gets its first member.
   */
  function setActiveId(id: string): void {
    if (id !== "") {
      storage.setItem(KEY_ACTIVE_ID, id);
      ports.onSceneAdd(id);
    } else {
      storage.removeItem(KEY_ACTIVE_ID);
    }
    void refresh().then(ports.notify);
  }

  function getActiveRelation(): string {
    const map = kvMap(KEY_RELATION);
    const v = map !== null ? cardStrOf(map[currentCardId()]) : kvLegacy(KEY_RELATION) || "";
    return RELATIONS.indexOf(v) >= 0 ? v : "default";
  }

  /** Validates against the enum before writing; unknown input silently becomes `default`. */
  function setActiveRelation(key: string): void {
    const val = RELATIONS.indexOf(key) >= 0 ? key : "default";
    const map = kvMap(KEY_RELATION) || {};
    map[currentCardId()] = val;
    storage.setItem(KEY_RELATION, JSON.stringify(map));
    ports.notify();
  }

  function getActiveEmotion(): string {
    const map = kvMap(KEY_EMOTION);
    const v = map !== null ? cardStrOf(map[currentCardId()]) : kvLegacy(KEY_EMOTION) || "";
    return v !== "" ? v : "neutral";
  }

  /**
   * Store free-form emotion text for the active card. Unlike relation there is no enum gate: the
   * worker accepts any string, and only a blank one falls back to `neutral`.
   */
  function setActiveEmotion(emotion: unknown): void {
    const raw = emotion === null || emotion === undefined ? "neutral" : String(emotion);
    const v = raw.trim() !== "" ? raw.trim() : "neutral";
    const map = kvMap(KEY_EMOTION) || {};
    map[currentCardId()] = v;
    storage.setItem(KEY_EMOTION, JSON.stringify(map));
    ports.notify();
  }

  function getActiveAffection(): number | null {
    return isAffectionOn() ? affection : null;
  }

  function getPendingThresholdEvents(): unknown[] {
    return readJsonArray(KEY_PENDING_EVENTS);
  }

  function clearPendingThresholdEvents(): void {
    storage.removeItem(KEY_PENDING_EVENTS);
  }

  function resetThresholdTriggers(cardId: string): void {
    if (cardId !== "") storage.removeItem(KEY_TRIGGERED_PREFIX + cardId);
  }

  /**
   * Record a band crossing. A band fires once per card: the fired `at` values live in a per-card
   * key, and a reset is what clears them. A threshold without a usable `at` or `instruction` is
   * ignored rather than defaulted, because injecting an empty instruction is worse than silence.
   */
  function collectThresholdEvents(card: RawCard, before: number, after: number): void {
    const list = cardArrOf(card["affectionThresholds"]);
    if (list.length === 0) return;
    const cardId = String(card["id"]);
    const key = KEY_TRIGGERED_PREFIX + cardId;
    const fired = readJsonArray(key);
    const fresh: Record<string, unknown>[] = [];
    for (let i = 0; i < list.length; i++) {
      const th = cardRecOf(list[i]);
      if (th === null) continue;
      const at = th["at"];
      const instruction = cardTrimmed(th["instruction"]);
      if (typeof at !== "number" || instruction === "") continue;
      if (fired.indexOf(at) >= 0) continue;
      const dir = cardStrOf(th["dir"]) || "up";
      const upCross = before < at && after >= at;
      const downCross = before > at && after <= at;
      const crossed =
        (dir === "up" && upCross) || (dir === "down" && downCross) || (dir === "both" && (upCross || downCross));
      if (!crossed) continue;
      fresh.push({ cardId: cardId, at: at, instruction: instruction });
      fired.push(at);
    }
    if (fresh.length === 0) return;
    storage.setItem(key, JSON.stringify(fired));
    const pending = readJsonArray(KEY_PENDING_EVENTS);
    for (let i = 0; i < fresh.length; i++) pending.push(fresh[i]);
    storage.setItem(KEY_PENDING_EVENTS, JSON.stringify(pending));
  }

  /**
   * Set the active card's score. No-ops without an active card or with the affection system off,
   * so a stale panel cannot write to a card the user just switched away from.
   * @param value - coerced with `Number`, rounded and clamped to 0..100; junk lands on 0.
   */
  async function setActiveAffection(value: unknown): Promise<void> {
    if (active === null || !isAffectionOn()) return;
    const before = typeof affection === "number" ? affection : AFFECTION_INIT;
    const after = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    affection = after;
    await cards.putAffection(active["id"], after);
    ports.onCharsDirty();
    collectThresholdEvents(active, before, after);
    ports.notify();
  }

  async function adjustActiveAffection(delta: unknown): Promise<void> {
    if (!isAffectionOn()) return;
    const cur = typeof affection === "number" ? affection : AFFECTION_INIT;
    await setActiveAffection(cur + (Number(delta) || 0));
  }

  /** Back to the initial score, and the fired-band record is cleared so the story can replay. */
  async function resetActiveAffection(): Promise<void> {
    if (active === null || !isAffectionOn()) return;
    resetThresholdTriggers(String(active["id"]));
    await setActiveAffection(AFFECTION_INIT);
  }

  function listAllCards(): RawCard[] {
    return allCards.slice();
  }

  function getAllCards(): Promise<RawCard[]> {
    return cards.all();
  }

  /**
   * An asset rides along whole once it proves to be an object with a usable `uri`; `type` / `name` /
   * `ext` are not inspected, because the consumers (image, sandbox import) re-check them anyway and
   * this layer only guarantees round-trip fidelity. Entries past the count or byte budget are
   * dropped rather than truncated: a half-kept data URI is worse than a missing one.
   */
  function normalizeAssets(input: unknown): unknown[] {
    const raw = cardArrOf(input);
    const out: unknown[] = [];
    let total = 0;
    for (let i = 0; i < raw.length && out.length < ASSET_MAX_COUNT; i++) {
      const rec = cardRecOf(raw[i]);
      if (rec === null) continue;
      const uri = cardStrOf(rec["uri"]);
      if (uri === "" || uri.length > ASSET_MAX_URI_CHARS) continue;
      if (total + uri.length > ASSET_MAX_TOTAL_CHARS) break;
      total += uri.length;
      out.push(rec);
    }
    return out;
  }

  /**
   * Whitelist the import-only fields, each with a length cap: this input comes from the open web
   * and is not to be trusted with arbitrary structure.
   * @returns `null` when every field is empty, so an import without extras stores no `spec` at all.
   */
  function normalizeSpec(input: unknown): CardSpec | null {
    const src = cardRecOf(input);
    if (src === null) return null;
    const spec: CardSpec = {
      specVersion: cardStrOf(src["specVersion"]).slice(0, 16),
      creator: cardStrOf(src["creator"]).slice(0, 200),
      creatorNotes: cardStrOf(src["creatorNotes"]).slice(0, 4000),
      characterVersion: cardStrOf(src["characterVersion"]).slice(0, 60),
      systemPrompt: cardStrOf(src["systemPrompt"]).slice(0, 20000),
      postHistoryInstructions: cardStrOf(src["postHistoryInstructions"]).slice(0, 20000),
      alternateGreetings: [],
      tags: [],
      extensions: {},
      assets: [],
    };
    const greetings = cardArrOf(src["alternateGreetings"]);
    for (let i = 0; i < greetings.length && spec.alternateGreetings.length < 20; i++) {
      const g = greetings[i];
      if (typeof g === "string") spec.alternateGreetings.push(g);
    }
    const tags = cardArrOf(src["tags"]);
    for (let i = 0; i < tags.length && spec.tags.length < 40; i++) {
      const t = tags[i];
      if (typeof t === "string") spec.tags.push(t);
    }
    const ext = cardRecOf(src["extensions"]);
    if (ext !== null) spec.extensions = ext;
    spec.assets = normalizeAssets(src["assets"]);
    const any =
      spec.specVersion.length > 0 ||
      spec.creator.length > 0 ||
      spec.creatorNotes.length > 0 ||
      spec.characterVersion.length > 0 ||
      spec.systemPrompt.length > 0 ||
      spec.postHistoryInstructions.length > 0 ||
      spec.alternateGreetings.length > 0 ||
      spec.tags.length > 0 ||
      Object.keys(spec.extensions).length > 0 ||
      spec.assets.length > 0;
    return any ? spec : null;
  }

  /**
   * The single write path for cards, shared by the panel, the prompt editor, the agent tools and
   * studio. It normalizes the owned fields, keeps `rules` at three slots and `exampleQA` at two,
   * and re-reads the table afterwards so the in-memory copy matches disk.
   * @param input - an untrusted card-shaped value; a missing name rejects with a user-facing message.
   * @returns The card as written, including the generated `u_<base36>` id when none was supplied.
   */
  async function saveCard(input: unknown): Promise<CharacterCard> {
    const src = cardRecOf(input);
    if (src === null) throw new Error("invalid card");
    const name = cardTrimmed(src["name"]);
    if (name === "") throw new Error("角色名不能为空");
    const exampleQA: ExamplePair[] = [];
    const rawQA = cardArrOf(src["exampleQA"]);
    for (let i = 0; i < rawQA.length && i < 2; i++) {
      const pair = cardRecOf(rawQA[i]);
      exampleQA.push({
        user: pair === null ? "" : pair["user"] || "",
        character: pair === null ? "" : pair["character"] || "",
      });
    }
    const card: CharacterCard = {
      id: cardStrOf(src["id"]) || "u_" + ports.now().toString(36),
      name: name,
      gender: cardStrOf(src["gender"]),
      age: cardStrOf(src["age"]),
      identity: cardStrOf(src["identity"]),
      scenario: cardStrOf(src["scenario"]),
      icon: cardStrOf(src["icon"]) || "🙂",
      enableAffection: src["enableAffection"] !== false,
      personality: cardStrOf(src["personality"]),
      speakingStyle: cardStrOf(src["speakingStyle"]),
      rules: cardArrOf(src["rules"]).slice(0, 3),
      openingLine: cardStrOf(src["openingLine"]),
      exampleQA: exampleQA,
      affectionThresholds: cardArrOf(src["affectionThresholds"]),
      avatar: cardStrOf(src["avatar"]),
      spec: normalizeSpec(src["spec"]),
    };
    // The panel relies on fixed slots; a card with fewer would render empty inputs out of range
    while (card.rules.length < 3) card.rules.push("");
    while (card.exampleQA.length < 2) card.exampleQA.push({ user: "", character: "" });
    await cards.put(card);
    ports.onCardMetaBump(card.id);
    await refresh();
    ports.notify();
    return card;
  }

  /**
   * Remove everything the card left behind: the affection row, the fired-band record, queued
   * threshold events, its scene slot, its capability entry and its memory namespace.
   * Lorebook entries are unbound rather than deleted, because the text is usually worth keeping.
   */
  async function cascadeCleanupCard(id: string): Promise<void> {
    if (id === "") return;
    await cards.removeAffection(id);
    storage.removeItem(KEY_TRIGGERED_PREFIX + id);
    const pending = readJsonArray(KEY_PENDING_EVENTS);
    const left: unknown[] = [];
    for (let i = 0; i < pending.length; i++) {
      const ev = cardRecOf(pending[i]);
      if (ev === null || ev["cardId"] !== id) left.push(pending[i]);
    }
    if (left.length > 0) storage.setItem(KEY_PENDING_EVENTS, JSON.stringify(left));
    else storage.removeItem(KEY_PENDING_EVENTS);
    ports.onSceneRemove(id);
    const capsRaw = readJson(KEY_CHAR_CAPS);
    const caps = cardRecOf(capsRaw);
    if (caps !== null && Object.prototype.hasOwnProperty.call(caps, id)) {
      delete caps[id];
      storage.setItem(KEY_CHAR_CAPS, JSON.stringify(caps));
    }
    await ports.onCardMemoryRemove(id);
    ports.onLorebookUnbind(id);
  }

  /**
   * Delete a card and its dependants. Clearing the active card goes through {@link setActiveId}
   * so the "no active card" state reaches every listener by the same path as a manual clear.
   */
  async function deleteCard(id: string): Promise<void> {
    if (id === "") return;
    await cards.remove(id);
    ports.onCardTombstone(id);
    await cascadeCleanupCard(id);
    if (currentCardId() === id) setActiveId("");
    else {
      await refresh();
      ports.notify();
    }
  }

  /** Re-read and notify; the panel redraw is the wiring's business, since only it owns the DOM. */
  async function reload(): Promise<void> {
    await refresh();
    ports.notify();
  }

  return {
    refresh: refresh,
    getActiveCard: getActiveCard,
    setActiveId: setActiveId,
    getActiveRelation: getActiveRelation,
    setActiveRelation: setActiveRelation,
    getActiveEmotion: getActiveEmotion,
    setActiveEmotion: setActiveEmotion,
    getActiveAffection: getActiveAffection,
    setActiveAffection: setActiveAffection,
    adjustActiveAffection: adjustActiveAffection,
    resetActiveAffection: resetActiveAffection,
    parseAffectionTag: parseAffectionTag,
    listAllCards: listAllCards,
    getAllCards: getAllCards,
    saveCard: saveCard,
    deleteCard: deleteCard,
    getPendingThresholdEvents: getPendingThresholdEvents,
    clearPendingThresholdEvents: clearPendingThresholdEvents,
    resetThresholdTriggers: resetThresholdTriggers,
    reload: reload,
    relations: RELATIONS,
    builtinEmotions: EMOTIONS,
    affectionStages: AFFECTION_STAGES,
    affectionInit: AFFECTION_INIT,
  };
}
