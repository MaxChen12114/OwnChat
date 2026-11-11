/* U36 冒烟：合法包装载计划/单点校验。U37 扩坏 JSON 人话报错全套。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRulePack, loadRulePack, KERNELS } from '../rules.mjs';

const GOOD = {
  id: 'rain',
  schemaVersion: 1,
  fields: { water: { bounds: 'wall' } },
  params: { rate: 0.02, flow: 0.15 },
  passes: [
    { kernel: 'add', target: 'water', rate: '${rate}', cx: 3, cy: 3, rad: 5, period: 1 },
    { kernel: 'downhill', target: 'water', flowK: '${flow}', period: 1 },
    { kernel: 'decay', target: 'water', rate: 0.001, per: 0.001, period: 5 },
  ],
  costs: [{ from: 'water', when: ['>', '${flow}'], cost: 'Infinity' }],
  metrics: ['floodedCells'],
};

test('合法规则包 → 装载计划完整，参数解析正确', () => {
  const { ok, plan, errors } = validateRulePack(GOOD);
  assert.ok(ok, errors.join('\n'));
  assert.equal(plan.id, 'rain');
  assert.equal(plan.passes.length, 3);
  assert.equal(plan.passes[0].params.rate, 0.02);     // ${rate} 解析
  assert.equal(plan.passes[1].params.flowK, 0.15);
  assert.equal(plan.passes[2].period, 5);
  assert.equal(plan.costs[0].cost, Infinity);
  assert.equal(typeof plan.passes[0].fn, 'function');
});

test('未知核函数 → 报错并列出已知清单', () => {
  const { errors } = validateRulePack({ ...GOOD, passes: [{ kernel: 'explode', target: 'water' }] });
  assert.ok(errors.some(e => e.includes('explode') && e.includes('add')), '应列出已知核函数');
});

test('target 未声明 → 报错含已声明名单', () => {
  const { errors } = validateRulePack({ ...GOOD, passes: [{ kernel: 'add', target: 'lava' }] });
  assert.ok(errors.some(e => e.includes('lava') && e.includes('water')));
});

test('${missing} 参数引用 → 报错含参数名与可用清单', () => {
  const { errors } = validateRulePack({ ...GOOD, passes: [{ kernel: 'add', target: 'water', rate: '${nope}' }] });
  assert.ok(errors.some(e => e.includes('nope') && e.includes('rate')));
});

test('period 非法 → 报错', () => {
  const { errors } = validateRulePack({ ...GOOD, passes: [{ kernel: 'add', target: 'water', rate: 1, period: 1.5 }] });
  assert.ok(errors.some(e => e.includes('period')));
});

test('bounds 非法 → 报错', () => {
  const { errors } = validateRulePack({ ...GOOD, fields: { water: { bounds: 'open' } } });
  assert.ok(errors.some(e => e.includes('bounds') && e.includes('open')));
});

test('顶层键拼写错误 → 报错提示合法键', () => {
  const bad = { ...GOOD, pass: GOOD.passes };        // 典型 typo
  const { errors } = validateRulePack(bad);
  assert.ok(errors.some(e => e.includes('"pass"') && e.includes('passes')));
});

test('schemaVersion 非 1 → 报错', () => {
  const { errors } = validateRulePack({ ...GOOD, schemaVersion: 2 });
  assert.ok(errors.some(e => e.includes('schemaVersion')));
});

test('costs.from 非场 → 报错', () => {
  const { errors } = validateRulePack({ ...GOOD, costs: [{ from: 'lava', when: ['>', 1] }] });
  assert.ok(errors.some(e => e.includes('lava')));
});

test('loadRulePack 聚合报错：三个错误一次报全，不抛栈', () => {
  const bad = {
    id: 'bad', schemaVersion: 1,
    fields: { water: {} },
    params: {},
    passes: [
      { kernel: 'ghost', target: 'water' },
      { kernel: 'add', target: 'lava' },
      { kernel: 'add', target: 'water', rate: '${missing}' },
    ],
  };
  try {
    loadRulePack(bad);
    assert.fail('应当抛出');
  } catch (e) {
    assert.ok(e.found.length === 3, `应一次报 3 条，得 ${e.found.length}`);
    assert.ok(e.message.includes('ghost') && e.message.includes('lava') && e.message.includes('missing'));
    assert.ok(!e.stack.includes('at resolveParam'), '人话错误不带内部栈帧噪声');
  }
});

test('loadRulePack 成功 → 返回 plan 且 passes 有绑定函数', () => {
  const plan = loadRulePack(GOOD);
  assert.equal(plan.passes.length, 3);
  assert.equal(Object.keys(KERNELS).length >= 6, true);
});
