/* U14 A* 全套：动态代价断路重算、等代价破平、批量寻路预算（A3 场景闭环）、代价加权绕行。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPathfinder } from '../path.mjs';
import { fromArrays, TERR } from '../world.mjs';
import { createCost } from '../cost.mjs';
import { createFields } from '../fields.mjs';

function mkPlain(W = 8, H = 8) {
  return fromArrays({ W, H, seed: 1, terr: new Array(W * H).fill(TERR.GRASS) });
}

function mkSystem(world, { maxExpand = null } = {}) {   // GF4：透传，让 path.mjs 默认值生效
  const fields = createFields({ W: world.W, H: world.H });
  fields.register('water');
  const c = createCost({ world, fields });
  c.define('walk', {
    blockers: [TERR.WATER, TERR.MOUNTAIN],
    fields: [{ name: 'water', mode: 'threshold', at: 0.3 }],
  });
  return {
    world, fields, cost: c,
    finder: createPathfinder({ world, costs: () => c.cost('walk'), maxExpand }),
    flood(i, v = 0.5) { fields.next('water')[i] = v; fields.swap('water'); c.bump(); },
  };
}

test('最短路：代价恒 1 时步数 = 曼哈顿距离+1', () => {
  const { finder } = mkSystem(mkPlain());
  const p = finder.path(0, 0, 5, 3);
  assert.equal(p.length, Math.abs(5) + Math.abs(3) + 1);
});

test('断路重算：原路被水淹后，bump 出新路径且不踩淹格', () => {
  const { finder, flood } = mkSystem(mkPlain());
  const before = finder.path(0, 0, 7, 0);            // 沿顶行直线
  assert.deepEqual(before[4], [4.5, 0.5]);
  // 淹掉顶行 (3,0)(4,0)(5,0)
  flood(3); flood(4); flood(5);
  const after = finder.path(0, 0, 7, 0);
  assert.ok(after, '绕行后仍可达');
  for (const [x, y] of after) {
    const i = Math.floor(y) * 8 + Math.floor(x);
    assert.ok(![3, 4, 5].includes(i), `路径踩了淹格 (${x},${y})`);
  }
  assert.ok(after.length > before.length, '绕行路径应更长');
});

test('断路完全封死 → null（绕无可绕）', () => {
  // 5×3 窄带，全淹
  const world = fromArrays({ W: 5, H: 3, seed: 1, terr: new Array(15).fill(TERR.GRASS) });
  const { finder, flood } = mkSystem(world);
  for (let i = 0; i < 15; i++) flood(i);
  assert.equal(finder.path(0, 1, 4, 1), null);
});

test('等代价破平：对称场地上两次同路径且为索引序较小者', () => {
  const { finder } = mkSystem(mkPlain());
  // (0,0)→(2,2)：右下/下右两条等长，固定邻序 R,L,D,U 下 g 相等时索引小者先扩
  const a = finder.path(0, 0, 2, 2);
  const b = finder.path(0, 0, 2, 2);
  assert.deepEqual(a, b);
  assert.equal(a.length, 5);
  // 第二格必是 [1.5,0.5]（右先于下；若实现改变邻序此断言即报警）
  assert.deepEqual(a[1], [1.5, 0.5]);
});

test('代价加权：拥堵格乘子大 → 绕开更便宜', () => {
  const world = mkPlain();
  const fields = createFields({ W: 8, H: 8 });
  fields.register('crowd');
  const c = createCost({ world, fields });
  c.define('walk', { fields: [{ name: 'crowd', mode: 'mult', k: 50 }] });
  const finder = createPathfinder({ world, costs: () => c.cost('walk') });
  // (3,0) 挤爆：直穿 5 格代价 1+201+1+1+1=205 vs 绕行 7 格×1=7
  fields.next('crowd')[3] = 4;
  fields.swap('crowd');
  c.bump();
  const p = finder.path(0, 0, 7, 0);
  const cells = p.map(([x, y]) => Math.floor(y) * 8 + Math.floor(x));
  assert.ok(!cells.includes(3), '应绕开拥堵格');
  assert.equal(p.length, 10);   // 绕行：直行 7 格改走下一行 → 10 格 9 步（g=9 << 直穿 207）
});

test('批量寻路预算：60 实体 × 全图路径 < 100ms（A3 卡死场景回归）', () => {
  const { finder } = mkSystem(mkPlain(16, 16), { maxExpand: 8000 });
  const t0 = process.hrtime.bigint();
  let ok = 0;
  for (let k = 0; k < 60; k++) {
    const p = finder.path(k % 16, (k / 16) | 0, 15 - (k % 16), 15 - ((k / 16) | 0));
    if (p) ok++;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`    60 实体全图寻路 = ${ms.toFixed(2)}ms（成功 ${ok}/60）`);
  assert.equal(ok, 60);
  assert.ok(ms < 100, `60 实体寻路 ${ms.toFixed(2)}ms 超预算`);
});

test('96×64 全图一次寻路 < 5ms', () => {
  const { finder } = mkSystem(mkPlain(96, 64), { maxExpand: 20000 });
  const t0 = process.hrtime.bigint();
  const p = finder.path(0, 0, 95, 63);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`    96×64 全图寻路 = ${ms.toFixed(2)}ms`);
  assert.ok(p);
  assert.ok(ms < 5, `全图寻路 ${ms.toFixed(2)}ms 超预算`);
});

test('慢路可走：threshold 指定 cost=8 时，穿慢路 vs 绕行按代价决策', () => {
  // 3×1 一行：直接走中间水格(慢路 cost 8) = 1+8+1=10；无路可绕 → 必须走
  const world = fromArrays({ W: 3, H: 1, seed: 1, terr: new Array(3).fill(TERR.GRASS) });
  const fields = createFields({ W: 3, H: 1 });
  fields.register('water');
  fields.next('water')[1] = 0.5;
  fields.swap('water');
  const c = createCost({ world, fields });
  c.define('walk', { fields: [{ name: 'water', mode: 'threshold', at: 0.3, cost: 8 }] });
  const finder = createPathfinder({ world, costs: () => c.cost('walk') });
  const p = finder.path(0, 0, 2, 0);
  assert.ok(p, '慢路可走，不应返回 null');
  assert.equal(p.length, 3);
});

/* ---------- U18 对齐原型 ---------- */

test('pathIndices：格索引数组，首尾正确，与 path() 等长', () => {
  const { finder } = mkSystem(mkPlain());
  const idx = finder.pathIndices(0, 0, 3, 0);
  assert.equal(idx[0], 0);           // start (0,0)
  assert.equal(idx[3], 3);           // target (3,0) → index 3
  assert.equal(idx.length, 4);
  const p = finder.path(0, 0, 3, 0);
  assert.equal(idx.length, p.length);
  // 相邻索引必须 4 邻接
  for (let k = 1; k < idx.length; k++) {
    const a = idx[k - 1], b = idx[k];
    const d = Math.abs((a % 8) - (b % 8)) + Math.abs(((a / 8) | 0) - ((b / 8) | 0));
    assert.equal(d, 1, `路径第 ${k} 步不邻接`);
  }
});

test('分数代价下最优性：0.1 便宜的捷径必须被选中', () => {
  // 1×3 线：cost [1, 0.1, 1]，走中格总代价 1.1 < 直达不存在 → 必经中格
  // 构造 3×1 世界，中格给 mult 0.05 的低水场（cost = 1*(1+0.05*... )）
  const world = fromArrays({ W: 3, H: 1, seed: 1, terr: new Array(3).fill(TERR.GRASS) });
  const fields = createFields({ W: 3, H: 1 });
  fields.register('water');
  fields.next('water')[1] = 0.02;    // cost = 1*(1+2*0.02) = 1.04 —— ε=1e-6 下必须可感知
  fields.swap('water');
  const c = createCost({ world, fields });
  c.define('walk', { fields: [{ name: 'water', mode: 'mult', k: 2 }] });
  const finder = createPathfinder({ world, costs: () => c.cost('walk') });
  const p = finder.path(0, 0, 2, 0); // 唯一路径必经中格，长度 3
  assert.equal(p.length, 3);
  // 关键断言：pathIndices 版本两次调用一致（精确比较下无 ε 抖动）
  assert.deepEqual(finder.pathIndices(0, 0, 2, 0), finder.pathIndices(0, 0, 2, 0));
});

/* ---------- GF4 默认上限回归 ---------- */

test('GF4：96×64 默认参数全图寻路必须可达（固定 4000 上限曾假报 null）', () => {
  const { finder } = mkSystem(mkPlain(96, 64));      // 不传 maxExpand，走默认
  const p = finder.path(0, 0, 95, 63);
  assert.ok(p, '96×64 全图用默认上限必须可达');
  assert.ok(finder.maxExpand >= 96 * 64 * 2, `默认上限应随世界尺寸（得 ${finder.maxExpand}）`);
});
