(function () {
/**
 * Line slicing and text search behind the agent's `read_file` / `search_file` tools.
 *
 * The kernel caps one tool result at 8000 characters and keeps the head and tail, so an
 * unbounded read silently loses the middle of a large file. Every window here is therefore
 * sized to fit inside that cap, and every overflow is reported instead of dropped.
 *
 * Literal matching is the default; regular expressions are opt-in and guarded (length cap,
 * nested-quantifier rejection, per-line failure fallback) because the pattern comes from the
 * model. Nothing here touches `window`, storage or the DOM; the adapter is l0/wiring/text-search.js.
 * @module services/agent/text-search
 */

/** Default and hard caps for one read window; the byte cap also bounds the character budget. */
const READ_DEF_LIMIT = 400;
const READ_MAX_LIMIT = 2000;
const READ_MAX_BYTES = 6000;
const LINE_CLIP = 500;

/** Search caps: hit count, context lines, output budget and the wall-clock escape hatch. */
const SEARCH_DEF_MAX = 30;
const SEARCH_HARD_MAX = 100;
const SEARCH_CTX_DEF = 2;
const SEARCH_CTX_MAX = 10;
const SEARCH_OUT_BUDGET = 7000;
const SEARCH_TIME_MS = 500;

/** Longest accepted pattern; anything past this is rejected before compilation. */
const REGEX_MAX_LEN = 200;

/**
 * Nested quantifiers (`(a+)+`, `(x*)*`) are the classic backtracking-bomb shape. They are
 * rejected rather than risked: a hung tool call has no timeout on the caller side.
 */
const NESTED_QUANT = /\([^)]*[+*][^)]*\)\s*[+*{]/;

/** Caps actually in force, so callers size their own windows instead of hard-coding numbers. */
const TS_LIMITS = {
  READ_DEF_LIMIT,
  READ_MAX_LIMIT,
  READ_MAX_BYTES,
  LINE_CLIP,
  SEARCH_DEF_MAX,
  SEARCH_HARD_MAX,
  SEARCH_CTX_DEF,
  SEARCH_OUT_BUDGET,
  SEARCH_TIME_MS,
  REGEX_MAX_LEN,
};

/** One paginated window. `from`/`to` are 1-based and inclusive; `to < total` means more text. */
                          
               
                
               
             
                
                       
                         
 

/** One hit line with optional surrounding context lines (already clipped). */
                              
               
               
                    
                   
 

/** Search outcome. `degraded` carries a user-facing reason when the answer is partial. */
                                 
                         
                
                     
                     
                          
 

/** Per-file bucket of hits, as the search_file caller accumulates them. */
                                
                 
                       
                       
                          
                      
 

/** Output-budgeted block list; `truncated` is true when anything was cut, anywhere. */
                              
                          
                     
 

function toInt(v         , def        , lo        , hi        )         {
  let n = parseInt(String(v), 10);
  if (isNaN(n)) n = def;
  return Math.max(lo, Math.min(hi, n));
}

function clipLine(s         )         {
  const t = String(s == null ? "" : s);
  return t.length > LINE_CLIP
    ? t.slice(0, LINE_CLIP) + "…[本行余下 " + (t.length - LINE_CLIP) + " 字符已裁]"
    : t;
}

/**
 * Slice `text` by lines, then trim to the byte budget.
 *
 * @returns The window plus what was lost: `droppedByBytes` counts lines removed by the byte cap,
 *   `clippedLines` counts lines whose tails were cut. Both are 0 on a clean window.
 */
function tsSliceLines(text         , offset          , limit          )          {
  const all = String(text == null ? "" : text).split("\n");
  const total = all.length;
  const from0 = Math.max(0, toInt(offset, 1, 1, Number.MAX_SAFE_INTEGER) - 1);
  const lim = toInt(limit, READ_DEF_LIMIT, 1, READ_MAX_LIMIT);
  const slice = all.slice(from0, from0 + lim);
  let clipped = 0;
  const lines           = [];
  for (let i = 0; i < slice.length; i++) {
    const ln = slice[i];
    if (ln.length > LINE_CLIP) clipped++;
    lines.push(clipLine(ln));
  }
  // Line count times line length can still exceed the window budget, so re-trim by bytes.
  let used = 0;
  let dropped = 0;
  for (let j = 0; j < lines.length; j++) {
    used += lines[j].length + 1;
    if (used > READ_MAX_BYTES) {
      dropped = lines.length - j;
      lines.length = j;
      break;
    }
  }
  const to = from0 + lines.length;
  return {
    text: lines.join("\n"),
    total,
    from: from0 + 1,
    to,
    more: to < total,
    clippedLines: clipped,
    droppedByBytes: dropped,
  };
}

/**
 * Translate a minimal glob into an anchored RegExp: `*` stays inside one path segment,
 * `**` crosses segments, `?` is one non-slash character.
 *
 * @returns `null` when the pattern has no wildcard (callers then use exact or substring
 *   matching) and also when the translation cannot compile — a bad glob must not throw.
 */
function tsGlobToRe(glob         )                {
  const g = String(glob == null ? "" : glob);
  if (!g || !/[*?]/.test(g)) return null;
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === "*") {
      if (g[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".indexOf(ch) >= 0) {
      re += "\\" + ch;
    } else {
      re += ch;
    }
  }
  try {
    return new RegExp("^" + re + "$");
  } catch (e) {
    return null;
  }
}

/**
 * Search `text` line by line, either literally (default) or with a guarded regular expression.
 *
 * Every rejection path returns a complete result with `matches: []` and a `degraded` reason
 * rather than throwing: a tool call must come back with something the model can act on.
 *
 * @returns Hits are capped at `max_results`; `total` still counts every match, so
 *   `truncated` distinguishes "few hits" from "hits cut off". A hit with no `before`/`after`
 *   means context was requested as 0.
 */
function tsSearchText(text         , opts                      )                 {
  const o = opts && typeof opts === "object" ? opts : {};
  const pattern = String(o["pattern"] == null ? "" : o["pattern"]);
  if (!pattern) {
    return { matches: [], total: 0, truncated: false, totalLines: 0, degraded: "缺少 pattern" };
  }
  const ctx = toInt(o["context"], 0, 0, SEARCH_CTX_MAX);
  const max = toInt(o["max_results"], SEARCH_DEF_MAX, 1, SEARCH_HARD_MAX);
  const lines = String(text == null ? "" : text).split("\n");
  let matcher                = null;
  let degraded                = null;
  if (o["regex"]) {
    if (pattern.length > REGEX_MAX_LEN) {
      return {
        matches: [],
        total: 0,
        truncated: false,
        totalLines: lines.length,
        degraded: "正则过长（>" + REGEX_MAX_LEN + " 字符）已拒绝；请用字面检索或缩短表达式",
      };
    }
    if (NESTED_QUANT.test(pattern)) {
      return {
        matches: [],
        total: 0,
        truncated: false,
        totalLines: lines.length,
        degraded: "正则含嵌套量词（如 (a+)+），有回溯炸弹风险，已拒绝；请改写表达式或改用字面检索",
      };
    }
    try {
      matcher = new RegExp(pattern, o["ignore_case"] ? "i" : "");
    } catch (e) {
      return {
        matches: [],
        total: 0,
        truncated: false,
        totalLines: lines.length,
        degraded: "正则不合法：" + String((e instanceof Error && e.message) || e),
      };
    }
  }
  const lit = o["ignore_case"] ? pattern.toLowerCase() : pattern;
  const t0 = Date.now();
  const matches                = [];
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    let hit = false;
    if (matcher) {
      try {
        hit = matcher.test(ln);
      } catch (e) {
        if (!degraded) degraded = "正则执行异常（该行已跳过）：" + String((e instanceof Error && e.message) || e);
        hit = false;
      }
    } else {
      hit = (o["ignore_case"] ? ln.toLowerCase() : ln).indexOf(lit) >= 0;
    }
    if (!hit) continue;
    total++;
    if (matches.length < max) {
      const m              = { line: i + 1, text: clipLine(ln) };
      if (ctx) {
        m.before = lines.slice(Math.max(0, i - ctx), i).map(clipLine);
        m.after = lines.slice(i + 1, i + 1 + ctx).map(clipLine);
      }
      matches.push(m);
    }
    if (Date.now() - t0 > SEARCH_TIME_MS) {
      if (!degraded) degraded = "检索时间预算（" + SEARCH_TIME_MS + "ms）用尽，已停在文件靠前位置（结果可能不全）";
      break;
    }
  }
  return { matches, total, truncated: total > matches.length, totalLines: lines.length, degraded };
}

/** Options bag as the tool layer hands it over; every field is untrusted input. */
                               
                         
 

/**
 * Pack hit blocks into the output budget, trimming by individual hit when a block does not fit.
 *
 * The first block is trimmed too, even when it alone exceeds the budget: an untrimmed block
 * would push the whole result past the kernel cap and lose the middle of the answer.
 *
 * @returns Only the blocks (and hits) that fit; `truncated` is true if anything was left out,
 *   including when the budget could not fit even one hit.
 */
function tsFitBlocks(blocks                         , budget          )              {
  const B = toInt(budget, SEARCH_OUT_BUDGET, 200, 100000);
  const kept                  = [];
  const list = blocks || [];
  let size = 0;
  let truncated = false;
  let keptMatches = 0;
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    const s = JSON.stringify(b).length;
    if (size + s <= B) {
      kept.push(b);
      size += s;
      keptMatches += (b.matches || []).length;
      continue;
    }
    const room = B - size;
    const head                = {
      path: b.path,
      totalLines: b.totalLines,
      matchCount: b.matchCount,
      matches: [],
      truncated: true,
    };
    const headLen = JSON.stringify(head).length;
    if (room <= headLen) {
      truncated = true;
      break;
    }
    const ms = b.matches || [];
    for (let j = 0; j < ms.length; j++) {
      if (!head.matches) head.matches = [];
      head.matches.push(ms[j]);
      if (JSON.stringify(head).length > room) {
        head.matches.pop();
        break;
      }
    }
    if (head.matches && head.matches.length) {
      kept.push(head);
      size += JSON.stringify(head).length;
      keptMatches += head.matches.length;
    }
    truncated = true;
    break;
  }
  let all = 0;
  for (let k = 0; k < list.length; k++) all += (list[k].matches || []).length;
  if (keptMatches < all) truncated = true;
  return { blocks: kept, truncated };
}

// Browser adapter appended by l0/emit.mjs. Engine: services/agent/text-search.ts (windowing, glob
// translation, literal/regex search with its guards, output budgeting). This file publishes the
// module under a non-frozen bridge and keeps the CommonJS bridge for out-of-repo harnesses.
//
// Publishing here rather than in the engine keeps the engine free of globals; the agent-workspace
// adapter resolves this port lazily on every call, so load order does not matter.
(function () {
  "use strict";
  if (typeof window === "undefined") return;

  window.textSearchSvc = {
    sliceLines: tsSliceLines,
    globToRe: tsGlobToRe,
    searchText: tsSearchText,
    fitBlocks: tsFitBlocks,
    LIMITS: TS_LIMITS,
  };

  // Node-side harnesses (no window) require the product directly; browsers never reach this branch.
  if (typeof module !== "undefined" && module.exports) module.exports = window.textSearchSvc;
})();

globalThis.TS_LIMITS = TS_LIMITS;
globalThis.tsSliceLines = tsSliceLines;
globalThis.tsGlobToRe = tsGlobToRe;
globalThis.tsSearchText = tsSearchText;
globalThis.tsFitBlocks = tsFitBlocks;
})();
