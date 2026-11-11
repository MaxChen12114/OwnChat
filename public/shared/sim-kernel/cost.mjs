/* sim-kernel/cost.mjs — L1 原子·代价派生
   规格 §3.3：把"场 + 静态层 + 政策"折算成通行代价。人流的唯一入口。
   铁律：代价是派生数据不是状态 —— 不进存档、按需重算、版本号脏标记缓存，
   不允许每 tick 全量重算（版本没变就直接返回缓存引用）。
   内核在「场 swap」「overlay 追加」「政策变更」时调 bump()。 */

export function createCost({ world, fields }) {
  const defs = new Map();            // costName -> spec
  const cache = new Map();           // costName -> { arr, atVersion }
  let version = 0;
  let derives = 0;

  /* 世界版本号 +1（kernel 每回合按需调，也可由 overlay seq 直接驱动） */
  function bump() { version++; }

  /* spec = {
       blockers?:  [terrValue, …]                    静态不可通行（水/山/建筑）
       fields?:    [{ name, mode:'threshold', at, cost? }   场阈值 → Infinity（或指定 cost）
                    |  { name, mode:'mult', k }             场乘子 → 乘 (1+k*v)
                    |  { name, mode:'flat', per }           场加值 → + per*v]
       policyCells?: [idx, …]                        政策封格 → Infinity
     } */
  function define(name, spec) {
    if (defs.has(name)) throw new Error(`代价图重复定义: "${name}"`);
    for (const fr of spec.fields || []) {
      if (!['threshold', 'mult', 'flat'].includes(fr.mode)) throw new Error(`代价图 "${name}" 非法 mode: ${fr.mode}`);
      // GF5：数值校验 —— 负乘子会产出负代价图，破坏 A*/Dijkstra 最优性且静默
      if (fr.mode === 'mult' && !(typeof fr.k === 'number' && fr.k >= 0)) {
        throw new TypeError(`代价图 "${name}" 的 mult k 必须 ≥ 0，得到 ${fr.k}（负乘子 = 负边权 = 最短路失效）`);
      }
      if (fr.mode === 'flat' && !(typeof fr.per === 'number' && fr.per >= 0)) {
        throw new TypeError(`代价图 "${name}" 的 flat per 必须 ≥ 0，得到 ${fr.per}`);
      }
      if (fr.mode === 'threshold' && !Number.isFinite(fr.at)) {
        throw new TypeError(`代价图 "${name}" 的 threshold at 必须是有限数，得到 ${fr.at}`);
      }
      if (fr.mode === 'threshold' && fr.cost != null && !(fr.cost > 0)) {
        throw new TypeError(`代价图 "${name}" 的 threshold cost 必须 > 0（或省略表示不可通行 Infinity），得到 ${fr.cost}`);
      }
    }
    defs.set(name, spec);
    bump();
  }

  function derive(def) {
    const { W, H } = world;
    const N = W * H;
    const arr = new Float32Array(N).fill(1);
    const terr = world.terrSlice();
    if (def.blockers) {
      for (let i = 0; i < N; i++) if (def.blockers.includes(terr[i])) arr[i] = Infinity;
    }
    for (const fr of def.fields || []) {
      const buf = fields.field(fr.name);       // 未注册会在这里炸出人话
      for (let i = 0; i < N; i++) {
        if (arr[i] === Infinity) continue;     // 已不可通行，不再叠
        const v = buf[i];
        if (fr.mode === 'threshold') { if (v > fr.at) arr[i] = fr.cost != null ? fr.cost : Infinity; }
        else if (fr.mode === 'mult') { if (v > 0) arr[i] *= 1 + fr.k * v; }
        else { if (v > 0) arr[i] += fr.per * v; }
      }
    }
    if (def.policyCells) for (const i of def.policyCells) arr[i | 0] = Infinity;
    return arr;
  }

  /* 取代价图：版本没变返回缓存引用（零拷贝零重算），变了才重derive */
  function cost(name) {
    const hit = cache.get(name);
    if (hit && hit.atVersion === version) return hit.arr;
    const def = defs.get(name);
    if (!def) throw new Error(`代价图未定义: "${name}"（已定义: ${[...defs.keys()].join(', ') || '无'}）`);
    const arr = derive(def);
    cache.set(name, { arr, atVersion: version });
    derives++;
    return arr;
  }

  return Object.freeze({
    define, cost, bump,
    version: () => version,
    derives: () => derives,        // 给测试/指标看"到底重算了几次"
  });
}
