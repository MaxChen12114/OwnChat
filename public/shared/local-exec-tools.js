// public/shared/local-exec-tools.js — 网页版的「本地手脚」（走本机执行服务）
// ─────────────────────────────────────────────────────────────────────
// 桌面版（Tauri）用 agent-local-tools.js 的 invoke 实现；网页版没有 invoke，
// 这里改走本机 127.0.0.1:8801 的执行服务（local-exec/local-exec-server.mjs）。
// 两个实现注册同一组工具名，靠 window.__TAURI__ 判断谁生效——不要同时装。
//
// 配置（浏览器控制台做一次）：
//   localStorage.setItem('cfw_local_exec_url', 'http://127.0.0.1:8801')
//   localStorage.setItem('cfw_local_exec_token', '<root>/.local-exec-token 的内容')
//
// 服务不在线时：工具照常注册，但调用返回明确的"服务未启动"指引，
// 让 agent 能告诉用户去启动，而不是报一个看不懂的网络错误。
// ─────────────────────────────────────────────────────────────────────
(function () {
  "use strict";
  if (window.__localExecTools) return;

  var LS_URL = "cfw_local_exec_url";
  var LS_TOKEN = "cfw_local_exec_token";

  function cfg() {
    var url = "", token = "";
    try {
      url = String(localStorage.getItem(LS_URL) || "").trim().replace(/\/+$/, "");
      token = String(localStorage.getItem(LS_TOKEN) || "").trim();
    } catch (e) {}
    return { url: url, token: token };
  }

  function ready() { var c = cfg(); return !!(c.url && c.token); }

  function hint() {
    var c = cfg();
    return "本机执行服务未就绪。" +
      (c.url ? "（已配地址 " + c.url + "，可能服务没启动或 token 不对）" : "（尚未配置地址与 token）") +
      "\n启动：node local-exec/local-exec-server.mjs --root <工作区> --port 8801" +
      "\n配置：localStorage.setItem('cfw_local_exec_url','http://127.0.0.1:8801');" +
      " localStorage.setItem('cfw_local_exec_token','<工作区>/.local-exec-token 的内容')";
  }

  async function api(method, path, body) {
    var c = cfg();
    if (!c.url || !c.token) throw new Error(hint());
    var r = await fetch(c.url + path, {
      method: method,
      headers: { "content-type": "application/json", "x-local-token": c.token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    var d = null;
    try { d = await r.json(); } catch (e) { throw new Error("执行服务返回非 JSON（" + r.status + "）"); }
    if (!r.ok) throw new Error((d && d.error) || ("HTTP " + r.status));
    return d;
  }

  async function defineTools(registry) {
    if (!registry || typeof registry.define !== "function") return;
    if (window.__TAURI__) return; // 桌面版走 Tauri 实现，避免工具重名

    registry.define({
      name: "local_list_dir",
      description: "列本机某个目录（相对工作区根或绝对路径，越界会被拒）。用于确认数据/文件在不在。",
      parameters: { type: "object", properties: { path: { type: "string", description: "目录路径，默认工作区根" } }, additionalProperties: false },
      run: async (a) => {
        try {
          const d = await api("GET", "/fs/list?path=" + encodeURIComponent((a && a.path) || "."));
          const lines = d.entries.slice(0, 200).map((e) => (e.dir ? "[DIR] " : "      ") + e.name + (e.dir ? "" : "  " + e.size + "B"));
          return "目录 " + d.path + "（" + d.entries.length + " 项）:\n" + lines.join("\n");
        } catch (e) { return String(e.message || e); }
      },
    });

    registry.define({
      name: "local_read_file",
      description: "读本机文件（相对工作区根或绝对路径，越界会被拒）。二进制文件返回 base64。",
      parameters: { type: "object", properties: { path: { type: "string", description: "文件路径" } }, required: ["path"], additionalProperties: false },
      run: async (a) => {
        try {
          const d = await api("POST", "/fs/read", { path: a.path });
          if (d.base64) return "[二进制 " + d.bytes + "B，base64 前 200 字符]\n" + String(d.base64).slice(0, 200);
          return "[文件 " + d.path + "，" + d.bytes + "B]\n" + String(d.content || "").slice(0, 20000);
        } catch (e) { return String(e.message || e); }
      },
    });

    registry.define({
      name: "local_write_file",
      description:
        "写本机文件（父目录自动创建，路径必须在工作区内）。\n" +
        "**写完要展示给人看（图/网页/CSV）时**：不要用 /xxx 这种站内相对路径（wrangler 的资产清单是启动时的快照，\n" +
        "新文件会 404，必须重启才可见）。改用本地服务的静态通道：\n" +
        "  写 <相对工作区的路径> → 用 URL http://127.0.0.1:8801/static/<同一个相对路径> 打开\n" +
        "  （例：写 OwnChat-AI/public/_art/a.png → stage_open({url:'http://127.0.0.1:8801/static/OwnChat-AI/public/_art/a.png'})）",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "文件路径" }, content: { type: "string", description: "文本内容" } },
        required: ["path", "content"], additionalProperties: false,
      },
      run: async (a) => {
        try {
          const d = await api("POST", "/fs/write", { path: a.path, content: a.content });
          return "已写入 " + d.path + "（" + d.bytes + "B）。展示用 URL：http://127.0.0.1:8801/static/" + String(a.path).replace(/\\/g, "/").replace(/^\/+/, "");
        } catch (e) { return String(e.message || e); }
      },
    });

    registry.define({
      name: "local_run_command",
      description:
        "在本机执行一个程序（不经 shell：command 是程序路径，args 是参数数组；不能写管道/重定向）。\n" +
        "适合：跑单步脚本、查环境、生成文件。长任务（>2 分钟）请改用 submit_job 派给作业台。\n" +
        "工作目录默认工作区根；越界路径会被拒。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "程序路径或命令名，如 C:/.../python.exe 或 python" },
          args: { type: "array", items: { type: "string" }, description: "参数数组" },
          cwd: { type: "string", description: "工作目录（可选，默认工作区根）" },
          timeoutMs: { type: "number", description: "超时毫秒（默认 120000，上限 600000）" },
        },
        required: ["command"], additionalProperties: false,
      },
      run: async (a) => {
        try {
          const d = await api("POST", "/exec", {
            command: a.command, args: Array.isArray(a.args) ? a.args : [],
            cwd: a.cwd || undefined, timeoutMs: a.timeoutMs || undefined,
          });
          const out = ["exitCode: " + d.exitCode];
          if (d.stdout) out.push("[stdout]\n" + String(d.stdout).slice(0, 12000));
          if (d.stderr) out.push("[stderr]\n" + String(d.stderr).slice(0, 4000));
          return out.join("\n");
        } catch (e) { return String(e.message || e); }
      },
    });
  }

  window.__localExecTools = { defineTools: defineTools, ready: ready, __v: 1 };
})();
