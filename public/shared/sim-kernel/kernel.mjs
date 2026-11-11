/* sim-kernel/kernel.mjs — 组装 + step()：八段回合
   规格 §11 的落地。段序固定，不许规则包改：
     1 收件   events.tick() 派发情景事件与条件触发
     2 场更新 passes.runTick()（读 a 写 b，跑完只 swap 本回合被写的场）
     3 派生   cost.bump() 后显式重derive 声明的代价图（代价用"本回合刚更新过"的场）
     4 决策   decisionProvider(tick, ctx) → 意图（本回合指令本回合生效）
     5 移动   ents.arbMove(意图) + density 实体→场（写缓冲）
     6 结算   settle(ctx, tick)（规则包核函数：占领/资源/伤亡）
     7 记账   每 fingerprintEvery 回合算状态指纹
     8 出栈   diff → onDiff(diff)（渲染/trace 只吃差分）
   全栈唯一时钟 = kernel.tick；rAF/trace 都只是它的消费者。 */

import { hash } from './rng.mjs';

export function createKernel(parts) {
  const {
    world, fields, passes, events, ents, cost,
    costNames = [],                 // 段 3 显式重derive 的代价图名
    depositFields = [],             // 段 5 实体→场（[field 或 {field, weightMass}]）
    decisionProvider = null,        // (tick, ctx) => [{id,x,y}, …]（U62 接 intents；今晚接脚本 agent）
    metricsProvider = null,         // (tick, ctx) => {指标名: 值}（GF3：喂给段 1 条件触发；不传则条件触发不评估）
    settle = null,                  // (ctx, tick) 规则包结算钩子
    onDiff = null,                  // (diff) 渲染/trace 出栈
    fingerprintEvery = 10,
  } = parts;

  if (!world || !fields || !passes || !events) throw new TypeError('createKernel 需要 world/fields/passes/events');

  let tick = 0;
  let lastFingerprint = 0;
  const lastDiff = () => _lastDiff;
  let _lastDiff = null;

  function ctx() {
    return { world, fields, passes, events, ents, cost, tick, overlay: parts.overlay || null };
  }

  /* 段 7：状态指纹。取实体位置量化 + 各场 sum + tick —— 足以检测分叉，够轻。 */
  function fingerprint() {
    const parts_ = [tick];
    if (ents) {
      for (let id = 0; id < ents.issued(); id++) {
        parts_.push(Math.round(ents.x[id] * 16), Math.round(ents.y[id] * 16));
      }
    }
    for (const name of fields.fields()) {
      parts_.push(Math.round(fields.sum(name) * 1024), Math.round(fields.moment(name) * 1024));   // GF7：空间矩堵重分布分叉
    }
    return hash(world.seed ?? 0, 'fingerprint', ...parts_);
  }

  /* 八段一步（内部）。返回 diff。
     段序（GF1 修正后）：收件 → 场写(deferSwap) → 决策 → 移动/deposit →
     统一 swap(written∪deposit) → 派生 → 结算 → 记账 → 出栈。
     与规格 §11 的差异：swap 统一延后、派生随之在移动后 —— 因为 deposit 必须与
     pass 写入同批 swap 才可见（否则 GF1：deposit 永不可见）；"代价用刚更新过的场"
     的段序理由不受影响。 */
  function oneTick() {
    tick++;
    const c = ctx();

    /* 1 收件（GF3：metricsProvider 让条件触发可达，不再硬编码 null） */
    const metrics = metricsProvider ? metricsProvider(tick, c) : null;
    const dispatched = events.tick(tick, metrics);

    /* 2 场更新（写，不 swap —— swap 统一到 deposit 之后） */
    const { ran, written } = passes.runTick(tick, c, { deferSwap: true });

    /* 4 决策（决策在移动之前：本回合指令本回合生效） */
    let moves = [];
    if (decisionProvider) moves = decisionProvider(tick, c) || [];

    /* 5 移动 + 实体→场（deposit-only 场先清零陈旧 b：本回合密度是全新写入，A4） */
    let moveResult = null;
    if (ents && moves.length) moveResult = ents.arbMove(moves);
    const depositNames = [];
    if (ents) {
      for (const df of depositFields) {
        const name = typeof df === 'string' ? df : df.field;
        const wm = typeof df === 'object' ? !!df.weightMass : false;
        if (!written.has(name)) fields.next(name).fill(0);
        ents.density(name, wm);
        depositNames.push(name);
      }
    }

    /* 2.5 统一 swap：written（b=F(a)[+deposit]）∪ deposit（b=0+deposit） */
    const swapSet = new Set([...written, ...depositNames]);
    const swapped = [...swapSet];
    for (const f of swapped) fields.swap(f);

    /* 3 派生（统一 swap 后 bump：代价图吃到本回合刚更新过的场——含实体密度） */
    if (cost && swapped.length) {
      cost.bump();
      for (const name of costNames) cost.cost(name);
    }

    /* 6 结算 */
    if (settle) settle(c, tick);

    /* 7 记账 */
    if (tick % fingerprintEvery === 0) lastFingerprint = fingerprint();

    /* 8 出栈 */
    _lastDiff = {
      t: tick,
      ran, swapped,
      events: dispatched.map(e => ({ id: e.id, type: e.type })),
      moved: moveResult ? moveResult.moved : 0,
      blocked: moveResult ? moveResult.blocked : 0,
      fingerprint: lastFingerprint,
    };
    if (onDiff) onDiff(_lastDiff);
  }

  /* 帧预算调度（CM 机制重写）：生成器逐回合让出，调用方（渲染循环/批跑）按预算拉。
     铁律：预算只决定"何时算"，绝不进模拟 —— 分片跑与一次跑结果逐位一致（U26 测试钉死）。
     budgetMs=Infinity / maxSteps=Infinity 各自可选。yield = 本回合 diff。 */
  function* stepGen(maxSteps = Infinity, budgetMs = Infinity) {
    const deadline = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + budgetMs;
    let done = 0;
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    while (done < maxSteps) {
      if (done > 0 && now() >= deadline) return { steps: done, budgetExceeded: true };
      oneTick();
      done++;
      yield _lastDiff;
    }
    return { steps: done, budgetExceeded: false };
  }

  /* step(n)：跑满 n 回合（内部走生成器，行为与分片完全一致）。返回当前 tick。 */
  function step(stepsN = 1) {
    const g = stepGen(stepsN, Infinity);
    let r = g.next();
    while (!r.done) r = g.next();
    return tick;
  }

  return Object.freeze({
    step, stepGen,
    tick: () => tick,
    fingerprint,
    lastDiff,
  });
}
