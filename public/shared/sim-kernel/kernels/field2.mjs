/* sim-kernel/kernels/field2.mjs — 场核函数②：diffuse / clamp / smooth
   全部纯函数 stencil（GF2 铁律）：b[i] = F(a, 邻居)，全量赋值。
   diffuse 守恒公式：b[i] = (1-diff)*a[i] + Σ_{j∈nb(i)} diff*a[j]/deg(j)
   —— 逐边交换份额按"源格度数"分摊，任意度数图（含 wall 边界、wrap 穿界）总量严格守恒。
   参数单位：diff 无量纲/回合 ∈ [0,1]。 */

export function diffuseKernel(fields, name, { diff }) {
  if (!(diff >= 0 && diff <= 1)) throw new RangeError(`diffuse diff 必须 ∈ [0,1]，得到 ${diff}`);
  const { W, H } = fields;
  const a = fields.field(name), b = fields.next(name);
  // 预计算每格度数：wall 界外邻居不计入；wrap 邻居取模回绕 → 度数恒 4
  const wrap = fields.boundsOf(name) === 'wrap';
  const deg = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let d = 4;
      if (!wrap) {
        if (x === 0 || x === W - 1) d--;
        if (y === 0 || y === H - 1) d--;
      }
      deg[i] = d;
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let inflow = 0;
      // 4 方向；wall 界外跳过；wrap 取模
      const nb = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
      for (const [nx, ny] of nb) {
        let jx = nx, jy = ny;
        if (jx < 0 || jx >= W || jy < 0 || jy >= H) {
          if (fields.boundsOf(name) !== 'wrap') continue;      // wall：无此邻居
          jx = (jx % W + W) % W; jy = (jy % H + H) % H;
        }
        inflow += diff * a[jy * W + jx] / deg[jy * W + jx];
      }
      b[i] = (1 - diff) * a[i] + inflow;
    }
  }
}

/* clamp：夹到 [lo, hi]。幂等。 */
export function clampKernel(fields, name, { lo, hi }) {
  if (!(lo <= hi)) throw new RangeError(`clamp 需要 lo ≤ hi，得到 ${lo}/${hi}`);
  const N = fields.W * fields.H;
  const a = fields.field(name), b = fields.next(name);
  for (let i = 0; i < N; i++) {
    const v = a[i];
    b[i] = v < lo ? lo : v > hi ? hi : v;
  }
}

/* smooth：3×3 均值（含自身），边界只对实际在图内的邻格求均值
   （钳制索引会让边界格被重复计入——角落格 (0,0) 被算 4 次——语义是错的）。
   滤波不守恒（设计如此）。 */
export function smoothKernel(fields, name) {
  const { W, H } = fields;
  const a = fields.field(name), b = fields.next(name);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= W) continue;
          s += a[ny * W + nx]; n++;
        }
      }
      b[y * W + x] = s / n;
    }
  }
}
