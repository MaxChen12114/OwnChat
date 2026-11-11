# NOTES-proto · 内核原型 ↔ sim-kernel 算法差异清单
### U17 深读 · 2026-11-11 · 源：theme-demos/sim-kernel-proto.html（676 行）

> 目的：U30+ 写核函数库前，把原型里验证过的算法与 kernel 现有实现对齐。
> 结论先行：**downhill 必须照抄原型的 delta 模式（不是 U06 教训的"纯函数"模式）**；
> astar 原型是线性扫堆 O(n)，kernel 的二叉堆是对的，不用改。

---

## 1. downhill 核函数（U30 直接照抄的算法）

原型 `kernelDownhill()`（行 238-276）——管流模型简化版：

```
budget = water[i] * FLOW_K          // ★ 总配额 0.42（不是每邻居 42%）
for d in 4 方向（配额没用完时）:
    diff = (elev[i]+water[i]) - (elev[j]+water[j])
    if diff <= 0: skip
    t = min(budget, diff * 0.5)     // ★ 传输量 = 水头差的一半，封顶配额
    budget -= t
    deltaW[i] -= t;  deltaW[j2] += t
统一写回：海面清零吸收；v<=0 → 0（挡 NaN）；v>20 → 20（单格上限防炸图）
```

**与 U06 "纯函数"教训的关系（重要修正）**：
- U06 的教训是"不许往陈旧 b 上累加"。但 downhill 是**成对流**（i↔j 互相给水），
  纯函数写法会双计或漏计——原型用的 **delta 草稿模式**（deltaW.fill(0) 每回合清零，
  流量先进 delta 再统一写回）才是成对流的安全写法。
- **规则**：邻接对偶耦合（水/火蔓延）→ delta 模式；逐格独立 stencil（雾/光照/人流）→ 纯函数模式。
  U30 的 `downhill` 用 delta，U31 的 `diffuse/smooth` 用纯函数。
- deltaW.fill(0) 就是"每回合从零开始"——与 A4 教训（陈旧底子）不冲突。

**U30 必须一起带的稳定性项**（原型实证缺了就炸）：
| 项 | 原型做法 | 缺了会怎样 |
|---|---|---|
| 海面当汇 | `terr===WATER` 格水清零 | 盆地水排不掉，图全淹 |
| NaN/负值守卫 | `if (!(v>0)) v = 0` | 一次 NaN 污染全图 |
| 单格上限 | `if (v > 20) v = 20` | 极端事件水深远超物理意义 |
| 蒸发+下渗 | `v*(1-rate) - 0.0015` | 盆地积水十几米深，永远不退 |

**参数（原型自定，非 CM 来源，可复用）**：FLOW_K=0.42、单格上限 20、下渗 0.0015/回合；
RAIN_RATE=0.032 属情景层不进内核。

## 2. astar：原型 vs kernel path.mjs

| 项 | 原型 | kernel path.mjs | 结论 |
|---|---|---|---|
| 开集结构 | openI 平铺数组 + **线性扫 O(n) 找最小 f** | 二叉堆 O(log n) | kernel 对，不改 |
| 闭集 | closed[seenGen] 出队即封 | 同 | 一致（A3 都已修） |
| 破平 | f 相等取索引小 | 同 | 一致 |
| 扩展上限 | guard 4000 + OPEN_MAX 池上限 | maxExpand 参数 | 一致 |
| g 松弛比较 | `ng < gScore[ni]`（精确 <） | `ng < gsc[ni] - 1e-6`（带 ε） | **差异点**：ε 会吞掉极小改进路径。两边都确定，但同输入路径可能不同。保留 kernel 的 ε（防浮点抖动重排），G1 审查时复核 ε 对最短路正确性的影响 |
| 路径格式 | **格索引数组** `[i, …]` | **格心坐标** `[[x+.5,y+.5], …]` | **差异点**：实体 SoA 的 pathOfs/pathLen 指向共享路径池，存索引更省更稳。U44 桥接时让 path.mjs 补一个 `pathIndices()` 输出，坐标版留给渲染 |
| 启发式 | 曼哈顿 | 同 | 一致 |

## 3. 场与回合

- 原型：water/waterB + deltaW 三件套；"swap"隐含在统一写回里。
- kernel fields.mjs 是超集（显式 bounds 三态 + period 由 kernel 管）。原型 bounds=absorb（海吸收）↔ kernel 的 absorb 边界语义一致。
- 原型回合 = 固定 100ms tick + `SEC_PER_TICK` 边界换算（A2 教训的落地形态）；
  kernel 全程用回合，参数带 /回合单位，UI 层才换算 —— 与规格一致，不改。
- 原型"确定性自检"按钮 = 同种子两遍比状态指纹 → kernel U28 的 determinism 闸门就是它的正式化。

## 4. 实体与随机

- 原型域参数是魔法数字（`rnd01(seed, 9000+a, 1)`）；kernel 用语义域字符串（`hash(seed,'agents',a)`）——等价确定，kernel 更可读，不改。
- 原型实体 60 个预分配 SoA，实体数上限思想一致。

## 5. 性能对账（本机）

| 项 | 原型 | kernel 现状 |
|---|---|---|
| 每回合全耗 | 0.11ms（96×64 含寻路） | 待 U25 组装后对账 |
| 全图 Dijkstra | — | flow 0.485ms（U16 稳态达标） |
| 单次 A* 全图 | — | 2.08ms（数组堆，G1 时换 TypedArray 堆预计 <1ms） |
| cost derive | — | 0.008ms |

## 6. U30 施工清单（照抄清单）

1. `downhill`：delta 模式 + 总配额 + `min(budget, diff*0.5)` + 海面汇 + NaN 守卫 + 上限 20
2. `decay`（蒸发下渗）：`v*(1-rate) - per`，rate/per 进规则包 params
3. `add`（降雨）：半径线性衰减，storm 中心是情景层参数
4. 守恒验收：暴雨 100 回合总量增量 = 降雨总量 − 蒸发总量 − 海面吸收量（精确等式，容差 1e-4）
