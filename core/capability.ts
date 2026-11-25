/**
 * L1c capability provider contract skeleton: type layer + read-only tables, deliberately not
 * wired. The 16 hand-rolled `fetch('/api...')` sites and the five scattered permission gates
 * cannot converge on one source of truth without these shapes; L2's `compileTools({ caps })`
 * consumes the snapshot instead of probing the environment or storage on its own.
 *
 * Boundary: shapes only — no implementation, no public/ call-site edits, nothing added to the
 * frozen window globals. The 16 fetch sites migrate to Transport one by one from L1c-2 on,
 * and only after this contract matches reality (two-way lock: test/capability-contract.test.mjs).
 * Capability evidence lives in CAPABILITY_SPECS (implementation file + signal literal, verified
 * by the test); line numbers rotted within one round when tried, literals do not. Exit criterion
 * mirrors L1a: 30 days without change, and every fetch routed through Transport once L1c closes.
 * @module core/capability
 */

/**
 * Environment capability id. Named after the gate's own criterion, not the tool name — one
 * capability can unlock several tools, and one tool may require two (pc_* reads both pcEnabled
 * and unlocked).
 */
export type CapabilityId =
  | "tauri"
  | "panel"
  | "unlocked"
  | "pcEnabled"
  | "pcBridge"
  | "localExec"
  | "sourceServer"
  | "multiAgent";

/**
 * Three states. The UI must be able to explain why a tool is missing: `off-user` (the user
 * turned it off) and `off-env` (the environment is not ready) must stay distinct — the first
 * sends the user to the capability page, the second to environment setup.
 */
export type CapabilityState = "ready" | "off-user" | "off-env";

/** Verdict for one capability. `reason` is present only when state is not ready, and doubles as UI copy. */
export interface CapabilityStatus {
  readonly id: CapabilityId;
  readonly state: CapabilityState;
  readonly reason?: string;
}

/**
 * One snapshot, consumed directly by L2's `compileTools({ caps })`. Eight flat booleans instead
 * of a `Record<CapabilityId, boolean>` on purpose: a mistyped key like caps["tauir"] compiles
 * against a record and silently reads false at runtime, while a flat field miss is caught by
 * the type checker.
 */
export interface CapabilitySnapshot {
  readonly tauri: boolean;
  readonly panel: boolean;
  readonly unlocked: boolean;
  readonly pcEnabled: boolean;
  readonly pcBridge: boolean;
  readonly localExec: boolean;
  readonly sourceServer: boolean;
  readonly multiAgent: boolean;
  /** Channel-declared capability flags (vision / tool calls), from the model catalog, not the local environment. */
  readonly providerFeatures: readonly string[];
}

// Runtime mirror of the CapabilityId union plus the evidence pointer. The union alone forced
// every Status builder to hand-copy eight strings and let injected fake ids through unchecked;
// this table makes the set iterable and pins who judges each bit (`signal` is the literal the
// gate reads, not a description).
export interface CapabilitySpec {
  readonly id: CapabilityId;
  /** Implementation file holding the criterion (repo-relative path). */
  readonly file: string;
  /** Signal literal the criterion greps for. The test requires it verbatim — moving the flag or the file turns the lock red. */
  readonly signal: string;
}

export const CAPABILITY_SPECS: readonly CapabilitySpec[] = [
  { id: "tauri", file: "public/services/local/pc-tools.js", signal: "window.__TAURI__" },
  { id: "panel", file: "public/services/ui/stage-tools.js", signal: "__panel.v === 1" },
  { id: "unlocked", file: "public/services/auth/unlock.js", signal: "cfw_unlocked_v1" },
  { id: "pcEnabled", file: "public/services/local/pc-tools.js", signal: "cfw_pc_enabled_v1" },
  { id: "pcBridge", file: "public/services/local/pc-tools.js", signal: "cfw_pc_bridge_token_v1" },
  { id: "localExec", file: "public/services/local/local-exec-tools.js", signal: "cfw_local_exec_token" },
  { id: "sourceServer", file: "public/services/agent/source-tools.js", signal: "cfw_source_tools_on_v1" },
  { id: "multiAgent", file: "public/shared/agent/tools.js", signal: "tavern_multi_agent_mode_v1" },
];

/** Runtime id list — derived from SPECS, never a second copy of the literals (two copies drift). */
export const CAPABILITY_IDS: readonly CapabilityId[] = CAPABILITY_SPECS.map((s) => s.id);

/**
 * Three states → boolean snapshot (the shape L2's `compileTools({ caps })` consumes). One-way:
 * only `ready` counts, `off-user` / `off-env` both collapse to false — the reasons stay in the
 * statuses for the UI. No reverse mapping on purpose: a boolean cannot tell user-off from
 * env-not-ready, and forcing one would lie. Unknown ids are ignored silently: the L2 sample's
 * `requires` still uses the unaligned workspace/network/pcToken names; they should default to
 * closed, not throw — fail-closed belongs to the gate, not this layer.
 */
export function toCapabilitySnapshot(
  statuses: readonly CapabilityStatus[],
  providerFeatures: readonly string[] = [],
): CapabilitySnapshot {
  const ready = new Set<CapabilityId>();
  for (const s of statuses) if (s.state === "ready") ready.add(s.id);
  return {
    tauri: ready.has("tauri"),
    panel: ready.has("panel"),
    unlocked: ready.has("unlocked"),
    pcEnabled: ready.has("pcEnabled"),
    pcBridge: ready.has("pcBridge"),
    localExec: ready.has("localExec"),
    sourceServer: ready.has("sourceServer"),
    multiAgent: ready.has("multiAgent"),
    providerFeatures: [...providerFeatures],
  };
}

/** Exactly three tokens. The auth one is the pc channel's historical fallback key, see SecretSpec.fallbackKey — not listed separately. */
export type SecretId = "unlock" | "pcBridge" | "localExec";

/** How the token travels: a body field or a request header. */
export type SecretCarrier = "body" | "header";

/**
 * Where one token lands. Field values are copied verbatim from the current implementations;
 * test/capability-contract.test.mjs greps public/ for each string and turns red if the
 * implementation stops using it.
 */
export interface SecretSpec {
  readonly id: SecretId;
  readonly storageKey: string;
  /** Historical fallback key. The pc channel falls back to `cfw_auth_token_v1` when `cfw_pc_bridge_token_v1` is empty. */
  readonly fallbackKey?: string;
  /** Body field name or header name, paired with carrier. */
  readonly field: string;
  readonly carrier: SecretCarrier;
  /** Which ApiScope it authenticates. unlock rides /api/chat via app; the other two hit local services directly. */
  readonly scope: ApiScope;
}

/**
 * The single source of truth for the three tokens. Pure data, no side effects: importing never
 * touches storage. Not a config — a mirror of reality; change the public/ implementation first
 * or the test goes red.
 */
export const SECRET_SPECS: readonly SecretSpec[] = [
  {
    id: "unlock",
    storageKey: "cfw_unlock_token_v1",
    field: "unlockToken",
    carrier: "body",
    scope: "app",
  },
  {
    id: "pcBridge",
    storageKey: "cfw_pc_bridge_token_v1",
    fallbackKey: "cfw_auth_token_v1",
    field: "x-pc-token",
    carrier: "header",
    scope: "pc",
  },
  {
    id: "localExec",
    storageKey: "cfw_local_exec_token",
    field: "x-local-token",
    carrier: "header",
    scope: "localExec",
  },
];

/** Token access interface. `set` is for explicit user action only (capability page / settings card); an agent may at most propose. */
export interface SecretProvider {
  get(id: SecretId): string;
  has(id: SecretId): boolean;
  set(id: SecretId, value: string): void;
  readonly specs: readonly SecretSpec[];
}

/**
 * Four target classes. Split by who authenticates and what failure copy looks like, not by URL
 * prefix: app — same-origin /api/* (the vast majority of the 16), failures are HTTP codes plus
 * the Worker error field; pc — both pc_* tiers, direct 127.0.0.1:8802 bridge falling back to
 * same-origin /api/pc; localExec — local_* direct to 127.0.0.1:8801, unconfigured means a
 * go-start-the-service hint, not a network error; sourceServer — 8797 sources / 8796 artifacts,
 * same human-readable hint.
 */
export type ApiScope = "app" | "pc" | "localExec" | "sourceServer";

/** Response consumption shape. All four really exist today (chat-stream streams, pc screenshots are blobs). */
export type ApiResponseKind = "json" | "text" | "stream" | "blob";

/**
 * One request. `body` is already serialized: token injection must happen before serialization,
 * or unlock.js's parse-the-string-just-to-rejoin-it patch returns.
 */
export interface ApiRequest {
  readonly scope: ApiScope;
  readonly path: string;
  readonly method?: string;
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly kind?: ApiResponseKind;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** Response. The raw four kept intact so call sites can migrate stepwise instead of rewriting their parsing in one shot. */
export interface ApiResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  blob(): Promise<Blob>;
  stream(): ReadableStream<Uint8Array> | null;
}

/**
 * The request exit. `reachable` only reads capability bits and config — it never sends probe
 * requests; probing every turn would wreck first-token latency and break the
 * catalog-text-in-system, statically-cacheable rule.
 */
export interface Transport {
  request(req: ApiRequest): Promise<ApiResponse>;
  reachable(scope: ApiScope): boolean;
}

/**
 * The only export surface: capability bits + tokens + request exit in one object. L2's policy
 * depends on this alone — no environment probes, no storage reads of its own. Relation to
 * hostApi: this interface will eventually hang off hostApi (a new member, its own unit; not
 * grabbed in this one).
 */
export interface CapabilityProvider {
  snapshot(): CapabilitySnapshot;
  /** One entry per capability, in CapabilityId declaration order — the stable order for UI grouping. */
  explain(): readonly CapabilityStatus[];
  readonly secrets: SecretProvider;
  readonly transport: Transport;
}
