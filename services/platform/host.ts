/**
 * Host provider registry: which seams this page talks to, and why.
 *
 * The desktop shell loads a fixed origin (the bundled page) while the data plane lives in a Node
 * sidecar on `127.0.0.1:8787`. That makes "which host am I on" a runtime question, answered here once
 * and shared as runtime services instead of being re-derived by every module:
 *   · `transport` (core/ports) — the request exit. Business code will inject it; until T4-A rewires
 *     the hand-rolled fetch sites, `tooling/l0/wiring/host.js` also installs a URL router so the existing
 *     relative `/api/*`, `/sync*` and `/img/*` calls reach the host without touching those call sites.
 *   · `key` (core/ports) — read-only token access. The access token lives in localStorage today
 *     (`services/auth/token.ts`); this port reads through a closure so the value is never copied.
 *   · `db` — selected through the DbPort facade (`dbSvc.use`). It is provided once by the facade as a
 *     forwarding bridge, which is exactly what keeps `ctx.get("db")` valid across host switches; a
 *     second `provide("db", …)` here would throw in the kernel, so the registry drives selection
 *     instead of re-registering the service.
 *
 * `/api/runtime` (T4-C) only refines the profile label. Missing endpoint is not an error: the desktop
 * infers `desktop` from a healthy `/config.js`, and everything else falls back to D1 defaults with a
 * reason recorded — this batch must not depend on a file another batch owns.
 *
 * Boundary: no DOM types, no storage reads, no shell globals. The wiring supplies the shell probe,
 * the base, the fetch and the token reader, so every decision here runs in a Node test unchanged.
 * @module services/platform/host
 */

import type { SecretPort, TransportPort, TransportRequest, TransportResponse } from "../../core/ports";

/** The subset of `fetch` this module needs; a real `fetch` is structurally assignable. */
export interface HostFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export interface HostFetchInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly redirect?: string;
}

export interface HostFetch {
  (url: string, init?: HostFetchInit): Promise<HostFetchResponse>;
}

/** Parsed `/api/runtime` answer. `profile` is the only field the decision needs. */
export interface RuntimeInfo {
  readonly profile: string;
  readonly capabilities: readonly string[];
  readonly limits: Readonly<Record<string, string>>;
}

/** One seam as the status panel/explain() reports it. */
export interface SeamView {
  readonly name: string;
  readonly provided: boolean;
  readonly by: string;
  readonly reason: string;
}

/** Everything `hostSvc.status()` answers. */
export interface HostStatus {
  readonly shell: boolean;
  readonly profile: string;
  readonly base: string;
  readonly db: string;
  readonly transport: string;
  readonly health: "ok" | "down" | "unknown";
  readonly runtime: { readonly found: boolean; readonly profile: string; readonly reason: string };
  readonly seams: readonly SeamView[];
  readonly reason: string;
  readonly updatedAt: number;
}

/** The minimal DbPort facade surface the registry drives (services/platform/db.ts). */
export interface HostDbSelector {
  use(name: string, options?: unknown): unknown;
  adapter(): string;
}

/** The minimal runtime-context surface (core/runtime.ts). */
export interface HostContext {
  provide(name: string, value: unknown): void;
  has(name: string): boolean;
}

export interface HostRegistryOptions {
  readonly context: HostContext;
  readonly db: HostDbSelector;
  /** True when the desktop shell exposes a working invoke. */
  readonly shell: boolean;
  /** Host base for the shell path; ignored on the web (same origin). */
  readonly base?: string;
  readonly fetchImpl?: HostFetch;
  /** Access token for the sidecar's Bearer gate; read per request, never cached. */
  readonly token?: () => string;
  /** Origin of the page, used to leave third-party URLs alone. Defaults to a placeholder. */
  readonly pageOrigin?: string;
  readonly now?: () => number;
  /** Probe timeouts (tests shorten these). */
  readonly timeoutMs?: number;
}

export interface HostRegistry {
  readonly v: 1;
  /** Resolves with the first decision; rejects only on a caller bug, never on a dead host. */
  readonly ready: Promise<HostStatus>;
  status(): HostStatus;
  /** Re-probe and re-select; used after the base or the token changes. */
  refresh(): Promise<HostStatus>;
  /** Point the registry at another host base ("" restores the default in the shell). */
  setBase(base: string): Promise<HostStatus>;
  /** Rewrite one request URL for the active host ("" base = unchanged). */
  route(url: string): string;
  /** The transport port handed to the runtime context. */
  transport(): TransportPort;
  /** The read-only secret port handed to the runtime context. */
  key(): SecretPort;
  /** The last decision, as a plain object (tests and the status panel read this). */
  decision(): HostDecision;
}

/** What the decision step returns; `reason` is user-explainable. */
export interface HostDecision {
  readonly profile: string;
  readonly db: string;
  readonly transport: "http" | "same-origin";
  readonly base: string;
  readonly health: "ok" | "down" | "unknown";
  readonly runtimeFound: boolean;
  readonly reason: string;
}

/** Inputs to the pure decision; every field is already observed, nothing is probed here. */
export interface HostDecisionInput {
  readonly shell: boolean;
  readonly base: string;
  readonly health: "ok" | "down" | "unknown";
  readonly runtime: RuntimeInfo | null;
}

/** Default sidecar origin. Explicit rather than "same as the page": the page is an app protocol. */
export const DEFAULT_HOST_BASE = "http://127.0.0.1:8787";
/** Token storage key; mirrors services/auth/token.ts (single read path stays there). */
export const ACCESS_TOKEN_ID = "access";

/** Object view without an assertion. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Strip trailing slashes; refuse a non-absolute value so a typo cannot become a page-relative path. */
export function normalizeBase(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) return "";
  return value.replace(/\/+$/, "");
}

/** Paths that belong to the host's data plane; everything else stays on the page origin. */
function isApiPath(pathname: string): boolean {
  if (pathname === "/sync" || pathname.indexOf("/sync/") === 0) return true;
  return pathname.indexOf("/api/") === 0 || pathname.indexOf("/img/") === 0;
}

/**
 * Route one request URL to the host. Pure and total: anything unrecognised is returned unchanged, so
 * a wrong base can break the API but can never rewrite a CDN URL or a data: URI.
 */
export function routeUrl(raw: string, base: string, pageOrigin?: string): string {
  const value = typeof raw === "string" ? raw : "";
  const root = normalizeBase(base);
  if (!value || !root) return value;
  if (/^(data|blob|javascript|mailto|tel):/i.test(value)) return value;
  const page = typeof pageOrigin === "string" ? pageOrigin.replace(/\/+$/, "") : "";

  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(value) || value.indexOf("//") === 0;
  if (!absolute) {
    // Relative path: the app only ever calls API paths this way.
    const cut = value.indexOf("?");
    const path = cut >= 0 ? value.slice(0, cut) : value;
    const rest = cut >= 0 ? value.slice(cut) : "";
    if (!isApiPath(path)) return value;
    return root + path + rest;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (e) {
    return value;
  }
  // Same-origin absolute URLs are the page's own API calls; third-party URLs keep their origin.
  if (!page || parsed.origin !== page) return value;
  if (!isApiPath(parsed.pathname)) return value;
  return root + parsed.pathname + parsed.search + parsed.hash;
}

/** Parse `/api/runtime`. Returns null for a missing or malformed body instead of guessing. */
export function parseRuntime(payload: unknown): RuntimeInfo | null {
  if (!isRecord(payload)) return null;
  const profile = typeof payload.profile === "string" ? payload.profile.trim() : "";
  if (!profile) return null;
  const capabilities: string[] = [];
  if (Array.isArray(payload.capabilities)) {
    for (const item of payload.capabilities) if (typeof item === "string" && item) capabilities.push(item);
  }
  const limits: Record<string, string> = {};
  if (isRecord(payload.limits)) {
    for (const key of Object.keys(payload.limits)) {
      const v = payload.limits[key];
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") limits[key] = String(v);
    }
  }
  return { profile: profile, capabilities: capabilities, limits: limits };
}

/**
 * The host decision. Desktop: the sidecar is the host whenever `/config.js` answers; `/api/runtime`
 * only renames the profile. Web: always D1 (same origin), profile from the manifest when present.
 */
export function decideHost(input: HostDecisionInput): HostDecision {
  const base = normalizeBase(input.base);
  const profile = input.runtime !== null ? input.runtime.profile : "";
  const runtimeFound = input.runtime !== null;
  if (!input.shell) {
    return {
      profile: profile || "guest",
      db: "d1",
      transport: "same-origin",
      base: "",
      health: input.health,
      runtimeFound: runtimeFound,
      reason: runtimeFound
        ? "web: /api/runtime profile " + profile
        : "web: no /api/runtime (T4-C) — D1 defaults, profile guest",
    };
  }
  if (input.health === "ok") {
    return {
      profile: profile || "desktop",
      db: "node",
      transport: "http",
      base: base || DEFAULT_HOST_BASE,
      health: "ok",
      runtimeFound: runtimeFound,
      reason: runtimeFound
        ? "desktop: /api/runtime says " + profile + "; sidecar healthy"
        : "desktop: /api/runtime missing (T4-C) — inferred from a healthy /config.js",
    };
  }
  return {
    profile: profile || "desktop",
    db: "d1",
    transport: "http",
    base: base || DEFAULT_HOST_BASE,
    health: input.health === "down" ? "down" : "unknown",
    runtimeFound: runtimeFound,
    reason:
      "desktop: host " + (input.health === "down" ? "unreachable" : "not probed yet") +
      " — D1 fallback until it answers (first-run step explains how to start it)",
  };
}

/** Race a promise against a timeout; the host must never hang a boot path. */
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  if (ms <= 0) return work;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + " timed out after " + String(ms) + "ms")), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** `/config.js` answering with the OwnChat marker is the readiness contract (same as the old probe). */
export async function probeHealth(fetchImpl: HostFetch, base: string, timeoutMs: number): Promise<"ok" | "down"> {
  const root = normalizeBase(base);
  if (!root) return "down";
  try {
    const res = await withTimeout(
      Promise.resolve(fetchImpl(root + "/config.js", { method: "GET", redirect: "manual" })),
      timeoutMs,
      "/config.js",
    );
    if (!res.ok) return "down";
    const body = await withTimeout(Promise.resolve(res.text()), timeoutMs, "/config.js body");
    return body.indexOf("APP_CTX_EXACT") >= 0 ? "ok" : "down";
  } catch (e) {
    return "down";
  }
}

/** Probe `/api/runtime`; a 404 is the expected state until T4-C lands, not a failure. */
export async function probeRuntime(
  fetchImpl: HostFetch,
  base: string,
  timeoutMs: number,
): Promise<{ info: RuntimeInfo | null; reason: string }> {
  const root = normalizeBase(base);
  // "" means the page origin: the web build asks its own deployment, the shell always has a base.
  const url = (root || "") + "/api/runtime";
  try {
    const res = await withTimeout(
      Promise.resolve(fetchImpl(url, { method: "GET", redirect: "manual" })),
      timeoutMs,
      "/api/runtime",
    );
    if (res.status === 404) return { info: null, reason: "endpoint missing (T4-C not merged)" };
    if (!res.ok) return { info: null, reason: "HTTP " + String(res.status) };
    const text = await withTimeout(Promise.resolve(res.text()), timeoutMs, "/api/runtime body");
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return { info: null, reason: "malformed JSON" };
    }
    const info = parseRuntime(parsed);
    return info === null ? { info: null, reason: "missing profile field" } : { info: info, reason: "ok" };
  } catch (e) {
    // Unreachable, timed out or CORS-blocked all mean the same thing: no manifest at this origin.
    return { info: null, reason: errText(e) };
  }
}

/** Build the registry. The returned `ready` never rejects for host-side failures. */
export function createHostRegistry(options: HostRegistryOptions): HostRegistry {
  if (!options || !options.context || !options.db) throw new Error("host: context and db are required");
  const fetchImpl: HostFetch = typeof options.fetchImpl === "function" ? options.fetchImpl : (): Promise<HostFetchResponse> => Promise.reject(new Error("host: fetch is unavailable"));
  const token = typeof options.token === "function" ? options.token : () => "";
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : 2500;
  const pageOrigin = typeof options.pageOrigin === "string" ? options.pageOrigin : "";
  let base = normalizeBase(options.base) || (options.shell ? DEFAULT_HOST_BASE : "");
  let health: "ok" | "down" | "unknown" = "unknown";
  let decision = decideHost({ shell: options.shell, base: base, health: health, runtime: null });
  let runtimeReason = "not probed yet";
  let applied = { name: "", base: "", token: "" };
  let updatedAt = now();
  let transportProvided = "";
  let keyProvided = "";

  /** The HTTP transport seam. Token read per request: a sign-in must not rebuild the port. */
  const transportPort: TransportPort = {
    async send(req: TransportRequest): Promise<TransportResponse> {
      const url = routeUrl(req.url, base, pageOrigin);
      const headers: Record<string, string> = {};
      if (req.headers) for (const k of Object.keys(req.headers)) headers[k] = String(req.headers[k]);
      const authToken = token();
      if (authToken && isApiPath(new URL(url, pageOrigin || "http://localhost").pathname) && !headers["authorization"]) {
        headers["authorization"] = "Bearer " + authToken;
      }
      const res = await fetchImpl(url, { method: req.method || "GET", headers: headers, body: req.body });
      return { ok: res.ok, status: res.status, text: () => res.text() };
    },
  };

  /** Read-only secret view. Only the access token is backed today; unknown ids answer "". */
  function readSecret(id: string): string {
    return id === ACCESS_TOKEN_ID ? token() : "";
  }
  const secretPort: SecretPort = {
    get: readSecret,
    has: (id: string) => readSecret(id) !== "",
  };

  /** Provide each seam once (the kernel refuses duplicates), and record who provided it. */
  function provideSeams(dec: HostDecision): void {
    if (dec.transport === "http" && !transportProvided) {
      if (options.context.has("transport")) {
        transportProvided = "pre-existing";
      } else {
        options.context.provide("transport", transportPort);
        transportProvided = "host(desktop)";
      }
    }
    if (dec.transport === "http" && !keyProvided) {
      if (options.context.has("key")) {
        keyProvided = "pre-existing";
      } else {
        options.context.provide("key", secretPort);
        keyProvided = "host(desktop)";
      }
    }
  }

  /** Select the DbPort adapter; re-selecting is how a base/token change takes effect. */
  function selectDb(dec: HostDecision): void {
    const tokenNow = dec.db === "node" ? token() : "";
    if (applied.name === dec.db && applied.base === dec.base && applied.token === tokenNow) return;
    const adapterOptions = dec.db === "node" ? { base: dec.base, token: tokenNow } : undefined;
    try {
      options.db.use(dec.db, adapterOptions);
      applied = { name: dec.db, base: dec.base, token: tokenNow };
    } catch (e) {
      // A missing adapter is a deployment error, not a reason to keep booting silently: fall back to
      // d1 once and record why (the explain view names it).
      runtimeReason = "adapter " + dec.db + " unavailable (" + errText(e) + "); using d1";
      decision = {
        profile: dec.profile,
        db: "d1",
        transport: dec.transport,
        base: dec.base,
        health: dec.health,
        runtimeFound: dec.runtimeFound,
        reason: runtimeReason,
      };
      if (applied.name !== "d1") {
        options.db.use("d1", undefined);
        applied = { name: "d1", base: "", token: "" };
      }
    }
  }

  function status(): HostStatus {
    const adapter = options.db.adapter() || decision.db;
    const seams: SeamView[] = [
      {
        name: "transport",
        provided: transportProvided !== "",
        by: transportProvided || "none",
        reason:
          transportProvided !== ""
            ? "requests leave through " + (decision.transport === "http" ? decision.base : "the page origin")
            : "web host: business code keeps its same-origin fetch until T4-A injects transport",
      },
      {
        name: "key",
        provided: keyProvided !== "",
        by: keyProvided || "none",
        reason:
          keyProvided !== ""
            ? "read-only view of the access token (localStorage-owned)"
            : "web host: no token seam needed (same-origin /api carries it)",
      },
      {
        name: "db",
        provided: true,
        by: "dbSvc facade",
        reason: "selected adapter: " + adapter + " (forwarding bridge keeps ctx.get('db') stable)",
      },
    ];
    return {
      shell: options.shell,
      profile: decision.profile,
      base: decision.base,
      db: adapter,
      transport: decision.transport,
      health: health,
      runtime: { found: decision.runtimeFound, profile: decision.runtimeFound ? decision.profile : "", reason: runtimeReason },
      seams: seams,
      reason: decision.reason,
      updatedAt: updatedAt,
    };
  }

  async function refresh(): Promise<HostStatus> {
    const nextBase = normalizeBase(base) || (options.shell ? DEFAULT_HOST_BASE : "");
    base = nextBase;
    let runtime: RuntimeInfo | null = null;
    if (options.shell) {
      const probe = await probeHealth(fetchImpl, base, timeoutMs);
      health = probe;
      if (probe === "ok") {
        const rt = await probeRuntime(fetchImpl, base, timeoutMs);
        runtime = rt.info;
        runtimeReason = rt.reason;
      } else {
        runtimeReason = "host did not answer /config.js";
      }
    } else {
      health = "unknown";
      const rt = await probeRuntime(fetchImpl, "", timeoutMs);
      runtime = rt.info;
      runtimeReason = rt.reason;
    }
    decision = decideHost({ shell: options.shell, base: base, health: health, runtime: runtime });
    provideSeams(decision);
    selectDb(decision);
    updatedAt = now();
    return status();
  }

  const ready = refresh().catch((e) => {
    // A probe bug must surface as an explainable degraded state, never as a boot rejection.
    runtimeReason = "probe failed: " + errText(e);
    decision = decideHost({ shell: options.shell, base: base, health: "down", runtime: null });
    provideSeams(decision);
    selectDb(decision);
    updatedAt = now();
    return status();
  });

  // Boot-time provisional selection, synchronously: shell → d1 relative (the router already points at
  // the sidecar, so early calls still work) until /config.js answers; web → d1 as always. Doing it here
  // rather than waiting for `ready` also keeps the facade from picking `tauri` in the meantime, so the
  // desktop's adapter is node/d1 by construction, not by race.
  provideSeams(decision);
  selectDb(decision);

  return {
    v: 1,
    ready: ready,
    status: status,
    refresh: refresh,
    setBase: (next: string) => {
      base = normalizeBase(next) || (options.shell ? DEFAULT_HOST_BASE : "");
      updatedAt = now();
      return refresh();
    },
    route: (url: string) => routeUrl(url, base, pageOrigin),
    transport: () => transportPort,
    key: () => secretPort,
    decision: () => decision,
  };
}
