/* sim-kernel/world.mjs — L0 牌桌：静态世界
   规格铁律 1：一次生成/导入，之后只读。agent/规则包永远不能改这一层。
   实现方式：数组封在闭包里，对外只暴露访问函数；对象整体 freeze；
   toJSON 返回深拷贝，改导出不伤本体。
   生成与导入产出同构（同一 schema），下游不区分来源。 */

import { hash, stream } from './rng.mjs';

export const TERR = { WATER: 0, SAND: 1, GRASS: 2, FOREST: 3, MOUNTAIN: 4 };
export const ZONE = { WATER: 0, RES: 1, COM: 2, IND: 3, PARK: 4, MOUNT: 5, RURAL: 6 };

/* ---------- 确定性噪声（整数格点 hash，双线性 + smoothstep） ---------- */

function latHash(ix, iy, seed, dom, oct) {
  return hash(seed, dom, oct, ix, iy) / 4294967296;
}
function smooth(t) { return t * t * (3 - 2 * t); }
function vnoise(x, y, seed, dom, oct) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const u = smooth(x - xi), v = smooth(y - yi);
  const a = latHash(xi, yi, seed, dom, oct), b = latHash(xi + 1, yi, seed, dom, oct);
  const c = latHash(xi, yi + 1, seed, dom, oct), d = latHash(xi + 1, yi + 1, seed, dom, oct);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, seed, dom, oct) {
  let amp = 0.5, f = 1, sum = 0, n = 0;
  for (let o = 0; o < oct; o++) { sum += amp * vnoise(x * f, y * f, seed, dom, o); n += amp; amp *= 0.5; f *= 2; }
  return sum / n;
}

/* ---------- 生成器（内核默认版，只保确定性与合理分布） ----------
   视觉级海岸线/城市细节由页面层 genWorld 负责；内核生成器供测试与 headless 批跑。 */
export function generateWorld({ W = 96, H = 64, seed = 1 } = {}) {
  const terr = new Uint8Array(W * H);
  const elev = new Float32Array(W * H);
  const zone = new Uint8Array(W * H);
  const bh = new Float32Array(W * H);

  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const nx = x / W - 0.5, ny = y / H - 0.5;
    const edge = 1 - Math.min(1, Math.hypot(nx * 2.1, ny * 2.1));
    const e = fbm(x * 0.055, y * 0.055, seed, 'elev', 4) * 0.75
            + fbm(x * 0.13, y * 0.13, seed, 'elevB', 3) * 0.25;
    elev[i] = e * 0.9 + edge * 0.42 - 0.16;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, e = elev[i];
    const mo = fbm(x * 0.07 + 31, y * 0.07 + 17, seed, 'moist', 3);
    terr[i] = e < 0.32 ? TERR.WATER : e > 0.70 ? TERR.MOUNTAIN
            : mo > 0.60 ? TERR.FOREST : TERR.GRASS;
  }

  // 陆地重心 + 分区环带（acc = 归一化接近度）
  let sx = 0, sy = 0, n = 0;
  for (let i = 0; i < W * H; i++) {
    const t = terr[i];
    if (t !== TERR.WATER && t !== TERR.MOUNTAIN) { sx += i % W; sy += (i / W) | 0; n++; }
  }
  const cx = n ? sx / n : W / 2, cy = n ? sy / n : H / 2;
  const maxd = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy)) || 1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, t = terr[i];
    if (t === TERR.WATER) { zone[i] = ZONE.WATER; continue; }
    const acc = 1 - Math.hypot(x - cx, y - cy) / maxd;
    const r1 = hash(seed, 'urb', 1, x, y) / 4294967296;
    const r2 = hash(seed, 'urb', 2, x, y) / 4294967296;
    const hj = 0.55 + r2 * 0.75;
    if (t === TERR.MOUNTAIN) { zone[i] = ZONE.MOUNT; }
    else if (t === TERR.FOREST) { zone[i] = ZONE.PARK; }
    else if (acc > 0.62) { zone[i] = ZONE.COM; bh[i] = t === TERR.SAND || r2 < 0.10 ? 0 : (3.5 + acc * 8 + r2 * 4) * hj; }
    else if (acc > 0.30) { zone[i] = ZONE.RES; bh[i] = t === TERR.SAND ? 0 : (1.8 + acc * 3.5 + r1 * 2) * hj; }
    else if (r1 > 0.72 && acc > 0.18) { zone[i] = ZONE.IND; bh[i] = 1 + r2 * 1.6; }
    else { zone[i] = ZONE.RURAL; bh[i] = r2 > 0.85 ? 1 + r1 * 1.6 : 0; }
    if (t === TERR.SAND) { zone[i] = ZONE.RES; bh[i] = 0; }
  }

  return fromArrays({ W, H, seed, terr, elev, zone, bh, grid: null, layers: null });
}

/* ---------- 导入：任意来源（生成/真实数据）走同一 schema ---------- */

export function fromArrays(data) {
  const W = data.W | 0, H = data.H | 0;
  if (!(W > 0 && H > 0)) throw new TypeError(`world 尺寸非法: W=${data.W} H=${data.H}`);
  const N = W * H;
  const pick = (name, Ctor, def) => {
    const src = data[name];
    if (src === undefined || src === null) return new Ctor(N).fill(def || 0);
    if (src.length !== N) throw new TypeError(`${name} 长度 ${src.length} ≠ W*H=${N}`);
    return Ctor === Uint8Array ? Uint8Array.from(src) : Float32Array.from(src);
  };
  const terr = pick('terr', Uint8Array, TERR.GRASS);
  const elev = pick('elev', Float32Array, 0);
  const zone = pick('zone', Uint8Array, 0);
  const bh = pick('bh', Float32Array, 0);
  const grid = data.grid ? Object.freeze({ ...data.grid }) : null;      // {origin,cellSize,crs} 坐标锚
  const layers = data.layers
    ? Object.freeze({ road: data.layers.road || null, building: data.layers.building || null })
    : Object.freeze({ road: null, building: null });

  const w = {
    schemaVersion: 1,
    W, H,
    seed: data.seed == null ? null : data.seed | 0,
    grid, layers,
    terrAt: i => terr[i | 0],
    elevAt: i => elev[i | 0],
    zoneAt: i => zone[i | 0],
    bhAt: i => bh[i | 0],
    // 切片读取（渲染/桥用，返回拷贝，改它不伤本体）
    terrSlice: () => Uint8Array.from(terr),
    toJSON: () => ({
      schemaVersion: 1, W, H,
      seed: data.seed == null ? null : data.seed | 0,
      grid: data.grid || null,
      terr: Array.from(terr), elev: Array.from(elev), zone: Array.from(zone), bh: Array.from(bh),
    }),
  };
  return Object.freeze(w);
}

export function fromJSON(obj) { return fromArrays(obj); }
