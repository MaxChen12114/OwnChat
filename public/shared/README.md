# `public/shared/` · OwnChat 浏览器 Agent 内核（魂）

对标 Claude Code 的内核层：把原本散落在文本里的内联信号（`[[发图:场景]]` / `[好感+N]`）升级为正规 **function calling + agent 循环**。本目录是与「壳」（形态层）解耦的独立 SDK，默认不改变现有单轮流式链路。

## 文件一览

| 文件 | 导出 | 加载方式 | 状态 |
| --- | --- | --- | --- |
| `agent-kernel.js` | `globalThis.AgentKernel = { createToolRegistry, runAgentLoop }` | **`<script type="module">`**（用了 ES `export`，经典脚本会抛 SyntaxError，全局永不挂载） | ✅ 已接线 |
| `tools.js` | `globalThis.OwnChatTools = { buildRegistry, defineTools }` | 经典 `<script>`（IIFE，顺序在 agent-kernel 之后即可，运行时才引用 AgentKernel） | ✅ 已接线 |
| `agent-reach.js` | `globalThis.AgentReach = { defineTools }` | 经典 `<script>` | ✅ 已接线（app.js 无条件追加其 7 个联网工具） |
| `agent-console.js` | `mountAgentConsole(container, opts)` | **`<script type="module">`** | ✅ 已接线（右栏运行面板） |
| `env-context.js` | `globalThis.__envContext` | 经典 `<script>` | ✅ 已接线（self_diagnostics 工具 + 会话环境快照） |
| `skills.js` / `tts*.js` / `image-channels.js` / `image-common.js` | `window.__skills / __omniTTS / __imageChannels / __imageCommon ...` | 经典 `<script>` | ✅ 主站各链使用（`image-channels.js` 须在 `image-common.js` 之前） |
| `agent-llm-adapter.js` | ESM `createLLMClient` | **未加载** | ⚠️ 未来选项：provider-agnostic callModel 适配层（DeepSeek V4 消息清洗 / 流式 tool_calls 重组）。其清洗逻辑需先与 app.js 现内联实现比对后才能接入或删除 |

## 工具注册表（createToolRegistry）

```js
const reg = AgentKernel.createToolRegistry()
reg.define({
  name: "send_image",
  description: "...",
  schema: { type: "object", properties: { /* ... */ } },
  run: async (args, ctx) => { /* ... */ },   // ⚠️ 回调键是 run，不是 execute
})
// reg.get(name) / reg.list() / reg.toSchemas()
```

- 回调签名 **`run(args, ctx)`**。早期用 `execute` 会在 `define` 时抛 `define 需要 { name, run }`。

## Agent 循环（runAgentLoop）

```js
const result = await AgentKernel.runAgentLoop({
  messages,                                        // [{ role, content }, ...]
  registry,                                        // createToolRegistry / buildRegistry 产物
  callModel: async (messages, schemas) => { /* ... */ }, // ⚠️ 位置传参
  maxIterations: 8,                                // 默认 8
  context: {},                                     // 透传给 tool.run 的 ctx
  ensurePermission: async (name, args) => true,    // 仅破坏性工具；省略 = 自动放行
  onEvent: (evt) => { /* ... */ },
})
// → { finalText, messages, iterations, stopReason }
```

- `callModel(messages, schemas)` **位置传参**；返回上游 `choices[0].message`（含 `tool_calls`）。
- 有 `tool_calls` → 查表执行 → 把 assistant(tool_calls) + 每个 `role:"tool"`(tool_call_id, content 字符串化) 回填 messages → 继续；无 tool_calls / 触达 maxIterations 即停。
- `onEvent` 事件：`model_call{iteration}` / `model_error{iteration,error}` / `tool_run{name,args}` / `tool_done{name}` / `tool_error{name,error}` / `tool_denied{name}` / `final{text}` / `max_iterations` / `subagent_start{role,task}` / `subagent_done{role}`。
- `ensurePermission(name, args)` 位置传参，仅破坏性工具弹确认。

## 内置工具（OwnChatTools.buildRegistry）

`buildRegistry({ onImage })` 注册 **17 个工具**（`tools.js` 按档位门控：默认 core 档 8 个进 schema，full 档 17 个；LS `cfw_agent_tools_v1` 切换）。注意：AgentReach 的 7 个联网工具与 env-context 的 self_diagnostics 由 app.js **无条件追加**，暂不受该门控管（4.82 备注：后续应纳入 profile）。核心几个：

| 工具 | 绑定 | 参数 |
| --- | --- | --- |
| `send_image` | `window.__chatImage.sendPhoto` | `{ type: "selfie" | "scene", scene_prompt }`，`onImage` 回调负责渲染气泡 |
| `adjust_affinity` | `window.__character.adjustActiveAffection` | `{ delta, reason }` |
| `manage_lorebook` / `manage_preset` / `set_theme` 等 | 站内各模块 API | 见 `tools.js` 各工具 description（full 档） |

## 接线（现状）

1. **worker.js** — `/api/chat` 在 `stream:false` 分支透传 `tools`/`tool_choice`，直接回传完整 JSON（`choices[].message`，含 `tool_calls`）；`stream` 省略/true 仍走原 SSE 流式。
2. **index.html** — 在 `app.js` 之后加载本目录 SDK（`agent-kernel.js` / `agent-console.js` 必须 `type="module"`）。
3. **app.js** — `sendOne` 顶部 `if (isAgentModeOn()) return await sendOneAgent(opts)` 分流；`sendOneAgent`（buildRegistry → callModel 非流式 → runAgentLoop → 渲染 finalText）。

### dev 开关

```js
__dev.setAgentMode(true)   // 开 Agent 循环（LS cfw_agent_mode_v1 = "1"）
__dev.setAgentMode(false)  // 回退原流式 sendOne
__dev.isAgentMode()
```

`isAgentModeOn()` 还会校验 `window.AgentKernel` + `window.OwnChatTools` 已加载，缺失自动回退流式。

## 红线

- 基座(src/prompts/bases/ 下的文本)一字未改；工具调用走独立通道，不碰 base。
- 内核为独立模块，「魂」（内核层，本目录）与「壳」（Tauri 形态层 + 本地能力三件套）解耦推进。
