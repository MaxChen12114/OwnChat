/* U02 rng 全套测试：确定性、域分离、雪崩性、复现性、源码禁 Math.random 扫描。
   扫描覆盖整个 sim-kernel/*.mjs —— 以后每个新模块自动被这条测试把关（铁律 2）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { hash, stream } from '../rng.mjs';

/* ---------- 基本确定性 ---------- */

test('同参数同哈希', () => {
  assert.equal(hash(1234, 'terrain'), hash(1234, 'terrain'));
  assert.equal(hash(1234, 'terrain', 5, 9), hash(1234, 'terrain', 5, 9));
});

test('不同域不同哈希', () => {
  assert.notEqual(hash(1234, 'terrain'), hash(1234, 'agents'));
  assert.notEqual(hash(1234, 'terrain'), hash(1235, 'terrain'));
});

test('参数拆分不串线', () => {
  assert.notEqual(hash(1, 'ab', 'c'), hash(1, 'a', 'bc'));
});

test('hash 接受混合类型域参数', () => {
  assert.equal(hash(1, 'a', 2, true), hash(1, 'a', 2, true));
  assert.notEqual(hash(1, 'a', 2, true), hash(1, 'a', 2, false));
});

test('hash 雪崩性：200 个相邻 seed 输出几乎不重复', () => {
  const seen = new Set();
  for (let s = 0; s < 200; s++) seen.add(hash(s, 'world'));
  assert.ok(seen.size >= 190, `200 个 seed 只有 ${seen.size} 个不同哈希，雪崩不足`);
});

/* ---------- stream 序列 ---------- */

test('stream 同种子同序列（100 步）', () => {
  const a = stream(7, 'rain'), b = stream(7, 'rain');
  for (let i = 0; i < 100; i++) assert.equal(a(), b());
});

test('stream 10000 步完全可复现', () => {
  const a = stream(2026, 'fourstage', 'od');
  const seq = [];
  for (let i = 0; i < 10000; i++) seq.push(a());
  const b = stream(2026, 'fourstage', 'od');
  for (let i = 0; i < 10000; i++) assert.equal(b(), seq[i]);
});

test('stream 不同域序列不同', () => {
  const a = stream(7, 'rain'), b = stream(7, 'crowd');
  let diff = 0;
  for (let i = 0; i < 20; i++) if (a() !== b()) diff++;
  assert.ok(diff >= 15, `20 步里只差 ${diff} 次，域分离不够`);
});

test('stream seed±1 序列不同', () => {
  const a = stream(100, 'x'), b = stream(101, 'x');
  let diff = 0;
  for (let i = 0; i < 20; i++) if (a() !== b()) diff++;
  assert.ok(diff >= 15);
});

test('stream 输出落在 [0,1) 且均值合理', () => {
  const g = stream(42, 'sanity');
  let sum = 0;
  for (let i = 0; i < 10000; i++) {
    const v = g();
    assert.ok(v >= 0 && v < 1, `越界值 ${v}`);
    sum += v;
  }
  const mean = sum / 10000;
  assert.ok(mean > 0.45 && mean < 0.55, `均值 ${mean} 偏离 0.5`);
});

/* ---------- 铁律 2 门禁：模拟层禁 Math.random ---------- */

/* 先剥注释再扫：注释里提到"Math.random"不算违例，代码里真的调用才算 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

test('sim-kernel 全部 .mjs 源码（剥注释后）禁 Math.random', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..');
  const files = readdirSync(dir).filter(f => f.endsWith('.mjs'));
  assert.ok(files.length >= 1, 'sim-kernel 目录为空？');
  const offenders = [];
  for (const f of files) {
    const code = stripComments(readFileSync(join(dir, f), 'utf8'));
    if (code.includes('Math.random')) offenders.push(f);
  }
  assert.deepEqual(offenders, [], `模拟层出现 Math.random: ${offenders.join(', ')}`);
});
