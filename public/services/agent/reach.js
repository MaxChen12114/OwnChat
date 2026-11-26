(function () {
/**
 * services/agent/reach.ts — 联网能力层里**不碰网络**的那一半。
 *
 * 原 `public/shared/agent/agent-reach.js`（775 行）里，真正需要判断的是这些东西：
 *   · HTML → 纯文本（原生抓取拿到的是原始 HTML，没有 Jina 的 markdown 清洗）
 *   · 大页面续读的分页口径（offset 切片，三条抓取路径共用同一口径）
 *   · DDG html 结果的三段解析（链接 / 标题 / 摘要分别扫，再按序 zip）
 *   · B 站 / GitHub 的字段映射（各家字段名不同，模型只认统一形状）
 *   · RSS/Atom 的极简 XML 解析（不依赖 DOM）
 *   · Exa 计费账本（只有 exa 计费，其余免费）
 *   · 六通道自检的报告与结论（不被单站反爬带偏）
 *
 * 网络本身（fetch / Tauri invoke / 代理端点）全部走端口注入，所以这些判断可以在 Node 里测。
 */

/** One slice of a long page, with enough bookkeeping for the model to resume. */
                            
               
                     
                     
                     
                     
 

/** A single search hit, shape shared by every source. */
                            
                
              
                  
 

/** Cumulative Exa spend, persisted per device. */
                            
              
                   
 

/** One response, flattened: the service never touches a `Response` object. */
                               
              
                 
               
                      
 

                           
                                                                                    
                     
                                                                       
                
                                                             
                                                                                  
                                                                                         
                                                                                                                          
                
                   
                    
                       
                                                                                              
 

                           
                                                                                                      
                                    
                                                                                                
                                                                        
                                                                                                 
                                            
                                                        
                                    
                                                                                    
                                                         
                                                
                                
                             
                                                                      
                                                                                             
                                                                          
                                      
                                                                
                                       
                                                                            
                                                                           
                                                                 
                                                                              
                        
                                                                      
                                   
                                                       
                                                                
                                                                 
                                                                                  
                                                         
                    
                                                                                                  
                                              
 

/** Shallow entry copy — also drops non-enumerable props, which is why errors need `errProp`. */
function recOf(value         )                          {
  const out                          = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) out[k] = v;
  }
  return out;
}

function arrOf(value         )            {
  return Array.isArray(value) ? value : [];
}

function text(value         )         {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function num(value         )         {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Exa Search ≈ $7 / 1k calls. */
const EXA_COST_PER_SEARCH = 0.007;
const REACH_COST_KEY = "cfw_reach_cost_v1";
const DEFAULT_TIMEOUT_MS = 20000;
const PROXY_READ_LIMIT = 500000;
/** The proxy route returns our SPA shell when it is not deployed; anything shorter is not content. */
const PROXY_MIN_CONTENT = 150;

function createReach(env          )           {
  function htmlToText(html         )         {
    if (typeof html !== "string") return "";
    let t = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<\/(p|div|li|tr|h[1-6]|br)>/gi, "\n")
      .replace(/<[^>]+>/g, " ");
    t = t
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    return t.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }

  /**
   * All three fetch paths slice **after** they have the full text, so the offsets mean the same thing
   * whether the body came from the native shell, the proxy, or a same-origin read.
   */
  function pageSlice(raw         , maxChars        , offset        )            {
    const s = text(raw);
    const total = s.length;
    const from = Math.min(Math.max(0, offset), total);
    const slice = s.slice(from, from + maxChars);
    return {
      text: slice,
      totalChars: total,
      fromOffset: from,
      nextOffset: from + slice.length,
      truncated: from + slice.length < total,
    };
  }

  /**
   * When the proxy route is missing, the host's static fallback answers with our own SPA shell — a
   * page of `<script>` tags. Recognising it is what separates "route not deployed" from "target down".
   */
  function looksLikeAppShell(body         )          {
    if (typeof body !== "string" || !body) return false;
    const head = body.slice(0, 800).toLowerCase();
    const isHtml = head.indexOf("<!doctype html") !== -1 || head.indexOf("<html") !== -1;
    return (
      isHtml &&
      (head.indexOf("/js/engine/app.js") !== -1 || head.indexOf('id="app"') !== -1 || head.indexOf("id='app'") !== -1)
    );
  }

  function decodeEntities(s        )         {
    return s
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .trim();
  }

  function ddgUrl(query        )         {
    return "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query) + "&kl=cn-zh";
  }

  /**
   * DDG's html endpoint is scanned three times — links, then titles, then snippets — and the three
   * arrays are zipped by index. Titles and snippets are optional; a missing one falls back to the URL
   * (title) or empty string (snippet), which keeps the hit count equal to the link count.
   */
  function parseDdgHtml(html        , count        )              {
    const links           = [];
    const linkRe = /class="result__a"[^>]+href="([^"]*)"/gi;
    let lm = linkRe.exec(html);
    while (lm !== null && links.length < count) {
      let href = lm[1];
      // DDG wraps outbound links as /l/?uddg=<encoded>; the real target is inside.
      if (href.indexOf("uddg=") !== -1) {
        try {
          const u = new URL(href.indexOf("//") === 0 ? "https:" + href : href);
          const decoded = decodeURIComponent(u.searchParams.get("uddg") || "");
          if (decoded) href = decoded;
        } catch (e) {
          /* keep the wrapped href */
        }
      }
      if (href && href.indexOf("http") === 0) links.push(href);
      lm = linkRe.exec(html);
    }
    if (!links.length) return [];

    const titles           = [];
    const titleRe = /class="result__a"[^>]+href="[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    let tm = titleRe.exec(html);
    while (tm !== null && titles.length < count) {
      titles.push(decodeEntities(tm[1]));
      tm = titleRe.exec(html);
    }

    const snippets           = [];
    const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    let sm = snipRe.exec(html);
    while (sm !== null) {
      snippets.push(decodeEntities(sm[1]));
      sm = snipRe.exec(html);
    }

    return links.map(function (href, i) {
      return { title: titles[i] || href, url: href, snippet: snippets[i] || "" };
    });
  }

  function biliUrl(keyword        , searchType        , count        )         {
    const params = new URLSearchParams({
      keyword: keyword,
      search_type: searchType,
      page: "1",
      page_size: String(count),
    });
    return "https://api.bilibili.com/x/web-interface/search/type?" + params.toString();
  }

  /** Bilibili wraps matched terms in `<em>` inside titles; the model should see clean text. */
  function biliResults(payload         , count        )                            {
    const data = recOf(recOf(payload).data);
    return arrOf(data.result)
      .slice(0, count)
      .map(function (raw) {
        const item = recOf(raw);
        const bvid = text(item.bvid);
        return {
          title: text(item.title || item.uname).replace(/<[^>]+>/g, ""),
          bvid: bvid,
          author: text(item.author || item.uname),
          desc: text(item.description || item.uploader_desc).slice(0, 200),
          url: text(item.arcurl) || (bvid ? "https://www.bilibili.com/video/" + bvid : ""),
          play: num(item.play),
          pubdate: num(item.pubdate),
        };
      });
  }

  function githubUrl(query        , sort        , count        )         {
    const params = new URLSearchParams({ q: query, sort: sort, order: "desc", per_page: String(count) });
    return "https://api.github.com/search/repositories?" + params.toString();
  }

  function githubResults(payload         , count        )                            {
    return arrOf(recOf(payload).items)
      .slice(0, count)
      .map(function (raw) {
        const repo = recOf(raw);
        return {
          full_name: text(repo.full_name),
          description: text(repo.description).slice(0, 200),
          stars: num(repo.stargazers_count),
          language: text(repo.language),
          url: text(repo.html_url),
          updated: text(repo.pushed_at),
        };
      });
  }

  /**
   * Minimal RSS/Atom parse. Deliberately not a DOM parser — the same code has to run in a Worker.
   * `<item>` and `<entry>` are both accepted; the tag lookups are case-insensitive.
   */
  function parseRss(xml        , count        )                           {
    const items                           = [];
    const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>|<entry[^>]*>([\s\S]*?)<\/entry>/gi;
    let m = itemRegex.exec(xml);
    while (m !== null && items.length < count) {
      const block = m[1] || m[2] || "";
      const get = function (tag        )         {
        const r = new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">", "i");
        const found = block.match(r);
        if (!found) return "";
        return found[1]
          .replace(/<[^>]+>/g, "")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&amp;/g, "&")
          .replace(/&quot;/g, '"')
          .trim();
      };
      items.push({
        title: get("title"),
        link: get("link") || get("id"),
        summary: get("summary") || get("description") || get("content"),
        pubdate: get("pubDate") || get("published") || get("updated"),
      });
      m = itemRegex.exec(xml);
    }
    return items;
  }

  function readCost()            {
    try {
      const raw = env.storage.getItem(REACH_COST_KEY);
      const o = raw ? recOf(JSON.parse(raw)) : {};
      if (typeof o.usd === "number") return { usd: o.usd, searches: num(o.searches) };
    } catch (e) {
      /* unreadable ledger counts as zero */
    }
    return { usd: 0, searches: 0 };
  }

  function bumpCost(usd        )            {
    const c = readCost();
    // Round at 1e-6 so repeated 0.007 additions do not drift into 0.021000000000000001.
    const next            = {
      usd: Math.round((c.usd + (Number(usd) || 0)) * 1e6) / 1e6,
      searches: (c.searches || 0) + 1,
    };
    try {
      env.storage.setItem(REACH_COST_KEY, JSON.stringify(next));
    } catch (e) {
      /* storage full: the in-memory number still moves for this session */
    }
    return next;
  }

  function costSummary()                                                 {
    const c = readCost();
    return { usd: c.usd, rmb: Math.round(c.usd * 7.2 * 100) / 100, searches: c.searches || 0 };
  }

  /** Only Exa bills. Everything else is free, and the note has to say so or the model over-avoids it. */
  function costForSource(source        )                                                   {
    if (source === "exa") {
      return { billable: true, usd: EXA_COST_PER_SEARCH, note: "Exa 付费搜索 ≈$" + EXA_COST_PER_SEARCH + "（≈0.05 元）" };
    }
    return { billable: false, usd: 0, note: "免费（" + source + "）" };
  }

  function exaCost()         {
    return EXA_COST_PER_SEARCH;
  }

  /**
   * Six independent channels, reported as they are.
   *
   * The 2026-06-19 rewrite replaced a single Bilibili probe, which had made a site-level anti-bot
   * challenge look like "no network at all". Two rules follow from that and must not be undone:
   *   · any single probe returning real content means the network is reachable;
   *   · whether `/api/*` is deployed is judged by the **JSON contract**, not by "is this HTML" —
   *     a real web page is HTML too.
   */
  async function diagnose(testUrl         )                  {
    const out           = [];
    const elapsed = function (t0        )         {
      return env.now() - t0 + "ms";
    };
    const explicit = typeof testUrl === "string" ? testUrl.trim() : "";
    const probes = explicit
      ? [explicit]
      : ["https://www.baidu.com/", "https://example.com/", "https://api.bilibili.com/x/web-interface/zone"];

    let networkReachable = false;
    let apiRoutesDeployed                 = null;

    out.push("【1. 运行环境】");
    out.push("  IS_DESKTOP = " + env.isDesktop + "(true=桌面 Tauri / false=网页)");
    out.push("  PROXY      = " + env.proxy);
    out.push("  origin     = " + (env.origin() || "(无 location)"));
    out.push("  navigator.onLine = " + (env.onLine() === undefined ? "(未知)" : String(env.onLine())));
    out.push("  hasTauriInvoke   = " + env.hasInvoke());
    out.push("  当前时间   = " + new Date(env.now()).toISOString());

    out.push("【2. 同源 API 路由部署 (/api/search 契约)】");
    let searchData                                 = null;
    try {
      const t0 = env.now();
      const r = await env.fetchText("/api/search?q=" + encodeURIComponent("connectivity diag ping"), {}, 12000);
      let json                                 = null;
      try {
        json = recOf(JSON.parse(r.body));
      } catch (e) {
        json = null;
      }
      if (json && typeof json.ok === "boolean") {
        apiRoutesDeployed = true;
        searchData = json;
        out.push("  ✅ HTTP " + r.status + "(" + elapsed(t0) + ") 返回合法 JSON → worker API 路由【已部署】");
      } else {
        apiRoutesDeployed = false;
        out.push(
          "  ❌ HTTP " +
            r.status +
            "(" +
            elapsed(t0) +
            ") 返回非 JSON" +
            (looksLikeAppShell(r.body) ? "(是本站 SPA 首页)" : "") +
            " → /api/search 路由【未部署】",
        );
        out.push("     线上 worker 是旧部署，未含 handleSearchProxy/handleFetchProxy → 网页端联网工具不可用，需 push worker.js 后重新部署");
      }
    } catch (e) {
      out.push("  ❌ 失败：" + errName(e) + " " + errMessage(e));
    }

    out.push("【3. web_search 通道 (/api/search → 默认 DDG / deep=exa 升级)】");
    if (apiRoutesDeployed === false) {
      out.push("  ⏭ 跳过：API 路由未部署(见第 2 步)");
    } else if (searchData) {
      const results = arrOf(searchData.results);
      if (searchData.ok === true && results.length > 0) {
        networkReachable = true;
        const src = text(searchData.source) || "?";
        out.push("  ✅ web_search 可用，取回 " + results.length + " 条结果(source=" + src + ")");
        out.push("     ℹ️ 默认走免费 DDG 即可(本自检不带 deep);需要 Exa 深搜时 web_search 带 deep=true 触发(前提:worker 已配 EXA_API_KEY)");
      } else if (searchData.ok === true) {
        out.push("  ⚠️ DDG 返回 0 条(source=" + (text(searchData.source) || "?") + ") —— DuckDuckGo 屏蔽了 Cloudflare 出口 IP 返回空(非本地网络问题)");
        out.push("     修法：① web_search 带 deep=true 走 Exa(需 worker 已配 EXA_API_KEY,直接有结果)  ② 或改用 fetch_page 平替(桌面端会自动降级原生 DDG)");
      } else {
        out.push("  ⚠️ DDG 上游报错：" + (text(searchData.error) || "未知") + " —— 多为 DDG 屏蔽 CF 出口");
      }
    } else {
      out.push("  (第 2 步未取得有效响应，无法判定)");
    }

    out.push("【4. fetch_page 代理通道 (" + env.proxy + ")】");
    let fetchOk = false;
    for (const probe of probes) {
      try {
        const t0 = env.now();
        const r = await env.fetchText(env.proxy + "?url=" + encodeURIComponent(probe), {}, 10000);
        if (looksLikeAppShell(r.body)) {
          out.push("  • " + probe + " → ⚠️ 返回本站首页壳(路由缺失，" + elapsed(t0) + ")");
        } else if (r.status >= 200 && r.status < 400 && r.body && r.body.trim().length > PROXY_MIN_CONTENT) {
          fetchOk = true;
          networkReachable = true;
          out.push("  • " + probe + " → ✅ HTTP " + r.status + " 取回 " + r.body.length + " 字(" + elapsed(t0) + ")");
          break;
        } else {
          out.push("  • " + probe + " → ⚠️ HTTP " + r.status + " 内容过短/被目标站拒(" + elapsed(t0) + "，疑似反爬)");
        }
      } catch (e) {
        out.push("  • " + probe + " → ❌ " + errName(e) + " " + errMessage(e));
      }
    }
    if (!fetchOk && apiRoutesDeployed !== false) {
      out.push("  ⚠️ 所有目标均未取回真实内容——若部分站是反爬(B 站等)属正常，只要有一个 ✅ 即视为联网正常");
    }

    out.push("【5. 桌面原生直连 http_request】");
    if (!env.isDesktop) {
      out.push("  ⏭ 跳过(当前非桌面端)");
    } else {
      for (const probe of probes) {
        try {
          const t0 = env.now();
          const txt = await env.nativeFetch(probe, 500);
          if (txt != null && txt.trim()) {
            networkReachable = true;
            out.push("  • " + probe + " → ✅ 成功(" + elapsed(t0) + ")取回 " + txt.length + " 字");
            break;
          }
          out.push("  • " + probe + " → ❌ 空/失败(" + elapsed(t0) + ")");
        } catch (e) {
          out.push("  • " + probe + " → ❌ " + errMessage(e));
        }
      }
    }

    // 不走代理，仅供参考 —— 这里的失败多为 CORS，与是否被墙无关。
    out.push("【6. 浏览器跨域直连(无代理，仅参考)】");
    for (const probe of probes) {
      try {
        const t0 = env.now();
        const r = await env.fetchText(probe, { mode: "no-cors" }, 8000);
        out.push("  • " + probe + " → HTTP " + (r.status || "opaque") + "(" + elapsed(t0) + ")");
      } catch (e) {
        const why = errName(e) === "AbortError" ? "超时(疑似丢包)" : "多为 CORS 拦截(与被墙无关)";
        out.push("  • " + probe + " → ❌ " + errName(e) + " — " + why);
      }
    }

    out.push("【结论】");
    if (apiRoutesDeployed === false) {
      out.push("  ✗ 线上 worker 未部署 /api/* 路由 → 网页端联网工具不可用，需 push worker.js 后重新部署。");
    } else {
      out.push(
        "  " +
          (networkReachable
            ? "✓ 网络可达：至少一个通道/目标取回了真实内容(单站如 B 站失败多为该站反爬，非无网络)。"
            : "✗ 所有通道均未取回真实内容，疑似确实无网络或全部目标被拦。"),
      );
      if (apiRoutesDeployed) {
        out.push("  · API 路由已部署；web_search 默认走免费 DDG，若 0 结果(DDG 屏蔽 CF 出口)可带 deep=true 走 Exa(需配 EXA_API_KEY)或用 fetch_page 平替。");
      }
    }
    return out.join("\n");
  }

  return {
    htmlToText,
    pageSlice,
    looksLikeAppShell,
    decodeEntities,
    parseDdgHtml,
    ddgUrl,
    biliUrl,
    biliResults,
    githubUrl,
    githubResults,
    parseRss,
    readCost,
    bumpCost,
    costSummary,
    costForSource,
    exaCost,
    diagnose,
  };
}

/**
 * `name` and `message` are **non-enumerable** on Error, so they must be read directly —
 * `Object.entries` would return nothing and every failure would print as `undefined`.
 */
function errProp(e         , key                    )          {
  return e && typeof e === "object" ? Reflect.get(e, key) : undefined;
}

function errName(e         )         {
  const n = errProp(e, "name");
  return n ? String(n) : "Error";
}

function errMessage(e         )         {
  const m = errProp(e, "message");
  return m ? String(m) : String(e);
}

/**
 * agent-reach — the agent's internet layer: six tools and the transport under them.
 *
 * The tools:
 *   fetch_page      — read any page. On desktop a native Rust request goes first; on the web the
 *                     request is proxied through /api/fetch, because a browser cannot reach several
 *                     of these hosts directly (blocked on the way out, or rejected by CORS).
 *   web_search      — semantic search. Worker side tries Exa first (paid), falls back to DDG; the
 *                     desktop falls back one more step to a native DDG call.
 *   search_bilibili — Bilibili search, no login required.
 *   search_github   — GitHub repository and code search.
 *   read_rss        — RSS/Atom feed parsing.
 *
 * AGENT_REACH_SKILL is kept as a constant but nothing injects it into a prompt: every tool
 * description already carries its own usage guidance, so the text is dead weight until someone
 * wires it into the system prompt.
 *
 * Usage:
 *   AgentReach.defineTools(registry)                     // into an existing registry
 *   const r = OwnChatTools.buildRegistry({ onImage })    // or merged into the built-in set
 *   AgentReach.defineTools(r)
 *
 * Load order: agent-kernel.js -> tools.js -> agent-reach.js.
 *
 * Only transport stays here: fetch, the Tauri invoke and the worker proxy, plus the six tool
 * definitions. HTML-to-text, page slicing, DDG parsing, the Bilibili/GitHub/RSS field maps, the
 * Exa cost ledger and the six-channel self-check all live in services/agent/reach.ts.
 */
;(function (global) {
  "use strict"

  // PROXY and IS_DESKTOP must be resolved before the service is created: the constructor takes
  // both facts and never re-reads them.
  const PROXY = typeof global.__agentReachProxy === "string"
    ? global.__agentReachProxy
    : "/api/fetch"  // worker 代理，绕过 CORS（网页侧必要）
  const IS_DESKTOP = !!(global.tauriSvc && global.tauriSvc.available())

  const svc = createReach({
    isDesktop: IS_DESKTOP,
    proxy: PROXY,
    // Ports are wrapped in function declarations, so hoisting makes them callable at construction
    // time even though the bodies appear further down.
    fetchText: async function (url, init, timeoutMs) {
      const r = await fetchWithTimeout(url, init, timeoutMs)
      const body = await r.text()
      const ct = (r.headers && r.headers.get && r.headers.get("content-type")) || ""
      return { ok: !!r.ok, status: typeof r.status === "number" ? r.status : 0, body: body, contentType: ct }
    },
    nativeFetch: function (url, maxChars, headers, rawHtml) {
      return tryNativeFetch(url, maxChars, headers, rawHtml)
    },
    now: function () { return Date.now() },
    origin: function () { try { return global.location ? global.location.origin : "" } catch (e) { return "" } },
    onLine: function () { try { return global.navigator ? global.navigator.onLine : undefined } catch (e) { return undefined } },
    hasInvoke: function () {
      return !!(global.tauriSvc && global.tauriSvc.available())
    },
    storage: {
      getItem: function (k) { try { return global.localStorage ? global.localStorage.getItem(k) : null } catch (e) { return null } },
      setItem: function (k, v) { try { if (global.localStorage) global.localStorage.setItem(k, v) } catch (e) {} },
    },
  })

  // Every outbound call needs a deadline. Without one, a host that accepts the connection and then
  // never answers leaves fetch pending forever and the agent loop hangs with it — the symptom is
  // "reasoning stops returning at round N". AbortController enforces the deadline; the desktop
  // additionally gets a native http_request fallback that does not depend on the Jina reader.
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
  // Rough HTML-to-text (implementation in the service).
  function htmlToText(html) { return svc.htmlToText(html) }

  // Desktop native fallback: plain text on success, null when not on desktop, on failure or on
  // timeout. `headers` is optional and is forwarded to the Rust http_request call.
  async function tryNativeFetch(url, maxChars, headers, rawHtml) {
    const invoke = global.tauriSvc ? global.tauriSvc.invokeOrNull() : null
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
      // rawHtml=true skips htmlToText and returns raw HTML, which nativeDdgSearch needs to parse
      // DDG's result structure.
      const text = rawHtml ? raw : ((/text\/html/i.test(ct) || /^\s*</.test(raw)) ? htmlToText(raw) : raw)
      return text.slice(0, maxChars)
    } catch (e) { return null }
  }

  // Only web_search bills, and only when it actually hit Exa; every other reach tool is free.
  // The ledger (with 1e-6 rounding, so a repeated 0.007 cannot drift) lives in the service; this
  // is a forwarder.
  const EXA_COST_PER_SEARCH = svc.exaCost()
  function bumpReachCost(usd) { return svc.bumpCost(usd) }
  function reachCostSummary() { return svc.costSummary() }


  // SKILL.md text (kept for reference; nothing injects it — see the file header).
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

  // Internal helpers.

  // Transport policy, and why it is split:
  //   · Web: every outbound call goes through the same-origin /api/fetch proxy. Direct calls to the
  //     reader and search hosts fail from a browser — blocked on the way out, or rejected by CORS —
  //     and a blocked call used to burn the full timeout before failing, which read as "the agent
  //     can never reach the network". The Worker's egress has neither problem: handleFetchProxy in
  //     worker.js makes the call server-side.
  //   · Desktop: a native Rust http_request instead of a webview fetch, because the webview is still
  //     bound by same-origin rules and every overseas host died on CORS. It is wrapped in a
  //     Response-like object so jinaRead / multiSourceSearch callers do not have to branch.
  //   · A native failure degrades to the worker proxy; on desktop that proxy usually does not exist,
  //     so it fails again — with an error, never a hang.
  // IS_DESKTOP is resolved at the top of the file because the service needs it at construction.
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
    // Native failure degrades to the worker proxy.
    return fetchWithTimeout(PROXY + "?url=" + encodeURIComponent(url), init, timeoutMs)
  }

  function extFetch(url, init, timeoutMs) {
    if (IS_DESKTOP) return nativeFetchResponse(url, init, timeoutMs)
    return fetchWithTimeout(PROXY + "?url=" + encodeURIComponent(url), init, timeoutMs)
  }

  /**
   * The one fetch wrapper every tool goes through: proxied on the web, native-first on desktop
   * with the proxy as the fallback.
   * @param {string} url
   * @param {RequestInit} [init]
   * @returns {Promise<Response>}
   */
  async function safeFetch(url, init) {
    // Web: proxy straight away. A direct attempt only spends the full timeout learning the host is
    // unreachable from here.
    if (!IS_DESKTOP) {
      return fetchWithTimeout(PROXY + "?url=" + encodeURIComponent(url), init)
    }
    // Desktop: Rust http_request first (no CORS, no egress blocking), proxy on failure.
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
   * Web search through the worker's /api/search: DDG runs server-side on the Cloudflare egress, so
   * the browser needs neither a key nor CORS, and no host has to be reachable from the client.
   * Desktop calls the same endpoint through the native transport; the web just fetches it.
   *
   * Running the search server-side is the architecture, not a workaround: an earlier version
   * called the search hosts directly and every one of them failed client-side.
   */
  const PER_SOURCE_TIMEOUT = 12000
  // Desktop-only fallback for the case the worker cannot cover: DDG routinely answers a
  // Cloudflare egress IP with zero results. The desktop can reach DDG's HTML endpoint from the
  // user's own address instead, and reuses the same result parsing as handleSearchProxy.
  // Web has no native transport, so it returns null and keeps the existing behaviour.
  async function nativeDdgSearch(query, count) {
    if (!IS_DESKTOP) return null
    const n = Math.max(1, Math.min(10, Number(count) || 5))
    // rawHtml=true: DDG's result structure has to be parsed out of the raw HTML.
    const html = await tryNativeFetch(svc.ddgUrl(query), 500000, {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }, true)
    if (!html) return null
    const results = svc.parseDdgHtml(html, n)
    if (!results.length) return null
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
          // Keep the source the worker reports (exa / ddg) instead of hardcoding it: a hardcoded
          // value would neither bill Exa nor label the result correctly.
          return { source: data.source || "worker-ddg", results: data.results }
        }
      }
    } catch (_) {}
    // Landing here means the worker returned nothing, usually because DDG blocked the Cloudflare
    // egress IP. The native path uses the user's own address.
    try {
      const native = await nativeDdgSearch(query, count)
      if (native && native.results && native.results.length > 0) return native
    } catch (_) {}
    return null
  }

  // Network self-check. The six-channel report lives in the service; the ports are the ones above.
  // Two criteria that must not be relaxed: any successful probe means the network is reachable (a
  // single host's anti-bot must not decide the verdict), and /api/search is judged by its JSON
  // contract rather than by whether the body looks like HTML — a real page is HTML too.
  function diagnoseNetwork(testUrl) { return svc.diagnose(testUrl) }

  // Tool registration.

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
        // Large pages and large sources need to be read past the head: max_chars alone left the
        // middle unreachable. offset is a character offset, and the slice always happens after the
        // full text is in hand, so all three paths share one meaning of the two numbers.
        const offset = Math.max(0, Math.min(5 * 1024 * 1024, Number(args.offset) || 0))
        const page = (t) => svc.pageSlice(t, maxChars, offset)
        // Same-origin first: read it in the page, with no proxy and no network hop. Routing our own
        // site through the worker's /api/fetch makes the Worker call itself as a subrequest, which
        // Cloudflare cuts off; an external relay was tried and Cloudflare recognised the Worker
        // egress just the same. A relative path ("/js/...") is the supported way to read our own
        // deployed source; an absolute URL for this host is rewritten to one.
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
            // Same-origin reads skip the 150-character floor the proxy path applies: short files
            // like JS and CSS must come back exactly as they are.
            return Object.assign({ ok: true, source: "same-origin", url: _rel }, page(_stxt))
          } catch (e) {
            return { ok: false, url: url, error: "同源读取异常：" + (e && e.message ? e.message : String(e)) }
          }
        }
        // Desktop: native Rust request (no CORS, no egress blocking). It has to ask for
        // offset + maxChars bytes because the body is sliced after the fact, not streamed.
        const nativeFirst = await tryNativeFetch(url, maxChars + offset)
        if (nativeFirst != null && nativeFirst.trim()) {
          return Object.assign({ ok: true, source: "native", url: url }, page(nativeFirst))
        }
        // Web: the /api/fetch worker proxy (same-origin Cloudflare egress, same path web_search
        // uses).
        try {
          const _pr = await fetchWithTimeout(PROXY + "?url=" + encodeURIComponent(url), {}, DEFAULT_TIMEOUT_MS)
          if (_pr.ok) {
            const _raw = await _pr.text()
            const _ct = (_pr.headers && _pr.headers.get && _pr.headers.get("content-type")) || ""
            // A missing proxy route answers with the SPA shell — a bare script tag, which
            // htmlToText turns into almost nothing. Skip the Jina fallback in that case.
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
          // Only exa bills, and the description has to say so explicitly — otherwise the model
          // over-avoids the free sources.
          const cost = svc.costForSource(found.source)
          if (cost.billable) bumpReachCost(cost.usd)
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

        const url = svc.biliUrl(kw, stype, count)

        const _biliHeaders = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'Referer': 'https://www.bilibili.com',
          'Origin': 'https://www.bilibili.com',
        }
        try {
          const r = await safeFetch(url, { headers: _biliHeaders })
          if (!r.ok) throw new Error("B 站 API 返回 " + r.status)
          const json = await r.json()
          const results = svc.biliResults(json, count)
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

        const url = svc.githubUrl(q, sort, count)

        try {
          const r = await safeFetch(url, {
            headers: { "Accept": "application/vnd.github+json" },
          })
          if (!r.ok) throw new Error("GitHub API " + r.status)
          const data = await r.json()
          const results = svc.githubResults(data, count)
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
          // Fetch the raw XML through native/proxy with a timeout; the outer catch owns failures.
          let xml = ""
          const r = await safeFetch(url, { headers: { "Accept": "application/rss+xml, application/xml, text/xml" } })
          // Without the r.ok check a 404 or an anti-bot page parses as valid XML with zero
          // entries, and the model reports "the feed is empty" instead of "the request failed".
          if (!r.ok) return { ok: false, error: "HTTP " + r.status + "（订阅源不可达或拒绝访问）" }
          xml = await r.text()

          // Minimal XML parsing: no DOM, so it also works where DOM is absent. Implementation in
          // the service.
          const items = svc.parseRss(xml, count)

          return { ok: true, url, count: items.length, items }
        } catch (e) {
          return { ok: false, url, error: "RSS 解析失败: " + String(e && e.message ? e.message : e) }
        }
      },
    })

    // ── reach_cost ────────────────────────────────────────────────────────────────
    // Give the agent a sense of what reach costs: cumulative Exa spend from web_search, persisted
    // locally.
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
    // The first thing to run when a user reports "reach never works": it reports step by step
    // which hop is failing.
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

  // Public API.
  global.AgentReach = {
    defineTools,
    SKILL: AGENT_REACH_SKILL,
    // Override the proxy endpoint (a web host with its own worker route can point it elsewhere).
    // Manual self-check from the console: AgentReach.diagnose().then(console.log).
    diagnose: function (url) { return diagnoseNetwork(url) },
  }

})(typeof globalThis !== "undefined" ? globalThis : window)

globalThis.createReach = createReach;
})();
