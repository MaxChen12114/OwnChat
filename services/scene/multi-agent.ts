/**
 * Multi-character scene: the mode flag, the card ids currently on stage, and the name-matching rules
 * a model uses to call one more character onto that stage.
 *
 * Only ids are persisted. Cards are resolved from the character domain on every read — the character
 * panel is the single writer of card data, so a cached copy here would go stale the moment a card is
 * edited, with no invalidation path that does not turn into a second source of truth.
 *
 * Two rules carry the behaviour users actually notice:
 *
 *   1. Every mutation dispatches `multi-agent:changed` and then `character:changed`. The second event
 *      is compatibility, not design: the character panel still re-renders on it, and dropping it
 *      leaves a stale roster on screen.
 *   2. Summoning switches multi mode on by itself. A model that names a character expects that
 *      character to be on stage from the next turn; requiring a second instruction is the bug users
 *      report as "the AI keeps talking to itself".
 *
 * Name matching is deliberately three-tiered (exact, normalised, bidirectional substring) because
 * models re-type names with punctuation and honorifics. The substring tier requires two characters on
 * both sides, so a one-character name cannot match everything on the shelf.
 *
 * @module services/scene/multi-agent
 */

/** A role card from this module's point of view: only `id` / `name` / `icon` are ever read. */
export interface SceneCard {
  [key: string]: unknown;
  id?: unknown;
  name?: unknown;
  icon?: unknown;
}

/** The persisted key/value surface (localStorage in the browser, a plain map in tests). */
export interface SceneStorage {
  read(key: string): string | null;
  write(key: string, value: string): void;
}

/**
 * The character domain, as this module uses it. All three members are optional in practice — the
 * facade may not be mounted yet when the scene is read during boot — so the wiring is what degrades
 * them to empty values and no-ops. `setActiveId` receives `""` to clear the active card.
 */
export interface SceneCharacters {
  listAllCards(): readonly unknown[];
  archetypes(): readonly unknown[];
  setActiveId(id: string): void;
}

/** Change notification. The wiring owns the event names and the second (compatibility) dispatch. */
export interface SceneEvents {
  changed(detail: SceneChange): void;
}

/** Payload carried by the change event. */
export interface SceneChange {
  isMulti: boolean;
  sceneIds: string[];
}

export interface ScenePorts {
  storage: SceneStorage;
  characters: SceneCharacters;
  events: SceneEvents;
}

/** The members the frozen page contract exposes. */
export interface Scene {
  isMulti(): boolean;
  setMulti(on: boolean): void;
  getSceneIds(): string[];
  setSceneIds(ids: unknown): string[];
  isInScene(id: string): boolean;
  addToScene(id: string): void;
  removeFromScene(id: string): void;
  getSceneCards(): SceneCard[];
  getSceneOtherNames(): string[];
  getSummonableNames(excludeId?: string): string[];
  summonByName(name: string): SceneCard | null;
}

const KEY_MODE = "tavern_multi_agent_mode_v1";
const KEY_SCENE = "tavern_active_scene_v1";
const KEY_ACTIVE_CHAR = "tavern_active_char_id";

/** Characters whose names or ids are not strings are corrupt records; they are skipped, not coerced. */
function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Normalise a name for comparison: strip the punctuation and bracketing models like to add, fold case.
 * Chinese brackets are included on purpose — `【小红】` and `小红` are the same character to a reader.
 */
function normalizeName(value: unknown): string {
  return String(value === null || value === undefined ? "" : value)
    .replace(/[\s【】\[\]()（）「」·,，.。!！?？~]/g, "")
    .toLowerCase();
}

/**
 * Create the scene over the given ports.
 *
 * @param ports Storage, character lookups and a change sink. Nothing is read or written until a
 *   member is called, so the factory is safe during boot while the character facade is still absent.
 * @returns The ten documented members. Card objects are the *same references* the character domain
 *   returned — callers mutate them (icon, affection) and expect their edits to stick.
 */
export function createScene(ports: ScenePorts): Scene {
  const storage = ports.storage;
  const characters = ports.characters;
  const events = ports.events;

  /** Fire the change event with the values the listeners will re-read anyway. */
  function emit(): void {
    events.changed({ isMulti: isMulti(), sceneIds: getSceneIds() });
  }

  function isMulti(): boolean {
    return storage.read(KEY_MODE) === "multi";
  }

  function setMulti(on: boolean): void {
    storage.write(KEY_MODE, on ? "multi" : "single");
    emit();
  }

  /**
   * Ids on stage, in insertion order.
   *
   * A corrupt or unreachable store reads as an empty scene rather than throwing: the scene is
   * decoration around the transcript, and a failed read must not take the send path down with it.
   */
  function getSceneIds(): string[] {
    try {
      const parsed: unknown = JSON.parse(storage.read(KEY_SCENE) || "[]");
      if (!Array.isArray(parsed)) return [];
      const out: string[] = [];
      for (let i = 0; i < parsed.length; i++) {
        const id: unknown = parsed[i];
        if (typeof id === "string" && id) out.push(id);
      }
      return out;
    } catch (e) {
      return [];
    }
  }

  function writeSceneIds(ids: readonly string[]): void {
    storage.write(KEY_SCENE, JSON.stringify(ids));
    emit();
  }

  /**
   * Replace the whole roster in one write (roleplay checkpoint restore). Dedupes and drops
   * non-strings; one change event, not one per member, so listeners never see a half-applied scene.
   */
  function setSceneIds(ids: unknown): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    if (Array.isArray(ids)) {
      for (let i = 0; i < ids.length; i++) {
        const id: unknown = ids[i];
        if (typeof id !== "string" || !id || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
      }
    }
    writeSceneIds(out);
    return getSceneIds();
  }

  function isInScene(id: string): boolean {
    return getSceneIds().includes(id);
  }

  /** Adding an id already on stage is a no-op: no write, and therefore no change event. */
  function addToScene(id: string): void {
    if (!id) return;
    const ids = getSceneIds();
    if (ids.includes(id)) return;
    ids.push(id);
    writeSceneIds(ids);
  }

  /**
   * Drop an id from the stage. When the dropped member was the active speaker, the first remaining
   * member becomes active (or the active card is cleared) — the event order is: roster first, then
   * speaker, so a listener that re-renders on the first event already sees the new roster.
   */
  function removeFromScene(id: string): void {
    if (!id) return;
    const ids = getSceneIds().filter((x) => x !== id);
    writeSceneIds(ids);
    const active = storage.read(KEY_ACTIVE_CHAR) || "";
    if (active === id) characters.setActiveId(ids[0] || "");
  }

  function cardOf(value: unknown): SceneCard | null {
    return isRecord(value) ? value : null;
  }

  function idOf(card: SceneCard): string {
    return textOf(card.id);
  }

  function nameOf(card: SceneCard): string {
    return textOf(card.name);
  }

  /** Collect the two card pools as typed cards, keeping the original object identities. */
  function collect(source: readonly unknown[]): SceneCard[] {
    const out: SceneCard[] = [];
    for (let i = 0; i < source.length; i++) {
      const card = cardOf(source[i]);
      if (card) out.push(card);
    }
    return out;
  }

  function scenePool(): SceneCard[] {
    return collect(characters.listAllCards());
  }

  function archetypePool(): SceneCard[] {
    return collect(characters.archetypes());
  }

  /**
   * Cards on stage, resolved id by id. Saved cards win over archetypes with the same id; an id that
   * no longer resolves anywhere is skipped instead of yielding a hole in the roster.
   */
  function getSceneCards(): SceneCard[] {
    const ids = getSceneIds();
    if (!ids.length) return [];
    const saved = new Map<string, SceneCard>();
    const cards = scenePool();
    for (let i = 0; i < cards.length; i++) saved.set(idOf(cards[i]), cards[i]);
    const archs = archetypePool();
    const out: SceneCard[] = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      let hit = saved.get(id);
      if (!hit) {
        for (let j = 0; j < archs.length; j++) {
          if (idOf(archs[j]) === id) {
            hit = archs[j];
            break;
          }
        }
      }
      if (hit) out.push(hit);
    }
    return out;
  }

  /**
   * Names of the other characters on stage, i.e. everyone a reply could hand the turn to.
   *
   * Empty in single mode (there is nobody else) and with fewer than two ids, which is the same
   * condition the console uses to decide whether to show itself at all.
   */
  function getSceneOtherNames(): string[] {
    if (!isMulti()) return [];
    const ids = getSceneIds();
    if (ids.length < 2) return [];
    const active = storage.read(KEY_ACTIVE_CHAR) || "";
    const cards = getSceneCards();
    const byId = new Map<string, SceneCard>();
    for (let i = 0; i < cards.length; i++) byId.set(idOf(cards[i]), cards[i]);
    const out: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (id === active) continue;
      const card = byId.get(id);
      if (!card) continue;
      const name = nameOf(card);
      if (name) out.push(name);
    }
    return out;
  }

  /**
   * Resolve a typed name to a card, saved cards first, then archetypes.
   *
   * Three tiers, tried in order: exact match on the raw name, exact match after
   * {@link normalizeName}, then bidirectional substring. The last tier is what lets `小红` find
   * `【小红】` and `小红姐姐`, and the two-character floor keeps a single-character name from matching
   * a whole shelf.
   *
   * @returns The card itself (not a copy), or `null` when nothing matches.
   */
  function findAnyCardByName(name: string): SceneCard | null {
    if (!name) return null;
    const pool = scenePool().concat(archetypePool());
    if (!pool.length) return null;
    const raw = name.trim();
    for (let i = 0; i < pool.length; i++) if (pool[i].name === raw) return pool[i];
    const wanted = normalizeName(raw);
    if (!wanted) return null;
    for (let i = 0; i < pool.length; i++) if (normalizeName(pool[i].name) === wanted) return pool[i];
    for (let i = 0; i < pool.length; i++) {
      const candidate = normalizeName(pool[i].name);
      if (!candidate || candidate.length < 2 || wanted.length < 2) continue;
      if (candidate.includes(wanted) || wanted.includes(candidate)) return pool[i];
    }
    return null;
  }

  /**
   * Names a model may still summon: saved cards only (archetypes are templates, not people the user
   * has agreed to), minus whoever is already on stage, minus the current speaker.
   */
  function getSummonableNames(excludeId?: string): string[] {
    const exclude = typeof excludeId === "string" ? excludeId : "";
    const scene = new Set(getSceneIds());
    const cards = scenePool();
    const out: string[] = [];
    for (let i = 0; i < cards.length; i++) {
      const id = idOf(cards[i]);
      const name = nameOf(cards[i]);
      if (!id || !name) continue;
      if (scene.has(id) || id === exclude) continue;
      out.push(name);
    }
    return out;
  }

  /**
   * Bring a character onto the stage by name.
   *
   * Side effects, in order: multi mode is switched on if it was off, then the card is added. Both go
   * through the public members, so both emit — a summon therefore produces two change events, which
   * the console already tolerates (it re-renders idempotently).
   *
   * @returns The resolved card on success, `null` when the name matches nothing.
   */
  function summonByName(name: string): SceneCard | null {
    const card = findAnyCardByName(name);
    if (!card) return null;
    if (!isMulti()) setMulti(true);
    const id = idOf(card);
    if (!isInScene(id)) addToScene(id);
    return card;
  }

  return {
    isMulti,
    setMulti,
    getSceneIds,
    setSceneIds,
    isInScene,
    addToScene,
    removeFromScene,
    getSceneCards,
    getSceneOtherNames,
    getSummonableNames,
    summonByName,
  };
}

/**
 * Rounds for one relay / discussion run, as typed into the prompt: 1–1000, and the previous value
 * when the field is empty or unparsable.
 *
 * @param raw The dialog value (a string from `prompt`, but numbers are accepted).
 * @param fallback The current round limit, used when `raw` carries no number.
 */
export function clampRounds(raw: unknown, fallback: number): number {
  const n = parseInt(String(raw || fallback), 10) || fallback;
  return Math.max(1, Math.min(1000, n));
}
