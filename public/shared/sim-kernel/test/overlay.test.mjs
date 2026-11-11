/* U19 冒烟：append 校验/seq 递增/truncate/快照拷贝。U21 扩回放一致与归因。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOverlay, OPS } from '../overlay.mjs';
import { fromArrays, TERR } from '../world.mjs';

function mkWorld() {
  return fromArrays({ W: 8, H: 8, seed: 1, terr: new Array(64).fill(TERR.GRASS) });
}

function mkOverlay() {
  return createOverlay(mkWorld());
}

test('append 递增 seq，归因字段完整', () => {
  const ov = mkOverlay();
  const s1 = ov.append({ t: 480, who: 'faction:red', op: 'terrain', cells: [5], to: TERR.WATER });
  const s2 = ov.append({ t: 482, who: 'player', op: 'terrain', cells: [6], to: TERR.SAND });
  assert.equal(s2, s1 + 1);
  const ev = ov.snapshot()[0];
  assert.equal(ev.t, 480);
  assert.equal(ev.who, 'faction:red');
  assert.equal(ev.to, TERR.WATER);
  assert.equal(ov.lastSeq(), s2);
});

test('cells 越界报人话错误（报索引和尺寸）', () => {
  const ov = mkOverlay();
  assert.throws(() => ov.append({ t: 1, who: 'p', op: 'terrain', cells: [64], to: 2 }), /越界.*64.*8×8/);
  assert.throws(() => ov.append({ t: 1, who: 'p', op: 'terrain', cells: [-1], to: 2 }), RangeError);
});

test('未知 op 报错并列出合法清单', () => {
  const ov = mkOverlay();
  assert.throws(() => ov.append({ t: 1, who: 'p', op: 'explode', cells: [1], to: 2 }), /explode.*terrain/);
  assert.ok(OPS.length >= 6);
});

test('terrain to 非法枚举报错', () => {
  const ov = mkOverlay();
  assert.throws(() => ov.append({ t: 1, who: 'p', op: 'terrain', cells: [1], to: 99 }), /枚举/);
});

test('t 负数 / who 空 / cells 空 → 全部报错', () => {
  const ov = mkOverlay();
  assert.throws(() => ov.append({ t: -1, who: 'p', op: 'terrain', cells: [1], to: 2 }), TypeError);
  assert.throws(() => ov.append({ t: 1, who: '', op: 'terrain', cells: [1], to: 2 }), TypeError);
  assert.throws(() => ov.append({ t: 1, who: 'p', op: 'terrain', cells: [], to: 2 }), TypeError);
});

test('truncate：删掉 seq 之后的事件，seq 退回，再 append 编号继续', () => {
  const ov = mkOverlay();
  const s3 = ov.append({ t: 1, who: 'a', op: 'terrain', cells: [1], to: 1 });
  ov.append({ t: 2, who: 'b', op: 'terrain', cells: [2], to: 2 });
  ov.append({ t: 3, who: 'c', op: 'terrain', cells: [3], to: 3 });
  const removed = ov.truncate(s3);
  assert.equal(removed, 2);
  assert.equal(ov.count(), 1);
  assert.equal(ov.lastSeq(), s3);
  const s4 = ov.append({ t: 4, who: 'd', op: 'terrain', cells: [4], to: 2 });
  assert.equal(s4, s3 + 1, '截断后编号从截断点继续');
});

test('truncate(0) 清空全部', () => {
  const ov = mkOverlay();
  ov.append({ t: 1, who: 'a', op: 'terrain', cells: [1], to: 1 });
  ov.append({ t: 2, who: 'a', op: 'terrain', cells: [2], to: 1 });
  assert.equal(ov.truncate(0), 2);
  assert.equal(ov.count(), 0);
  assert.equal(ov.lastSeq(), 0);
});

test('snapshot 是深拷贝：改快照不伤账本', () => {
  const ov = mkOverlay();
  ov.append({ t: 1, who: 'a', op: 'terrain', cells: [1, 2], to: 1 });
  const snap = ov.snapshot();
  snap[0].who = 'hacked';
  snap[0].cells[0] = 999;
  assert.equal(ov.snapshot()[0].who, 'a');
  assert.equal(ov.snapshot()[0].cells[0], 1);
});

test('note 超长截断到 200（防账本被灌垃圾）', () => {
  const ov = mkOverlay();
  ov.append({ t: 1, who: 'a', op: 'terrain', cells: [1], to: 1, note: 'x'.repeat(500) });
  assert.equal(ov.snapshot()[0].note.length, 200);
});

/* ---------- U20 投影 ---------- */

test('无事件投影 = base 原样', () => {
  const world = mkWorld();
  const ov = createOverlay(world);
  const v = ov.project();
  assert.equal(v.terrAt(0), world.terrAt(0));
  assert.equal(v.ownerAt(0), null);
});

test('terrain 事件覆盖 base，其余格不动', () => {
  const world = mkWorld();
  const ov = createOverlay(world);
  ov.append({ t: 1, who: 'red', op: 'terrain', cells: [5], to: TERR.WATER });
  const v = ov.project();
  assert.equal(v.terrAt(5), TERR.WATER);
  assert.equal(v.terrAt(6), world.terrAt(6));
  assert.equal(v.ownerAt(5).who, 'red');
  assert.equal(v.ownerAt(6), null);
});

test('zone/bh 事件各自作用', () => {
  const ov = mkOverlay();
  ov.append({ t: 1, who: 'p', op: 'zone', cells: [3], to: 2 });
  ov.append({ t: 1, who: 'p', op: 'bh', cells: [3], to: 7.5 });
  const v = ov.project();
  assert.equal(v.zoneAt(3), 2);
  assert.equal(v.bhAt(3), 7.5);
});

test('同格多事件：seq 后者胜，归因指向最后写入者', () => {
  const ov = mkOverlay();
  ov.append({ t: 1, who: 'red', op: 'terrain', cells: [9], to: TERR.WATER });
  ov.append({ t: 2, who: 'blue', op: 'terrain', cells: [9], to: TERR.SAND });
  const v = ov.project();
  assert.equal(v.terrAt(9), TERR.SAND);
  assert.equal(v.ownerAt(9).who, 'blue');
});

test('viewAt(S)：回放到任意 seq 与当时状态一致（时间轴的地基）', () => {
  const ov = mkOverlay();
  ov.append({ t: 1, who: 'a', op: 'terrain', cells: [1], to: TERR.WATER });   // seq1
  ov.append({ t: 2, who: 'b', op: 'terrain', cells: [1], to: TERR.FOREST });  // seq2
  const now = ov.project();
  const past = ov.project(1);
  assert.equal(now.terrAt(1), TERR.FOREST);
  assert.equal(past.terrAt(1), TERR.WATER, '回放到 seq=1 应看到水');
  assert.equal(past.ownerAt(1).who, 'a');
  assert.equal(ov.project(0).terrAt(1), mkWorld().terrAt(1), 'seq=0 = 纯 base');
});

test('投影不碰 base：project 后 base 世界逐字节不变', () => {
  const world = mkWorld();
  const before = world.terrSlice();
  const ov = createOverlay(world);
  ov.append({ t: 1, who: 'a', op: 'terrain', cells: [1, 2, 3], to: TERR.WATER });
  ov.project();
  assert.deepEqual(world.terrSlice(), before);
});

test('facility 事件进设施清单（语义 U45 落地）', () => {
  const ov = mkOverlay();
  ov.append({ t: 5, who: 'player', op: 'facility', cells: [10, 11], to: 'pump', note: '西区泵站' });
  const v = ov.project();
  const fac = v.facilities();
  assert.equal(fac.length, 1);
  assert.equal(fac[0].kind, 'pump');
  assert.equal(fac[0].who, 'player');
  assert.deepEqual(fac[0].cells, [10, 11]);
});

/* ---------- U21 全套：可复现性闭环 ---------- */

test('回放一致：两份独立 overlay 同事件序列 → 投影逐字节一致', () => {
  const mk = () => {
    const world = mkWorld();
    const ov = createOverlay(world);
    ov.append({ t: 1, who: 'red', op: 'terrain', cells: [5, 6], to: TERR.WATER });
    ov.append({ t: 2, who: 'blue', op: 'zone', cells: [5], to: 3 });
    ov.append({ t: 3, who: 'red', op: 'terrain', cells: [6], to: TERR.SAND });
    return { world, ov };
  };
  const a = mk(), b = mk();
  assert.deepEqual(a.ov.project().terrSlice(), b.ov.project().terrSlice());
  assert.deepEqual(
    a.ov.snapshot().map(e => [e.seq, e.who, e.op, e.to]),
    b.ov.snapshot().map(e => [e.seq, e.who, e.op, e.to]));
});

test('撤销闭环：truncate(S) 后投影 == 当初 project(S)', () => {
  const world = mkWorld();
  const ov = createOverlay(world);
  ov.append({ t: 1, who: 'a', op: 'terrain', cells: [1], to: TERR.WATER });   // seq1
  ov.append({ t: 2, who: 'b', op: 'terrain', cells: [1], to: TERR.FOREST });  // seq2
  const at1 = ov.project(1).terrSlice();      // 当时 seq=1 的世界
  ov.truncate(1);                              // 撤销 seq2
  assert.deepEqual(ov.project().terrSlice(), at1, '截断重放必须精确还原当时');
  assert.equal(ov.project().ownerAt(1).who, 'a', '归因也回到截断前');
});

test('存档往返：事件 JSON → 新 overlay → 投影一致', () => {
  const world = mkWorld();
  const ov = createOverlay(world);
  ov.append({ t: 1, who: 'red', op: 'terrain', cells: [5], to: TERR.WATER, note: '人工湖' });
  ov.append({ t: 2, who: 'blue', op: 'bh', cells: [7], to: 12.5 });
  const saved = JSON.parse(JSON.stringify(ov.snapshot()));
  const ov2 = createOverlay(world);
  for (const e of saved) ov2.append(e);
  assert.deepEqual(ov2.project().terrSlice(), ov.project().terrSlice());
  assert.deepEqual(ov2.project().ownerAt(7), ov.project().ownerAt(7));
  assert.equal(ov2.snapshot()[0].note, '人工湖');
});

test('seq 是唯一权威序：乱序 t 事件按提交序应用', () => {
  const ov = mkOverlay();
  ov.append({ t: 9, who: 'late', op: 'terrain', cells: [2], to: TERR.WATER });   // seq1, t=9
  ov.append({ t: 1, who: 'early', op: 'terrain', cells: [2], to: TERR.SAND });   // seq2, t=1
  const v = ov.project();
  assert.equal(v.terrAt(2), TERR.SAND, 'seq=2 后提交者胜（t 只是标注，不是排序键）');
  assert.equal(v.ownerAt(2).who, 'early');
});

test('from 只记账不校验：与实际不符也入账（审计语义）', () => {
  const ov = mkOverlay();
  const s = ov.append({ t: 1, who: 'a', op: 'terrain', cells: [1], from: TERR.MOUNTAIN, to: TERR.WATER });
  assert.equal(s, 1);
  assert.equal(ov.snapshot()[0].from, TERR.MOUNTAIN);
  assert.equal(ov.project().terrAt(1), TERR.WATER);
});

test('性能：1000 事件投影 < 5ms（min-of-3）', () => {
  const ov = mkOverlay();
  for (let k = 0; k < 1000; k++) {
    ov.append({ t: k, who: 'stress', op: 'terrain', cells: [k % 64], to: TERR.WATER });
  }
  ov.project();      // 预热
  let best = Infinity;
  for (let r = 0; r < 3; r++) {
    const t0 = process.hrtime.bigint();
    ov.project();
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  console.log(`    project(1000 事件) min-of-3 = ${best.toFixed(2)}ms`);
  assert.ok(best < 5, `1000 事件投影 ${best.toFixed(2)}ms 超预算`);
});

/* ---------- GF9 投影缓存 ---------- */

test('GF9：同 seq 重复 project 返回同一冻结对象（零重建）', () => {
  const ov = mkOverlay();
  ov.append({ t: 1, who: 'a', op: 'terrain', cells: [1], to: TERR.WATER });
  const v1 = ov.project();
  const v2 = ov.project();
  assert.equal(v1, v2, 'seq 不变必须命中缓存（同一引用）');
  const h1 = ov.project(1);
  const h2 = ov.project(1);
  assert.equal(h1, h2, 'viewAt 同 seq 也要命中');
});

test('GF9：append 后缓存失效，投影反映新事件', () => {
  const ov = mkOverlay();
  const v1 = ov.project();
  ov.append({ t: 1, who: 'a', op: 'terrain', cells: [2], to: TERR.MOUNTAIN });
  const v2 = ov.project();
  assert.notEqual(v1, v2, 'seq 变了必须重建');
  assert.equal(v2.terrAt(2), TERR.MOUNTAIN);
});

test('GF9：truncate 后缓存失效', () => {
  const ov = mkOverlay();
  ov.append({ t: 1, who: 'a', op: 'terrain', cells: [1], to: TERR.WATER });
  const v1 = ov.project();
  ov.truncate(0);
  const v2 = ov.project();
  assert.notEqual(v1, v2);
  assert.equal(v2.terrAt(1), mkWorld().terrAt(1), '截断后回到 base');
});
