/* U12 代价全套：组合叠加、缓存契约（100 读 1 算）、场变 seq 联动、性能、非法配置。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCost } from '../cost.mjs';
import { fromArrays, TERR } from '../world.mjs';
import { createFields } from '../fields.mjs';

function mkWorld() {
  const terr = new Array(36).fill(TERR.GRASS);
  terr[7] = TERR.MOUNTAIN;      // (1,1)
  terr[14] = TERR.WATER;        // (2,2)
  return fromArrays({ W: 6, H: 6, seed: 1, terr });
}

function mkWater(v) {
  const f = createFields({ W: 6, H: 6 });
  f.register('water');
  for (let i = 0; i < 36; i++) f.next('water')[i] = v;
  f.swap('water');
  return f;
}

test('组合叠加：山(Infinity) 与水阈(Infinity) 与乘子共存，Infinity 不被覆盖', () => {
  const w = mkWorld();
  const f = createFields({ W: 6, H: 6 });
  f.register('water');
  f.next('water')[7] = 0.9;     // 山上也有水 —— Infinity 必须保持
  f.next('water')[20] = 0.5;    // 平地水深 0.5
  f.swap('water');
  const c = createCost({ world: w, fields: f });
  c.define('walk', {
    blockers: [TERR.MOUNTAIN, TERR.WATER],
    fields: [
      { name: 'water', mode: 'threshold', at: 0.3 },
      { name: 'water', mode: 'mult', k: 2 },
    ],
  });
  const arr = c.cost('walk');
  assert.equal(arr[7], Infinity, '山+水深 → Infinity');
  assert.equal(arr[14], Infinity, '静水格 → Infinity');
  assert.equal(arr[20], Infinity, '平地超阈 → Infinity');
  assert.equal(arr[0], 1, '无水草地 → 1');
  // 乘子与阈值同场时：阈下格应用乘子
  f.next('water')[26] = 0.2;
  f.swap('water');
  c.bump();
  const arr2 = c.cost('walk');
  assert.ok(Math.abs(arr2[26] - 1.4) < 1e-5, `阈下格应乘 (1+2*0.2)=1.4，得 ${arr2[26]}`);
});

test('缓存契约：同版本 100 次读取只 derive 1 次', () => {
  const c = createCost({ world: mkWorld(), fields: mkWater(0) });
  c.define('walk', { blockers: [TERR.WATER, TERR.MOUNTAIN] });
  for (let i = 0; i < 100; i++) c.cost('walk');
  assert.equal(c.derives(), 1, '同版本反复取用不得重算');
});

test('场变 + bump → 重算；没 bump → 不重算（kernel 负责通知）', () => {
  const w = mkWorld();
  const f = createFields({ W: 6, H: 6 });
  f.register('water');
  f.next('water')[3] = 0.1;
  f.swap('water');
  const c = createCost({ world: w, fields: f });
  c.define('walk', { fields: [{ name: 'water', mode: 'threshold', at: 0.3 }] });
  const a1 = c.cost('walk');
  assert.equal(a1[3], 1);
  // 场内容变了但没 bump：契约 = cost 不知道，不重算
  f.next('water')[3] = 0.9;
  f.swap('water');
  const a2 = c.cost('walk');
  assert.equal(a2[3], 1, '未 bump 不重算（kernel 每回合场 swap 后统一 bump）');
  // bump 之后：新代价生效
  c.bump();
  const a3 = c.cost('walk');
  assert.equal(a3[3], Infinity);
  assert.equal(c.derives(), 2);
});

test('threshold 指定 cost（非 Infinity）', () => {
  const c = createCost({ world: mkWorld(), fields: mkWater(0.5) });
  c.define('slow', { fields: [{ name: 'water', mode: 'threshold', at: 0.3, cost: 8 }] });
  const arr = c.cost('slow');
  assert.equal(arr[0], 8);
});

test('flat 加值模式：cost = 1 + per*v', () => {
  const c = createCost({ world: mkWorld(), fields: mkWater(0.5) });
  c.define('damp', { fields: [{ name: 'water', mode: 'flat', per: 4 }] });
  const arr = c.cost('damp');
  assert.ok(Math.abs(arr[0] - 3) < 1e-5, `应为 1+4*0.5=3，得 ${arr[0]}`);
});

test('全图 derive 性能：36 格 <1ms（6144 格按比例外推 <2ms）', () => {
  const c = createCost({ world: mkWorld(), fields: mkWater(0.2) });
  c.define('walk', {
    blockers: [TERR.WATER, TERR.MOUNTAIN],
    fields: [{ name: 'water', mode: 'mult', k: 1 }],
  });
  const t0 = process.hrtime.bigint();
  c.cost('walk');
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`    derive(36格) = ${ms.toFixed(3)}ms`);
  assert.ok(ms < 1, `derive 耗时 ${ms.toFixed(3)}ms`);
});

test('非法配置：重复定义报错、非法 mode 报错', () => {
  const c = createCost({ world: mkWorld(), fields: mkWater(0) });
  c.define('walk', {});
  assert.throws(() => c.define('walk', {}), /重复/);
  assert.throws(() => c.define('bad', { fields: [{ name: 'water', mode: 'exp' }] }), /非法 mode/);
});

/* ---------- GF5 数值校验 ---------- */

test('GF5：负乘子拒绝（负边权破坏最短路）', () => {
  const c = createCost({ world: mkWorld(), fields: mkWater(0) });
  assert.throws(() => c.define('bad', { fields: [{ name: 'water', mode: 'mult', k: -1.5 }] }), /mult k 必须 ≥ 0/);
});

test('GF5：负 flat per 拒绝；非有限 threshold at 拒绝；threshold cost ≤ 0 拒绝', () => {
  const c = createCost({ world: mkWorld(), fields: mkWater(0) });
  assert.throws(() => c.define('b1', { fields: [{ name: 'water', mode: 'flat', per: -1 }] }), /per 必须 ≥ 0/);
  assert.throws(() => c.define('b2', { fields: [{ name: 'water', mode: 'threshold', at: 'x' }] }), /有限数/);
  assert.throws(() => c.define('b3', { fields: [{ name: 'water', mode: 'threshold', at: 0.3, cost: -2 }] }), /cost 必须 > 0/);
});

test('GF5：k=0 / per=0 合法（边界）', () => {
  const c = createCost({ world: mkWorld(), fields: mkWater(0.2) });
  c.define('ok', { fields: [{ name: 'water', mode: 'mult', k: 0 }, { name: 'water', mode: 'flat', per: 0 }] });
  assert.equal(c.cost('ok')[0], 1);
});
