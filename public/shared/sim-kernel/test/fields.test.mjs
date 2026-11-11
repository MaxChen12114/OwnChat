/* U06 场全套测试：守恒（配额模式）、边界不泄漏、A1 反面教材锚、swap 契约、结算顺序。
   重分配 stencil 写在测试里（核函数库 U30 才进内核）——这里验证的是"场"这个容器的契约。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFields, BOUNDS } from '../fields.mjs';

const EPS = 1e-5;
function sumArr(a) { let s = 0; for (let v of a) s += v; return s; }

/* 标准 stencil 写法：b[i] 是 a 的**纯函数**（全量赋值），绝不在 b 上跨格累加。
   b 的底子是上一回合的旧 a —— 累加 = 复利膨胀（本测试曾经 1000 → 2.5e12 实证过）。
   A1 的完整病根 = 「配额」+「纯函数」两条，缺一不可。 */
function redistribute(f, name, rate) {
  const { W, H } = f;
  const a = f.field(name), b = f.next(name);
  const bounds = f.boundsOf(name);
  const give = v => Math.max(v, 0) * rate / 4;   // 每槽固定份额，配额语义
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const v = Math.max(a[i], 0);
    const budget = v * rate;
    const per = budget / 4;
    let inflow = 0, outsideKeep = 0;
    const nb = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
    for (const [nx, ny] of nb) {
      const out = nx < 0 || ny < 0 || nx >= W || ny >= H;
      if (out) {
        if (bounds === 'wall') outsideKeep += per;         // 界外份额留原地
        else if (bounds === 'absorb') { /* 被吸收，消失 */ }
        else { /* wrap */ inflow += give(a[((ny % H) + H) % H * W + ((nx % W) + W) % W]); }
      } else {
        inflow += give(a[ny * W + nx]);
      }
    }
    const keep = (v - budget) + outsideKeep;
    b[i] = keep + inflow;                                   // 纯 a 的函数：全量赋值
  }
}

/* 无配额反面教材：每格还从邻居各收 42%（不除以槽位），纯函数写法照样凭空造水 */
function redistributeNaive(f, name, rate) {
  const { W, H } = f;
  const a = f.field(name), b = f.next(name);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    let inflow = 0;
    if (x > 0) inflow += a[i - 1] * rate;
    if (x < W - 1) inflow += a[i + 1] * rate;
    if (y > 0) inflow += a[i - W] * rate;
    if (y < H - 1) inflow += a[i + W] * rate;
    b[i] = a[i] + inflow;
  }
}

function seedMass(f, name, cx, cy, m) {
  f.next(name)[cy * f.W + cx] = m;
  f.swap(name);
}

/* ---------- 守恒 ---------- */

test('守恒：配额重分配 50 步总量不变', () => {
  const f = createFields({ W: 12, H: 12 });
  f.register('water');
  seedMass(f, 'water', 6, 6, 1000);
  const s0 = f.sum('water');
  for (let t = 0; t < 50; t++) { redistribute(f, 'water', 0.42); f.swap('water'); }
  const s1 = f.sum('water');
  assert.ok(Math.abs(s1 - s0) / s0 < EPS, `总量漂移: ${s0} → ${s1}`);
});

test('反面教材（A1 锚）：无配额 42%×4 邻居 → 总量凭空膨胀', () => {
  const f = createFields({ W: 12, H: 12 });
  f.register('water');
  seedMass(f, 'water', 6, 6, 1000);
  const s0 = f.sum('water');
  redistributeNaive(f, 'water', 0.42);
  f.swap('water');
  const s1 = f.sum('water');
  assert.ok(s1 > s0 * 1.5, `反面教材没复现膨胀？${s0} → ${s1}（rate 语义变了？）`);
});

/* ---------- 边界 ---------- */

test('wall：边界格界外配额留在原地，不泄漏', () => {
  const f = createFields({ W: 6, H: 6 });
  f.register('w', BOUNDS.WALL);
  seedMass(f, 'w', 0, 0, 100);   // 角上：只有 2 个界内邻居
  const s0 = f.sum('w');
  for (let t = 0; t < 30; t++) { redistribute(f, 'w', 0.42); f.swap('w'); }
  assert.ok(Math.abs(f.sum('w') - s0) / s0 < EPS, 'wall 泄漏了');
});

test('wrap：质量穿界复现，总量不变', () => {
  const f = createFields({ W: 6, H: 6 });
  f.register('w', BOUNDS.WRAP);
  seedMass(f, 'w', 0, 0, 100);
  const s0 = f.sum('w');
  for (let t = 0; t < 30; t++) { redistribute(f, 'w', 0.42); f.swap('w'); }
  assert.ok(Math.abs(f.sum('w') - s0) / s0 < EPS, 'wrap 丢了质量');
});

test('absorb：边界质量被吸收，减量恰好等于吸收额', () => {
  const f = createFields({ W: 4, H: 4 });
  f.register('w', BOUNDS.ABSORB);
  seedMass(f, 'w', 0, 0, 100);   // 角上 2 个界外槽位
  const s0 = f.sum('w');
  // 一轮：budget=42，每槽 10.5，两个界外槽位共吞 21
  redistribute(f, 'w', 0.42);
  f.swap('w');
  const s1 = f.sum('w');
  assert.ok(Math.abs((s0 - s1) - 21) < EPS, `吸收额应为 21，实际 ${s0 - s1}`);
});

test('wall 采样钳制：界外坐标取边界值不炸', () => {
  const f = createFields({ W: 4, H: 4 });
  f.register('w');
  f.next('w')[0] = 7;
  f.swap('w');
  assert.equal(f.sample('w', -5, -5), 7);
  assert.equal(f.sample('w', 100, 100), 0);
});

test('absorb 采样：界外返回 0', () => {
  const f = createFields({ W: 4, H: 4 });
  f.register('w', BOUNDS.ABSORB);
  f.next('w')[0] = 7;
  f.swap('w');
  assert.equal(f.sample('w', -1, 0), 0);
  assert.equal(f.sample('w', 0, 0), 7);   // 格点中心取原值
});

/* ---------- swap 契约 ---------- */

test('swap 两次回到原缓冲（未更新的场数据不丢）', () => {
  const f = createFields({ W: 4, H: 4 });
  f.register('w');
  seedMass(f, 'w', 2, 2, 5);
  const before = f.field('w').slice();
  f.swap('w'); f.swap('w');
  assert.deepEqual(f.field('w'), before);
});

test('结算顺序契约：pass 先整场写 b，deposit 后累加，swap 后两者并存', () => {
  const f = createFields({ W: 4, H: 4 });
  f.register('crowd');
  // 模拟第 2 段（场更新）：pass 算出 b
  f.next('crowd')[5] = 10;
  // 模拟第 5 段（移动）实体 deposit
  f.deposit('crowd', 5, 2.5);
  f.swap('crowd');
  assert.equal(f.field('crowd')[5], 12.5);
});
