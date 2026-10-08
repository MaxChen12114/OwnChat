/**
 * agent-reach.js — Agent 互联网能力层（Skill 模块）
 * 基于 Agent-Reach 设计理念，浏览器侧实现
 *
 * 能力列表：
 *   fetch_page      — 读任意网页（桌面端 Rust 原生直连优先，网页端走 /api/fetch worker 代理，绕过 GFW / CORS）
 *   web_search      — 全网语义搜索（worker 服务端：Exa 优先付费，降级 DDG；桌面端再降级原生 DDG）
 *   search_bilibili — B 站内容搜索（无需登录，国内直连）
 *   search_github   — GitHub 仓库/代码搜索
 *   read_rss        — RSS/Atom 订阅源解析
 *
 * 注:本文件仍内嵌 AGENT_REACH_SKILL 常量留作参考,但没有任何代码把它注入 prompt ——
 * 工具说明(description)已自带使用指引,SKILL 文本当前是纯负重(可按需接入 system prompt)。
 *
 * 用法：
 *   // 方式一：注册到现有 registry
 *   AgentReach.defineTools(registry)
 *
 *   // 方式二：合并到 OwnChatTools
 *   const registry = OwnChatTools.buildRegistry({ onImage })
 *   AgentReach.defineTools(registry)
 *
 * 加载顺序：agent-kernel.js → tools.js → agent-reach.js
 */
;(function (global) {
  "use strict"

  // ─── 2026-06-17 超时与原生兑底 ──────────────────────────
  // 真因修复:Jina Reader / B站 / GitHub 等外呼无超时,抓到无响应站点时 fetch 永不 resolve,
  // 让 agent loop 永久挂起(“推理到第 N 轮就不返回”)。给所有外呼套 AbortController 超时;
  // 桌面端(Tauri)再补原生 http_request 直连兑底(无 GFW / CORS,不依赖 Jina)。
  const DEFAULT_TIMEOUT_MS = 20000
  function fetchWithTimeout(url, init, timeoutMs) {
    const ms = timeoutMs || DEFAULT_TIMEOUT_MS
    const ctrl = new AbortController()
    const timer = setTimeout(function () { try { ctrl.abort() } catch (e) {} }, ms)
    const opts = Object.assign({}, init || {}, { signal: ctrl.signal })
    return fetch(url, opts).finally(function () { clearTimeout(timer) })
  }
  function withTimeout(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        reject(new Error((label || "操作") + "超时(" + (ms || DEFAULT_TIMEOUT_MS) + "ms)"))
      }, ms || DEFAULT_TIMEOUT_MS)
      Promise.resolve(promise).then(
        function (v) { clearTimeout(timer); resolve(v) },
        function (e) { clearTimeout(timer); reject(e) }
      )
    })
  }
  // HTML 粗转纯文(原生抓取拿到的是原始 HTML,没有 Jina 的 markdown 清洗)
  function htmlToText(html) {
    if (typeof html !== "string") return ""
    let t = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<\/(p|div|li|tr|h[1-6]|br)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
    t = t.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    return t.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim()
  }
  // 桌面端原生直连兑底:成功返回纯文本,非桌面/失败/超时返回 null
  // headers: 可选对象，传给 Rust http_request 的请求头（如 UA / Referer）
  async function tryNativeFetch(url, maxChars, headers, rawHtml) {
    const invoke = (typeof global.__TAURI__ !== "undefined" && global.__TAURI__ && global.__TAURI__.core && typeof global.__TAURI__.core.invoke === "function")
      ? global.__TAURI__.core.invoke.bind(global.__TAURI__.core) : null
    if (!invoke) return null
    try {
      const r = await withTimeout(invoke("http_request", { method: "GET", url: url, follow_redirects: true, headers: headers || {} }), DEFAULT_TIMEOUT_MS, "原生抓取")
      const status = r && typeof r.status === "number" ? r.status : 0
      if (status < 200 || status >= 400) return null
      let raw = ""
      try {
        const bin = atob((r && r.body_base64) || "")
        raw = new TextDecoder("utf-8").decode(Uint8Array.from(bin, function (c) { return c.charCodeAt(0) }))
      } catch (e) { raw = "" }
      if (!raw) return null
      const ct = (r && r.content_type) || ""
      // rawHtml=true: 跳过 htmlToText,返回原始 HTML(供 nativeDdgSearch 解析 DDG 结果结构)
      const text = rawHtml ? raw : ((/text\/html/i.test(ct) || /^\s*</.test(raw)) ? htmlToText(raw) : raw)
      return text.slice(0, maxChars)
    } catch (e) { return null }
  }

  // ─── 常量 ───────────────────────────────────────────────────────────────────
  const BILI_API     = "https://api.bilibili.com/x/web-interface/search/type"
  const GH_API       = "https://api.github.com/search"
  const PROXY        = typeof global.__agentReachProxy === "string"
    ? global.__agentReachProxy
    : "/api/fetch"  // worker 代理，绕过 CORS（网页侧必要）

  // ─── 2026-06-20 成本意识：web_search 命中 Exa 时按次计费(其余联网工具免费) ───────
  // 让 agent 对消耗有概念：每次 Exa 搜索累加估算花费并本地持久化，供 web_search 结果与 reach_cost 读取。
  const EXA_COST_PER_SEARCH = 0.007  // USD，Exa Search ≈ $7/1k
  const _REACH_COST_KEY = "cfw_reach_cost_v1"
  function _readReachCost() {
    try {
      const raw = global.localStorage && global.localStorage.getItem(_REACH_COST_KEY)
      const o = raw ? JSON.parse(raw) : null
      if (o && typeof o.usd === "number") return o
    } catch (e) {}
    return { usd: 0, searches: 0 }
  }
  function bumpReachCost(usd) {
    const c = _readReachCost()
    c.usd = Math.round((c.usd + (Number(usd) || 0)) * 1e6) / 1e6
    c.searches = (c.searches || 0) + 1
    try { global.localStorage && global.localStorage.setItem(_REACH_COST_KEY, JSON.stringify(c)) } catch (e) {}
    return c
  }
  function reachCostSummary() {
    const c = _readReachCost()
    return { usd: c.usd, rmb: Math.round(c.usd * 7.2 * 100) / 100, searches: c.searches || 0 }
  }


  // ─── SKILL.md（agent 自动读取的能力说明）────────────────────────────────────
  const AGENT_REACH_SKILL = `
# Agent-Reach Skill

## 能力
- **fetch_page(url)**          读任意网页内容（**本站自身地址/相对路径=同源直读**——读自己的源码就用这个；桌面端 Rust 原生直连优先，其余走 /api/fetch worker 代理，绕墙 / CORS）
- **web_search(query, deep?)** 全网搜索：默认免费 DDG；deep=true 升级 Exa 语义搜索(付费 ~$0.007/次)，返回标题 + 摘要 + 链接
- **search_bilibili(keyword)** B 站搜索视频/专栏，无需登录
- **search_github(query)**     搜 GitHub 仓库（star 排序）
- **read_rss(url)**            解析 RSS/Atom 订阅源
- **reach_diagnose()**         联网自检：逐步报告联网在哪一环失败（环境/同源代理/原生直连/跨域直连）
- **reach_cost()**             查询本会话联网工具已消耗（web_search 命中 Exa 的次数与估算花费）

## 使用原则
1. 需要读具体页面内容 → fetch_page
2. 需要找信息但不知道 URL → web_search
3. 国内内容（B 站）→ search_bilibili
4. 找开源项目 → search_github
5. 订阅博客/新闻 → read_rss

## 成本意识（重要）
- **fetch_page / search_bilibili / search_github / read_rss = 免费**（走代理或原生，不计费）。
- **web_search = 默认免费**：默认走 DDG 不花钱；只有显式 deep=true 才走 Exa（约 $0.007/次≈0.05 元）。按需升级，别默认深搜。
- 原则：**已知或能猜到 URL 时优先 fetch_page（免费）**，只有“不知道去哪找”时才用 web_search；勿对同一问题反复搜。
- 你每轮推理本身也按 token 计费，无谓的超长输出 / 反复调用都在烧钱，按需精简。
- 想知道花了多少，调 reach_cost。

## 被墙说明
- 所有工具均通过原生直连 / 内部代理中转，agent 无需感知网络环境
- Bilibili / GitHub 国内直连优先；网页端均走 /api/fetch worker 代理
- 所有外呼均带超时，不会因某个网站无响应而挂死任务
`.trim()

  // ─── 内部工具函数 ─────────────────────────────────────────────────────────────

  // ─── 2026-06-18 真因修复：网页端外呼一律走 /api/fetch worker 代理 ───────────
  // 旧实现里 fetch_page(jinaRead) 与 web_search(jinaSearch/searxng) 直连
  // r.jina.ai / s.jina.ai / searxng，在国内浏览器被 GFW 拦 / 被 CORS 挡 →
  // 每次都要等满 20s 超时才失败 → agent“访问网络一直失败”。
  // 桌面端(Tauri) egress 无 GFW，仍直连；网页端改走同源 worker 代理
  // (Cloudflare 出口无 GFW/CORS，worker.js 的 handleFetchProxy 服务端代发)。
  const IS_DESKTOP = !!(global.__TAURI__ && global.__TAURI__.core && typeof global.__TAURI__.core.invoke === "function")
  // ─── 2026-06-18 联网真修：桌面端改走 Rust 原生 http_request，彻底绕开 webview CORS ──────
  // 根因：旧版 extFetch 桌面分支用 fetchWithTimeout(url) = webview fetch()，
  // 在 Tauri webview 里仍受同源策略约束 → 境外站全灭（Jina/SearXNG/DDG/Bing 均撞 CORS）。
  // 修复：桌面端改走 tryNativeFetch（Rust invoke http_request，无 CORS / GFW），
  // 包装成 Response-like 对象供 jinaRead/multiSourceSearch 等调用方无感使用；
  // 原生失败（invoke 返回 null）自动降级 worker 代理。
  async function nativeFetchResponse(url, init, timeoutMs) {
    const raw = await tryNativeFetch(url, 500000, (init && init.headers) || {})
    if (raw != null) {
      return {
        ok: true, status: 200,
        headers: { get: function () { return null } },
        text: function () { return Promise.resolve(raw) },
        json: function () {
          try { return Promise.resolve(JSON.parse(raw)) }
          catch (e) { return Promise.reject(e) }
        }
      }
    }
    // 原生失败 → 降级 worker 代理（桌面端 worker 通常不存在，会进一步失败并报错，但不会挂死）
    return fetchWithTimeout(PROXY + "?url=" + encodeURIComponent(url), init, timeoutMs)
  }

  function extFetch(url, init, timeoutMs) {
    if (IS_DESKTOP) return nativeFetchResponse(url, init, timeoutMs)
    return fetchWithTimeout(PROXY + "?url=" + encodeURIComponent(url), init, timeoutMs)
  }

  /**
   * 通用 fetch 包装：网页端走代理(无 GFW/CORS)，桌面端直连失败再兜底代理
   * @param {string} url
   * @param {RequestInit} [init]
   * @returns {Promise<Response>}
   */
  async function safeFetch(url, init) {
    // 网页端：直接走代理，避免直连境外站被墙后等满超时
    if (!IS_DESKTOP) {
      return fetchWithTimeout(PROXY + "?url=" + encodeURIComponent(url), init)
    }
    // 桌面端：走 Rust 原生 http_request（无 CORS / GFW），失败降级代理
    const raw = await tryNativeFetch(url, 500000, (init && init.headers) || {})
    if (raw != null) {
      return {
        ok: true, status: 200,
        headers: { get: function () { return null } },
        text: function () { return Promise.resolve(raw) },
        json: function () {
          try { return Promise.resolve(JSON.parse(raw)) }
          catch (e) { return Promise.reject(e) }
        }
      }
    }
    return fetchWithTimeout(PROXY + "?url=" + encodeURIComponent(url), init)
  }





  /**
   * web 搜索：走 worker /api/search（服务端 DDG，Cloudflare 出口，无 GFW / 无 CORS / 无 key）
   * 桌面端走 Rust 原生请求同源 worker；网页端直接同源 fetch。
   * 2026-06-18: 替换原 Jina+SearXNG 四死源方案——根因是所有源被 GFW 拦在客户端侧，
   * 搜索移到 worker 服务端执行才是正确架构（等价 Claude Code 的服务端 WebSearch）。
   */
  const PER_SOURCE_TIMEOUT = 12000
  // 2026-06-20 桌面原生搜索兜底:worker /api/search 走 Cloudflare 出口,DDG 常屏蔽 CF 出口 IP 返回 0 结果。
  // 桌面端可用 Rust 原生(用户自己的住宅 IP,不被 CF 封)直连 DDG html 接口,复用 worker handleSearchProxy 同款解析。
  // 仅桌面端生效(IS_DESKTOP);网页端无原生通道,返回 null 保持原行为。
  async function nativeDdgSearch(query, count) {
    if (!IS_DESKTOP) return null
    const n = Math.max(1, Math.min(10, Number(count) || 5))
    const ddgUrl = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query) + "&kl=cn-zh"
    const html = await tryNativeFetch(ddgUrl, 500000, {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }, true)  // rawHtml=true:要原始 HTML 解析 result__a 结构
    if (!html) return null
    const decodeEnt = function (s) {
      return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').trim()
    }
    const links = []
    const linkRe = /class="result__a"[^>]+href="([^"]*)"/gi
    let lm
    while ((lm = linkRe.exec(html)) !== null && links.length < n) {
      let href = lm[1]
      if (href.indexOf("uddg=") !== -1) {
        try { const u = new URL(href.indexOf("//") === 0 ? "https:" + href : href); const decoded = decodeURIComponent(u.searchParams.get("uddg") || ""); if (decoded) href = decoded } catch (_) {}
      }
      if (href && href.indexOf("http") === 0) links.push(href)
    }
    if (!links.length) return null
    const titles = []
    const titleRe = /class="result__a"[^>]+href="[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
    let tm
    while ((tm = titleRe.exec(html)) !== null && titles.length < n) titles.push(decodeEnt(tm[1]))
    const snippets = []
    const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi
    let sm
    while ((sm = snipRe.exec(html)) !== null) snippets.push(decodeEnt(sm[1]))
    const results = links.map(function (href, i) { return { title: titles[i] || href, url: href, snippet: snippets[i] || "" } })
    return { source: "native-ddg", results: results }
  }
  async function multiSourceSearch(query, count, deep) {
    count = count || 5
    try {
      const apiUrl = "/api/search?q=" + encodeURIComponent(query) + "&n=" + count + (deep ? "&engine=exa" : "")
      const r = await withTimeout(
        fetchWithTimeout(apiUrl, {}, PER_SOURCE_TIMEOUT),
        PER_SOURCE_TIMEOUT, "worker-search"
      )
      if (r.ok) {
        const data = await r.json().catch(function () { return null })
        if (data && data.ok && Array.isArray(data.results) && data.results.length > 0) {
          // worker 返回真实 source(exa / ddg),不再写死——否则 Exa 生效也不计费、显示也错
          return { source: data.source || "worker-ddg", results: data.results }
        }
      }
    } catch (_) {}
    // 桌面端兜底:worker 搜索无结果(多为 DDG 屏蔽 CF 出口 IP)时,改用 Rust 原生直连 DDG(走住宅 IP,不被封)
    try {
      const native = await nativeDdgSearch(query, count)
      if (native && native.results && native.results.length > 0) return native
    } catch (_) {}
    return null
  }

  // ─── 联网自检：逐通道探测，精确定位“访问失败”卡在哪一步 ──────────────────────────
  // 2026-06-19 重写：旧版只拿单个 B 站接口当探针，B 站反爬失败 → 被“先入为主”判成无网络(误报)。
  //   ① 多目标探针：任一成功即判“网络可达”，不被单站反爬带偏
  //   ② 用 /api/search 的 JSON 契约判定 worker API 路由是否部署(不再靠“是不是 HTML”瞎猜——真实网页本就是 HTML)
  //   ③ 新增 web_search(/api/search→DDG) 独立通道，区分“路由缺失 / DDG 限流空结果 / 正常”
  //   ④ 明确区分“目标站反爬”与“真无网络”
  // 六通道相互独立、如实报告：1 环境  2 同源 API 路由部署  3 web_search 通道  4 fetch_page 代理通道  5 桌面原生直连  6 浏览器跨域直连
  async function diagnoseNetwork(testUrl) {
    const out = []
    const ms = function (t0) { return (Date.now() - t0) + "ms" }
    // 多目标探针：任一成功即判“网络可达”，避免单站反爬(如 B 站)被误判成无网络
    const PROBES = (typeof testUrl === "string" && testUrl.trim())
      ? [testUrl.trim()]
      : ["https://www.baidu.com/", "https://example.com/", "https://api.bilibili.com/x/web-interface/zone"]
    // 路由缺失时静态兜底会回站点 SPA 首页；用这个判据识别“拿到的是我们自己的首页壳”而非目标内容
    function looksLikeAppShell(body) {
      if (typeof body !== "string" || !body) return false
      const head = body.slice(0, 800).toLowerCase()
      const isHtml = head.indexOf("<!doctype html") !== -1 || head.indexOf("<html") !== -1
      return isHtml && (head.indexOf("/js/engine/app.js") !== -1 || head.indexOf("id=\"app\"") !== -1 || head.indexOf("id='app'") !== -1)
    }
    let networkReachable = false  // 任一通道任一目标取回真实内容 → 置真
    let apiRoutesDeployed = null  // /api/search 契约判定：true=已部署 false=未部署 null=未知

    // 1. 运行环境
    out.push("【1. 运行环境】")
    out.push("  IS_DESKTOP = " + IS_DESKTOP + "(true=桌面 Tauri / false=网页)")
    out.push("  PROXY      = " + PROXY)
    out.push("  origin     = " + (global.location ? global.location.origin : "(无 location)"))
    out.push("  navigator.onLine = " + (global.navigator ? global.navigator.onLine : "(未知)"))
    out.push("  hasTauriInvoke   = " + !!(global.__TAURI__ && global.__TAURI__.core && typeof global.__TAURI__.core.invoke === "function"))
    out.push("  当前时间   = " + new Date().toISOString())

    // 2. 同源 API 路由是否部署 —— 用 /api/search 的 JSON 契约判定(命中 handleSearchProxy 才回 JSON；路由缺失则静态兜底回 SPA 首页)
    out.push("【2. 同源 API 路由部署 (/api/search 契约)】")
    let searchData = null
    try {
      const t0 = Date.now()
      const r = await fetchWithTimeout("/api/search?q=" + encodeURIComponent("connectivity diag ping"), {}, 12000)
      const body = await r.text()
      let json = null
      try { json = JSON.parse(body) } catch (_) {}
      if (json && typeof json.ok === "boolean") {
        apiRoutesDeployed = true
        searchData = json
        out.push("  ✅ HTTP " + r.status + "(" + ms(t0) + ") 返回合法 JSON → worker API 路由【已部署】")
      } else {
        apiRoutesDeployed = false
        out.push("  ❌ HTTP " + r.status + "(" + ms(t0) + ") 返回非 JSON" + (looksLikeAppShell(body) ? "(是本站 SPA 首页)" : "") + " → /api/search 路由【未部署】")
        out.push("     线上 worker 是旧部署，未含 handleSearchProxy/handleFetchProxy → 网页端联网工具不可用，需 push worker.js 后重新部署")
      }
    } catch (e) {
      out.push("  ❌ 失败：" + (e && e.name) + " " + (e && e.message))
    }

    // 3. web_search 通道(/api/search → 服务端 DDG)：区分“路由缺失 / DDG 限流空结果 / 正常”
    out.push("【3. web_search 通道 (/api/search → 默认 DDG / deep=exa 升级)】")
    if (apiRoutesDeployed === false) {
      out.push("  ⏭ 跳过：API 路由未部署(见第 2 步)")
    } else if (searchData) {
      if (searchData.ok && Array.isArray(searchData.results) && searchData.results.length > 0) {
        networkReachable = true
        const src = searchData.source || "?"
        out.push("  ✅ web_search 可用，取回 " + searchData.results.length + " 条结果(source=" + src + ")")
        out.push("     ℹ️ 默认走免费 DDG 即可(本自检不带 deep);需要 Exa 深搜时 web_search 带 deep=true 触发(前提:worker 已配 EXA_API_KEY)")
      } else if (searchData.ok) {
        out.push("  ⚠️ DDG 返回 0 条(source=" + (searchData.source || "?") + ") —— DuckDuckGo 屏蔽了 Cloudflare 出口 IP 返回空(非本地网络问题)")
        out.push("     修法：① web_search 带 deep=true 走 Exa(需 worker 已配 EXA_API_KEY,直接有结果)  ② 或改用 fetch_page 平替(桌面端会自动降级原生 DDG)")
      } else {
        out.push("  ⚠️ DDG 上游报错：" + (searchData.error || "未知") + " —— 多为 DDG 屏蔽 CF 出口")
      }
    } else {
      out.push("  (第 2 步未取得有效响应，无法判定)")
    }

    // 4. fetch_page 代理通道(/api/fetch)：多目标，任一取回真实内容即判可用
    out.push("【4. fetch_page 代理通道 (" + PROXY + ")】")
    let fetchOk = false
    for (const probe of PROBES) {
      try {
        const t0 = Date.now()
        const r = await fetchWithTimeout(PROXY + "?url=" + encodeURIComponent(probe), {}, 10000)
        const body = await r.text()
        if (looksLikeAppShell(body)) {
          out.push("  • " + probe + " → ⚠️ 返回本站首页壳(路由缺失，" + ms(t0) + ")")
        } else if (r.status >= 200 && r.status < 400 && body && body.trim().length > 150) {
          fetchOk = true; networkReachable = true
          out.push("  • " + probe + " → ✅ HTTP " + r.status + " 取回 " + body.length + " 字(" + ms(t0) + ")")
          break
        } else {
          out.push("  • " + probe + " → ⚠️ HTTP " + r.status + " 内容过短/被目标站拒(" + ms(t0) + "，疑似反爬)")
        }
      } catch (e) {
        out.push("  • " + probe + " → ❌ " + (e && e.name) + " " + (e && e.message))
      }
    }
    if (!fetchOk && apiRoutesDeployed !== false) out.push("  ⚠️ 所有目标均未取回真实内容——若部分站是反爬(B 站等)属正常，只要有一个 ✅ 即视为联网正常")

    // 5. 桌面原生直连
    out.push("【5. 桌面原生直连 http_request】")
    if (!IS_DESKTOP) {
      out.push("  ⏭ 跳过(当前非桌面端)")
    } else {
      for (const probe of PROBES) {
        try {
          const t0 = Date.now()
          const txt = await tryNativeFetch(probe, 500)
          if (txt != null && txt.trim()) { networkReachable = true; out.push("  • " + probe + " → ✅ 成功(" + ms(t0) + ")取回 " + txt.length + " 字"); break }
          else out.push("  • " + probe + " → ❌ 空/失败(" + ms(t0) + ")")
        } catch (e) { out.push("  • " + probe + " → ❌ " + (e && e.message)) }
      }
    }

    // 6. 浏览器跨域直连(不走代理，仅供参考——失败多为 CORS，与是否被墙无关)
    out.push("【6. 浏览器跨域直连(无代理，仅参考)】")
    for (const probe of PROBES) {
      try {
        const t0 = Date.now()
        const r = await fetchWithTimeout(probe, { mode: "no-cors" }, 8000)
        out.push("  • " + probe + " → HTTP " + (r.status || "opaque") + "(" + ms(t0) + ")")
      } catch (e) {
        const why = (e && e.name === "AbortError") ? "超时(疑似丢包)" : "多为 CORS 拦截(与被墙无关)"
        out.push("  • " + probe + " → ❌ " + (e && e.name) + " — " + why)
      }
    }

    // 结论：综合判定，不被单站反爬带偏
    out.push("【结论】")
    if (apiRoutesDeployed === false) {
      out.push("  ✗ 线上 worker 未部署 /api/* 路由 → 网页端联网工具不可用，需 push worker.js 后重新部署。")
    } else {
      out.push("  " + (networkReachable ? "✓ 网络可达：至少一个通道/目标取回了真实内容(单站如 B 站失败多为该站反爬，非无网络)。" : "✗ 所有通道均未取回真实内容，疑似确实无网络或全部目标被拦。"))
      if (apiRoutesDeployed) out.push("  · API 路由已部署；web_search 默认走免费 DDG，若 0 结果(DDG 屏蔽 CF 出口)可带 deep=true 走 Exa(需配 EXA_API_KEY)或用 fetch_page 平替。")
    }
    return out.join("\n")
  }

  // ─── 工具注册 ─────────────────────────────────────────────────────────────────

  function defineTools(registry) {
    if (!registry || typeof registry.define !== "function") {
      throw new Error("[agent-reach] 需要传入有效的 ToolRegistry（来自 agent-kernel.js）")
    }

    // ── fetch_page ──────────────────────────────────────────────────────────────
    registry.define({
      name: "fetch_page",
      description:
        "读取任意网页的文本内容。本站自己的地址（含 \"/\" 开头的相对路径，如 /js/text/engine/app.js）走**同源直读**（页面直接读，不经代理，读自己部署的前端源码就用这个）；" +
        "其余地址桌面端优先 Rust 原生直连，网页端/失败时走 /api/fetch worker 代理（绕过 GFW 和 CORS）。" +
        "适合：读文章、文档、GitHub README、B 站专栏、本站自己的源码文件等。均带超时，不会挂死。",
      parameters: {
        type: "object",
        properties: {
          url:       { type: "string",  description: "要读取的网页 URL" },
          max_chars: { type: "integer", description: "本次最多返回字符数，默认 8000" },
          offset:    { type: "integer", description: "从第几个字符开始返回（默认 0）。大页面/大源码分次读：结果里的 nextOffset 直接传回来即可续读" },
        },
        required: ["url"],
        additionalProperties: false,
      },
      async run(args) {
        const url = args && typeof args.url === "string" ? args.url.trim() : ""
        if (!url) return { ok: false, error: "url 不能为空" }
        const maxChars = Math.max(500, Math.min(40000, Number(args.max_chars) || 8000))
        // 2026-10-08 续读：大页面/大源码不再只看头（旧版只有 max_chars，中段永远读不到）。
        // offset 是字符偏移；统一在**拿到全文之后**切片（三条路径共用同一口径）。
        const offset = Math.max(0, Math.min(5 * 1024 * 1024, Number(args.offset) || 0))
        const page = (t) => {
          const s = String(t == null ? "" : t)
          const total = s.length
          const from = Math.min(offset, total)
          const slice = s.slice(from, from + maxChars)
          return { text: slice, totalChars: total, fromOffset: from, nextOffset: from + slice.length, truncated: from + slice.length < total }
        }
        // ① 同源地址：页面自己直读，不走任何代理也不出网 ——
        // 2026-10-07 修复「自己抓自己」死局：worker 的 /api/fetch 去抓本站 = worker 子请求自身，
        // Cloudflare 直接掐断（实测外部跳板也会识破 Worker 出口，全军覆没）。
        // 同源相对路径（"/js/..."）就是读自己部署的前端源码的正道；本站绝对 URL 折算成相对路径再读。
        const _origin = (typeof location !== "undefined" && location.origin) ? location.origin : ""
        const _isSameOrigin = url.charAt(0) === "/" ||
          (!!_origin && (url === _origin || url.indexOf(_origin + "/") === 0))
        if (_isSameOrigin) {
          const _rel = url.charAt(0) === "/" ? url : (url.slice(_origin.length) || "/")
          try {
            const _sr = await fetchWithTimeout(_rel, {}, DEFAULT_TIMEOUT_MS)
            if (!_sr.ok) return { ok: false, url: url, error: "同源读取失败：HTTP " + _sr.status + "（" + _rel + "）" }
            const _sraw = await _sr.text()
            const _sct = (_sr.headers && _sr.headers.get && _sr.headers.get("content-type")) || ""
            const _stxt = (/text\/html/i.test(_sct) || /^\s*</.test(_sraw)) ? htmlToText(_sraw) : _sraw
            if (!_stxt || !_stxt.trim()) return { ok: false, url: url, error: "同源读取为空：" + _rel }
            // 同源直读不做「代理那套 150 字门槛」：JS/CSS 这类短文件也要原样返回
            return Object.assign({ ok: true, source: "same-origin", url: _rel }, page(_stxt))
          } catch (e) {
            return { ok: false, url: url, error: "同源读取异常：" + (e && e.message ? e.message : String(e)) }
          }
        }
        // ② 桌面端：Rust 原生直连（无 GFW / CORS）。要多取 offset 之后的正文，所以按 offset+maxChars 要
        const nativeFirst = await tryNativeFetch(url, maxChars + offset)
        if (nativeFirst != null && nativeFirst.trim()) {
          return Object.assign({ ok: true, source: "native", url: url }, page(nativeFirst))
        }
        // ③ /api/fetch worker 代理（同源 Cloudflare 出口，无 GFW/CORS；与 web_search 同路径）
        try {
          const _pr = await fetchWithTimeout(PROXY + "?url=" + encodeURIComponent(url), {}, DEFAULT_TIMEOUT_MS)
          if (_pr.ok) {
            const _raw = await _pr.text()
            const _ct = (_pr.headers && _pr.headers.get && _pr.headers.get("content-type")) || ""
            // 若代理路由不存在则返回 SPA 首页(纯 script 壳，htmlToText 后极短) → 跳过降级 Jina
            const _txt = (/text\/html/i.test(_ct) || /^\s*</.test(_raw)) ? htmlToText(_raw) : _raw
            if (_txt && _txt.trim().length > 150) {
              return Object.assign({ ok: true, source: "proxy", url: url }, page(_txt))
            }
          }
        } catch (_) {}
        return { ok: false, url: url, error: "fetch_page 失败：原生直连不可用（非桌面端），/api/fetch 代理无有效内容" }
      },
    })

    // ── web_search ──────────────────────────────────────────────────────────────
    registry.define({
      name: "web_search",
      description:
        "全网搜索，返回标题 + 摘要 + 链接列表。" +
        "默认走免费 DDG（够用、零成本）；仅当设 deep=true 时才升级到 Exa 语义搜索（付费约 $0.007/次≈0.05 元）。桌面端 DDG 无结果会自动降级原生直连。" +
        "成本提示：先用默认免费搜索，只有结果不够准/不够全时再带 deep=true；已知具体 URL 时优先用免费的 fetch_page，勿对同一问题反复搜。" +
        "适合：找最新资讯、学术资料、技术文档、产品信息等。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string",  description: "搜索关键词或问题" },
          count: { type: "integer", description: "返回结果数，默认 5，最多 10" },
          deep:  { type: "boolean", description: "是否升级到 Exa 深度语义搜索（付费约 $0.007/次≈0.05 元）。默认 false 走免费 DDG；仅当普通搜索结果不够准/不够全时才设 true。" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      async run(args) {
        const q = args && typeof args.query === "string" ? args.query.trim() : ""
        if (!q) return { ok: false, error: "query 不能为空" }
        const count = Math.max(1, Math.min(10, Number(args.count) || 5))
        const deep = args && args.deep === true

        const found = await multiSourceSearch(q, count, deep)
        if (found && found.results && found.results.length > 0) {
          const billable = found.source === "exa"
          if (billable) bumpReachCost(EXA_COST_PER_SEARCH)
          const cost = billable
            ? { usd: EXA_COST_PER_SEARCH, note: "Exa 付费搜索 ≈$" + EXA_COST_PER_SEARCH + "（≈0.05 元）" }
            : { usd: 0, note: "免费（" + found.source + "）" }
          return { ok: true, source: found.source, query: q, results: found.results, cost: cost, session_cost: reachCostSummary() }
        }
        return { ok: false, error: "所有搜索源均无结果，请稍后重试或换一个关键词", cost: { usd: 0, note: "无结果未计费" } }
      },
    })

    // ── search_bilibili ─────────────────────────────────────────────────────────
    registry.define({
      name: "search_bilibili",
      description:
        "搜索 B 站视频、专栏、UP 主等内容。无需登录，国内直连。" +
        "适合：找教程视频、UP 主内容、B 站热门话题等。",
      parameters: {
        type: "object",
        properties: {
          keyword:     { type: "string",  description: "搜索关键词" },
          search_type: {
            type: "string",
            enum: ["video", "article", "bili_user"],
            description: "搜索类型：video=视频（默认），article=专栏，bili_user=UP 主",
          },
          count: { type: "integer", description: "返回数量，默认 5，最多 20" },
        },
        required: ["keyword"],
        additionalProperties: false,
      },
      async run(args) {
        const kw = args && typeof args.keyword === "string" ? args.keyword.trim() : ""
        if (!kw) return { ok: false, error: "keyword 不能为空" }
        const stype = args.search_type || "video"
        const count = Math.max(1, Math.min(20, Number(args.count) || 5))

        const params = new URLSearchParams({
          keyword:     kw,
          search_type: stype,
          page:        "1",
          page_size:   String(count),
        })
        const url = BILI_API + "?" + params.toString()

        const _biliHeaders = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'Referer': 'https://www.bilibili.com',
          'Origin': 'https://www.bilibili.com',
        }
        try {
          const r = await safeFetch(url, { headers: _biliHeaders })
          if (!r.ok) throw new Error("B 站 API 返回 " + r.status)
          const json = await r.json()
          const list = (json && json.data && json.data.result) || []
          const results = list.slice(0, count).map(function (item) {
            return {
              title:  (item.title  || item.uname || "").replace(/<[^>]+>/g, ""),
              bvid:   item.bvid   || "",
              author: item.author || item.uname || "",
              desc:   (item.description || item.uploader_desc || "").slice(0, 200),
              url:    item.arcurl || (item.bvid ? "https://www.bilibili.com/video/" + item.bvid : ""),
              play:   item.play   || 0,
              pubdate: item.pubdate || 0,
            }
          })
          return { ok: true, keyword: kw, search_type: stype, results }
        } catch (e) {
          return { ok: false, error: "B 站搜索失败: " + String(e && e.message ? e.message : e) }
        }
      },
    })

    // ── search_github ───────────────────────────────────────────────────────────
    registry.define({
      name: "search_github",
      description:
        "搜索 GitHub 仓库，按 star 数排序。适合：找开源项目、工具、框架等。" +
        "返回仓库名、描述、star 数、主要语言、URL。",
      parameters: {
        type: "object",
        properties: {
          query:    { type: "string",  description: "搜索词，支持 GitHub 高级语法如 language:python」" },
          count:    { type: "integer", description: "返回数量，默认 5，最多 10" },
          sort:     {
            type: "string",
            enum: ["stars", "updated", "forks"],
            description: "排序方式，默认 stars",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      async run(args) {
        const q = args && typeof args.query === "string" ? args.query.trim() : ""
        if (!q) return { ok: false, error: "query 不能为空" }
        const count = Math.max(1, Math.min(10, Number(args.count) || 5))
        const sort  = args.sort || "stars"

        const params = new URLSearchParams({
          q,
          sort,
          order: "desc",
          per_page: String(count),
        })
        const url = GH_API + "/repositories?" + params.toString()

        try {
          const r = await safeFetch(url, {
            headers: { "Accept": "application/vnd.github+json" },
          })
          if (!r.ok) throw new Error("GitHub API " + r.status)
          const data = await r.json()
          const items = Array.isArray(data && data.items) ? data.items : []
          const results = items.slice(0, count).map(function (repo) {
            return {
              full_name:   repo.full_name   || "",
              description: (repo.description || "").slice(0, 200),
              stars:       repo.stargazers_count || 0,
              language:    repo.language    || "",
              url:         repo.html_url    || "",
              updated:     repo.pushed_at  || "",
            }
          })
          return { ok: true, query: q, sort, results }
        } catch (e) {
          return { ok: false, error: "GitHub 搜索失败: " + String(e && e.message ? e.message : e) }
        }
      },
    })

    // ── read_rss ────────────────────────────────────────────────────────────────
    registry.define({
      name: "read_rss",
      description:
        "解析 RSS/Atom 订阅源，返回最新文章列表（标题、链接、摘要、发布时间）。",
      parameters: {
        type: "object",
        properties: {
          url:   { type: "string",  description: "RSS/Atom 订阅链接" },
          count: { type: "integer", description: "返回条数，默认 5，最多 20" },
        },
        required: ["url"],
        additionalProperties: false,
      },
      async run(args) {
        const url = args && typeof args.url === "string" ? args.url.trim() : ""
        if (!url) return { ok: false, error: "url 不能为空" }
        const count = Math.max(1, Math.min(20, Number(args.count) || 5))

        try {
          // 走原生/代理请求原始 XML(带超时)；失败由外层 catch 统一处理
          let xml = ""
          const r = await safeFetch(url, { headers: { "Accept": "application/rss+xml, application/xml, text/xml" } })
          xml = await r.text()

          // 简单 XML 解析（不依赖 DOM，兼容 Worker 环境）
          const items = []
          const itemRegex = /<item[^>]*>([\/\s\S]*?)<\/item>|<entry[^>]*>([\s\S]*?)<\/entry>/gi
          let m
          while ((m = itemRegex.exec(xml)) !== null && items.length < count) {
            const block = m[1] || m[2] || ""
            const get = function (tag) {
              const r = new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)<\/" + tag + ">", "i")
              const found = block.match(r)
              return found ? found[1].replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').trim() : ""
            }
            items.push({
              title:   get("title"),
              link:    get("link") || get("id"),
              summary: get("summary") || get("description") || get("content"),
              pubdate: get("pubDate") || get("published") || get("updated"),
            })
          }

          return { ok: true, url, count: items.length, items }
        } catch (e) {
          return { ok: false, url, error: "RSS 解析失败: " + String(e && e.message ? e.message : e) }
        }
      },
    })

    // ── reach_cost ────────────────────────────────────────────────────────────────
    // 让 agent 对联网消耗有概念：统计 web_search 命中 Exa 的累计花费(本地持久化)。
    registry.define({
      name: "reach_cost",
      description:
        "查询本设备累计的联网付费消耗：web_search 命中 Exa 的次数与估算花费（USD / 人民币）。" +
        "fetch_page、search_bilibili、search_github、read_rss 均免费、不计入。只读、无副作用、不花钱。" +
        "用户问『联网花了多少钱 / 还剩多少额度』时调用。注意：仅统计搜索 API 费用，不含模型对话 token 费。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async run() {
        const s = reachCostSummary()
        return {
          ok: true,
          web_search_exa_calls: s.searches,
          spent_usd: s.usd,
          spent_rmb_est: s.rmb,
          note: "仅 web_search 经 Exa 的费用（每次≈$" + EXA_COST_PER_SEARCH + "）；其余联网工具免费。模型对话 token 费不在此统计内。",
        }
      },
    })

    // ── reach_diagnose ──────────────────────────────────────────────────────────
    // 用户反馈“访问从未成功”时的首选自检：跑一次，逐步报告卡在哪一环。
    registry.define({
      name: "reach_diagnose",
      description:
        "联网自检工具：依次探测【运行环境 / 同源 API 路由部署 / web_search(Exa/DDG) 通道 / fetch_page 代理通道 / 桌面原生直连 / 浏览器跨域直连】" +
        "六个通道，多目标探针(任一成功即判网络可达，不被 B 站等单站反爬带偏)，逐步报告每一步是否成功及失败原因，" +
        "用于定位『联网访问失败 / 从未成功』的确切故障点。只读、无副作用。" +
        "当用户反馈联网工具用不了时，应优先调用本工具自检，再据结果说明问题。",
      parameters: {
        type: "object",
        properties: {
          test_url: { type: "string", description: "用于探测的目标 URL，默认多目标(百度 / example.com / B 站)" },
        },
        additionalProperties: false,
      },
      async run(args) {
        const url = args && typeof args.test_url === "string" ? args.test_url : ""
        try {
          const report = await diagnoseNetwork(url)
          return { ok: true, report: report }
        } catch (e) {
          return { ok: false, error: String(e && e.message ? e.message : e) }
        }
      },
    })

    return registry
  }

  // ─── 公开 API ─────────────────────────────────────────────────────────────────
  global.AgentReach = {
    defineTools,
    SKILL: AGENT_REACH_SKILL,
    // 配置代理端点（网页侧如有自定义 worker 路由可覆盖）
    setProxy: function (endpoint) { global.__agentReachProxy = endpoint },
    // 控制台手动自检：AgentReach.diagnose().then(console.log)
    diagnose: function (url) { return diagnoseNetwork(url) },
  }

})(typeof globalThis !== "undefined" ? globalThis : window)