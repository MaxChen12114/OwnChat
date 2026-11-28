/**
 * Custom model pricing settings: the single home for the `cfw_custom_pricing_v1` table shared by
 * the settings card (write side in settings.js) and the cost ledger (read side in
 * services/cost/ledger.ts, `getCustomPricing`).
 *
 * Both sides used to spell out the same JSON-object guard independently — `JSON.parse`, object and
 * not-array, otherwise `{}` — so a change to one silently diverged from the other. The table shape,
 * its normalization and the price validation now live here once; the DOM (inputs, list rows, status
 * text) stays in the settings card. `table()` is byte-identical to ledger's read, which an
 * equivalence lock pins down.
 *
 * Prices are non-negative ¥/million-token numbers; `NaN` and negatives are rejected on save, so a
 * malformed input can never be persisted into a billing calculation. The table is part of the sync
 * whitelist and never holds an API key — only numeric price fields survive a write.
 *
 * Zero window, zero casts: storage arrives through {@link PricingPorts}, and the wiring owns the
 * try/catch around localStorage. Every port call is guarded, matching the card's old safe reads.
 * @module services/ui/settings-custom-pricing
 */

export const CUSTOM_PRICING_KEY = "cfw_custom_pricing_v1";

/** Storage port; structurally identical to the ledger's storage port. */
export interface PricingPorts {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface Price {
  cache_hit: number;
  input: number;
  output: number;
}

export type PricingTable = Record<string, Price>;

export interface PricingApi {
  /** Normalized table — byte-identical to ledger's getCustomPricing(). */
  table(): PricingTable;
  /** Persist one model's prices; rejects an empty id or any non-numeric/negative price. */
  save(id: string, price: Price): boolean;
  /** Remove one model from the table. */
  remove(id: string): void;
  /** Valid non-negative price from a typed field; null means "not a number". */
  parsePrice(raw: unknown): number | null;
}

/** Reject arrays, null and primitives; keep only plain objects, matching ledger's guard. */
export function normalizeTable(raw: unknown): PricingTable {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: PricingTable = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "object" || v === null || Array.isArray(v)) continue;
    const fields: Record<string, unknown> = {};
    for (const [fk, fv] of Object.entries(v)) fields[fk] = fv;
    out[k] = { cache_hit: num(fields.cache_hit), input: num(fields.input), output: num(fields.output) };
  }
  return out;
}

function num(v: unknown): number {
  return typeof v === "number" && isFinite(v) ? v : 0;
}

/** A typed price field is valid only when it parses to a finite, non-negative number. */
export function parsePrice(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : parseFloat(String(raw ?? ""));
  return isFinite(n) && n >= 0 ? n : null;
}

function safeGet(ports: PricingPorts): string | null {
  try {
    return ports.getItem(CUSTOM_PRICING_KEY);
  } catch (e) {
    return null;
  }
}

export function createSettingsCustomPricing(ports: PricingPorts): PricingApi {
  return {
    table: () => {
      let raw: unknown;
      try {
        raw = JSON.parse(safeGet(ports) || "{}");
      } catch (e) {
        return {};
      }
      return normalizeTable(raw);
    },
    save: (id, price) => {
      const key = String(id ?? "").trim();
      if (!key) return false;
      const cacheHit = parsePrice(price.cache_hit);
      const input = parsePrice(price.input);
      const output = parsePrice(price.output);
      if (cacheHit === null || input === null || output === null) return false;
      const all = (function () {
        const cur = (function () {
          try {
            return JSON.parse(safeGet(ports) || "{}");
          } catch (e) {
            return {};
          }
        })();
        return normalizeTable(cur);
      })();
      all[key] = { cache_hit: cacheHit, input, output };
      try {
        ports.setItem(CUSTOM_PRICING_KEY, JSON.stringify(all));
      } catch (e) {
      }
      return true;
    },
    remove: (id) => {
      const key = String(id ?? "").trim();
      if (!key) return;
      let raw: unknown;
      try {
        raw = JSON.parse(safeGet(ports) || "{}");
      } catch (e) {
        return;
      }
      const all = normalizeTable(raw);
      delete all[key];
      try {
        ports.setItem(CUSTOM_PRICING_KEY, JSON.stringify(all));
      } catch (e) {
      }
    },
    parsePrice,
  };
}
