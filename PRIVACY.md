# Privacy Policy

> 中文在前，English below. Last updated: 2026-10-07.

## 中文

OwnChat 是一个**自部署**应用：仓库里的是源码，服务由你自己部署到自己的 Cloudflare 账号。因此**我们没有任何服务器，也不接触你的任何数据**。

### 数据存在哪里

| 数据 | 位置 | 说明 |
|---|---|---|
| 会话记录 / 角色卡 / 设置 / 世界观 | 你的浏览器 `localStorage` | 默认只在本机；换浏览器或清站点数据即消失 |
| 云同步数据（可选） | **你自己账号**的 Cloudflare KV | 只有你部署的那份 Worker 能读写；默认关闭，需在设置里显式开启 |
| 自建模型（BYO）密钥 | 你的浏览器 `localStorage` | 不进云同步、不上传 |
| 模型 API Key（服务端） | 你的 Worker Secrets / 本地 `.dev.vars` | 只存在于服务端，永不下发到前端 |
| 桌面端本地数据 | 你的「文档/OwnChat」目录（SQLite） | 可在设置里改到任意目录 |
| 氛围音音频 | 随仓库分发的静态文件 | 30 条 CC0 音轨，来源见 `public/assets/ambient/CREDITS.txt` |

### 什么会被发出去

- **聊天与提示词**：调用 AI 模型时，内容会发送到**你自己配置的**模型服务商（如 DeepSeek、NVIDIA 或你自建的兼容端点），适用该厂商的隐私条款。这是功能本身决定的，自部署无法替你规避。
- **图像生成**：同样发送到你配置的图像服务。
- **联网工具**（Agent 模式的搜索 / 抓网页）：请求由你部署的 Worker 代理发出。
- **不做的事**：不含任何分析、埋点、遥测或错误上报；不收集使用统计；不向第三方发送你的标识信息。

### 桌面端（Tauri）

- 本地文件读写与命令执行属**显式能力**：每次调用都要在系统原生确认框放行，文件路径受工作目录门控。
- 自动更新只会向你配置的更新源（默认是你自己的仓库 Releases）发起请求。

### 删除你的数据

- 浏览器端：清除该站点的站点数据（localStorage）。
- 云同步：删除你账号里的 KV namespace，或清空对应键。
- 桌面端：删除「文档/OwnChat」目录（或你在设置里指定的目录）。
- 部署端：`wrangler delete` 删除 Worker。

### 第三方组件

第三方提示词库与音频素材的来源与许可见 `src/prompts/CREDITS.md`、`public/assets/ambient/CREDITS.txt`；代码许可见 `LICENSE`（MIT）。

---

## English

OwnChat is a **self-hosted** application: this repository holds the source, and you deploy it to your own Cloudflare account. **We operate no servers and never touch your data.**

### Where your data lives

| Data | Location | Notes |
|---|---|---|
| Conversations / character cards / settings / lorebooks | your browser `localStorage` | Local by default; gone if you clear site data |
| Optional cloud sync | Cloudflare KV in **your own account** | Readable only by the Worker you deployed; off by default |
| Bring-your-own model keys | your browser `localStorage` | Never synced, never uploaded |
| Server-side model API keys | your Worker Secrets / local `.dev.vars` | Server-only, never sent to the frontend |
| Desktop data | your `Documents/OwnChat` folder (SQLite) | Configurable in settings |
| Ambient audio | static files shipped with the repo | 30 CC0 tracks, see `public/assets/ambient/CREDITS.txt` |

### What leaves your machine

- **Chat messages and prompts** are sent to the model provider **you** configured (DeepSeek, NVIDIA, or your own OpenAI-compatible endpoint) and are subject to that provider's policy. This is inherent to the feature.
- **Image generation** requests go to the image service you configured.
- **Web tools** (agent search/fetch) are proxied through the Worker you deployed.
- **What we do not do**: no analytics, no telemetry, no crash reporting, no usage statistics, no identifiers sent anywhere.

### Desktop app (Tauri)

- Local file access and command execution are explicit capabilities: every call must be approved in a native OS dialog, and file paths are confined to a user-chosen working directory.
- Auto-update only contacts the update endpoint you configure (by default, your own repository's releases).

### Deleting your data

- Browser: clear site data for the app's origin (`localStorage`).
- Cloud sync: delete the KV namespace in your account, or clear the keys.
- Desktop: delete the `Documents/OwnChat` folder (or your configured folder).
- Deployment: `wrangler delete` to remove the Worker.

### Third-party components

Prompt libraries and audio assets are credited with their licenses in `src/prompts/CREDITS.md` and `public/assets/ambient/CREDITS.txt`. Code license: `LICENSE` (MIT).
