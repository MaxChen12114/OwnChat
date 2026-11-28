/**
 * The status panel's brain, minus the DOM: number formatting, the context-window lookup, the manual
 * limit parser, the context snapshot (how many tokens each payload block costs), and the HTML for the
 * four sections.
 *
 * The snapshot math is the part worth locking: it must agree with what actually gets sent, or the
 * capacity card lies. Three rules carry history:
 *  - Uploaded documents count through the app's own `attFileTokens` — the truncated amount is what
 *    actually goes out. Pending (not yet sent) attachments are estimated here with the same shape, and
 *    the two never overlap: after sending, `takePending` moves the text into the session.
 *  - Lorebook entries are matched against the last 6 messages — the same input the send path uses, or
 *    the panel would disagree with the request.
 *  - The context window is only ever detected from the worker's `APP_CTX_EXACT` / `APP_CTX_HINTS`
 *    (upstream /v1/models responses do not carry window sizes). No local fallback table: a copied
 *    table drifts from the worker config silently, which is why this used to be wrong.
 *
 * The manual-limit parser accepts what people actually type — `1000000`, `100万`, `1m`, `128k` —
 * because a number input silently swallowed `100万` and the user's value vanished.
 * @module services/ui/status-panel
 */

function recOf(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

export const DEFAULT_CTX = 131072;

/** Section categories, in the order the card lists them. Labels are panel copy. */
export interface Cat {
  key: string;
  name: string;
  color: string;
  lore?: boolean;
}

export function makeCats(accent: string): Cat[] {
  return [
    { key: "msgTokens", name: "消息历史", color: accent },
    { key: "attTokens", name: "上传文档", color: accent },
    { key: "sumTokens", name: "记忆摘要", color: accent },
    { key: "loreTokens", name: "设定集", color: accent, lore: true },
    { key: "cardTokens", name: "角色卡·人设", color: accent },
    { key: "presetTokens", name: "预设·技能", color: accent },
    { key: "reasoningTokens", name: "思考归档", color: accent },
  ];
}

/** Numbers as k/M abbreviations; `—` for anything that is not a finite number. Numeric strings pass. */
export function fmtTok(n: unknown): string {
  if (n == null) return "—";
  const num = Number(n);
  if (isNaN(num)) return "—";
  const v = Math.round(num);
  if (v >= 1e6) {
    const m = v / 1e6;
    return (m < 10 ? m.toFixed(1) : String(Math.round(m))) + "M";
  }
  if (v >= 1e3) {
    const k = v / 1e3;
    return (k < 10 ? k.toFixed(1) : String(Math.round(k))) + "k";
  }
  return String(v);
}

export function fmtPct(p: number): string {
  return (p * 100).toFixed(p > 0 && p < 0.01 ? 2 : 1) + "%";
}

/** `42 秒前` / `3 分钟前` / `2 小时前`; empty timestamp reads `—`. */
export function fmtAgo(ts: unknown, now: number): string {
  if (!ts) return "—";
  const s = Math.max(0, Math.round((now - Number(ts)) / 1000));
  return s < 60 ? s + " 秒前" : s < 3600 ? Math.round(s / 60) + " 分钟前" : Math.round(s / 3600) + " 小时前";
}

/** Look up the window for a model id: exact id first, then hint regexes; 0 means "unknown". */
export function detectCtx(modelId: unknown, exact: unknown, hints: unknown): number {
  const s = String(modelId || "");
  if (!s) return 0;
  const ex = recOf(exact);
  const hit = ex[s];
  if (typeof hit === "number") return hit;
  const hs = Array.isArray(hints) ? hints : [];
  for (let i = 0; i < hs.length; i++) {
    const h = hs[i];
    if (!Array.isArray(h) || h.length < 2) continue;
    try {
      if (new RegExp(String(h[0]), "i").test(s)) return Number(h[1]);
    } catch (e) {}
  }
  return 0;
}

/** manual > detected > default; a manual value below 1024 is treated as not set. */
export function resolveCtxWindow(manual: number, detected: number): number {
  if (manual && manual >= 1024) return manual;
  return detected || DEFAULT_CTX;
}

/**
 * Parse the manual limit field. Accepts `1000000`, `100万`, `1m`, `128k`, `2千`, `5w` and plain
 * numbers with spaces/commas; anything else is NaN and the caller restores the effective value.
 */
export function parseCtxInput(raw: unknown): number {
  const s = String(raw == null ? "" : raw).trim().toLowerCase().replace(/[\s,_]/g, "");
  if (!s) return NaN;
  const m = s.match(/^([0-9]*\.?[0-9]+)(万|千|m|k|w)?$/);
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  if (!isFinite(n)) return NaN;
  const u = m[2];
  const mult = u === "万" || u === "w" ? 1e4 : u === "m" ? 1e6 : u === "千" || u === "k" ? 1e3 : 1;
  return Math.round(n * mult);
}

export interface EstimateSource {
  estimateTokens?: (t: string) => number;
  getSessionMessages?: () => unknown[] | null;
  getLastRequestStats?: () => unknown;
  attFileTokens?: (m: unknown) => number | null;
}

export interface CollectSources {
  app?: EstimateSource;
  lorebook?: { getActiveEntries?: (q: unknown) => unknown[] | null };
  skills?: { buildCatalogPrompt?: () => string };
  character?: { getActiveCard?: () => unknown };
  attach?: { list?: () => unknown[] | null };
  cost?: { getCostStats?: () => unknown; getUsageStats?: () => unknown };
  sync?: { getStatus?: () => unknown };
  storage: { getItem(k: string): string | null };
  /** The active conversation's summary text. Required: the summary table and its legacy key are
   *  owned by `services/conv/summary.ts`, so this card must not read a storage key of its own. */
  summaryText: () => string;
  modelId: string;
  now?: () => number;
}

export interface CtxSnapshot {
  total: number;
  msgs: number;
  msgTokens: number;
  reasoningTokens: number;
  sumTokens: number;
  loreTokens: number;
  loreCount: number;
  attTokens: number;
  cardTokens: number;
  presetTokens: number;
  skillTokens: number;
  summaryTrigger: number;
  lastReq: unknown;
  usage: unknown;
  sync: unknown;
  cost: unknown;
  mode: string;
  model: string;
}

/** One snapshot for both hosts. Every source read is guarded: a missing module costs 0, not a crash. */
export function collectSnapshot(src: CollectSources): CtxSnapshot {
  const app = src.app || {};
  const est = (t: unknown): number => {
    try {
      return app.estimateTokens ? app.estimateTokens(String(t || "")) : 0;
    } catch (e) {
      return 0;
    }
  };
  const msgs = app.getSessionMessages ? app.getSessionMessages() || [] : [];
  const card = src.character && src.character.getActiveCard ? src.character.getActiveCard() : null;
  const last6 = msgs.slice(-6).map((m) => String(recOf(m).content || "")).join("\n");

  let loreTokens = 0;
  let loreCount = 0;
  try {
    const entries = src.lorebook && src.lorebook.getActiveEntries
      ? src.lorebook.getActiveEntries({ text: last6, cardId: String(recOf(card).id || "") })
      : [];
    loreCount = entries.length;
    loreTokens = est(entries.map((e) => recOf(e).name ? String(recOf(e).name) + "\n" + String(recOf(e).content || "") : String(recOf(e).content || "")).join("\n"));
  } catch (e) {}

  let skillsText = "";
  try {
    skillsText = src.skills && src.skills.buildCatalogPrompt ? src.skills.buildCatalogPrompt() : "";
  } catch (e) {}

  let presetsText = "";
  try {
    const arr = JSON.parse(src.storage.getItem("cfw_prompt_presets_v1") || "[]");
    presetsText = (Array.isArray(arr) ? arr : [])
      .filter((p) => p && recOf(p).enabled)
      .map((p) => String(recOf(p).content || ""))
      .join("\n");
  } catch (e) {}

  let msgTokens = 0;
  let reasoningTokens = 0;
  let attTokens = 0;
  const attTk = app.attFileTokens || null;
  msgs.forEach((m) => {
    const rec = recOf(m);
    msgTokens += est(rec.content);
    if (typeof rec.reasoning_content === "string") reasoningTokens += est(rec.reasoning_content);
    if (attTk) {
      try {
        attTokens += attTk(m) || 0;
      } catch (e) {}
    }
  });
  try {
    const pend = src.attach && src.attach.list ? src.attach.list() || [] : [];
    pend.forEach((p) => {
      const rec = recOf(p);
      if (rec.kind === "text") attTokens += est("【文件:" + String(rec.name || "") + "】" + String(rec.text || ""));
    });
  } catch (e) {}

  const sumText = String(src.summaryText() || "");
  const sumTokens = est(sumText);
  const cardTokens = est(card ? JSON.stringify(card) : "");
  const presetTokens = est(presetsText);
  const skillTokens = est(skillsText);
  const total = msgTokens + attTokens + sumTokens + loreTokens + cardTokens + presetTokens + skillTokens + reasoningTokens;

  let cost: unknown = null;
  try {
    cost = src.cost && src.cost.getCostStats ? src.cost.getCostStats() : null;
  } catch (e) {}
  let usage: unknown = null;
  try {
    usage = src.cost && src.cost.getUsageStats ? src.cost.getUsageStats() : null;
  } catch (e) {}
  let sync: unknown = null;
  try {
    sync = src.sync && src.sync.getStatus ? src.sync.getStatus() : null;
  } catch (e) {}

  return {
    total: total,
    msgs: msgs.length,
    msgTokens: msgTokens,
    reasoningTokens: reasoningTokens,
    sumTokens: sumTokens,
    loreTokens: loreTokens,
    loreCount: loreCount,
    attTokens: attTokens,
    cardTokens: cardTokens,
    presetTokens: presetTokens,
    skillTokens: skillTokens,
    summaryTrigger: parseInt(src.storage.getItem("cfw_summary_trigger") || "30", 10) || 30,
    lastReq: app.getLastRequestStats ? app.getLastRequestStats() : null,
    usage: usage,
    sync: sync,
    cost: cost,
    mode: src.storage.getItem("cfw_mode") === "fast" ? "快速" : "免费",
    model: src.modelId || "—",
  };
}

export interface UsageStatsLike {
  summary?: Record<string, unknown> | null;
  series(range: number): { label?: string; total?: number }[];
  modelSeries(range: number, top: number): { name?: string; points?: number[] }[];
  heatmap(weeks: number): { level?: number; label?: string }[];
}

const TREND_COLORS = ["var(--accent, #7fa4c9)", "#5aa9a3", "#d08a4a", "#9b7fd1"];
const TREND_W = 300;
const TREND_H = 92;
const TREND_PAD_Y = 8;

/** The usage card: five numbers, the 26-week heatmap, the 7/30-day trend, and the estimate note. */
export function usageHtml(u: UsageStatsLike | null, rangeIn: number, esc: (s: unknown) => string): string {
  if (!u || !u.summary) return '<div class="sp-empty">用量模块未加载。</div>';
  const range = rangeIn === 30 ? 30 : 7;
  const sum = recOf(u.summary);
  const series = u.series(range);
  const models = u.modelSeries(range, 4);
  const totalTokens = Number(sum.totalTokens) || 0;
  const totalRequests = Number(sum.totalRequests) || 0;
  const hasData = totalTokens > 0 || totalRequests > 0;
  const max = Math.max(1, ...series.map((s) => Number(s.total) || 0));
  const x = (i: number) => (series.length <= 1 ? TREND_W / 2 : i * (TREND_W / (series.length - 1)));
  const y = (v: number) => TREND_H - TREND_PAD_Y - (v / max) * (TREND_H - TREND_PAD_Y * 2);
  const linePath = (pts: number[]) => pts.map((v, i) => (i ? "L" : "M") + x(i).toFixed(1) + "," + y(v).toFixed(1)).join(" ");
  const lines = (models.length ? models : [{ name: "全部模型", points: series.map((s) => Number(s.total) || 0) }])
    .map((m, i) => ({ name: m.name || "", points: m.points || [], color: TREND_COLORS[i % TREND_COLORS.length] }));
  const heat = u.heatmap(26);
  const heatHtml = heat.map((c) => '<i class="sp-heat-i l' + (c.level || 0) + '" title="' + esc(c.label) + '"></i>').join("");
  const rangeBtn = (n: number) => '<button type="button" class="sp-range-btn' + (range === n ? " on" : "") + '" data-sp-range="' + n + '">' + n + "日</button>";
  const peakLabel = sum.peakDate ? String(sum.peakDate).slice(5) : "—";
  const totalCost = Number(sum.totalCost) || 0;
  const costText = totalCost > 0 ? " · ¥" + totalCost.toFixed(4) : "";
  const gridLines = [0.25, 0.5, 0.75]
    .map((r) => '<line x1="0" y1="' + (TREND_H * r).toFixed(1) + '" x2="' + TREND_W + '" y2="' + (TREND_H * r).toFixed(1) + '"/>')
    .join("");
  const first = series[0] || {};
  const last = series[series.length - 1] || {};
  return (
    '<div class="sp-row sp-head"><span class="sp-title">使用统计</span><span class="sp-range">' + rangeBtn(7) + rangeBtn(30) + "</span></div>" +
    '<div class="sp-stats">' +
    '<div class="sp-stat wide"><b>' + fmtTok(totalTokens) + "</b><span>累计 Token · " + totalRequests + " 次请求" + costText + "</span></div>" +
    '<div class="sp-stat"><b>' + fmtTok(sum.peakTokens) + "</b><span>峰值 · " + esc(peakLabel) + "</span></div>" +
    '<div class="sp-stat"><b>' + (Number(sum.activeDays) || 0) + " 天</b><span>活跃天数</span></div>" +
    '<div class="sp-stat"><b>' + (Number(sum.currentStreak) || 0) + " 天</b><span>当前连续</span></div>" +
    '<div class="sp-stat"><b>' + (Number(sum.longestStreak) || 0) + " 天</b><span>最长连续</span></div>" +
    "</div>" +
    '<div class="sp-heat">' + heatHtml + "</div>" +
    '<div class="sp-heat-legend">少 <i style="opacity:.2"></i><i style="opacity:.4"></i><i style="opacity:.68"></i><i></i> 多</div>' +
    (hasData
      ? '<svg class="sp-trend" viewBox="0 0 ' + TREND_W + " " + TREND_H + '" preserveAspectRatio="none" role="img" aria-label="每日 Token 趋势">' +
        '<g class="sp-trend-grid">' + gridLines + "</g>" +
        lines.map((l) => '<path d="' + linePath(l.points) + '" fill="none" stroke="' + l.color + '" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>').join("") +
        "</svg>" +
        '<div class="sp-trend-x"><span>' + esc(first.label || "") + "</span><span>" + esc(last.label || "") + "</span></div>" +
        '<div class="sp-legend">' + lines.map((l) => '<span><i style="background:' + l.color + '"></i>' + esc(l.name) + "</span>").join("") + "</div>"
      : '<div class="sp-empty">还没有用量记录。发一条消息后开始统计。</div>') +
    ((Number(sum.totalEstimated) || 0) ? '<div class="sp-note">含 ' + sum.totalEstimated + ' 次估算（上游未回 usage，免费档常见）。</div>' : "")
  );
}

/** The seven capacity rows; the share is measured against the effective window. */
export function catRowsHtml(s: CtxSnapshot, ctx: number, accent: string, esc: (s: unknown) => string): string {
  return makeCats(accent)
    .map((c) => {
      const v = Number(recOf(s)[c.key]) || 0;
      const sub = c.lore && s.loreCount ? " · " + s.loreCount + "条" : "";
      return (
        '<div class="sp-cat"><span class="sp-dot" style="background:' + c.color + '"></span>' +
        '<span class="sp-cat-name">' + esc(c.name) + sub + "</span>" +
        '<span class="sp-cat-val">' + fmtTok(v) + " · " + fmtPct(ctx ? v / ctx : 0) + "</span></div>"
      );
    })
    .join("");
}

/** The last-request block: estimated output vs real usage are different rows on purpose. */
export function lastReqHtml(lr: unknown, esc: (s: unknown) => string, now: number): string {
  if (!lr) return '<div class="sp-empty">发送一条消息后显示真实 usage / 耗时。</div>';
  const r = recOf(lr);
  const rows: [string, string][] = [];
  rows.push(["模型", esc(r.model || "—") + " · " + esc(r.mode || "—")]);
  if (r.est) {
    rows.push(["输出", fmtTok(r.outEstimate) + " tok(估算)"]);
    rows.push(["Prompt/Completion", "上游未回 usage"]);
  } else {
    rows.push(["Prompt / Completion", fmtTok(r.prompt) + " / " + fmtTok(r.completion)]);
    rows.push(["Total", fmtTok(r.total) + " tok"]);
    if (r.cacheHit != null && r.prompt) {
      rows.push(["缓存命中", Math.round((Number(r.cacheHit) / Math.max(1, Number(r.prompt))) * 100) + "%"]);
    }
  }
  if (r.ms) rows.push(["耗时", r.ms + " ms"]);
  rows.push(["时间", fmtAgo(r.at, now)]);
  return rows.map((row) => '<div class="sp-kv"><span class="k">' + row[0] + '</span><span class="v">' + row[1] + "</span></div>").join("");
}

/** The system block: sync state, today's cost (fast mode only), and the summary countdown. */
export function sysHtml(s: CtxSnapshot, esc: (s: unknown) => string): string {
  const rows: [string, string][] = [];
  const sc = recOf(s.sync);
  if (sc) {
    const enabled = !!sc.enabled;
    const st = !enabled ? "关" : sc.paused ? "已暂停" : "开启";
    rows.push(["云同步", esc(st) + (enabled ? " · push " + (Number(sc.pushCount) || 0) + "/1000" : "")]);
    if (enabled && sc.lastPush) rows.push(["上次推送", fmtAgo(sc.lastPush, Date.now())]);
  }
  const cost = recOf(s.cost);
  rows.push(["今日费用", s.mode === "快速" && cost ? "¥" + Number(cost.today || 0).toFixed(4) : "免费模式 · 不计费"]);
  rows.push(["会话消息", s.msgs + " 条"]);
  const left = s.summaryTrigger - s.msgs;
  rows.push(["历史压缩", s.msgs + "/" + s.summaryTrigger + " 条" + (left <= 0 ? ' <span class="sp-warn">将触发摘要</span>' : "")]);
  return rows.map((row) => '<div class="sp-kv"><span class="k">' + row[0] + '</span><span class="v">' + row[1] + "</span></div>").join("");
}
