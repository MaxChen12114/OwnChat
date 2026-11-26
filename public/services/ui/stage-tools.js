(function () {
/**
 * Content-canvas tools: the five model tools that drive the right-hand panel's tab host
 * (stage_list / stage_open / stage_close / stage_view / stage_call).
 *
 * Every panel touch goes through {@link StagePorts.panel}, re-probed on each call instead of
 * snapshotted at load: the canvas mounts late on desktop and never on mobile, so a snapshot taken
 * before panel-host boots would keep the whole group unregistered for the session. The description
 * text is behaviour here — the model picks `page` over `html` by reading it — so it is carried over
 * verbatim, Chinese included; results stay plain text the model can act on.
 *
 * Tabs are addressed by `page` (a catalog id) on open and by `id` on close/call. Both are optional:
 * a call without them keeps the pre-tab meaning ("open it", "close what is showing", "call the
 * active tab"), which is why the old single-canvas call pattern still works.
 *
 * This file touches no `window`, `document` or `localStorage`; the facade lookup and the
 * `__stageTools` bridge live in l0/wiring/stage-tools.js.
 * @module services/ui/stage-tools
 */

/** A tool descriptor as the model sees it. `parameters` stays opaque JSON Schema. */
                          
               
                      
                                      
                                          
 

                                   
                             
 

/**
 * The slice of the panel facade this group needs. `tools` and `call` are optional because they
 * arrived in later facade versions; `state` carries `tabs`/`catalog` on the tab-host version and
 * the older `hasContent`-only shape is still tolerated. `close`/`call` gained an optional tab id.
 */
                             
                        
                       
                                                      
                                  
                                  
                                                                                 
 

                             
                                                                                               
                                 
 

/** Largest inline HTML accepted; above this the model should publish a file and pass `url`. */
const MAX_HTML = 400000;
/** Character budget for a `stage_call` result, so one screenshot cannot flood the context. */
const MAX_RET = 8000;
/** Views the panel can switch to; anything else is rejected before touching the facade. */
const VIEWS = ["canvas", "activity", "status"];

/**
 * Object guard for values that came back from the model or from the panel. Fields are copied one
 * by one: that is how this codebase reads unknown JSON without a cast.
 */
function recOf(value         )                          {
  const out                          = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
  const entries = Object.entries(value);
  for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  return out;
}

/** Array guard for the same reason as {@link recOf}. */
function arrOf(value         )            {
  if (!Array.isArray(value)) return [];
  const out            = [];
  for (let i = 0; i < value.length; i++) out.push(value[i]);
  return out;
}

/** String form used where the old code concatenated: `String(x)` matches `"" + x` for every value. */
function strOf(value         )         {
  return String(value);
}

/** `message` is non-enumerable on Error, so it cannot come through {@link recOf}. */
function messageOf(value         )          {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
  try {
    return Reflect.get(value, "message");
  } catch (_e) {
    return undefined;
  }
}

/** The wording the model sees when the facade throws: its message, else the thrown value. */
function errText(error         )         {
  return String(messageOf(error) || error);
}

/** Truncate for display with an ellipsis, so a long URL cannot dominate the tool result line. */
function brief(value         , limit        )         {
  const s = value == null ? "" : String(value);
  return s.length > limit ? s.slice(0, limit) + "…" : s;
}

/**
 * Build the group over its ports. `defineTools` registers nothing when the canvas is absent, which
 * is the same "not enabled, not registered" rule the other tool groups follow; a throw from
 * `define` is left to the caller, whose registry already isolates one group from the rest.
 */
function createStageTools(ports            ) {
  const DEFS            = [
    {
      name: "stage_list",
      description:
        "列出右栏标签页**已经开着什么、还能开什么**：已开标签（带 id 与当前激活项）+ 站内可开页面目录。\n" +
        "规则：用户说\"打开地图 / 看看沙盘 / 打开那个页面\"时，**先调这个**，不要自己去搜源码、也不要手写 HTML 重画。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      run: async () => {
        const p = ports.panel();
        if (!p) return "内容标签页未就绪。";
        const st = recOf(p.state());
        const tabs = arrOf(st["tabs"]);
        const catalog = arrOf(st["catalog"]);
        const lines           = [];
        if (tabs.length) {
          lines.push("已开标签（" + tabs.length + " 个）：");
          for (const item of tabs) {
            const t = recOf(item);
            const on = t["active"] === true;
            lines.push(
              "· [" + strOf(t["id"]) + "] " + strOf(t["title"]) +
                (t["pageId"] ? "（" + strOf(t["pageId"]) + "）" : "") +
                (on ? " ← 当前" : ""),
            );
          }
        } else {
          lines.push("当前没有打开的标签。");
        }
        if (catalog.length) {
          lines.push("站内可开页面（stage_open({page:\"id\"}) 直接打开）：");
          for (const item of catalog) {
            const c = recOf(item);
            lines.push(
              "· " + strOf(c["id"]) + " — " + strOf(c["title"] || c["id"]) + " → " +
                strOf(c["url"] || "（未配置，打开会给启动引导）"),
            );
          }
        } else {
          lines.push("站内没有注册任何页面。");
        }
        lines.push("也可以用 stage_open({html}) 放一次性内容（图表/表格）。");
        return lines.join("\n");
      },
    },
    {
      name: "stage_open",
      description:
        "在右栏**新开一个标签页**（已经开着就切到那一个，不会重复开）。四种用法，按优先级选：\n" +
        "① {page} 打开目录里的站内页面（id 见 stage_list：sandbox / council / studio / write / flow / coding / audio / map）——**优先用这个**。\n" +
        "② {url} 打开一个现成网页（agent 之前挂过的页面、外部地址）。\n" +
        "③ {html} 打开一段自包含 HTML——只用于\"没有现成页面的一次性可视化\"：图表、表格、流程图、小演示。\n" +
        "④ {text} 纯文本（日志、纯文本产物）。\n" +
        "纪律：\n" +
        "· 用户要\"地图 / 沙盘\"时先 stage_list 看有哪些站内页面，**不要搜源码、也不要手写 HTML 重画地图**。\n" +
        "· html 在隔离沙箱里执行（origin 为 null）：可以跑脚本、画 canvas，但**读不到父页**（parent/localStorage 会抛 SecurityError），不要把页面状态塞进 html 里传。\n" +
        "· 打开后标签切到前台；面板收起时只在顶栏 ⊞ 上点一个小圆点，用户自己决定什么时候看。\n" +
        "· 切走的标签会被暂停（动画冻结）；页面不配合时主机按上限销毁最旧的标签，切回来会重建。",
      parameters: {
        type: "object",
        properties: {
          page: { type: "string", description: "站内页面 id（stage_list 返回的目录；优先用它）" },
          url: { type: "string", description: "要打开的网页地址（http/https/相对路径）" },
          html: { type: "string", description: "自包含 HTML 片段（仅当没有现成页面时用）" },
          text: { type: "string", description: "纯文本内容" },
          title: { type: "string", description: "标签标题（简短，用于标签条与窗口标题）" },
          mode: {
            type: "string",
            description: "安全档（一般不用传）：trusted=自家页 / host-html=隔离沙箱 / external=外链。不传时按内容自动推断（html→host-html，url→trusted）。",
          },
        },
        additionalProperties: false,
      },
      run: async (args) => {
        const p = ports.panel();
        if (!p) return "内容标签页未就绪（手机端由壳接管，或页面未加载 panel-host）。";
        const a = recOf(args);
        const html = a["html"];
        const hasHtml = html != null && String(html) !== "";
        if (!a["page"] && !a["url"] && !hasHtml && a["text"] == null) return "至少给 page / url / html / text 之一。";
        if (hasHtml && String(html).length > MAX_HTML) {
          return "html 太大（" + String(html).length + " 字符，上限 " + MAX_HTML + "）。建议先落成文件，再用 url 打开。";
        }
        try {
          const r = recOf(
            p.open({
              pageId: a["page"] ? String(a["page"]) : undefined,
              url: a["url"] ? String(a["url"]) : undefined,
              html: hasHtml ? String(html) : undefined,
              text: a["text"] != null ? String(a["text"]) : undefined,
              title: String(a["title"] || ""),
              mode: a["mode"] ? String(a["mode"]) : undefined,
            }),
          );
          if (!r["ok"]) return "打开失败：" + String(r["error"] || "未知原因");
          const st = recOf(p.state());
          return (
            "已打开标签：" +
            strOf(a["title"] || r["title"] || brief(a["page"] || a["url"] || "内联内容", 60)) +
            "（安全档 " + strOf(r["mode"]) + "，宽 " + strOf(st["width"]) + "px）。"
          );
        } catch (e) {
          return "打开出错：" + errText(e);
        }
      },
    },
    {
      name: "stage_close",
      description:
        "关掉右栏的一个标签页（不传 id = 关当前激活的那个）。内容看完就收，别让它一直占着用户的屏幕。标签页本身不会收起面板，用户点顶栏按钮可收起整个面板。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "标签 id（stage_list 返回）；省略 = 当前激活标签" },
        },
        additionalProperties: false,
      },
      run: async (args) => {
        const p = ports.panel();
        if (!p) return "内容标签页未就绪。";
        const id = String(recOf(args)["id"] || "").trim();
        try {
          p.close(id ? id : undefined);
          return id ? "已关闭标签：" + id + "。" : "已关闭当前标签。";
        } catch (e) {
          return "关闭出错：" + errText(e);
        }
      },
    },
    {
      name: "stage_view",
      description:
        "切换右栏的视图：canvas=内容标签页（默认）/ activity=活动（多智能体交互时间线）/ status=状态（上下文、计费、系统）。" +
        "一般不需要调用——用户自己会点。只有一种情况用得上：你想让用户\"先看过程\"（activity）再回来看结果。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "canvas | activity | status" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      run: async (args) => {
        const p = ports.panel();
        if (!p) return "内容标签页未就绪。";
        const name = String(recOf(args)["name"] || "");
        if (VIEWS.indexOf(name) === -1) return "未知视图：" + name + "（可选 canvas / activity / status）";
        try {
          p.view(name);
          return "已切到视图：" + name;
        } catch (e) {
          return "切换出错：" + errText(e);
        }
      },
    },
    {
      name: "stage_call",
      description:
        "调用右栏某个标签页自己注册的函数（页面用 window.__stage = { 函数名: (参数) => 结果 } 声明），用来驱动它：改地图、推战线、换数据、重算。\n" +
        "默认打**当前激活的标签**；要驱动后台标签就带 id（stage_list 返回）。\n" +
        "什么时候用：用户要「让页面动起来 / 更新它 / 按你说的改」时。**只打开不驱动 = 页面停在初始那一帧。**\n" +
        "参数形状：args 是**按位置的参数列表**，等价于 fn(...args)。\n" +
        "  · 无参：省略 args 或写 []\n" +
        "  · 单参数且该参数是个数组：要再包一层，例 setOwners 传 args=[网格数组]\n" +
        "  · 例：{fn:\"setOwner\", args:[48,10,1]} → setOwner(48,10,1)\n" +
        "函数名不对会返回该页面实际可用的函数清单，照着清单再调一次即可。\n" +
        "沙盘（page:\"sandbox\"）注册的函数以页面实际注册（__stage）为准——调错名会返回实时清单，以它为准。\n" +
        "常用：state（看局面）/ editCell（改地形，走 overlay 账本）/ act（通用改动命令）/ facility.place·remove（设施）/ preview（放置预览）/ terrainDataURL（确定性比对）。没有标签时先 stage_open 再调。",
      parameters: {
        type: "object",
        properties: {
          fn: { type: "string", description: "函数名（页面 window.__stage 的键）" },
          args: { description: "传给该函数的入参（任意 JSON）。不需要参数可省略。" },
          timeoutMs: { type: "number", description: "超时毫秒（默认 15000，上限 120000）" },
          id: { type: "string", description: "目标标签 id（stage_list 返回）；省略 = 当前激活标签" },
        },
        required: ["fn"],
        additionalProperties: false,
      },
      run: async (args) => {
        const p = ports.panel();
        if (!p) return "内容标签页未就绪。";
        if (typeof p.call !== "function") return "标签页回调通道不可用（panel-host 版本太旧，需要 v>=20）。";
        const a = recOf(args);
        const fn = String(a["fn"] || "").trim();
        if (!fn) return "需要 fn（画布页注册的函数名）。";
        const id = String(a["id"] || "").trim();
        let out         ;
        try {
          out = await p.call(fn, "args" in a ? a["args"] : undefined, a["timeoutMs"], id ? id : undefined);
        } catch (e) {
          return "调用失败：" + errText(e);
        }
        if (out === undefined) return "已执行 " + fn + "（无返回值）。";
        let s        ;
        try {
          const json = JSON.stringify(out);
          s = json == null ? String(out) : json;
        } catch (_e) {
          s = String(out);
        }
        if (s.length > MAX_RET) {
          return fn + " 返回了 " + s.length + " 字符，超过上限 " + MAX_RET + "，已截断：\n" + s.slice(0, MAX_RET);
        }
        return fn + " → " + s;
      },
    },
  ];

  /** Register the five tools, or nothing at all when the canvas is not mounted. */
  function defineTools(registry                         )       {
    if (!registry || typeof registry.define !== "function") return;
    if (!ports.panel()) return;
    for (const def of DEFS) registry.define(def);
  }

  return { defineTools };
}

// ── Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name ──
// Content-canvas tools: the five tool texts and every result wording live in
// services/ui/stage-tools.ts, so this file owns only the facade lookup. The panel is probed on
// every call rather than snapshotted at load, because it mounts after boot on desktop and never on
// mobile — a cached "absent" would keep the group unregistered for the whole session. Registration
// itself is a no-op without a canvas, the same rule the sibling tool groups follow.
(function () {
  if (window.__stageTools) return;

  function panel() {
    return (window.panelSvc && window.panelSvc.v === 1) ? window.panelSvc : null;
  }

  var svc = createStageTools({ panel: panel });

  window.__stageTools = { defineTools: svc.defineTools, __v: 1 };
})();

globalThis.recOf = recOf;
globalThis.arrOf = arrOf;
globalThis.createStageTools = createStageTools;
})();
