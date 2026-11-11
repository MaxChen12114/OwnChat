/* sim-kernel/flow.mjs — L1 原子·多源流场
   规格 §3.3：多源 Dijkstra → 全图"到最近目标"的方向场。人流首选：
   几百个疏散者共享一张方向场，每人每回合只读一格 dir，不用各自 A*。
   语义：dist[i] = 从 i 走到最近目标的累计代价（含首步入场的 cost）；
         dir[i] = 0右/1左/2下/3上 → 下一格；-1 = 目标自身；-2 = 不可达。
   确定性：堆 (dist,索引) 破平 + 固定邻序 + 平局保留先到方向。
   性能：平行 TypedArray 堆 + 缓冲跨 build 复用（数组对象堆实测 5.2ms，超预算 10 倍）。 */

export function createFlow({ world, costs }) {
  const W = world.W, H = world.H, N = W * H;
  // 跨 build 复用的缓冲（每次 build 全量重置，无跨次状态）
  const dist = new Float32Array(N);
  const dir = new Int8Array(N);
  const heapD = new Float64Array(N * 6);      // 最坏情况每格被 push 多次
  const heapI = new Int32Array(N * 6);

  function build(targets) {
    const arr = costs();
    dist.fill(Infinity);
    dir.fill(-2);
    let hn = 0;

    for (const t of targets) {
      const i = t | 0;
      if (arr[i] === Infinity) throw new Error(`流场目标格不可通行: 索引 ${i}`);
      dist[i] = 0; dir[i] = -1;
      // push (0, i)
      let c = hn++;
      heapD[c] = 0; heapI[c] = i;
      while (c > 0) {
        const p = (c - 1) >> 1;
        if (heapD[p] < heapD[c] || (heapD[p] === heapD[c] && heapI[p] <= heapI[c])) break;
        const td = heapD[p]; heapD[p] = heapD[c]; heapD[c] = td;
        const ti = heapI[p]; heapI[p] = heapI[c]; heapI[c] = ti;
        c = p;
      }
    }

    const DX = [1, -1, 0, 0], DY = [0, 0, 1, -1];
    while (hn > 0) {
      const d = heapD[0], cur = heapI[0];
      // pop：末尾换根 + 下沉
      hn--;
      if (hn > 0) {
        heapD[0] = heapD[hn]; heapI[0] = heapI[hn];
        let c = 0;
        for (;;) {
          const l = c * 2 + 1, r = l + 1;
          let m = c;
          if (l < hn && (heapD[l] < heapD[m] || (heapD[l] === heapD[m] && heapI[l] < heapI[m]))) m = l;
          if (r < hn && (heapD[r] < heapD[m] || (heapD[r] === heapD[m] && heapI[r] < heapI[m]))) m = r;
          if (m === c) break;
          const td = heapD[m]; heapD[m] = heapD[c]; heapD[c] = td;
          const ti = heapI[m]; heapI[m] = heapI[c]; heapI[c] = ti;
          c = m;
        }
      }
      if (d > dist[cur]) continue;              // 惰性删除：堆里的过期项直接跳过
      const cx = cur % W, cy = (cur / W) | 0;
      const stepIntoCur = arr[cur];               // 从邻居迈向 cur 要付"进入 cur"的代价
      for (let k = 0; k < 4; k++) {               // 反向松弛
        const nx = cx + DX[k], ny = cy + DY[k];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (arr[ni] === Infinity) continue;
        const nd = d + stepIntoCur;
        if (nd < dist[ni] - 1e-6) {
          dist[ni] = nd;
          dir[ni] = k ^ 1;                        // k 是 cur→ni，dir 要存 ni→cur：0↔1、2↔3 互翻
          // push (nd, ni)
          let c = hn++;
          heapD[c] = nd; heapI[c] = ni;
          while (c > 0) {
            const p = (c - 1) >> 1;
            if (heapD[p] < heapD[c] || (heapD[p] === heapD[c] && heapI[p] <= heapI[c])) break;
            const td = heapD[p]; heapD[p] = heapD[c]; heapD[c] = td;
            const ti = heapI[p]; heapI[p] = heapI[c]; heapI[c] = ti;
            c = p;
          }
        }
      }
    }
    return { dist, dir };
  }

  return Object.freeze({ build });
}

/* 沿方向场行走（给测试/实体 policy 用）：从 (x,y) 返回下一步格心坐标；到目标返回 null。 */
export function stepAlong(dirs, W, H, x, y) {
  const cx = Math.floor(x), cy = Math.floor(y);
  const d = dirs[cy * W + cx];
  if (d < 0) return null;                            // 目标或不可达
  const DX = [1, -1, 0, 0], DY = [0, 0, 1, -1];
  const nx = Math.min(Math.max(cx + DX[d], 0), W - 1);
  const ny = Math.min(Math.max(cy + DY[d], 0), H - 1);
  return [nx + 0.5, ny + 0.5];
}
