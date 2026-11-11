/* sim-kernel/passes.mjs — pass 注册表与调度
   规格 §3.4：场更新按 pass 表跑（读 a 写 b），各 pass 可有不同 period。
   不变量（注册期静态检测，报错不给机会）：
   - 同一个 pass 不能既读又写同一场
   - 两个 pass 写同一场 → 报错（规则包耦合冲突必须显式解决，不许静默）
   - 引用未注册的场 → 报错
   调度：执行序 = 注册序（确定性）；period>0，tick % period === 0 的回合才跑
   （period=1 每回合，period=5 在 tick 5,10,15…）。跑完后只 swap 本回合被写的场。 */

export function createPasses({ fields }) {
  const passes = [];
  const writerOf = new Map();          // field -> pass id（写冲突检测）

  function register(p) {
    if (!p || !p.id) throw new TypeError('pass 需要 id');
    if (passes.some(q => q.id === p.id)) throw new Error(`pass id 重复: "${p.id}"`);
    if (!Array.isArray(p.reads) || !Array.isArray(p.writes)) throw new TypeError(`pass "${p.id}" 需要 reads/writes 数组`);
    const period = p.period == null ? 1 : p.period;
    if (!(Number.isInteger(period) && period >= 1)) throw new TypeError(`pass "${p.id}" period 必须是正整数，得到 ${p.period}`);
    const known = new Set(fields.fields());
    for (const f of [...p.reads, ...p.writes]) {
      if (!known.has(f)) throw new Error(`pass "${p.id}" 引用未注册的场 "${f}"（已注册: ${fields.fields().join(', ') || '无'}）`);
    }
    const overlap = p.writes.filter(w => p.reads.includes(w));
    if (overlap.length) throw new Error(`pass "${p.id}" 读写同一场: ${overlap.join(', ')}（同一 pass 不许既读又写，规格铁律）`);
    for (const w of p.writes) {
      if (writerOf.has(w)) throw new Error(`场 "${w}" 已被 pass "${writerOf.get(w)}" 声明写入，pass "${p.id}" 再写 → 冲突（规则包必须显式解决）`);
      writerOf.set(w, p.id);
    }
    const rec = Object.freeze({ id: p.id, reads: [...p.reads], writes: [...p.writes], period, run: p.run });
    passes.push(rec);
    return rec;
  }

  /* 推进一个 tick：按注册序执行到期 pass。
     opts.deferSwap=true 时不立刻 swap，把写入集合交给调用方统一处理
     （GF1：kernel 要把 deposit 场与 pass 写入场合成同一个 swap 批次，
      否则 deposit 落在 swap 之后的陈旧 b 上，永不可见）。
     默认（不传 opts）保持旧语义：跑完立即 swap，返回 swapped。 */
  function runTick(tick, ctx, opts = {}) {
    const ran = [];
    const writtenFields = new Set();
    for (const p of passes) {
      if (tick % p.period !== 0) continue;
      p.run(ctx, tick);
      ran.push(p.id);
      for (const w of p.writes) writtenFields.add(w);
    }
    if (opts.deferSwap) return { ran, written: writtenFields, swapped: [] };
    const swapped = [...writtenFields];
    for (const f of swapped) fields.swap(f);
    return { ran, written: writtenFields, swapped };
  }

  return Object.freeze({
    register, runTick,
    list: () => passes.map(p => ({ id: p.id, period: p.period, reads: [...p.reads], writes: [...p.writes] })),
    writerOf: f => writerOf.get(f) || null,
  });
}
