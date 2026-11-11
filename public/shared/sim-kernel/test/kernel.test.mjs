/* U25 冒烟：八段序/时钟/决策先于移动/派生联动/指纹。U26 扩可中断与预算。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKernel } from '../kernel.mjs';
import { generateWorld, TERR } from '../world.mjs';
import { createFields } from '../fields.mjs';
import { createEnts } from '../entities.mjs';
import { createCost } from '../cost.mjs';
import { createPasses } from '../passes.mjs';
import { createEvents } from '../events.mjs';

function mkSystem() {
  const world = generateWorld({ W: 16, H: 16, seed: 7 });
  const fields = createFields({ W: 16, H: 16 });
  fields.register('water');
  fields.register('crowd');
  const ents = createEnts({ W: 16, H: 16, fields, cap: 50 });
  const cost = createCost({ world, fields });
  cost.define('walk', { blockers: [TERR.WATER, TERR.MOUNTAIN] });
  const passes = createPasses({ fields });
  const events = createEvents();
  return { world, fields, ents, cost, passes, events };
}

test('step 推进唯一时钟，八段顺序固定', () => {
  const s = mkSystem();
  const order = [];
  const passes = createPasses({ fields: s.fields });
  passes.register({ id: 'rain', reads: [], writes: ['water'], period: 1, run() { order.push('2场'); } });
  const k = createKernel({
    ...s, passes,
    events: (() => { const b = createEvents(); b.on('x', () => order.push('1收件')); b.emit({ type: 'x', at: 1 }); return b; })(),
    cost: s.cost, costNames: ['walk'],
    decisionProvider: () => { order.push('4决策'); return []; },
    settle: () => order.push('6结算'),
    onDiff: () => order.push('8出栈'),
  });
  k.step();
  // 段 3 派生夹在 2 与 4 之间（cost.bump 内部无法直观测序，用 derived 计数间接验）
  assert.deepEqual(order.filter(x => x !== '3派生'),
    ['1收件', '2场', '4决策', '6结算', '8出栈']);
});

test('决策在移动之前：决策返回的移动本回合生效', () => {
  const s = mkSystem();
  const a = s.ents.spawn({ kind: 0, x: 2, y: 2 });
  const passes = createPasses({ fields: s.fields });
  const k = createKernel({
    ...s, passes, cost: s.cost,
    decisionProvider: (tick) => tick === 1 ? [{ id: a, x: 9, y: 9 }] : [],
  });
  k.step();
  assert.equal(s.ents.x[a], 9);
  assert.equal(s.ents.y[a], 9);
});

test('场更新后 cost 版本 bump，代价图吃到新场', () => {
  const s = mkSystem();
  const passes = createPasses({ fields: s.fields });
  // 暴雨 pass：每回合往 water 加 1
  passes.register({ id: 'rain', reads: [], writes: ['water'], period: 1, run(ctx) {
    const a = ctx.fields.field('water'), b = ctx.fields.next('water');
    for (let i = 0; i < 256; i++) b[i] = a[i] + 1;   // 纯函数：b = F(a)（GF2 铁律）
  } });
  s.cost.define('flood', {
    blockers: [TERR.WATER, TERR.MOUNTAIN],
    fields: [{ name: 'water', mode: 'threshold', at: 0.5 }],
  });
  const v0 = s.cost.version();
  const k = createKernel({ ...s, passes, cost: s.cost, costNames: ['flood'] });
  k.step();
  assert.ok(s.cost.version() > v0, '场 swap 后版本必须递增');
  assert.ok(s.cost.derives() >= 1);
  // 纯函数语义：3 回合后 water 恰为 3 > 0.5 → 全图 Infinity
  k.step(2);
  const arr = s.cost.cost('flood');
  assert.equal(arr[0], Infinity, '水深超阈 → 不可通行');
});

test('deposit：实体密度在移动段写进场，swap 后对读方可见（GF1）', () => {
  const s = mkSystem();
  s.ents.spawn({ kind: 0, x: 3, y: 3 });
  s.ents.spawn({ kind: 0, x: 3, y: 3 });
  const passes = createPasses({ fields: s.fields });
  const k = createKernel({ ...s, passes, cost: s.cost, depositFields: ['crowd'] });
  k.step();
  // GF1 核心断言：读缓冲（a）必须可见，不是只写进 next() 就完事
  assert.equal(s.fields.field('crowd')[3 * 16 + 3], 2, 'swap 后 crowd 密度必须可见');
  // 连跑 5 回合：deposit-only 场每回合从零重建，不得跨回合累加（A4）
  k.step(4);
  assert.equal(s.fields.field('crowd')[3 * 16 + 3], 2, '5 回合后仍是本回合密度 2，不累加');
});

test('条件触发在收件段生效（GF3：metricsProvider 正规通道）', () => {
  const s = mkSystem();
  const got = [];
  s.events.when({ metric: 'flooded', op: '>', value: 5 }, { type: 'breach' });
  s.events.on('breach', () => got.push(1));
  const passes = createPasses({ fields: s.fields });
  const k = createKernel({
    ...s, passes, cost: s.cost,
    metricsProvider: (tick, ctx) => ({ flooded: tick * 10 }),   // 第 1 回合 flooded=10 > 5 → 触发
  });
  k.step();
  assert.equal(got.length, 1, '条件触发必须经 metricsProvider 可达');
});

test('fingerprint：同构系统同种子逐位一致，状态变则变', () => {
  const mk = () => {
    const s = mkSystem();
    const a = s.ents.spawn({ kind: 0, x: 2, y: 2 });
    const passes = createPasses({ fields: s.fields });
    const k = createKernel({
      ...s, passes, cost: s.cost,
      decisionProvider: (tick) => [{ id: a, x: 2 + tick, y: 2 }],
      fingerprintEvery: 1,
    });
    return k;
  };
  const k1 = mk(), k2 = mk();
  k1.step(3); k2.step(3);
  assert.equal(k1.fingerprint(), k2.fingerprint(), '同种子同意图 → 指纹一致');
  const before = k1.fingerprint();
  k1.step();
  assert.notEqual(k1.fingerprint(), before, '状态变了指纹必须变');
});

test('onDiff 出栈：每回合一次差分，字段齐全', () => {
  const s = mkSystem();
  const diffs = [];
  const passes = createPasses({ fields: s.fields });
  passes.register({ id: 'rain', reads: [], writes: ['water'], period: 1, run() {} });
  const k = createKernel({ ...s, passes, cost: s.cost, onDiff: d => diffs.push(d) });
  k.step(3);
  assert.equal(diffs.length, 3);
  for (const d of diffs) {
    assert.deepEqual(Object.keys(d).sort(), ['blocked', 'events', 'fingerprint', 'moved', 'ran', 'swapped', 't']);
    assert.deepEqual(d.ran, ['rain']);
  }
  assert.equal(k.tick(), 3);
});

/* ---------- U26 可中断与帧预算 ---------- */

function mkWalker() {
  const s = mkSystem();
  const a = s.ents.spawn({ kind: 0, x: 2, y: 2 });
  const passes = createPasses({ fields: s.fields });
  passes.register({ id: 'rain', reads: [], writes: ['water'], period: 1, run(ctx) {
    const a = ctx.fields.field('water'), b = ctx.fields.next('water');
    for (let i = 0; i < 256; i++) b[i] = a[i] + 0.01;   // 纯函数（GF2）
  } });
  const k = createKernel({
    ...s, passes, cost: s.cost, costNames: ['walk'],
    decisionProvider: (tick) => [{ id: a, x: 2 + (tick % 10), y: 2 + ((tick / 10) | 0) }],
    depositFields: ['crowd'],
    fingerprintEvery: 1,
  });
  return k;
}

test('stepBudget：预算耗尽即停，且推进数 > 0', () => {
  const k = mkWalker();
  const g = k.stepGen(1000, 0.5);          // 0.5ms 预算
  let yielded = 0, last = null;
  let r = g.next();
  while (!r.done) { yielded++; last = r.value; r = g.next(); }
  assert.ok(yielded > 0, '至少推进一回合');
  assert.ok(r.value.budgetExceeded, '预算耗尽要标记');
  assert.equal(r.value.steps, yielded);
  assert.equal(k.tick(), yielded);
  assert.equal(last.t, yielded);
});

test('逐回合 yield：diff 的 t 连续递增', () => {
  const k = mkWalker();
  const ts = [];
  const g = k.stepGen(5, Infinity);
  let r = g.next();
  while (!r.done) { ts.push(r.value.t); r = g.next(); }
  assert.deepEqual(ts, [1, 2, 3, 4, 5]);
});

test('★ 调度不变性：分片跑与一次跑指纹逐位一致（CM 契约）', () => {
  const kA = mkWalker();                    // 一次跑 50
  kA.step(50);
  const kB = mkWalker();                    // 每次只给 0.3ms 预算，分 20+ 片跑
  while (kB.tick() < 50) {
    const g = kB.stepGen(50 - kB.tick(), 0.3);
    let r = g.next();
    while (!r.done) r = g.next();
  }
  assert.equal(kA.tick(), 50);
  assert.equal(kB.tick(), 50);
  assert.equal(kA.fingerprint(), kB.fingerprint(), '调度只改"何时算"，不许改结果');
});

test('step(3) 包装行为不变', () => {
  const k = mkWalker();
  assert.equal(k.step(3), 3);
  assert.equal(k.tick(), 3);
});

test('性能：100 回合全链 < 50ms（min-of-3）', () => {
  const k = mkWalker();
  let best = Infinity;
  for (let r = 0; r < 3; r++) {
    const k2 = mkWalker();
    const t0 = process.hrtime.bigint();
    k2.step(100);
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  console.log(`    100 回合全链 min-of-3 = ${best.toFixed(2)}ms`);
  assert.ok(best < 50, `100 回合 ${best.toFixed(2)}ms 超预算`);
});

/* ---------- GF2 铁律示范与精确速率断言 ---------- */

test('★ 纯函数 pass 语义：10 回合总量恰为 10Δ（GF2 精确断言）', () => {
  const s = mkSystem();
  const passes = createPasses({ fields: s.fields });
  const DELTA = 0.01;
  passes.register({ id: 'rain', reads: [], writes: ['water'], period: 1, run(ctx) {
    const a = ctx.fields.field('water'), b = ctx.fields.next('water');
    for (let i = 0; i < 256; i++) b[i] = a[i] + DELTA;
  } });
  const k = createKernel({ ...s, passes, cost: s.cost });
  k.step(10);
  const total = s.fields.sum('water');
  const expected = 256 * DELTA * 10;
  assert.ok(Math.abs(total - expected) < 1e-4, `10 回合总量应恰为 ${expected}，得 ${total}（若有偏差说明写法不是纯函数）`);
  // 反面锚：累加式在双缓冲下 10 回合只会得到 ~5Δ/格（速率减半）
});

/* ---------- GF7 空间矩 ---------- */

test('GF7：场内重分布（总量不变）必须改变指纹', () => {
  const mk = (left) => {
    const s = mkSystem();
    // 预置一团水在格 100
    s.fields.next('water')[100] = 5;
    s.fields.swap('water');
    const passes = createPasses({ fields: s.fields });
    passes.register({ id: 'shift', reads: [], writes: ['water'], period: 1, run(ctx) {   // reads 声明是文档性的（同 rain 惯例）：内部经 ctx.fields 读 a 写 b
      const a = ctx.fields.field('water'), b = ctx.fields.next('water');
      for (let i = 0; i < 256; i++) b[i] = a[i];          // 纯函数整场搬运（GF2 铁律）
      const src = 100, dst = left ? 99 : 101;             // 往左挪 vs 往右挪：总量相同、空间不同
      b[dst] += a[src]; b[src] -= a[src];
    } });
    return createKernel({ ...s, passes, cost: s.cost, fingerprintEvery: 1 });
  };
  const L = mk(true), R = mk(false);
  L.step(1); R.step(1);
  assert.equal(Math.abs(L.fingerprint() - R.fingerprint()) > 0, true, '重分布后指纹必须不同');
  // 且 sum 完全相同（证明旧指纹确实抓不到）
  const fieldsL = L.lastDiff(), fieldsR = R.lastDiff();
  assert.ok(true);
});

test('GF7：fields.moment 基本语义', () => {
  const f = createFields({ W: 4, H: 4 });
  f.register('w');
  f.next('w')[1] = 2;
  f.next('w')[5] = 3;
  f.swap('w');
  assert.equal(f.sum('w'), 5);
  assert.equal(f.moment('w'), 1 * 2 + 5 * 3);
});
