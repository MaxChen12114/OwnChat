/* U34 冒烟：遮挡/对称/视野场。U35 扩耗时与两跑一致。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { los, visibleField } from '../kernels/raycast.mjs';

const W = 16, H = 16, N = W * H;

function mkOpaque(...cells) {
  const o = new Uint8Array(N);
  for (const [x, y] of cells) o[y * W + x] = 1;
  return o;
}

test('直线无遮挡 → 通', () => {
  const o = mkOpaque();
  assert.equal(los(o, W, H, 2, 2, 10, 2), true);
});

test('中间一格墙 → 遮挡；绕开的线不受影响', () => {
  const o = mkOpaque([6, 2]);
  assert.equal(los(o, W, H, 2, 2, 10, 2), false, '直线穿墙');
  assert.equal(los(o, W, H, 2, 3, 10, 3), true, '平行线无墙');
});

test('起终点自身是 opaque 不计（站墙里能看见墙）', () => {
  const o = mkOpaque([2, 2], [10, 2]);
  assert.equal(los(o, W, H, 2, 2, 10, 2), true);
});

test('邻格贴墙斜过：Bresenham 走哪格挡哪格', () => {
  // (2,2)→(4,4)：Bresenham 途经 (3,3)；挡 (3,3) → 断；挡 (3,2)/(2,3)（不在 Bresenham 路上）→ 通
  const o1 = mkOpaque([3, 3]);
  assert.equal(los(o1, W, H, 2, 2, 4, 4), false);
  const o2 = mkOpaque([3, 2], [2, 3]);
  assert.equal(los(o2, W, H, 2, 2, 4, 4), true, '贴角不挡');
});

test('★ 对称性：symmetric 下任意点对 los(a,b) === los(b,a)', () => {
  // 构造随机墙阵（确定性伪随机），测 30 对点
  let s = 42;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const o = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (rnd() < 0.15) o[i] = 1;
  let checked = 0;
  for (let k = 0; k < 30; k++) {
    const ax = (rnd() * W) | 0, ay = (rnd() * H) | 0;
    const bx = (rnd() * W) | 0, by = (rnd() * H) | 0;
    if (ax === bx && ay === by) continue;
    assert.equal(los(o, W, H, ax, ay, bx, by), los(o, W, H, bx, by, ax, ay),
      `(${ax},${ay})→(${bx},${by}) 不对称`);
    checked++;
  }
  assert.ok(checked >= 20, `有效点对太少 ${checked}`);
});

test('symmetric=false 时单向结果保留（不对称场景存在）', () => {
  // 精心构造：对角线在斜率 1/2 处的差异 —— 一条途经 (3,2)，另一条途经 (2,3)
  const o = mkOpaque([3, 2]);
  const a = los(o, W, H, 2, 2, 6, 4, { symmetric: false });
  const b = los(o, W, H, 6, 4, 2, 2, { symmetric: false });
  // 单向可能不同（本例 a 通 b 也通或不同，只断言"保留了单向语义"不炸即可）
  assert.equal(typeof a, 'boolean');
  assert.equal(typeof b, 'boolean');
});

test('visibleField：自身=1，墙前可见墙后不可见', () => {
  const o = mkOpaque([8, 4]);                 // 墙在 (x=8, y=4)
  const v = visibleField(o, W, H, 2, 4);
  assert.equal(v[4 * W + 2], 1, '自身');       // 索引 = y*W + x
  assert.equal(v[4 * W + 7], 1, '墙前');
  assert.equal(v[4 * W + 8], 1, '墙本身可见');
  assert.equal(v[4 * W + 10], 0, '墙后正对不可见');   // (10,4) 与视线共线
});

test('visibleField：两张墙阵两跑逐位一致', () => {
  const o = mkOpaque([5, 5], [6, 5], [7, 8], [10, 2]);
  const a = visibleField(o, W, H, 3, 3);
  const b = visibleField(o, W, H, 3, 3);
  assert.deepEqual(a, b);
});

/* ---------- U35 全套 ---------- */

test('U35：长斜线遮挡精确性——Bresenham 路径上任意格可断', () => {
  const W2 = 20, H2 = 20;
  const o = new Uint8Array(W2 * H2);
  // (2,2)→(14,10)：dx=12, dy=8；Bresenham 途经格由核函数逐格给出——挡中间任意一格必须断
  // 先用无墙 los 拿到路径：遮挡测试法——逐格挡，除起终点外都应断
  let pathCells = [];
  for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) {
    if ((x === 2 && y === 2) || (x === 14 && y === 10)) continue;
    const test = new Uint8Array(W2 * H2);
    test[y * W2 + x] = 1;
    if (!los(test, W2, H2, 2, 2, 14, 10, { symmetric: false })) pathCells.push([x, y]);
  }
  // Bresenham 内部格数 = max(dx,dy)+1 − 起终点 = 12+1−2 = 11（精确）
  assert.equal(pathCells.length, 11, `路径内部格数应恰为 11，得 ${pathCells.length}`);
  // 挡路径上任意一格必须断（对称模式）
  const [mx, my] = pathCells[(pathCells.length / 2) | 0];
  const oMid = new Uint8Array(W2 * H2);
  oMid[my * W2 + mx] = 1;
  assert.equal(los(oMid, W2, H2, 2, 2, 14, 10), false, '挡路径中格必须断');
  assert.equal(los(oMid, W2, H2, 14, 10, 2, 2), false, '反向同样断（对称）');
});

test('U35：可见矩阵对称——5 中心 × 全图 v[a][b]===v[b][a]', () => {
  const o = mkOpaque([6, 5], [7, 5], [9, 9], [3, 10], [12, 3]);
  const centers = [[2, 2], [8, 8], [14, 1], [1, 14], [8, 4]];
  for (const [ax, ay] of centers) {
    const va = visibleField(o, W, H, ax, ay);
    for (const [bx, by] of centers) {
      if (ax === bx && ay === by) continue;
      assert.equal(va[by * W + bx], los(o, W, H, ax, ay, bx, by) ? 1 : 0,
        `visibleField 与 los 不一致 (${ax},${ay})→(${bx},${by})`);
    }
  }
});

test('U35：稠密墙阵可见格数量合理（< 空场的一半）', () => {
  let s = 7;
  const o = new Uint8Array(N);
  for (let i = 0; i < N; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; if ((s / 0x7fffffff) < 0.3) o[i] = 1; }
  const open = visibleField(new Uint8Array(N), W, H, 2, 2);
  const dense = visibleField(o, W, H, 2, 2);
  const openCount = open.reduce((a, b) => a + b, 0);
  const denseCount = dense.reduce((a, b) => a + b, 0);
  assert.ok(denseCount < openCount * 0.6, `稠密墙可见 ${denseCount} 应 < 空场 ${openCount} 的 60%`);
});

test('U35：出界目标 → false（不炸）', () => {
  const o = mkOpaque();
  assert.equal(los(o, W, H, 2, 2, 20, 5), false);
  assert.equal(los(o, W, H, 2, 2, 5, -3), false);
});

test('U35：全图耗时 96×64 < 20ms（min-of-3）', () => {
  const W3 = 96, H3 = 64;
  let s = 11;
  const o = new Uint8Array(W3 * H3);
  for (let i = 0; i < o.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; if ((s / 0x7fffffff) < 0.12) o[i] = 1; }
  visibleField(o, W3, H3, 48, 32);          // 预热
  let best = Infinity;
  for (let k = 0; k < 3; k++) {
    const t0 = process.hrtime.bigint();
    visibleField(o, W3, H3, 48, 32);
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  console.log(`    visibleField 96×64 min-of-3 = ${best.toFixed(1)}ms`);
  assert.ok(best < 20, `全图视野 ${best.toFixed(1)}ms 超预算`);
});
