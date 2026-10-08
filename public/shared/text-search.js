// public/shared/text-search.js — 大文件"分页读 / 检索定位"的纯函数（2026-10-08）
// ─────────────────────────────────────────────────────────────
// 背景：agent 旧 read_file 返回全文，而内核回灌上限 8000 字符（头 6000 + 尾 1500）会把**中段挖掉** ——
// 读 20KB 以上的文件/网页等于只看首尾（与平台里那个 agent 的盲区同款）。
// 这里只放**无副作用纯函数**，供两处复用：
//   ① data/agent-workspace.js 的 read_file（按行分页）/ search_file（grep 语义）
//   ② 仓库外 redteam 单测（Node 直 require）
// 口径抄 DSH 生态（dsh-pi-compatible 的 read:offset/limit + grep 字面优先；token-saver 的命中/上下文预算）：
//   · 字面匹配默认（快、零误报、无 ReDoS）；regex 显式开，且加长度上限 + 嵌套量词拒绝 + 逐行失败降级
//   · 行窗口：默认 400 行 / 单窗 ≤24KB（受内核 8000 字符回灌约束，比 DSH 的 2000 行更小）/ 单行 ≤500 字符
//   · 检索结果：默认 30 命中（上限 100）/ 上下文默认 2 行 / 总输出 ≤8000 字符，超了截断并如实标注
(function () {
  "use strict";

  // 单窗文本预算：内核单条工具结果上限 8000 字符（头 6000 + 尾 1500，超了会**挖掉中段**）——
  // 窗口必须整份装得进去，否则刚修好的"中段全黑"会被内核再造成一次。留 JSON 包装（路径/行号/提示语）的余量。
  var READ_DEF_LIMIT = 400, READ_MAX_LIMIT = 2000, READ_MAX_BYTES = 6000, LINE_CLIP = 500;
  var SEARCH_DEF_MAX = 30, SEARCH_HARD_MAX = 100, SEARCH_CTX_DEF = 2, SEARCH_CTX_MAX = 10, SEARCH_OUT_BUDGET = 7000, SEARCH_TIME_MS = 500;
  var REGEX_MAX_LEN = 200;
  // 嵌套量词（(a+)+ / (x*)* 这类）是 JS 回溯炸弹的典型形态：拒绝而不是赌它不炸
  var NESTED_QUANT = /\([^)]*[+*][^)]*\)\s*[+*{]/;

  function toInt(v, def, lo, hi) {
    var n = parseInt(v, 10);
    if (isNaN(n)) n = def;
    return Math.max(lo, Math.min(hi, n));
  }
  function clipLine(s) {
    var t = String(s == null ? "" : s);
    return t.length > LINE_CLIP ? (t.slice(0, LINE_CLIP) + "…[本行余下 " + (t.length - LINE_CLIP) + " 字符已裁]") : t;
  }

  /** 按行分页切片（1 起 offset）。返回 { text, total, from, to, more, clippedLines, droppedByBytes } */
  function sliceLines(text, offset, limit) {
    var all = String(text == null ? "" : text).split("\n");
    var total = all.length;
    var from0 = Math.max(0, toInt(offset, 1, 1, Number.MAX_SAFE_INTEGER) - 1);
    var lim = toInt(limit, READ_DEF_LIMIT, 1, READ_MAX_LIMIT);
    var slice = all.slice(from0, from0 + lim);
    var clipped = 0, lines = [];
    for (var i = 0; i < slice.length; i++) {
      var ln = slice[i];
      if (ln.length > LINE_CLIP) clipped++;
      lines.push(clipLine(ln));
    }
    // 再按单窗字节预算收口（行数 × 行长可能超 24KB）
    var used = 0, dropped = 0;
    for (var j = 0; j < lines.length; j++) {
      used += lines[j].length + 1;
      if (used > READ_MAX_BYTES) { dropped = lines.length - j; lines.length = j; break; }
    }
    var to = from0 + lines.length; // 1 起、含
    return { text: lines.join("\n"), total: total, from: from0 + 1, to: to, more: to < total, clippedLines: clipped, droppedByBytes: dropped };
  }

  /** 极简 glob → RegExp（* 不跨 /，** 跨 /，? 单字符）。无通配符返回 null（调用方走子串/精确匹配） */
  function globToRe(glob) {
    var g = String(glob == null ? "" : glob);
    if (!g || !/[*?]/.test(g)) return null;
    var re = "";
    for (var i = 0; i < g.length; i++) {
      var ch = g[i];
      if (ch === "*") {
        if (g[i + 1] === "*") { re += ".*"; i++; } else { re += "[^/]*"; }
      } else if (ch === "?") { re += "[^/]"; }
      else if ("\\^$.|+()[]{}".indexOf(ch) >= 0) { re += "\\" + ch; }
      else { re += ch; }
    }
    try { return new RegExp("^" + re + "$"); } catch (e) { return null; }
  }

  /** 在文本里按行检索。opts: { pattern, regex, ignore_case, context, max_results }
   *  返回 { matches:[{line,text,before,after}], total, truncated, totalLines, degraded } */
  function searchText(text, opts) {
    var o = opts || {};
    var pattern = String(o.pattern == null ? "" : o.pattern);
    if (!pattern) return { matches: [], total: 0, truncated: false, totalLines: 0, degraded: "缺少 pattern" };
    var ctx = toInt(o.context, 0, 0, SEARCH_CTX_MAX);
    var max = toInt(o.max_results, SEARCH_DEF_MAX, 1, SEARCH_HARD_MAX);
    var lines = String(text == null ? "" : text).split("\n");
    var matcher = null, degraded = null;
    if (o.regex) {
      if (pattern.length > REGEX_MAX_LEN) return { matches: [], total: 0, truncated: false, totalLines: lines.length, degraded: "正则过长（>" + REGEX_MAX_LEN + " 字符）已拒绝；请用字面检索或缩短表达式" };
      if (NESTED_QUANT.test(pattern)) return { matches: [], total: 0, truncated: false, totalLines: lines.length, degraded: "正则含嵌套量词（如 (a+)+），有回溯炸弹风险，已拒绝；请改写表达式或改用字面检索" };
      try { matcher = new RegExp(pattern, o.ignore_case ? "i" : ""); }
      catch (e) { return { matches: [], total: 0, truncated: false, totalLines: lines.length, degraded: "正则不合法：" + String((e && e.message) || e) }; }
    }
    var lit = o.ignore_case ? pattern.toLowerCase() : pattern;
    var t0 = Date.now();
    var matches = [], total = 0;
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      var hit = false;
      if (matcher) {
        try { hit = matcher.test(ln); }
        catch (e) { if (!degraded) degraded = "正则执行异常（该行已跳过）：" + String((e && e.message) || e); hit = false; }
      } else {
        hit = (o.ignore_case ? ln.toLowerCase() : ln).indexOf(lit) >= 0;
      }
      if (!hit) continue;
      total++;
      if (matches.length < max) {
        var m = { line: i + 1, text: clipLine(ln) };
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
    return { matches: matches, total: total, truncated: total > matches.length, totalLines: lines.length, degraded: degraded };
  }

  /** 把命中块列表装进输出预算：整块装不下就把它**按条裁**（保留能装下的部分并标注 truncated），
   *  一条都装不下就停。返回 { blocks, truncated, keptMatches }。首个块超预算时也必须裁 —— 否则
   *  一个块就能把内核的 8000 字符回灌上限撞破（那会被内核挖掉中段，正是要避免的现象）。 */
  function fitBlocks(blocks, budget) {
    var B = toInt(budget, SEARCH_OUT_BUDGET, 200, 100000);
    var kept = [], size = 0, truncated = false, keptMatches = 0;
    for (var i = 0; i < (blocks || []).length; i++) {
      var b = blocks[i];
      var s = JSON.stringify(b).length;
      if (size + s <= B) { kept.push(b); size += s; keptMatches += (b.matches || []).length; continue; }
      // 按条裁剪当前块
      var room = B - size;
      var head = { path: b.path, totalLines: b.totalLines, matchCount: b.matchCount, matches: [], truncated: true };
      var headLen = JSON.stringify(head).length;
      if (room <= headLen) { truncated = true; break; }
      var ms = b.matches || [];
      for (var j = 0; j < ms.length; j++) {
        head.matches.push(ms[j]);
        if (JSON.stringify(head).length > room) { head.matches.pop(); break; }
      }
      if (head.matches.length) { kept.push(head); size += JSON.stringify(head).length; keptMatches += head.matches.length; }
      truncated = true;
      break;
    }
    if (keptMatches < (blocks || []).reduce(function (n, b) { return n + ((b.matches || []).length); }, 0)) truncated = true;
    return { blocks: kept, truncated: truncated };
  }

  var api = {
    sliceLines: sliceLines,
    globToRe: globToRe,
    searchText: searchText,
    fitBlocks: fitBlocks,
    LIMITS: {
      READ_DEF_LIMIT: READ_DEF_LIMIT, READ_MAX_LIMIT: READ_MAX_LIMIT, READ_MAX_BYTES: READ_MAX_BYTES, LINE_CLIP: LINE_CLIP,
      SEARCH_DEF_MAX: SEARCH_DEF_MAX, SEARCH_HARD_MAX: SEARCH_HARD_MAX, SEARCH_CTX_DEF: SEARCH_CTX_DEF,
      SEARCH_OUT_BUDGET: SEARCH_OUT_BUDGET, SEARCH_TIME_MS: SEARCH_TIME_MS, REGEX_MAX_LEN: REGEX_MAX_LEN,
    },
  };
  if (typeof window !== "undefined") window.__textSearch = api;
  // 仓库外 redteam 单测用（Node 无 window；本仓库 .js 默认按 CJS 解析，require 即可）
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
