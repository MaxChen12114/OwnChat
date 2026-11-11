/* U24 passes：静态冲突检测（注册即报错）、period 调度、swap 范围、执行序。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPasses } from '../passes.mjs';
import { createFields } from '../fields.mjs';

function mk() {
  const fields = createFields({ W: 4, H: 4 });
  fields.register('water');
  fields.register('smoke');
  return { fields, ps: createPasses({ fields }) };
}

test('同 pass 读写同一场 → 注册即报错', () => {
  const { fields, ps } = mk();
  assert.throws(
    () => ps.register({ id: 'bad', reads: ['water'], writes: ['water'], period: 1, run() {} }),
    /读写同一场.*铁律/);
});

test('两 pass 写同一场 → 报错并列出对方 id', () => {
  const { fields, ps } = mk();
  ps.register({ id: 'a', reads: [], writes: ['water'], period: 1, run() {} });
  assert.throws(
    () => ps.register({ id: 'b', reads: ['smoke'], writes: ['water'], period: 1, run() {} }),
    /已被 pass "a" 声明写入/);
});

test('引用未注册场 → 报错并列出已注册名单', () => {
  const { fields, ps } = mk();
  assert.throws(
    () => ps.register({ id: 'c', reads: ['fire'], writes: [], period: 1, run() {} }),
    /fire/);
});

test('id 重复 / period 非法 → 报错', () => {
  const { fields, ps } = mk();
  ps.register({ id: 'a', reads: [], writes: ['water'], period: 1, run() {} });
  assert.throws(() => ps.register({ id: 'a', reads: [], writes: ['smoke'], period: 1, run() {} }), /重复/);
  assert.throws(() => ps.register({ id: 'd', reads: [], writes: [], period: 0, run() {} }), /period/);
  assert.throws(() => ps.register({ id: 'e', reads: [], writes: [], period: 1.5, run() {} }), /period/);
});

test('period：p1 每回合跑，p3 只在 3,6,9 跑', () => {
  const { fields, ps } = mk();
  const hits = { p1: 0, p3: 0 };
  ps.register({ id: 'p1', reads: [], writes: ['water'], period: 1, run() { hits.p1++; } });
  ps.register({ id: 'p3', reads: [], writes: [], period: 3, run() { hits.p3++; } });
  for (let t = 1; t <= 9; t++) ps.runTick(t, {});
  assert.equal(hits.p1, 9);
  assert.equal(hits.p3, 3);
});

test('执行序 = 注册序', () => {
  const { fields, ps } = mk();
  const order = [];
  ps.register({ id: 'first', reads: [], writes: ['water'], period: 1, run() { order.push('first'); } });
  ps.register({ id: 'second', reads: ['water'], writes: [], period: 1, run() { order.push('second'); } });
  ps.runTick(1, {});
  assert.deepEqual(order, ['first', 'second']);
});

test('swap 只换本回合被写的场', () => {
  const { fields, ps } = mk();
  fields.next('water')[0] = 7;
  fields.next('smoke')[0] = 9;
  ps.register({ id: 'w', reads: [], writes: ['water'], period: 1, run() {} });
  const r = ps.runTick(1, {});
  assert.deepEqual(r.swapped, ['water']);
  assert.equal(fields.field('water')[0], 7, 'water 已 swap');
  assert.equal(fields.field('smoke')[0], 0, 'smoke 未 swap');
  assert.equal(fields.next('smoke')[0], 9);
});

test('period=3 的场只在跑的回合 swap', () => {
  const { fields, ps } = mk();
  fields.register('rain3');
  ps.register({ id: 'r3', reads: [], writes: ['rain3'], period: 3, run(ctx, tick) { ctx.fields.next('rain3')[0] = tick; } });
  const r1 = ps.runTick(1, { fields });
  assert.deepEqual(r1.swapped, [], 'tick1 未到期不 swap');
  fields.next('water')[1] = 1;               // 别的场这回合有 deposit
  const r3 = ps.runTick(3, { fields });
  assert.deepEqual(r3.swapped, ['rain3']);
  assert.equal(fields.field('rain3')[0], 3);
});

test('list / writerOf 查询', () => {
  const { fields, ps } = mk();
  ps.register({ id: 'w', reads: ['smoke'], writes: ['water'], period: 2, run() {} });
  assert.equal(ps.writerOf('water'), 'w');
  assert.equal(ps.writerOf('smoke'), null);
  const l = ps.list();
  assert.equal(l[0].id, 'w');
  assert.equal(l[0].period, 2);
});
