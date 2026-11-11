/* sim-kernel/path.mjs — L1 原子·寻路（A*，4 邻域）
   附录 A3 教训（照着避）：
   1. 必须带闭集，出队即封 —— 只判 g 值更优会让同节点反复扩展，
      代价图一变表现为"整个页面卡住"而不是报错。
   2. 等代价按索引破平 —— 同 f 值先取索引小的，保证同起点同终点永远同一条路。
   3. 硬扩展上限 —— 超了返回 null（不可达），不许无限烧。
   步代价 = 进入邻格的代价 cost[ni]（代价恒 1 时退化为经典 BFS 最短路）。
   U18 对齐原型（NOTES-proto §2）：松弛用精确 <（ε 会吞掉真实的小改进，导致次优路径）；
   提供 pathIndices() 返回格索引数组（实体共享路径池用），path() 返回格心坐标（渲染用）。 */

export function createPathfinder({ world, costs, maxExpand = null }) {
  /* costs: () => Float32Array（cost.mjs 的 cost(name)，调用方负责缓存与脏标记） */
  /* GF4：默认上限随世界尺寸走（固定 4000 在 96×64=6144 格下会把可达报成不可达） */
  const cap = maxExpand ?? world.W * world.H * 2;

  const W0 = world.W, H0 = world.H, N0 = W0 * H0;
  // GF6：缓冲提升到闭包复用（seen/closed 用 gen 戳，gsc/par 只在 seen===gen 时可信 → 无跨次状态）
  const gsc = new Float32Array(N0), fs = new Float64Array(N0);
  const par = new Int32Array(N0), seen = new Int32Array(N0), closed = new Int32Array(N0);
  const heapF = new Float64Array(N0 * 4), heapI = new Int32Array(N0 * 4);   // 重推最坏 ~4N
  let gen = 0;

  function search(sx, sy, tx, ty) {
    const W = W0, H = H0;
    sx |= 0; sy |= 0; tx |= 0; ty |= 0;
    if (sx < 0 || sy < 0 || sx >= W || sy >= H || tx < 0 || ty < 0 || tx >= W || ty >= H) return null;
    const arr = costs();
    if (arr[ty * W + tx] === Infinity) return null;      // 目标本身不可通行

    gen++;
    let hn = 0;
    const sI = sy * W + sx, tI = ty * W + tx;
    gsc[sI] = 0; par[sI] = -1; seen[sI] = gen; fs[sI] = 0;
    // push (0, sI)
    let c = hn++;
    heapF[c] = 0; heapI[c] = sI;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heapF[p] < heapF[c] || (heapF[p] === heapF[c] && heapI[p] <= heapI[c])) break;
      const tf = heapF[p]; heapF[p] = heapF[c]; heapF[c] = tf;
      const ti = heapI[p]; heapI[p] = heapI[c]; heapI[c] = ti;
      c = p;
    }

    const DX = [1, -1, 0, 0], DY = [0, 0, 1, -1];        // 固定邻序，配合索引破平 → 全程确定
    let expanded = 0;
    while (hn > 0) {
      const f = heapF[0], cur = heapI[0];
      // pop：末尾换根 + 下沉
      hn--;
      if (hn > 0) {
        heapF[0] = heapF[hn]; heapI[0] = heapI[hn];
        let cc = 0;
        for (;;) {
          const l = cc * 2 + 1, r = l + 1;
          let m = cc;
          if (l < hn && (heapF[l] < heapF[m] || (heapF[l] === heapF[m] && heapI[l] < heapI[m]))) m = l;
          if (r < hn && (heapF[r] < heapF[m] || (heapF[r] === heapF[m] && heapI[r] < heapI[m]))) m = r;
          if (m === cc) break;
          const tf = heapF[m]; heapF[m] = heapF[cc]; heapF[cc] = tf;
          const ti = heapI[m]; heapI[m] = heapI[cc]; heapI[cc] = ti;
          cc = m;
        }
      }
      if (closed[cur] === gen) continue;                 // A3：出队即封
      closed[cur] = gen;
      if (cur === tI) {
        const out = [];
        let p = cur;
        while (p !== -1) { out.push(p); p = par[p]; }   // 格索引，start→target
        out.reverse();
        return out;
      }
      if (++expanded >= cap) return null;                  // A3：硬上限（GF4：默认随世界尺寸）
      const cx = cur % W, cy = (cur / W) | 0;
      const gCur = gsc[cur];
      for (let d = 0; d < 4; d++) {
        const nx = cx + DX[d], ny = cy + DY[d];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (closed[ni] === gen) continue;                // 已定案不再看
        const nc = arr[ni];
        if (nc === Infinity) continue;                   // 不可通行
        const ng = gCur + nc;
        if (seen[ni] !== gen || ng < gsc[ni]) {          // U18：精确 <（对齐原型）
          seen[ni] = gen;
          gsc[ni] = ng;
          par[ni] = cur;
          const h = Math.abs(nx - tx) + Math.abs(ny - ty);   // 曼哈顿；步代价 ≥1 → 可采纳
          const fv = ng + h;
          fs[ni] = fv;
          // push (fv, ni)
          let cc = hn++;
          heapF[cc] = fv; heapI[cc] = ni;
          while (cc > 0) {
            const p2 = (cc - 1) >> 1;
            if (heapF[p2] < heapF[cc] || (heapF[p2] === heapF[cc] && heapI[p2] <= heapI[cc])) break;
            const tf = heapF[p2]; heapF[p2] = heapF[cc]; heapF[cc] = tf;
            const ti = heapI[p2]; heapI[p2] = heapI[cc]; heapI[cc] = ti;
            cc = p2;
          }
        }
      }
    }
    return null;                                         // open 耗尽 = 不可达
  }

  /* 格索引路径（实体共享路径池 / trace 用） */
  function pathIndices(sx, sy, tx, ty) { return search(sx, sy, tx, ty); }
  /* 格心坐标路径（渲染 / 桥用） */
  function path(sx, sy, tx, ty) {
    const W = world.W;
    const idx = search(sx, sy, tx, ty);
    if (!idx) return null;
    return idx.map(i => [(i % W) + 0.5, ((i / W) | 0) + 0.5]);
  }

  return Object.freeze({ path, pathIndices, maxExpand: cap });
}
