# AGENTS.md — 给 AI 助手的仓库约定

> 这份是公开版（与私有开发线同源，由导出脚本生成）：**没有访问码门**。
> 基座分两套目录 —— `src/prompts/bases/`（内置：随包一份「基础」）与 `src/prompts/custom/`
> （使用者自己的那份，只有他自己的部署看得见；顶栏按钮切到「自定义」时用它，为空时回落内置默认档）。

## 底座文本是载荷，不是文档

`src/prompts/bases/` 与 `src/prompts/custom/` 下的 `.md` / `.txt` 与子目录都是**逐字发送给模型的文本本体**：
既有内容不许被「顺手」改动（改名 / 换扩展名可以）。要新版本就**新增**一个文件或子目录，
放进去即自动进白名单与前端下拉，id = 文件名 / 目录名。底座必须保持 LF（`.gitattributes` 钉死）。

## 注册表是生成物

`src/prompts/*/index.js` 是**生成物**（已 gitignore，勿手改勿提交）：由 `scripts/gen-prompts.mjs`
扫描目录生成，`wrangler dev` / `wrangler deploy` 前自动执行（`[build] command` 里还串了一道
`scripts/check-syntax.mjs` 真语法门）。

## 语言 / 风格

- **提交信息与 GitHub 元数据（仓库简介 / Release 说明 / PR 标题）一律用英文**；代码注释与文档可用中文。
- 注释写约束与「上一版为什么不对」，不复述代码、不写流水账（后者归提交信息）。
- 新的空 `catch` 要点明吞的是什么；注释写清「为什么」。

## 工作纪律

- **只报告真跑过的命令与真看到的输出**，失败就把原始报错贴出来。
- **缺东西要响，不要静默跳过**：新的兜底要么留痕，要么不做。
- **删掉一个功能时，先把它的引用 grep 干净再删**（悬空引用 `check-syntax` 查不出来）。
- **校验放在边界**：HTTP 入参、上游回包、localStorage 读取、生成的注册表都当不可信。
- **独立改动分开提交**；已推送的历史不改写。

## 安全

- `.dev.vars`（`DEEPSEEK_API_KEY` / `NVIDIA_API_KEY` / `CHAT_PASSWORD`）与 `*.key` **永不入库**。
- 设置了 `CHAT_PASSWORD` 后，`/api/*` 与 `/sync` 一律要求 `Authorization: Bearer <密码>`；
  未设置则不校验 —— 那等于把模型额度开放给任何拿到地址的人。**部署时务必设置**。
- 提示词正文（基座 / 指令模块库 / 技能库）只下发通过密码校验的请求。

## 验证

| 改动面 | 证据 |
|---|---|
| 任意 JS | `node scripts/check-syntax.mjs`（别用 `node --check`，本仓库会漏报） |
| 提示词 / 装配 / 生成脚本 | `npx wrangler deploy --dry-run` |
| 前端运行时 | 起 `wrangler dev` 真加载页面，用真指针点击走一遍改过的路径；改 `public/` 后必须重启 dev server（资源清单是启动时快照） |
