/* sim-kernel/entities.mjs — L1 原子·实体
   规格 §3.2：SoA 扁平数组（不是对象数组），上限默认 4000，超限报警不静默扩容。
   不变量：
   - 实体不能自己改坐标：一切移动走 move/arbMove，由内核仲裁
   - 同格冲突按 id 定序（id 小的先占），不按浮点坐标 —— 确定性要求
   - id 永不复用：死槽不回收。复用会破坏 trace 归因与"回放不重问"的可追溯性
   - GF8：无仲裁的 move() 已删除——改坐标的唯一通道是 arbMove（同格冲突按 id 定序） */

export function createEnts({ W, H, cap = 4000, fields = null } = {}) {
  const x = new Float32Array(cap), y = new Float32Array(cap);
  const kind = new Uint8Array(cap), policy = new Uint8Array(cap);
  const vx = new Float32Array(cap), vy = new Float32Array(cap);
  const hp = new Float32Array(cap), mass = new Float32Array(cap);
  const pathOfs = new Int32Array(cap), pathLen = new Int32Array(cap);
  const alive = new Uint8Array(cap);
  const attrs = new Map();      // id -> 非数值附加属性（名字/颜色等，走堆，不进 SoA）

  let n = 0;                    // 已发放的 slot 数（= 下一个 id）
  let liveCount = 0;
  let overflow = 0;             // 超限被拒次数（可观测，规格 §5.3 的"算得少"代价可见化）

  function spawn(o) {
    if (n >= cap) { overflow++; return -1; }     // 报警不静默扩容
    const id = n++;
    alive[id] = 1; liveCount++;
    x[id] = +o.x || 0; y[id] = +o.y || 0;
    kind[id] = o.kind | 0;
    vx[id] = +o.vx || 0; vy[id] = +o.vy || 0;
    hp[id] = o.hp == null ? 1 : +o.hp;
    mass[id] = o.mass == null ? 1 : +o.mass;
    policy[id] = o.policy | 0;                   // 0=规则 1=agent 决策缓存
    pathOfs[id] = o.pathOfs | 0; pathLen[id] = o.pathLen | 0;
    if (o.attrs) attrs.set(id, o.attrs);
    return id;
  }

  function remove(id) {
    if (!alive[id]) return false;
    alive[id] = 0; liveCount--;
    attrs.delete(id);
    return true;
  }

  /* 同格冲突仲裁：moves = [{id,x,y}]，按 id 升序处理，目标格先到先得。
     返回 {moved, blocked}。排序本身确定 → 结果确定。 */
  function arbMove(moves) {
    const ordered = [...moves].sort((a, b) => a.id - b.id);
    const claimed = new Set();
    let moved = 0, blocked = 0;
    for (const m of ordered) {
      if (!alive[m.id]) continue;
      const cx = Math.min(Math.max(Math.floor(m.x), 0), W - 1);
      const cy = Math.min(Math.max(Math.floor(m.y), 0), H - 1);
      const cell = cy * W + cx;
      if (claimed.has(cell)) { blocked++; continue; }
      claimed.add(cell);
      x[m.id] = cx; y[m.id] = cy;
      moved++;
    }
    return { moved, blocked };
  }

  /* 实体→场：把在场实体按格写入 fields 的写缓冲（1/实体，或按 mass 加权）。 */
  function density(fieldName, weightMass = false) {
    if (!fields) throw new Error('density 需要 fields（createEnts({fields}) 传入）');
    const b = fields.next(fieldName);
    for (let id = 0; id < n; id++) {
      if (!alive[id]) continue;
      const cx = Math.min(Math.max(Math.floor(x[id]), 0), W - 1);
      const cy = Math.min(Math.max(Math.floor(y[id]), 0), H - 1);
      b[cy * W + cx] += weightMass ? mass[id] : 1;
    }
  }

  function forEach(fn) {
    for (let id = 0; id < n; id++) if (alive[id]) fn(id);
  }

  return Object.freeze({
    W, H, cap,
    x, y, kind, policy, vx, vy, hp, mass, pathOfs, pathLen,   // 只读引用（内部仍可变，内核专用）
    spawn, remove, arbMove, density, forEach,   // GF8：move 已删——无仲裁直写接口不对外，规则包一律 arbMove
    count: () => liveCount,
    issued: () => n,
    overflow: () => overflow,
    attrsOf: id => attrs.get(id) || null,
  });
}
