/**
 * The cost-log rules, minus the DOM: day-bucket folding, the four windows (today / 7 days / month /
 * total) and the two HTML fragments the settings card renders. Reads no storage, touches no DOM —
 * the wiring hands in the log, the clock keys and the device id.
 *
 * The per-device fold is accumulated beside the all-device fold rather than derived from it. A day
 * is bucketed by device so two machines merge instead of overwriting, and "this machine" is the only
 * figure the user can act on, so both come out of the same pass instead of re-summing each day.
 * @module services/ui/cost-log
 */

/** One day's totals. Every field is a plain number, zero when the bucket carries nothing. */
export interface CostDaySum {
  cost: number;
  prompt: number;
  completion: number;
  requests: number;
}

/** One rendered row: the day's totals plus the two facts the row shows beside them. */
export interface CostLogRow extends CostDaySum {
  date: string;
  localCost: number;
  multi: boolean;
}

/** The four windows and the two device-scoped variants the summary strip shows. */
export interface CostLogTotals {
  today: number;
  week: number;
  month: number;
  total: number;
  todayLocal: number;
  totalLocal: number;
  requests: number;
  anyMulti: boolean;
}

/** Summary strip + day rows, computed in one pass over the log. */
export interface CostLogAggregate extends CostLogTotals {
  /** Newest day first, the order the list renders in. */
  rows: CostLogRow[];
}

/**
 * Inputs the caller owns: the two date keys are passed in so a test can pin the clock, and `sumDay`
 * lets the host reuse its ledger fold (which also accumulates `estimated` and per-model buckets —
 * this module reads only the four shared fields).
 */
export interface CostLogContext {
  /** Local date key `YYYY-MM-DD` for "today". */
  today: string;
  /** Local date key for the oldest day still counted as "last 7 days". */
  weekStart: string;
  /** Device bucket to read for the "this machine" figures; null disables them. */
  deviceId: string | null;
  /** Optional host fold. Receives one day entry and returns any object carrying the four fields. */
  sumDay?: (dayEntry: unknown) => unknown;
}

/** Copy into a fresh record, or null when the value is not a plain object. Copying keeps callers
 * from mutating (or aliasing) whatever storage handed back. */
function recOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = item;
  return out;
}

/** Numbers only; anything else counts as zero so a corrupted bucket cannot poison a total. */
function numOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function addInto(out: CostDaySum, entry: Record<string, unknown>): void {
  out.cost += numOf(entry.cost);
  out.prompt += numOf(entry.prompt);
  out.completion += numOf(entry.completion);
  out.requests += numOf(entry.requests);
}

/**
 * A flat entry is the pre-bucketing shape (`{cost,prompt,...}` directly on the day). The check looks
 * at `cost`/`requests` only, matching what the ledger writes, so a bucket map that happens to hold a
 * key named `prompt` is still read as a bucket map.
 */
function isFlatEntry(entry: Record<string, unknown>): boolean {
  return typeof entry.cost === "number" || typeof entry.requests === "number";
}

/**
 * Local date key of a `Date`, `YYYY-MM-DD`.
 * @param date Instant to format; the caller decides which instant "today" means.
 * @returns The key with local-calendar fields, never UTC — the log is bucketed by the user's day.
 */
export function costDateKey(date: Date): string {
  return (
    date.getFullYear() +
    "-" +
    String(date.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(date.getDate()).padStart(2, "0")
  );
}

/**
 * Start of the seven-day window that ends today, counted as `now - 6 days`.
 * @param nowMs Epoch milliseconds treated as "now".
 * @returns Local date key of the oldest included day.
 */
export function costWeekStart(nowMs: number): string {
  return costDateKey(new Date(nowMs - 6 * 86400000));
}

/**
 * Sum one day entry across every device bucket.
 * @param dayEntry Either a flat entry or a `{deviceId: bucket}` map; anything else yields zeros.
 * @returns The four totals; the object is always fresh, never aliased to the input.
 */
export function costDaySum(dayEntry: unknown): CostDaySum {
  const out: CostDaySum = { cost: 0, prompt: 0, completion: 0, requests: 0 };
  const day = recOf(dayEntry);
  if (!day) return out;
  const buckets: unknown[] = isFlatEntry(day) ? [day] : Object.values(day);
  for (const bucket of buckets) {
    const rec = recOf(bucket);
    if (rec) addInto(out, rec);
  }
  return out;
}

/**
 * Sum one day entry for a single device.
 * @param dayEntry Flat entry or device-keyed map.
 * @param deviceId Bucket to read; null (or a missing bucket) yields zeros.
 * @returns The four totals for that device only.
 */
export function costDayDeviceSum(dayEntry: unknown, deviceId: string | null): CostDaySum {
  const out: CostDaySum = { cost: 0, prompt: 0, completion: 0, requests: 0 };
  const day = recOf(dayEntry);
  if (!day || !deviceId) return out;
  if (isFlatEntry(day)) {
    addInto(out, day);
    return out;
  }
  const bucket = recOf(day[deviceId]);
  if (bucket) addInto(out, bucket);
  return out;
}

/**
 * Whether a day holds more than one device bucket.
 * @param dayEntry Flat entry or device-keyed map; flat days are single-device by definition.
 * @returns True only for a bucket map with two or more keys — the cue for the "多设备" tag.
 */
export function costDayIsMulti(dayEntry: unknown): boolean {
  const day = recOf(dayEntry);
  if (!day || isFlatEntry(day)) return false;
  return Object.keys(day).length > 1;
}

/**
 * Fold the whole log into the four windows plus one row per day.
 * @param log `{ [YYYY-MM-DD]: dayEntry }` as stored; unknown shapes are tolerated and count as zero.
 * @param ctx Clock keys, device id and the optional host fold.
 * @returns Totals and rows; rows are ordered newest day first.
 */
export function costLogAggregate(log: Record<string, unknown>, ctx: CostLogContext): CostLogAggregate {
  const monthPrefix = ctx.today.slice(0, 7);
  const rows: CostLogRow[] = [];
  const totals: CostLogAggregate = {
    rows,
    today: 0,
    week: 0,
    month: 0,
    total: 0,
    todayLocal: 0,
    totalLocal: 0,
    requests: 0,
    anyMulti: false,
  };
  const days = Object.keys(log).sort().reverse();
  for (const date of days) {
    const entry = log[date];
    const all = ctx.sumDay ? sumViaPort(ctx.sumDay, entry) : costDaySum(entry);
    const local = costDayDeviceSum(entry, ctx.deviceId);
    const multi = costDayIsMulti(entry);
    if (multi) totals.anyMulti = true;
    totals.total += all.cost;
    totals.requests += all.requests;
    totals.totalLocal += local.cost;
    if (date === ctx.today) {
      totals.today += all.cost;
      totals.todayLocal += local.cost;
    }
    if (date >= ctx.weekStart) totals.week += all.cost;
    if (date.startsWith(monthPrefix)) totals.month += all.cost;
    rows.push({
      date,
      cost: all.cost,
      prompt: all.prompt,
      completion: all.completion,
      requests: all.requests,
      localCost: local.cost,
      multi,
    });
  }
  return totals;
}

/** The host fold may return anything; keep only the four totals this module understands. */
function sumViaPort(sumDay: (dayEntry: unknown) => unknown, dayEntry: unknown): CostDaySum {
  const rec = recOf(sumDay(dayEntry));
  if (!rec) return costDaySum(dayEntry);
  return {
    cost: numOf(rec.cost),
    prompt: numOf(rec.prompt),
    completion: numOf(rec.completion),
    requests: numOf(rec.requests),
  };
}

/**
 * The four-cell summary strip.
 * @param totals Aggregate figures; `anyMulti` switches the labels to "all devices" and adds the
 *   per-machine sub-lines.
 * @returns HTML for the `#costSummary` container. Costs render at four decimals.
 */
export function costSummaryHtml(totals: CostLogTotals): string {
  const multi = totals.anyMulti;
  const todaySub = multi
    ? '<span class="cost-sub">本机 ¥' + totals.todayLocal.toFixed(4) + "</span>"
    : "";
  const totalSub = multi
    ? '<span class="cost-sub">本机 ¥' + totals.totalLocal.toFixed(4) + " · " + totals.requests + " 次请求</span>"
    : '<span class="cost-sub">' + totals.requests + " 次请求</span>";
  return (
    '<div class="cost-cell"><span class="cost-label">今日' + (multi ? "(合计)" : "") +
    '</span><span class="cost-val">¥' + totals.today.toFixed(4) + "</span>" + todaySub + "</div>" +
    '<div class="cost-cell"><span class="cost-label">近 7 日</span><span class="cost-val">¥' +
    totals.week.toFixed(4) + "</span></div>" +
    '<div class="cost-cell"><span class="cost-label">本月</span><span class="cost-val">¥' +
    totals.month.toFixed(4) + "</span></div>" +
    '<div class="cost-cell total"><span class="cost-label">总计' + (multi ? "(全设备)" : "") +
    '</span><span class="cost-val">¥' + totals.total.toFixed(4) + "</span>" + totalSub + "</div>"
  );
}

/**
 * The per-day list, or the empty-state line when the log has no days.
 * @param aggregate Rows come from {@link costLogAggregate}, already newest first.
 * @returns HTML for the `#costDailyList` container. Day amounts render at five decimals and the
 *   per-machine figure appears only on multi-device days.
 */
export function costDailyListHtml(aggregate: CostLogAggregate): string {
  if (!aggregate.rows.length) {
    return '<div class="cost-empty">暂无数据。快速档下发出第一条计费消息后开始记录。</div>';
  }
  return aggregate.rows
    .map((row) => {
      const localTag = row.multi
        ? '<span class="cost-meta">本机 ¥' + row.localCost.toFixed(5) + "</span>"
        : "";
      return (
        '<div class="cost-row"><span class="cost-date">' + row.date +
        (row.multi ? ' <span class="cost-meta">· 多设备</span>' : "") + "</span>" +
        '<span class="cost-amt">¥' + row.cost.toFixed(5) + "</span>" +
        '<span class="cost-meta">' + row.requests + " 次 · in " + row.prompt + " / out " + row.completion +
        "</span>" + localTag + "</div>"
      );
    })
    .join("");
}

/**
 * The card shell that is inserted into the settings slot.
 * @returns HTML for the card body, including the summary and list containers and the three buttons.
 *   The copy is user-visible text and is not translated by comment-cleanup passes.
 */
export function costCardHtml(): string {
  return (
    '<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/><path d="M7 15h3"/></svg>用量与费用日志（API 调用）</h4>' +
    '<p>快速档按 token 实时计费（默认走 DeepSeek 官方，渠道见「设置→模型 API」）；免费档也记录 token 用量（费用为 0）。记录在本地（LS <code>cfw_cost_log_v1</code>），开启云同步后按设备分桶跨设备合并。</p>' +
    '<div id="costSummary" class="cost-summary"></div>' +
    '<div id="costDailyList" class="cost-daily"></div>' +
    '<div class="rowline" style="margin-top:10px;"><div></div><div class="btns">' +
    '<button class="smallbtn" id="costSyncNowBtn">同步费用</button>' +
    '<button class="smallbtn" id="costExportBtn">导出 JSON</button>' +
    '<button class="smallbtn danger" id="costClearBtn">清空日志</button>' +
    "</div></div>"
  );
}

/**
 * The export payload shown to the user.
 * @param log Whatever the host read from storage; passed through verbatim.
 * @returns Pretty-printed JSON, two-space indent.
 */
export function costLogJson(log: unknown): string {
  return JSON.stringify(log, null, 2);
}
