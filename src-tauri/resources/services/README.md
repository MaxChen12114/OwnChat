# 随 App 打包的本地服务脚本

这里的文件是工作区里服务的**快照**，由壳在运行时直接从安装包内启动（`app.path().resource_dir()`）。

| 文件 | 来源 | 说明 |
|---|---|---|
| `pc-bridge/server.mjs` + `pc-bridge/lib/*.ps1` | `remote-desk/pc-bridge/` | 手机 agent 的截屏/点击/读写后端（8802）。`LIB` 已改为跟随脚本自身目录，因此可以随包运行 |
| `source-server.mjs` | `OwnChat/scripts/dev/source-server.mjs` | 源码检索（8797），`list_source / search_source / read_source` 的后端 |

更新方式：改完工作区里的源文件后，把它们重新复制到这里（保持相对路径不变），随下一次打包生效。
运行参数由 `src-tauri/src/services.rs` 决定：`--root <Agent 工作目录>`（pc-bridge 若存在 `<工作目录>/remote-desk` 则用它），端口固定 8802 / 8797。
