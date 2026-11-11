/* sim-kernel/rng.mjs — 分域确定性随机
   铁律 2 的实现：模拟层禁 Math.random，一切随机从 (seed, domain) 派生。
   同一 (seed, domain) 永远同序列；不同域互不串线 —— 改一处参数不漂移整条世界线。
   全整数运算（Math.imul），无浮点中间态，浏览器与 Node 逐位一致。 */

/* hash(seed, ...parts) → 0..2^32-1 无符号整数
   parts 为域描述（字符串或数字），逐字符混入。
   每段结束后混入分隔常数，保证 ('ab','c') 与 ('a','bc') 不同流。 */
export function hash(seed, ...parts) {
  let h = (seed | 0) ^ 0x9E3779B9;
  h = Math.imul(h, 0x85EBCA6B) >>> 0;
  for (let p = 0; p < parts.length; p++) {
    const s = String(parts[p]);
    for (let i = 0; i < s.length; i++) {
      h = (Math.imul(h ^ s.charCodeAt(i), 0x27D4EB2F) + 0x165667B1) >>> 0;
      h = Math.imul(h ^ (h >>> 15), 0x2545F491) >>> 0;
    }
    h = Math.imul(h ^ 0x1F123BB5, 0x27D4EB2D) >>> 0;
  }
  // murmur3 finish：雪崩，让相邻输入产生不相关的输出
  h ^= h >>> 16; h = Math.imul(h, 0x85EBCA6B) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xC2B2AE35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/* stream(seed, ...domain) → next() ∈ [0,1)
   mulberry32：快、种子敏感、序列质量够模拟用。
   种子为 0 时替换成非零常数，避免全零退化。 */
export function stream(seed, ...domain) {
  let a = hash(seed, ...domain) | 0;
  if (a === 0) a = 0x6D2B79F5 | 0;
  return function next() {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
