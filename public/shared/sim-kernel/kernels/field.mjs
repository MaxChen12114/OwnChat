/* sim-kernel/kernels/field.mjs — 场核函数（规则包用）
   GF2 铁律在此落地为两种合法姿势（NOTES-proto §1）：
   - 纯函数 stencil（add/decay）：b[i] = F(a[i], …) 全量赋值
   - delta 草稿（downhill 成对流）：delta.fill(0) → 成对流累加 → 统一写回
   全部确定性：row-major、无 Math.random、参数单位一律 /回合。
   照抄清单（NOTES-proto §6）：downhill 总配额 + min(budget, diff*0.5) 传输 +
   海面当汇 + NaN 守卫 + 单格上限。 */

import { TERR } from '../world.mjs';

/* add：降雨（纯函数）。以 (cx,cy) 为中心、rad 为半径线性衰减，每格加 rate（米/回合）。
   b = a + rain —— 全量赋值，本 pass 是该场本回合的唯一写者。 */
export function addKernel(fields, name, { rate, cx, cy, rad }) {
  const { W, H } = fields;
  const a = fields.field(name), b = fields.next(name);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const dx = x - cx, dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      b[i] = a[i] + (d > rad ? 0 : rate * (1 - d / rad));
    }
  }
}

/* decay：蒸发 + 下渗（纯函数）。v(t+1) = v(t)*(1-rate) - per；负值夹 0。
   rate 无量纲/回合（0.01 = 每回合蒸发 1%），per 米/回合。 */
export function decayKernel(fields, name, { rate, per }) {
  const N = fields.W * fields.H;
  const a = fields.field(name), b = fields.next(name);
  for (let i = 0; i < N; i++) {
    const v = a[i] * (1 - rate) - per;
    b[i] = v > 0 ? v : 0;
  }
}

/* downhill：下坡流（delta 草稿——成对流唯一安全写法）。
   每格总配额 budget = v*flowK（不是每邻居 flowK，A1）；
   对每个更低的邻居给 t = min(budget剩余, 水头差*0.5)；
   海面（terrain===TERR.WATER）当汇：水流入海即消失；
   NaN/负守卫 + 单格上限 cap（防极端事件炸图）。
   terrain: Uint8Array（world.terrSlice()），flowK/cap/单位 /回合。 */
export function downhillKernel(fields, name, { terrain, elev, flowK = 0.42, cap = 20 }) {
  const { W, H } = fields;
  const N = W * H;
  const a = fields.field(name), b = fields.next(name);
  const delta = new Float32Array(N);              // delta 草稿：每回合从零开始（GF2 安全姿势）
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const v = a[i];
      if (!(v > 1e-9)) continue;                  // NaN/零格跳过
      if (terrain[i] === TERR.WATER) continue;    // 海面本身不下坡
      const hi = elev[i] + v;
      let budget = v * flowK;                     // ★ 总量配额：所有邻居共享这一份
      // 四方向依次尝试，配额用完即停（A1 修法）
      for (let d = 0; d < 4 && budget > 1e-9; d++) {
        const nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0);
        const ny = y + (d === 2 ? 1 : d === 3 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        const diff = hi - (elev[j] + a[j]);
        if (diff <= 0) continue;                  // 只往低处流
        const t = Math.min(budget, diff * 0.5);
        budget -= t;
        delta[i] -= t;
        delta[j] += t;
      }
    }
  }
  // 统一写回（row-major，与遍历顺序无关 → 确定）
  for (let i = 0; i < N; i++) {
    if (terrain[i] === TERR.WATER) { b[i] = 0; continue; }   // 海：吸收
    let v = a[i] + delta[i];
    if (!(v > 0)) v = 0;                                    // NaN/负守卫
    if (v > cap) v = cap;                                   // 单格上限
    b[i] = v;
  }
}
