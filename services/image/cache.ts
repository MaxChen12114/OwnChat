/**
 * Prompt cache for image generation: an identical prompt asked again within the TTL is answered
 * from the previous result, so it neither reaches the upstream nor burns a daily quota slot.
 *
 * Only synchronous text-to-image calls are considered, only `n === 1` (a batch would need one
 * entry per image), and only `http(s)` URLs are stored — a `data:` URL would put a base64 payload
 * into localStorage and blow its quota. Entries expire after six hours because the upstream links
 * they hold are themselves short-lived.
 *
 * This module is the arithmetic: hashing, the TTL/LRU trim, the on/off flag. The wiring layer owns
 * localStorage, the fetch interception, the change event and the Response object handed back on a
 * hit. `cacheRequest` deliberately returns the prompt alongside the key so the wiring layer can
 * record a result without re-parsing the request body.
 * @module services/image/cache
 */

export interface CacheStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface CacheStats {
  count: number;
  saved: number;
}

export interface CachePorts {
  storage: CacheStorage;
  /** Clock port (epoch ms); the tests pin it, the browser uses the wall clock. */
  now?(): number;
  /** Called after every mutation, once the state on disk is consistent again. */
  notify(s: CacheStats): void;
}

export interface ImageCache {
  get(key: unknown): string | null;
  put(key: unknown, url: unknown, prompt: unknown): void;
  bumpSaved(): void;
  clear(): void;
  stats(): CacheStats;
  isEnabled(): boolean;
  setEnabled(v: unknown): void;
}

/** A cacheable request: the entry key plus the prompt to store with a fresh result. */
export interface CacheRequest {
  key: string;
  prompt: string;
}

interface CacheState {
  /** The whole parsed object, so keys written by an older build survive a round trip. */
  root: Record<string, unknown>;
  entries: Record<string, unknown>;
  saved: number;
}

const LS_CACHE = "cfw_image_cache_v1";
const LS_ON = "cfw_image_cache_enabled_v1";
const MAX_ENTRIES = 80;
const TTL_MS = 6 * 3600 * 1000;
const GEN_MARK = "images/generations";
const ASYNC_MARK = "async/";

function recOf(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

/** djb2-xor over UTF-16 code units, backwards. Short keys keep the stored JSON small. */
export function hashKey(s: string): string {
  let h = 5381;
  let i = s.length;
  while (i) {
    h = (h * 33) ^ s.charCodeAt(--i);
  }
  return "k" + (h >>> 0).toString(36);
}

/**
 * Key for a generation body, or `null` when it cannot be cached (no prompt). Defaults must stay
 * in step with the upstream's own defaults: a request that omits `model`/`size` is the same
 * request as one naming them explicitly.
 */
export function keyFromBody(body: unknown): string | null {
  const o = recOf(body);
  const model = str(o.model) || "z-image-turbo";
  const size = str(o.size) || "1024x1024";
  const prompt = str(o.prompt).trim();
  if (!prompt) return null;
  return hashKey(model + "|" + size + "|" + prompt);
}

/**
 * Decides whether a request is eligible for the cache, and with which key.
 *
 * `async/` is excluded on purpose: those requests return a job handle, not an image URL, and
 * caching the handle would hand back a stale job. `method` is passed in already resolved
 * (init first, then the Request object, then GET) because this module never sees either object.
 */
export function cacheRequest(url: unknown, method: unknown, body: unknown): CacheRequest | null {
  const u = str(url);
  const m = (str(method) || "GET").toUpperCase();
  if (m !== "POST") return null;
  if (u.indexOf(GEN_MARK) < 0 || u.indexOf(ASYNC_MARK) >= 0) return null;
  if (typeof body !== "string") return null;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed) return null;
  const n = recOf(parsed).n;
  // Loose on null/undefined, strict on the number: "1" as a string is a batch of unknown size.
  if (!(n === null || n === undefined || n === 1)) return null;
  const key = keyFromBody(parsed);
  if (!key) return null;
  return { key, prompt: str(recOf(parsed).prompt) };
}

/** Response body handed back on a hit; `_cached` lets callers tell a replay from a real result. */
export function cachedBody(url: string): string {
  return JSON.stringify({ data: [{ url: url }], _cached: true });
}

export function createCache(ports: CachePorts): ImageCache {
  const clock = ports.now || function (): number { return Date.now(); };

  function load(): CacheState {
    try {
      return stateOf(JSON.parse(ports.storage.getItem(LS_CACHE) || "{}"));
    } catch {
      return stateOf({});
    }
  }

  function stateOf(raw: unknown): CacheState {
    const root = recOf(raw);
    const entries = recOf(root.entries);
    root.entries = entries;
    const saved = typeof root.saved === "number" ? root.saved : 0;
    root.saved = saved;
    return { root: root, entries: entries, saved: saved };
  }

  function save(s: CacheState): void {
    try {
      ports.storage.setItem(LS_CACHE, JSON.stringify(s.root));
    } catch { /* the cache is an optimisation: a full disk must not break generation */ }
  }

  function statsOf(s: CacheState): CacheStats {
    return { count: Object.keys(s.entries).length, saved: s.saved };
  }

  function emit(s: CacheState): void {
    ports.notify(statsOf(s));
  }

  function get(key: unknown): string | null {
    const k = str(key);
    if (!k) return null;
    const s = load();
    if (!s.entries[k]) return null;
    const e = recOf(s.entries[k]);
    if (clock() - num(e.ts) > TTL_MS) {
      delete s.entries[k];
      save(s);
      return null;
    }
    return str(e.url) || null;
  }

  function put(key: unknown, url: unknown, prompt: unknown): void {
    const k = str(key);
    const u = str(url);
    if (!k || !u || u.indexOf("data:") === 0) return;
    const s = load();
    s.entries[k] = { url: u, ts: clock(), prompt: str(prompt).slice(0, 120) };
    const keys = Object.keys(s.entries);
    if (keys.length > MAX_ENTRIES) {
      const rows = keys.map(function (kk: string): { k: string; ts: number } {
        return { k: kk, ts: num(recOf(s.entries[kk]).ts) };
      });
      rows.sort(function (a, b): number { return a.ts - b.ts; });
      for (const row of rows.slice(0, keys.length - MAX_ENTRIES)) delete s.entries[row.k];
    }
    save(s);
    emit(s);
  }

  function bumpSaved(): void {
    const s = load();
    s.root.saved = s.saved + 1;
    s.saved = s.saved + 1;
    save(s);
    emit(s);
  }

  function clear(): void {
    const s = stateOf({});
    save(s);
    emit(s);
  }

  function isEnabled(): boolean {
    try {
      return ports.storage.getItem(LS_ON) !== "0";
    } catch {
      return true;
    }
  }

  function setEnabled(v: unknown): void {
    try {
      ports.storage.setItem(LS_ON, v ? "1" : "0");
    } catch { /* same as save() */ }
    emit(load());
  }

  return {
    get: get,
    put: put,
    bumpSaved: bumpSaved,
    clear: clear,
    stats: function (): CacheStats { return statsOf(load()); },
    isEnabled: isEnabled,
    setEnabled: setEnabled
  };
}
