// core/host-api.ts — the hostApi v1 contract skeleton (L1a, item 2)
//
// Role: the single window contract surface the repository converges on. The page is still a few
// hundred classic scripts calling each other through globals, so load order decides what mounts;
// without a fixed shape, every later annotation documents an accidental shape instead of a contract.
//
// Scope: types only. Nothing is assembled at runtime yet — the browser has no window.hostApi until
// the compat shadow layer is wired in, which is why globals.d.ts still carries the old facade
// declarations. Deleting them now would turn the files already running under @ts-check red for no
// gain; "no new globals" is enforced by the frozen-name gate in scripts/check-contracts.mjs instead
// (positive control: adding a contract name exits 1 and names it).
//
// House rules for this file: no loose escape types, no type assertions, no suppression comments.
//
// Retire criterion: unchanged for 30 consecutive days.
//
// @module core/host-api

// tools is the L2 agent-tool-layer contract slot.
//
// The tool layer needs a published shape, and a fresh global was the original plan — the L1a freeze
// rules that out, so the shape lands on hostApi.tools.manifest. Field names are the ones in
// bundles/agent/manifest/schema.json; test/tool-manifest.test.mjs keeps the two in lockstep. The
// `risk` enum values and the concrete schema shapes are left to L2 when it migrates, so they are
// `string` and `Record<string, unknown>` here rather than a guess or an escape type.
//
// `manifest` is optional on purpose: the L0a generator is not wired in yet, and policy code has to be
// writable and testable before it is. A pure data manifest under bundles/agent/manifest/ adds no
// window global, which is what keeps the frozen-name gate quiet for L2.

/** One tool declaration; bundles/agent/manifest/schema.json must match it field for field. */
// Owner ruling 2026-11-14: `requires` lists tool prerequisites (workspace = workspace file access,
// network, pcToken = PC-channel token) and is a *different taxonomy* from a bundle's `capabilities`
// (host capability bits). The trust gate rejects the one tool when a prerequisite is missing; the
// host rejects the whole bundle when a capability bit is absent. Do not rename one to match the
// other, and do not invent a host capability for `network`.
export interface ToolManifestEntry {
  id: string;
  group: string;
  summary: string;
  keywords: string[];
  provider: string;
  requires: string[];
  risk: string;
  sideEffect: boolean;
  residentCandidate: boolean;
  defaultEnabled: boolean;
  schema: Record<string, unknown>;
}

/** Read-only manifest produced at build time by L0a (a classic script artifact, never fetched). */
export interface ToolManifest {
  entries: readonly ToolManifestEntry[];
}

/** hostApi.tools: one compilation, three consumers (registration / request / UI). */
export interface ToolHostApi {
  /** Undefined until the L0a generator is wired in; afterwards the generator fills it, readers only. */
  readonly manifest?: ToolManifest;
}

/** The one window contract surface. Members are camelCase, replacing the old double-underscore names. */
export interface HostApi {
  /** App shell: conversation / send / status panel read-only data. Source: l0/wiring/app.js (product /services/chat/app.js) */
  app: AppFacade;
  /** Cost ledger and pricing. Source: l0/wiring/app.js (some members mount later) */
  cost: CostFacade;
  /** Cleanup pipeline probe. Source: services/chat/pipeline.ts */
  pipeline: PipelineFacade;
  /** Per-conversation turn registry and lifecycle. Source: public/services/agent-host/turn-runtime.js */
  turnRuntime: TurnRuntimeFacade;
  /** Cloud sync. Source: services/data/sync.ts */
  sync: SyncFacade;
  /** Role cards. Source: services/data/character.ts */
  character: CharacterFacade;
  /** Multi-character scene. Source: services/scene/multi-agent.ts */
  multi: MultiFacade;
  /** Auth middleware. Source: public/js/text/core/auth.js:85-90 */
  auth: AuthFacade;
  /**
   * The L2 agent-tool-layer contract slot.
   *
   * Unlike the eight facades above it is not collected from an existing global name: it is where a
   * new service lands. That is also why it is a **required** member — the slot itself always exists,
   * and "no generator yet" is expressed one level down by the optional manifest. Keeping those two
   * facts apart lets L2 policy code read hostApi.tools and then decide whether the manifest is ready.
   */
  tools: ToolHostApi;
}

declare global {
  interface Window {
    /** Transitional: coexists with the old facades until the compat shadow phase ends. */
    hostApi: HostApi;
  }
}
