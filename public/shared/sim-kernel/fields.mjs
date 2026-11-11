/* sim-kernel/fields.mjs — L1 原子·场
   规格 §3.1：一格一个连续量的存储与演化，引擎不知道场叫什么名字。
   双缓冲：本回合所有 pass 读 a 写 b，回合末 swap —— 同 pass 不得读写同一场
   （该静态检测在 rules.mjs/passes.mjs 做注册期校验，这里提供数据与缓冲）。
   边界必须显式声明，默认 wall；场数量上限 8，防规则包乱开层。

   ★ GF2 铁律（写 pass 的唯一安全姿势）：
     b 在任何时刻的内容都不可信（swap 后 b = 上一回合的旧 a）。
     唯一安全写法 = 对 a 的纯函数全量赋值：b[i] = F(a[i], a[邻居])。
     b[i] += Δ 的真实语义是 a(t+1) = a(t-1) + Δ —— 速率减半且 period>1 时踩更陈旧的底子。
     成对流耦合（i↔j 互给，如 downhill）用 delta 草稿：先 fill(0) 再统一写回（NOTES-proto §1）。 */

export const BOUNDS = { WALL: 'wall', WRAP: 'wrap', ABSORB: 'absorb' };
export const MAX_FIELDS = 8;

export function createFields({ W, H, cap = MAX_FIELDS }) {
  const regs = new Map();   // name -> { a, b, bounds }（a=当前读缓冲，b=写缓冲）

  /* 注册一个场。bounds 必须显式给（wall|wrap|absorb），不给默认 wall。 */
  function register(name, bounds = BOUNDS.WALL, init = 0) {
    if (regs.has(name)) throw new Error(`场重复注册: "${name}"`);
    if (regs.size >= cap) throw new Error(`场数量超上限 ${cap}（第 ${regs.size + 1} 个 "${name}" 被拒）`);
    if (!Object.values(BOUNDS).includes(bounds)) throw new Error(`非法边界 "${bounds}"（可用: ${Object.values(BOUNDS).join('/')}）`);
    const a = new Float32Array(W * H);
    if (init) a.fill(init);
    regs.set(name, { a, b: new Float32Array(W * H), bounds });
    return name;
  }

  function reg(name) {
    const r = regs.get(name);
    if (!r) throw new Error(`未注册的场 "${name}"（已注册: ${[...regs.keys()].join(', ') || '无'}）`);
    return r;
  }

  /* 读缓冲（本 pass 的上一状态） */
  function field(name) { return reg(name).a; }
  /* 写缓冲（本 pass 的输出；必须整场写满，swap 才无脏数据） */
  function next(name) { return reg(name).b; }

  /* 双线性采样（实体读场用）。fx/fy 为格坐标（可带小数）。 */
  function sample(name, fx, fy) {
    const { a, bounds } = reg(name);
    let x = fx, y = fy;
    if (bounds === BOUNDS.ABSORB) {
      if (x < 0 || y < 0 || x > W - 1 || y > H - 1) return 0;
    } else if (bounds === BOUNDS.WRAP) {
      x = ((x % W) + W) % W;
      y = ((y % H) + H) % H;
    } else {
      x = Math.min(Math.max(x, 0), W - 1);
      y = Math.min(Math.max(y, 0), H - 1);
    }
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = bounds === BOUNDS.WRAP ? (x0 + 1) % W : Math.min(x0 + 1, W - 1);
    const y1 = bounds === BOUNDS.WRAP ? (y0 + 1) % H : Math.min(y0 + 1, H - 1);
    const tx = x - x0, ty = y - y0;
    const i00 = y0 * W + x0, i10 = y0 * W + x1, i01 = y1 * W + x0, i11 = y1 * W + x1;
    return a[i00] * (1 - tx) * (1 - ty) + a[i10] * tx * (1 - ty)
         + a[i01] * (1 - tx) * ty       + a[i11] * tx * ty;
  }

  /* 实体→场：往写缓冲累加（人流密度、火源）。v 可为负（消耗）。 */
  function deposit(name, i, v) {
    reg(name).b[i | 0] += v;
  }

  /* 回合末换缓冲。只换本回合被更新过的场（period 逻辑由 kernel 决定）。 */
  function swap(name) {
    const r = reg(name);
    const t = r.a; r.a = r.b; r.b = t;
  }
  function swapAll() { for (const n of regs.keys()) swap(n); }

  /* 给指标/规则包校验用的便捷统计 */
  function sum(name) {
    const { a } = reg(name);
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i];
    return s;
  }
  function max(name) {
    const { a } = reg(name);
    let m = -Infinity;
    for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i];
    return m;
  }
  /* GF7：一阶空间矩 Σ i·v —— 与 sum 配合可检测"总量不变、空间挪动"的重分布分叉 */
  function moment(name) {
    const { a } = reg(name);
    let s = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== 0) s += i * a[i];
    return s;
  }

  return Object.freeze({
    W, H, cap,
    register, field, next, sample, deposit, swap, swapAll, sum, max, moment,
    fields: () => [...regs.keys()],
    boundsOf: name => reg(name).bounds,
  });
}
