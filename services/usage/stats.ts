/**
 * Usage-log aggregation for the statistics card: per-day rows, a summary, a range series and the
 * heatmap. Pure input to output — this module does not even need a storage port, the caller hands
 * it the parsed log.
 *
 * Two log shapes are accepted: the current `{ "YYYY-MM-DD": { [deviceId]: { ... } } }` and the older
 * flat bucket (`{ cost, prompt, completion, requests }`), because a device can carry years of both.
 *
 * Streaks count a day as active when it has tokens or requests, and a run that has not used anything
 * yet today still counts from yesterday — that is the reading people expect from "current streak".
 * @module services/usage/stats
 */

export interface UsageModel {
  prompt: number;
  completion: number;
  requests: number;
  cost: number;
  estimated: number;
}

export interface UsageDay {
  prompt: number;
  completion: number;
  requests: number;
  cost: number;
  estimated: number;
  models: Record<string, UsageModel>;
  total: number;
}

export interface UsageSummary {
  totalTokens: number;
  totalRequests: number;
  totalCost: number;
  totalEstimated: number;
  activeDays: number;
  peakTokens: number;
  peakDate: string;
  currentStreak: number;
  longestStreak: number;
}

export interface UsageSeriesRow {
  date: string;
  label: string;
  prompt: number;
  completion: number;
  total: number;
  requests: number;
  cost: number;
  estimated: number;
  models: Record<string, UsageModel>;
}

export interface UsageHeatCell {
  date: string;
  total: number;
  requests: number;
  level: number;
  label: string;
}

export interface UsageResult {
  days: Record<string, UsageDay>;
  summary: UsageSummary;
  series(n?: number): UsageSeriesRow[];
  modelSeries(n?: number, topN?: number): { name: string; total: number; index: number; points: number[] }[];
  heatmap(weeks?: number): UsageHeatCell[];
}

const DAY = 86400000;

function toRecord(o: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) out[k] = v;
  return out;
}

export function pad(n: number): string { return String(n).padStart(2, "0"); }

export function dayKey(date?: Date): string {
  const d = date || new Date();
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

function parseDay(key: unknown): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function isFlat(e: unknown): boolean {
  if (typeof e !== "object" || e === null || Array.isArray(e)) return false;
  return ("cost" in e && typeof e.cost === "number")
    || ("requests" in e && typeof e.requests === "number")
    || ("prompt" in e && typeof e.prompt === "number")
    || ("completion" in e && typeof e.completion === "number");
}

function bucketsOf(dayEntry: unknown): Record<string, unknown>[] {
  if (typeof dayEntry !== "object" || dayEntry === null) return [];
  if (isFlat(dayEntry)) return [toRecord(dayEntry)];
  return Object.values(dayEntry).filter(function (b) { return !!b; });
}

function addModel(into: Record<string, UsageModel>, name: unknown, src: unknown): UsageModel {
  const key = String(name || "未知模型").slice(0, 120) || "未知模型";
  const m = into[key] || (into[key] = { prompt: 0, completion: 0, requests: 0, cost: 0, estimated: 0 });
  const r = (typeof src === "object" && src !== null) ? toRecord(src) : {};
  m.prompt += num(r.prompt);
  m.completion += num(r.completion);
  m.requests += num(r.requests);
  m.cost += num(r.cost);
  m.estimated += num(r.estimated);
  return m;
}

function emptyDay(): UsageDay {
  return { prompt: 0, completion: 0, requests: 0, cost: 0, estimated: 0, models: {}, total: 0 };
}

/** The whole log in one pass: per-day rows, the summary, the range series and the heatmap. */
export function build(log: unknown, now?: number | string | Date): UsageResult {
  const today = now ? new Date(now) : new Date();
  const logRec: Record<string, unknown> = (typeof log === "object" && log !== null) ? toRecord(log) : {};
  const days: Record<string, UsageDay> = {};
  Object.keys(logRec).sort().forEach(function (key) {
    const day = emptyDay();
    bucketsOf(logRec[key]).forEach(function (b) {
      day.prompt += num(b.prompt);
      day.completion += num(b.completion);
      day.requests += num(b.requests);
      day.cost += num(b.cost);
      day.estimated += num(b.estimated);
      const models = (typeof b.models === "object" && b.models !== null) ? toRecord(b.models) : null;
      if (models) {
        Object.keys(models).forEach(function (name) {
          addModel(day.models, name, models[name]);
        });
      }
    });
    day.total = day.prompt + day.completion;
    if (day.total || day.requests || day.cost) days[key] = day;
  });

  const keys = Object.keys(days).sort();
  let totalTokens = 0, totalRequests = 0, totalCost = 0, totalEstimated = 0;
  let peakTokens = 0, peakDate = "";
  keys.forEach(function (key) {
    const d = days[key];
    totalTokens += d.total;
    totalRequests += d.requests;
    totalCost += d.cost;
    totalEstimated += d.estimated;
    if (d.total > peakTokens) { peakTokens = d.total; peakDate = key; }
  });

  // A day counts toward a streak when it has tokens or requests.
  const active = keys.filter(function (k) { return days[k].total > 0 || days[k].requests > 0; });
  let longestStreak = 0, run = 0;
  let prev: Date | null = null;
  active.forEach(function (k) {
    const d = parseDay(k);
    if (!d) return;
    if (prev && Math.round((d.getTime() - prev.getTime()) / DAY) === 1) run += 1;
    else run = 1;
    if (run > longestStreak) longestStreak = run;
    prev = d;
  });
  const todayKey = dayKey(today);
  let currentStreak = 0;
  const cursorStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  // Nothing yet today: the current streak is still alive from yesterday.
  const isActive = function (k: string): boolean {
    const d = days[k];
    return !!d && (d.total > 0 || d.requests > 0);
  };
  let cursor = isActive(todayKey) ? cursorStart : new Date(cursorStart.getTime() - DAY);
  for (let i = 0; i < 400; i++) {
    const k = dayKey(cursor);
    if (!isActive(k)) break;
    currentStreak += 1;
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() - 1);
  }

  function series(n?: number): UsageSeriesRow[] {
    const count = Math.max(1, Math.min(400, Math.floor(Number(n) || 7)));
    const out: UsageSeriesRow[] = [];
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const startMs = start.getTime() - (count - 1) * DAY;
    for (let i = 0; i < count; i++) {
      const date = new Date(startMs + i * DAY);
      const key = dayKey(date);
      const d = days[key] || emptyDay();
      out.push({
        date: key,
        label: (date.getMonth() + 1) + "/" + date.getDate(),
        prompt: d.prompt, completion: d.completion, total: d.total,
        requests: d.requests, cost: d.cost, estimated: d.estimated,
        models: d.models || {},
      });
    }
    return out;
  }

  function modelSeries(n?: number, topN?: number): { name: string; total: number; index: number; points: number[] }[] {
    const count = Math.max(1, Math.min(400, Math.floor(Number(n) || 7)));
    const top = Math.max(1, Math.min(6, Math.floor(Number(topN) || 4)));
    const totals: Record<string, number> = {};
    keys.forEach(function (key) {
      const models = days[key].models || {};
      Object.keys(models).forEach(function (name) {
        totals[name] = (totals[name] || 0) + models[name].prompt + models[name].completion;
      });
    });
    const names = Object.keys(totals).sort(function (x, y) { return totals[y] - totals[x]; }).slice(0, top);
    const rows = series(count);
    return names.map(function (name, index) {
      return {
        name: name,
        total: totals[name],
        index: index,
        points: rows.map(function (row) {
          const m = row.models[name];
          return m ? (m.prompt + m.completion) : 0;
        }),
      };
    });
  }

/** Heat cells in week-column order, ready for a column-flow grid. */
  function heatmap(weeks?: number): UsageHeatCell[] {
    const w = Math.max(4, Math.min(53, Math.floor(Number(weeks) || 26)));
    const out: UsageHeatCell[] = [];
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const start = new Date(end.getTime() - (w * 7 - 1) * DAY);
    let max = 0;
    keys.forEach(function (key) { if (days[key].total > max) max = days[key].total; });
    for (let i = 0; i < w * 7; i++) {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const key = dayKey(date);
      const d = days[key] || { total: 0, requests: 0 };
      let level = 0;
      if (d.total > 0 || d.requests > 0) {
        const ratio = max ? d.total / max : 1;
        level = ratio > 0.66 ? 4 : ratio > 0.33 ? 3 : ratio > 0.12 ? 2 : 1;
      }
      out.push({
        date: key, total: d.total, requests: d.requests, level: level,
        label: key + " · " + d.total + " tokens · " + d.requests + " 次请求",
      });
    }
    return out;
  }

  return {
    days: days,
    summary: {
      totalTokens: totalTokens,
      totalRequests: totalRequests,
      totalCost: totalCost,
      totalEstimated: totalEstimated,
      activeDays: active.length,
      peakTokens: peakTokens,
      peakDate: peakDate,
      currentStreak: currentStreak,
      longestStreak: longestStreak,
    },
    series: series,
    modelSeries: modelSeries,
    heatmap: heatmap,
  };
}
