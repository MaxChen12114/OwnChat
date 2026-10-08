# OwnChat

[English](README.md) | **中文**

数据与密钥都留在你自己手里的 AI 创作平台 —— 部署到你自己的 Cloudflare 账号，角色扮演、长文写作、代码协作、图像与语音都在同一套界面里完成。

![OwnChat · 聊天(玻璃主题)](docs/screenshots/chat-glass.png)

## 界面截图

| 聊天 · 玻璃主题 | 聊天 · 烛夜私语 | 设置面板 |
|---|---|---|
| ![玻璃](docs/screenshots/chat-glass.png) | ![烛夜](docs/screenshots/chat-candle.png) | ![设置](docs/screenshots/settings.png) |

## 功能

- **角色扮演与多分支对话** —— 角色卡（兼容 SillyTavern V1/V2/V3 与 PNG 卡导入导出）、设定集（世界书）、好感度、群聊、多智能体编排。
- **长文写作与代码协作** —— 提示词编辑器管理可复用的指令模块、技能与场景预设。
- **Agent 模式** —— 工具调用循环：联网搜索/抓网页、虚拟文件工作区、发图、氛围音导演，右栏有完整运行控制台。
- **图像与语音** —— 走你自己配置的图像服务；桌面端可接本地 TTS（GPT-SoVITS）。
- **氛围音** —— 环境声 × 背景音乐两条独立音轨，内置 30 条 CC0 音轨；RP 模式下模型可按剧情用隐藏标签自行导演。
- **主题** —— 极简 / 玻璃 / 烛夜私语，按设备生效。
- **自部署优先** —— 没有厂商后端、没有遥测；你的 Worker、你的 KV、你的密钥。

## 自部署（Cloudflare Workers）

**最快的一条路 —— 一键部署按钮。** 它会把本仓库克隆到你自己的 GitHub、自动创建 KV 存储，并在配置 Worker 的过程中问你几个密钥：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/MaxChen12114/OwnChat)

它会问的那几项在 `.dev.vars.example` 里有说明（至少要一个模型 Key；强烈建议再设一个访问密码）。习惯用命令行、或已经有 Workers 环境，就走下面的手动流程：

前置：一个 Cloudflare 账号（免费配额足够）与 Node.js 18+。

```bash
git clone https://github.com/<你>/OwnChat && cd OwnChat
npm i -g wrangler && wrangler login

# 1) 建一个 KV namespace（可选云同步用），把打印出来的 id 填进
#    wrangler.toml 的 [[kv_namespaces]] id
wrangler kv namespace create TAVERN_SYNC

# 2) 服务端模型密钥（不入库；用哪个配哪个）
wrangler secret put DEEPSEEK_API_KEY
wrangler secret put NVIDIA_API_KEY

# 3) 部署（构建步骤会自动重新生成提示词注册表并跑语法门）
wrangler deploy
```

`wrangler deploy` 会打印 Worker 地址；要不要绑自定义域名随意（Workers → 你的 Worker → Settings → Domains & Routes）。

本地开发：`wrangler dev`，密钥放 `.dev.vars`（已在 `.gitignore` 内）。

## 桌面端与安卓构建

Tauri 2 打包工程在 `src-tauri/`；CI（`.github/workflows/tauri-build.yml`）会在打版本标签或手动触发时构建 Windows 安装包与安卓 APK（带 `-test` 的标签出 draft 包，供测试装机）。

**壳是"域中立"的**：首次启动会显示一个本地设置页，填你自己的部署地址即可进入 —— 页内还带一个三步的一键部署向导。**指向自己的 Worker 不需要重新构建**；本地能力（选定目录下的文件读写、带系统确认框的命令执行）只会授予你配置的那一个域名，且仅此一个。

发布你自己的构建、或想让构建跳过设置页直连某站时：

1. **（可选）写死默认地址**：`src-tauri/tauri.conf.json` 里 `app.windows[0].url` 填 `https://你的域名/?shell=android`（`shell=android` 启用移动端布局）；不填就走设置页。
2. **生成你自己的签名密钥**（自动更新用）：
   ```bash
   npx tauri signer generate -w ownchat.key
   ```
   私钥放仓库 Secrets：`TAURI_SIGNING_PRIVATE_KEY`（+ 密码）；公钥填进 `tauri.conf.json` → `plugins.updater.pubkey`，更新源 `plugins.updater.endpoints` 指向你自己的 Releases。
3. **改 bundle identifier**（`tauri.conf.json` 的 `identifier`）如果你想让自己的构建成为一个独立应用。注意它就是安卓的 `applicationId`，上线后再改等于换应用（需卸载重装）。

## 添加自己的基座提示词

**基座**是 system 提示词的第一段，决定模型在整个应用里的行为方式。本仓库只带**一套**通用基座（`src/prompts/bases/基础.md`）。

要加自己的：

1. 把任意 `.md` / `.txt`（或一整个文件夹 = 一套多文件基座）丢进 `src/prompts/bases/`。
2. 部署（构建步骤会自动扫描该目录；**文件名 / 文件夹名就是设置里「对话 → 基座」下拉显示的 id**）。
3. 部署里有**两套及以上**基座时，顶栏那个按钮点一下就能循环切换；只有一套时它会提示你来看这段说明。

> **本仓库不提供什么。** 只含上面那一套通用基座。项目不附带、不审核、也不为任何其他基座文本背书 —— 使用者自行添加、自行负责，并有责任遵守所在地区的法律与你所用模型服务商的条款。

基座文件是**载荷不是文档**：逐字节进入模型请求（保持 LF，`.gitattributes` 已钉死）。

随仓库分发的提示词库来源见 `src/prompts/CREDITS.md`，内置氛围音来源见 `public/assets/ambient/CREDITS.txt`。

## 隐私与许可

- 隐私政策：[PRIVACY.md](PRIVACY.md) —— 数据只在你本机 / 你自己账号的 Cloudflare KV；无遥测。
- 开源协议：[MIT](LICENSE)。

## 开发约定

架构说明与开发约定见 [AGENTS.md](AGENTS.md)。提 PR 前值得知道的两条：

- **提交信息与 GitHub 元数据（仓库简介、Release 说明、PR 标题）一律用英文。**
- `src/prompts/bases/` 下的提示词是**载荷不是文档** —— 逐字节都要保持原样。

第三方致谢：提示词库（`src/prompts/CREDITS.md`）、氛围音（`public/assets/ambient/CREDITS.txt`）、截图所用壁纸（见 `docs/` 说明）。
