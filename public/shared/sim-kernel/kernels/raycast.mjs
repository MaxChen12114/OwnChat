/* sim-kernel/kernels/raycast.mjs — 视线核函数（Bresenham）
   los(opaque, W, H, x0, y0, x1, y1) → bool：Bresenham 直线逐格走，
   途中踩到 opaque 格 → 遮挡（起点/终点自身的 opaque 不计——站在墙里也能看见墙）。
   对称性：Bresenham 线天然不对称（a→b 与 b→a 走的格可能不同，遮挡判定可能翻转）。
   symmetric=true（默认）时双向都通才算可见 —— 这是"对称性"测试项的正确实现姿势。
   visibleField：从 (cx,cy) 到全图的可见性场（Uint8Array 0/1），规则包用它做视野/雾。 */

/* 单向 LOS（内部）。opaque: Uint8Array，1=遮挡。 */
function losOne(opaque, W, H, x0, y0, x1, y1) {
  let x = x0, y = y0;
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    if (!(x === x0 && y === y0) && !(x === x1 && y === y1)) {
      if (opaque[y * W + x]) return false;             // 途中遮挡（不含起终点）
    }
    if (x === x1 && y === y1) return true;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
    if (x < 0 || y < 0 || x >= W || y >= H) return false;   // 出界断线
  }
}

export function los(opaque, W, H, x0, y0, x1, y1, { symmetric = true } = {}) {
  const fwd = losOne(opaque, W, H, x0, y0, x1, y1);
  if (!symmetric) return fwd;
  if (!fwd) return false;
  return losOne(opaque, W, H, x1, y1, x0, y0);         // 双向都通才算可见
}

/* 全图可见性场。per 格双向 LOS（对称保证）。 */
export function visibleField(opaque, W, H, cx, cy, { symmetric = true } = {}) {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      out[y * W + x] = los(opaque, W, H, cx, cy, x, y, { symmetric }) ? 1 : 0;
    }
  }
  return out;
}
