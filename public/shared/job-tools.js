// public/shared/job-tools.js — 作业台客户端（主站 → 外部作业服务的派活通道）
// ─────────────────────────────────────────────────────────────────────
// 从 geo 侧 geojobs.js（163 行）移植，契约不变，落点改造：
//   · 产物不再进「artifacts viewer」，改为 __panel.open()（有 url 开页面，只有图就生成一个画廊页）
//   · 状态迁移推进右栏画布 / toast，不再有 stage 时间线
//
// 为什么需要它：
//   本地同步执行（local_run_command）跑十几分钟会把会话卡死。多步、分钟级、要沙箱的活
//   应该派给作业台异步跑：submit → 后台执行 → 回传 manifest → 产物进画布。
//
// 配置（本机私密，不进云同步）：
//   localStorage["cfw_jobs_v1"] = { serverUrl, deviceId, secret, artifactsBase }
//   未配置时工具照样注册——但调用会返回明确的配置指引（比"工具不存在"对 agent 更有用）。
//
// 鉴权：token = HMAC-SHA256(secret, "device:" + deviceId)，与 Worker / 桥三端逐字节一致。
// ─────────────────────────────────────────────────────────────────────
(function (global) {
  "use strict";

  var LS_KEY = "cfw_jobs_v1";
  var POLL_MS = 2500;
  var POLL_MAX_ROUNDS = 240; // 约 10 分钟

  function readConfig() {
    try {
      var o = JSON.parse(localStorage.getItem(LS_KEY) || "{}") || {};
      return {
        serverUrl: String(o.serverUrl || "").replace(/\/+$/, ""),
        deviceId: String(o.deviceId || "chat"),
        secret: String(o.secret || ""),
        artifactsBase: String(o.artifactsBase || "").replace(/\/+$/, "")
      };
    } catch (e) {
      return { serverUrl: "", deviceId: "chat", secret: "", artifactsBase: "" };
    }
  }

  function configured() {
    var c = readConfig();
    return !!(c.serverUrl && c.secret);
  }

  function hex(buf) {
    return [].map.call(new Uint8Array(buf), function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }

  async function deviceToken(secret, deviceId) {
    var enc = new TextEncoder();
    var key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    var sig = await crypto.subtle.sign("HMAC", key, enc.encode("device:" + deviceId));
    return hex(sig);
  }

  async function headers_(cfg) {
    var tok = await deviceToken(cfg.secret, cfg.deviceId);
    return { "content-type": "application/json", "x-device-id": cfg.deviceId, authorization: "Bearer " + tok };
  }

  async function call_(method, path, body, cfg) {
    var r = await fetch(cfg.serverUrl + path, {
      method: method,
      headers: await headers_(cfg),
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    var d = null;
    try { d = await r.json(); } catch (e) { /* 非 JSON 按 null 走，错误以 status 为准 */ }
    return { status: r.status, ok: r.ok, data: d };
  }

  function toast_(msg, ms) {
    try { global.__feedback && global.__feedback.toast && global.__feedback.toast(msg, { ms: ms || 3200 }); } catch (e) {}
  }

  function notify_(ev) {
    try { global.dispatchEvent(new CustomEvent("cfw:job", { detail: ev })); } catch (e) {}
  }

  // ---------- 产物 → 右栏画布 ----------
  function resolveArtifactsUrl(u) {
    var s = String(u || "").trim();
    if (!s) return "";
    if (s.indexOf("workbench://") === 0) {
      var base = readConfig().artifactsBase;
      if (!base) return "";
      var p = s.slice("workbench://".length).replace(/\\/g, "/").replace(/^\/+/, "");
      return base + "/" + p;
    }
    // 站内相对路径（如 /tools/sandbox/index.html）：直接可用，不必拼产物基址
    if (s.charAt(0) === "/") return s;
    return /^https?:\/\//.test(s) ? s : "";
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function galleryHtml(title, imgs) {
    var body = imgs.map(function (f) {
      return '<figure style="margin:0 0 18px"><img src="' + esc(f.url) + '" alt="" ' +
        'style="display:block;width:100%;border-radius:9px;border:1px solid #243040">' +
        (f.caption ? '<figcaption style="margin-top:6px;color:#8595a6;font-size:11px">' + esc(f.caption) + "</figcaption>" : "") +
        "</figure>";
    }).join("");
    return '<div style="margin:0;padding:16px;font:12px/1.7 system-ui,\'Microsoft YaHei\',sans-serif;color:#dfe7ef;background:#0e0e11">' +
      '<div style="font-size:13px;font-weight:600;margin-bottom:12px;color:#eaf2fa">' + esc(title) + "</div>" +
      body + "</div>";
  }

  var _viewOpened = {};

  function consumeView(jobId, j) {
    if (!jobId || _viewOpened[jobId] || !j || !global.__panel) return false;
    var ms = Array.isArray(j.manifests) ? j.manifests : [];
    for (var i = 0; i < ms.length; i++) {
      var m = ms[i];
      if (!m || m.manifestType !== "manifest.view" || !m.inline) continue;
      var v = null;
      try { v = JSON.parse(m.inline); } catch (e) { continue; }
      var url = resolveArtifactsUrl(v && v.url);
      var imgs = ((v && v.files) || []).map(function (f) {
        return { url: resolveArtifactsUrl(typeof f === "string" ? f : (f && f.url) || ""), caption: (f && f.caption) || "" };
      }).filter(function (f) { return !!f.url; });
      if (!url && !imgs.length) continue;
      _viewOpened[jobId] = 1;
      var title = (v && v.title) || (j.brief && j.brief.title) || "作业产物";
      try {
        if (url) global.__panel.open({ url: url, title: title, mode: "external" });
        else global.__panel.open({ html: galleryHtml(title, imgs), title: title });
      } catch (e) {}
      toast_("作业产物已接入画布：" + title, 3800);
      notify_({ type: "view", jobId: jobId, title: title });
      return true;
    }
    return false;
  }

  // ---------- 轮询：只在状态迁移时通知；终态自动停 ----------
  var _pollers = {};

  function pollJob(jobId, cfg0) {
    var cfg = cfg0 || readConfig();
    if (!jobId || _pollers[jobId]) return;
    var last = null, rounds = 0;
    _pollers[jobId] = setInterval(async function () {
      rounds++;
      if (rounds > POLL_MAX_ROUNDS) {
        clearInterval(_pollers[jobId]); delete _pollers[jobId];
        notify_({ type: "timeout", jobId: jobId });
        return;
      }
      var r;
      try { r = await call_("GET", "/jobs/" + jobId, undefined, cfg); } catch (e) { return; }
      if (!r.ok || !r.data || !r.data.jobId) return;
      var j = r.data;
      consumeView(jobId, j);
      if (j.state !== last) {
        last = j.state;
        notify_({ type: "state", jobId: jobId, state: j.state, title: (j.brief && j.brief.title) || "", note: j.note || "" });
        if (j.state === "done" || j.state === "failed" || j.state === "canceled") {
          clearInterval(_pollers[jobId]); delete _pollers[jobId];
          if (j.state === "done") toast_("作业完成：" + ((j.brief && j.brief.title) || jobId), 3600);
          if (j.state === "failed") toast_("作业失败：" + ((j.note || jobId) + "").slice(0, 60), 4200);
        }
      }
    }, POLL_MS);
  }

  // ---------- 派活 ----------
  async function submit(brief) {
    var cfg = readConfig();
    if (!configured()) return { ok: false, error: "作业台未配置（需要 serverUrl 与 secret）" };
    if (!brief || !brief.kind || !brief.title || !brief.goal) return { ok: false, error: "brief 需要 kind / title / goal" };
    if (!Array.isArray(brief.acceptance) || !brief.acceptance.length) brief.acceptance = ["按 goal 完成并回传 observation"];
    if (!Array.isArray(brief.dataRefs)) brief.dataRefs = [];
    var r;
    try { r = await call_("POST", "/jobs", brief, cfg); }
    catch (e) { return { ok: false, error: "连不上作业台: " + ((e && e.message) || e) }; }
    if (!r.ok) return { ok: false, error: "作业台拒绝 (" + r.status + "): " + ((r.data && r.data.error) || "") };
    var d = r.data || {};
    pollJob(d.jobId, cfg);
    return { ok: true, jobId: d.jobId, state: d.state };
  }

  async function test() {
    var cfg = readConfig();
    if (!configured()) return { ok: false, error: "未配置（先填 serverUrl 与 secret）" };
    try {
      var r = await call_("GET", "/jobs/j_probe_nonexistent", undefined, cfg);
      if (r.status === 404) return { ok: true, note: "连通且鉴权通过" };
      if (r.status === 401) return { ok: false, error: "鉴权失败：secret 与作业台不符" };
      return { ok: false, error: "意外响应 " + r.status };
    } catch (e) { return { ok: false, error: "连不上: " + ((e && e.message) || e) }; }
  }

  // ---------- agent 工具 ----------
  async function defineTools(registry) {
    if (!registry || typeof registry.define !== "function") return;

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
              "域名只能是 data / geo / sim / kb / meta 之一。**它不是执行器名**——别写 shell / probe / agent，那几个会直接报错。"
          },
          title: { type: "string", description: "一句话标题（用户会在产物标题里看到）" },
          goal: { type: "string", description: "要达成什么（写给执行者看的完整说明）" },
          acceptance: { type: "array", items: { type: "string" }, description: "验收标准（可选）" },
          dataRefs: { type: "array", items: { type: "string" }, description: "需要的数据引用（可选，路径或 URL）" },
          params: {
            type: "object",
            description: "透传给执行器的参数。shell 执行器必须给 params.command（要跑的命令，PowerShell 语法）；probe 可省。",
            additionalProperties: true
          },
          approved: { type: "boolean", description: "危险动作闸门：shell 执行器必须为 true 才放行；改文件/删文件时更要显式确认。" },
        },
        required: ["kind", "title", "goal"],
        additionalProperties: true,
      },
      run: async (args) => {
        if (!configured()) {
          var cfg = readConfig();
          return "作业台未配置。" + (cfg.serverUrl ? "缺 secret。" : "需要先填 serverUrl 与 secret。") +
            "\n在控制台执行一次（本机私密，不进云同步）：\n" +
            "localStorage.setItem('cfw_jobs_v1', JSON.stringify({serverUrl:'http://127.0.0.1:8797', deviceId:'chat', secret:'<你的作业台 secret>', artifactsBase:'http://127.0.0.1:8796'}))";
        }
        var r = await submit({
          kind: String(args.kind || ""),
          title: String(args.title || ""),
          goal: String(args.goal || ""),
          acceptance: Array.isArray(args.acceptance) ? args.acceptance : undefined,
          dataRefs: Array.isArray(args.dataRefs) ? args.dataRefs : undefined,
          params: (args.params && typeof args.params === "object") ? args.params : undefined,
          approved: args.approved === true,
        });
        if (!r.ok) return "派活失败：" + r.error;
        return "已派活：" + r.jobId + "（状态 " + (r.state || "queued") + "）。后台执行中，产物到了会自动挂到右栏画布。";
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
      run: async (args) => {
        var cfg = readConfig();
        if (!configured()) return "作业台未配置。";
        var jobId = String((args && args.jobId) || "");
        if (!jobId) return "需要 jobId。";
        try {
          var r = await call_("GET", "/jobs/" + jobId, undefined, cfg);
          if (!r.ok) return "查询失败：" + r.status + " " + ((r.data && r.data.error) || "");
          var j = r.data || {};
          var out = ["作业 " + jobId + "：状态 " + (j.state || "?"), "标题：" + ((j.brief && j.brief.title) || "?")];
          if (j.note) out.push("备注：" + j.note);
          var ms = Array.isArray(j.manifests) ? j.manifests : [];
          if (ms.length) {
            out.push("产物清单（" + ms.length + " 条）：");
            ms.forEach(function (m) {
              out.push("· " + (m.manifestType || "?") + (m.inline ? "（" + String(m.inline).slice(0, 160) + "）" : ""));
            });
          }
          return out.join("\n");
        } catch (e) {
          return "查询出错：" + ((e && e.message) || e);
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
      run: async (args) => {
        var cfg = readConfig();
        if (!configured()) return "作业台未配置。";
        var jobId = String((args && args.jobId) || "");
        try {
          var r = await call_("GET", "/jobs/" + jobId, undefined, cfg);
          if (!r.ok) return "查询失败：" + r.status;
          _viewOpened[jobId] = 0; // 允许重开
          var ok = consumeView(jobId, r.data);
          return ok ? "已把产物挂回画布。" : "这个作业还没有可展示的产物（manifest.view 为空）。";
        } catch (e) {
          return "出错：" + ((e && e.message) || e);
        }
      },
    });
  }

  global.__jobTools = {
    defineTools: defineTools,
    readConfig: readConfig,
    configured: configured,
    submit: submit,
    test: test,
    pollJob: pollJob,
    _consumeView: consumeView,
    _resolveArtifactsUrl: resolveArtifactsUrl,
    __v: 1,
  };
})(typeof window !== "undefined" ? window : globalThis);
