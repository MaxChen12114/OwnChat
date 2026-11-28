/**
 * Runtime manifest: the server's answer to "which profile is this host, what may this client do,
 * and which numbers does the server enforce", plus the capability kernel that turns that answer
 * into started/stopped provider ports.
 *
 * Why this is not `core/capability.ts`: that file is the *tool* capability snapshot (what this
 * environment can do for the agent, with its two-way lock). A profile manifest is a *host*
 * contract: the server says guest/account/desktop/selfhost, and the client starts the ports that
 * profile needs. Merging the two would make "the user turned a tool off" and "this host has no
 * database" the same bit.
 *
 * Kernel semantics: applying a manifest forks ONE child scope and starts every provider module a
 * enabled capability needs, through `inject`; applying a different manifest disposes that child
 * first. Switching profiles therefore only swaps the capability/provider set — it never touches
 * the data path, the root context or any captured port. Unknown capabilities, unknown profiles and
 * malformed numbers degrade (reported, never thrown): a server that grows a field ahead of the
 * client must not stop the app from booting. A known provider that is not registered leaves its
 * capability PENDING and explainable, the same story `core/runtime.ts` tells.
 *
 * First-connect planning lives here because it is the same question asked at boot ("which host is
 * this, and what does the user want to keep"), and its answer is data, not a dialog. The dialog,
 * the storage reads and the backup/sync calls belong to the settings wiring.
 *
 * Boundary: no DOM, no storage, no network, no environment probe. Limits are advisory to the
 * client and authoritative on the server; the client uses the server's numbers verbatim (it never
 * enlarges them) and falls back to {@link DEFAULT_RUNTIME_LIMITS} only when the response omits one.
 * @module core/runtime-manifest
 */

import type { Disposer, ExplainResult, RuntimeContext } from "./runtime";

/** The four profiles the matrix in the plan commits to. */
export type RuntimeProfile = "guest" | "account" | "desktop" | "selfhost";

/** Declaration order; the UI groups by it and the profile switcher iterates it. */
export const RUNTIME_PROFILES: readonly RuntimeProfile[] = ["guest", "account", "desktop", "selfhost"];

/** Capabilities this client understands. Anything else in a response is ignored with a report. */
export type RuntimeCapabilityId =
  | "chat"
  | "sync"
  | "data"
  | "presets"
  | "search"
  | "tts"
  | "image"
  | "pc"
  | "deploy";

/**
 * Capability registry: one row per capability and the provider services it needs. Providers are
 * named after the port they publish (`transport` / `secret` / `storage` / `db`), never after a
 * concrete adapter — "D1" is a choice the db provider makes, not a capability.
 */
export interface RuntimeCapabilitySpec {
  readonly id: RuntimeCapabilityId;
  readonly providers: readonly string[];
}

export const RUNTIME_CAPABILITIES: readonly RuntimeCapabilitySpec[] = [
  { id: "chat", providers: ["transport", "storage"] },
  { id: "sync", providers: ["transport", "secret"] },
  { id: "data", providers: ["db"] },
  { id: "presets", providers: ["transport", "secret"] },
  { id: "search", providers: ["transport"] },
  { id: "tts", providers: ["transport"] },
  { id: "image", providers: ["transport"] },
  { id: "pc", providers: ["transport", "secret"] },
  { id: "deploy", providers: ["transport", "secret"] },
];

/** Runtime id list derived from the registry, never a second copy of the literals. */
export const RUNTIME_CAPABILITY_IDS: readonly RuntimeCapabilityId[] = RUNTIME_CAPABILITIES.map((s) => s.id);

/** Wire limits, one member per endpoint family the Worker caps today. */
export type RuntimeLimitSurface = "sync" | "syncCost" | "syncExclude" | "syncChat" | "syncChars" | "data" | "chatEvents";

export interface RuntimeLimits {
  readonly sync: { readonly maxBodyBytes: number };
  readonly syncCost: { readonly maxBodyBytes: number };
  readonly syncExclude: { readonly maxBodyBytes: number };
  readonly syncChat: { readonly maxBodyBytes: number };
  readonly syncChars: { readonly maxBodyBytes: number };
  readonly data: {
    readonly maxBodyBytes: number;
    readonly maxSqlChars: number;
    readonly maxTxStatements: number;
    readonly maxSearchLimit: number;
    readonly maxQueryChars: number;
  };
  readonly chatEvents: {
    readonly maxBodyBytes: number;
    readonly maxEventBytes: number;
    readonly batch: number;
    readonly keep: number;
  };
}

/**
 * Mirrors the literals the Worker and `src/data-api.js` enforce (5MB sync blobs, 12MiB data-body
 * cap, 100k SQL chars, 200 tx statements, 50 search hits, 1.5MB event batch, 256KiB per event).
 * `test/runtime-manifest.test.mjs` compares this table with a live `/api/runtime` response, so a
 * raised/dropped server cap turns the lock red instead of leaving the client believing a stale
 * number. Kept as a table (not constants inline in the kernel) so the fallback manifest and the
 * comparison share one source.
 */
export const DEFAULT_RUNTIME_LIMITS: RuntimeLimits = {
  sync: { maxBodyBytes: 5 * 1024 * 1024 },
  syncCost: { maxBodyBytes: 512 * 1024 },
  syncExclude: { maxBodyBytes: 256 * 1024 },
  syncChat: { maxBodyBytes: 5 * 1024 * 1024 },
  syncChars: { maxBodyBytes: 5 * 1024 * 1024 },
  data: {
    maxBodyBytes: 12 * 1024 * 1024,
    maxSqlChars: 100000,
    maxTxStatements: 200,
    maxSearchLimit: 50,
    maxQueryChars: 200,
  },
  chatEvents: {
    maxBodyBytes: Math.floor(1.5 * 1024 * 1024),
    maxEventBytes: 256 * 1024,
    batch: 50,
    keep: 2000,
  },
};

/** Normalised manifest. `capabilities` contains known ids only; `issues` explains every dropped field. */
export interface RuntimeManifest {
  readonly version: 1;
  readonly profile: RuntimeProfile;
  readonly capabilities: Readonly<Record<string, boolean>>;
  readonly limits: RuntimeLimits;
  /** `worker`, `local` (quiet fallback before the first fetch) or `fallback` (fetch failed). */
  readonly source: string;
  readonly issues: readonly string[];
}

export interface ManifestParseResult {
  readonly manifest: RuntimeManifest;
  readonly issues: readonly string[];
}

/** unknown JSON → plain-object view; null, arrays and scalars become an empty object. */
function recOf(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value);
    for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  }
  return out;
}

/** Whether a string is one of the four profiles (used by parsers and the wiring's fallback). */
export function isRuntimeProfile(value: unknown): value is RuntimeProfile {
  if (typeof value !== "string") return false;
  for (let i = 0; i < RUNTIME_PROFILES.length; i++) if (RUNTIME_PROFILES[i] === value) return true;
  return false;
}

/** Whether a string is a capability this client knows. */
export function isRuntimeCapability(value: unknown): value is RuntimeCapabilityId {
  if (typeof value !== "string") return false;
  for (let i = 0; i < RUNTIME_CAPABILITY_IDS.length; i++) if (RUNTIME_CAPABILITY_IDS[i] === value) return true;
  return false;
}

/**
 * A fresh capability table for a profile. `guest` keeps only chat: a page with no account must
 * still be able to talk (that is the "无配置 guest 可聊" rule), while cloud/admin surfaces stay
 * off until the server grants them. The three privileged profiles default to everything on and
 * are then overridden by the server's explicit booleans.
 */
export function profileCapabilities(profile: RuntimeProfile): Record<RuntimeCapabilityId, boolean> {
  const out: Record<RuntimeCapabilityId, boolean> = {
    chat: false,
    sync: false,
    data: false,
    presets: false,
    search: false,
    tts: false,
    image: false,
    pc: false,
    deploy: false,
  };
  if (profile === "guest") {
    out.chat = true;
    return out;
  }
  for (let i = 0; i < RUNTIME_CAPABILITY_IDS.length; i++) out[RUNTIME_CAPABILITY_IDS[i]] = true;
  return out;
}

/** Deep copy so a caller mutating the returned table cannot poison later manifests. */
function copyLimits(source: RuntimeLimits): RuntimeLimits {
  return {
    sync: { maxBodyBytes: source.sync.maxBodyBytes },
    syncCost: { maxBodyBytes: source.syncCost.maxBodyBytes },
    syncExclude: { maxBodyBytes: source.syncExclude.maxBodyBytes },
    syncChat: { maxBodyBytes: source.syncChat.maxBodyBytes },
    syncChars: { maxBodyBytes: source.syncChars.maxBodyBytes },
    data: {
      maxBodyBytes: source.data.maxBodyBytes,
      maxSqlChars: source.data.maxSqlChars,
      maxTxStatements: source.data.maxTxStatements,
      maxSearchLimit: source.data.maxSearchLimit,
      maxQueryChars: source.data.maxQueryChars,
    },
    chatEvents: {
      maxBodyBytes: source.chatEvents.maxBodyBytes,
      maxEventBytes: source.chatEvents.maxEventBytes,
      batch: source.chatEvents.batch,
      keep: source.chatEvents.keep,
    },
  };
}

/** Read one non-negative integer; anything else is reported and replaced by the fallback. */
function limitAt(raw: Record<string, unknown>, key: string, fallback: number, label: string, issues: string[]): number {
  if (!Object.prototype.hasOwnProperty.call(raw, key)) return fallback;
  const value = raw[key];
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  issues.push("limits." + label + " 不是非负有限数字，已用默认值 " + fallback);
  return fallback;
}

/** Parse the wire shape; never throws, always answers a usable manifest. */
export function parseRuntimeManifest(raw: unknown): ManifestParseResult {
  const issues: string[] = [];
  const root = recOf(raw);
  if (Object.prototype.hasOwnProperty.call(root, "version") && root.version !== 1) {
    issues.push("manifest.version 不是 1（收到 " + String(root.version) + "），按 1 解析");
  }

  let profile: RuntimeProfile = "guest";
  if (isRuntimeProfile(root.profile)) profile = root.profile;
  else issues.push("未知 profile「" + String(root.profile) + "」，已按 guest 处理");

  const capabilities: Record<string, boolean> = profileCapabilities(profile);
  const capsRaw = recOf(root.capabilities);
  const capKeys = Object.keys(capsRaw);
  for (let i = 0; i < capKeys.length; i++) {
    const key = capKeys[i];
    if (!isRuntimeCapability(key)) {
      issues.push("未知能力「" + key + "」已忽略（降级，不阻塞 boot）");
      continue;
    }
    const value = capsRaw[key];
    if (typeof value === "boolean") capabilities[key] = value;
    else issues.push("能力「" + key + "」不是布尔值，已保留默认值");
  }

  const limitsRaw = recOf(root.limits);
  const syncRaw = recOf(limitsRaw.sync);
  const syncCostRaw = recOf(limitsRaw.syncCost);
  const syncExcludeRaw = recOf(limitsRaw.syncExclude);
  const syncChatRaw = recOf(limitsRaw.syncChat);
  const syncCharsRaw = recOf(limitsRaw.syncChars);
  const dataRaw = recOf(limitsRaw.data);
  const eventsRaw = recOf(limitsRaw.chatEvents);
  const limits: RuntimeLimits = {
    sync: { maxBodyBytes: limitAt(syncRaw, "maxBodyBytes", DEFAULT_RUNTIME_LIMITS.sync.maxBodyBytes, "sync.maxBodyBytes", issues) },
    syncCost: { maxBodyBytes: limitAt(syncCostRaw, "maxBodyBytes", DEFAULT_RUNTIME_LIMITS.syncCost.maxBodyBytes, "syncCost.maxBodyBytes", issues) },
    syncExclude: { maxBodyBytes: limitAt(syncExcludeRaw, "maxBodyBytes", DEFAULT_RUNTIME_LIMITS.syncExclude.maxBodyBytes, "syncExclude.maxBodyBytes", issues) },
    syncChat: { maxBodyBytes: limitAt(syncChatRaw, "maxBodyBytes", DEFAULT_RUNTIME_LIMITS.syncChat.maxBodyBytes, "syncChat.maxBodyBytes", issues) },
    syncChars: { maxBodyBytes: limitAt(syncCharsRaw, "maxBodyBytes", DEFAULT_RUNTIME_LIMITS.syncChars.maxBodyBytes, "syncChars.maxBodyBytes", issues) },
    data: {
      maxBodyBytes: limitAt(dataRaw, "maxBodyBytes", DEFAULT_RUNTIME_LIMITS.data.maxBodyBytes, "data.maxBodyBytes", issues),
      maxSqlChars: limitAt(dataRaw, "maxSqlChars", DEFAULT_RUNTIME_LIMITS.data.maxSqlChars, "data.maxSqlChars", issues),
      maxTxStatements: limitAt(dataRaw, "maxTxStatements", DEFAULT_RUNTIME_LIMITS.data.maxTxStatements, "data.maxTxStatements", issues),
      maxSearchLimit: limitAt(dataRaw, "maxSearchLimit", DEFAULT_RUNTIME_LIMITS.data.maxSearchLimit, "data.maxSearchLimit", issues),
      maxQueryChars: limitAt(dataRaw, "maxQueryChars", DEFAULT_RUNTIME_LIMITS.data.maxQueryChars, "data.maxQueryChars", issues),
    },
    chatEvents: {
      maxBodyBytes: limitAt(eventsRaw, "maxBodyBytes", DEFAULT_RUNTIME_LIMITS.chatEvents.maxBodyBytes, "chatEvents.maxBodyBytes", issues),
      maxEventBytes: limitAt(eventsRaw, "maxEventBytes", DEFAULT_RUNTIME_LIMITS.chatEvents.maxEventBytes, "chatEvents.maxEventBytes", issues),
      batch: limitAt(eventsRaw, "batch", DEFAULT_RUNTIME_LIMITS.chatEvents.batch, "chatEvents.batch", issues),
      keep: limitAt(eventsRaw, "keep", DEFAULT_RUNTIME_LIMITS.chatEvents.keep, "chatEvents.keep", issues),
    },
  };

  return {
    manifest: {
      version: 1,
      profile: profile,
      capabilities: capabilities,
      limits: limits,
      source: typeof root.source === "string" && root.source ? root.source : "unknown",
      issues: issues,
    },
    issues: issues,
  };
}

/**
 * The manifest used before the first fetch or after a failed one. A desktop shell can answer
 * `desktop` locally; everything else is `guest`, which still grants chat — boot never blocks on
 * `/api/runtime`.
 */
export function localRuntimeManifest(profile: RuntimeProfile, issue?: string): RuntimeManifest {
  const issues: string[] = [];
  if (typeof issue === "string" && issue) issues.push(issue);
  return {
    version: 1,
    profile: profile,
    capabilities: profileCapabilities(profile),
    limits: copyLimits(DEFAULT_RUNTIME_LIMITS),
    source: "fallback",
    issues: issues,
  };
}

export interface RuntimeLimitVerdict {
  readonly ok: boolean;
  readonly surface: string;
  readonly size: number;
  readonly limit: number;
  readonly error?: string;
}

/**
 * Compare a payload size against the manifest's limit. `bytes` is expected to be a UTF-8 byte
 * count (TextEncoder); the Worker itself compares UTF-16 length, which is never larger for the
 * same string, so a client that passes here cannot be rejected for size by the server.
 */
export function checkRuntimeLimit(limits: RuntimeLimits, surface: unknown, bytes: unknown): RuntimeLimitVerdict {
  const name = typeof surface === "string" ? surface : "";
  const size = typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0 ? bytes : -1;
  if (!name || !Object.prototype.hasOwnProperty.call(limits, name)) {
    return { ok: false, surface: name, size: size, limit: 0, error: "未知限额面：" + name };
  }
  const entry = recOf(Reflect.get(limits, name));
  const limit = typeof entry.maxBodyBytes === "number" ? entry.maxBodyBytes : 0;
  if (size < 0) return { ok: false, surface: name, size: size, limit: limit, error: "大小不是非负有限数字" };
  if (!limit) return { ok: false, surface: name, size: size, limit: 0, error: "该面没有 maxBodyBytes 限额" };
  return { ok: size <= limit, surface: name, size: size, limit: limit };
}

/** One provider module the kernel may start. `apply` publishes its port via `ctx.provide`. */
export interface KernelProviderInput {
  readonly manifest: RuntimeManifest;
  readonly capability: RuntimeCapabilitySpec;
  readonly provider: string;
}

export interface KernelProvider {
  readonly name: string;
  /** Service name to provide; defaults to `name`. */
  readonly service?: string;
  /** Hard dependency gate handed to `ctx.inject`; absent means "no deps". */
  readonly inject?: readonly string[];
  /**
   * Start the provider. Synchronous by contract: publish a value and/or return its inverse. A
   * provider needing async readiness provides an object with a `ready` promise, which the runtime
   * kernel awaits before activating dependents.
   */
  readonly apply: (ctx: RuntimeContext, input: KernelProviderInput) => Disposer | void;
}

export interface KernelIssue {
  readonly code: string;
  readonly capability: string;
  readonly provider?: string;
  readonly message: string;
  readonly missing?: readonly string[];
}

export interface KernelApplyResult {
  readonly profile: RuntimeProfile;
  /** False when the same manifest was already applied (no provider was restarted). */
  readonly changed: boolean;
  readonly started: readonly string[];
  readonly pending: readonly KernelIssue[];
  readonly errors: readonly KernelIssue[];
  readonly ignored: readonly string[];
  readonly issues: readonly string[];
  readonly capabilities: Readonly<Record<string, boolean>>;
  readonly limits: RuntimeLimits;
}

export interface CapabilityKernel {
  readonly v: 1;
  /** Parse + start/stop providers. Accepts raw JSON or an already-normalised manifest. */
  apply(raw: unknown): KernelApplyResult;
  get(service: string): unknown;
  has(service: string): boolean;
  explain(id: string): ExplainResult | null;
  status(): KernelApplyResult;
  providerNames(): readonly string[];
  checkLimit(surface: unknown, bytes: unknown): RuntimeLimitVerdict;
  dispose(): void;
}

export interface CapabilityKernelOptions {
  readonly context: RuntimeContext;
  readonly providers: readonly KernelProvider[];
  /** Override the registry (tests); defaults to RUNTIME_CAPABILITIES. */
  readonly capabilities?: readonly RuntimeCapabilitySpec[];
}

function messageOf(error: unknown): string {
  if (error && typeof error === "object") {
    const message = recOf(error).message;
    if (typeof message === "string" && message) return message;
  }
  return String(error);
}

/** A stable string for "same manifest": profile + capability row + limits, in registry order. */
function fingerprintOf(manifest: RuntimeManifest, registry: readonly RuntimeCapabilitySpec[]): string {
  const caps: string[] = [];
  for (let i = 0; i < registry.length; i++) caps.push(registry[i].id + "=" + (manifest.capabilities[registry[i].id] === true ? "1" : "0"));
  return JSON.stringify([manifest.profile, caps, manifest.limits]);
}

/** Empty result used by `status()` before the first apply. */
function idleResult(): KernelApplyResult {
  return {
    profile: "guest",
    changed: false,
    started: [],
    pending: [],
    errors: [],
    ignored: [],
    issues: ["manifest 尚未应用"],
    capabilities: profileCapabilities("guest"),
    limits: copyLimits(DEFAULT_RUNTIME_LIMITS),
  };
}

/**
 * Build the capability kernel over an existing runtime context. The kernel never owns the root
 * context: it forks a child per apply and disposes that child on the next apply or on `dispose()`,
 * so the host's services (the db facade's forwarding port in particular) survive every profile
 * switch. `get()` reads the nearest service in that child: an unstarted provider therefore falls
 * through to a root service of the same name, which is why callers gate on `capabilities()` when
 * "this profile does not run provider X" must be enforced.
 */
export function createCapabilityKernel(options: CapabilityKernelOptions): CapabilityKernel {
  if (!options || !options.context || typeof options.context.fork !== "function") {
    throw new Error("runtime-manifest: 需要一个 runtime context");
  }
  const root = options.context;
  const registry = options.capabilities && options.capabilities.length ? options.capabilities : RUNTIME_CAPABILITIES;
  const providerMap = new Map<string, KernelProvider>();
  for (let i = 0; i < options.providers.length; i++) {
    const provider = options.providers[i];
    if (!provider || typeof provider.name !== "string" || !provider.name) continue;
    if (typeof provider.apply !== "function") continue;
    providerMap.set(provider.name, provider);
  }

  let scope: RuntimeContext | null = null;
  let lastPrint = "";
  let lastResult: KernelApplyResult | null = null;

  function apply(raw: unknown): KernelApplyResult {
    const parsed = parseRuntimeManifest(raw);
    const manifest = parsed.manifest;
    const print = fingerprintOf(manifest, registry);
    if (scope !== null && lastResult !== null && print === lastPrint) {
      return {
        profile: lastResult.profile,
        changed: false,
        started: lastResult.started,
        pending: lastResult.pending,
        errors: lastResult.errors,
        ignored: lastResult.ignored,
        issues: parsed.issues,
        capabilities: lastResult.capabilities,
        limits: lastResult.limits,
      };
    }

    if (scope !== null) {
      scope.dispose();
      scope = null;
    }
    const next = root.fork();
    scope = next;
    const started: string[] = [];
    const pending: KernelIssue[] = [];
    const errors: KernelIssue[] = [];
    // Unknown capabilities are dropped by the parser (so the table stays closed), but the kernel
    // still reports them: "the server grew a capability this client does not know" is exactly the
    // kind of skew the status panel must be able to explain.
    const ignored: string[] = [];
    const rawCapKeys = Object.keys(recOf(recOf(raw).capabilities));
    for (let i = 0; i < rawCapKeys.length; i++) {
      if (!isRuntimeCapability(rawCapKeys[i])) ignored.push(rawCapKeys[i]);
    }

    for (let i = 0; i < registry.length; i++) {
      const capability = registry[i];
      if (manifest.capabilities[capability.id] !== true) continue;

      const missingProviders: string[] = [];
      for (let p = 0; p < capability.providers.length; p++) {
        if (!providerMap.has(capability.providers[p])) missingProviders.push(capability.providers[p]);
      }
      if (missingProviders.length) {
        pending.push({
          code: "missing_provider",
          capability: capability.id,
          message: "provider 未注册：" + missingProviders.join(", "),
          missing: missingProviders,
        });
        continue;
      }

      for (let p = 0; p < capability.providers.length; p++) {
        const providerName = capability.providers[p];
        if (started.indexOf(providerName) >= 0) continue;
        const provider = providerMap.get(providerName);
        if (!provider) continue;
        started.push(providerName);
        const service = provider.service || provider.name;
        try {
          const handle = next.inject(
            provider.inject || [],
            function (ctx: RuntimeContext): Disposer | void {
              return provider.apply(ctx, { manifest: manifest, capability: capability, provider: providerName });
            },
            "capability:" + capability.id + "/" + providerName,
          );
          if (handle.status === "pending") {
            pending.push({
              code: "provider_pending",
              capability: capability.id,
              provider: providerName,
              message: "provider「" + providerName + "」依赖未就绪：" + service,
              missing: handle.missing,
            });
          } else if (handle.status === "error") {
            errors.push({
              code: "provider_error",
              capability: capability.id,
              provider: providerName,
              message: "provider「" + providerName + "」启动失败：" + messageOf(handle.error),
            });
          }
        } catch (e) {
          // A provide() duplicate or a broken module must not abort the rest of the manifest.
          errors.push({
            code: "provider_error",
            capability: capability.id,
            provider: providerName,
            message: "provider「" + providerName + "」挂载异常：" + messageOf(e),
          });
        }
      }
    }

    const result: KernelApplyResult = {
      profile: manifest.profile,
      changed: true,
      started: started,
      pending: pending,
      errors: errors,
      ignored: ignored,
      issues: parsed.issues,
      capabilities: manifest.capabilities,
      limits: manifest.limits,
    };
    lastPrint = print;
    lastResult = result;
    return result;
  }

  return {
    v: 1,
    apply: apply,
    get: function (service: string): unknown {
      return scope === null ? undefined : scope.get(service);
    },
    has: function (service: string): boolean {
      return scope !== null && scope.has(service);
    },
    explain: function (id: string): ExplainResult | null {
      return scope === null ? null : scope.explain(id);
    },
    status: function (): KernelApplyResult {
      return lastResult === null ? idleResult() : lastResult;
    },
    providerNames: function (): readonly string[] {
      return Array.from(providerMap.keys());
    },
    checkLimit: function (surface: unknown, bytes: unknown): RuntimeLimitVerdict {
      const limits = lastResult === null ? DEFAULT_RUNTIME_LIMITS : lastResult.limits;
      return checkRuntimeLimit(limits, surface, bytes);
    },
    dispose: function (): void {
      if (scope !== null) {
        scope.dispose();
        scope = null;
      }
      lastPrint = "";
      lastResult = null;
    },
  };
}

/** Host identity inputs: origin is the page's origin, adapter is the selected DbPort name. */
export interface HostIdentity {
  readonly origin: string;
  readonly adapter: string;
}

/**
 * Stable host key (`origin|adapter`). Profile is deliberately NOT part of it: logging in flips
 * guest→account and must not look like "a new host, choose what to keep".
 */
export function hostKey(input: unknown): string {
  const o = recOf(input);
  const origin = typeof o.origin === "string" ? o.origin.trim().replace(/\/+$/, "").toLowerCase() : "";
  const adapter = typeof o.adapter === "string" ? o.adapter.trim().toLowerCase() : "";
  if (!origin) return "";
  return origin + "|" + (adapter || "unknown");
}

export type FirstConnectChoice = "local" | "host" | "merge";

export interface FirstConnectOption {
  readonly id: FirstConnectChoice;
  /** UI copy lives in services/ui/settings-deploy; the plan only carries the rule. */
  readonly requiresBackup: boolean;
  /** True when the choice replaces one side instead of merging. */
  readonly destructive: boolean;
}

/** Warning codes instead of sentences: the dialog owns the wording (and the i18n dictionary). */
export type FirstConnectWarning = "" | "backup_missing" | "host_unknown";

export interface FirstConnectPlan {
  readonly isNewHost: boolean;
  readonly previous: string;
  readonly current: string;
  readonly backupAvailable: boolean;
  readonly warning: FirstConnectWarning;
  readonly options: readonly FirstConnectOption[];
}

const FIRST_CONNECT_OPTIONS: readonly FirstConnectOption[] = [
  { id: "local", requiresBackup: true, destructive: true },
  { id: "host", requiresBackup: true, destructive: true },
  { id: "merge", requiresBackup: true, destructive: false },
];

/**
 * Decide whether this is a first connection to a different host and which three choices apply.
 * Every choice asks for a backup first (the requirement is "merge backs up first"; taking the
 * backup before the destructive two as well is the only safe reading). A missing `backupSvc` does
 * not block the choice — it produces `warning: "backup_missing"` so the dialog can say plainly
 * that continuing will not back anything up. An empty current key means the page cannot identify
 * its host; the plan then refuses to claim "new host" instead of inventing one.
 */
export function planFirstConnect(currentRaw: unknown, previousRaw: unknown, backupAvailable: unknown): FirstConnectPlan {
  const current = typeof currentRaw === "string" ? currentRaw.trim() : "";
  const previous = typeof previousRaw === "string" ? previousRaw.trim() : "";
  const backup = backupAvailable === true;
  if (!current) {
    return {
      isNewHost: false,
      previous: previous,
      current: "",
      backupAvailable: backup,
      warning: "host_unknown",
      options: FIRST_CONNECT_OPTIONS,
    };
  }
  const isNewHost = !!previous && previous !== current;
  return {
    isNewHost: isNewHost,
    previous: previous,
    current: current,
    backupAvailable: backup,
    warning: isNewHost && !backup ? "backup_missing" : "",
    options: FIRST_CONNECT_OPTIONS,
  };
}
