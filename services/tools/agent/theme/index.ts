/**
 * `set_theme` — the only tool that changes the global appearance.
 *
 * The theme facade owns applying a style/scheme patch; this module owns the two gates the tool
 * needs before it may call that facade: the style must be in the live whitelist (the facade may add
 * styles over time, so the default is only a fallback) and the scheme must be one of two literals.
 * An empty patch is rejected rather than turned into a no-op success.
 * @module services/tools/agent/theme
 */

export interface ThemeFacade {
  set(patch: Record<string, unknown>): void;
  get?(): unknown;
  styles?(): unknown;
}

export interface ThemeToolDeps {
  theme(): ThemeFacade | null;
}

export interface ThemeToolResult {
  ok: boolean;
  error?: string;
  applied?: Record<string, unknown>;
  current?: unknown;
}

export interface ThemeToolsApi {
  setTheme(args: unknown): Promise<ThemeToolResult>;
}

const DEFAULT_STYLES = ["minimal", "glass", "candle"];

function recOf(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) out[k] = v;
  }
  return out;
}

function errText(e: unknown): string {
  if (e !== null && typeof e === "object") {
    const own = Object.getOwnPropertyDescriptor(e, "message");
    if (own && typeof own.value === "string" && own.value) return own.value;
    const proto = Object.getPrototypeOf(e);
    if (proto) {
      const inherited = Object.getOwnPropertyDescriptor(proto, "message");
      if (inherited && typeof inherited.value === "string" && inherited.value) return inherited.value;
    }
  }
  return String(e);
}

/** Create the theme tool. */
export function createThemeTools(deps: ThemeToolDeps): ThemeToolsApi {
  async function setTheme(input: unknown): Promise<ThemeToolResult> {
    const facade = deps.theme();
    if (!facade || typeof facade.set !== "function") {
      return { ok: false, error: "主题模块未就绪 (theme.js / window.themeSvc)" };
    }
    const args = recOf(input);
    const patch: Record<string, unknown> = {};
    if (typeof args["style"] === "string") {
      const raw = typeof facade.styles === "function" ? facade.styles() : DEFAULT_STYLES;
      const allowed: string[] = Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string") : DEFAULT_STYLES;
      if (allowed.indexOf(args["style"]) < 0) {
        return { ok: false, error: "未知 style: " + args["style"] + ";可选 " + allowed.join("/") };
      }
      patch["style"] = args["style"];
    }
    if (typeof args["scheme"] === "string") {
      if (args["scheme"] !== "dark" && args["scheme"] !== "light") {
        return { ok: false, error: "scheme 只能是 dark/light" };
      }
      patch["scheme"] = args["scheme"];
    }
    if (!Object.keys(patch).length) return { ok: false, error: "至少要传 style 或 scheme" };
    try {
      facade.set(patch);
      const current = typeof facade.get === "function" ? facade.get() : patch;
      return { ok: true, applied: patch, current: current };
    } catch (e) {
      return { ok: false, error: "切换主题失败: " + errText(e) };
    }
  }

  return { setTheme };
}
