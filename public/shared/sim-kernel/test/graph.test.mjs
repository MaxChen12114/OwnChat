/* U09 冒烟：CRUD/邻接定序/矩阵/确定性。U10 补边界与汇总入口。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGraph } from '../graph.mjs';

function mkCity() {
  const g = createGraph('zones');
  for (const id of ['z3', 'z1', 'z2']) g.addNode(id, { pop: 1000 });
  g.addEdge('z1', 'z2', { len: 5, cap: 100 }, { twoWay: true });
  g.addEdge('z2', 'z3', { len: 7, cap: 80 });
  return g;
}

test('节点 CRUD：重复报错，属性可读', () => {
  const g = mkCity();
  assert.equal(g.nodeCount(), 3);
  assert.throws(() => g.addNode('z1'), /重复/);
  assert.equal(g.nodeAttrs('z1').pop, 1000);
  assert.deepEqual(g.nodeIds(), ['z1', 'z2', 'z3']);
});

test('有向边：单向只有一侧可见', () => {
  const g = mkCity();
  assert.ok(g.edge('z2', 'z3'));
  assert.equal(g.edge('z3', 'z2'), null);
  assert.deepEqual(g.neighbors('z3'), []);
});

test('twoWay：两侧都有', () => {
  const g = mkCity();
  assert.ok(g.edge('z1', 'z2'));
  assert.ok(g.edge('z2', 'z1'));
  assert.equal(g.edge('z1', 'z2').len, 5);
});

test('邻接遍历按 id 升序，与插入顺序无关', () => {
  const g1 = createGraph('a');
  for (const id of ['n1', 'n2', 'n0']) g1.addNode(id);
  g1.addEdge('n0', 'n2'); g1.addEdge('n0', 'n1');
  const g2 = createGraph('b');
  for (const id of ['n0', 'n1', 'n2']) g2.addNode(id);
  g2.addEdge('n0', 'n1'); g2.addEdge('n0', 'n2');
  assert.deepEqual(g1.neighbors('n0').map(p => p[0]), ['n1', 'n2']);
  assert.deepEqual(g2.neighbors('n0').map(p => p[0]), ['n1', 'n2']);
});

test('removeEdge/removeNode 清理干净', () => {
  const g = mkCity();
  assert.equal(g.removeEdge('z1', 'z2', { twoWay: true }), true);
  assert.equal(g.edge('z2', 'z1'), null, 'twoWay 的反向还在？');
  assert.equal(g.removeNode('z2'), true);
  assert.equal(g.edge('z2', 'z3'), null);
  assert.equal(g.edge('z1', 'z2'), null);
  assert.equal(g.nodeCount(), 2);
  assert.equal(g.edgeCount(), 0);
});

test('setEdge 合并更新边数据', () => {
  const g = mkCity();
  assert.equal(g.setEdge('z1', 'z2', { cap: 200, toll: 3 }), true);
  assert.equal(g.edge('z1', 'z2').cap, 200);
  assert.equal(g.edge('z1', 'z2').len, 5, '未提到的字段保留');
});

test('边数据是拷贝（改返回值不伤原图）', () => {
  const g = mkCity();
  const d = g.edge('z1', 'z2');
  d.len = 999;
  assert.equal(g.edge('z1', 'z2').len, 5);
});

test('矩阵：set/get/dims', () => {
  const g = mkCity();
  const od = g.mat('od', 3, 3);
  od.set(1, 2, 42.5);
  assert.equal(od.get(1, 2), 42.5);
  assert.equal(od.rows, 3);
  assert.equal(od.cols, 3);
  assert.equal(od.data.length, 9);
});

test('矩阵按名字复用', () => {
  const g = mkCity();
  const a = g.mat('od', 3, 3);
  const b = g.mat('od', 3, 3);
  assert.equal(a, b);
  assert.deepEqual(g.matNames(), ['od']);
});

test('不存在的节点查邻接报人话错误', () => {
  const g = mkCity();
  assert.throws(() => g.neighbors('zz'), /不存在/);
});

/* ---------- U10 补边界 ---------- */

test('自环边被拒（区内出行走 mat 对角线）', () => {
  const g = createGraph('g');
  g.addNode('a');
  assert.throws(() => g.addEdge('a', 'a'), /自环/);
});

test('单节点图 neighbors 为空', () => {
  const g = createGraph('g');
  g.addNode('only');
  assert.deepEqual(g.neighbors('only'), []);
  assert.equal(g.edgeCount(), 0);
});

test('mat 越界 get/set 抛 RangeError', () => {
  const g = createGraph('g');
  g.addNode('a'); g.addNode('b');
  const m = g.mat('od', 2, 2);
  assert.throws(() => m.get(2, 0), RangeError);
  assert.throws(() => m.set(-1, 0, 1), RangeError);
  assert.throws(() => m.set(0, 5, 1), RangeError);
});

test('50 节点全连接：顺序稳定、边数正确', () => {
  const g = createGraph('full');
  const ids = [];
  for (let i = 0; i < 50; i++) { const id = 'n' + String(i).padStart(2, '0'); ids.push(id); g.addNode(id); }
  for (const a of ids) for (const b of ids) if (a !== b) g.addEdge(a, b, { len: 1 });
  assert.equal(g.edgeCount(), 50 * 49);
  const nb = g.neighbors('n07').map(p => p[0]);
  assert.deepEqual(nb.slice(0, 3), ['n00', 'n01', 'n02']);
  assert.deepEqual(nb.slice(-2), ['n48', 'n49']);
});
