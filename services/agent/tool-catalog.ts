/**
 * Tool catalogue (B2) with on-demand loading.
 *
 * The problem it solves: every request used to ship every tool schema. Now the model gets a
 * catalogue (name + one-line summary + group) plus `tool_search` to pull a full schema when it
 * actually needs one, which is what keeps prompt cost flat as the tool set grows.
 *
 * Relation to the old `public/shared/agent/tool-catalog.js`: the same implementation, in another
 * language. That file was a classic script whose only consumers were `l0/tools-manifest.mjs` (which
 * evaluated its source text at build time to get `build()` for the manifest's classification fields)
 * and two tests — nothing loaded it at runtime. Hence no wiring and no boot entry: a pure module read
 * at build time, and the `__toolCatalog` global is gone with it.
 *
 * Group rules match in order; file and source rules sit before network ones, so `search_file` is not
 * mistaken for a `search_` network tool.
 */

export interface ToolFunctionSchema {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface CatalogEntry {
  name: string;
  summary: string;
  group: string;
  keywords: string[];
  schema: ToolFunctionSchema;
  approxTokens: number;
}

export interface Catalog {
  version: number;
  entries: CatalogEntry[];
  byName: Map<string, CatalogEntry>;
  fullSchemas: ToolFunctionSchema[];
  fullTokens: number;
  /** Cost of directory mode: the catalog text plus the `tool_search` schema. */
  directoryTokens: number;
}

/** Whatever `registry` the caller wraps; only these three methods are touched. */
export interface RegistryLike {
  define(def: unknown): unknown;
  get(name: string): unknown;
  list(): unknown[];
}

export interface RegistryOptions {
  mode?: unknown;
  resident?: unknown;
  limit?: unknown;
}

export interface DirectoryRegistry {
  define(def: unknown): unknown;
  get(name: string): unknown;
  list(): unknown[];
  toSchemas(): ToolFunctionSchema[];
  stats(): { mode: string; directoryTokens: number; currentTokens: number; fullTokens: number; savedPct: number };
  catalog(): Catalog;
  catalogPrompt(): string;
}

export const VERSION = 1;
export const TOOL_SEARCH_NAME = "tool_search";

/** Ordered: the first match wins, so specific prefixes must come before generic ones. */
const GROUP_RULES: Array<[RegExp, string]> = [
  [/^(read_file|write_file|list_files|search_file|export_file)$/, "文件"],
  [/^source_/, "源码"],
  [/^(read_source|list_source|search_source)$/, "源码"],
  [/^pc_/, "远程电脑"],
  [/^local_/, "本地执行"],
  [/^stage_/, "舞台"],
  [/^memory_/, "记忆"],
  [/^load_skill$/, "技能"],
  [/^offer_choices$/, "交互"],
  [/^(send_image$|generate_)/, "图像"],
  [/^(manage_|adjust_|speak$)/, "角色"],
  [/^(delegate_|convene_|invite_|whisper$)/, "多智能体"],
  [/^(web_|fetch_|search_|read_rss$)/, "联网"],
];

/** Every group name in rule order, for UI that wants to list them. */
export function groupNames(): string[] {
  return GROUP_RULES.map((r) => r[1]);
}

function recOf(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) out[k] = v;
  }
  return out;
}

function arrOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : parseInt(String(value), 10);
  return Number.isFinite(n) ? n : 0;
}

export function groupOf(name: unknown): string {
  const n = text(name);
  for (const [re, group] of GROUP_RULES) {
    if (re.test(n)) return group;
  }
  return "其他";
}

/**
 * One-line summary for the directory: first sentence, hard-capped at 120 chars.
 * The directory is a **prompt budget**, so a chatty description must not eat it.
 */
export function summaryOf(desc: unknown, name: unknown): string {
  let s = text(desc).replace(/\s+/g, " ").trim();
  if (!s) return text(name);
  const m = s.match(/^(.{0,120}?)[。.；;！!？?]/);
  if (m && m[1]) s = m[1];
  if (s.length > 120) s = s.slice(0, 119) + "…";
  return s;
}

/** Name segments plus the summary, deduped — the raw material `search()` scores against. */
export function keywordsOf(name: unknown, summary: unknown): string[] {
  const seen: Record<string, number> = {};
  const out: string[] = [];
  text(name)
    .split("_")
    .forEach(function (part) {
      const p = part.toLowerCase();
      if (p && !seen[p]) {
        seen[p] = 1;
        out.push(p);
      }
    });
  const s = text(summary).toLowerCase();
  if (s && !seen[s]) out.push(s);
  return out;
}

interface NormalDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Accepts both the flat registry shape and the OpenAI `{type:'function', function:{…}}` shape. */
export function normalizeDef(def: unknown): NormalDef | null {
  if (!def || typeof def !== "object") return null;
  const d = recOf(def);
  if (d.type === "function" && d.function) {
    const fn = recOf(d.function);
    return { name: text(fn.name), description: text(fn.description), parameters: recOf(fn.parameters) };
  }
  return { name: text(d.name), description: text(d.description), parameters: recOf(d.parameters) };
}

export function toSchema(def: NormalDef): ToolFunctionSchema {
  const params = Object.keys(def.parameters).length ? def.parameters : { type: "object", properties: {} };
  return {
    type: "function",
    function: { name: def.name, description: def.description, parameters: params },
  };
}

export function measure(schemas: unknown): { chars: number; approxTokens: number } {
  let chars = 0;
  try {
    chars = JSON.stringify(schemas || []).length;
  } catch (e) {
    chars = 0;
  }
  return { chars: chars, approxTokens: Math.ceil(chars / 4) };
}

export function toolSearchParameters(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      query: { type: "string", description: "关键词，如 天气 / pdf / 截图" },
      group: { type: "string", description: "分组过滤，如 联网 / 文件 / 远程电脑" },
      names: { type: "array", items: { type: "string" }, description: "直接按工具名加载" },
      limit: { type: "number", description: "最多返回几条，默认 8" },
    },
  };
}

export function toolSearchDescription(): string {
  return "按关键词或分组查找工具，并加载完整参数定义。当前只看到工具目录（名称 + 一句说明）；需要某个工具的完整参数时先调用本工具。";
}

export function toolSearchSchema(): ToolFunctionSchema {
  return {
    type: "function",
    function: {
      name: TOOL_SEARCH_NAME,
      description: toolSearchDescription(),
      parameters: toolSearchParameters(),
    },
  };
}

function entryOf(d: NormalDef): CatalogEntry {
  const summary = summaryOf(d.description, d.name);
  const schema = toSchema(d);
  return {
    name: d.name,
    summary: summary,
    group: groupOf(d.name),
    keywords: keywordsOf(d.name, summary),
    schema: schema,
    approxTokens: Math.ceil(JSON.stringify(schema).length / 4),
  };
}

export function build(toolDefs: unknown): Catalog {
  const entries: CatalogEntry[] = [];
  const byName = new Map<string, CatalogEntry>();
  const fullSchemas: ToolFunctionSchema[] = [];
  arrOf(toolDefs).forEach(function (raw) {
    const d = normalizeDef(raw);
    // `tool_search` itself is never catalogued: it is always resident, so listing it would be noise.
    if (!d || !d.name || d.name === TOOL_SEARCH_NAME) return;
    const entry = entryOf(d);
    entries.push(entry);
    byName.set(entry.name, entry);
    fullSchemas.push(entry.schema);
  });
  const catalog: Catalog = {
    version: VERSION,
    entries: entries,
    byName: byName,
    fullSchemas: fullSchemas,
    fullTokens: measure(fullSchemas).approxTokens,
    directoryTokens: 0,
  };
  catalog.directoryTokens = measureDirectory(catalog).approxTokens;
  return catalog;
}

export function directorySchemas(_catalog?: Catalog): ToolFunctionSchema[] {
  return [toolSearchSchema()];
}

/**
 * The directory text spliced into the system prompt. This — not `tool_search` — is what makes
 * directory mode work: the model has to see *something* to know what to ask for.
 */
export function catalogPrompt(catalog: Catalog, opts?: { maxChars?: unknown }): string {
  const max = num(opts && opts.maxChars) > 0 ? num(opts && opts.maxChars) : 4000;
  const lines: string[] = [];
  let used = 0;
  let dropped = 0;
  for (const e of catalog.entries) {
    const line = "- `" + e.name + "` [" + e.group + "]: " + e.summary;
    if (used + line.length > max) {
      dropped++;
      continue;
    }
    used += line.length + 1;
    lines.push(line);
  }
  if (dropped) lines.push("- （目录过长，其余 " + dropped + " 条未列出：可按名直接 tool_search）");
  if (!lines.length) return "";
  return (
    "\n\n【工具目录】当前只提供名称、一句说明与分组；需要某个工具的完整参数时，先调用 tool_search（可按 query/group/names 查）。\n" +
    lines.join("\n")
  );
}

/** Directory mode's real cost = catalog text + the `tool_search` schema; both go into the request. */
export function measureDirectory(catalog: Catalog): { chars: number; approxTokens: number } {
  const schemas = measure(directorySchemas());
  const prompt = catalogPrompt(catalog);
  const chars = schemas.chars + prompt.length;
  return { chars: chars, approxTokens: Math.ceil(chars / 4) };
}

/**
 * Scores by field weight: exact name 100, name substring 50, group 30, summary 20, keywords 10.
 * Ties break on name so repeated searches return a stable order.
 */
export function search(catalog: Catalog, query: unknown, opts?: { group?: unknown; limit?: unknown }): CatalogEntry[] {
  const q = text(query).trim().toLowerCase();
  const group = opts && opts.group ? text(opts.group).trim() : "";
  const limit = opts && num(opts.limit) > 0 ? num(opts.limit) : 8;
  const terms = q ? q.split(/\s+/).filter(Boolean) : [];
  const hits: Array<{ entry: CatalogEntry; score: number }> = [];
  for (const e of catalog.entries) {
    if (group && e.group !== group) continue;
    let score = 0;
    if (terms.length) {
      const name = e.name.toLowerCase();
      const summary = e.summary.toLowerCase();
      const kw = e.keywords.join(" ").toLowerCase();
      const grp = e.group.toLowerCase();
      for (const t of terms) {
        if (name === t) score += 100;
        else if (name.indexOf(t) >= 0) score += 50;
        if (summary.indexOf(t) >= 0) score += 20;
        if (kw.indexOf(t) >= 0) score += 10;
        if (grp.indexOf(t) >= 0) score += 30;
      }
      if (score === 0) continue;
    } else {
      score = 1;
    }
    hits.push({ entry: e, score: score });
  }
  hits.sort(function (a, b) {
    return b.score - a.score || a.entry.name.localeCompare(b.entry.name);
  });
  return hits.slice(0, limit).map((x) => x.entry);
}

/**
 * Wraps a registry so `toSchemas()` returns a **stable array** that grows as tools are loaded.
 * `runAgentLoop` takes the reference once per turn; pushing into it is what makes newly searched
 * tools visible on the next round without re-reading the registry.
 */
export function createRegistry(registry: RegistryLike, opts?: RegistryOptions): DirectoryRegistry {
  if (!registry || typeof registry.list !== "function" || typeof registry.get !== "function") {
    throw new Error("[tool-catalog] 需要合法 registry");
  }
  const mode = (opts && opts.mode) === "full" ? "full" : "directory";
  const resident = arrOf(opts && opts.resident).map((n) => text(n));
  const limit = opts && num(opts.limit) > 0 ? num(opts.limit) : 8;
  const catalog = build(registry.list());
  const fullSchemas = catalog.fullSchemas.slice();
  const schemas: ToolFunctionSchema[] = [];

  function hasSchema(name: string): boolean {
    for (const s of schemas) {
      if (s && s.function && s.function.name === name) return true;
    }
    return false;
  }
  function pushSchema(schema: ToolFunctionSchema): void {
    if (schema && schema.function && !hasSchema(schema.function.name)) schemas.push(schema);
  }

  if (mode === "full") {
    fullSchemas.forEach(pushSchema);
  } else {
    pushSchema(toolSearchSchema());
    resident.forEach(function (name) {
      const e = catalog.byName.get(name);
      if (e) pushSchema(e.schema);
    });
  }

  const initialTokens = (mode === "directory" ? measureDirectory(catalog) : measure(schemas)).approxTokens;

  function runSearch(args: unknown): Record<string, unknown> {
    const a = recOf(args);
    const names = arrOf(a.names).map((n) => text(n));
    let found: CatalogEntry[] = [];
    if (names.length) {
      for (const n of names) {
        const e = catalog.byName.get(n);
        if (e) found.push(e);
      }
    } else {
      found = search(catalog, a.query, { group: a.group, limit: num(a.limit) || limit });
    }
    if (!found.length) {
      const asked = text(a.query) || text(a.group) || names.join(",") || "（空查询）";
      return { ok: false, error: "未找到工具：" + asked };
    }
    found.forEach(function (e) {
      pushSchema(e.schema);
    });
    return {
      ok: true,
      loaded: found.map((e) => e.name),
      tools: found.map((e) => e.schema),
      hint: "完整参数已加载，可直接调用这些工具。",
    };
  }

  if (!registry.get(TOOL_SEARCH_NAME)) {
    registry.define({
      name: TOOL_SEARCH_NAME,
      description: toolSearchDescription(),
      parameters: toolSearchParameters(),
      run: runSearch,
    });
  }

  return {
    define: function (def: unknown): unknown {
      const r = registry.define(def);
      const d = normalizeDef(def);
      // Tools defined *after* the wrapper was built must still show up in the directory.
      if (d && d.name && d.name !== TOOL_SEARCH_NAME && !catalog.byName.has(d.name)) {
        const entry = entryOf(d);
        catalog.entries.push(entry);
        catalog.byName.set(entry.name, entry);
        catalog.fullSchemas.push(entry.schema);
        if (mode === "full") pushSchema(entry.schema);
      }
      return r;
    },
    get: function (name: string): unknown {
      return registry.get(name);
    },
    list: function (): unknown[] {
      return registry.list();
    },
    toSchemas: function (): ToolFunctionSchema[] {
      return schemas;
    },
    stats: function () {
      const full = measure(fullSchemas).approxTokens;
      return {
        mode: mode,
        directoryTokens: initialTokens,
        currentTokens: measure(schemas).approxTokens,
        fullTokens: full,
        savedPct: full ? Math.round((1 - initialTokens / full) * 100) : 0,
      };
    },
    catalog: function (): Catalog {
      return catalog;
    },
    catalogPrompt: function (): string {
      return catalogPrompt(catalog);
    },
  };
}
