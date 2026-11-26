# tooling/ — 构建、生成与门禁

这里放所有**不随运行时页面加载**的工具。根目录原来分散着 `l0/`、`scripts/`、`bundles/`、`app/boot.ts`，它们都只服务构建与检查，收到一个文件夹后根目录只剩产品代码、部署数据与文档。

| 子目录 / 文件 | 职责 |
|---|---|
| `boot.ts` | boot 行加载器的唯一真源；`l0/build.mjs` 逐字提取，测试锁住两侧一致 |
| `l0/` | 启动层生成器：`emit`（TS→classic 产物）、`build`（boot 清单/启动行）、`tools-manifest`、`wiring` 接线、`wiring-parts` 拆件 |
| `scripts/` | 门禁与运维：语法/类型/契约/文档/i18n 检查、回归入口、公开导出与同步、本机宿主 staging |
| `bundles/` | agent 工具清单的声明契约（`schema.json`、`tools.json`、捕获件） |
| `typecheck/` | 独立 TypeScript 工具链（`contracts.json` 会随公开导出，其余依赖不进公开树） |

## 常用命令

```bash
node tooling/scripts/check-syntax.mjs        # 真实语法门
node tooling/l0/emit.mjs --write             # 重发射 services/core/lib 产物
node tooling/l0/build.mjs --write            # 重写 boot 行与工具页目录
node tooling/l0/tools-manifest.mjs --write   # 重生成 agent 工具清单
node tooling/scripts/run-regression.mjs      # 全量回归
```

改 `services/**/*.ts` 后跑 `emit --write`；改 `tooling/l0/scripts.json` 后跑 `build --write`；改工具声明后跑 `tools-manifest --write`。产物都已入库，`--check` 会在 CI 抓脱钩。
