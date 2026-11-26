# `tooling/bundles/agent/manifest/` · 工具清单声明格式（L2 起点 v0.1）

> 2026-11-13 接手 L1a 后的第一批 L2 产物。**只有格式 + 样本 + 门禁，不是全量清单。**
> 格式的活真源是 `core/host-api.ts` 的 `ToolManifestEntry` 与同目录 `schema.json`，两者的字段
> 集合由 `test/tool-manifest.test.mjs` 双向钉住 —— 任一边漂移，回归立刻红。

## 为什么先只放格式

上一轮实测：默认环境装配出 **36 个工具 / 36 个 schema ≈ 4.2k tokens 每轮**，而设置卡只显示
core 6 / full 15 —— 根因是「注册表、请求体、设置卡」各有真源。修法是让三者消费同一份编译结果，
而编译的输入就是这里的清单声明。

全量清单**不能手写**：手写等于再造一个写死点，下一次加工具照样漂移。它由 **L0a 生成器**
（`tooling/l0/build.mjs`，与 `?v=` / index.html 骨架同一套构建期扫描）从各 provider 的声明汇总产出，
运行时只读、不 fetch（service worker 会 bypass `/api/`，e2e 的 fetch 桩会把纯 JSON 吞成空清单）。

## 文件

| 文件 | 作用 |
|---|---|
| `schema.json` | draft-07 声明格式，字段与 `core/host-api.ts` 的 `ToolManifestEntry` 一一对应 |
| `tools.sample.json` | 3 个真实工具的样本（文件 / 联网 / 远程电脑），供门禁正负控用 |
| `../../../test/tool-manifest.test.mjs` | 校验门禁：格式、id 唯一、正负控、**TS 接口字段与 JSON Schema 双向一致** |

## 字段口径

- `id` 必须与运行时 `registry.define({name})` 逐字一致；生成期双向校验「声明 ↔ 实现」。
- `group` / `summary` / `keywords` 供能力页渲染与 `tool_search` 检索；`summary` ≤120 字，
  与 `services/agent/tool-catalog.ts` 的 `summaryOf()` 截断口径一致。
- `provider` 是模块标识，**不是新全局名**；纯数据清单不新增任何 window 契约，因此不会触发
  `check-contracts` 的冻结门禁。
- `requires` 是能力位，由 **L1c capability provider** 统一判定（`tauri` / `panel` / `unlocked` /
  `sourceServer` / `network` …）；L2 的 policy 不自己探环境。
- `risk` 四值初版按实测 36 个工具归类；`core/host-api.ts` 里仍是 `string`（L1a 刻意不猜形状），
  等 L2 迁移实测后再决定是否同步收紧为联合类型。
- `residentCandidate` 承载决策 7 的「首批常驻名单待统计」—— 它是可计算量，不是写死的名单。
- `defaultEnabled` 对 `external` / `destructive` 应显式 `false`，走 fail-closed。

## 两个必须记住的门禁缺口

1. `tooling/scripts/check-contracts.mjs` 的 `SCAN_DIRS = ["public","scripts","src","test"]`，
   **不扫 `tooling/bundles/`**；`check-syntax.mjs` 同样只扫 `public/**`。所以本目录现在既不被契约门禁
   也不被语法全检覆盖 —— 这正是「零冲突」的来源，也是隐患。
   **L0a 生成器接入时必须把 `tooling/bundles/` 加进这两个扫描根**，并同步 `check-structure` 的
   目录白名单（A.5 第 3 条：`check-syntax` 扫描根不扩会「扫描成功、什么都没检查」的假绿）。
2. `test/tool-manifest.test.mjs` 已接入 `run-regression.mjs`，它把 `schema.json` 的字段集合
   与 `core/host-api.ts` 的 `ToolManifestEntry` 钉在一起，并断言 `HostApi` 上存在
   `tools: ToolHostApi`（L1a-4 补入的契约位）。**两边任一漂移，回归立刻红。**

## 边界

- 这里落的是 **L2 的输入数据**，不是 L3 外置 bundle 落地（A.3：bundles 目录在 L3 才长全）。
- 不新增 window 全局、不引 npm / CDN、不碰 `index.html`、不改 `settings.js`。
- 全量清单、`compileTools` 策略编译器、`resolveSchemas` 内核钩子、能力页 UI 都在后续阶段，
  见施工单；本批只把「L2 可以开工」的形状固定下来。
