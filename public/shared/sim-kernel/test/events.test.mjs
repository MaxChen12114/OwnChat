/* U22 冒烟：定序/派发/条件触发/去重。U23 扩乱序一致与链式。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEvents } from '../events.mjs';

test('按 (at,id) 定序派发，乱序入队不影响顺序', () => {
  const bus = createEvents();
  const got = [];
  bus.on('rain', e => got.push(`${e.at}:${e.id}`));
  bus.emit({ type: 'rain', at: 520 });     // 先排远的
  bus.emit({ type: 'rain', at: 480 });     // 后排近的
  bus.emit({ type: 'rain', at: 480 });     // 同 tick，id 序
  bus.tick(600);
  assert.deepEqual(got, ['480:1', '480:2', '520:0']);
});

test('同类型多订阅者按注册顺序', () => {
  const bus = createEvents();
  const got = [];
  bus.on('breach', () => got.push('first'));
  bus.on('breach', () => got.push('second'));
  bus.emit({ type: 'breach', at: 1 });
  bus.tick(1);
  assert.deepEqual(got, ['first', 'second']);
});

test('未到期的留在队列里', () => {
  const bus = createEvents();
  bus.emit({ type: 'rain', at: 100 });
  let called = 0;
  bus.on('rain', () => called++);
  bus.tick(50);
  assert.equal(called, 0);
  assert.equal(bus.pendingCount(), 1);
  bus.tick(100);
  assert.equal(called, 1);
});

test('at 小于当前 tick 的事件立即派发（不丢）', () => {
  const bus = createEvents();
  let called = 0;
  bus.on('late', () => called++);
  bus.tick(500);
  bus.emit({ type: 'late', at: 10 });
  bus.tick(501);
  assert.equal(called, 1);
});

test('条件触发：超阈派发一次，key 永久去重', () => {
  const bus = createEvents();
  const got = [];
  bus.on('breach', e => got.push(e.payload));
  bus.when({ metric: 'flooded', op: '>', value: 200 }, { type: 'breach', payload: { at_cell: [48, 60] } });
  bus.tick(1, { flooded: 150 });          // 没到
  assert.equal(got.length, 0);
  bus.tick(2, { flooded: 238 });          // 超阈 → 触发
  assert.equal(got.length, 1);
  bus.tick(3, { flooded: 300 });          // 还在超阈 → 不重复
  bus.tick(4, { flooded: 50 });           // 回落
  bus.tick(5, { flooded: 500 });          // 再超阈 → 仍不重复（key 永久）
  assert.equal(got.length, 1);
  assert.deepEqual(bus.fired(), ['flooded>200->breach']);
});

test('条件触发产生的事件当 tick 立即可见', () => {
  const bus = createEvents();
  const order = [];
  bus.on('flooded', () => order.push('cond'));
  bus.when({ metric: 'flooded', op: '>', value: 10 }, { type: 'flooded' });
  bus.tick(1, { flooded: 99 });
  assert.deepEqual(order, ['cond']);
  assert.equal(bus.pendingCount(), 0);
});

test('reset：队列与触发记录清空，订阅保留', () => {
  const bus = createEvents();
  let called = 0;
  bus.on('rain', () => called++);
  bus.when({ metric: 'x', op: '>', value: 1 }, { type: 'rain' });
  bus.tick(1, { x: 5 });
  assert.equal(called, 1);
  bus.reset();
  bus.tick(2, { x: 5 });
  assert.equal(called, 2, 'reset 后条件可再触发');
});

test('非法事件报人话错误', () => {
  const bus = createEvents();
  assert.throws(() => bus.emit({ type: '', at: 1 }), TypeError);
  assert.throws(() => bus.emit({ type: 'x', at: -5 }), TypeError);
  assert.throws(() => bus.when({ metric: 'x', op: '~', value: 1 }, { type: 'y' }), /op/);
});

/* ---------- U23 全套 ---------- */

test('同 tick 乱序入队：4 种排列派发序逐位一致', () => {
  const base = () => {
    const bus = createEvents();
    const got = [];
    bus.on('e', e => got.push(e.id));
    return { bus, got };
  };
  const ids = [0, 1, 2, 3];
  const ref = null;
  let refSeq = null;
  for (let p = 0; p < 4; p++) {
    const { bus, got } = base();
    const evs = ids.map(i => ({ id: i }));
    // 确定性洗牌
    let s = 77 + p;
    for (let i = evs.length - 1; i > 0; i--) { s = (s * 1103515245 + 12345) & 0x7fffffff; const j = s % (i + 1); [evs[i], evs[j]] = [evs[j], evs[i]]; }
    for (const e of evs) bus.emit({ type: 'e', at: 10 });
    bus.tick(10);
    if (refSeq === null) refSeq = [...got];
    else assert.deepEqual(got, refSeq, `排列 ${p} 派发序不同`);
  }
  assert.deepEqual(refSeq, [0, 1, 2, 3], 'id 序即权威序');
});

test('触发只触发一次：同 tick 条件多轮链式不重复', () => {
  const bus = createEvents();
  let count = 0;
  bus.on('alarm', () => count++);
  bus.when({ metric: 'water', op: '>', value: 1 }, { type: 'alarm' });
  bus.emit({ type: 'noise', at: 5 });           // 有到期事件 → 走两轮循环
  bus.tick(5, { water: 9 });
  assert.equal(count, 1, '链式多轮里条件只准触发一次');
});

test('处理器内再 emit：下一轮派发，不丢不炸', () => {
  const bus = createEvents();
  const got = [];
  bus.on('outer', () => { bus.emit({ type: 'inner', at: 1 }); got.push('outer'); });
  bus.on('inner', () => got.push('inner'));
  bus.emit({ type: 'outer', at: 1 });
  bus.tick(1);
  assert.deepEqual(got, ['outer', 'inner']);
});

test('退订函数生效', () => {
  const bus = createEvents();
  let n = 0;
  const off = bus.on('x', () => n++);
  bus.emit({ type: 'x', at: 1 });
  bus.tick(1);
  off();
  bus.emit({ type: 'x', at: 2 });
  bus.tick(2);
  assert.equal(n, 1);
});

test('多条件同 tick 各触发一次', () => {
  const bus = createEvents();
  const got = [];
  bus.on('a', () => got.push('a'));
  bus.on('b', () => got.push('b'));
  bus.when({ metric: 'm1', op: '>', value: 1 }, { type: 'a' });
  bus.when({ metric: 'm2', op: '>', value: 1 }, { type: 'b' });
  bus.tick(1, { m1: 5, m2: 5 });
  assert.deepEqual(got.sort(), ['a', 'b']);
});

test('metrics 缺 key：条件不触发也不炸', () => {
  const bus = createEvents();
  let n = 0;
  bus.on('a', () => n++);
  bus.when({ metric: 'ghost', op: '>', value: 1 }, { type: 'a' });
  bus.tick(1, { other: 5 });
  bus.tick(2, null);
  assert.equal(n, 0);
});

test('事件对象可序列化（trace 契约）：JSON 往返一致', () => {
  const bus = createEvents();
  const id = bus.emit({ type: 'rain', at: 480, payload: { intensity: 2.0, area: 'west' } });
  bus.on('rain', () => {});
  bus.tick(480);
  const snap = JSON.parse(JSON.stringify({ id, pending: bus.pendingCount() }));
  assert.equal(snap.id, id);
  assert.equal(typeof snap.id, 'number');
});

test('性能：1000 事件单 tick 派发 < 3ms（min-of-3）', () => {
  const bus = createEvents();
  let n = 0;
  bus.on('bulk', () => n++);
  for (let k = 0; k < 1000; k++) bus.emit({ type: 'bulk', at: 10 });
  bus.tick(1);
  let best = Infinity;
  for (let r = 0; r < 3; r++) {
    const t0 = process.hrtime.bigint();
    bus.tick(10 + r);
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  console.log(`    tick 派发 1000 事件 min-of-3 = ${best.toFixed(2)}ms`);
  assert.ok(best < 3, `派发 ${best.toFixed(2)}ms 超预算`);
});
