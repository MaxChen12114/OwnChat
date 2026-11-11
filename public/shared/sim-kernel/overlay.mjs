/* sim-kernel/overlay.mjs — 世界改动层（事件溯源）
   铁律 1 的实现形态：base（牌桌）不可变，agent/玩家的改动 = 只追加的事件流。
   每条事件带 who/t —— 归因免费（点格子问"谁在第几回合改的"）、回放免费
   （回放 = base + 事件序列前缀，确定性不破）。
   撤销 = 截断到某个 seq 再重放（不做单条反向撤销：后面有人基于被撤状态做过
   决策时，单条撤销会让世界不自洽——"信息已泄漏"问题）。
   本模块只管账本（append/校验/截断）；投影（base+事件→当前世界）在 U20。 */

import { TERR } from './world.mjs';

export const OPS = ['terrain', 'zone', 'bh', 'road', 'building', 'facility', 'remove'];

export function createOverlay(world) {
  const N = world.W * world.H;
  const events = [];
  let seq = 0;

  /* append(event) → seq。event = { t, who, op, cells, from?, to, note? }
     校验失败给人话报错（哪条字段、为什么），绝不静默吞。 */
  function append(e) {
    if (!e || typeof e !== 'object') throw new TypeError('append 需要一个事件对象');
    const t = e.t | 0;
    if (!(t >= 0) || String(e.t).includes('.')) throw new TypeError(`事件 t 必须是非负整数回合号，得到 ${e.t}`);
    if (!e.who || typeof e.who !== 'string') throw new TypeError('事件 who 必须是非空字符串（谁改的）');
    if (!OPS.includes(e.op)) throw new TypeError(`事件 op "${e.op}" 不合法（可用: ${OPS.join('/')}）`);
    if (!Array.isArray(e.cells) || e.cells.length === 0) throw new TypeError('事件 cells 必须是非空数组');
    const cells = e.cells.map(v => v | 0);
    for (const i of cells) {
      if (!(i >= 0) || i >= N) throw new RangeError(`cells 越界: 索引 ${i}，世界 ${world.W}×${world.H}=${N} 格`);
    }
    if (e.to == null) throw new TypeError('事件 to 不能为空（改成什么）');
    if (e.op === 'terrain' && !Object.values(TERR).includes(e.to)) {
      throw new TypeError(`terrain 事件 to=${e.to} 不是合法地形枚举（0..4）`);
    }

    const ev = Object.freeze({
      t, seq: ++seq,
      who: e.who, op: e.op, cells,
      from: e.from == null ? null : e.from,   // from 只记账（审计）；并发冲突校验在裁决层
      to: e.to,
      note: e.note == null ? '' : String(e.note).slice(0, 200),
    });
    events.push(ev);
    return ev.seq;
  }

  /* 截断到 seq ≤ s（撤销语义）。返回删掉的事件数。seq 退回到截断点，之后 append 继续编号。 */
  function truncate(s) {
    let removed = 0;
    while (events.length && events[events.length - 1].seq > s) { events.pop(); removed++; }
    seq = events.length ? events[events.length - 1].seq : 0;
    return removed;
  }

  /* 只读快照（深拷贝，改快照不伤账本） */
  function snapshot() { return events.map(e => ({ ...e, cells: [...e.cells] })); }

  /* 投影：base + 事件（seq ≤ atSeq）→ 当前世界视图。这是"当前世界"和"回放到任意回合"
     的唯一实现——同一份代码，atSeq=null 给实时视图，atSeq=S 给时间轴回放。
     返回冻结视图 + 归因表（每格最后写入者）。base 永远不被碰。 */
  let projCache = { seq: -1, atSeq: null, view: null };   // GF9：(seq, atSeq) 键缓存，append/truncate 改 seq 即失效
  function project(atSeq = null) {
    if (projCache.view && projCache.seq === seq && projCache.atSeq === (atSeq == null ? null : atSeq)) {
      return projCache.view;                         // seq 不变直接给同一冻结对象，UI 每帧调不产垃圾
    }
    const j = world.toJSON();                        // base 深拷贝（terr/zone/bh 一次拿全，base 永不被碰）
    const terr = Uint8Array.from(j.terr);
    const zone = Uint8Array.from(j.zone);
    const bh = Float32Array.from(j.bh);
    const owner = new Map();                         // cell -> { seq, who, op, to, t }
    const facilities = [];

    const limit = atSeq == null ? Infinity : atSeq;
    for (const ev of events) {
      if (ev.seq > limit) break;
      for (const i of ev.cells) {
        if (ev.op === 'terrain') { terr[i] = ev.to; owner.set(i, ev); }
        else if (ev.op === 'zone') { zone[i] = ev.to; owner.set(i, ev); }
        else if (ev.op === 'bh') { bh[i] = ev.to; owner.set(i, ev); }
        // road/building/facility/remove 的投影语义随 U45 设施对象落地，先入列表
      }
      if (ev.op === 'facility') facilities.push({ seq: ev.seq, t: ev.t, who: ev.who, kind: ev.to, cells: [...ev.cells] });
      if (ev.op === 'remove') facilities.push({ seq: ev.seq, t: ev.t, who: ev.who, kind: 'remove', cells: [...ev.cells] });
    }

    const view = Object.freeze({
      W: world.W, H: world.H, atSeq: limit === Infinity ? null : atSeq,
      terrAt: i => terr[i | 0],
      zoneAt: i => zone[i | 0],
      bhAt: i => bh[i | 0],
      terrSlice: () => Uint8Array.from(terr),
      ownerAt: i => owner.get(i | 0) || null,        // 归因：谁最后改的这格
      facilities: () => facilities.map(f => ({ ...f, cells: [...f.cells] })),
    });
    projCache = { seq, atSeq: atSeq == null ? null : atSeq, view };
    return view;
  }

  return Object.freeze({
    W: world.W, H: world.H,
    append, truncate, snapshot, project,
    lastSeq: () => seq,
    count: () => events.length,
  });
}
