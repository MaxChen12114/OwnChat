/* sim-kernel/trace.mjs — L9 契约·轨迹记录与分叉检测
   trace = 每 tick 的 {t, fingerprint, events, moved, blocked} 序列 + 存档头。
   用途：
   - 回归：同种子两跑 compare → identical=true 才算确定性过关（U28 闸门的底座）
   - 排查：分叉时 firstDivergence 直接报出第一个不同的回合号
   - 存档：dump() 纯 JSON；load 校验 schemaVersion
   记录是被动挂载：kernel 的 onDiff → trace.record(diff)，trace 自己不算指纹。 */

export const TRACE_SCHEMA = 1;

export function createTrace(world, meta = null) {
  const rows = [];

  function record(diff) {
    rows.push({
      t: diff.t,
      fp: diff.fingerprint,
      ev: (diff.events || []).map(e => e.id),          // 事件 id（内容在 events 账本，不重复存）
      moved: diff.moved,
      blocked: diff.blocked,
      ran: [...(diff.ran || [])],
    });
  }

  function dump() {
    return {
      schemaVersion: TRACE_SCHEMA,
      world: { W: world.W, H: world.H, seed: world.seed },
      meta: meta || null,
      rows: rows.map(r => ({ ...r, ran: [...r.ran], ev: [...r.ev] })),
      headFp: rows.length ? rows[rows.length - 1].fp : null,
    };
  }

  function load(d) {
    if (!d || d.schemaVersion !== TRACE_SCHEMA) {
      throw new TypeError(`trace schema 不匹配: 期望 ${TRACE_SCHEMA}，得到 ${d && d.schemaVersion}`);
    }
    if (!Array.isArray(d.rows)) throw new TypeError('trace rows 缺失');
    return d;
  }

  return Object.freeze({
    record, dump, load,
    count: () => rows.length,
    lastFp: () => rows.length ? rows[rows.length - 1].fp : null,
  });
}

/* 两条 trace 对比：逐行比指纹链。返回 { identical, firstDivergence, lenA, lenB }。
   identical = 行数相同且每行指纹/事件/移动全部一致。 */
export function compareTraces(a, b) {
  const ra = a.rows || a.dump().rows;
  const rb = b.rows || b.dump().rows;
  const n = Math.min(ra.length, rb.length);
  let firstDivergence = null;
  for (let k = 0; k < n; k++) {
    const x = ra[k], y = rb[k];
    if (x.t !== y.t || x.fp !== y.fp || x.moved !== y.moved || x.blocked !== y.blocked
      || x.ev.length !== y.ev.length || x.ran.join(',') !== y.ran.join(',')) {
      firstDivergence = x.t;
      break;
    }
  }
  const identical = firstDivergence === null && ra.length === rb.length;
  return { identical, firstDivergence, lenA: ra.length, lenB: rb.length };
}

/* 从 dump JSON 恢复成可对比对象（存档 vs 现跑 的回归场景） */
export function traceFromDump(d) {
  const parsed = (typeof d === 'string') ? JSON.parse(d) : d;
  if (!parsed || parsed.schemaVersion !== TRACE_SCHEMA) {
    throw new TypeError(`trace schema 不匹配: 期望 ${TRACE_SCHEMA}`);
  }
  return { rows: parsed.rows, dump: () => parsed };
}
