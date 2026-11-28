/**
 * Pure logic for the lorebook (world-book) data layer: entry normalization, storage reads,
 * send-time filtering and the two import formats.
 *
 * Storage, change notification, clock and randomness arrive through {@link LorebookPorts};
 * this module touches no `window`, `localStorage` or `document`. The browser adapter and the
 * frozen `lorebookSvc` name live in tooling/l0/wiring/lorebook.js.
 *
 * Entries live in localStorage rather than IndexedDB: the payload is small text, and LS is what
 * sync.js already dumps into the cloud KV, so "same lorebook on another device" comes for free
 * instead of needing a second IDB upload path.
 *
 * id / boundCardId / source accept strings only; numeric ids are dropped during normalization
 * and every consumer compares them as strings.
 * @module services/data/lorebook
 */

/** Key-value storage port: window.localStorage in the browser, a Map in the Node tests. */
export interface KvStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** A normalized entry; this is also the shape written to disk. Dirty fields are dropped or defaulted. */
export interface LoreEntry {
  id: string;
  name: string;
  /** Injected only when the recent conversation text matches. Empty list plus `alwaysOn=false` never fires. */
  keywords: string[];
  content: string;
  /** Injected unconditionally, but it lifts the keyword gate only: disabled, empty content and card mismatch still block. */
  alwaysOn: boolean;
  /** Higher sorts first; ties keep their relative order, i.e. the sort is stable. */
  priority: number;
  scope: "global" | "perCard";
  /** Consulted only when `scope="perCard"`; an empty string means bound to no card. */
  boundCardId: string;
  /** Only an explicit `false` disables an entry; a missing field counts as enabled. */
  enabled: boolean;
  /** Provenance marker for the editor only; never consulted when filtering. */
  source: string;
  /**
   * SillyTavern round-trip fields, all optional: absent means "the source did not say", so an
   * export omits them instead of inventing a default. None of them is consumed by the send-time
   * filter yet — they are stored and written back verbatim; injection semantics are a separate
   * unit of work and must not drift in through normalization.
   */
  secondaryKeywords?: string[];
  selective?: boolean;
  /** CCV2 string form (`before_char` / `after_char`); ST's numeric form maps 0/1 onto these. */
  position?: string;
  depth?: number;
  /** Trigger probability clamped to 0..100. */
  probability?: number;
  useProbability?: boolean;
  /** Raw ST logic code (0 AND_ANY / 1 NOT_ALL / 2 NOT_ANY / 3 AND_ALL), never interpreted here. */
  selectiveLogic?: unknown;
}

/** Query for the active set. `text` is the recent conversation text, `cardId` the current card id; both default to "". */
export interface ActiveQuery {
  text?: string;
  cardId?: string;
}

/** Import options: `merge=true` appends with fresh ids, otherwise the table is replaced. */
export interface ImportOptions {
  merge?: boolean;
}

/**
 * Environment ports. The window adapter and every try/catch sit in the wiring layer, so this
 * module may assume the ports honour their contract.
 */
export interface LorebookPorts {
  storage: KvStorage;
  /** Emit the change event; the editor's lorebook tab refreshes on it. */
  notify(): void;
  /** Current timestamp, used as the uid prefix. */
  now(): number;
  /** Random in [0,1), used as the uid suffix. */
  random(): number;
}

/** Public surface, name for name identical to the old window contract. */
export interface LorebookApi {
  getAll(): LoreEntry[];
  getEntry(id: string): LoreEntry | null;
  saveEntry(entry: unknown): LoreEntry;
  deleteEntry(id: string): void;
  getActiveEntries(opts?: ActiveQuery): LoreEntry[];
  exportAll(): LoreEntry[];
  importAll(arr: unknown, opts?: ImportOptions): number;
  parseSillyTavernBook(data: unknown, source?: string): LoreEntry[];
  LS_KEY: string;
}

/**
 * unknown -> plain-object copy; arrays, null and scalars all become null. Copied via
 * Object.entries rather than indexed because `typeof x === "object"` only narrows to object,
 * and reading through an index signature yields `any`.
 */
function lbRecOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  return out;
}

/** Strings pass through; everything else becomes "". */
function lbStrOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Create a lorebook instance. It holds no mutable state — every read and write goes through the
 * storage port — so several instances share one dataset.
 * @param ports - storage, change notification, clock and randomness; uids are built from `now()` plus `random()`.
 * @returns The public surface, name for name identical to the old window contract. A failed write does not throw, yet the change event still fires.
 */
export function createLorebook(ports: LorebookPorts): LorebookApi {
  const storage = ports.storage;
  const LS_KEY = "tavern_lorebook_v1";

  /** Read failures degrade to an empty lorebook: private mode and quota exhaustion are not the caller's fault. */
  function read(): string | null {
    try {
      return storage.getItem(LS_KEY);
    } catch (e) {
      return null;
    }
  }

  /** uid looks like `lb_<timestamp base36><4 random chars>`; it only has to avoid collisions within one machine's data, not globally. */
  function uid(): string {
    return "lb_" + ports.now().toString(36) + ports.random().toString(36).slice(2, 6);
  }

  /** Keyword normalization: strings split on ASCII/CJK commas, semicolons and newlines; arrays are trimmed item by item; empty items are dropped. */
  function keywordsOf(value: unknown): string[] {
    let raw: unknown = value;
    if (typeof raw === "string") raw = raw.split(/[,，;；\n]/);
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (let i = 0; i < raw.length; i++) {
      const item: unknown = raw[i];
      const k = (item === null || item === undefined ? "" : String(item)).trim();
      if (k !== "") out.push(k);
    }
    return out;
  }

  /** Finite numbers pass through; everything else goes through `parseInt(…, 10) || 0`, so non-numeric input lands on 0. */
  function priorityOf(value: unknown): number {
    if (typeof value === "number" && isFinite(value)) return value;
    return parseInt(String(value), 10) || 0;
  }

  /** Any input -> a valid entry: missing fields get defaults, dirty fields are dropped, an empty id is generated on the spot. */
  function normalize(entry: unknown): LoreEntry {
    const src = lbRecOf(entry);
    const e: Record<string, unknown> = src === null ? {} : src;
    const idRaw = lbStrOf(e["id"]);
    const scopeRaw: unknown = e["scope"];
    const out: LoreEntry = {
      id: idRaw === "" ? uid() : idRaw,
      name: String(e["name"] || "").trim(),
      keywords: keywordsOf(e["keywords"]),
      content: String(e["content"] || ""),
      alwaysOn: !!e["alwaysOn"],
      priority: priorityOf(e["priority"]),
      scope: scopeRaw === "perCard" ? "perCard" : "global",
      boundCardId: lbStrOf(e["boundCardId"]),
      enabled: e["enabled"] !== false,
      source: lbStrOf(e["source"]),
    };
    // Optional round-trip fields are assigned only when the input carries them, so legacy rows
    // keep their exact stored shape (JSON.stringify omits what stays unset).
    const secondary = keywordsOf(e["secondaryKeywords"]);
    if (secondary.length > 0) out.secondaryKeywords = secondary;
    if (e["selective"] === true) out.selective = true;
    const position = lbStrOf(e["position"]).trim();
    if (position !== "") out.position = position;
    if (typeof e["depth"] === "number" && isFinite(e["depth"])) out.depth = e["depth"];
    if (typeof e["probability"] === "number" && isFinite(e["probability"])) {
      out.probability = Math.max(0, Math.min(100, e["probability"]));
    }
    if (e["useProbability"] === true) out.useProbability = true;
    if (e["selectiveLogic"] !== undefined && e["selectiveLogic"] !== null) out.selectiveLogic = e["selectiveLogic"];
    return out;
  }

  /** Load and normalize. Broken JSON, a non-array and an empty string all read as an empty lorebook. */
  function load(): LoreEntry[] {
    const raw = read();
    if (raw === null || raw === "") return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    const out: LoreEntry[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const item: unknown = parsed[i];
      out.push(normalize(item));
    }
    return out;
  }

  /** Write and emit. A failed write does not throw and the event still fires — listeners re-read the old value, which matches what is on disk. */
  function save(arr: LoreEntry[]): void {
    const rows: LoreEntry[] = [];
    for (let i = 0; i < arr.length; i++) rows.push(normalize(arr[i]));
    try {
      storage.setItem(LS_KEY, JSON.stringify(rows));
    } catch (e) {}
    ports.notify();
  }

  function getAll(): LoreEntry[] {
    return load();
  }

  function getEntry(id: string): LoreEntry | null {
    const arr = load();
    for (let i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i];
    return null;
  }

  function saveEntry(entry: unknown): LoreEntry {
    const e = normalize(entry);
    const arr = load();
    let hit = -1;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].id === e.id) {
        hit = i;
        break;
      }
    }
    if (hit >= 0) arr[hit] = e;
    else arr.push(e);
    save(arr);
    return e;
  }

  function deleteEntry(id: string): void {
    const arr = load();
    const kept: LoreEntry[] = [];
    for (let i = 0; i < arr.length; i++) if (arr[i].id !== id) kept.push(arr[i]);
    save(kept);
  }

  /**
   * Called from the send path: the entries to inject this turn, highest priority first.
   * The four gates are, in order, disabled, empty content, perCard not bound to this card and
   * keyword miss; alwaysOn lifts the last one only.
   */
  function getActiveEntries(opts?: ActiveQuery): LoreEntry[] {
    const o: ActiveQuery = opts === undefined || opts === null ? {} : opts;
    // Missing and falsy both read as "", which is what the old `opts.text || ""` observed
    const text = String(o.text || "").toLowerCase();
    const cardId = o.cardId || "";
    const all = load();
    const hit: LoreEntry[] = [];
    for (let i = 0; i < all.length; i++) {
      const e = all[i];
      if (e.enabled === false) continue;
      if (e.content.trim() === "") continue;
      if (e.scope === "perCard" && !(e.boundCardId !== "" && e.boundCardId === cardId)) continue;
      if (e.alwaysOn) {
        hit.push(e);
        continue;
      }
      if (e.keywords.length === 0) continue;
      let matched = false;
      for (let k = 0; k < e.keywords.length; k++) {
        const kw = e.keywords[k].toLowerCase();
        if (kw !== "" && text.indexOf(kw) >= 0) {
          matched = true;
          break;
        }
      }
      if (matched) hit.push(e);
    }
    // Tie order relies on Array#sort being stable (required since ES2019); the editor lists entries in this order
    hit.sort(function (a, b) {
      return b.priority - a.priority;
    });
    return hit;
  }

  /** Export every entry for the "export JSON" button; differs from getAll in name only. */
  function exportAll(): LoreEntry[] {
    return load();
  }

  /**
   * Import a whole table; entries with both empty content and empty name are dropped.
   * With `merge=true` they are appended with fresh ids so they cannot shadow existing entries,
   * otherwise the table is replaced.
   * @param arr - a parsed external JSON value; anything that is not an array is a no-op.
   * @returns How many entries were written.
   */
  function importAll(arr: unknown, opts?: ImportOptions): number {
    const o: ImportOptions = opts === undefined || opts === null ? {} : opts;
    if (!Array.isArray(arr)) return 0;
    const add: LoreEntry[] = [];
    for (let i = 0; i < arr.length; i++) {
      const item: unknown = arr[i];
      const e = normalize(item);
      if (e.content.trim() !== "" || e.name !== "") add.push(e);
    }
    if (o.merge === true) {
      const cur = load();
      // merge must re-issue ids: importing this repo's own export would otherwise overwrite same-named entries
      for (let i = 0; i < add.length; i++) {
        add[i].id = uid();
        cur.push(add[i]);
      }
      save(cur);
    } else {
      save(add);
    }
    return add.length;
  }

  /**
   * Parse a SillyTavern v2 world book. `entries` may be an array or an "index -> entry" map, and
   * the input may be the world-info file itself or a character card (inlined `character_book`,
   * possibly nested one level deeper under `data`).
   * Entries with empty content are dropped; every other field takes the same normalization as
   * this repo's own format.
   * @param source - provenance written onto each entry; defaults to "SillyTavern".
   * @returns Normalized entries; an unrecognized shape yields an empty array instead of throwing.
   */
  function parseSillyTavernBook(data: unknown, source?: string): LoreEntry[] {
    const dataRec = lbRecOf(data);
    let book: Record<string, unknown> | null = dataRec;
    if (dataRec !== null) {
      const inner = lbRecOf(dataRec["character_book"]);
      if (inner !== null) book = inner;
      else {
        const wrap = lbRecOf(dataRec["data"]);
        const nested = wrap === null ? null : lbRecOf(wrap["character_book"]);
        if (nested !== null) book = nested;
      }
    }
    let entriesRaw: unknown = book === null ? undefined : book["entries"];
    // Falsy rather than undefined: an empty array or object must also fall through to data.entries, as before
    if (!entriesRaw) {
      const wrap = book === null ? null : lbRecOf(book["data"]);
      if (wrap !== null) entriesRaw = wrap["entries"];
    }
    if (!entriesRaw || typeof entriesRaw !== "object") return [];

    const list: unknown[] = [];
    if (Array.isArray(entriesRaw)) {
      for (let i = 0; i < entriesRaw.length; i++) list.push(entriesRaw[i]);
    } else {
      const map = lbRecOf(entriesRaw);
      if (map === null) return [];
      const keys = Object.keys(map);
      for (let i = 0; i < keys.length; i++) list.push(map[keys[i]]);
    }

    const out: LoreEntry[] = [];
    for (let i = 0; i < list.length; i++) {
      const en = lbRecOf(list[i]);
      if (en === null) continue;
      const contentRaw: unknown = en["content"];
      const content = typeof contentRaw === "string" ? contentRaw : "";
      if (content.trim() === "") continue;
      let keys: unknown = en["keys"];
      if (keys === undefined || keys === null || keys === false || keys === "") keys = en["key"];
      if (typeof keys === "string") keys = keys.split(/[,，]/);
      const order = en["insertion_order"];
      const alt = en["order"];
      // Round-trip fields: the CCV2 card-book names sit top-level, the ST world-info ones hide
      // inside `extensions`. `selective` stays honest to an explicit `false` — only an entry with
      // secondary keys and no explicit flag reads as selective.
      const ext = lbRecOf(en["extensions"]);
      let secondaryRaw: unknown = en["secondary_keys"];
      if (secondaryRaw === undefined || secondaryRaw === null) secondaryRaw = en["keysecondary"];
      if (secondaryRaw === undefined || secondaryRaw === null) secondaryRaw = ext === null ? undefined : ext["keysecondary"];
      let position: unknown = en["position"];
      if (typeof position === "number") {
        // ST world-info files number the position (0 before char / 1 after char); the depth and
        // AN codes are a different insertion model, so they are left absent rather than guessed.
        position = position === 0 ? "before_char" : position === 1 ? "after_char" : "";
      }
      const depthRaw: unknown = ext !== null && ext["depth"] !== undefined ? ext["depth"] : en["depth"];
      const probRaw: unknown = ext !== null && ext["probability"] !== undefined ? ext["probability"] : en["probability"];
      const useProbRaw: unknown =
        ext !== null && ext["useProbability"] !== undefined ? ext["useProbability"] : en["useProbability"];
      const logicRaw: unknown = ext === null ? undefined : ext["selectiveLogic"];
      const secondaryList = keywordsOf(secondaryRaw);
      const selective =
        en["selective"] === true || (secondaryList.length > 0 && en["selective"] === undefined);
      out.push(
        normalize({
          name: en["comment"] || en["name"] || "",
          keywords: keys,
          content: content,
          alwaysOn: !!(en["constant"] || en["alwaysOn"]),
          priority: typeof order === "number" ? order : typeof alt === "number" ? alt : 0,
          enabled: !(en["disable"] === true || en["enabled"] === false),
          scope: "global",
          source: source === undefined || source === "" ? "SillyTavern" : source,
          secondaryKeywords: secondaryList,
          selective: selective,
          position: position,
          depth: depthRaw,
          probability: probRaw,
          useProbability: useProbRaw,
          selectiveLogic: logicRaw,
        })
      );
    }
    return out;
  }

  return {
    getAll: getAll,
    getEntry: getEntry,
    saveEntry: saveEntry,
    deleteEntry: deleteEntry,
    getActiveEntries: getActiveEntries,
    exportAll: exportAll,
    importAll: importAll,
    parseSillyTavernBook: parseSillyTavernBook,
    LS_KEY: LS_KEY,
  };
}
