// public/shared/agent-local-tools.js — 桌面端本地能力工具（4.70）
//
// 给 agent 真实的本地能力:列目录 / 读文件 / 写文件 / 跑命令。只在桌面端(Tauri)注册;
// 网页版没有 invoke,本模块什么都不做。
//
// === 为什么名字带 local_ 前缀 ===
// 已经有一套虚拟工作区工具在跑(data/agent-workspace.js):
//   list_files / read_file / write_file / edit_file / delete_file / export_file
// 它们操作的是浏览器 IndexedDB,文件不落地。内核的 registry.define 遇到重名会 **throw**,
// 而重复定义会让后续工具全部漏注册(agent-reach.js 头顶那条 Bug4 注释记的就是这个坑)。
// 所以本地这套统一加 local_ 前缀,两组并存、语义分明:
//   不带前缀 = 会话内的临时工作区(随便写,不落盘)
//   带 local_ = 你磁盘上的真实文件(受工作目录门控)
//
// === 门控能覆盖什么、不能覆盖什么 ===
//   文件类(local_read_file / local_write_file / local_list_dir):工作目录门控**有效**,
//     路径解析后必须落在工作目录内,`../` 与软链逃逸都会被拒。
//   local_run_command:工作目录**只是 cwd** —— 命令可以 cd 出去、访问任何当前用户有权访问的东西。
//     对它的真实约束是权限确认卡 + 工作模式(设置 → Agent)。描述里如实写清,不夸大。
//
// 命令用 spawn 数组参数传递(不经 shell),所以没有 shell 注入问题;
// 代价是不支持管道/重定向 —— 需要的话得显式跑 `cmd /c "..."` 或 `bash -c "..."`。

(function (global) {
  "use strict";

  function tauriInvoke() {
    const t = typeof window !== "undefined" && window.__TAURI__;
    return t && t.core && typeof t.core.invoke === "function" ? t.core.invoke.bind(t.core) : null;
  }

  function isDesktop() {
    return !!tauriInvoke();
  }

  /**
   * 把 invoke 的异常转成模型看得懂的说明。
   * 部署顺序会产生一个中间态:前端已发布、用户 exe 还是旧版 —— 那时这些命令**根本没注册**,
   * 报的是 "command not found"。照原样回传会让模型以为自己参数写错了,反复重试。
   * 识别出来并说明是版本问题,它就会放弃而不是瞎试。
   */
  function explain(e) {
    const msg = String((e && e.message) || e);
    if (/not found|not allowed|unknown command|command .* not/i.test(msg)) {
      return "本地能力在当前 App 版本里不存在(需要 4.70+ 的桌面版)。别再重试,换用虚拟工作区工具或告知用户更新 App。";
    }
    return msg;
  }

  function defineTools(registry) {
    const invoke = tauriInvoke();
    if (!invoke) return registry; // 网页版:不注册

    registry.define({
      name: "local_env",
      destructive: false,
      description:
        "查看本地能力状态:工作目录设在哪、里面有多少文件、Node 运行时是自带还是系统的。要动本地文件前先用它确认环境。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async run() {
        try {
          const i = await invoke("local_env_info");
          return {
            ok: true,
            workdir: i.workdir || null,
            workdir_entries: i.entries,
            platform: i.platform,
            node: i.node
              ? {
                  ready: i.node.ready,
                  source: i.node.source,   // "bundled" | "system" | ""
                  version: i.node.version,
                  message: i.node.message,
                }
              : null,
          };
        } catch (e) {
          return { ok: false, error: explain(e) };
        }
      },
    });

    registry.define({
      name: "local_list_dir",
      destructive: false,
      description:
        "列出工作目录内的一个目录(不传 path 就是工作目录本身)。返回文件名 / 类型 / 大小。" +
        "只能列工作目录里面的路径。",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "目录路径;相对路径按工作目录解析" } },
        additionalProperties: false,
      },
      async run({ path }) {
        try {
          return { ok: true, entries: await invoke("local_list_dir", { path: path || null }) };
        } catch (e) {
          return { ok: false, error: explain(e) };
        }
      },
    });

    registry.define({
      name: "local_read_file",
      destructive: false,
      description: "读取工作目录内的一个文本文件。只能读工作目录里面的文件(软链逃逸也会被拒)。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件路径;相对路径按工作目录解析" },
          max_chars: { type: "number", description: "最多读取字符数(默认 200000)" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      async run({ path, max_chars }) {
        try {
          const r = await invoke("local_read_file", {
            path: String(path),
            maxChars: typeof max_chars === "number" ? max_chars : null,
          });
          return { ok: true, path: r.path, text: r.text, chars: r.chars, truncated: r.truncated };
        } catch (e) {
          return { ok: false, error: explain(e) };
        }
      },
    });

    registry.define({
      name: "local_write_file",
      destructive: true,
      description:
        "把内容写入工作目录内的一个文件(会覆盖同名文件)。只能写工作目录里面;" +
        "父目录必须已存在。这是**真实磁盘写入**,不是会话内临时文件 —— " +
        "想写不落盘的东西请用 write_file(虚拟工作区)。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "目标文件路径;相对路径按工作目录解析" },
          content: { type: "string", description: "要写入的完整内容" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
      async run({ path, content }) {
        try {
          const r = await invoke("local_write_file", { path: String(path), content: String(content) });
          return { ok: true, path: r.path, bytes: r.bytes, overwrote: r.existed };
        } catch (e) {
          return { ok: false, error: explain(e) };
        }
      },
    });

    registry.define({
      name: "local_run_command",
      destructive: true,
      description:
        "在工作目录里执行一条命令,返回退出码与输出。适合跑构建、测试、脚本、git 等。" +
        "参数以数组传递、**不经 shell**(所以没有 shell 注入,但也不支持管道/重定向;" +
        "要管道得自己跑 cmd /c 或 bash -c)。" +
        "注意:①工作目录只决定命令的 cwd,**不能限制命令访问别处** —— 一条命令可以 cd 出去。" +
        "所以这条工具受你的权限确认卡与工作模式管辖,且每次执行前还会弹**系统原生确认框**" +
        "(Rust 侧,页面无法伪造;用户拒绝则本次调用直接失败)。" +
        "②环境变量经过清洗:名字含 KEY/PASSWORD/SECRET/TOKEN 的不会传给命令," +
        "printenv 看不到用户凭据是刻意设计,不要尝试绕过。",
      parameters: {
        type: "object",
        properties: {
          cmd: { type: "string", description: "可执行文件名,如 \"node\" / \"git\" / \"python\"" },
          args: { type: "array", items: { type: "string" }, description: "参数数组,如 [\"--version\"]" },
          cwd: { type: "string", description: "工作目录内的子目录(可选,默认工作目录本身)" },
          timeout_ms: { type: "number", description: "超时毫秒,默认 120000,上限 600000" },
        },
        required: ["cmd"],
        additionalProperties: false,
      },
      async run({ cmd, args, cwd, timeout_ms }) {
        try {
          const r = await invoke("local_run_command", {
            cmd: String(cmd),
            args: Array.isArray(args) ? args.map(String) : null,
            cwd: cwd ? String(cwd) : null,
            timeoutMs: typeof timeout_ms === "number" ? timeout_ms : null,
          });
          return {
            ok: !!r.ok,
            exit_code: r.exitCode,
            stdout: r.stdout || "",
            stderr: r.stderr || "",
            duration_ms: r.durationMs,
            truncated: !!r.truncated,
            timed_out: !!r.timedOut,
            cwd: r.cwd,
          };
        } catch (e) {
          return { ok: false, error: explain(e) };
        }
      },
    });

    return registry;
  }

  global.AgentLocalTools = { defineTools, isDesktop };
})(typeof globalThis !== "undefined" ? globalThis : window);
