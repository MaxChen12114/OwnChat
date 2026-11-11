/* U04 world 全套测试：四数组确定性、导出完整性、只读保护、非法输入拒绝、边界尺寸。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateWorld, fromJSON, fromArrays, TERR, ZONE } from '../world.mjs';

/* ---------- 确定性 ---------- */

test('同种子两次生成，四数组逐字节一致', () => {
  const a = generateWorld({ W: 48, H: 32, seed: 7 });
  const b = generateWorld({ W: 48, H: 32, seed: 7 });
  assert.deepEqual(a.terrSlice(), b.terrSlice());
  assert.deepEqual(a.toJSON().elev, b.toJSON().elev);
  assert.deepEqual(a.toJSON().zone, b.toJSON().zone);
  assert.deepEqual(a.toJSON().bh, b.toJSON().bh);
});

test('不同种子世界不同', () => {
  const a = generateWorld({ W: 48, H: 32, seed: 7 });
  const b = generateWorld({ W: 48, H: 32, seed: 8 });
  assert.notDeepEqual(a.terrSlice(), b.terrSlice());
});

/* ---------- 生成分布 ---------- */

test('生成世界分布合理（有水有陆地）', () => {
  const w = generateWorld({ W: 96, H: 64, seed: 1 });
  const counts = new Array(5).fill(0);
  for (const v of w.terrSlice()) counts[v]++;
  assert.ok(counts[TERR.WATER] > 200, `水面太少: ${counts[TERR.WATER]}`);
  assert.ok(counts[TERR.GRASS] + counts[TERR.FOREST] > 1000, '陆地太少');
});

test('zone 全部落在枚举 0..6', () => {
  const j = generateWorld({ W: 64, H: 48, seed: 9 }).toJSON();
  for (const v of j.zone) assert.ok(v >= 0 && v <= 6, `zone 越界: ${v}`);
});

test('城市带：中心附近以 COM/RES 为主', () => {
  const w = generateWorld({ W: 64, H: 48, seed: 9 });
  let urban = 0, total = 0;
  for (let y = 18; y < 30; y++) for (let x = 24; x < 40; x++) {
    const z = w.zoneAt(y * 64 + x);
    if (z !== ZONE.WATER) { total++; if (z === ZONE.COM || z === ZONE.RES) urban++; }
  }
  assert.ok(total > 0, '中心采样区全是水，无法验证');
  assert.ok(urban / total > 0.5, `中心区域城市带占比 ${(urban / total).toFixed(2)}，环带失效`);
});

test('elev 全域落在 [0,1]', () => {
  const j = generateWorld({ W: 48, H: 32, seed: 2 }).toJSON();
  for (const v of j.elev) assert.ok(v >= 0 && v <= 1, `elev 越界: ${v}`);
});

/* ---------- 只读保护 ---------- */

test('牌桌只读：冻结、无写入 API、导出是拷贝', () => {
  const w = generateWorld({ W: 16, H: 16, seed: 5 });
  assert.ok(Object.isFrozen(w));
  assert.throws(() => { w.seed = 99; }, TypeError);
  const j = w.toJSON();
  j.terr[0] = 99;
  assert.notEqual(w.terrAt(0), 99);
});

test('grid/layers 若传入则冻结', () => {
  const w = fromArrays({ W: 8, H: 8, seed: 1,
    grid: { origin: [110.0, 23.0], cellSize: 100, crs: 'EPSG:4326' },
    layers: { road: [1, 2, 3] } });
  assert.ok(Object.isFrozen(w.grid));
  assert.ok(Object.isFrozen(w.layers));
  assert.equal(w.grid.cellSize, 100);
});

/* ---------- 非法输入拒绝 ---------- */

test('fromJSON：terr 长度不匹配抛 TypeError', () => {
  assert.throws(() => fromJSON({ W: 4, H: 4, terr: [0, 1, 2] }), TypeError);
});

test('fromJSON：非正尺寸抛 TypeError', () => {
  assert.throws(() => fromJSON({ W: 0, H: 4 }), TypeError);
  assert.throws(() => fromJSON({ W: 4, H: -1 }), TypeError);
});

test('缺省数组：zone/bh 未给时补零不炸', () => {
  const w = fromJSON({ W: 4, H: 4, seed: 1, terr: new Array(16).fill(TERR.GRASS) });
  assert.equal(w.toJSON().zone.length, 16);
  assert.equal(w.toJSON().bh.length, 16);
});

/* ---------- 边界尺寸 ---------- */

test('单格世界 W=1,H=1 正常', () => {
  const w = generateWorld({ W: 1, H: 1, seed: 1 });
  assert.equal(w.toJSON().terr.length, 1);
  assert.ok(w.terrAt(0) >= 0 && w.terrAt(0) <= 4);
});
