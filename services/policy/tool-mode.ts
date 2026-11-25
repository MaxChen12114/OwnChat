/**
 * Tool mode runtime: turns the `cfw_tool_mode_v1` flag into the two things one agent turn needs —
 * the `tool_search` executor registered on the kernel registry, and the per-round `resolveSchemas`
 * closure that merges the discovered set into the resident list.
 *
 * Semantics (B2 design §4, C-3):
 *  - `full` (default): zero wiring. `resolveSchemas` returns the input array, the same reference —
 *    the kernel sends the registry's full set and nothing else changes.
 *  - `directory`: all tools stay registered in the kernel registry (registration never shrinks);
 *    only what is SENT shrinks. The resident list is the manifest's resident candidates plus the
 *    discovered set, so a tool the model pulls in via `tool_search` is sent from the next round on
 *    — the per-kernel-lifetime "re-send" semantics.
 *  - Anything that is not exactly "directory", or a missing policy module, degrades to full with no
 *    tool_search registered: the rollback is one storage byte, and a half-installed policy domain
 *    must never take the turn down.
 *
 * Dependencies arrive through `deps`, injected by the wiring from the policy products' emit
 * bridges — this file imports nothing and touches no window, so it emits standalone and tests with
 * the real modules injected. The registry is the live kernel registry (get/define/toSchemas).
 * @module services/policy/tool-mode
 */

type ApplyFn = typeof import("./registry-adapter").applyToolPolicy;
type EntriesFn = typeof import("./registry-adapter").registryToPolicyEntries;
type SearchSchemaFn = typeof import("./tool-policy").toolSearchSchema;
type MatchFn = typeof import("./tool-search").matchEntries;
type DiscoveredFn = typeof import("./tool-search").createDiscovered;
type SearchEntry = Parameters<MatchFn>[0][number];
type CatalogEntry = ReturnType<EntriesFn>[number];
type CompiledTools = ReturnType<ApplyFn>;

/** The kernel registry surface this runtime needs (the real createToolRegistry shape). */
export interface ToolModeRegistry {
  get(name: string): unknown;
  define(def: { name: string; description?: string; parameters?: unknown; run: (args: unknown, ctx?: unknown) => unknown }): unknown;
  toSchemas(): unknown[];
}

/** The policy modules this runtime consumes; injected by the wiring, never imported. */
export interface ToolModeDeps {
  applyToolPolicy: ApplyFn | null;
  registryToPolicyEntries: EntriesFn | null;
  toolSearchSchema: SearchSchemaFn | null;
  TOOL_SEARCH_ID: string | null;
  matchEntries: MatchFn | null;
  createDiscovered: DiscoveredFn | null;
}

export interface ToolModeInput {
  /** The raw `cfw_tool_mode_v1` storage value; read side is dirty-tolerant (see readToolMode). */
  rawMode?: unknown;
  /** `hostApi.tools.manifest` payload (metadata source by id), or null. */
  manifest?: unknown;
  /** The live kernel registry the executor registers itself on. */
  registry?: ToolModeRegistry | null;
  /** Policy modules from the emit bridge; absent or half-present = full semantics. */
  deps?: ToolModeDeps | null;
  /** Receives the directory text once per resolved round; the turn feeds it into the injections. */
  onDirectoryText?: (text: string) => void;
}

export interface ToolModeRuntime {
  /** True once the tool_search executor is on the registry. False in every full-path case. */
  registerToolSearch(): boolean;
  /** full / unknown mode / missing deps: the input array, the same reference. */
  resolveSchemas(schemas: unknown[]): unknown[];
}

const DEFAULT_SEARCH_LIMIT = 8;

/**
 * The mode gate. Only the exact string "directory" enables the reduced send — "adaptive" stays
 * off until the mode switch exposes it (B2 design §6), and every other value (blank, garbage,
 * wrong type) is full. The default IS the old behaviour, so the flag is also the rollback.
 */
export function readToolMode(raw: unknown): "full" | "directory" {
  return raw === "directory" ? "directory" : "full";
}

/** unknown -> plain-object view; arrays, null and scalars all become an empty one. */
function recOf(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
  const entries = Object.entries(value);
  for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  return out;
}

/** Create the per-turn runtime. Never throws: every degraded path just behaves like full. */
export function createToolModeRuntime(input?: ToolModeInput | null): ToolModeRuntime {
  const i: ToolModeInput = input && typeof input === "object" ? input : { deps: undefined };
  const d: Partial<ToolModeDeps> = i.deps || {};
  const mode = readToolMode(i.rawMode);

  // Narrowed views, not casts: each dependency is checked where it is used, so a half-installed
  // policy domain degrades to the full path instead of raising.
  const applyFn = typeof d.applyToolPolicy === "function" ? d.applyToolPolicy : null;
  const entriesFn = typeof d.registryToPolicyEntries === "function" ? d.registryToPolicyEntries : null;
  const schemaFn = typeof d.toolSearchSchema === "function" ? d.toolSearchSchema : null;
  const matchFn = typeof d.matchEntries === "function" ? d.matchEntries : null;
  const discoverFn = typeof d.createDiscovered === "function" ? d.createDiscovered : null;
  const searchId = typeof d.TOOL_SEARCH_ID === "string" ? d.TOOL_SEARCH_ID : "";
  const reg = i.registry !== null && i.registry !== undefined && typeof i.registry.toSchemas === "function"
    ? i.registry
    : null;
  const discovered = discoverFn ? discoverFn() : null;
  // The mode gate is a guard at every use site: full stays the exact old path even when every
  // policy module is present and healthy. `usable` is the all-or-nothing switch: a half-present
  // dependency set degrades the WHOLE runtime to full, never just part of it.
  const directory = mode === "directory";
  const usable = directory
    && applyFn !== null && entriesFn !== null && schemaFn !== null && matchFn !== null
    && discovered !== null && reg !== null && searchId !== "";

  /** The executor behind tool_search: match the registry's CURRENT full set, remember, return. */
  const search = (args: unknown): unknown => {
    if (!usable || !entriesFn || !matchFn || !discovered || !reg) return { tools: [], note: "tool_search 未就绪" };
    const rec = recOf(args);
    const query = typeof rec["query"] === "string" ? rec["query"] : "";
    const group = typeof rec["group"] === "string" ? rec["group"] : "";
    const namesRaw = rec["names"];
    const names = Array.isArray(namesRaw)
      ? namesRaw.filter((n): n is string => typeof n === "string" && n !== "")
      : [];
    const limitRaw = rec["limit"];
    const limit = typeof limitRaw === "number" && limitRaw > 0 && isFinite(limitRaw)
      ? Math.floor(limitRaw)
      : DEFAULT_SEARCH_LIMIT;
    // Catalog = the registry's current full set, minus tool_search itself (searching for the
    // search tool would only echo it back).
    const entries: CatalogEntry[] = entriesFn(reg.toSchemas(), i.manifest as Parameters<EntriesFn>[1])
      .filter((e) => e.id !== searchId);
    const byId = new Map<string, CatalogEntry>();
    for (let k = 0; k < entries.length; k++) byId.set(entries[k].id, entries[k]);
    let hitIds: string[] = [];
    if (names.length > 0) {
      for (let k = 0; k < names.length; k++) {
        if (byId.has(names[k])) hitIds.push(names[k]);
      }
    } else {
      hitIds = matchFn(entries, query, group).map((e: SearchEntry) => e.id);
    }
    hitIds = hitIds.slice(0, limit);
    discovered.add(hitIds);
    const tools: unknown[] = [];
    for (let k = 0; k < hitIds.length; k++) {
      const e = byId.get(hitIds[k]);
      if (e) tools.push(e.schema);
    }
    return tools.length > 0
      ? { tools: tools }
      : { tools: [], note: "未命中任何工具；换个关键词，或用 names 直接指定工具名" };
  };

  return {
    registerToolSearch: function (): boolean {
      // A half-present dependency set must not install a search tool that can never match.
      if (!usable || !reg || !schemaFn) return false;
      try {
        if (reg.get(searchId)) return true; // already registered (or a module claimed the name)
        const schema = recOf(schemaFn());
        const fn = recOf(schema["function"]);
        if (fn["name"] !== searchId) return false;
        reg.define({
          name: searchId,
          description: typeof fn["description"] === "string" ? fn["description"] : "",
          parameters: fn["parameters"],
          run: function (args: unknown) { return search(args); },
        });
        return true;
      } catch (e) {
        return false; // a failed install must not take the turn down; full semantics survive
      }
    },

    resolveSchemas: function (schemas: unknown[]): unknown[] {
      if (!usable || !applyFn || !entriesFn || !discovered || !reg) return schemas;
      // The search tool itself never rides the resident list: the compiler prepends its schema,
      // and letting the registered executor through would send it twice and list it in the
      // directory as something still to discover.
      const sendable: unknown[] = schemas.filter((s) => recOf(recOf(s)["function"])["name"] !== searchId);
      const entries = entriesFn(sendable, i.manifest as Parameters<EntriesFn>[1]);
      const resident: string[] = [];
      for (let k = 0; k < entries.length; k++) {
        if (entries[k].residentCandidate) resident.push(entries[k].id);
      }
      const found = discovered.ids();
      for (let k = 0; k < found.length; k++) resident.push(found[k]);
      const compiled: CompiledTools = applyFn({
        schemas: sendable,
        manifest: i.manifest as Parameters<ApplyFn>[0]["manifest"],
        config: { mode: "directory", resident: resident },
      });
      if (typeof i.onDirectoryText === "function" && typeof compiled.directoryText === "string") {
        try { i.onDirectoryText(compiled.directoryText); } catch (e) {}
      }
      return Array.from(compiled.tools);
    },
  };
}
