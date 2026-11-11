/* U30 场核函数①：add/decay/downhill。U31 是守恒精确等式回归（A1/A4 锚）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addKernel, decayKernel, downhillKernel } from '../kernels/field.mjs';
import { createFields } from '../fields.mjs';
import { TERR } from '../world.mjs';

const W = 8, H = 8, N = 64;
const ELEV = new Float32Array(N).fill(0.5);        // 平地

function mkFields() {
  const f = createFields({ W, H });
  f.register('water');
  return f;
}

test('add：中心线性衰减、半径外为零、b=a+rain（纯函数）', () => {
  const f = mkFields();
  f.next('water')[27] = 1;                         // 预置存量在中心 (3,3)
  f.swap('water');
  addKernel(f, 'water', { rate: 0.3, cx: 3, cy: 3, rad: 2 });
  const a = f.field('water'), b = f.next('water');
  assert.ok(Math.abs(b[3 * 8 + 3] - 1.3) < 1e-6, '中心加满额');
  const half = b[3 * 8 + 4];                        // 距离 1 → 衰减一半；该格存量 0
  assert.ok(Math.abs(half - 0.15) < 1e-6, `应为 0.15，得 ${half}`);
  assert.equal(b[0], 0, '半径外无雨且无存量 → b=a=0');
});

test('decay：指数蒸发 + 下渗，负值夹 0', () => {
  const f = mkFields();
  f.next('water')[0] = 1;
  f.next('water')[1] = 0.001;                      // 小于 per 会被夹 0
  f.swap('water');
  decayKernel(f, 'water', { rate: 0.1, per: 0.002 });
  const b = f.next('water');
  assert.ok(Math.abs(b[0] - (1 * 0.9 - 0.002)) < 1e-6);
  assert.equal(b[1], 0, '下渗后为负 → 夹 0');
});

test('downhill：单格配额语义——流出 ≤ flowK×v 且按水头差分配', () => {
  const f = mkFields();
  const terrain = new Uint8Array(N).fill(TERR.GRASS);
  f.next('water')[27] = 10;                        // (3,3)
  f.swap('water');
  downhillKernel(f, 'water', { terrain, elev: ELEV, flowK: 0.42, cap: 20 });
  const b = f.next('water');
  const out = 10 - b[27];
  assert.ok(out > 0 && out <= 10 * 0.42 + 1e-6, `流出 ${out} 应 ≤ 配额 4.2`);
  // 四邻居都是平地：水头差同为 10 → 各拿 min(budget/4份额, diff*0.5)……实际按顺序消费
  // 精确语义：d0..d3 顺序，每个 t=min(剩余budget, 10*0.5)=min(剩余, 5)
  // budget=4.2：d0 t=4.2 → budget 0 → 其余 0。邻居(4,3)=格28 得 4.2
  assert.ok(Math.abs(b[28] - 4.2) < 1e-6, `右邻应得 4.2，得 ${b[28]}`);
  assert.equal(b[26] + b[19] + b[35], 0, '配额用完即停');
});

test('downhill：海面当汇（流入海的水消失）', () => {
  const f = mkFields();
  const terrain = new Uint8Array(N).fill(TERR.GRASS);
  terrain[28] = TERR.WATER;                        // 右邻是海
  f.next('water')[27] = 10;
  f.swap('water');
  downhillKernel(f, 'water', { terrain, elev: ELEV });
  const b = f.next('water');
  assert.equal(b[28], 0, '海格清零吸收');
  assert.ok(10 - b[27] > 0, '水流向海');
  // 守恒：写缓冲总量 = 原量 - 流入海部分（sum 读的是 a，downhill 未 swap，须直接查 b）
  let total = 0;
  for (const v of f.next('water')) total += v;
  assert.ok(total < 10, `海吸收后写缓冲总量 ${total} < 10`);
});

test('downhill：NaN 输入被守卫夹 0，不扩散', () => {
  const f = mkFields();
  const terrain = new Uint8Array(N).fill(TERR.GRASS);
  f.next('water')[27] = NaN;
  f.swap('water');
  downhillKernel(f, 'water', { terrain, elev: ELEV });
  const b = f.next('water');
  assert.equal(b[27], 0, 'NaN 格输出 0');
  let nanCount = 0;
  for (const v of b) if (Number.isNaN(v)) nanCount++;
  assert.equal(nanCount, 0, 'NaN 不得扩散');
});

test('downhill：单格上限 cap', () => {
  const f = mkFields();
  const terrain = new Uint8Array(N).fill(TERR.MOUNTAIN);   // 全山：无处可流
  f.next('water')[27] = 100;
  f.swap('water');
  downhillKernel(f, 'water', { terrain, elev: ELEV, cap: 20 });
  assert.equal(f.next('water')[27], 20, '超限夹到 cap');
});

test('downhill：两跑逐位一致（row-major 确定性）', () => {
  const run = () => {
    const f = mkFields();
    const terrain = new Uint8Array(N).fill(TERR.GRASS);
    terrain[20] = TERR.WATER;
    for (let k = 0; k < 30; k++) {
      if (k % 3 === 0) addKernel(f, 'water', { rate: 0.05, cx: 3, cy: 3, rad: 4 });
      downhillKernel(f, 'water', { terrain, elev: ELEV });
      f.swap('water');
      decayKernel(f, 'water', { rate: 0.01, per: 0.001 });
      f.swap('water');
    }
    return f.field('water').slice();
  };
  assert.deepEqual(run(), run());
});

/* ---------- U31 守恒精确等式（A1/A4 回归锚） ----------
   判据：total(t) = initial + Σrain − Σ海吸收 − Σ蒸发，逐 tick 记账，容差 1e-4。
   旧 bug（A1 凭空造水 / A4 陈旧累加）在此等式下必然爆炸，跑不过 100 回合。 */

const sumArr = arr => { let s = 0; for (const v of arr) s += v; return s; };

function rainAt(i, cx, cy, rad, rate) {
  const x = i % W, y = (i / W) | 0;
  const d = Math.hypot(x - cx, y - cy);
  return d > rad ? 0 : rate * (1 - d / rad);
}

test('U31① A1 锚：无海无蒸发，100 回合 total == Σrain（精确记账）', () => {
  const f = mkFields();
  const terrain = new Uint8Array(N).fill(TERR.GRASS);      // 无海
  const elev = ELEV;
  const rate = 0.05, cx = 3, cy = 3, rad = 6;
  let total = 0, rainSum = 0;
  for (let t = 1; t <= 100; t++) {
    addKernel(f, 'water', { rate, cx, cy, rad });
    let rainTick = 0;
    for (let i = 0; i < N; i++) rainTick += rainAt(i, cx, cy, rad, rate);
    rainSum += rainTick;
    f.swap('water');
    downhillKernel(f, 'water', { terrain, elev });
    f.swap('water');
    // 无蒸发：decay 不跑
    total = sumArr(f.field('water'));
    // 每 tick 校验：total == rainSum（初始 0）
    if (t % 10 === 0) {
      assert.ok(Math.abs(total - rainSum) < 1e-4 * Math.max(1, rainSum),
        `t=${t} total=${total} vs Σrain=${rainSum} —— 有凭空造水或丢失`);
    }
  }
  assert.ok(Math.abs(total - rainSum) / rainSum < 1e-4,
    `终态：total=${total} Σrain=${rainSum} 相对偏差 ${(Math.abs(total - rainSum) / rainSum).toExponential(2)}`);
});

test('U31② 海吸收记账：total == Σrain − 海面吸收', () => {
  const f = mkFields();
  const terrain = new Uint8Array(N).fill(TERR.GRASS);
  for (const i of [0, 1, 8, 9]) terrain[i] = TERR.WATER;   // 角上一片海
  const rate = 0.05, cx = 4, cy = 4, rad = 6;
  let total = 0, rainSum = 0, absorbed = 0;
  for (let t = 1; t <= 100; t++) {
    addKernel(f, 'water', { rate, cx, cy, rad });
    for (let i = 0; i < N; i++) rainSum += rainAt(i, cx, cy, rad, rate);
    f.swap('water');
    const preDown = sumArr(f.field('water'));
    downhillKernel(f, 'water', { terrain, elev: ELEV });
    absorbed += preDown - sumArr(f.next('water'));          // down 净损失 = 海吸收（无边界损失：wall 界外配额留原地）
    f.swap('water');
    total = sumArr(f.field('water'));
    const expect = rainSum - absorbed;
    if (t % 20 === 0) {
      assert.ok(Math.abs(total - expect) < 1e-4 * Math.max(1, expect),
        `t=${t} total=${total} vs Σrain−吸收=${expect}`);
    }
  }
  assert.ok(absorbed > 0, '海确实吸收了水');
});

test('U31③ 蒸发记账：total == Σrain − 蒸发 − 下渗（无海）', () => {
  const f = mkFields();
  const terrain = new Uint8Array(N).fill(TERR.GRASS);
  const rate = 0.05, cx = 3, cy = 3, rad = 6;
  const dec = { rate: 0.02, per: 0.001 };
  let rainSum = 0, evapSum = 0;
  for (let t = 1; t <= 100; t++) {
    addKernel(f, 'water', { rate, cx, cy, rad });
    for (let i = 0; i < N; i++) rainSum += rainAt(i, cx, cy, rad, rate);
    f.swap('water');
    downhillKernel(f, 'water', { terrain, elev: ELEV });
    f.swap('water');
    const preDecay = sumArr(f.field('water'));
    decayKernel(f, 'water', dec);
    evapSum += preDecay - sumArr(f.next('water'));
    f.swap('water');
    const total = sumArr(f.field('water'));
    const expect = rainSum - evapSum;                        // 无海：无吸收项
    assert.ok(Math.abs(total - expect) < 1e-4 * Math.max(1, expect),
      `t=${t} total=${total} vs Σrain−蒸发=${expect}`);
  }
  assert.ok(evapSum > 0, '蒸发确实发生');
});
