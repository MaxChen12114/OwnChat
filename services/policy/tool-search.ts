/**
 * tool_search runtime: the discovered-set store and the catalog matcher behind the `tool_search`
 * tool. Directory mode sends only the resident set; every tool the model pulls in via
 * `tool_search` joins the discovered set, which the resolveSchemas closure merges into the
 * resident list on later turns — so "discovered" is per-kernel-lifetime state, exactly matching
 * the re-send-per-turn semantics.
 *
 * Matching is plain substring over the entry id, its keywords and its group, case-insensitive —
 * the same conservative rule the old tool-catalog used. An empty query matches nothing (the model
 * must say what it wants).
 * @module services/policy/tool-search
 */

// tool-policy is a separate emit product; at runtime the dependency arrives through the emit
// bridge (globalThis.toolSearchSchema, same classic-script page). Declared, not imported: the
// emit channel only carries import-free sources, and a bare identifier survives the strip.
declare const toolSearchSchema: typeof import("./tool-policy").toolSearchSchema;

/** One catalog entry the matcher sees (the structural view from registryToPolicyEntries). */
export interface SearchEntry {
  readonly id: string;
  readonly group: string;
  readonly summary: string;
  readonly keywords: readonly string[];
}

/** unknown -> plain-object view; arrays, null and scalars all become null. */
function recOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  return out;
}

/** Plain substring over id + keywords + group, case-insensitive; empty query matches nothing. */
export function matchEntries(entries: readonly SearchEntry[], query: string, group: string): SearchEntry[] {
  const q = query.trim().toLowerCase();
  const g = group.trim().toLowerCase();
  if (q === "" && g === "") return [];
  const out: SearchEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const idHit = q !== "" && e.id.toLowerCase().indexOf(q) >= 0;
    const kwHit = q !== "" && e.keywords.some((k) => k.toLowerCase().indexOf(q) >= 0);
    const sumHit = q !== "" && e.summary.toLowerCase().indexOf(q) >= 0;
    const groupHit = g === "" || e.group.toLowerCase().indexOf(g) >= 0;
    if ((idHit || kwHit || sumHit) && groupHit) out.push(e);
  }
  return out;
}

/** The discovered set: tools pulled in via tool_search during this kernel's lifetime. */
export interface DiscoveredSet {
  add(ids: readonly string[]): number;
  has(id: string): boolean;
  ids(): readonly string[];
}

/** Create an empty discovered set; `add` is idempotent and returns how many were new. */
export function createDiscovered(): DiscoveredSet {
  const set = new Set<string>();
  return {
    add: function (ids) {
      let fresh = 0;
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        if (typeof id !== "string" || id === "" || set.has(id)) continue;
        set.add(id);
        fresh++;
      }
      return fresh;
    },
    has: function (id) { return set.has(id); },
    ids: function () { return Array.from(set); },
  };
}

/** Public surface for the C-3 wiring: the schema to register plus the matcher and the set. */
export interface ToolSearchRuntime {
  /** The `tool_search` schema to send in directory mode (from tool-policy, single source). */
  schema(): unknown;
  /** Match catalog entries for one tool_search call. */
  match(entries: readonly SearchEntry[], query: string, group: string): SearchEntry[];
  /** The per-kernel discovered set the resolveSchemas closure merges into `resident`. */
  discovered(): DiscoveredSet;
}

/** Create the runtime bundle; it owns one discovered set for its whole lifetime. */
export function createToolSearchRuntime(): ToolSearchRuntime {
  const discovered = createDiscovered();
  return {
    schema: toolSearchSchema,
    match: matchEntries,
    discovered: function () { return discovered; },
  };
}
