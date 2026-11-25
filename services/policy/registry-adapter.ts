/**
 * Bridge between the live tool registry (whose schemas are runtime truth: bundles add and remove
 * tools per environment) and the policy compiler (whose metadata comes from the captured manifest).
 *
 * The runtime side wins: a schema present at run time is the candidate set, enriched by manifest
 * metadata looked up by id. A manifest entry without a runtime schema is ignored — the directory
 * must only cover tools the model can actually call. Missing metadata falls back to conservative
 * defaults and never throws; an adapter that throws would take the whole turn down.
 * @module services/policy/registry-adapter
 */

// tool-policy is a separate emit product; at runtime the dependency arrives through the emit
// bridge (globalThis.compileTools, same classic-script page). Declared, not imported: the emit
// channel only carries import-free sources, and a bare identifier survives the strip.
declare const compileTools: typeof import("./tool-policy").compileTools;

/** Same structural shape as {@link PolicyEntry} (see that file for why this is not an import). */
export interface AdapterEntry {
  readonly id: string;
  readonly group: string;
  readonly summary: string;
  readonly keywords: readonly string[];
  readonly requires: readonly string[];
  readonly risk: string;
  readonly residentCandidate: boolean;
  readonly defaultEnabled: boolean;
  readonly schema: Record<string, unknown>;
}

/** The manifest subset the adapter reads; identical to the runtime payload of `hostApi.tools.manifest`. */
export interface AdapterManifest { readonly entries?: unknown }

/** unknown -> plain-object view; arrays, null and scalars all become null. */
function recOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  return out;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Enrich one runtime schema with manifest metadata by id. Conservative defaults keep a missing or
 * partial manifest entry working: `summary` falls back to the schema description's first sentence,
 * `group` to an explicit "未分组" so the directory renders an honest bucket, and everything the
 * policy gates on defaults to permissive (low risk, resident candidate, enabled).
 */
export function entryFromSchema(
  schemaView: Record<string, unknown>,
  meta: Record<string, unknown> | null,
): AdapterEntry {
  const fn = recOf(schemaView["function"]);
  const name = fn === null ? "" : str(fn["name"]);
  const description = fn === null ? "" : str(fn["description"]);
  const summary = str(meta === null ? "" : meta["summary"]);
  const keywordsRaw = meta === null ? [] : meta["keywords"];
  const keywords: string[] = Array.isArray(keywordsRaw)
    ? keywordsRaw.filter((k): k is string => typeof k === "string" && k !== "")
    : [];
  return {
    id: name,
    group: meta !== null && str(meta["group"]) !== "" ? str(meta["group"]) : "未分组",
    summary: summary !== "" ? summary : (description.split(/[。.\n]/)[0] || name),
    keywords: keywords.length > 0 ? keywords : [name],
    requires: meta !== null && Array.isArray(meta["requires"]) ? meta["requires"].filter((r): r is string => typeof r === "string") : [],
    risk: meta !== null && str(meta["risk"]) !== "" ? str(meta["risk"]) : "low",
    residentCandidate: meta === null ? true : meta["residentCandidate"] !== false,
    defaultEnabled: meta === null ? true : meta["defaultEnabled"] !== false,
    schema: schemaView,
  };
}

/**
 * Runtime schemas -> policy entries. Manifest metadata is optional per entry; entries with a
 * missing name are dropped (a schema without a callable name cannot be gated or sent).
 * @param schemas - the live `registry.toSchemas()` output.
 * @param manifest - `hostApi.tools.manifest` (metadata source), or null.
 */
export function registryToPolicyEntries(
  schemas: readonly unknown[],
  manifest: AdapterManifest | null,
): AdapterEntry[] {
  const metaById = new Map<string, Record<string, unknown> | null>();
  const manifestRec = recOf(manifest);
  const list = manifestRec === null ? [] : manifestRec["entries"];
  if (Array.isArray(list)) {
    for (let i = 0; i < list.length; i++) {
      const rec = recOf(list[i]);
      if (rec === null) continue;
      const id = str(rec["id"]);
      if (id !== "") metaById.set(id, rec);
    }
  }
  const out: AdapterEntry[] = [];
  for (let i = 0; i < schemas.length; i++) {
    const schemaView = recOf(schemas[i]);
    if (schemaView === null) continue;
    const fn = recOf(schemaView["function"]);
    if (fn === null) continue;
    const name = str(fn["name"]);
    if (name === "") continue;
    out.push(entryFromSchema(schemaView, metaById.get(name) || null));
  }
  return out;
}

/** Inputs for {@link applyToolPolicy}: live schemas plus the metadata manifest. */
export interface ApplyInput {
  readonly schemas: readonly unknown[];
  readonly manifest: AdapterManifest | null;
  readonly config?: { readonly mode?: string; readonly perTool?: Readonly<Record<string, boolean>>; readonly resident?: readonly string[]; readonly maxTools?: number };
  readonly caps?: Readonly<Record<string, boolean | undefined>>;
  readonly context?: { readonly userText?: string; readonly skillHits?: readonly string[]; readonly recentToolIds?: readonly string[] };
}

/**
 * Apply the tool policy to the live schema list. In `full` mode the input array is returned
 * as-is — same reference, zero re-ordering, the exact one-flag rollback. In directory/adaptive
 * the compiler builds the reduced set plus the directory text, and the caller owns feeding
 * `directoryText` into the system prompt.
 * @param input - live schemas, metadata manifest and the policy configuration.
 * @returns The compiled result; `tools` is what the request sends.
 */
export function applyToolPolicy(input: ApplyInput): { tools: readonly unknown[]; directoryText: string; explain: unknown; stats: unknown } {
  const mode = input.config && input.config.mode === "directory" ? "directory"
    : input.config && input.config.mode === "adaptive" ? "adaptive"
    : "full";
  if (mode === "full") {
    return { tools: input.schemas, directoryText: "", explain: [], stats: { mode: mode, sent: input.schemas.length } };
  }
  const entries = registryToPolicyEntries(input.schemas, input.manifest);
  const compiled = compileTools({
    manifest: { entries: entries },
    config: { mode: mode, perTool: input.config && input.config.perTool, resident: input.config && input.config.resident, maxTools: input.config && input.config.maxTools },
    caps: input.caps || {},
    context: input.context || {},
  });
  return {
    tools: compiled.tools,
    directoryText: compiled.directoryText,
    explain: compiled.explain,
    stats: compiled.stats,
  };
}
