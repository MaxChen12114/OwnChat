# 提示词库出处与许可（CREDITS）

本目录下的库文本**不是**本仓库原创的，除标注「本仓库」的条目外都来自开源项目。
每条 entry 的 front-matter 里也写了 `source` / `license`（编辑器里能看到）。

- 库的**源文件**：`src/prompts/presets/{functional,behavioral}/<名字>.md`（指令模块；显示分组名走 front-matter 的 `group`）与 `src/prompts/skills/<名字>.md`（技能；显示名走 `name`）。**路径一律 ASCII**，中文只出现在 front-matter 的显示名里。
- 生成物 `index.js` 不进版本库（`.gitignore`），由 `scripts/gen-prompts.mjs` 在 dev/deploy 前生成。
- 下发走 `POST /api/presets`（**需登录**）：未通过校验 403，一个字符都不给。
- 想加/删/改条目：往对应目录放文件或改文件 —— **别改本文件之外的第三方正文措辞**（要改就在 front-matter 的 `note` 里写明，或直接换成自己的条目）。

## 第三方正文的使用范围

| 做法 | 说明 |
|---|---|
| **原文** | 一字未改，只去掉上游工具自己的 front-matter（如 cursor 的 `applyTo`/`globs`、SKILL.md 的 `name/description`）。 |
| **节选** | 整段选取（不重写、不翻译、不改字）；取舍范围写在条目的 `note` 里，并给出源文件地址。 |
| **适配行** | 少数条目在正文最前面加了一行，说明「本模块作用于用户当前消息的内容」——因为上游是 pipeline 风格（`INPUT:`），直接放进聊天会把整段对话当输入。 |

## 条目来源

| 条目 | 类型 | 来源 | 许可 | 改动 |
|---|---|---|---|---|
| 摘要 · 要点提炼 · 文字润色 · 代码讲解 · 代码审查 · 长文分析 | 指令模块（功能） | [danielmiessler/fabric](https://github.com/danielmiessler/fabric) `data/patterns/*/system.md` | MIT | 原文 + 适配行 |
| 简洁作答 | 指令模块（功能） | [github/awesome-copilot](https://github.com/github/awesome-copilot) `instructions/taming-copilot.instructions.md` | MIT | 原文（去 applyTo front-matter） |
| 反谄媚与验证 | 指令模块（功能） | [PatrickJS/awesome-cursorrules](https://github.com/PatrickJS/awesome-cursorrules) `rules/anti-sycophancy-code-discipline-*.mdc` | CC0-1.0 | 原文（去 cursor front-matter） |
| 不抢话 · 视角 · 文风 · 场外指令 | 指令模块（行为） | [oliblue-evan/dsh-roleplay-preset](https://github.com/oliblue-evan/dsh-roleplay-preset) `agent.cordis.yml`（三、四、五节） | MIT | 节选（整行/整段；不含该仓库中改编自其他来源的「二、角色沉浸」段） |
| 中文去AI腔 · 代码审查清单 | 技能 | 本仓库（原 `public/presets/starter-skills.json` 引入） | 自有 | 原文 |
| 前端设计 | 技能 | Anthropic skills · `frontend-design`（原 starter-skills 库引入） | CC（完整条款见 Anthropic skills 的 `LICENSE.txt`） | 原文 |
| 工程记忆库 | 技能 | [github/awesome-copilot](https://github.com/github/awesome-copilot) `instructions/memory-bank.instructions.md` | MIT | 节选（结构 + 核心文件 + 工作流） |
| 长文扩写 · 对话写法 · 人物塑造 | 技能 | [PenglongHuang/chinese-novelist-skill](https://github.com/PenglongHuang/chinese-novelist-skill) `references/guides/*.md` | MIT | 节选（取舍见各条 `note`） |
| 角色卡写作 | 技能 | [wwwangzilin/dsh-character-presets](https://github.com/wwwangzilin/dsh-character-presets) `persona-template/ADVANCED.md` | MIT | 原文（去 H1） |

MIT / CC-BY 类条目在再分发时保留版权与许可声明即满足要求；本文件与各条目的 front-matter 就是这份声明。

## 基础准则（`src/prompts/bases/基础.md`）的来源

这份是**自写**的，不是从别处抄的 —— 查过一圈的结论是：开源世界没有可直接拿来用的通用助手 base，能合法拿到的现成货全是 coding harness（ZCode Apache-2.0 / deepseek-harness MIT 的提示词都在引用自家工具名，放进创作/扮演场景会指错路）。所以：

- **结构**参考 zai-org/ZCode 与 deepseek-ai/deepseek-harness 的写法（一句身份 + 分区小标题 + 命令式规则），以及 Anthropic Agent Skills 文档对「metadata 与正文分离」的建议；
- **条款骨架**对齐 OpenAI Model Spec（CC0 公有领域）：helpful / honest / 不谄媚 / 不编造 / 用户前提有误先指出 —— 逐条改写成中文，不含原文句子；
- 正文**全部自写**，没有任何一句来自第三方文本。所有者可随时改（它不是红线）。
## 有意**不**采用（记下来免得下次又去翻）

| 来源 | 原因 |
|---|---|
| SillyTavern / AgnAI / RisuAI / text-generation-webui / KoboldAI | AGPL 或 GPL —— 与本仓库许可不兼容，只作结构参考 |
| `nihaoshi/mimoCode-story`（去 AI 味清单） | **仓库没有 LICENSE**（写作时查过，无 LICENSE / COPYING 文件）→ 不采用 |
| `victorchen96/deepseek_v4_rolepaly_instruct` | 无 LICENSE → 不采用（`dsh-roleplay-preset` 里改编自它的那一段已一并排除） |
| 各处流传的厂商 system prompt「泄露集」（`x1xhlol/*`、`asgeirtj/*`、各类 Mirror） | 内容是泄露的专有文本，仓库级 license 洗不白；只作结构参考 |
| `zai-org/ZCode`（Apache-2.0）、`deepseek-ai/deepseek-harness`（MIT） | 许可没问题，但它们的系统提示词是**编码 agent harness** 的（引用自己那套工具名：`read`/`write`/`skill`…），搬进本平台的聊天/角色扮演场景会指错路 → 只作**格式**参考（本仓库的「技能目录 + load_skill」三级披露形态就来自这两家与 Anthropic Agent Skills 文档） |

## 已知缺口（想要就自己丢文件进去）

- **防重复 / 反八股**：社区里真正好用的那批（各类 ST 预设合集）**都没有许可或为 AGPL** → 没有可合法入库的现成条目。近似的替代是技能「中文去AI腔」与「长文扩写」。
- **现成角色卡**：本库**不设**「角色」分类 —— 角色在本平台是**固定格式的角色卡**（见 AGENTS.md），不是自由文本；从网上找的卡走「提示词编辑器 → 角色 → 导入」即可（V2/V3 JSON 与 PNG 卡都支持）。
