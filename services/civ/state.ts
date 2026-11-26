/**
 * Faction facts, the turn clock and the deterministic RNG.
 *
 * This module is the only place that mutates numbers on a faction. Every other module returns an
 * intent or a settlement effect and the tick orchestrator applies it through {@link StateApi.adjust}
 * or {@link StateApi.spend}; that keeps "who changed the number" answerable from one call site.
 *
 * Determinism contract:
 *   - no `Math.random`, no `Date.now`, no locale-dependent formatting;
 *   - every random draw comes from `rng(seed, ...domain)` (mulberry32 over an integer hash), so a
 *     change to one domain never shifts another domain's stream;
 *   - every stored number is rounded to 4 decimals, which keeps cross-device float drift from
 *     turning into a different trace.
 *
 * @module services/civ/state
 */

import type {
  CivWorld,
  Clock,
  CreateWorldOptions,
  EconomyRules,
  Faction,
  FactionDelta,
  FactionId,
  FactionSeed,
  ProductionResult,
  ResourceMap,
  Rng,
  StateApi,
} from "./types";

const MAX_STAT = 100;
const DEFAULT_SEASONS_PER_YEAR = 4;
const DEFAULT_MORALE = 70;
const DEFAULT_REPUTATION = 50;
const ROUND_SCALE = 10000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Copy own enumerable string keys into a plain record. Never trusts the prototype chain. */
function recOf(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isRecord(value)) return out;
  for (const key of Object.keys(value)) out[key] = Reflect.get(value, key);
  return out;
}

function round4(value: number): number {
  return Math.round(value * ROUND_SCALE) / ROUND_SCALE;
}

function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  return value < lo ? lo : value > hi ? hi : value;
}

function stableNumber(value: number): number {
  return Number.isFinite(value) ? round4(value) : 0;
}

function copyResources(source: ResourceMap): ResourceMap {
  const out: ResourceMap = {};
  for (const key of Object.keys(source)) out[key] = stableNumber(source[key]);
  return out;
}

function hash32(seed: number, ...parts: (string | number)[]): number {
  let h = (seed | 0) ^ 0x9e3779b9;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  for (const part of parts) {
    const text = String(part);
    for (let i = 0; i < text.length; i++) {
      h = (Math.imul(h ^ text.charCodeAt(i), 0x27d4eb2f) + 0x165667b1) >>> 0;
      h = Math.imul(h ^ (h >>> 15), 0x2545f491) >>> 0;
    }
    h = Math.imul(h ^ 0x1f123bb5, 0x27d4eb2d) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

function createRng(seed: number, ...domain: (string | number)[]): Rng {
  let state = hash32(seed, ...domain) | 0;
  if (state === 0) state = 0x6d2b79f5 | 0;
  function next(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return {
    next,
    int(maxExclusive: number): number {
      if (!(maxExclusive > 0)) return 0;
      return Math.floor(next() * maxExclusive);
    },
    range(min: number, max: number): number {
      return min + next() * (max - min);
    },
  };
}

function canonical(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "null";
    return String(round4(value));
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) parts.push(canonical(item));
    return "[" + parts.join(",") + "]";
  }
  if (typeof value === "object") {
    const rec = recOf(value);
    const keys = Object.keys(rec).sort();
    const parts: string[] = [];
    for (const key of keys) parts.push(JSON.stringify(key) + ":" + canonical(rec[key]));
    return "{" + parts.join(",") + "}";
  }
  return "null";
}

function makeFaction(seed: FactionSeed): Faction {
  return {
    id: seed.id,
    name: seed.name,
    resources: copyResources(seed.resources),
    population: Math.max(0, stableNumber(seed.population)),
    territory: Math.max(0, stableNumber(seed.territory)),
    army: Math.max(0, stableNumber(seed.army)),
    morale: clamp(stableNumber(seed.morale === undefined ? DEFAULT_MORALE : seed.morale), 0, MAX_STAT),
    reputation: clamp(
      stableNumber(seed.reputation === undefined ? DEFAULT_REPUTATION : seed.reputation),
      0,
      MAX_STAT,
    ),
    warExhaustion: clamp(
      stableNumber(seed.warExhaustion === undefined ? 0 : seed.warExhaustion),
      0,
      MAX_STAT,
    ),
  };
}

function cloneFaction(f: Faction): Faction {
  return {
    id: f.id,
    name: f.name,
    resources: copyResources(f.resources),
    population: f.population,
    territory: f.territory,
    army: f.army,
    morale: f.morale,
    reputation: f.reputation,
    warExhaustion: f.warExhaustion,
  };
}

function createWorld(opts: CreateWorldOptions): CivWorld {
  if (!Number.isFinite(opts.seed)) throw new TypeError("seed 必须是有限数字");
  if (!Array.isArray(opts.factions) || opts.factions.length === 0) {
    throw new TypeError("factions 必须是非空数组");
  }
  const order: FactionId[] = [];
  const factions: Record<FactionId, Faction> = {};
  for (const seed of opts.factions) {
    if (!seed || typeof seed.id !== "string" || seed.id.trim() === "") {
      throw new TypeError("每个 faction 都需要非空 id");
    }
    if (Object.prototype.hasOwnProperty.call(factions, seed.id)) {
      throw new Error("faction id 重复: " + seed.id);
    }
    order.push(seed.id);
    factions[seed.id] = makeFaction(seed);
  }
  const seasons =
    opts.clock && Number.isInteger(opts.clock.seasonsPerYear) && (opts.clock.seasonsPerYear || 0) > 0
      ? (opts.clock.seasonsPerYear || DEFAULT_SEASONS_PER_YEAR)
      : DEFAULT_SEASONS_PER_YEAR;
  const tick = opts.clock && Number.isInteger(opts.clock.tick) && (opts.clock.tick || 0) >= 0
    ? (opts.clock.tick || 0)
    : 0;
  const year = opts.clock && Number.isInteger(opts.clock.year) && (opts.clock.year || 0) > 0
    ? (opts.clock.year || 1)
    : 1;
  const season = opts.clock && Number.isInteger(opts.clock.season)
    ? clamp(opts.clock.season || 0, 0, seasons - 1)
    : 0;
  return {
    schemaVersion: 1,
    seed: opts.seed | 0,
    clock: { tick, year, season, seasonsPerYear: seasons },
    order,
    factions,
  };
}

function faction(world: CivWorld, id: FactionId): Faction | null {
  if (!Object.prototype.hasOwnProperty.call(world.factions, id)) return null;
  const found = world.factions[id];
  return found === undefined ? null : found;
}

function factions(world: CivWorld): Faction[] {
  const out: Faction[] = [];
  for (const id of world.order) {
    const found = faction(world, id);
    if (found !== null) out.push(found);
  }
  return out;
}

function adjust(world: CivWorld, id: FactionId, delta: FactionDelta): Faction | null {
  const target = faction(world, id);
  if (target === null) return null;
  if (delta.resources) {
    for (const key of Object.keys(delta.resources)) {
      const current = target.resources[key] === undefined ? 0 : target.resources[key];
      target.resources[key] = Math.max(0, stableNumber(current + delta.resources[key]));
    }
  }
  if (delta.population !== undefined) {
    target.population = Math.max(0, stableNumber(target.population + delta.population));
  }
  if (delta.territory !== undefined) {
    target.territory = Math.max(0, stableNumber(target.territory + delta.territory));
  }
  if (delta.army !== undefined) {
    target.army = Math.max(0, stableNumber(target.army + delta.army));
  }
  if (delta.morale !== undefined) {
    target.morale = clamp(stableNumber(target.morale + delta.morale), 0, MAX_STAT);
  }
  if (delta.reputation !== undefined) {
    target.reputation = clamp(stableNumber(target.reputation + delta.reputation), 0, MAX_STAT);
  }
  if (delta.warExhaustion !== undefined) {
    target.warExhaustion = clamp(stableNumber(target.warExhaustion + delta.warExhaustion), 0, MAX_STAT);
  }
  return target;
}

function canAfford(world: CivWorld, id: FactionId, cost: ResourceMap): boolean {
  const target = faction(world, id);
  if (target === null) return false;
  for (const key of Object.keys(cost)) {
    const need = cost[key];
    if (!(need > 0)) continue;
    const have = target.resources[key] === undefined ? 0 : target.resources[key];
    if (have + 1e-9 < need) return false;
  }
  return true;
}

function spend(world: CivWorld, id: FactionId, cost: ResourceMap): boolean {
  if (!canAfford(world, id, cost)) return false;
  const delta: ResourceMap = {};
  for (const key of Object.keys(cost)) delta[key] = -cost[key];
  adjust(world, id, { resources: delta });
  return true;
}

function produce(world: CivWorld, economy: EconomyRules): ProductionResult[] {
  const results: ProductionResult[] = [];
  for (const target of factions(world)) {
    let shortage = false;
    for (const key of economy.resources) {
      const base = economy.productionPerTurn[key] === undefined ? 0 : economy.productionPerTurn[key];
      const perPop = economy.perPopulation[key] === undefined ? 0 : economy.perPopulation[key];
      const perTerr = economy.perTerritory[key] === undefined ? 0 : economy.perTerritory[key];
      const upkeep = economy.upkeepPerArmy[key] === undefined ? 0 : economy.upkeepPerArmy[key];
      const flow = base + perPop * target.population + perTerr * target.territory - upkeep * target.army;
      const current = target.resources[key] === undefined ? 0 : target.resources[key];
      const next = current + flow;
      if (next < 0) {
        shortage = true;
        target.resources[key] = 0;
      } else {
        target.resources[key] = stableNumber(next);
      }
    }
    if (!shortage) {
      target.population = Math.max(0, stableNumber(target.population + economy.populationGrowthPerTurn));
    }
    const moraleDelta = shortage ? -economy.starvationMoralePenalty : economy.moraleRecovery;
    target.morale = clamp(stableNumber(target.morale + moraleDelta), 0, economy.maxMorale);
    target.warExhaustion = clamp(target.warExhaustion, 0, economy.maxWarExhaustion);
    target.reputation = clamp(target.reputation, 0, economy.maxReputation);
    results.push({
      faction: target.id,
      resources: copyResources(target.resources),
      population: target.population,
      morale: target.morale,
      shortage,
    });
  }
  return results;
}

function advance(world: CivWorld): Clock {
  world.clock.tick += 1;
  world.clock.season += 1;
  if (world.clock.season >= world.clock.seasonsPerYear) {
    world.clock.season = 0;
    world.clock.year += 1;
  }
  return world.clock;
}

function cloneWorld(world: CivWorld): CivWorld {
  const copied: Record<FactionId, Faction> = {};
  for (const id of world.order) {
    const found = faction(world, id);
    if (found !== null) copied[id] = cloneFaction(found);
  }
  return {
    schemaVersion: 1,
    seed: world.seed,
    clock: {
      tick: world.clock.tick,
      year: world.clock.year,
      season: world.clock.season,
      seasonsPerYear: world.clock.seasonsPerYear,
    },
    order: [...world.order],
    factions: copied,
  };
}

export function createState(): StateApi {
  return {
    createWorld,
    faction,
    factions,
    adjust,
    canAfford,
    spend,
    produce,
    advance,
    rng: createRng,
    stableHash(value: unknown): number {
      return hash32(0x1a2b3c4d, canonical(value));
    },
    canonicalJSON(value: unknown): string {
      return canonical(value);
    },
    cloneWorld,
  };
}
