/**
 * Environment snapshot, load-order self-check, and the `<env>` block injected into the system prompt.
 *
 * Two layers, both zero-network:
 *   L1 `build()` — time, timezone, online state, shell, screen, language, version, installed tools.
 *   L0 `loadOrderCheck()` — are the four critical modules loaded, and is the monkey-patch chain intact?
 *
 * L0 exists because of the project's most frequent failure class: a duplicate `const` throwing
 * `SyntaxError`, a module loaded out of order, a file rolled back to an older build, or the `fetch` /
 * `Storage` chain breaking. A check that silently reports "1/6" is worse than none, so the `__dev`
 * probe tests the method that actually exists (`isDevMode`, not the old made-up `isOn`).
 *
 * `snapshotText` is deliberately **session-static**: the date only, never hours and minutes. A
 * per-turn timestamp would invalidate the prompt-prefix cache for the whole system block every round,
 * which is expensive on long documents. `build()` still returns the full time for the diagnostics tool.
 *
 * Every global is read through {@link EnvContextEnv} rather than touched directly, so the whole module
 * can be exercised without a browser.
 *
 * Lock: `test/env-context.test.mjs` (written with the migration).
 * @module services/agent/env-context
 */

export interface EnvSnapshot {
  local_time: string;
  tz: string;
  weekday: string;
  is_online: boolean;
  is_tauri: boolean;
  screen: string;
  lang: string;
  app_version: string;
  app_hash: string;
  site_origin: string;
  tools_count: number;
  tools: string[];
}

export interface LoadCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface LoadOrderResult {
  ok: boolean;
  total: number;
  failed: number;
  checks: LoadCheck[];
  summary: string;
}

export interface EnvContextEnv {
  /** Reads a global by name (`__dev`, `AgentKernel`, `__appVersion`, …). */
  read(key: string): unknown;
  /** `window.fetch` — inspected to see whether the auth chain wrapped it. */
  fetch(): unknown;
  /** `Storage.prototype.setItem` — inspected to see whether sync took it over. */
  storageSetItem(): unknown;
  navigator(): { onLine?: boolean; language?: string } | null;
  screen(): { width?: number; height?: number } | null;
  location(): { origin?: string } | null;
}

export interface EnvContextApi {
  build(opts?: unknown): EnvSnapshot;
  loadOrderCheck(): LoadOrderResult;
  snapshotText(opts?: unknown): string;
  defineTools(registry: unknown): unknown;
}

const ENV_WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function text(value: unknown): string {
  return value == null ? "" : typeof value === "string" ? value : String(value);
}

function recOf(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) out[k] = v;
  }
  return out;
}

/** True when the function is not the browser's native one — i.e. something wrapped it. */
function isPatched(fn: unknown): boolean {
  try {
    return typeof fn === "function" && String(fn).indexOf("[native code]") === -1;
  } catch (e) {
    return false;
  }
}

interface EnvRegistryLike {
  define(def: Record<string, unknown>): unknown;
}

function isRegistry(value: unknown): value is EnvRegistryLike {
  return typeof recOf(value).define === "function";
}

/** Calls a method held as `unknown` without an `as` cast. */
function callWith(fn: unknown, self: unknown, arg: unknown): Promise<unknown> {
  if (typeof fn !== "function") return Promise.reject(new Error("not a function"));
  return Promise.resolve(fn.call(self, arg));
}

export function createEnvContext(env: EnvContextEnv): EnvContextApi {
  function hasTauri(): boolean {
    const t = recOf(env.read("__TAURI__"));
    const core = recOf(t.core);
    return typeof core.invoke === "function";
  }

  function build(opts?: unknown): EnvSnapshot {
    const o = recOf(opts);
    const now = new Date();
    let tz = "";
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    } catch (e) {
      // A host without Intl falls back to the runtime's own zone.
    }
    const rawVer = env.read("__appVersion");
    const ver = rawVer && typeof rawVer === "object" ? recOf(rawVer) : null;
    const verStr = typeof rawVer === "string" ? rawVer : "";
    const registry = recOf(o.registry);
    let toolNames: string[] = [];
    try {
      if (typeof registry.list === "function") {
        const listed = registry.list();
        toolNames = (Array.isArray(listed) ? listed : []).map((t) => text(recOf(t).name));
      }
    } catch (e) {
      // A throwing registry still leaves an empty tool list.
    }
    const nav = env.navigator();
    const scr = env.screen();
    const loc = env.location();
    return {
      local_time: (function () {
        try {
          const dtf: Intl.DateTimeFormatOptions = {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
          };
          // Follow the machine's own zone; only pin it when Intl actually resolved one.
          if (tz) dtf.timeZone = tz;
          return new Intl.DateTimeFormat("sv-SE", dtf).format(now);
        } catch (e) {
          return now.toISOString();
        }
      })(),
      tz: tz,
      weekday: ENV_WEEKDAYS[now.getDay()],
      is_online: nav && "onLine" in nav ? !!nav.onLine : true,
      is_tauri: hasTauri(),
      screen: scr ? text(scr.width) + "×" + text(scr.height) : "",
      lang: (nav && text(nav.language)) || "",
      app_version: ver ? text(ver.version) : verStr || "unknown",
      app_hash: ver ? text(ver.hash) : "",
      site_origin: loc ? text(loc.origin) : "",
      tools_count: toolNames.length,
      tools: toolNames,
    };
  }

  /**
   * The six-item load-order self-check.
   * @returns per-check detail plus a one-line summary naming the failures — the summary is what gets
   * injected into the prompt, so it has to be readable on its own.
   */
  function loadOrderCheck(): LoadOrderResult {
    const checks: LoadCheck[] = [];
    function add(name: string, ok: unknown, detail?: string): void {
      checks.push({ name: name, ok: !!ok, detail: ok ? "" : detail || "" });
    }

    const dev = recOf(env.read("__dev"));
    add("dev.js (window.__dev)", typeof dev.isDevMode === "function", "window.__dev 缺失或无 isDevMode → dev.js 未加载或加载顺序错");
    const kernel = recOf(env.read("AgentKernel"));
    add("agent-kernel.js (window.AgentKernel)", typeof kernel.createToolRegistry === "function", "window.AgentKernel 缺失 → 内核未加载");
    const tools = recOf(env.read("OwnChatTools"));
    add("tools.js (window.OwnChatTools)", typeof tools.buildRegistry === "function", "window.OwnChatTools 缺失 → 工具集未加载");
    const reach = recOf(env.read("AgentReach"));
    add("agent-reach (window.AgentReach)", typeof reach.defineTools === "function", "window.AgentReach 缺失 → 联网能力未加载");

    add(
      "fetch 已被包裹 (auth.js 链)",
      isPatched(env.fetch()),
      "window.fetch 仍是原生 → auth.js 鉴权注入未生效，/sync 与 /api/* 可能 401"
    );
    add(
      "Storage.setItem 已接管 (sync.js)",
      isPatched(env.storageSetItem()),
      "localStorage.setItem 未被包裹 → sync.js 云同步 markDirty 失效，改动不会上传"
    );

    const failed = checks.filter((c) => !c.ok);
    return {
      ok: failed.length === 0,
      total: checks.length,
      failed: failed.length,
      checks: checks,
      summary:
        failed.length === 0
          ? "全部关键模块已加载，monkey-patch 链完整"
          : failed.length + "/" + checks.length + " 项异常：" + failed.map((c) => c.name).join("、"),
    };
  }

  /** The `<env>` block. Session-static on purpose: date only, no clock. */
  function snapshotText(opts?: unknown): string {
    const s = build(opts);
    const l0 = loadOrderCheck();
    return [
      "<env>",
      "日期：" + s.local_time.slice(0, 10) + "（周" + s.weekday + "，" + s.tz + "）",
      "运行端：" + (s.is_tauri ? "桌面端 Tauri" : "浏览器") + " | 网络：" + (s.is_online ? "在线" : "离线"),
      "版本：" + s.app_version + (s.app_hash ? "@" + s.app_hash : ""),
      "站点：" + (s.site_origin || "未知"),
      "可读源码：本站前端=同源相对路径（/js/… /shared/… /styles*.css，用 fetch_page 直读）；上游公开仓库=https://github.com/MaxChen12114/OwnChat（文件原文：https://raw.githubusercontent.com/MaxChen12114/OwnChat/main/<路径>）",
      "已装工具(" + s.tools_count + ")：" + (s.tools.join(", ") || "无"),
      "加载自检：" + l0.summary,
      "</env>",
    ].join("\n");
  }

  /** Registers `self_diagnostics`. Unlike the other tool groups this one **throws** on a bad registry. */
  function defineTools(registry: unknown): unknown {
    if (!isRegistry(registry)) {
      throw new Error("[env-context] 需要传入有效的 ToolRegistry（来自 agent-kernel.js）");
    }
    registry.define({
      name: "self_diagnostics",
      description:
        "运行环境快照 + 加载完整性自检 + 联网逐环节自检。环境/加载部分只读零网络（时间/时区/网络/版本/已装工具/各模块是否加载/monkey-patch 链是否完整）；联网部分委托 AgentReach.diagnose() 逐环节探测（同源代理 /api/fetch、桌面原生直连、浏览器跨域直连），定位联网在哪一步失败。" +
        "默认含联网探测；传 network:false 则只做零网络的环境+加载自检。" +
        "当用户问“你状态怎么样/现在几点/联网了吗/访问失败/为什么不工作/是不是又崩了”时调用。",
      parameters: {
        type: "object",
        properties: {
          network: { type: "boolean", description: "是否执行联网逐环节探测（默认 true）。false=仅零网络的环境+加载自检" },
          test_url: { type: "string", description: "联网探测用的目标 URL（默认多目标探针：百度/example.com/B 站）" },
        },
        additionalProperties: false,
      },
      async run(args: unknown, ctx: unknown) {
        const c = recOf(ctx);
        const reg2 = recOf(c.registry).list ? c.registry : registry;
        const result: Record<string, unknown> = { ok: true, env: build({ registry: reg2 }), load_check: loadOrderCheck() };
        const a = recOf(args);
        const doNet = !args || a.network !== false;
        if (doNet) {
          const reach = recOf(env.read("AgentReach"));
          if (typeof reach.diagnose === "function") {
            try {
              result.network = await callWith(reach.diagnose, reach, a.test_url);
            } catch (e) {
              const m = e && typeof e === "object" ? Reflect.get(e, "message") : undefined;
              result.network = "联网自检异常：" + (m ? String(m) : String(e));
            }
          } else {
            result.network = "未检测到 AgentReach.diagnose（联网能力层未加载或版本过旧），已跳过联网自检";
          }
        }
        return result;
      },
    });
    return registry;
  }

  return { build: build, loadOrderCheck: loadOrderCheck, snapshotText: snapshotText, defineTools: defineTools };
}
