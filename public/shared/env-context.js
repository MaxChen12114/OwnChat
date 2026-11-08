
;(function (global) {
  "use strict"

  function hasTauri() {
    const t = global.__TAURI__
    return !!(t && t.core && typeof t.core.invoke === "function")
  }

  // ── L1：静态环境快照（零网络） ───────────────────────────────────────────
  function build(opts) {
    opts = opts || {}
    const now = new Date()
    let tz = ""
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "" } catch (e) {}
    const _rawVer = global.__appVersion
    const ver = (_rawVer && typeof _rawVer === "object") ? _rawVer : null
    const _verStr = typeof _rawVer === "string" ? _rawVer : ""
    const registry = opts.registry || null
    let toolNames = []
    try {
      if (registry && typeof registry.list === "function") {
        toolNames = registry.list().map(function (t) { return t.name })
      }
    } catch (e) {}
    return {
      local_time: (function () {
        try {
          // 4.79 #8: 跟随本机时区(上面 tz 由 Intl 解析),不再硬编码 Asia/Shanghai;tz 为空时省略,让 Intl 用运行时本地时区
          const _opts = {
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
          }
          if (tz) _opts.timeZone = tz
          return new Intl.DateTimeFormat("sv-SE", _opts).format(now)
        } catch (e) { return now.toISOString() }
      })(),
      tz: tz,
      weekday: ["日", "一", "二", "三", "四", "五", "六"][now.getDay()],
      is_online: (typeof navigator !== "undefined" && "onLine" in navigator) ? navigator.onLine : true,
      is_tauri: hasTauri(),
      screen: (typeof screen !== "undefined") ? (screen.width + "×" + screen.height) : "",
      lang: (typeof navigator !== "undefined" && navigator.language) || "",
      app_version: ver ? (ver.version || "") : (_verStr || "unknown"),
      app_hash: ver ? (ver.hash || "") : "",
      site_origin: (typeof location !== "undefined" && location.origin) ? location.origin : "",
      tools_count: toolNames.length,
      tools: toolNames,
    }
  }

  // ── L0：加载完整性 / monkey-patch 链自检（零网络，项目最高频故障） ──────────
  // 历史踩坑：const 重复声明 SyntaxError、加载顺序错、某模块被回滚成老版、fetch/Storage 链断裂
  function loadOrderCheck() {
    const checks = []
    function add(name, ok, detail) { checks.push({ name: name, ok: !!ok, detail: ok ? "" : (detail || "") }) }

    // 关键全局模块是否加载
    // 2026-06-20 修正误报:旧版探测 global.__dev.isOn(并不存在的方法名)→ __dev 已加载也永远判 fail(自检「1/6」那根刺)。
    // app.js 暴露的 window.__dev 真方法是 isDevMode(及 getReplyStyle 等),这里探真实方法名。
    add("dev.js (window.__dev)", !!(global.__dev && typeof global.__dev.isDevMode === "function"),
        "window.__dev 缺失或无 isDevMode → dev.js 未加载或加载顺序错")
    add("agent-kernel.js (window.AgentKernel)", !!(global.AgentKernel && typeof global.AgentKernel.createToolRegistry === "function"),
        "window.AgentKernel 缺失 → 内核未加载")
    add("tools.js (window.OwnChatTools)", !!(global.OwnChatTools && typeof global.OwnChatTools.buildRegistry === "function"),
        "window.OwnChatTools 缺失 → 工具集未加载")
    add("agent-reach.js (window.AgentReach)", !!(global.AgentReach && typeof global.AgentReach.defineTools === "function"),
        "window.AgentReach 缺失 → 联网能力未加载")

    let fetchPatched = false
    try { fetchPatched = typeof global.fetch === "function" && global.fetch.toString().indexOf("[native code]") === -1 } catch (e) {}
    add("fetch 已被包裹 (auth.js 链)", fetchPatched,
        "window.fetch 仍是原生 → auth.js 鉴权注入未生效，/sync 与 /api/* 可能 401")

    // sync.js 接管 Storage.setItem（云同步 markDirty 的关键）
    let setItemPatched = false
    try { setItemPatched = Storage.prototype.setItem.toString().indexOf("[native code]") === -1 } catch (e) {}
    add("Storage.setItem 已接管 (sync.js)", setItemPatched,
        "localStorage.setItem 未被包裹 → sync.js 云同步 markDirty 失效，改动不会上传")

    const failed = checks.filter(function (c) { return !c.ok })
    return {
      ok: failed.length === 0,
      total: checks.length,
      failed: failed.length,
      checks: checks,
      summary: failed.length === 0
        ? "全部关键模块已加载，monkey-patch 链完整"
        : (failed.length + "/" + checks.length + " 项异常：" + failed.map(function (c) { return c.name }).join("、")),
    }
  }

  // 注入 system prompt 的 <env> 文本（建议 session 级注入一次，不是每条消息都带）
  function snapshotText(opts) {
    const s = build(opts)
    const l0 = loadOrderCheck()
    return [
      "<env>",
      // 2026-06-19 缓存优化:注入 system 的 <env> 改为「会话级静态」——只保留日期,去掉 时:分:秒。否则每轮时间戳变动会让「含超大文档的整个 system 前缀」前缀缓存每轮失效 → 费用暴涨。需精确实时时间时模型仍可调 self_diagnostics(build() 照常返回完整 local_time,不受影响)。
      "日期：" + s.local_time.slice(0, 10) + "（周" + s.weekday + "，" + s.tz + "）",
      "运行端：" + (s.is_tauri ? "桌面端 Tauri" : "浏览器") + " | 网络：" + (s.is_online ? "在线" : "离线"),
      "版本：" + s.app_version + (s.app_hash ? ("@" + s.app_hash) : ""),
      // 2026-10-07: 自我认知 —— 站点地址用 location.origin 取（不硬编码域名，fork 后也正确）；
      // 「可读源码」两行让 agent 知道去哪读自己：本站前端=同源相对路径直读，上游=公开仓库 raw。
      // 这两行是会话级静态内容，不影响 <env> 的前缀缓存策略（见上一行注释）。
      "站点：" + (s.site_origin || "未知"),
      "可读源码：本站前端=同源相对路径（/js/… /shared/… /styles*.css，用 fetch_page 直读）；上游公开仓库=https://github.com/MaxChen12114/OwnChat（文件原文：https://raw.githubusercontent.com/MaxChen12114/OwnChat/main/<路径>）",
      "已装工具(" + s.tools_count + ")：" + (s.tools.join(", ") || "无"),
      "加载自检：" + l0.summary,
      "</env>",
    ].join("\n")
  }

  // ── 注册为 agent 工具（只读、非破坏性，权限可完全放开） ────────────────────
  function defineTools(registry) {
    if (!registry || typeof registry.define !== "function") {
      throw new Error("[env-context] 需要传入有效的 ToolRegistry（来自 agent-kernel.js）")
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
      async run(args, ctx) {
        const reg = (ctx && ctx.registry) || registry
        const result = { ok: true, env: build({ registry: reg }), load_check: loadOrderCheck() }
        const doNet = !args || args.network !== false
        if (doNet) {
          if (global.AgentReach && typeof global.AgentReach.diagnose === "function") {
            try {
              result.network = await global.AgentReach.diagnose(args && args.test_url)
            } catch (e) {
              result.network = "联网自检异常：" + (e && e.message ? e.message : String(e))
            }
          } else {
            result.network = "未检测到 AgentReach.diagnose（agent-reach.js 未加载或版本过旧），已跳过联网自检"
          }
        }
        return result
      },
    })
    return registry
  }

  global.__envContext = { build: build, loadOrderCheck: loadOrderCheck, snapshotText: snapshotText, defineTools: defineTools }
})(typeof globalThis !== "undefined" ? globalThis : window)