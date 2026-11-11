/* U32 冒烟：diffuse/clamp/smooth。U33 扩守恒与幂等全套。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffuseKernel, clampKernel, smoothKernel } from '../kernels/field2.mjs';
import { createFields, BOUNDS } from '../fields.mjs';
import { TERR } from '../world.mjs';

const W = 8, H = 8, N = 64;

function mk(bounds = 'wall') {
  const f = createFields({ W, H });
  f.register('w', bounds);
  return f;
}

test('diffuse：内部对称交换守恒', () => {
  const f = mk();
  f.next('w')[27] = 10;
  f.next('w')[36] = 6;      // 两格都有质量，度数都 4
  f.swap('w');
  const before = f.sum('w');
  diffuseKernel(f, 'w', { diff: 0.3 });
  f.swap('w');
  assert.ok(Math.abs(f.sum('w') - before) < 1e-4, `总量 ${before} → ${f.sum('w')}`);
});

test('diffuse：wall 边界格（度数≠4）也严格守恒', () => {
  const f = mk();
  f.next('w')[0] = 10;      // 角格度数 2
  f.next('w')[9] = 5;       // 内部
  f.swap('w');
  const before = f.sum('w');
  diffuseKernel(f, 'w', { diff: 0.5 });
  f.swap('w');
  assert.ok(Math.abs(f.sum('w') - before) < 1e-4, `角格守恒失败 ${before} → ${f.sum('w')}`);
});

test('diffuse：wrap 穿界守恒', () => {
  const f = mk(BOUNDS.WRAP);
  f.next('w')[0] = 10;
  f.swap('w');
  const before = f.sum('w');
  diffuseKernel(f, 'w', { diff: 0.4 });
  f.swap('w');
  assert.ok(Math.abs(f.sum('w') - before) < 1e-4);
});

test('diffuse：diff=0 恒等；diff=1 纯邻居均值', () => {
  const f = mk();
  f.next('w')[27] = 8;
  f.swap('w');
  diffuseKernel(f, 'w', { diff: 0 });
  assert.equal(f.next('w')[27], 8);
  diffuseKernel(f, 'w', { diff: 1 });
  const b = f.next('w');
  // 度数 4 全平地 0 → b[27] = 0
  assert.equal(b[27], 0);
});

test('diffuse：非法 diff 报错', () => {
  const f = mk();
  assert.throws(() => diffuseKernel(f, 'w', { diff: -0.1 }), /diffuse diff/);
  assert.throws(() => diffuseKernel(f, 'w', { diff: 1.5 }), /diffuse diff/);
});

test('clamp：夹住两端', () => {
  const f = mk();
  f.next('w')[0] = -5;
  f.next('w')[1] = 3;
  f.next('w')[2] = 50;
  f.swap('w');
  clampKernel(f, 'w', { lo: 0, hi: 10 });
  const b = f.next('w');
  assert.deepEqual([b[0], b[1], b[2]], [0, 3, 10]);
});

test('clamp：幂等（跑两遍 == 跑一遍后再跑）', () => {
  const f = mk();
  f.next('w')[0] = 42;
  f.swap('w');
  clampKernel(f, 'w', { lo: 0, hi: 10 });
  f.swap('w');
  const once = f.field('w').slice();
  clampKernel(f, 'w', { lo: 0, hi: 10 });
  f.swap('w');
  assert.deepEqual(f.field('w'), once, 'clamp 幂等');
});

test('smooth：平地不变，尖峰摊平', () => {
  const f = mk();
  for (let i = 0; i < N; i++) f.next('w')[i] = 1;
  f.next('w')[27] = 9;
  f.swap('w');
  smoothKernel(f, 'w');
  f.swap('w');
  const a = f.field('w');
  assert.equal(a[0], 1, '远角平地不变');
  assert.ok(a[27] > 1 && a[27] < 9, `尖峰应被摊平到 (1,9)，得 ${a[27]}`);
  // 中心格 3×3 含一个 9、八个 1 → (9+8)/9 = 1.888…
  assert.ok(Math.abs(a[27] - 17 / 9) < 1e-5);
});

test('两跑逐位一致', () => {
  const run = () => {
    const f = mk(BOUNDS.WRAP);
    for (let k = 0; k < 20; k++) f.next('w')[(k * 7) % N] = 1 + (k % 3);
    f.swap('w');
    for (let t = 0; t < 15; t++) {
      diffuseKernel(f, 'w', { diff: 0.2 });
      f.swap('w');
      if (t % 3 === 0) { smoothKernel(f, 'w'); f.swap('w'); }
      clampKernel(f, 'w', { lo: 0, hi: 2 });
      f.swap('w');
    }
    return f.field('w').slice();
  };
  assert.deepEqual(run(), run());
});

/* ---------- U33 全套 ---------- */

test('U33：diffuse 100 步长跑守恒（wall/wrap/absorb 三边界）', () => {
  for (const bounds of ['wall', 'wrap', 'absorb']) {
    const f = mk(bounds);
    f.next('w')[27] = 10;
    f.next('w')[40] = 5;
    f.swap('w');
    const before = f.sum('w');
    for (let t = 0; t < 100; t++) {
      diffuseKernel(f, 'w', { diff: 0.3 });
      f.swap('w');
    }
    const after = f.sum('w');
    assert.ok(Math.abs(after - before) < 1e-4 * Math.max(1, before),
      `${bounds} 100 步守恒失败 ${before} → ${after}`);
  }
});

test('U33：对称性——孤立质量扩散后四邻对称（wall 内部）', () => {
  const f = mk();
  f.next('w')[27] = 16;      // (3,3) 内部格
  f.swap('w');
  diffuseKernel(f, 'w', { diff: 0.5 });
  f.swap('w');
  const a = f.field('w');
  assert.equal(a[28], a[26], '左右对称');
  assert.equal(a[19], a[35], '上下对称');
  assert.equal(a[28], a[19], '四方向等权');
});

test('U33：clamp×diffuse 组合 50 步——被夹掉的质量计入账本', () => {
  const f = mk();
  f.next('w')[27] = 10;
  f.next('w')[36] = 2;
  f.swap('w');
  let accounted = f.sum('w');          // 账面初始
  for (let t = 0; t < 50; t++) {
    diffuseKernel(f, 'w', { diff: 0.3 });
    f.swap('w');
    const pre = f.sum('w');
    clampKernel(f, 'w', { lo: 0, hi: 3 });
    f.swap('w');
    const post = f.sum('w');
    accounted -= (pre - post);         // clamp 损失入账
    assert.ok(Math.abs(f.sum('w') - accounted) < 1e-4, `t=${t} 组合记账漂移`);
  }
});

test('U33：smooth 角落格 3×3 钳制计数正确（4 格均值）', () => {
  const f = mk();
  // 角(0,0) 的 3×3 钳制后含 (0,0)(1,0)(0,1)(1,1) 四格，值 1/2/3/4 → 均值 2.5
  f.next('w')[0] = 1;
  f.next('w')[1] = 2;
  f.next('w')[8] = 3;
  f.next('w')[9] = 4;
  f.swap('w');
  smoothKernel(f, 'w');
  f.swap('w');
  assert.ok(Math.abs(f.field('w')[0] - 2.5) < 1e-6, `角落均值应为 2.5，得 ${f.field('w')[0]}`);
});

test('U33：diffuse 性能 96×64 一次 < 1ms（min-of-3）', () => {
  const f = createFields({ W: 96, H: 64 });
  f.register('w');
  f.next('w')[3000] = 5;
  f.swap('w');
  diffuseKernel(f, 'w', { diff: 0.2 });   // 预热
  let best = Infinity;
  for (let k = 0; k < 3; k++) {
    const t0 = process.hrtime.bigint();
    diffuseKernel(f, 'w', { diff: 0.2 });
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  console.log(`    diffuse 96×64 min-of-3 = ${best.toFixed(3)}ms`);
  assert.ok(best < 1, `diffuse ${best.toFixed(3)}ms 超预算`);
});
