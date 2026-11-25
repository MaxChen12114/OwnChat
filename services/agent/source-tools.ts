/**
 * The `*_source` / `*_artifact` tool group: five read-only queries against a local source server.
 *
 * Why it exists: the agent's built-in `read_file` / `search_file` only see the *session* workspace
 * (IndexedDB), so they cannot reach the repository, and `fetch_page` truncates at 8000 chars — reading
 * a large file takes many rounds. This service answers with `file:line` plus a line window in one call.
 *
 * Off by default on the public site, on by default on loopback: `cfw_source_tools_on_v1` wins when
 * set (`1`/`0`), otherwise the hostname decides. That is a deliberate default — the service only binds
 * 127.0.0.1 and only reads, but registering five tools the server cannot answer would just teach the
 * model to call broken tools.
 *
 * Addresses are storage-overridable (`cfw_source_url_v1`, `cfw_artifact_url_v1`) so moving the service
 * needs no code change, and the "service down" message names the exact command to start it.
 *
 * Lock: `test/source-tools.test.mjs` (written with the migration).
 * @module services/agent/source-tools
 */

export interface SourceResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export interface SourceEnv {
  storage: { getItem(key: string): string | null };
  /** Hostname of the page, used for the loopback default when the switch is unset. */
  hostname(): string;
  fetch(url: string, init?: unknown): Promise<SourceResponse>;
}

export interface SourceToolsApi {
  enabled(): boolean;
  base(): string;
  artBase(): string;
  normArtifactRef(ref: unknown): string;
  fmtLines(j: unknown): string;
  defineTools(registry: unknown): Promise<void>;
  _keys: { ON_KEY: string; URL_KEY: string; ART_KEY: string };
}

const SOURCE_ON_KEY = "cfw_source_tools_on_v1";
const SOURCE_URL_KEY = "cfw_source_url_v1";
const SOURCE_ART_KEY = "cfw_artifact_url_v1";
const SOURCE_TIMEOUT_MS = 30000;

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

function arrOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** `name`/`message` live on the prototype and are non-enumerable — read them directly. */
function errProp(e: unknown, key: "name" | "message"): unknown {
  return e && typeof e === "object" ? Reflect.get(e, key) : undefined;
}

function errText(e: unknown): string {
  const m = errProp(e, "message");
  return m ? String(m) : String(e);
}

interface SourceRegistryLike {
  define(def: Record<string, unknown>): unknown;
}

function isRegistry(value: unknown): value is SourceRegistryLike {
  return typeof recOf(value).define === "function";
}

export function createSourceTools(env: SourceEnv): SourceToolsApi {
  function ls(key: string): string {
    try {
      return text(env.storage.getItem(key)).trim();
    } catch (e) {
      return "";
    }
  }

  /** Explicit switch first, then "loopback means yes". Anything else is off. */
  function enabled(): boolean {
    const on = ls(SOURCE_ON_KEY);
    if (on === "1") return true;
    if (on === "0") return false;
    try {
      const h = env.hostname();
      return h === "127.0.0.1" || h === "localhost" || h === "[::1]";
    } catch (e) {
      return false;
    }
  }

  function base(): string {
    return ls(SOURCE_URL_KEY).replace(/\/+$/, "") || "http://127.0.0.1:8797";
  }

  function artBase(): string {
    return ls(SOURCE_ART_KEY).replace(/\/+$/, "") || "http://127.0.0.1:8796/artifacts";
  }

  function down(extra?: unknown): string {
    return (
      "源码服务不可达（" + base() + "）。\n" +
      "启动：node scripts/dev/source-server.mjs [--root <目录>] [--artifacts <产物目录>]\n" +
      '（地址可在 设置→高级→开发工具 或 localStorage["' + SOURCE_URL_KEY + '"] 修改）' +
      (extra ? "\n原始错误：" + text(extra) : "")
    );
  }

  async function api(path: string, params?: unknown, timeoutMs?: number): Promise<Record<string, unknown>> {
    const q: string[] = [];
    const p = recOf(params);
    Object.keys(p).forEach(function (k) {
      const v = p[k];
      if (v === undefined || v === null || v === "") return;
      q.push(encodeURIComponent(k) + "=" + encodeURIComponent(text(v)));
    });
    const u = base() + path + (q.length ? "?" + q.join("&") : "");
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctl
      ? setTimeout(function () {
          if (ctl) ctl.abort();
        }, timeoutMs || SOURCE_TIMEOUT_MS)
      : null;
    let r: SourceResponse;
    try {
      r = await env.fetch(u, ctl ? { signal: ctl.signal } : undefined);
    } catch (e) {
      if (errProp(e, "name") === "AbortError") throw new Error(down("请求超时"));
      throw new Error(down(errText(e)));
    } finally {
      if (timer) clearTimeout(timer);
    }
    let j: unknown = null;
    try {
      j = await r.json();
    } catch (e) {
      j = null;
    }
    if (!j) throw new Error("源码服务返回错误：HTTP " + r.status);
    return recOf(j);
  }

  /** Artifact refs may arrive as a full URL, with a leading slash, or already prefixed. */
  function normArtifactRef(ref: unknown): string {
    let s = text(ref).trim().replace(/\\/g, "/").replace(/^https?:\/\/[^/]+/, "").replace(/^\/+/, "");
    if (s.indexOf("artifacts/") === 0) s = s.slice("artifacts/".length);
    return s;
  }

  /** A line window: header, numbered lines, and a "continue from" hint when truncated. */
  function fmtLines(j: unknown): string {
    const r = recOf(j);
    const out = [text(r.path) + "（行 " + text(r.start) + "–" + text(r.end) + " / 共 " + text(r.totalLines) + " 行）"];
    arrOf(r.lines).forEach(function (l) {
      const line = recOf(l);
      out.push(text(line.n).padStart(5, " ") + " | " + text(line.text));
    });
    if (r.nextStart) out.push("（未读完，继续读：" + text(r.nextStart) + " 起）");
    return out.join("\n");
  }

  async function defineTools(registry: unknown): Promise<void> {
    if (!isRegistry(registry)) return;
    if (!enabled()) return; // Off (or public site by default): register nothing, zero footprint.

    registry.define({
      name: "list_source",
      description:
        "列出可检索的源码/文档文件清单（由本地 source-server 的 --root 决定范围；已排除 node_modules/.git/.venv 与密钥文件）。" +
        "不知道某段代码在哪个文件时先看它；可用 prefix 收窄目录。",
      parameters: {
        type: "object",
        properties: { prefix: { type: "string", description: "目录前缀（可选），如 public/js" } },
        additionalProperties: false,
      },
      run: async (args: unknown) => {
        try {
          const a = recOf(args);
          const j = await api("/list", { prefix: a.prefix || "" }, 20000);
          const files = arrOf(j.files);
          const cap = 100;
          const out = [
            "可检索文件：" +
              text(j.count) +
              " 个" +
              (a.prefix ? "（prefix=" + text(a.prefix) + "）" : "") +
              (j.truncated ? "（已截断）" : ""),
          ];
          out.push(files.slice(0, cap).map((f) => text(f)).join("\n"));
          if (files.length > cap) out.push("…（还有 " + (files.length - cap) + " 个未显示；用 prefix 收窄）");
          out.push("提示：读文件用 read_source(路径)，找内容用 search_source(关键词)。");
          return out.join("\n");
        } catch (e) {
          return errText(e);
        }
      },
    });

    registry.define({
      name: "search_source",
      description:
        "在可检索根内做字面/正则搜索，返回「文件:行号 + 行内容」。找某函数/字符串在哪、有几处就用它——比逐页 fetch 快且准。" +
        "默认不区分大小写、字面匹配；regex=true 走正则；命中多时用 pathPrefix 收窄。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "要找的字符串或（regex=true 时的）正则" },
          regex: { type: "boolean", description: "可选：true=按正则解释（默认字面匹配）" },
          pathPrefix: { type: "string", description: "可选：只在某目录下搜" },
          max: { type: "number", description: "可选：命中上限，默认 60，最大 200" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      run: async (args: unknown) => {
        try {
          const a = recOf(args);
          const j = await api(
            "/grep",
            { q: a.query || "", regex: a.regex ? "1" : "", prefix: a.pathPrefix || "", max: a.max || "" },
            30000
          );
          if (!j.ok) return "搜索失败：" + (text(j.error) || "未知错误");
          const hits = arrOf(j.hits);
          if (!hits.length) return "没有命中（可换关键词、放宽 pathPrefix，或确认服务 --root 覆盖了目标目录）。";
          const out = [
            "命中 " + text(j.hitCount) + " 处（扫描 " + text(j.scannedFiles) + " 个文件，" + text(j.seconds) + "s" + (j.truncated ? "，已截断" : "") + "）：",
          ];
          hits.forEach(function (h) {
            const hit = recOf(h);
            out.push(text(hit.path) + ":" + text(hit.line) + "  " + text(hit.text));
          });
          out.push("要读上下文：read_source(路径, start=命中行-10, lines=30)。");
          return out.join("\n");
        } catch (e) {
          return errText(e);
        }
      },
    });

    registry.define({
      name: "read_source",
      description: "按行读可检索根内的文件（带行号、字符预算，超出给 nextStart 续读）。先 search_source 定位再读窗口，别整文件读。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对根路径（正斜杠）" },
          start: { type: "number", description: "起始行，默认 1" },
          lines: { type: "number", description: "读取行数，默认 200，最大 400" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      run: async (args: unknown) => {
        try {
          const a = recOf(args);
          const j = await api("/raw", { path: a.path || "", start: a.start || "", lines: a.lines || "" }, 20000);
          if (!j.ok) return "读取失败：" + (text(j.error) || "未知错误");
          return fmtLines(j);
        } catch (e) {
          return errText(e);
        }
      },
    });

    registry.define({
      name: "list_artifacts",
      description: "列出产物目录（需 source-server 启动时配 --artifacts）里的文件，含大小/时间；用于找 agent 生成的图片、文档、数据。",
      parameters: { type: "object", properties: { prefix: { type: "string", description: "路径前缀（可选）" } }, additionalProperties: false },
      run: async (args: unknown) => {
        try {
          const a = recOf(args);
          const j = await api("/list_artifacts", { prefix: a.prefix || "" }, 20000);
          if (!j.ok) return "产物清单不可用：" + (text(j.error) || "未知错误");
          const files = arrOf(j.files);
          if (!files.length) return "产物目录为空（或 prefix 没命中）。";
          const out = ["产物：" + text(j.count) + " 个" + (j.truncated ? "（已截断）" : "")];
          files.slice(0, 80).forEach(function (f) {
            const file = recOf(f);
            out.push(text(file.path) + "  " + text(file.size) + "B");
          });
          if (files.length > 80) out.push("…（还有 " + (files.length - 80) + " 个；用 prefix 收窄）");
          out.push("读内容：read_artifact(路径)。");
          return out.join("\n");
        } catch (e) {
          return errText(e);
        }
      },
    });

    registry.define({
      name: "read_artifact",
      description: "读产物内容（TEXT 白名单、≤2MiB；二进制/超限会返回可打开的 URL）。路径可写 artifacts/x、x 或完整 URL。",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "产物路径或 URL" },
          start: { type: "number", description: "起始行，默认 1" },
          lines: { type: "number", description: "读取行数，默认 200" },
        },
        required: ["ref"],
        additionalProperties: false,
      },
      run: async (args: unknown) => {
        try {
          const a = recOf(args);
          const j = await api(
            "/read_artifact",
            { path: normArtifactRef(a.ref), start: a.start || "", lines: a.lines || "" },
            20000
          );
          if (j.ok) return fmtLines(j);
          if (j.binary && j.url) return "二进制/超限，用 URL 打开：" + text(j.url);
          return "读取失败：" + (text(j.error) || "未知错误") + (j.url ? "\nURL：" + text(j.url) : "");
        } catch (e) {
          return errText(e);
        }
      },
    });
  }

  return {
    enabled: enabled,
    base: base,
    artBase: artBase,
    normArtifactRef: normArtifactRef,
    fmtLines: fmtLines,
    defineTools: defineTools,
    _keys: { ON_KEY: SOURCE_ON_KEY, URL_KEY: SOURCE_URL_KEY, ART_KEY: SOURCE_ART_KEY },
  };
}
