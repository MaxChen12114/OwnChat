(function () {
/**
 * Pure logic for the lorebook (world-book) data layer: entry normalization, storage reads,
 * send-time filtering and the two import formats.
 *
 * Storage, change notification, clock and randomness arrive through {@link LorebookPorts};
 * this module touches no `window`, `localStorage` or `document`. The browser adapter and the
 * frozen `__lorebook` name live in l0/wiring/lorebook.js.
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
                            
                                      
                                            
 

/** A normalized entry; this is also the shape written to disk. Dirty fields are dropped or defaulted. */
                            
             
               
                                                                                                               
                     
                  
                                                                                                                             
                    
                                                                                     
                   
                              
                                                                                       
                      
                                                                                       
                   
                                                                               
                 
     
                                                                                              
                                                                                                
                                                                                               
                                                              
     
                               
                      
                                                                                                
                    
                 
                                               
                       
                           
                                                                                                   
                           
 

/** Query for the active set. `text` is the recent conversation text, `cardId` the current card id; both default to "". */
                              
                
                  
 

/** Import options: `merge=true` appends with fresh ids, otherwise the table is replaced. */
                                
                  
 

/**
 * Environment ports. The window adapter and every try/catch sit in the wiring layer, so this
 * module may assume the ports honour their contract.
 */
                                
                     
                                                                          
                 
                                                   
                
                                                 
                   
 

/** Public surface, name for name identical to the old window contract. */
                              
                        
                                         
                                       
                                
                                                    
                           
                                                        
                                                                    
                 
 

/**
 * unknown -> plain-object copy; arrays, null and scalars all become null. Copied via
 * Object.entries rather than indexed because `typeof x === "object"` only narrows to object,
 * and reading through an index signature yields `any`.
 */
function lbRecOf(value         )                                 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const out                          = {};
  const entries = Object.entries(value);
  for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  return out;
}

/** Strings pass through; everything else becomes "". */
function lbStrOf(value         )         {
  return typeof value === "string" ? value : "";
}

/**
 * Create a lorebook instance. It holds no mutable state — every read and write goes through the
 * storage port — so several instances share one dataset.
 * @param ports - storage, change notification, clock and randomness; uids are built from `now()` plus `random()`.
 * @returns The public surface, name for name identical to the old window contract. A failed write does not throw, yet the change event still fires.
 */
function createLorebook(ports               )              {
  const storage = ports.storage;
  const LS_KEY = "tavern_lorebook_v1";

  /** Read failures degrade to an empty lorebook: private mode and quota exhaustion are not the caller's fault. */
  function read()                {
    try {
      return storage.getItem(LS_KEY);
    } catch (e) {
      return null;
    }
  }

  /** uid looks like `lb_<timestamp base36><4 random chars>`; it only has to avoid collisions within one machine's data, not globally. */
  function uid()         {
    return "lb_" + ports.now().toString(36) + ports.random().toString(36).slice(2, 6);
  }

  /** Keyword normalization: strings split on ASCII/CJK commas, semicolons and newlines; arrays are trimmed item by item; empty items are dropped. */
  function keywordsOf(value         )           {
    let raw          = value;
    if (typeof raw === "string") raw = raw.split(/[,，;；\n]/);
    if (!Array.isArray(raw)) return [];
    const out           = [];
    for (let i = 0; i < raw.length; i++) {
      const item          = raw[i];
      const k = (item === null || item === undefined ? "" : String(item)).trim();
      if (k !== "") out.push(k);
    }
    return out;
  }

  /** Finite numbers pass through; everything else goes through `parseInt(…, 10) || 0`, so non-numeric input lands on 0. */
  function priorityOf(value         )         {
    if (typeof value === "number" && isFinite(value)) return value;
    return parseInt(String(value), 10) || 0;
  }

  /** Any input -> a valid entry: missing fields get defaults, dirty fields are dropped, an empty id is generated on the spot. */
  function normalize(entry         )            {
    const src = lbRecOf(entry);
    const e                          = src === null ? {} : src;
    const idRaw = lbStrOf(e["id"]);
    const scopeRaw          = e["scope"];
    const out            = {
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
  function load()              {
    const raw = read();
    if (raw === null || raw === "") return [];
    let parsed         ;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    const out              = [];
    for (let i = 0; i < parsed.length; i++) {
      const item          = parsed[i];
      out.push(normalize(item));
    }
    return out;
  }

  /** Write and emit. A failed write does not throw and the event still fires — listeners re-read the old value, which matches what is on disk. */
  function save(arr             )       {
    const rows              = [];
    for (let i = 0; i < arr.length; i++) rows.push(normalize(arr[i]));
    try {
      storage.setItem(LS_KEY, JSON.stringify(rows));
    } catch (e) {}
    ports.notify();
  }

  function getAll()              {
    return load();
  }

  function getEntry(id        )                   {
    const arr = load();
    for (let i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i];
    return null;
  }

  function saveEntry(entry         )            {
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

  function deleteEntry(id        )       {
    const arr = load();
    const kept              = [];
    for (let i = 0; i < arr.length; i++) if (arr[i].id !== id) kept.push(arr[i]);
    save(kept);
  }

  /**
   * Called from the send path: the entries to inject this turn, highest priority first.
   * The four gates are, in order, disabled, empty content, perCard not bound to this card and
   * keyword miss; alwaysOn lifts the last one only.
   */
  function getActiveEntries(opts              )              {
    const o              = opts === undefined || opts === null ? {} : opts;
    // Missing and falsy both read as "", which is what the old `opts.text || ""` observed
    const text = String(o.text || "").toLowerCase();
    const cardId = o.cardId || "";
    const all = load();
    const hit              = [];
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
  function exportAll()              {
    return load();
  }

  /**
   * Import a whole table; entries with both empty content and empty name are dropped.
   * With `merge=true` they are appended with fresh ids so they cannot shadow existing entries,
   * otherwise the table is replaced.
   * @param arr - a parsed external JSON value; anything that is not an array is a no-op.
   * @returns How many entries were written.
   */
  function importAll(arr         , opts                )         {
    const o                = opts === undefined || opts === null ? {} : opts;
    if (!Array.isArray(arr)) return 0;
    const add              = [];
    for (let i = 0; i < arr.length; i++) {
      const item          = arr[i];
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
  function parseSillyTavernBook(data         , source         )              {
    const dataRec = lbRecOf(data);
    let book                                 = dataRec;
    if (dataRec !== null) {
      const inner = lbRecOf(dataRec["character_book"]);
      if (inner !== null) book = inner;
      else {
        const wrap = lbRecOf(dataRec["data"]);
        const nested = wrap === null ? null : lbRecOf(wrap["character_book"]);
        if (nested !== null) book = nested;
      }
    }
    let entriesRaw          = book === null ? undefined : book["entries"];
    // Falsy rather than undefined: an empty array or object must also fall through to data.entries, as before
    if (!entriesRaw) {
      const wrap = book === null ? null : lbRecOf(book["data"]);
      if (wrap !== null) entriesRaw = wrap["entries"];
    }
    if (!entriesRaw || typeof entriesRaw !== "object") return [];

    const list            = [];
    if (Array.isArray(entriesRaw)) {
      for (let i = 0; i < entriesRaw.length; i++) list.push(entriesRaw[i]);
    } else {
      const map = lbRecOf(entriesRaw);
      if (map === null) return [];
      const keys = Object.keys(map);
      for (let i = 0; i < keys.length; i++) list.push(map[keys[i]]);
    }

    const out              = [];
    for (let i = 0; i < list.length; i++) {
      const en = lbRecOf(list[i]);
      if (en === null) continue;
      const contentRaw          = en["content"];
      const content = typeof contentRaw === "string" ? contentRaw : "";
      if (content.trim() === "") continue;
      let keys          = en["keys"];
      if (keys === undefined || keys === null || keys === false || keys === "") keys = en["key"];
      if (typeof keys === "string") keys = keys.split(/[,，]/);
      const order = en["insertion_order"];
      const alt = en["order"];
      // Round-trip fields: the CCV2 card-book names sit top-level, the ST world-info ones hide
      // inside `extensions`. `selective` stays honest to an explicit `false` — only an entry with
      // secondary keys and no explicit flag reads as selective.
      const ext = lbRecOf(en["extensions"]);
      let secondaryRaw          = en["secondary_keys"];
      if (secondaryRaw === undefined || secondaryRaw === null) secondaryRaw = en["keysecondary"];
      if (secondaryRaw === undefined || secondaryRaw === null) secondaryRaw = ext === null ? undefined : ext["keysecondary"];
      let position          = en["position"];
      if (typeof position === "number") {
        // ST world-info files number the position (0 before char / 1 after char); the depth and
        // AN codes are a different insertion model, so they are left absent rather than guessed.
        position = position === 0 ? "before_char" : position === 1 ? "after_char" : "";
      }
      const depthRaw          = ext !== null && ext["depth"] !== undefined ? ext["depth"] : en["depth"];
      const probRaw          = ext !== null && ext["probability"] !== undefined ? ext["probability"] : en["probability"];
      const useProbRaw          =
        ext !== null && ext["useProbability"] !== undefined ? ext["useProbability"] : en["useProbability"];
      const logicRaw          = ext === null ? undefined : ext["selectiveLogic"];
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

// Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name.
// The implementation lives in services/data/lorebook.ts; every window bridge is here — the
// localStorage trio, change-event dispatch, and the clock / random source for uid generation.
// The old module reached for localStorage and dispatchEvent inline; the service now takes them as
// ports, and the same semantics move to this file unchanged.
(function () {
  if (window.__lorebook) return;

  var storage = {
    getItem: function (key) {
      try {
        return window.localStorage.getItem(key);
      } catch (e) {
        return null;
      }
    },
    setItem: function (key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch (e) {}
    },
  };

  var api = createLorebook({
    storage: storage,
    // The editor's world-building tab listens for this event and repaints. A failed dispatch must not
    // fail the save that triggered it.
    notify: function () {
      try {
        window.dispatchEvent(new Event("lorebook:changed"));
      } catch (e) {}
    },
    now: function () {
      return Date.now();
    },
    random: function () {
      return Math.random();
    },
  });

  window.__lorebook = {
    getAll: api.getAll,
    getEntry: api.getEntry,
    saveEntry: api.saveEntry,
    deleteEntry: api.deleteEntry,
    getActiveEntries: api.getActiveEntries,
    exportAll: api.exportAll,
    importAll: api.importAll,
    parseSillyTavernBook: api.parseSillyTavernBook,
    LS_KEY: api.LS_KEY,
  };
})();

globalThis.createLorebook = createLorebook;
})();
