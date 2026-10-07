# src-tauri · Tauri 2 桌面 / 移动打包工程

把部署好的 OwnChat Web 端用 Tauri 2 打包成可安装的桌面 / 移动应用。

## 先改三处指向（否则装出来的壳还是指向别人的站）

1. `tauri.conf.json` → `app.windows[0].url`：改成你自己的域名（`https://你的域名/?shell=android`；
   `shell=android` 参数启用移动端布局）。
2. `capabilities/remote.json`：把授权源（IPC/全局 Tauri API 授予哪些源）改成同一个域名 ——
   **远程源拿到的 IPC 权限等同于本机应用**，只授予你自己的站。
3. `identifier`：换成你自己的（它就是安卓的 `applicationId`，上线后再改等于换应用）。

## 自动更新（可选）

```bash
npx tauri signer generate -w ownchat.key        # 生成自己的签名密钥
```

- 私钥（`ownchat.key`）→ 仓库 Secrets：`TAURI_SIGNING_PRIVATE_KEY`（有密码再加 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`）；
- 公钥 → `tauri.conf.json` → `plugins.updater.pubkey`；
- `plugins.updater.endpoints` → 指向你自己仓库的 Releases。
- **密钥永不入库**（`.gitignore` 已排除 `*.key`）。

## 两种出包方式

### A. 云构建（推荐）
仓库自带 `.github/workflows/tauri-build.yml`：Actions → "Build Tauri App" → Run workflow；
或推一个版本标签（`git tag app-v1.0.0 && git push origin app-v1.0.0`）触发。
Windows 出 NSIS `.exe`，安卓出调试 APK（产物在 Actions Artifacts / Releases）。

### B. 本地构建
1. 安装 Rust：https://rustup.rs
2. 安装 Tauri CLI：`cargo install tauri-cli --version "^2.0"`
3. 生成图标（只需一次）：`cargo tauri icon ../public/assets/icon-512.png`
4. 出包：`cargo tauri build`（Windows 产物在 `target/release/bundle/`）

## 安全模型

远程页面**不是**按"普通网页"运行：`withGlobalTauri: true` + `capabilities/remote.json` 的授权
让页面可以调用本机命令（本地文件读写、执行命令、TTS 代理等）。所有命令都在 `build.rs` 登记、
未登记/未授权的命令远程页调不到；本地文件读写受工作目录门控，命令执行前有**系统原生确认框**。
换域名时记得同步改 capabilities —— 授予了谁，就等于把本机能力交给了谁。
