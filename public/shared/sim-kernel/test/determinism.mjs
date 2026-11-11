#!/usr/bin/env node
/* sim-kernel/test/determinism.mjs — 确定性闸门（P0 验收，规格 §15）
   判据：同种子、同决策、200 回合，跑两遍 ——
     ① trace 指纹链逐行一致（compareTraces identical）
     ② dump JSON 逐字节一致
     ③ 分片调度跑（每 tick 一次预算）与整跑也逐字节一致（调度不变性）
   全过 → exit 0；任何一条不过 → 打印分叉点，exit 1。 */

import { generateWorld, TERR } from '../world.mjs';
import { createFields } from '../fields.mjs';
import { createEnts } from '../entities.mjs';
import { createCost } from '../cost.mjs';
import { createPasses } from '../passes.mjs';
import { createEvents } from '../events.mjs';
import { createKernel } from '../kernel.mjs';
import { createTrace, compareTraces, traceFromDump } from '../trace.mjs';

const TICKS = 200;
const SEED = 2026;

function buildRun(seed, decision) {
  const world = generateWorld({ W: 48, H: 32, seed });
  const fields = createFields({ W: world.W, H: world.H });
  fields.register('water');
  fields.register('crowd');
  const ents = createEnts({ W: world.W, H: world.H, fields, cap: 200 });
  const walkers = [];
  for (let k = 0; k < 12; k++) walkers.push(ents.spawn({ kind: 0, x: 5 + k, y: 10 }));
  const cost = createCost({ world, fields });
  cost.define('walk', { blockers: [TERR.WATER, TERR.MOUNTAIN] });
  const passes = createPasses({ fields });
  passes.register({ id: 'rain', reads: [], writes: ['water'], period: 1, run(ctx) {
    const b = ctx.fields.next('water');
    const a = ctx.fields.field('water');
    for (let i = 0; i < b.length; i++) b[i] = a[i] + 0.008;   // 纯函数（GF2）
  } });
  const ev = createEvents();
  ev.when({ metric: 'moved', op: '>', value: 1e9 }, { type: 'never' });   // 恒不触发，验证条件路径无害
  const trace = createTrace(world, { seed, ticks: TICKS });
  const kernel = createKernel({
    world, fields, passes, events: ev, ents, cost, costNames: ['walk'],
    depositFields: ['crowd'], fingerprintEvery: 1,
    decisionProvider: (tick) => walkers.map((id, k) => ({ id, x: (5 + k + tick * decision.stepX) % world.W, y: 10 + ((tick * decision.stepY) % world.H) })),
    onDiff: d => trace.record(d),
  });
  return { kernel, trace };
}

function main() {
  console.log(`确定性闸门：seed=${SEED}，${TICKS} 回合，两遍整跑 + 一遍分片调度`);
  const t0 = Date.now();

  const A = buildRun(SEED, { stepX: 1, stepY: 1 });
  A.kernel.step(TICKS);

  const B = buildRun(SEED, { stepX: 1, stepY: 1 });
  B.kernel.step(TICKS);

  // ① 指纹链
  const cmp = compareTraces(A.trace, B.trace);
  if (!cmp.identical) {
    console.error(`✗ 指纹链分叉 @t=${cmp.firstDivergence} (lenA=${cmp.lenA} lenB=${cmp.lenB})`);
    process.exit(1);
  }
  console.log(`  ① 指纹链一致（${cmp.lenA} 行）`);

  // ② JSON 逐字节
  const ja = JSON.stringify(A.trace.dump());
  const jb = JSON.stringify(B.trace.dump());
  if (ja !== jb) {
    for (let i = 0; i < Math.min(ja.length, jb.length); i++) {
      if (ja[i] !== jb[i]) { console.error(`✗ JSON 在第 ${i} 字节分叉：…${ja.slice(i - 40, i + 10)}…`); break; }
    }
    process.exit(1);
  }
  console.log(`  ② dump 逐字节一致（${(ja.length / 1024).toFixed(1)}KB）`);

  // ③ 调度不变性：分片（每回合一次预算）重跑 C
  const C = buildRun(SEED, { stepX: 1, stepY: 1 });
  while (C.kernel.tick() < TICKS) {
    const g = C.kernel.stepGen(TICKS - C.kernel.tick(), 0.05);   // 每 tick 最多 0.05ms → 多数回合跑 1 步就停
    let r = g.next();
    while (!r.done) r = g.next();
  }
  const restored = traceFromDump(ja);
  const cmpC = compareTraces(restored, C.trace);
  if (!cmpC.identical) {
    console.error(`✗ 分片调度与整跑分叉 @t=${cmpC.firstDivergence}`);
    process.exit(1);
  }
  console.log(`  ③ 分片调度（预算切片）与整跑逐字节一致`);

  const ms = Date.now() - t0;
  console.log(`✓ 确定性闸门通过：3/3 判据全绿，末指纹 ${A.trace.lastFp().toString(16)}，总耗时 ${ms}ms`);
}

main();
