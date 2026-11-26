# src-tauri · Tauri 2 桌面 / 移动打包工程

桌面壳的设计（2026-11-28 起）：

- **固定 origin**：窗口永远加载随包页面（host/runtime/public），不导航到远端站点。
- **本机宿主**：安装包内置 host/runtime（server/ + src/ + public/ + migrations/），首启在
  127.0.0.1:8787 启动 Node 宿主；Windows 安装包同时内置 Node 24 运行时（runtime/node/node.exe），
  用户不需要自己装 Node。源码构建若没有 runtime/node，会回退系统 PATH 里的 Node 24+。
- **宿主地址只决定 API/fetch 去哪**（托盘「更换服务器地址」），页面地址不变；换宿主=换后端，
  不用重新打包。
- **安卓版是瘦客户端**：加载随包 UI，但需要连一个可访问的宿主（你自己部署的实例，或局域网里的
  桌面宿主）；安卓跑不了本机 Node 宿主。

## 构建

- **云构建（推荐）**：.github/workflows/tauri-build.yml，推 tag 或手动 dispatch；Windows 出 NSIS，
  安卓出 APK。构建前会把 Node 24 复制到 src-tauri/runtime/node/，再由 beforeBuildCommand 跑
  node scripts/stage-host.mjs 生成 host/runtime/。
- **本地构建**：需要 Rust 与 Node 24+；在 src-tauri 下运行 cargo tauri build。本地不会自动内置
  Node 运行时，调试时走系统 PATH 的 node。

## 自动更新

官方公开版发布由维护者签名：plugins.updater.pubkey 已内置对应公钥，私钥放在仓库 Secrets 里。

要发布你自己的版本，请换成你自己的密钥对：

npx tauri signer generate -w ownchat.key

- 私钥（ownchat.key）→ 仓库 Secrets：TAURI_SIGNING_PRIVATE_KEY（有密码再加 TAURI_SIGNING_PRIVATE_KEY_PASSWORD）；
- 公钥 → tauri.conf.json → plugins.updater.pubkey；
- plugins.updater.endpoints → 指向你自己仓库的 Releases。
- 密钥永不入库（.gitignore 已排除 *.key）。

## 安全模型

页面是本机随包页，不是远端网页：withGlobalTauri + capabilities 让页面可以调用本机命令
（本地文件读写、执行命令、TTS 代理等）。所有命令都在 build.rs 登记，未登记/未授权的命令
调不到；本地文件读写受工作目录门控，命令执行前有系统原生确认框。默认 capabilities 只覆盖
随包页面，没有远端域名的动态授权。

