/**
 * External sandbox views: URL construction and parameter validation for the
 * independent sandbox's 2D pages (`demo/starmap.html`, `demo/play.html`).
 *
 * The independent repository is AGPL-3.0-only. Nothing from it is copied here:
 * this module only knows the two public page paths and the query parameters the
 * pages read. The base URL is owner-configured (`cfw_panel_sandbox_url_v1`);
 * loopback addresses work only on the machine running the sandbox, while a
 * phone needs a reachable source (separate deployment or a LAN IP).
 *
 * Runtime shape: pure functions plus a thin factory over an injected
 * `getBaseUrl` port, so this file runs unchanged in a browser wiring and in a
 * Node test. Cross-origin iframes are assumed: no `postMessage` protocol is
 * assumed here, and nothing reads the page's DOM.
 *
 * @module services/sandbox/views
 */

/** localStorage key holding the sandbox root URL (no trailing `/demo/...`). */
export const SANDBOX_BASE_KEY = "cfw_panel_sandbox_url_v1";

/** The two 2D pages the product mounts. 3D fly/terrain pages are intentionally absent. */
export const VIEW_PATHS: Readonly<Record<string, string>> = {
  starmap: "/demo/starmap.html",
  play: "/demo/play.html",
};

const MAX_SEED = 2147483647;
const MAX_BODY = 64;

export type SandboxViewKind = "starmap" | "play";
export type SandboxAutoMode = "on" | "land";

/** Owner-facing descriptor: what the view is and how to drive it. */
export interface SandboxViewDescriptor {
  readonly kind: SandboxViewKind;
  readonly path: string;
  readonly title: string;
  readonly hint: string;
}

/** Injected ports. `origin` is the main site origin when known. */
export interface SandboxViewsPorts {
  readonly getBaseUrl: () => unknown;
  readonly origin?: string;
}

/** Everything a caller may pass; values are validated, never trusted. */
export interface SandboxViewRequest {
  readonly view?: unknown;
  readonly seed?: unknown;
  readonly body?: unknown;
  readonly auto?: unknown;
}

/** A built URL or a fail-closed refusal with the same field shape. */
export interface SandboxViewPlan {
  readonly ok: boolean;
  readonly kind: string;
  readonly title: string;
  readonly path: string;
  readonly url: string;
  readonly params: string;
  readonly warnings: readonly string[];
  readonly reason?: string;
}

export interface SandboxConfig {
  readonly configured: boolean;
  readonly base: string | null;
  readonly origin: string | null;
  readonly loopback: boolean;
  readonly crossOrigin: boolean;
  readonly reason?: string;
}

export interface SandboxGuidance {
  readonly configured: boolean;
  readonly base: string | null;
  readonly title: string;
  readonly text: string;
  readonly warnings: readonly string[];
}

interface ParsedBase {
  readonly ok: boolean;
  readonly base: string;
  readonly origin: string;
  readonly loopback: boolean;
  readonly reason: string;
}

interface ParsedNumber {
  readonly ok: boolean;
  readonly value: number | null;
  readonly reason: string;
}

interface ParsedAuto {
  readonly ok: boolean;
  readonly value: SandboxAutoMode | null;
  readonly reason: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function recOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  return out;
}

function strOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Loopback is a real host fact, not a guess. `[::1]` is what URL reports. */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/**
 * Normalize the configured root. Accepts only http/https with an explicit
 * scheme, drops query/hash, and strips a pasted `/demo/starmap.html` or
 * `/demo/play.html` suffix back to the root. Credentials are refused rather
 * than sent in an iframe URL.
 */
export function normalizeSandboxBase(input: unknown): ParsedBase {
  const raw = strOf(input).trim();
  if (!raw) {
    return { ok: false, base: "", origin: "", loopback: false, reason: "沙盘根地址为空：设置 " + SANDBOX_BASE_KEY };
  }
  const candidate = raw.startsWith("//") ? "https:" + raw : raw;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch (e) {
    return { ok: false, base: "", origin: "", loopback: false, reason: "沙盘根地址不是合法 URL（需以 http:// 或 https:// 开头）" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, base: "", origin: "", loopback: false, reason: `沙盘根地址只接受 http/https，得到 ${url.protocol}` };
  }
  if (url.username || url.password) {
    return { ok: false, base: "", origin: "", loopback: false, reason: "沙盘根地址不得带用户名/密码" };
  }
  let path = url.pathname.replace(/\/+$/, "");
  const lower = path.toLowerCase();
  for (const suffix of Object.values(VIEW_PATHS)) {
    if (lower.endsWith(suffix)) {
      path = path.slice(0, path.length - suffix.length).replace(/\/+$/, "");
      break;
    }
  }
  const base = url.protocol + "//" + url.host + path;
  return {
    ok: true,
    base,
    origin: url.protocol + "//" + url.host,
    loopback: isLoopbackHost(url.hostname),
    reason: "",
  };
}

/** Seed: omitted/blank = null; otherwise a base-10 integer in [0, 2^31-1]. */
export function parseSeed(value: unknown): ParsedNumber {
  if (value === undefined || value === null) return { ok: true, value: null, reason: "" };
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0 || value > MAX_SEED) {
      return { ok: false, value: null, reason: `seed 必须是 0..${MAX_SEED} 的整数` };
    }
    return { ok: true, value, reason: "" };
  }
  if (typeof value !== "string") return { ok: false, value: null, reason: "seed 只接受数字或十进制字符串" };
  const text = value.trim();
  if (!text) return { ok: true, value: null, reason: "" };
  if (!/^\d+$/.test(text)) return { ok: false, value: null, reason: "seed 只接受十进制数字" };
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_SEED) {
    return { ok: false, value: null, reason: `seed 必须是 0..${MAX_SEED} 的整数` };
  }
  return { ok: true, value: n, reason: "" };
}

/** Planet index: omitted = null; otherwise an integer in [0, 64]. */
export function parseBody(value: unknown): ParsedNumber {
  if (value === undefined || value === null) return { ok: true, value: null, reason: "" };
  if (typeof value === "string" && value.trim() === "") return { ok: true, value: null, reason: "" };
  if (typeof value !== "number" && typeof value !== "string") {
    return { ok: false, value: null, reason: "body 只接受数字或十进制字符串" };
  }
  const n = typeof value === "number" ? value : Number(value.trim());
  if (!Number.isInteger(n) || n < 0 || n > MAX_BODY) {
    return { ok: false, value: null, reason: `body 必须是 0..${MAX_BODY} 的整数` };
  }
  return { ok: true, value: n, reason: "" };
}

/**
 * Auto mode: the demo treats any truthy `auto` as "generate + select", and
 * `auto=land` additionally presses "land". Everything else is refused instead
 * of becoming a silent random run.
 */
export function parseAuto(value: unknown): ParsedAuto {
  if (value === undefined || value === null) return { ok: true, value: null, reason: "" };
  if (typeof value === "boolean") return { ok: true, value: value ? "on" : null, reason: "" };
  if (typeof value === "number") {
    if (value === 0) return { ok: true, value: null, reason: "" };
    if (value === 1) return { ok: true, value: "on", reason: "" };
    return { ok: false, value: null, reason: "auto 只接受布尔值 / 0 / 1 / on / land / off" };
  }
  if (typeof value !== "string") {
    return { ok: false, value: null, reason: "auto 只接受布尔值 / 0 / 1 / on / land / off" };
  }
  const text = value.trim().toLowerCase();
  if (!text || text === "0" || text === "false" || text === "off") return { ok: true, value: null, reason: "" };
  if (text === "1" || text === "true" || text === "on" || text === "yes") return { ok: true, value: "on", reason: "" };
  if (text === "land" || text === "landing") return { ok: true, value: "land", reason: "" };
  return { ok: false, value: null, reason: "auto 只接受布尔值 / 0 / 1 / on / land / off" };
}

export function describeView(kind: unknown): SandboxViewDescriptor | null {
  if (kind === "starmap") {
    return {
      kind: "starmap",
      path: VIEW_PATHS.starmap,
      title: "星图",
      hint: "星图叠加视图：?seed= 固定同一片星空；不带 seed 时用默认种子。",
    };
  }
  if (kind === "play") {
    return {
      kind: "play",
      path: VIEW_PATHS.play,
      title: "星系 → 星球 → 地图",
      hint: "?auto 自动生成星系并选星，?body= 选行星，?auto=land 直接降落生成 96×64 地图。",
    };
  }
  return null;
}

/** Build the URL. Parameters are written in a fixed order (seed, body, auto). */
export function buildViewUrl(base: string, kind: SandboxViewKind, seed: number | null, body: number | null, auto: SandboxAutoMode | null): string {
  const url = new URL(base + VIEW_PATHS[kind]);
  const params = url.searchParams;
  if (seed !== null) params.set("seed", String(seed));
  if (body !== null) params.set("body", String(body));
  if (auto !== null) params.set("auto", auto);
  return url.href;
}

/**
 * Resolve configuration without throwing: a broken storage getter degrades to
 * "not configured" so the view entry stays disabled instead of half-working.
 */
export function sandboxConfig(ports: SandboxViewsPorts): SandboxConfig {
  let raw: unknown = null;
  try {
    raw = ports.getBaseUrl();
  } catch (e) {
    return { configured: false, base: null, origin: null, loopback: false, crossOrigin: false, reason: "读取沙盘配置失败" };
  }
  if (raw === null || raw === undefined || strOf(raw).trim() === "") {
    return { configured: false, base: null, origin: null, loopback: false, crossOrigin: false, reason: "未配置沙盘根地址" };
  }
  const parsed = normalizeSandboxBase(raw);
  if (!parsed.ok) {
    return { configured: false, base: null, origin: null, loopback: false, crossOrigin: false, reason: parsed.reason };
  }
  const pageOrigin = strOf(ports.origin).replace(/\/+$/, "");
  return {
    configured: true,
    base: parsed.base,
    origin: parsed.origin,
    loopback: parsed.loopback,
    crossOrigin: pageOrigin !== "" && pageOrigin.toLowerCase() !== parsed.origin.toLowerCase(),
    reason: "",
  };
}

const MOBILE_WARNING = "手机要访问必须有一个可达的源：独立部署，或与手机同网段的局域网 IP；127.0.0.1/localhost 只在本机有效。";
const CORS_WARNING = "这两个页面以 iframe 跨源挂载：主站读不到其 DOM，postMessage 协议暂不假定。";

/** Guidance for the settings/empty state. Contains the mobile reachability caveat. */
export function guidance(ports: SandboxViewsPorts): SandboxGuidance {
  const cfg = sandboxConfig(ports);
  if (!cfg.configured) {
    return {
      configured: false,
      base: null,
      title: "沙盘视图未配置",
      text: `把沙盘根地址写入 ${SANDBOX_BASE_KEY}（例：http://192.168.1.20:8000 或 https://sandbox.example.com）。`,
      warnings: [MOBILE_WARNING],
    };
  }
  const warnings: string[] = [];
  if (cfg.loopback) warnings.push(MOBILE_WARNING);
  if (cfg.crossOrigin) warnings.push(CORS_WARNING);
  return {
    configured: true,
    base: cfg.base,
    title: "沙盘视图",
    text: `沙盘源：${cfg.base}`,
    warnings,
  };
}

function fail(kind: string, reason: string, warnings: readonly string[]): SandboxViewPlan {
  return { ok: false, kind, title: "", path: "", url: "", params: "", warnings, reason };
}

/**
 * Validate a request and build the page URL. Fail-closed: an invalid seed/body/
 * auto or a view that does not accept a parameter returns `ok:false` with a
 * human-readable reason and the same guidance caveats.
 */
export function planView(ports: SandboxViewsPorts, request: SandboxViewRequest): SandboxViewPlan {
  const rec = recOf(request);
  if (rec === null) return fail("", "视图请求必须是对象", []);
  const kindRaw = rec["view"];
  const desc = describeView(kindRaw);
  if (desc === null) return fail(strOf(kindRaw), "未知视图：只支持 starmap / play", []);
  const cfg = sandboxConfig(ports);
  const guide = guidance(ports);
  if (!cfg.configured || cfg.base === null) {
    return fail(desc.kind, guide.text, guide.warnings);
  }

  const seed = parseSeed(rec["seed"]);
  const body = parseBody(rec["body"]);
  const auto = parseAuto(rec["auto"]);
  const warnings: string[] = [];
  if (guide.warnings.length) warnings.push(...guide.warnings);
  if (!seed.ok) return fail(desc.kind, seed.reason, warnings);
  if (!body.ok) return fail(desc.kind, body.reason, warnings);
  if (!auto.ok) return fail(desc.kind, auto.reason, warnings);

  if (desc.kind === "starmap" && (body.value !== null || auto.value !== null)) {
    return fail(desc.kind, "星图只接受 seed（body/auto 属于 play 页）", warnings);
  }
  if (desc.kind === "play") {
    if (seed.value !== null) warnings.push("当前 play 页只读 auto/body；seed 已写入 URL，供后续支持种子的版本消费。");
    if (body.value !== null && auto.value === null) warnings.push("body 只在 ?auto 流程中生效；单独打开 play 时是手动点选。");
    if (auto.value !== null && seed.value === null) warnings.push("未给 seed：play 页会随机生成星系，结果不可复现。");
  }
  if (seed.value === null && desc.kind === "starmap") warnings.push("未给 seed：星图使用页面默认种子。");

  const url = buildViewUrl(cfg.base, desc.kind, seed.value, body.value, auto.value);
  const params = new URL(url).search;
  return {
    ok: true,
    kind: desc.kind,
    title: desc.title,
    path: desc.path,
    url,
    params,
    warnings,
  };
}

export interface SandboxViews {
  readonly baseKey: string;
  readonly config: () => SandboxConfig;
  readonly guidance: () => SandboxGuidance;
  readonly describe: typeof describeView;
  readonly plan: (request: SandboxViewRequest) => SandboxViewPlan;
  readonly starmap: (options?: { seed?: unknown }) => SandboxViewPlan;
  readonly play: (options?: { seed?: unknown; body?: unknown; auto?: unknown }) => SandboxViewPlan;
}

/** Factory with ports; the wiring passes localStorage and `location.origin`. */
export function createSandboxViews(ports: SandboxViewsPorts): SandboxViews {
  function requestFor(kind: SandboxViewKind, options: unknown): SandboxViewRequest {
    const rec = recOf(options) ?? {};
    return { view: kind, seed: rec["seed"], body: rec["body"], auto: rec["auto"] };
  }
  return {
    baseKey: SANDBOX_BASE_KEY,
    config: () => sandboxConfig(ports),
    guidance: () => guidance(ports),
    describe: describeView,
    plan: (request) => planView(ports, request),
    starmap: (options) => planView(ports, requestFor("starmap", options)),
    play: (options) => planView(ports, requestFor("play", options)),
  };
}
