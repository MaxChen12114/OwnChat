# src-tauri · Tauri 2 桌面 / 移动打包工程

把部署好的 OwnChat Web 端用 Tauri 2 打包成可安装的桌面 / 移动应用。

## 域中立壳：装好首次填地址即可

公开版**不写死站点地址**：首次启动显示本地设置页（`frontend/index.html`，双语，含「一键部署」向导）。
填入部署地址后，Rust 侧只为**这一个域名**动态授予 IPC 能力（见 `src/lib.rs` 的「服务器地址」一节）
再导航过去 —— 公开仓库不带静态能力清单（`capabilities/remote.json` 已被移除）。

想让自己出的包直连某站、跳过设置页，改这两处：

1. `tauri.conf.json` → `app.windows[0].url`：填你的域名（`https://你的域名/?shell=android`；
   `shell=android` 参数启用移动端布局）。
2. `identifier`：换成你自己的（它就是安卓的 `applicationId`，上线后再改等于换应用）。

自己发布时若坚持要用静态授权（不用启动页），可以自行添加 `capabilities/remote.json` ——
权限清单与 `src/lib.rs` 的 `REMOTE_PERMISSIONS` 必须保持同一口径（改一处要改两处）。

## 自动更新

官方公开版发布由维护者签名：`plugins.updater.pubkey` 已内置对应公钥，私钥放在本仓库的 Secrets 里。

要发布**你自己的**版本，请换成你自己的密钥对：

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
