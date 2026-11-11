/* sim-kernel/events.mjs — L4 情景·事件队列
   规格 §6：时间触发（scenario 的 at）与条件触发（metric 阈值）走同一条队列，不各搞一套。
   定序 = (tick, id)：id 由 emit 顺序单调分配，提交序即权威序 —— 回放一致（与 overlay seq 同哲学）。
   条件触发按 key 永久去重（一次情景只触发一次；回落再超阈不重放）。
   事件全部可序列化（能进 trace）。 */

export function createEvents() {
  const pending = [];                  // 待触发 { id, at, type, payload }
  const handlers = new Map();          // type -> [fn]（注册顺序即调用顺序）
  const conditions = [];               // { cond, then, key }
  const firedKeys = new Set();
  let nextId = 0;
  let nowTick = 0;

  /* 排一个事件。at = 生效回合号。at <= 当前 tick 的会在下一次 tick() 立即派发，不丢。 */
  function emit({ type, at, payload = null }) {
    if (!type || typeof type !== 'string') throw new TypeError('事件 type 必须是非空字符串');
    const t = at | 0;
    if (!(t >= 0)) throw new TypeError(`事件 at 必须是非负整数回合号，得到 ${at}`);
    const ev = { id: nextId++, at: t, type, payload };
    pending.push(ev);
    return ev.id;
  }

  /* 注册处理器（同类型按注册顺序调用）；返回退订函数 */
  function on(type, fn) {
    if (!handlers.has(type)) handlers.set(type, []);
    const list = handlers.get(type);
    list.push(fn);
    return () => {
      const k = list.indexOf(fn);
      if (k >= 0) list.splice(k, 1);
    };
  }

  /* 注册条件触发：metrics[metric] 满足 op value → 派发 then 事件（key 去重） */
  function when(cond, then, key = null) {
    if (!cond || !cond.metric) throw new TypeError('条件触发需要 {metric, op, value}');
    const ops = new Set(['>', '<', '>=', '<=', '==', '!=']);
    if (!ops.has(cond.op)) throw new TypeError(`条件 op "${cond.op}" 不合法（可用: ${[...ops].join(' ')}）`);
    const k = key || `${cond.metric}${cond.op}${cond.value}->${then.type}`;
    conditions.push({ cond, then, key: k });
    return k;
  }

  function satisfied(cond, metrics) {
    const v = metrics ? metrics[cond.metric] : undefined;
    if (v === undefined) return false;
    switch (cond.op) {
      case '>': return v > cond.value;
      case '<': return v < cond.value;
      case '>=': return v >= cond.value;
      case '<=': return v <= cond.value;
      case '==': return v === cond.value;
      case '!=': return v !== cond.value;
    }
    return false;
  }

  const CMP = (a, b) => a.at - b.at || a.id - b.id;

  /* 推进到 tick t：先评估条件触发（无到期事件也要评），再派发到期事件。
     条件派发的新事件若 at <= t 同轮继续派发（链式），上限 4 层防死循环。 */
  function tick(t, metrics = null) {
    nowTick = t;
    const dispatched = [];
    for (let round = 0; round < 4; round++) {
      // ① 条件评估（key 永久去重）——必须在派发之前，否则"无到期事件"的 tick 会跳过评估
      for (const c of conditions) {
        if (firedKeys.has(c.key)) continue;
        if (satisfied(c.cond, metrics)) {
          firedKeys.add(c.key);
          emit({ type: c.then.type, at: t, payload: c.then.payload ?? null });
        }
      }
      // ② 派发到期事件（(at,id) 序）
      const due = [];
      for (let k = 0; k < pending.length; k++) if (pending[k].at <= t) due.push(pending[k]);
      if (!due.length) break;
      due.sort(CMP);
      const dueIds = new Set(due.map(e => e.id));
      for (let k = pending.length - 1; k >= 0; k--) {
        if (dueIds.has(pending[k].id)) pending.splice(k, 1);
      }
      for (const ev of due) {
        dispatched.push(ev);
        const list = handlers.get(ev.type);
        if (list) for (const fn of list) fn(ev, t);
      }
    }
    return dispatched;
  }

  function reset() {                     // 情景重开：清队列与触发记录，订阅保留
    pending.length = 0;
    firedKeys.clear();
    nextId = 0;
    nowTick = 0;
  }

  return Object.freeze({
    emit, on, when, tick, reset,
    pendingCount: () => pending.length,
    now: () => nowTick,
    fired: () => [...firedKeys],
  });
}
