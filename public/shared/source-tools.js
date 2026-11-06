// public/shared/source-tools.js — agent「源码/产物检索」工具组（可选开发工具）
// ─────────────────────────────────────────────────────────────────────
// 后端：scripts/dev/source-server.mjs（本地只读、只绑 127.0.0.1）。
//   五件套：list_source / search_source / read_source / list_artifacts / read_artifact
// 为什么：agent 原生的 read_file/search_file 只读"会话工作区"（IndexedDB），读不到仓库；
//   fetch_page 有 8000 字截断，读大文件要很多轮。这里由本地服务一次给出 文件:行号 + 行窗口。
// 开关：cfw_source_tools_on_v1（'1'/'0'；未设时 127.0.0.1/localhost 默认开，线上默认关）。
// 地址：cfw_source_url_v1（默认 http://127.0.0.1:8797）
//       产物 URL：cfw_artifact_url_v1（默认 http://127.0.0.1:8796/artifacts）
// 安全：服务只绑回环、只读；.env/.dev.vars/*.nvapi/*.pem/*.key、node_modules/.git 等由服务端 deny。
// ─────────────────────────────────────────────────────────────────────
(function () {
  "use strict";
  if (window.__sourceTools) return;

  var ON_KEY = "cfw_source_tools_on_v1";
  var URL_KEY = "cfw_source_url_v1";
  var ART_KEY = "cfw_artifact_url_v1";
  var LS_TIMEOUT = 30000;

  function ls(k) { try { return String(localStorage.getItem(k) || "").trim(); } catch (e) { return ""; } }
  function enabled() {
    var on = ls(ON_KEY);
    if (on === "1") return true;
    if (on === "0") return false;
    try {
      var h = location.hostname;
      return h === "127.0.0.1" || h === "localhost" || h === "[::1]";
    } catch (e) { return false; }
  }
  function base() { return ls(URL_KEY).replace(/\/+$/, "") || "http://127.0.0.1:8797"; }
  function artBase() { return ls(ART_KEY).replace(/\/+$/, "") || "http://127.0.0.1:8796/artifacts"; }

  function down(extra) {
    return "源码服务不可达（" + base() + "）。\n"
      + "启动：node scripts/dev/source-server.mjs [--root <目录>] [--artifacts <产物目录>]\n"
      + "（地址可在 设置→高级→开发工具 或 localStorage[\"" + URL_KEY + "\"] 修改）"
      + (extra ? "\n原始错误：" + extra : "");
  }

  async function api(path, params, timeoutMs) {
    var q = [];
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v === undefined || v === null || v === "") return;
      q.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
    });
    var u = base() + path + (q.length ? "?" + q.join("&") : "");
    var ctl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, timeoutMs || LS_TIMEOUT) : null;
    var r;
    try {
      r = await fetch(u, ctl ? { signal: ctl.signal } : undefined);
    } catch (e) {
      if (e && e.name === "AbortError") throw new Error(down("请求超时"));
      throw new Error(down(String((e && e.message) || e)));
    } finally { if (timer) clearTimeout(timer); }
    var j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    if (!j) throw new Error("源码服务返回错误：HTTP " + r.status);
    return j;
  }

  // 产物 ref 归一：去 origin / 前导斜杠 / artifacts 前缀
  function normArtifactRef(ref) {
    var s = String(ref || "").trim().replace(/\\/g, "/").replace(/^https?:\/\/[^/]+/, "").replace(/^\/+/, "");
    if (s.indexOf("artifacts/") === 0) s = s.slice("artifacts/".length);
    return s;
  }

  function fmtLines(j) {
    var out = [j.path + "（行 " + j.start + "–" + j.end + " / 共 " + j.totalLines + " 行）"];
    (j.lines || []).forEach(function (l) { out.push(String(l.n).padStart(5, " ") + " | " + l.text); });
    if (j.nextStart) out.push("（未读完，继续读：" + j.nextStart + " 起）");
    return out.join("\n");
  }

  async function defineTools(registry) {
    if (!registry || typeof registry.define !== "function") return;
    if (!enabled()) return; // 未开启 / 线上默认关：不注册，零占用

    registry.define({
      name: "list_source",
      description:
        "列出可检索的源码/文档文件清单（由本地 source-server 的 --root 决定范围；已排除 node_modules/.git/.venv 与密钥文件）。" +
        "不知道某段代码在哪个文件时先看它；可用 prefix 收窄目录。",
      parameters: { type: "object", properties: { prefix: { type: "string", description: "目录前缀（可选），如 public/js" } }, additionalProperties: false },
      run: async (args) => {
        try {
          const j = await api("/list", { prefix: (args && args.prefix) || "" }, 20000);
          const files = j.files || [];
          const cap = 100;
          const out = ["可检索文件：" + j.count + " 个" + (args && args.prefix ? "（prefix=" + args.prefix + "）" : "") + (j.truncated ? "（已截断）" : "")];
          out.push(files.slice(0, cap).join("\n"));
          if (files.length > cap) out.push("…（还有 " + (files.length - cap) + " 个未显示；用 prefix 收窄）");
          out.push("提示：读文件用 read_source(路径)，找内容用 search_source(关键词)。");
          return out.join("\n");
        } catch (e) { return String((e && e.message) || e); }
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
      run: async (args) => {
        try {
          const j = await api("/grep", {
            q: (args && args.query) || "",
            regex: args && args.regex ? "1" : "",
            prefix: (args && args.pathPrefix) || "",
            max: (args && args.max) || "",
          }, 30000);
          if (!j.ok) return "搜索失败：" + (j.error || "未知错误");
          const hits = j.hits || [];
          if (!hits.length) return "没有命中（可换关键词、放宽 pathPrefix，或确认服务 --root 覆盖了目标目录）。";
          const out = ["命中 " + j.hitCount + " 处（扫描 " + j.scannedFiles + " 个文件，"
            + j.seconds + "s" + (j.truncated ? "，已截断" : "") + "）："];
          hits.forEach(function (h) { out.push(h.path + ":" + h.line + "  " + h.text); });
          out.push("要读上下文：read_source(路径, start=命中行-10, lines=30)。");
          return out.join("\n");
        } catch (e) { return String((e && e.message) || e); }
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
      run: async (args) => {
        try {
          const j = await api("/raw", { path: (args && args.path) || "", start: (args && args.start) || "", lines: (args && args.lines) || "" }, 20000);
          if (!j.ok) return "读取失败：" + (j.error || "未知错误");
          return fmtLines(j);
        } catch (e) { return String((e && e.message) || e); }
      },
    });

    registry.define({
      name: "list_artifacts",
      description: "列出产物目录（需 source-server 启动时配 --artifacts）里的文件，含大小/时间；用于找 agent 生成的图片、文档、数据。",
      parameters: { type: "object", properties: { prefix: { type: "string", description: "路径前缀（可选）" } }, additionalProperties: false },
      run: async (args) => {
        try {
          const j = await api("/list_artifacts", { prefix: (args && args.prefix) || "" }, 20000);
          if (!j.ok) return "产物清单不可用：" + (j.error || "未知错误");
          const files = j.files || [];
          if (!files.length) return "产物目录为空（或 prefix 没命中）。";
          const out = ["产物：" + j.count + " 个" + (j.truncated ? "（已截断）" : "")];
          files.slice(0, 80).forEach(function (f) { out.push(f.path + "  " + f.size + "B"); });
          if (files.length > 80) out.push("…（还有 " + (files.length - 80) + " 个；用 prefix 收窄）");
          out.push("读内容：read_artifact(路径)。");
          return out.join("\n");
        } catch (e) { return String((e && e.message) || e); }
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
      run: async (args) => {
        try {
          const j = await api("/read_artifact", {
            path: normArtifactRef(args && args.ref),
            start: (args && args.start) || "",
            lines: (args && args.lines) || "",
          }, 20000);
          if (j.ok) return fmtLines(j);
          if (j.binary && j.url) return "二进制/超限，用 URL 打开：" + j.url;
          return "读取失败：" + (j.error || "未知错误") + (j.url ? "\nURL：" + j.url : "");
        } catch (e) { return String((e && e.message) || e); }
      },
    });
  }

  window.__sourceTools = { defineTools, enabled, base, artBase, _keys: { ON_KEY: ON_KEY, URL_KEY: URL_KEY, ART_KEY: ART_KEY } };
})();
