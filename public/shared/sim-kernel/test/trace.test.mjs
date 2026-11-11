/* U27 trace：记录/dump/对比/分叉定位/存档往返。U28 用它做 200 回合确定性闸门。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTrace, compareTraces, traceFromDump } from '../trace.mjs';
import { createKernel } from '../kernel.mjs';
import { generateWorld, TERR } from '../world.mjs';
import { createFields } from '../fields.mjs';
import { createEnts } from '../entities.mjs';
import { createCost } from '../cost.mjs';
import { createPasses } from '../passes.mjs';
import { createEvents } from '../events.mjs';

/* 同种子建两个同构系统；divergeAt 回合起换决策制造分叉 */
function mkRun(seed, divergeAt = Infinity) {
  const world = generateWorld({ W: 16, H: 16, seed });
  const fields = createFields({ W: 16, H: 16 });
  fields.register('water');
  fields.register('crowd');
  const ents = createEnts({ W: 16, H: 16, fields, cap: 50 });
  const a = ents.spawn({ kind: 0, x: 2, y: 2 });
  const cost = createCost({ world, fields });
  cost.define('walk', { blockers: [TERR.WATER, TERR.MOUNTAIN] });
  const passes = createPasses({ fields });
  passes.register({ id: 'rain', reads: [], writes: ['water'], period: 1, run(ctx) {
    const a = ctx.fields.field('water'), b = ctx.fields.next('water');
    for (let i = 0; i < 256; i++) b[i] = a[i] + 0.01;   // 纯函数（GF2）
  } });
  const trace = createTrace(world, { label: seed });
  const events = createEvents();
  const k = createKernel({
    world, fields, passes, events, ents, cost, costNames: ['walk'],
    depositFields: ['crowd'],
    fingerprintEvery: 1,
    decisionProvider: (tick) => [{ id: a, x: 2 + (tick % 8) + (tick >= divergeAt ? 5 : 0), y: 2 + ((tick / 8) | 0) }],
    onDiff: d => trace.record(d),
  });
  return { k, trace };
}

test('记录与 dump：行结构完整、头指纹=末行指纹', () => {
  const { k, trace } = mkRun(7);
  k.step(10);
  const d = trace.dump();
  assert.equal(d.schemaVersion, 1);
  assert.equal(d.world.seed, 7);
  assert.equal(d.rows.length, 10);
  assert.equal(d.headFp, d.rows[9].fp);
  assert.deepEqual(Object.keys(d.rows[0]).sort(), ['blocked', 'ev', 'fp', 'moved', 'ran', 't']);
});

test('★ 同种子两跑 identical，firstDivergence=null', () => {
  const A = mkRun(7); A.k.step(50);
  const B = mkRun(7); B.k.step(50);
  const cmp = compareTraces(A.trace, B.trace);
  assert.equal(cmp.identical, true);
  assert.equal(cmp.firstDivergence, null);
  assert.equal(cmp.lenA, 50);
});

test('分叉检测：tick 5 起换决策 → firstDivergence=5', () => {
  const A = mkRun(7); A.k.step(20);
  const B = mkRun(7, 5); B.k.step(20);           // 第 5 回合起决策不同
  const cmp = compareTraces(A.trace, B.trace);
  assert.equal(cmp.identical, false);
  assert.equal(cmp.firstDivergence, 5, '应精确定位第一个分叉回合');
});

test('存档往返：dump → JSON → traceFromDump → 与原跑 identical', () => {
  const A = mkRun(7); A.k.step(30);
  const json = JSON.stringify(A.trace.dump());
  const restored = traceFromDump(json);
  const B = mkRun(7); B.k.step(30);
  const cmp = compareTraces(restored, B.trace);
  assert.equal(cmp.identical, true, '存档与重跑必须一致');
});

test('load 拒绝错误 schema，给人话', () => {
  const t = createTrace(generateWorld({ W: 4, H: 4, seed: 1 }));
  assert.throws(() => t.load({ schemaVersion: 99, rows: [] }), /schema 不匹配.*99/);
  assert.throws(() => t.load(null), TypeError);
});

test('体积冒烟：200 回合 trace dump < 200KB', () => {
  const { k, trace } = mkRun(3);
  k.step(200);
  const json = JSON.stringify(trace.dump());
  console.log(`    200 回合 trace = ${(json.length / 1024).toFixed(1)}KB`);
  assert.ok(trace.count() === 200);
  assert.ok(json.length < 200 * 1024);
});
