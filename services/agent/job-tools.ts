/**
 * The job-board client: hand long, multi-step work to an external runner instead of blocking the chat.
 *
 * Why it exists: `local_run_command` runs synchronously, so a fifteen-minute job freezes the session.
 * Anything multi-step, minutes long, or needing a sandbox is submitted here instead — `submit` returns a
 * job id immediately, the runner works in the background, and finished artifacts are pushed into the
 * right-hand canvas.
 *
 * Auth is `HMAC-SHA256(secret, "device:" + deviceId)`, byte-identical to the Worker and the bridge.
 * Config lives in `localStorage["cfw_jobs_v1"]` and never syncs: it holds the shared secret.
 *
 * Unconfigured is a first-class state. The tools still register, and calling one returns the exact
 * `localStorage.setItem` line to paste — far more useful to a model than "tool does not exist", which
 * it would interpret as "wrong arguments" and retry.
 *
 * Polling is state-transition based: a notification fires when `state` **changes**, not on every tick,
 * and the interval stops itself on `done` / `failed` / `canceled` or after ~10 minutes.
 *
 * Lock: `test/job-tools.test.mjs` (written with the migration).
 * @module services/agent/job-tools
 */

export interface JobConfig {
  serverUrl: string;
  deviceId: string;
  secret: string;
  artifactsBase: string;
}

export interface JobResponse {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
}

export interface JobPanelLike {
  open(spec: Record<string, unknown>): unknown;
}

export interface JobEnv {
  storage: { getItem(key: string): string | null };
  fetch(url: string, init?: unknown): Promise<JobResponse>;
  /** Toast host; a missing one means notifications are silently dropped. */
  toast(message: string, ms?: number): void;
  /** Fires a `cfw:job` event for the status panel. */
  notify(detail: Record<string, unknown>): void;
  panel(): JobPanelLike | null;
}

export interface JobToolsApi {
  readConfig(): JobConfig;
  configured(): boolean;
  resolveArtifactsUrl(u: unknown): string;
  galleryHtml(title: unknown, imgs: unknown): string;
  consumeView(jobId: unknown, j: unknown): boolean;
  pollJob(jobId: unknown, cfg?: JobConfig): void;
  submit(brief: unknown): Promise<{ ok: boolean; error?: string; jobId?: string; state?: unknown }>;
  test(): Promise<{ ok: boolean; note?: string; error?: string }>;
  defineTools(registry: unknown): Promise<void>;
  _keys: { LS_KEY: string; POLL_MS: number; POLL_MAX_ROUNDS: number };
}

const JOB_LS_KEY = "cfw_jobs_v1";
const JOB_POLL_MS = 2500;
const JOB_POLL_MAX_ROUNDS = 240; // ~10 minutes

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

function errText(e: unknown): string {
  const m = e && typeof e === "object" ? Reflect.get(e, "message") : undefined;
  return m ? String(m) : String(e);
}

interface JobRegistryLike {
  define(def: Record<string, unknown>): unknown;
}

function isRegistry(value: unknown): value is JobRegistryLike {
  return typeof recOf(value).define === "function";
}

export function createJobTools(env: JobEnv): JobToolsApi {
  function readConfig(): JobConfig {
    try {
      const o = recOf(JSON.parse(text(env.storage.getItem(JOB_LS_KEY)) || "{}"));
      return {
        serverUrl: text(o.serverUrl).replace(/\/+$/, ""),
        deviceId: text(o.deviceId) || "chat",
        secret: text(o.secret),
        artifactsBase: text(o.artifactsBase).replace(/\/+$/, ""),
      };
    } catch (e) {
      return { serverUrl: "", deviceId: "chat", secret: "", artifactsBase: "" };
    }
  }

  function configured(): boolean {
    const c = readConfig();
    return !!(c.serverUrl && c.secret);
  }

  function hex(buf: ArrayBuffer): string {
    return Array.prototype.map
      .call(new Uint8Array(buf), function (b: number) {
        return ("0" + b.toString(16)).slice(-2);
      })
      .join("");
  }

  /** `HMAC-SHA256(secret, "device:" + deviceId)` — the three ends must agree byte for byte. */
  async function deviceToken(secret: string, deviceId: string): Promise<string> {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode("device:" + deviceId));
    return hex(sig);
  }

  async function headers(cfg: JobConfig): Promise<Record<string, string>> {
    const tok = await deviceToken(cfg.secret, cfg.deviceId);
    return { "content-type": "application/json", "x-device-id": cfg.deviceId, authorization: "Bearer " + tok };
  }

  /** One request. A non-JSON body is `data: null` — the status code is what counts then. */
  async function call(method: string, path: string, body: unknown, cfg: JobConfig): Promise<{ status: number; ok: boolean; data: Record<string, unknown> | null }> {
    const r = await env.fetch(cfg.serverUrl + path, {
      method: method,
      headers: await headers(cfg),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let d: unknown = null;
    try {
      d = await r.json();
    } catch (e) {
      d = null;
    }
    return { status: r.status, ok: r.ok, data: d ? recOf(d) : null };
  }

  function toast(msg: string, ms?: number): void {
    try {
      env.toast(msg, ms || 3200);
    } catch (e) {
      // Notifications are decorative.
    }
  }

  function notify(ev: Record<string, unknown>): void {
    try {
      env.notify(ev);
    } catch (e) {
      // Same.
    }
  }

  /**
   * Turns a manifest artifact reference into something the canvas can open.
   * `workbench://x` resolves against the configured artifacts base; a site-relative `/x` is already
   * usable; an absolute http(s) URL passes through; anything else is unusable.
   */
  function resolveArtifactsUrl(u: unknown): string {
    const s = text(u).trim();
    if (!s) return "";
    if (s.indexOf("workbench://") === 0) {
      const base = readConfig().artifactsBase;
      if (!base) return "";
      const p = s.slice("workbench://".length).replace(/\\/g, "/").replace(/^\/+/, "");
      return base + "/" + p;
    }
    if (s.charAt(0) === "/") return s;
    return /^https?:\/\//.test(s) ? s : "";
  }

  function esc(s: unknown): string {
    return text(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /** A gallery page for jobs that produced images but no viewable URL. */
  function galleryHtml(title: unknown, imgs: unknown): string {
    const body = arrOf(imgs)
      .map(function (raw) {
        const f = recOf(raw);
        return (
          '<figure style="margin:0 0 18px"><img src="' +
          esc(f.url) +
          '" alt="" ' +
          'style="display:block;width:100%;border-radius:9px;border:1px solid #243040">' +
          (f.caption ? '<figcaption style="margin-top:6px;color:#8595a6;font-size:11px">' + esc(f.caption) + "</figcaption>" : "") +
          "</figure>"
        );
      })
      .join("");
    return (
      '<div style="margin:0;padding:16px;font:12px/1.7 system-ui,\'Microsoft YaHei\',sans-serif;color:#dfe7ef;background:#0e0e11">' +
      '<div style="font-size:13px;font-weight:600;margin-bottom:12px;color:#eaf2fa">' +
      esc(title) +
      "</div>" +
      body +
      "</div>"
    );
  }

  const viewOpened: Record<string, unknown> = {};

  /**
   * Opens a job's `manifest.view` artifact in the canvas — once per job.
   * @returns true when something was opened. A view with neither a URL nor usable images is skipped
   * rather than opening an empty page.
   */
  function consumeView(jobId: unknown, j: unknown): boolean {
    const id = text(jobId);
    const panel = env.panel();
    if (!id || viewOpened[id] || !j || !panel) return false;
    const job = recOf(j);
    const ms = arrOf(job.manifests);
    for (let i = 0; i < ms.length; i++) {
      const m = recOf(ms[i]);
      if (!m || m.manifestType !== "manifest.view" || !m.inline) continue;
      let v: Record<string, unknown> = {};
      try {
        v = recOf(JSON.parse(text(m.inline)));
      } catch (e) {
        continue;
      }
      const url = resolveArtifactsUrl(v.url);
      const imgs = arrOf(v.files)
        .map(function (f) {
          const raw = typeof f === "string" ? f : text(recOf(f).url);
          return { url: resolveArtifactsUrl(raw), caption: text(recOf(f).caption) };
        })
        .filter(function (f) {
          return !!f.url;
        });
      if (!url && !imgs.length) continue;
      viewOpened[id] = 1;
      const title = text(v.title) || text(recOf(job.brief).title) || "作业产物";
      try {
        if (url) panel.open({ url: url, title: title, mode: "external" });
        else panel.open({ html: galleryHtml(title, imgs), title: title });
      } catch (e) {
        // A failing panel must not stop the notification below.
      }
      toast("作业产物已接入画布：" + title, 3800);
      notify({ type: "view", jobId: id, title: title });
      return true;
    }
    return false;
  }

  const pollers: Record<string, ReturnType<typeof setInterval>> = {};

  /** Polls until a terminal state or the round budget runs out; notifies only on state changes. */
  function pollJob(jobId: unknown, cfg0?: JobConfig): void {
    const id = text(jobId);
    const cfg = cfg0 || readConfig();
    if (!id || pollers[id]) return;
    let last: unknown = null;
    let rounds = 0;
    pollers[id] = setInterval(async function () {
      rounds++;
      if (rounds > JOB_POLL_MAX_ROUNDS) {
        clearInterval(pollers[id]);
        delete pollers[id];
        notify({ type: "timeout", jobId: id });
        return;
      }
      let r;
      try {
        r = await call("GET", "/jobs/" + id, undefined, cfg);
      } catch (e) {
        return;
      }
      if (!r.ok || !r.data || !r.data.jobId) return;
      const j = r.data;
      consumeView(id, j);
      if (j.state !== last) {
        last = j.state;
        notify({ type: "state", jobId: id, state: j.state, title: text(recOf(j.brief).title), note: text(j.note) });
        if (j.state === "done" || j.state === "failed" || j.state === "canceled") {
          clearInterval(pollers[id]);
          delete pollers[id];
          if (j.state === "done") toast("作业完成：" + (text(recOf(j.brief).title) || id), 3600);
          if (j.state === "failed") toast("作业失败：" + (text(j.note) || id).slice(0, 60), 4200);
        }
      }
    }, JOB_POLL_MS);
  }

  /**
   * Submits a brief.
   * @returns the job id on success. `acceptance` defaults to one line when omitted, and `dataRefs`
   * to an empty list, so the runner always receives a complete brief.
   */
  async function submit(brief: unknown): Promise<{ ok: boolean; error?: string; jobId?: string; state?: unknown }> {
    const cfg = readConfig();
    if (!configured()) return { ok: false, error: "作业台未配置（需要 serverUrl 与 secret）" };
    const b = recOf(brief);
    if (!brief || !b.kind || !b.title || !b.goal) return { ok: false, error: "brief 需要 kind / title / goal" };
    const out = recOf(brief);
    if (!Array.isArray(out.acceptance) || !out.acceptance.length) out.acceptance = ["按 goal 完成并回传 observation"];
    if (!Array.isArray(out.dataRefs)) out.dataRefs = [];
    let r;
    try {
      r = await call("POST", "/jobs", out, cfg);
    } catch (e) {
      return { ok: false, error: "连不上作业台: " + errText(e) };
    }
    if (!r.ok) return { ok: false, error: "作业台拒绝 (" + r.status + "): " + text(recOf(r.data).error) };
    const d = r.data || {};
    pollJob(d.jobId, cfg);
    return { ok: true, jobId: text(d.jobId), state: d.state };
  }

  /** Probes the board with a guaranteed-missing job id: 404 means the token was accepted. */
  async function test(): Promise<{ ok: boolean; note?: string; error?: string }> {
    const cfg = readConfig();
    if (!configured()) return { ok: false, error: "未配置（先填 serverUrl 与 secret）" };
    try {
      const r = await call("GET", "/jobs/j_probe_nonexistent", undefined, cfg);
      if (r.status === 404) return { ok: true, note: "连通且鉴权通过" };
      if (r.status === 401) return { ok: false, error: "鉴权失败：secret 与作业台不符" };
      return { ok: false, error: "意外响应 " + r.status };
    } catch (e) {
      return { ok: false, error: "连不上: " + errText(e) };
    }
  }

  async function defineTools(registry: unknown): Promise<void> {
    if (!isRegistry(registry)) return;

    registry.define({
      name: "submit_job",
      description:
        "把「多步、分钟级、需要沙箱执行」的活派给外部作业台异步跑，后台执行完把产物送进右栏画布。\n" +
        "什么时候用：批量改文件、跑长分析脚本、生成多张图、需要工具链的多阶段任务。\n" +
        "什么时候**不用**：单步秒级操作（用 local_run_command）；纯问答（直接答）。\n" +
        "派完立刻返回 jobId，会话不阻塞；状态迁移会自己通知，产物到了会自动挂到画布上。\n" +
        "未配置作业台时调用会返回配置指引。",
      parameters: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            description:
              "任务类型，格式必须是「域名.动作」（小写字母开头，如 data.repro、geo.parse、meta.shell）。" +
              "域名只能是 data / geo / sim / kb / meta 之一。**它不是执行器名**——别写 shell / probe / agent，那几个会直接报错。",
          },
          title: { type: "string", description: "一句话标题（用户会在产物标题里看到）" },
          goal: { type: "string", description: "要达成什么（写给执行者看的完整说明）" },
          acceptance: { type: "array", items: { type: "string" }, description: "验收标准（可选）" },
          dataRefs: { type: "array", items: { type: "string" }, description: "需要的数据引用（可选，路径或 URL）" },
          params: {
            type: "object",
            description: "透传给执行器的参数。shell 执行器必须给 params.command（要跑的命令，PowerShell 语法）；probe 可省。",
            additionalProperties: true,
          },
          approved: { type: "boolean", description: "危险动作闸门：shell 执行器必须为 true 才放行；改文件/删文件时更要显式确认。" },
        },
        required: ["kind", "title", "goal"],
        additionalProperties: true,
      },
      run: async (args: unknown) => {
        const a = recOf(args);
        if (!configured()) {
          const cfg = readConfig();
          return (
            "作业台未配置。" +
            (cfg.serverUrl ? "缺 secret。" : "需要先填 serverUrl 与 secret。") +
            "\n在控制台执行一次（本机私密，不进云同步）：\n" +
            "localStorage.setItem('cfw_jobs_v1', JSON.stringify({serverUrl:'http://127.0.0.1:8797', deviceId:'chat', secret:'<你的作业台 secret>', artifactsBase:'http://127.0.0.1:8796'}))"
          );
        }
        const r = await submit({
          kind: text(a.kind),
          title: text(a.title),
          goal: text(a.goal),
          acceptance: Array.isArray(a.acceptance) ? a.acceptance : undefined,
          dataRefs: Array.isArray(a.dataRefs) ? a.dataRefs : undefined,
          params: a.params && typeof a.params === "object" ? a.params : undefined,
          approved: a.approved === true,
        });
        if (!r.ok) return "派活失败：" + r.error;
        return "已派活：" + r.jobId + "（状态 " + text(r.state || "queued") + "）。后台执行中，产物到了会自动挂到右栏画布。";
      },
    });

    registry.define({
      name: "job_status",
      description: "查一个作业的当前状态与产物清单（jobId 来自 submit_job）。",
      parameters: {
        type: "object",
        properties: { jobId: { type: "string", description: "作业 id" } },
        required: ["jobId"],
        additionalProperties: false,
      },
      run: async (args: unknown) => {
        const cfg = readConfig();
        if (!configured()) return "作业台未配置。";
        const jobId = text(recOf(args).jobId);
        if (!jobId) return "需要 jobId。";
        try {
          const r = await call("GET", "/jobs/" + jobId, undefined, cfg);
          if (!r.ok) return "查询失败：" + r.status + " " + text(recOf(r.data).error);
          const j = r.data || {};
          const out = ["作业 " + jobId + "：状态 " + text(j.state || "?"), "标题：" + (text(recOf(j.brief).title) || "?")];
          if (j.note) out.push("备注：" + text(j.note));
          const ms = arrOf(j.manifests);
          if (ms.length) {
            out.push("产物清单（" + ms.length + " 条）：");
            ms.forEach(function (raw) {
              const m = recOf(raw);
              out.push("· " + text(m.manifestType || "?") + (m.inline ? "（" + text(m.inline).slice(0, 160) + "）" : ""));
            });
          }
          return out.join("\n");
        } catch (e) {
          return "查询出错：" + errText(e);
        }
      },
    });

    registry.define({
      name: "job_open_artifacts",
      description: "把某个作业的产物重新挂到右栏画布（之前关掉了、想再看一次时用）。",
      parameters: {
        type: "object",
        properties: { jobId: { type: "string", description: "作业 id" } },
        required: ["jobId"],
        additionalProperties: false,
      },
      run: async (args: unknown) => {
        const cfg = readConfig();
        if (!configured()) return "作业台未配置。";
        const jobId = text(recOf(args).jobId);
        try {
          const r = await call("GET", "/jobs/" + jobId, undefined, cfg);
          if (!r.ok) return "查询失败：" + r.status;
          viewOpened[jobId] = 0; // Re-openable on request.
          const ok = consumeView(jobId, r.data);
          return ok ? "已把产物挂回画布。" : "这个作业还没有可展示的产物（manifest.view 为空）。";
        } catch (e) {
          return "出错：" + errText(e);
        }
      },
    });
  }

  return {
    readConfig: readConfig,
    configured: configured,
    resolveArtifactsUrl: resolveArtifactsUrl,
    galleryHtml: galleryHtml,
    consumeView: consumeView,
    pollJob: pollJob,
    submit: submit,
    test: test,
    defineTools: defineTools,
    _keys: { LS_KEY: JOB_LS_KEY, POLL_MS: JOB_POLL_MS, POLL_MAX_ROUNDS: JOB_POLL_MAX_ROUNDS },
  };
}
