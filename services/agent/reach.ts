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
export interface PageSlice {
  text: string;
  totalChars: number;
  fromOffset: number;
  nextOffset: number;
  truncated: boolean;
}

/** A single search hit, shape shared by every source. */
export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** Cumulative Exa spend, persisted per device. */
export interface ReachCost {
  usd: number;
  searches: number;
}

/** One response, flattened: the service never touches a `Response` object. */
export interface FlatResponse {
  ok: boolean;
  status: number;
  body: string;
  contentType: string;
}

export interface ReachEnv {
  /** True inside the Tauri shell (Rust `http_request` available, no CORS / GFW). */
  isDesktop: boolean;
  /** Worker proxy path, `/api/fetch` unless overridden before load. */
  proxy: string;
  /** Plain fetch with an abort timeout. Errors propagate. */
  fetchText(url: string, init: unknown, timeoutMs: number): Promise<FlatResponse>;
  /** Desktop-only Rust direct request; `null` when unavailable, failed, or timed out. */
  nativeFetch(url: string, maxChars: number, headers?: Record<string, string>, rawHtml?: boolean): Promise<string | null>;
  now(): number;
  origin(): string;
  onLine(): unknown;
  hasInvoke(): boolean;
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
}

export interface ReachApi {
  /** Rough HTML → text. Strips tooling/scripts/styles, turns block ends into newlines, decodes the basics. */
  htmlToText(html: unknown): string;
  /** Cuts a `maxChars` window starting at `offset` and reports where the next window begins. */
  pageSlice(text: unknown, maxChars: number, offset: number): PageSlice;
  /** True when a body is our own SPA shell — i.e. the proxy route is missing, not the target. */
  looksLikeAppShell(body: unknown): boolean;
  /** Strips tags and decodes the entities DDG emits. */
  decodeEntities(s: string): string;
  /** Parses DDG's html endpoint into hits. `[]` when the markup matches nothing. */
  parseDdgHtml(html: string, count: number): SearchHit[];
  /** The html endpoint URL, with `kl=cn-zh`. */
  ddgUrl(query: string): string;
  /** Bilibili search URL. */
  biliUrl(keyword: string, searchType: string, count: number): string;
  /** Maps a Bilibili payload to hits, dropping the `<em>` highlighting it puts in titles. */
  biliResults(payload: unknown, count: number): Record<string, unknown>[];
  /** GitHub repository search URL. */
  githubUrl(query: string, sort: string, count: number): string;
  /** Maps a GitHub payload to hits. */
  githubResults(payload: unknown, count: number): Record<string, unknown>[];
  /** Minimal RSS/Atom parse: title / link / summary / pubdate per item. */
  parseRss(xml: string, count: number): Record<string, string>[];
  /** Reads the persisted ledger. Corrupt or missing storage reads as zero. */
  readCost(): ReachCost;
  /** Adds one search's cost and persists. @returns the new ledger. */
  bumpCost(usd: number): ReachCost;
  /** Ledger plus the RMB estimate the tool reports. */
  costSummary(): { usd: number; rmb: number; searches: number };
  /** Whether a source bills, and the note shown to the model. */
  costForSource(source: string): { billable: boolean; usd: number; note: string };
  /** Per-search Exa price, for the tool descriptions. */
  exaCost(): number;
  /** Six-channel connectivity report. Every probe is independent; one success means reachable. */
  diagnose(testUrl: unknown): Promise<string>;
}

/** Shallow entry copy — also drops non-enumerable props, which is why errors need `errProp`. */
function recOf(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) out[k] = v;
  }
  return out;
}

function arrOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function num(value: unknown): number {
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

export function createReach(env: ReachEnv): ReachApi {
  function htmlToText(html: unknown): string {
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
  function pageSlice(raw: unknown, maxChars: number, offset: number): PageSlice {
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
  function looksLikeAppShell(body: unknown): boolean {
    if (typeof body !== "string" || !body) return false;
    const head = body.slice(0, 800).toLowerCase();
    const isHtml = head.indexOf("<!doctype html") !== -1 || head.indexOf("<html") !== -1;
    return (
      isHtml &&
      (head.indexOf("/js/engine/app.js") !== -1 || head.indexOf('id="app"') !== -1 || head.indexOf("id='app'") !== -1)
    );
  }

  function decodeEntities(s: string): string {
    return s
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .trim();
  }

  function ddgUrl(query: string): string {
    return "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query) + "&kl=cn-zh";
  }

  /**
   * DDG's html endpoint is scanned three times — links, then titles, then snippets — and the three
   * arrays are zipped by index. Titles and snippets are optional; a missing one falls back to the URL
   * (title) or empty string (snippet), which keeps the hit count equal to the link count.
   */
  function parseDdgHtml(html: string, count: number): SearchHit[] {
    const links: string[] = [];
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

    const titles: string[] = [];
    const titleRe = /class="result__a"[^>]+href="[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    let tm = titleRe.exec(html);
    while (tm !== null && titles.length < count) {
      titles.push(decodeEntities(tm[1]));
      tm = titleRe.exec(html);
    }

    const snippets: string[] = [];
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

  function biliUrl(keyword: string, searchType: string, count: number): string {
    const params = new URLSearchParams({
      keyword: keyword,
      search_type: searchType,
      page: "1",
      page_size: String(count),
    });
    return "https://api.bilibili.com/x/web-interface/search/type?" + params.toString();
  }

  /** Bilibili wraps matched terms in `<em>` inside titles; the model should see clean text. */
  function biliResults(payload: unknown, count: number): Record<string, unknown>[] {
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

  function githubUrl(query: string, sort: string, count: number): string {
    const params = new URLSearchParams({ q: query, sort: sort, order: "desc", per_page: String(count) });
    return "https://api.github.com/search/repositories?" + params.toString();
  }

  function githubResults(payload: unknown, count: number): Record<string, unknown>[] {
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
  function parseRss(xml: string, count: number): Record<string, string>[] {
    const items: Record<string, string>[] = [];
    const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>|<entry[^>]*>([\s\S]*?)<\/entry>/gi;
    let m = itemRegex.exec(xml);
    while (m !== null && items.length < count) {
      const block = m[1] || m[2] || "";
      const get = function (tag: string): string {
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

  function readCost(): ReachCost {
    try {
      const raw = env.storage.getItem(REACH_COST_KEY);
      const o = raw ? recOf(JSON.parse(raw)) : {};
      if (typeof o.usd === "number") return { usd: o.usd, searches: num(o.searches) };
    } catch (e) {
      /* unreadable ledger counts as zero */
    }
    return { usd: 0, searches: 0 };
  }

  function bumpCost(usd: number): ReachCost {
    const c = readCost();
    // Round at 1e-6 so repeated 0.007 additions do not drift into 0.021000000000000001.
    const next: ReachCost = {
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

  function costSummary(): { usd: number; rmb: number; searches: number } {
    const c = readCost();
    return { usd: c.usd, rmb: Math.round(c.usd * 7.2 * 100) / 100, searches: c.searches || 0 };
  }

  /** Only Exa bills. Everything else is free, and the note has to say so or the model over-avoids it. */
  function costForSource(source: string): { billable: boolean; usd: number; note: string } {
    if (source === "exa") {
      return { billable: true, usd: EXA_COST_PER_SEARCH, note: "Exa 付费搜索 ≈$" + EXA_COST_PER_SEARCH + "（≈0.05 元）" };
    }
    return { billable: false, usd: 0, note: "免费（" + source + "）" };
  }

  function exaCost(): number {
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
  async function diagnose(testUrl: unknown): Promise<string> {
    const out: string[] = [];
    const elapsed = function (t0: number): string {
      return env.now() - t0 + "ms";
    };
    const explicit = typeof testUrl === "string" ? testUrl.trim() : "";
    const probes = explicit
      ? [explicit]
      : ["https://www.baidu.com/", "https://example.com/", "https://api.bilibili.com/x/web-interface/zone"];

    let networkReachable = false;
    let apiRoutesDeployed: boolean | null = null;

    out.push("【1. 运行环境】");
    out.push("  IS_DESKTOP = " + env.isDesktop + "(true=桌面 Tauri / false=网页)");
    out.push("  PROXY      = " + env.proxy);
    out.push("  origin     = " + (env.origin() || "(无 location)"));
    out.push("  navigator.onLine = " + (env.onLine() === undefined ? "(未知)" : String(env.onLine())));
    out.push("  hasTauriInvoke   = " + env.hasInvoke());
    out.push("  当前时间   = " + new Date(env.now()).toISOString());

    out.push("【2. 同源 API 路由部署 (/api/search 契约)】");
    let searchData: Record<string, unknown> | null = null;
    try {
      const t0 = env.now();
      const r = await env.fetchText("/api/search?q=" + encodeURIComponent("connectivity diag ping"), {}, 12000);
      let json: Record<string, unknown> | null = null;
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
function errProp(e: unknown, key: "name" | "message"): unknown {
  return e && typeof e === "object" ? Reflect.get(e, key) : undefined;
}

function errName(e: unknown): string {
  const n = errProp(e, "name");
  return n ? String(n) : "Error";
}

function errMessage(e: unknown): string {
  const m = errProp(e, "message");
  return m ? String(m) : String(e);
}
