# `lib/` · 纯算法与编解码（浏览器安全，无 DOM / IO / 域语义）

`lib/` 是 2026-11-28 从 `core/` 拆出来的第三层。拆的理由只有一条：`core/` 原来同时住着
「契约 + 运行时」和「纯算法」，于是「谁能依赖谁」说不清 —— ZIP 读写器被 `services/data/backup.ts`
和 `services/chat/doc-extract.ts` 当工具调用，却和 `ports.ts`、`runtime.ts` 摆在同一个桶里，
看起来像同一种东西。它们不是。

## 三层规则（唯一真源就是这一节）

| 目录 | 装什么 | 不许装什么 |
| --- | --- | --- |
| `core/` | 契约、清单、运行时：`capability.ts`、`ports.ts`、`runtime.ts`、`runtime-manifest.ts`、`slot-registry.ts`、`trust-gate.ts`、`host-api.ts` / `host-api.compat.ts`、`db.ts`（DbPort 端口类型 + 线格式） | 任何 IO、任何域语义、任何「顺手实现的小算法」 |
| `lib/` | 浏览器安全的纯算法与编解码：只进出值（字节、字符串、对象），无 DOM、无 IO、无域语义 | DOM / `document` / `localStorage` / IndexedDB / `fetch` / 网络 / 文件系统 / Tauri 壳 / 业务含义（不知道「会话」「角色」「备份」是什么） |
| `services/` | 域与 IO：每个文件拥有一个业务域的判断，外加它的端口（存储、网络、壳、DOM） | 通用算法（放 `lib/`）；契约骨架（放 `core/`） |

依赖方向，单向：

```
services/**  ──值──▶  lib/**  ──仅 import type──▶  core/**
     │                                               ▲
     └────────────────── 仅 import type ─────────────┘
```

- `core/**` **不许** import `lib/**` 或 `services/**`（契约与运行时是地板；它只 import 自己）。
  `core/i18n.ts` 是当前唯一的例外，正在由 i18n 代理迁往 `lib/i18n.ts`，见文末。
- `lib/**` 可以 `import type` 自 `core/**`（`db-search.ts` → `core/db.ts` 的 `SearchScope` /
  `SearchSurface` 就是这样），但那是纯类型、发射时消失；**不许** import `services/**`。
- `services/**` 可以 `import type` 自 `core/**`，可以 import `lib/**` 的值。浏览器路径上真正执行的
  `lib` 是发射产物 `public/shared/lib/*.js`，由 `window.escapeSvc` / `window.ZipRead` /
  `window.ZipWrite` / `window.dbSearchSql` 这几个既有的非 `__` 名字挂出（**零新增 `window.__*`**）。

判断口径（三条都满足才进 `lib/`）：① 输入输出都是值；② 在 Node 测试域里能原样跑，不需要任何桩；
③ 把业务名词全删掉，这个文件还成立。ZIP 读写器满足全部三条，所以它在这里；`db.ts` 不满足第 ③
条（它逐字节定义的是存储线的形状），所以它留在 `core/`。

## 文件清单

| 文件 | 干什么 | 产物（boot 或按需） | 全局名 |
| --- | --- | --- | --- |
| `zip-read.ts` | 零依赖 ZIP 读取（store / deflate-raw），路径穿越与体积/压缩比闸 | `/shared/lib/zip-read.js`（**按需**加载：备份卡、DOCX/XLSX 抽取、技能包导入） | `window.ZipRead` |
| `zip-write.ts` | 零依赖 ZIP 写入（`CompressionStream("deflate-raw")` + 自算 CRC32），与读取器逐条规则对齐 | `/shared/lib/zip-write.js`（按需，备份写出） | `window.ZipWrite` |
| `escape.ts` | 唯一 HTML 转义器（`& < > " '`），文本与属性同一套 | `/shared/lib/escape.js`（boot） | `window.escapeSvc` |
| `db-search.ts` | 检索面 + scope + q → SQL 文本 / 绑定参数 / 模式（FTS5 短语 vs `LIKE` 回退），与 `src/data-api.js` 字节一致 | `/shared/lib/db-search.js`（boot，必须早于两个 HTTP 适配器与桌面适配器） | `window.dbSearchSql` |

## 路径映射（迁移前 → 迁移后）

| 源 | 旧产物 / 旧 boot 路径 | 新产物 / 新 boot 路径 |
| --- | --- | --- |
| `core/zip-read.ts` | `public/shared/core/zip-read.js` · `/shared/core/zip-read.js` | `public/shared/lib/zip-read.js` · `/shared/lib/zip-read.js` |
| `core/zip-write.ts` | `public/shared/core/zip-write.js` · `/shared/core/zip-write.js` | `public/shared/lib/zip-write.js` · `/shared/lib/zip-write.js` |
| `core/escape.ts` | `public/shared/core/escape.js` · `/shared/core/escape.js`（boot） | `public/shared/lib/escape.js` · `/shared/lib/escape.js`（boot） |
| `core/db-search.ts` | `public/shared/core/db-search.js` · `/shared/core/db-search.js`（boot） | `public/shared/lib/db-search.js` · `/shared/lib/db-search.js`（boot） |

接线文件不动位置：`l0/wiring/{zip-read,zip-write,escape,db-search}.js` 仍是这四件唯一的 browser
接线，登记表从 `l0/emit.mjs` 的 `CORE_WIRINGS` 挪到 `LIB_WIRINGS`（同一个发射器、同一个 IIFE
包裹、同样的字节比对兜底），产物根从 `public/shared/core/` 换成 `public/shared/lib/`。

## 例外：`core/db.ts` 为什么留在这里

`db.ts` 看起来也「纯」——只有类型和两个编解码函数。但它的编解码**就是**存储线的定义（`{__b64}`、
参数归一、结果形状），`src/data-api.js` 与 `test/db-wire.test.mjs` 逐位对拍它；它是两个 adapter 与
服务之间那份契约的一部分，不是可以被任何层随手复用的工具。把它放进 `lib/` 会把「线格式属于
seam」这件事说反。同理，`runtime.ts` / `runtime-manifest.ts` / `slot-registry.ts` / `trust-gate.ts`
也留在 `core/`：它们是运行时与准入门，不是算法。

## i18n 的迁移（留给 i18n 代理）

`core/i18n.ts` 正在被另一个代理迁到 `lib/i18n.ts`，本次边界施工**没有动它**。它落地时要做的事：

1. `l0/emit.mjs`：把 `"core/i18n.ts": "l0/wiring/i18n.js"` 从 `CORE_WIRINGS` 挪到 `LIB_WIRINGS`；
2. `l0/scripts.json`：boot 路径 `/shared/core/i18n.js` → `/shared/lib/i18n.js`（`w` 注解同步）；
3. `l0/wiring/i18n.js` + `l0/wiring/settings/10-appearance.js` 的注释；
4. `scripts/check-structure.mjs` 第 3 段的字典路径检查读的是 `public/shared/core/i18n.js`，
   要改指 `public/shared/lib/i18n.js`；字典本体 `/shared/core/i18n-dict.js` 是懒加载的数据文件，
   **不随引擎迁移**，`check-i18n.mjs` / `.i18n-baseline.json` 的 `dictPath` 保持不动；
5. 改了引擎内容后跑 `node l0/emit.mjs --write` 与 `node l0/build.mjs --write`。

`lib/README.md` 与 `l0/emit.mjs` 的 `LIB_WIRINGS` 注释都按「i18n 会进来」写好，但**没有**提前登记
不存在的源 —— 登记表必须指向真实文件，否则 `--check` 直接红。

## 新增一个 `lib/` 文件的工序

1. 写 `lib/<name>.ts`：纯算法，零 IO，文件头写清输入输出与「为什么不是 core / services」；
2. 写 `l0/wiring/<name>.js`（浏览器接线，挂既有名字或明确的非 `__` 名字）；
3. `l0/emit.mjs` 的 `LIB_WIRINGS` 加一行（产物自动落 `public/shared/lib/`）；
4. 要在 boot 加载就进 `l0/scripts.json`，按需加载就不进（ZIP 两件就是按需）；
5. 门禁：`scripts/check-syntax.mjs` / `scripts/check-contracts.mjs` / `tooling/typecheck/tsconfig.json`
   都已包含 `lib/`；测试锚点指产物 `public/shared/lib/<name>.js`；
6. `node l0/emit.mjs --write && node l0/build.mjs --write`，再跑全量 `run-regression`。
