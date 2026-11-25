/**
 * Tool policy: one manifest compiled once into the three answers the agent needs — what to
 * register, what to send, and what to show.
 *
 * The problem it removes: the tool set used to be an implicit system assembled out of script
 * order, per-module self-registration and hand-written settings copy, so the same question ("how
 * many tools are there?") had four different answers. `registryDefs` decides registration, `tools`
 * decides the request, `explain` + `stats` decide the UI — all from one return value, so the
 * numbers cannot drift apart.
 *
 * Boundaries, so this is not mistaken for "already wired": pure functions, zero imports, no window
 * globals, no DOM. `registry.js`, `agent-kernel.js`, `tools.js` and `settings.js` are untouched.
 * `full` is the default and the one-flag rollback; `directory` and `adaptive` are implemented but
 * stay off until the task-set comparison in the build order is finished.
 *
 * Not here on purpose: permission decisions (`risk` is only surfaced through `explain`) and
 * environment probing (`caps` belongs to whoever owns the capability ids — a second list here
 * would be a second source of truth).
 *
 * Token accounting: `ceil(JSON.stringify(tools).length / 4)`, matching `tool-catalog.measure`
 * character for character. The directory text keeps that module's layout and prefix so the prompt
 * cache is not invalidated mid-migration. `maxTools` defaults to 12. Schema order is manifest
 * order, never score order.
 *
 * Retire it when the file has been unchanged for 30 days and registry assembly goes through this
 * function.
 * @module services/policy/tool-policy
 */

/** Three delivery modes. `full` is the status quo and the one-flag rollback; the other two can
 * only become default once the task-set comparison passes. */
export type ToolMode = "full" | "directory" | "adaptive";

/**
 * The fields the policy actually reads — a structural subset, not a copy of `ToolManifestEntry`.
 *
 * `core/host-api.ts` is deliberately not imported: core contracts emit nothing at runtime, and a
 * service has to survive being bundled into a classic script with no imports. Field drift is
 * already pinned between `host-api.ts` and `schema.json` by `test/tool-manifest.test.mjs`, so the
 * structural argument needs no assertion here.
 */
export interface PolicyEntry {
  readonly id: string;
  readonly group: string;
  readonly summary: string;
  readonly keywords: readonly string[];
  readonly requires: readonly string[];
  readonly risk: string;
  readonly residentCandidate: boolean;
  readonly defaultEnabled: boolean;
  /** The full JSON Schema sent to the model. It may carry `description` — that is the real long copy. */
  readonly schema: Record<string, unknown>;
}

export interface ToolPolicyManifest { readonly entries: readonly PolicyEntry[] }

export interface ToolPolicyConfig {
  /** Defaults to `full`; an invalid value falls back to `full` too — when in doubt, send more tools
 * rather than silently hiding them. */
  readonly mode?: ToolMode;
  /** Explicit user switch: `false` = off, `true` = force on (overrides `defaultEnabled`). */
  readonly perTool?: Readonly<Record<string, boolean>>;
  /** Resident set (derived from usage statistics, never hard-coded here). Required by directory and
 * adaptive, because those modes only send the resident tools up front. */
  readonly resident?: readonly string[];
  /** Adaptive pre-selection cap, default 12. `tool_search` does not count against it. */
  readonly maxTools?: number;
}

/**
 * Environment capability bits, as an open map rather than `{tauri, panel, ...}`: the names are owned
 * by `CapabilityId`, and providers add their own (`providerFeatures`). The policy only looks up the
 * names listed in `manifest.requires`, and a missing entry counts as "not ready".
 */
export interface ToolCaps { readonly [capability: string]: boolean | undefined }

/** Per-turn context, only the three signals pre-selection uses. `iteration`/`convId` are not
 * collected because selection never looks at them. */
export interface ToolContext {
  readonly userText?: string;
  readonly skillHits?: readonly string[];
  readonly recentToolIds?: readonly string[];
}

/**
 * Five states; the UI renders `reason` verbatim. `on` = registered and sent, `deferred` =
 * registered but not sent (it still appears in the directory, waiting for `tool_search`; directory
 * and adaptive only), `off-user` = the user switched it off, `off-caps` = a capability is missing,
 * `off-policy` = declared off by default.
 *
 * `on` and `deferred` are registered; the `off-*` three are not — which is what makes "switched
 * off" mean the same thing in all three layers: not registered, not sent, not callable.
 */
export type ToolExplainState = "on" | "deferred" | "off-user" | "off-caps" | "off-policy";

export interface ToolExplain {
  readonly id: string;
  readonly state: ToolExplainState;
  readonly reason: string;
  readonly group: string;
  readonly risk: string;
}

export interface ToolFunctionSchema {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export interface ToolPolicyStats {
  total: number;
  /** Registered = `on` + `deferred`. */
  registered: number;
  /** Sent = `on`. */
  sent: number;
  /** Approximate tokens of the sent schemas (same measure as `tool-catalog`); the directory text is
 * **not** included. */
  approxTokens: number;
  /** Percent saved against `full`. Always 0 for `full`, and it **can be negative** — see the tail of
 * `compileTools`. */
  savedPct: number;
}

export interface CompiledTools {
  readonly mode: ToolMode;
  /** Entries to register (`on` + `deferred`). The provider still supplies `run`; the policy only
 * decides whether registration happens at all. */
  readonly registryDefs: readonly PolicyEntry[];
  /** Schemas sent to the model, in manifest order. */
  readonly tools: readonly ToolFunctionSchema[];
  /** Directory text for the system prompt, once per conversation. Empty in `full` mode. */
  readonly directoryText: string;
  /** Where every entry went and why, in manifest order — the UI renders this directly and must not
 * filter it again. */
  readonly explain: readonly ToolExplain[];
  readonly stats: ToolPolicyStats;
}

const DEFAULT_MAX_TOOLS = 12;
const DIRECTORY_MAX_CHARS = 4000;
export const TOOL_SEARCH_ID = "tool_search";

/**
 * In directory and adaptive mode `tool_search` is a system tool rather than a module-injected one.
 * The copy matches `toolSearchSchema` in `services/agent/tool-catalog.ts` word for word: both exist
 * during the migration, and the old one is deleted once assembly goes through this function — at
 * which point this becomes the only source.
 */
export function toolSearchSchema(): ToolFunctionSchema {
  return {
    type: "function",
    function: {
      name: TOOL_SEARCH_ID,
      description: "按关键词或分组查找工具，并加载完整参数定义。当前只看到工具目录（名称 + 一句说明）；需要某个工具的完整参数时先调用本工具。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "关键词，如 天气 / pdf / 截图" },
          group: { type: "string", description: "分组过滤，如 联网 / 文件 / 远程电脑" },
          names: { type: "array", items: { type: "string" }, description: "直接按工具名加载" },
          limit: { type: "number", description: "最多返回几条，默认 8" }
        }
      }
    }
  };
}

/** Same measure as `tool-catalog`. A stringify throw counts as 0: bookkeeping must never take the
 * compiler down. */
export function measureTokens(schemas: readonly unknown[]): number {
  let chars = 0;
  try { chars = JSON.stringify(schemas || []).length; } catch { chars = 0; }
  return Math.ceil(chars / 4);
}

/**
 * The order carries meaning and must not be changed: (1) an explicit user choice wins outright —
 * when he turned it off it stays off, whatever the environment says; (2) the declared default
 * comes next (high-risk tools fail closed); (3) the environment last.
 *
 * Swapping the last two makes "user enabled it + capability missing" report the wrong reason and
 * sends people off to configure the wrong thing.
 */
function gateOf(entry: PolicyEntry, config: ToolPolicyConfig, caps: ToolCaps): { state: ToolExplainState; reason: string } | null {
  const explicit = config.perTool ? config.perTool[entry.id] : undefined;
  if (explicit === false) return { state: "off-user", reason: "用户已在能力页关闭" };
  if (!entry.defaultEnabled && explicit !== true) return { state: "off-policy", reason: "声明为默认关闭（高风险，需用户显式开启）" };
  const missing = entry.requires.filter((cap) => caps[cap] !== true);
  if (missing.length) return { state: "off-caps", reason: "能力位未就绪：" + missing.join(" / ") };
  return null;
}

/**
 * Scoring uses deterministic signals only: an explicit mention beats recent use, which beats a
 * keyword or group hit, which beats being a resident candidate.
 *
 * The weights answer "does this tool apply right now", not "is it usually popular". That is why
 * `residentCandidate` is only a weak prior (+10): it must not outrank a tool named in the user's
 * own words, or a screenshot request gets crowded out by `read_file`.
 *
 * No tokenisation — the text is Chinese, where splitting still yields one token per sentence — so
 * matching is plain substring. Scores only select; the final order goes back to manifest order so
 * the prompt prefix does not change every turn.
 */
function scoreOf(entry: PolicyEntry, terms: readonly string[], recent: readonly string[]): number {
  let score = entry.residentCandidate ? 10 : 0;
  if (recent.indexOf(entry.id) >= 0) score += 25;
  const id = entry.id.toLowerCase();
  const summary = String(entry.summary || "").toLowerCase();
  const group = String(entry.group || "").toLowerCase();
  for (const k of entry.keywords || []) {
    const kw = String(k || "").toLowerCase();
    if (!kw) continue;
    for (const t of terms) {
      if (!t) continue;
      if (kw === t) score += 20;
      else if (t.indexOf(kw) >= 0) score += 10;
      else if (kw.indexOf(t) >= 0) score += 6;
    }
  }
  for (const t of terms) {
    if (!t) continue;
    if (id === t) score += 60;
    else if (id.indexOf(t) >= 0) score += 30;
    if (summary.indexOf(t) >= 0) score += 6;
    if (group.indexOf(t) >= 0) score += 10;
  }
  return score;
}

/** Context to search terms: `skillHits` as-is, `userText` lowercased as one whole string (no
 * splitting). */
function termsOf(context: ToolContext): string[] {
  const out: string[] = [];
  const push = (raw: string): void => {
    const t = String(raw == null ? "" : raw).toLowerCase().trim();
    if (t && out.indexOf(t) < 0) out.push(t);
  };
  (context.skillHits || []).forEach(push);
  const text = String(context.userText == null ? "" : context.userText).toLowerCase().trim();
  if (text) push(text);
  return out;
}

/** Residents always win and are never squeezed by the cap — the list is a promise made by the user
 * or by usage statistics, not something a score should be able to evict. */
function pickAdaptive(eligible: readonly PolicyEntry[], config: ToolPolicyConfig, context: ToolContext): PolicyEntry[] {
  const resident = config.resident || [];
  const recent = context.recentToolIds || [];
  const terms = termsOf(context);
  const limit = Number(config.maxTools) > 0 ? Number(config.maxTools) : DEFAULT_MAX_TOOLS;
  const residentEntries = eligible.filter((e) => resident.indexOf(e.id) >= 0);
  const rest = eligible.filter((e) => resident.indexOf(e.id) < 0);
  const ranked = rest
    .map((entry, index) => ({ entry, index, score: scoreOf(entry, terms, recent) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const room = limit - residentEntries.length;
  if (room <= 0) return residentEntries;
  return residentEntries.concat(ranked.slice(0, room).map((x) => x.entry));
}

/**
 * `description` prefers `schema.description` (the tool's real long copy) and only falls back to
 * `summary`, which is truncated to 120 characters — using it as the description shows the model a
 * half sentence. The generator must therefore put the long copy into `schema.description`;
 * otherwise `full` mode silently gets shorter descriptions.
 */
function schemaOf(entry: PolicyEntry): ToolFunctionSchema {
  const raw = entry.schema || {};
  const long = typeof raw.description === "string" ? String(raw.description) : "";
  const description = long || String(entry.summary || entry.id);
  const parameters = raw.properties ? raw : { type: "object", properties: {} };
  return { type: "function", function: { name: entry.id, description, parameters } };
}

/** Directory text: same layout as `tool-catalog.catalogPrompt`, except `group`/`summary` are read
 * from the manifest directly. */
function directoryTextOf(entries: readonly PolicyEntry[], maxChars: number): string {
  const lines: string[] = [];
  let used = 0;
  let dropped = 0;
  for (const e of entries) {
    const line = "- `" + e.id + "` [" + e.group + "]: " + e.summary;
    if (used + line.length > maxChars) { dropped++; continue; }
    used += line.length + 1;
    lines.push(line);
  }
  if (dropped) lines.push("- （目录过长，其余 " + dropped + " 条未列出：可按名直接 tool_search）");
  if (!lines.length) return "";
  return "\n\n【工具目录】当前只提供名称、一句说明与分组；需要某个工具的完整参数时，先调用 tool_search（可按 query/group/names 查）。\n" + lines.join("\n");
}

export interface ToolPolicyInput {
  readonly manifest: ToolPolicyManifest;
  readonly config?: ToolPolicyConfig;
  readonly caps?: ToolCaps;
  readonly context?: ToolContext;
}

export function compileTools(input: ToolPolicyInput): CompiledTools {
  const entries = (input.manifest && input.manifest.entries) || [];
  const config = input.config || {};
  const caps = input.caps || {};
  const context = input.context || {};
  const mode: ToolMode = config.mode === "directory" || config.mode === "adaptive" ? config.mode : "full";

  const explain: ToolExplain[] = [];
  const eligible: PolicyEntry[] = [];
  for (const entry of entries) {
    const gate = gateOf(entry, config, caps);
    if (gate) explain.push({ id: entry.id, state: gate.state, reason: gate.reason, group: entry.group, risk: entry.risk });
    else {
      eligible.push(entry);
      explain.push({ id: entry.id, state: "on", reason: "", group: entry.group, risk: entry.risk }); // downgraded below if not sent
    }
  }

  const resident = config.resident || [];
  let sending = eligible;
  if (mode === "directory") sending = eligible.filter((e) => resident.indexOf(e.id) >= 0);
  else if (mode === "adaptive") sending = pickAdaptive(eligible, config, context);

  const sendingIds: string[] = sending.map((e) => e.id);
  const finalExplain: ToolExplain[] = explain.map((item) => {
    if (item.state !== "on" || sendingIds.indexOf(item.id) >= 0) return item;
    return { id: item.id, state: "deferred", reason: "本轮未下发（已注册，可用 tool_search 补齐）", group: item.group, risk: item.risk };
  });

  const registeredIds: string[] = finalExplain.filter((x) => x.state === "on" || x.state === "deferred").map((x) => x.id);
  const registryDefs = entries.filter((e) => registeredIds.indexOf(e.id) >= 0);

  // Back to manifest order: `sending` is a filtered subset, but the order must follow `entries`.
  const tools: ToolFunctionSchema[] = [];
  if (mode !== "full") tools.push(toolSearchSchema());
  for (const e of entries) if (sendingIds.indexOf(e.id) >= 0) tools.push(schemaOf(e));

  // The directory covers every registered entry (on + deferred). `deferred` means "not sent but
  // discoverable", so listing only `on` would hide them for good. The `off-*` states are not
  // registered and must not appear: the model would call them and fail.
  const directoryText = mode === "full" ? "" : directoryTextOf(registryDefs, DIRECTORY_MAX_CHARS);

  // `savedPct` has to include the directory text: it goes into the system prompt once per
  // conversation, but it is not free. Counting only `tools` makes directory/adaptive look cheaper
  // than they are — with few tools it even claims a saving where there is a cost. That number is
  // exactly what decides whether adaptive becomes the default, so an optimistic count would be a
  // wrong decision dressed up as a measurement.
  const fullTokens = measureTokens(eligible.map(schemaOf));
  const approxTokens = measureTokens(tools);
  const directoryTokens = directoryText ? Math.ceil(directoryText.length / 4) : 0;
  const savedPct = fullTokens > 0 ? Math.round((1 - (approxTokens + directoryTokens) / fullTokens) * 100) : 0;

  return {
    mode,
    registryDefs,
    tools,
    directoryText,
    explain: finalExplain,
    stats: { total: entries.length, registered: registryDefs.length, sent: sending.length, approxTokens, savedPct }
  };
}
