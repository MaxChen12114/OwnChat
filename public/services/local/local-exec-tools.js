(function () {
/**
 * Tool group that reaches the machine's local-exec service from the browser build, which has no
 * Tauri `invoke`. The desktop build registers the same four tool names through the invoke-based
 * `agent-local-tools` module, so exactly one of the two may be registered; the wiring probes the
 * desktop bridge at registration time and this module stays silent when it is present.
 *
 * The service owns the request shapes, the readiness rule and every string the model sees. The
 * wiring owns `localStorage`, `fetch` and the desktop probe — nothing here touches a browser global.
 *
 * An unconfigured endpoint is not a registration failure: the tools register anyway and each call
 * returns the setup hint, so the model can tell the user what to start instead of surfacing a raw
 * network error. Tool descriptions and returned text stay Chinese — they are agent-facing copy, not
 * comments. See test/local-exec-tools.test.mjs.
 * @module services/local/local-exec-tools
 */

const LEX_LS_URL = "cfw_local_exec_url";
const LEX_LS_TOKEN = "cfw_local_exec_token";

/** Storage reader; only `getItem` is used. A throw means "not configured", never a hard failure. */
                             
                                      
 

/** Resolved endpoint and token. `url` has trailing slashes stripped. */
                            
              
                
 

/** Minimal response surface needed here; the wiring passes the real `fetch` result through. */
                              
              
                 
                           
 

/** Request init this module builds; the wiring hands it straight to `fetch`. */
                          
                 
                                  
                
 

/** Everything this module needs from the browser. */
                           
                      
                                                              
                                                                                              
                     
 

/** One tool descriptor as the agent registry expects it. */
                          
               
                      
                                      
                                                                                
                                   
 

                       
                              
 

function lexRec(v         )                          {
  const out                          = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

/** Stringify for display exactly like template interpolation: `undefined` prints as such. */
function lexRaw(v         )         {
  return String(v);
}

/** Read a field that must be present; a missing key is a protocol violation, not an empty value. */
function lexField(rec                         , key        )          {
  if (!(key in rec)) throw new Error("执行服务返回缺少字段（" + key + "）");
  return rec[key];
}

function lexArrField(rec                         , key        )            {
  const v = lexField(rec, key);
  if (!Array.isArray(v)) throw new Error("执行服务返回格式异常（" + key + " 不是数组）");
  return v;
}

/**
 * `/fs/list` reports the *untruncated* entry count but only prints the first 200 rows, so a large
 * directory still tells the model how much it is not seeing.
 */
function lexListLines(entries           )         {
  return entries
    .slice(0, 200)
    .map((e) => {
      const row = lexRec(e);
      const dir = !!row.dir;
      return (dir ? "[DIR] " : "      ") + lexRaw(row.name) + (dir ? "" : "  " + lexRaw(row.size) + "B");
    })
    .join("\n");
}

/** `e.message || e`, but `message` is non-enumerable so it has to come from `Reflect.get`. */
function lexErrText(e         )         {
  if (e && typeof e === "object") {
    const m = Reflect.get(e, "message");
    if (m) return String(m);
  }
  return String(e);
}

/**
 * Resolve the stored endpoint.
 *
 * @param storage Any `getItem` surface. Throwing stores resolve to the empty config.
 * @returns The trimmed url with trailing slashes removed, and the trimmed token.
 */
function lexConfig(storage            )            {
  let url = "";
  let token = "";
  try {
    url = String(storage.getItem(LEX_LS_URL) || "").trim().replace(/\/+$/, "");
    token = String(storage.getItem(LEX_LS_TOKEN) || "").trim();
  } catch (e) {
    // Blocked storage reads as "not configured"; the hint below explains how to set both keys.
  }
  return { url, token };
}

/** @returns True when both the endpoint and the token are configured. */
function lexReady(cfg           )          {
  return !!(cfg.url && cfg.token);
}

/**
 * @param cfg Current config.
 * @returns The setup guidance shown when a call cannot be made. It names the concrete server
 * command and the two storage keys, and distinguishes "no address yet" from "address set but the
 * service or token is wrong" — the two failures have different fixes.
 */
function lexHint(cfg           )         {
  return (
    "本机执行服务未就绪。" +
    (cfg.url
      ? "（已配地址 " + cfg.url + "，可能服务没启动或 token 不对）"
      : "（尚未配置地址与 token）") +
    "\n启动：node local-exec/local-exec-server.mjs --root <工作区> --port 8801" +
    "\n配置：localStorage.setItem('cfw_local_exec_url','http://127.0.0.1:8801');" +
    " localStorage.setItem('cfw_local_exec_token','<工作区>/.local-exec-token 的内容')"
  );
}

/**
 * One JSON call against the local service.
 *
 * @param body Omitted entirely when `undefined` — the GET path must not send a body.
 * @returns The parsed JSON object. Non-object JSON is flattened to an empty record, which the field
 * readers then reject, so a malformed reply surfaces as a protocol error rather than as silent
 * empty data.
 * @throws Error with the setup hint when unconfigured, the service's own `error` field on a
 * non-2xx reply, or the HTTP status when the reply carries no message.
 */
async function lexCall(
  ports          ,
  method        ,
  path        ,
  body                          ,
)                                   {
  const cfg = lexConfig(ports.storage);
  if (!lexReady(cfg)) throw new Error(lexHint(cfg));
  const init          = {
    method,
    headers: { "content-type": "application/json", "x-local-token": cfg.token },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await ports.fetchImpl(cfg.url + path, init);
  let d          = null;
  try {
    d = await r.json();
  } catch (e) {
    throw new Error("执行服务返回非 JSON（" + r.status + "）");
  }
  if (!r.ok) {
    const err = lexRec(d).error;
    throw new Error(err ? String(err) : "HTTP " + r.status);
  }
  return lexRec(d);
}

function lexTools(ports          )            {
  return [
    {
      name: "local_list_dir",
      description: "列本机某个目录（相对工作区根或绝对路径，越界会被拒）。用于确认数据/文件在不在。",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "目录路径，默认工作区根" } },
        additionalProperties: false,
      },
      run: async (a) => {
        try {
          const args = lexRec(a);
          const path = String(args.path || ".");
          const d = await lexCall(ports, "GET", "/fs/list?path=" + encodeURIComponent(path));
          const entries = lexArrField(d, "entries");
          return "目录 " + lexRaw(d.path) + "（" + entries.length + " 项）:\n" + lexListLines(entries);
        } catch (e) {
          return lexErrText(e);
        }
      },
    },
    {
      name: "local_read_file",
      description: "读本机文件（相对工作区根或绝对路径，越界会被拒）。二进制文件返回 base64。",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "文件路径" } },
        required: ["path"],
        additionalProperties: false,
      },
      run: async (a) => {
        try {
          const d = await lexCall(ports, "POST", "/fs/read", { path: lexRec(a).path });
          const base64 = d.base64;
          if (base64) {
            return (
              "[二进制 " + lexRaw(d.bytes) + "B，base64 前 200 字符]\n" + String(base64).slice(0, 200)
            );
          }
          const content = d.content;
          return (
            "[文件 " + lexRaw(d.path) + "，" + lexRaw(d.bytes) + "B]\n" +
            String(content ? content : "").slice(0, 20000)
          );
        } catch (e) {
          return lexErrText(e);
        }
      },
    },
    {
      name: "local_write_file",
      description:
        "写本机文件（父目录自动创建，路径必须在工作区内）。\n" +
        "**写完要展示给人看（图/网页/CSV）时**：不要用 /xxx 这种站内相对路径（wrangler 的资产清单是启动时的快照，\n" +
        "新文件会 404，必须重启才可见）。改用本地服务的静态通道：\n" +
        "  写 <相对工作区的路径> → 用 URL http://127.0.0.1:8801/static/<同一个相对路径> 打开\n" +
        "  （例：写 OwnChat/public/_art/a.png → stage_open({url:'http://127.0.0.1:8801/static/OwnChat/public/_art/a.png'})）",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件路径" },
          content: { type: "string", description: "文本内容" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
      run: async (a) => {
        try {
          const args = lexRec(a);
          const d = await lexCall(ports, "POST", "/fs/write", {
            path: args.path,
            content: args.content,
          });
          const shown = String(args.path).replace(/\\/g, "/").replace(/^\/+/, "");
          return (
            "已写入 " + lexRaw(d.path) + "（" + lexRaw(d.bytes) + "B）。展示用 URL：" +
            "http://127.0.0.1:8801/static/" + shown
          );
        } catch (e) {
          return lexErrText(e);
        }
      },
    },
    {
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
        required: ["command"],
        additionalProperties: false,
      },
      run: async (a) => {
        try {
          const args = lexRec(a);
          // `undefined` members are dropped by JSON.stringify, which is how "default at the server"
          // is expressed here — sending nulls would override the server's own defaults.
          const d = await lexCall(ports, "POST", "/exec", {
            command: args.command,
            args: Array.isArray(args.args) ? args.args : [],
            cwd: args.cwd || undefined,
            timeoutMs: args.timeoutMs || undefined,
          });
          const out = ["exitCode: " + lexRaw(d.exitCode)];
          const stdout = d.stdout;
          if (stdout) out.push("[stdout]\n" + String(stdout).slice(0, 12000));
          const stderr = d.stderr;
          if (stderr) out.push("[stderr]\n" + String(stderr).slice(0, 4000));
          return out.join("\n");
        } catch (e) {
          return lexErrText(e);
        }
      },
    },
  ];
}

/**
 * Register the four tools on an agent registry.
 *
 * @param registry The registry object; anything without a callable `define` is ignored, so a
 * half-built host cannot break the boot sequence.
 * @returns Nothing. On the desktop build (or when the registry is unusable) no tool is registered —
 * the other implementation owns these names there.
 */
function lexDefineTools(ports          , registry         )       {
  const reg = lexAsRegistry(registry);
  if (!reg) return;
  if (ports.desktop()) return;
  const tools = lexTools(ports);
  for (let i = 0; i < tools.length; i++) reg.define(tools[i]);
}

/** Structural check that also keeps the registry at arm's length — no cast, no shared reference. */
function lexAsRegistry(v         )                     {
  if (!v || typeof v !== "object") return null;
  const define = Reflect.get(v, "define");
  if (typeof define !== "function") return null;
  return {
    define: (tool) => {
      Reflect.apply(define, v, [tool]);
    },
  };
}

// Browser adapter, appended by l0/emit.mjs. Engine: services/local/local-exec-tools.ts; this file
// owns localStorage, fetch, the desktop probe and the published tool-group object. The desktop
// build registers the same four tool names through the invoke-based module, so registration is
// skipped whenever that bridge is present — never both.
(function () {
  "use strict";
  if (window.__localExecTools) return;

  var ports = {
    storage: { getItem: function (k) { return localStorage.getItem(k); } },
    fetchImpl: function (url, init) { return fetch(url, init); },
    desktop: function () { return !!(window.tauriSvc && window.tauriSvc.has()); },
  };

  window.__localExecTools = {
    defineTools: function (registry) { lexDefineTools(ports, registry); },
    ready: function () { return lexReady(lexConfig(ports.storage)); },
    __v: 1,
  };
})();

globalThis.lexConfig = lexConfig;
globalThis.lexReady = lexReady;
globalThis.lexHint = lexHint;
globalThis.lexDefineTools = lexDefineTools;
})();
