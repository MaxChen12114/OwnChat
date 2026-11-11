/* U08 实体全套：仲裁可复现（任意排列同一终态）、三方冲突、超限细节、钳制仲裁、性能冒烟。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnts } from '../entities.mjs';
import { createFields } from '../fields.mjs';

test('仲裁可复现：同一批 move 任意排列，终态逐位一致', () => {
  const mk = () => {
    const e = createEnts({ W: 16, H: 16 });
    const ids = [];
    for (let i = 0; i < 20; i++) ids.push(e.spawn({ kind: 0, x: i % 16, y: (i / 16) | 0 }));
    return { e, ids };
  };
  const moves = ids => ids.map((id, k) => ({ id, x: (k * 7) % 16, y: (k * 3) % 16 }));

  const { e: e1, ids } = mk();
  e1.arbMove(moves(ids));
  const ref = { x: e1.x.slice(), y: e1.y.slice() };

  // 8 种不同排列（含逆序），终态必须全同
  for (let p = 0; p < 8; p++) {
    const { e, ids: ids2 } = mk();
    const m = moves(ids2);
    // 确定性洗牌（禁 Math.random 的门禁也约束测试吗？——测试文件允许，但保持一致性用固定种子）
    let s = 1234 + p;
    for (let i = m.length - 1; i > 0; i--) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const j = s % (i + 1);
      [m[i], m[j]] = [m[j], m[i]];
    }
    e.arbMove(m);
    assert.deepEqual({ x: e.x.slice(), y: e.y.slice() }, ref, `排列 ${p} 终态不同`);
  }
});

test('三方同格冲突：只有 id 最小的占住，blocked=2', () => {
  const e = createEnts({ W: 8, H: 8 });
  const a = e.spawn({ kind: 0, x: 0, y: 0 });
  const b = e.spawn({ kind: 0, x: 1, y: 1 });
  const c = e.spawn({ kind: 0, x: 2, y: 2 });
  const r = e.arbMove([{ id: c, x: 4, y: 4 }, { id: a, x: 4, y: 4 }, { id: b, x: 4, y: 4 }]);
  assert.equal(r.moved, 1);
  assert.equal(r.blocked, 2);
  assert.equal(e.x[a], 4);
  assert.equal(e.x[b], 1);
  assert.equal(e.x[c], 2);
});

test('不同目标格互不干扰，全部通过', () => {
  const e = createEnts({ W: 8, H: 8 });
  const ids = [0, 1, 2].map(k => e.spawn({ kind: 0, x: k, y: 0 }));
  const r = e.arbMove(ids.map((id, k) => ({ id, x: k + 1, y: 1 })));
  assert.equal(r.moved, 3);
  assert.equal(r.blocked, 0);
});

test('arbMove 跳过死者（GF8：无仲裁 move 已删，不再有绕过通道）', () => {
  const e = createEnts({ W: 8, H: 8 });
  const a = e.spawn({ kind: 0, x: 0, y: 0 });
  e.remove(a);
  const r = e.arbMove([{ id: a, x: 5, y: 5 }]);
  assert.equal(r.moved, 0);
  assert.equal(e.x[a], 0);
  assert.ok(!('move' in e), '导出对象不得再有 move');
});

test('超限细节：多次被拒计数累加，remove 不减 overflow', () => {
  const e = createEnts({ W: 4, H: 4, cap: 2 });
  e.spawn({ kind: 0, x: 0, y: 0 });
  const b = e.spawn({ kind: 0, x: 1, y: 0 });
  e.spawn({ kind: 0, x: 2, y: 0 });   // 拒 #1
  e.spawn({ kind: 0, x: 3, y: 0 });   // 拒 #2
  e.spawn({ kind: 0, x: 0, y: 1 });   // 拒 #3
  assert.equal(e.overflow(), 3);
  e.remove(b);
  assert.equal(e.overflow(), 3, 'overflow 是累计报警数，remove 不回退');
  assert.equal(e.count(), 1);
});

test('remove 再 spawn 同 id 不复活死者属性', () => {
  const e = createEnts({ W: 8, H: 8 });
  const a = e.spawn({ kind: 0, x: 1, y: 1, hp: 0.9, attrs: { name: '张三' } });
  e.remove(a);
  const b = e.spawn({ kind: 1, x: 2, y: 2, hp: 1 });
  assert.ok(b > a);
  assert.equal(e.hp[b], 1);
  assert.equal(e.attrsOf(b), null);
  assert.equal(e.count(), 1);
});

test('钳制碰撞：多个实体被钳到同一角，按 id 定序', () => {
  const e = createEnts({ W: 4, H: 4 });
  const a = e.spawn({ kind: 0, x: 3, y: 3 });
  const b = e.spawn({ kind: 0, x: 3, y: 3 });
  const r = e.arbMove([{ id: b, x: 99, y: 99 }, { id: a, x: 99, y: 99 }]);
  assert.equal(r.moved, 1);
  assert.equal(r.blocked, 1);
  assert.equal(e.x[a], 3);
  assert.equal(e.y[b], 3);
});

test('density 跨格分布：两格各 1、一格 2', () => {
  const fields = createFields({ W: 8, H: 8 });
  fields.register('crowd');
  const e = createEnts({ W: 8, H: 8, fields });
  const ids = [
    e.spawn({ kind: 0, x: 1, y: 1 }),
    e.spawn({ kind: 0, x: 1, y: 1 }),
    e.spawn({ kind: 0, x: 4, y: 2 }),
    e.spawn({ kind: 0, x: 6, y: 6 }),
  ];
  e.density('crowd');
  const b = fields.next('crowd');
  assert.equal(b[9], 2);
  assert.equal(b[2 * 8 + 4], 1);
  assert.equal(b[6 * 8 + 6], 1);
  assert.equal(e.count(), 4);
});

test('性能冒烟：1000 实体仲裁 < 10ms', () => {
  const e = createEnts({ W: 64, H: 64, cap: 1000 });
  const ids = [];
  for (let i = 0; i < 1000; i++) ids.push(e.spawn({ kind: 0, x: i % 64, y: (i / 64) | 0 }));
  const moves = ids.map(id => ({ id, x: (id * 13) % 64, y: (id * 7) % 64 }));
  const t0 = process.hrtime.bigint();
  e.arbMove(moves);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`    arbMove(1000) = ${ms.toFixed(2)}ms`);
  assert.ok(ms < 10, `1000 实体仲裁耗时 ${ms.toFixed(2)}ms`);
});
