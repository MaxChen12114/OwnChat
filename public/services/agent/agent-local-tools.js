(function () {
/**
 * Desktop-only local file and command tools, registered only when the Tauri shell is present.
 *
 * **Why the `local_` prefix.** A virtual workspace tool set already exists (`list_files` / `read_file` /
 * `write_file` …) operating on IndexedDB, where nothing reaches disk. `registry.define` **throws** on a
 * duplicate name, and that throw takes every later tool down with it. So the real-disk set is prefixed:
 * no prefix = throwaway session workspace, `local_` = actual files behind a working-directory gate.
 *
 * **What the gate does and does not cover.** For the three file tools the working directory is a real
 * boundary: paths are resolved and must land inside it, and `../` plus symlink escapes are rejected.
 * For `local_run_command` the working directory is only the `cwd` — a command can `cd` out and reach
 * anything the user can. The real constraint there is the permission card plus the work mode, and the
 * tool description says so rather than overclaiming.
 *
 * **Commands never go through a shell.** Arguments travel as an array, so there is no shell injection;
 * the price is no pipes or redirection unless the model explicitly runs `cmd /c` / `bash -c`.
 *
 * `explain()` exists because of deployment skew: a published front end can meet an older installed
 * binary, where these commands are simply **not registered** and the error reads "command not found".
 * Passed through verbatim, the model concludes its arguments are wrong and retries forever; told it is
 * a version problem, it stops.
 *
 * Lock: `test/agent-local-tools.test.mjs` (written with the migration).
 * @module services/agent/agent-local-tools
 */

                              
                                                                  
 

                                
                                                          
                               
 

                                
                       
                              
                                          
 

function text(value         )         {
  return value == null ? "" : typeof value === "string" ? value : String(value);
}

function recOf(value         )                          {
  const out                          = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) out[k] = v;
  }
  return out;
}

/** `message` is non-enumerable on real errors — read it off the object, never via entries. */
function errText(e         )         {
  const m = e && typeof e === "object" ? Reflect.get(e, "message") : undefined;
  return m ? String(m) : String(e);
}

                             
                                                
 

function isRegistry(value         )                             {
  return typeof recOf(value).define === "function";
}

function createAgentLocalTools(env               )                {
  function isDesktop()          {
    return !!env.invoke();
  }

  /**
   * Turns an invoke failure into something the model can act on.
   * A "command not found"-shaped message means the installed app is older than the front end; saying so
   * stops the retry loop that a raw error message would start.
   */
  function explain(e         )         {
    const msg = errText(e);
    if (/not found|not allowed|unknown command|command .* not/i.test(msg)) {
      return "本地能力在当前 App 版本里不存在(需要 4.70+ 的桌面版)。别再重试,换用虚拟工作区工具或告知用户更新 App。";
    }
    return msg;
  }

  function defineTools(registry         )          {
    const invoke = env.invoke();
    if (!invoke) return registry; // Web build: register nothing.
    if (!isRegistry(registry)) return registry;
    const reg = registry;

    reg.define({
      name: "local_env",
      destructive: false,
      description:
        "查看本地能力状态:工作目录设在哪、里面有多少文件、Node 运行时是自带还是系统的。要动本地文件前先用它确认环境。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async run() {
        try {
          const i = await invoke("local_env_info");
          const node = recOf(i.node);
          return {
            ok: true,
            workdir: i.workdir || null,
            workdir_entries: i.entries,
            platform: i.platform,
            node: i.node
              ? {
                  ready: node.ready,
                  // "bundled" | "system" | ""
                  source: node.source,
                  version: node.version,
                  message: node.message,
                }
              : null,
          };
        } catch (e) {
          return { ok: false, error: explain(e) };
        }
      },
    });

    reg.define({
      name: "local_list_dir",
      destructive: false,
      description:
        "列出工作目录内的一个目录(不传 path 就是工作目录本身)。返回文件名 / 类型 / 大小。" + "只能列工作目录里面的路径。",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "目录路径;相对路径按工作目录解析" } },
        additionalProperties: false,
      },
      async run(args         ) {
        const a = recOf(args);
        try {
          return { ok: true, entries: await invoke("local_list_dir", { path: a.path || null }) };
        } catch (e) {
          return { ok: false, error: explain(e) };
        }
      },
    });

    reg.define({
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
      async run(args         ) {
        const a = recOf(args);
        try {
          const r = await invoke("local_read_file", {
            path: text(a.path),
            maxChars: typeof a.max_chars === "number" ? a.max_chars : null,
          });
          return { ok: true, path: r.path, text: r.text, chars: r.chars, truncated: r.truncated };
        } catch (e) {
          return { ok: false, error: explain(e) };
        }
      },
    });

    reg.define({
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
      async run(args         ) {
        const a = recOf(args);
        try {
          const r = await invoke("local_write_file", { path: text(a.path), content: text(a.content) });
          return { ok: true, path: r.path, bytes: r.bytes, overwrote: r.existed };
        } catch (e) {
          return { ok: false, error: explain(e) };
        }
      },
    });

    reg.define({
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
          cmd: { type: "string", description: '可执行文件名,如 "node" / "git" / "python"' },
          args: { type: "array", items: { type: "string" }, description: '参数数组,如 ["--version"]' },
          cwd: { type: "string", description: "工作目录内的子目录(可选,默认工作目录本身)" },
          timeout_ms: { type: "number", description: "超时毫秒,默认 120000,上限 600000" },
        },
        required: ["cmd"],
        additionalProperties: false,
      },
      async run(args         ) {
        const a = recOf(args);
        try {
          const r = await invoke("local_run_command", {
            cmd: text(a.cmd),
            args: Array.isArray(a.args) ? a.args.map((x) => text(x)) : null,
            cwd: a.cwd ? text(a.cwd) : null,
            timeoutMs: typeof a.timeout_ms === "number" ? a.timeout_ms : null,
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

  return { isDesktop: isDesktop, explain: explain, defineTools: defineTools };
}

// ── Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name ──
// The implementation moved to services/agent/agent-local-tools.ts. The only port is the Tauri invoke,
// resolved per call: the shell may inject `__TAURI__` after this script, and registration happens when
// the agent registry is built rather than at load time.
(function (g) {
  "use strict";
  var api = createAgentLocalTools({
    invoke: function () {
      return window.tauriSvc ? window.tauriSvc.invokeOrNull() : null;
    },
  });
  window.AgentLocalTools = { defineTools: api.defineTools, isDesktop: api.isDesktop };
})(window);

globalThis.createAgentLocalTools = createAgentLocalTools;
})();
