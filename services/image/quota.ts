/**
 * Image generation quota: a per-device, per-day estimate of how many images this browser has
 * produced through the site's own proxy.
 *
 * The upstream free tier allows roughly 100 images a day, but the real limit is enforced by the
 * provider, so nothing here blocks a request — it only answers "how am I doing". Counting happens
 * at a single point (the fetch wrapper in the wiring layer), which is why the workshop, the WeChat
 * image sender and the quick-generate button are all covered without touching any of them.
 *
 * Known gap, deliberately not fixed: only calls that leave this device through this site are
 * counted. The standalone `/image/` page, direct calls to the provider and other devices are not.
 *
 * The store is localStorage, so the count is per browser profile and survives reloads; only the
 * last 30 days are kept. `services/image/quota` holds the arithmetic; the wiring layer owns
 * localStorage, the fetch interception, the change event and the settings card.
 * @module services/image/quota
 */

export interface QuotaStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface QuotaSnapshot {
  used: number;
  limit: number;
  remaining: number;
  date: string;
}

export interface QuotaPorts {
  storage: QuotaStorage;
  /** Clock port; the tests pin it, the browser uses the wall clock. */
  now?(): Date;
  /** Called after every mutation, once the listeners have run. */
  notify(s: QuotaSnapshot): void;
}

export interface Quota {
  add(n?: unknown): number;
  getToday(): number;
  getLimit(): number;
  setLimit(n: unknown): void;
  getRemaining(): number;
  reset(): void;
  onChange(fn: (s: QuotaSnapshot) => void): void;
  snapshot(): QuotaSnapshot;
}

const LS_DATA = "cfw_image_quota_v1";
const LS_LIMIT = "cfw_image_quota_limit_v1";
const DEFAULT_LIMIT = 100;
const KEEP_DAYS = 30;
const GEN_PATH = "/img/v1/images/generations";
const EDIT_PATH = "/img/v1/async/images/edits";

function recOf(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

/** Local calendar day (`YYYY-MM-DD`); the quota resets at local midnight, not UTC. */
export function dayKey(d: Date): string {
  const pad = (n: number): string => (n < 10 ? "0" + String(n) : String(n));
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

/**
 * How many images a request is worth, or `0` when the URL is not a generator.
 *
 * A synchronous generation is charged for `body.n` (defaulting to 1 when the body is absent,
 * unparsable or carries a falsy `n`); an async edit is always one image.
 */
export function chargeFor(url: unknown, body: unknown): number {
  const u = typeof url === "string" ? url : "";
  if (u.indexOf(GEN_PATH) >= 0) {
    if (typeof body !== "string") return 1;
    try {
      const parsed: unknown = JSON.parse(body);
      const n = parsed ? recOf(parsed).n : null;
      if (!n) return 1;
      return parseInt(String(n), 10) || 1;
    } catch {
      return 1;
    }
  }
  return u.indexOf(EDIT_PATH) >= 0 ? 1 : 0;
}

export function createQuota(ports: QuotaPorts): Quota {
  const listeners: Array<(s: QuotaSnapshot) => void> = [];
  const clock = ports.now || function (): Date { return new Date(); };

  function readMap(): Record<string, unknown> {
    try { return recOf(JSON.parse(ports.storage.getItem(LS_DATA) || "{}")); } catch { return {}; }
  }
  function writeMap(m: Record<string, unknown>): void {
    try { ports.storage.setItem(LS_DATA, JSON.stringify(m)); } catch { /* quota is advisory: a full disk must not break generation */ }
  }

  function getLimit(): number {
    const v = parseInt(String(ports.storage.getItem(LS_LIMIT) || ""), 10);
    return isFinite(v) && v > 0 ? v : DEFAULT_LIMIT;
  }
  function getToday(): number {
    return parseInt(String(readMap()[dayKey(clock())] || 0), 10) || 0;
  }
  function getRemaining(): number {
    return Math.max(0, getLimit() - getToday());
  }
  function snapshot(): QuotaSnapshot {
    return { used: getToday(), limit: getLimit(), remaining: getRemaining(), date: dayKey(clock()) };
  }

  function emit(): void {
    const s = snapshot();
    for (const fn of listeners) { try { fn(s); } catch { /* one bad listener must not starve the rest */ } }
    ports.notify(s);
  }

  function add(n?: unknown): number {
    let inc = parseInt(String(n), 10);
    if (!isFinite(inc) || inc === 0) inc = 1;
    const m = readMap();
    const k = dayKey(clock());
    const cur = parseInt(String(m[k] || 0), 10) || 0;
    const next = Math.max(0, cur + inc);
    m[k] = next;
    const keys = Object.keys(m).sort();
    while (keys.length > KEEP_DAYS) {
      const drop = keys.shift();
      if (drop !== undefined) delete m[drop];
    }
    writeMap(m);
    emit();
    return next;
  }

  function setLimit(n: unknown): void {
    const v = parseInt(String(n), 10);
    if (isFinite(v) && v > 0) {
      try { ports.storage.setItem(LS_LIMIT, String(v)); } catch { /* same as above */ }
    }
    emit();
  }

  function reset(): void {
    const m = readMap();
    m[dayKey(clock())] = 0;
    writeMap(m);
    emit();
  }

  function onChange(fn: (s: QuotaSnapshot) => void): void {
    if (typeof fn === "function") listeners.push(fn);
  }

  return { add, getToday, getLimit, setLimit, getRemaining, reset, onChange, snapshot };
}
