/**
 * agent-kernel.js — OwnChat 网页内核（魂）· 工具调用内核 SDK
 *
 * 定位：传输无关 / 模式无关的 agent 内核。只负责
 *   1) 工具注册表（name -> { schema, run, 危险标记 }）
 *   2) agent while 循环（模型 -> tool_calls -> 执行 -> 回灌 -> 重复）
 * 不负责：调模型（由宿主注入 callModel）、本地能力（壳 / Tauri）、UI。
 *
 * 对标 Claude Code 精髓：loop 本身很朴素，价值在它周围的注册表 / 权限 / 回灌。
 * 参考文档：Notion「Claude Code 源码精髓拆解 · 内核落地参考」。
 *
 * 用法见文件底部 DEMO。可在 Cloudflare Worker 与浏览器中运行（无 DOM 依赖）。
 */

/** 创建一个工具注册表 */
export function createToolRegistry() {
	const tools = new Map()

	/**
	 * 注册一个工具
	 * @param {object} def
	 * @param {string} def.name              工具名（模型据此调用）
	 * @param {string} def.description       给模型看的说明，越准越好
	 * @param {object} def.parameters        JSON Schema（OpenAI function 参数格式）
	 * @param {(args:object, ctx:object)=>Promise<any>} def.run  实际执行函数
	 * @param {boolean|Function} [def.destructive] 是否破坏性(执行前过权限闸门)。
	 *        可传函数 (args) => boolean,按实际参数判定(如 list 无害、delete 有破坏性)。
	 */
	function define(def) {
		if (!def || !def.name || typeof def.run !== "function") {
			throw new Error("[agent-kernel] define 需要 { name, run }")
		}
		tools.set(def.name, {
			name: def.name,
			description: def.description || "",
			parameters: def.parameters || { type: "object", properties: {} },
			run: def.run,
			// 保留函数形式 —— 第 167 行的闸门会按实际参数判定它。
			// 2026-10-04 修正:原为 `!!def.destructive`,规则在注册时就被压成 true,
			// 导致闸门里 `typeof tool.destructive === "function"` 那条分支永不命中,
			// 4 个工具(manage_character_card / manage_lorebook /
			// manage_preset / manage_settings)的只读调用也被当成破坏性操作。
			destructive: def.destructive ?? false,
		})
		return registry
	}

	function get(name) {
		return tools.get(name)
	}

	function list() {
		return [...tools.values()]
	}

	/** 导出成 OpenAI / DeepSeek 兼容的 tools 数组 */
	function toSchemas() {
		return list().map((t) => ({
			type: "function",
			function: {
				name: t.name,
				description: t.description,
				parameters: t.parameters,
			},
		}))
	}

	const registry = { define, get, list, toSchemas }
	return registry
}

/** 当前在跑的 agent 工作 loop 计数(供 autopilot 互斥锁探测,决策 L) */
let _activeLoops = 0
/** 是否有 agent 工作 loop 正在运行(autopilot.whoElseDriving 用) */
export function isRunning() {
	return _activeLoops > 0
}

/**
 * 运行 agent 主循环。
 *
 * @param {object} opts
 * @param {Array}  opts.messages          OpenAI 风格消息数组（会被原地追加）
 * @param {object} opts.registry         createToolRegistry() 的返回值
 * @param {(messages:Array, schemas:Array)=>Promise<object>} opts.callModel
 *        宿主注入的模型调用。需返回 { content?:string, tool_calls?:Array }
 *        （DeepSeek / OpenAI 的 choices[0].message 即是此形状）
 * @param {number}  [opts.maxIterations=8]   最大轮数（防失控 / 防烧钱）
 * @param {object}  [opts.context={}]        透传给每个 tool.run 的上下文
 * @param {(toolName:string,args:object)=>Promise<boolean>} [opts.ensurePermission]
 *        破坏性工具执行前的权限闸门；返回 false 则拒绝执行。
 *        2026-10-05 起 **fail-closed**：未提供闸门、或闸门抛错，破坏性工具一律拒绝
 *        （三种结局的错误措辞可区分，便于模型自我纠正而不是瞎重试）。
 * @param {(event:object)=>void} [opts.onEvent]  观测钩子（trace / UI 用）
 * @param {Array<(s:{iteration:number,messages:Array})=>Promise<{reject?:string,append?:Array}|void>>} [opts.beforeStep]
 *        2026-10-05 新增（DSH agent/pre-step 的单钩子版）：每次模型请求前依次调用。
 *        可返回 {reject:"原因"} 提前收尾（不发起这次请求），或 {append:[消息]} 在请求前
 *        追加上下文（时间/状态/压缩检查点等）。把"发请求前的策略"从循环体里拆出来。
 * @returns {Promise<{finalText:string, messages:Array, iterations:number, stopReason:string}>}
 *        stopReason ∈ "stop" | "model_error" | "max_iterations" | "blocked"
 */
export async function runAgentLoop(opts) {
	const {
		messages,
		registry,
		callModel,
		maxIterations = 8,
		context = {},
		ensurePermission,
		onEvent = () => {},
		beforeStep,
	} = opts || {}

	if (!Array.isArray(messages)) throw new Error("[agent-kernel] messages 必须是数组")
	if (!registry || typeof registry.toSchemas !== "function")
		throw new Error("[agent-kernel] 需要合法 registry")
	if (typeof callModel !== "function")
		throw new Error("[agent-kernel] 需要注入 callModel")

	const schemas = registry.toSchemas()
	const _beforeSteps = Array.isArray(beforeStep) ? beforeStep : (beforeStep ? [beforeStep] : [])

	_activeLoops++
	try {
	for (let i = 0; i < maxIterations; i++) {
		// pre-step 钩子:先于本次请求执行。reject 则本回合以 blocked 收尾(不花钱)。
		let _rejected = null
		for (const hook of _beforeSteps) {
			let d = null
			try { d = await hook({ iteration: i, messages, registry }) } catch (e) {
				// 钩子异常按"要求否决"处理(fail-closed)——钩子是宿主策略,策略出错不该放行请求
				d = { reject: `beforeStep 钩子异常: ${e && e.message ? e.message : e}` }
			}
			if (!d) continue
			if (d.reject) { _rejected = String(d.reject); break }
			if (Array.isArray(d.append)) for (const m of d.append) if (m && m.role) messages.push(m)
		}
		if (_rejected) {
			onEvent({ type: "blocked", iteration: i, reason: _rejected })
			pairPendingToolCalls(messages, "回合在请求前被否决，本轮调用未发生")
			const finalText = `（回合被否决：${_rejected}）`
			messages.push({ role: "assistant", content: finalText })
			return { finalText, messages, iterations: i, stopReason: "blocked" }
		}

		onEvent({ type: "model_call", iteration: i })
		let res
		try {
			res = (await callModel(messages, schemas)) || {}
		} catch (e) {
			// 模型调用失败（上下文超限 / 上游 4xx-5xx / 超时）——不再静默抛穿掀翻整个 loop。
			// 发 model_error 事件 + 带着已有进度优雅收尾，让 UI 能看到真实原因而不是“卡在第 N 轮”。
			const errMsg = String(e && e.message ? e.message : e)
			onEvent({ type: "model_error", iteration: i, error: errMsg })
			pairPendingToolCalls(messages, `模型调用失败（${errMsg}），本轮已发出的工具调用结果未知`)
			const finalText = `（第 ${i + 1} 轮模型调用失败，已中止：${errMsg}）`
			messages.push({ role: "assistant", content: finalText })
			return { finalText, messages, iterations: i + 1, stopReason: "model_error" }
		}
		const toolCalls = res.tool_calls || []

		// 没有工具调用 = 模型觉得说完了 -> 收尾
		if (toolCalls.length === 0) {
			const finalText = res.content || ""
			messages.push({ role: "assistant", content: finalText })
			onEvent({ type: "final", iteration: i, text: finalText })
			pairPendingToolCalls(messages, "循环正常收尾前的配对检查")
			return { finalText, messages, iterations: i + 1, stopReason: "stop" }
		}

		// 先把模型这条 assistant（含 tool_calls）记进上下文。
		// 2026-09-14 协议修复:§G-1 带 tool_calls 的助理轮必须回传 reasoning_content
		// (DeepSeek 硬要求,否则后续轮次直接 400) —— 原来这里把它丢了,推理模型多轮必挂。
		// 注意 content 由调用方的请求装配统一置空(§G-2),这里保留原始正文以便上层取用。
		const _asstMsg = { role: "assistant", content: res.content || "", tool_calls: toolCalls }
		if (res.reasoning_content) _asstMsg.reasoning_content = res.reasoning_content
		messages.push(_asstMsg)

		// 逐个执行工具，结果（含报错）回灌
		for (const call of toolCalls) {
			const fn = call.function || {}
			const name = fn.name
			let args = {}
			try {
				args = fn.arguments ? JSON.parse(fn.arguments) : {}
			} catch (e) {
				const _err = `参数 JSON 解析失败: ${e.message}`
				pushToolResult(messages, call, { error: _err }, { name, args: null, ok: false, error: _err })
				onEvent({ type: "tool_error", name, error: "bad_json", message: _err })
				continue
			}

			const tool = registry.get(name)
			if (!tool) {
				const _err = `未知工具: ${name}`
				pushToolResult(messages, call, { error: _err }, { name, args, ok: false, error: _err })
				onEvent({ type: "tool_error", name, error: "unknown_tool", message: _err })
				continue
			}

			// 权限闸门：破坏性操作执行前确认。
			// 2026-09-14:destructive 支持函数形式 —— 同一个工具不同 action 的副作用不同
			// (如 manage_character_card 的 list 无害、delete 有破坏性),静态布尔太粗。
			// 2026-10-05 改为 **fail-closed**(取自 DSH user-approval 的语义):
			//   以前是 `if (_needPerm && typeof ensurePermission === "function")` ——
			//   宿主忘了传闸门时破坏性工具**静默执行**;闸门抛错会炸穿整个循环,
			//   还把已入栈的 tool_calls 留成未配对。现在三种结局全部拒绝且措辞可区分:
			//   闸门缺失 / 闸门异常 / 用户拒绝 —— 模型能据此判断该换路还是该停下。
			const _needPerm = (typeof tool.destructive === "function") ? !!tool.destructive(args) : !!tool.destructive;
			if (_needPerm && typeof ensurePermission !== "function") {
				const _err = "权限闸门不可用（宿主未提供确认机制），破坏性操作已拒绝"
				pushToolResult(messages, call, { error: _err }, { name, args, ok: false, error: _err, denied: true, denied_reason: "gate_unavailable" })
				onEvent({ type: "tool_denied", name, args, reason: "gate_unavailable" })
				continue
			}
			if (_needPerm) {
				let ok = false
				try {
					ok = await ensurePermission(name, args)
				} catch (e) {
					const _err = `权限检查失败（闸门异常）：${e && e.message ? e.message : e}`
					pushToolResult(messages, call, { error: _err }, { name, args, ok: false, error: _err, denied: true, denied_reason: "gate_error" })
					onEvent({ type: "tool_denied", name, args, reason: "gate_error" })
					continue
				}
				if (!ok) {
					const _err = "用户拒绝了该操作"
					pushToolResult(messages, call, { error: _err }, { name, args, ok: false, error: _err, denied: true, denied_reason: "user_denied" })
					onEvent({ type: "tool_denied", name, args, reason: "user_denied" })
					continue
				}
			}

			const _t0 = Date.now()
			try {
				onEvent({ type: "tool_run", name, args })
				const result = await tool.run(args, context)
				const _ms = Date.now() - _t0
				pushToolResult(messages, call, result, { name, args, ok: true, ms: _ms })
				// 2026-09-14:tool_done 补上结果摘要与耗时 —— 原来只有 name,
				// 导致聊天与右栏都无法展示「工具返回了什么」(只剩一个 ✓)。
				onEvent({ type: "tool_done", name, args, ok: true, ms: _ms, summary: summarizeToolResult(result) })
			} catch (e) {
				// 报错也回灌，让模型下一轮自己读错误再改（这正是 loop 的魔法）
				const _err = String(e && e.message ? e.message : e)
				const _ms = Date.now() - _t0
				pushToolResult(messages, call, { error: _err }, { name, args, ok: false, ms: _ms, error: _err })
				onEvent({ type: "tool_error", name, args, error: "throw", message: _err, ms: _ms })
			}
		}
	}

	// 触顶：是否再给模型一次收尾机会由宿主决定。
	// 4.79 #5：旧代码返回 finalText:"" 且不入栈 → UI 只看到空白；此处与 model_error 一致，给出可见收尾文案并入栈。
	onEvent({ type: "max_iterations" })
	pairPendingToolCalls(messages, `已达最大轮数（${maxIterations}），本条工具调用未及执行，结果未知`)
	const finalText = `（已达到最大工具调用轮数 ${maxIterations} 轮，已自动停止。如果任务尚未完成，可缩小范围或分步重试。）`
	messages.push({ role: "assistant", content: finalText })
	return { finalText, messages, iterations: maxIterations, stopReason: "max_iterations" }
	} finally {
		_activeLoops--
	}
}

/** 单条工具结果回灌上限（字符）：防止大网页/搜索结果整段回灌撑爆上下文，导致后续轮次 400/超时 */
const MAX_TOOL_RESULT_CHARS = 8000

/** 把一次工具结果按 OpenAI 格式塞回消息流。
 *  meta = { name, args, ok, ms, error?, denied? } —— 2026-09-14 新增,挂在消息的 `_tool` 字段上,
 *  仅供聊天/右栏渲染「工具调用卡片」用;发送请求前由上层剥掉(app.js buildAgentRequestMessages)。 */
function pushToolResult(messages, call, result, meta) {
	let content = typeof result === "string" ? result : JSON.stringify(result)
	if (content && content.length > MAX_TOOL_RESULT_CHARS) {
		// 2026-10-05(DSH compaction-tool-result-pruner 的做法): 头尾保留,不再只留头部 ——
		// 工具输出的关键信息(最终状态行/错误摘要/退出码)经常落在尾部,一刀切会把它裁掉。
		// 总长仍 ≤ MAX_TOOL_RESULT_CHARS,标记里带原始长度供模型判断要不要分段重取。
		const total = content.length
		const omitted = total - MAX_TOOL_RESULT_CHARS
		const head = content.slice(0, 6000)
		const tail = total > 6000 ? content.slice(-1500) : ""
		content =
			head +
			`\n…[中间省略 ${omitted} 字，原文共 ${total} 字。如需完整内容请缩小范围或分页/分段获取]…\n` +
			tail
	}
	const msg = {
		role: "tool",
		tool_call_id: call.id,
		content,
	}
	if (meta) msg._tool = meta
	messages.push(msg)
}

/** 工具结果摘要(供 UI 卡片显示「返回了什么」,不参与回灌,避免撑上下文) */
function summarizeToolResult(result) {
	try {
		if (result == null) return ""
		if (typeof result === "string") return result.slice(0, 400)
		const j = JSON.stringify(result)
		return j && j.length > 400 ? j.slice(0, 400) + "…" : (j || "")
	} catch (e) { return "" }
}

/** 配对自愈(2026-10-05,取自 DSH ToolCallRecovery 的简化版): —— 给没有任何 tool 结果的 tool_call 合成一条错误结果,
 *  保证 messages 里 tool_call/tool_result 永远配对,下一轮请求不会因协议断裂 400。
 *  正常流程里结果总是紧跟调用入栈,本函数是 no-op;它保护的是未来会引入的
 *  取消/并行执行/超时等提前退出路径(roadmap 里"取消信号进内核"落地后就靠它兜底)。
 *  @returns {number} 补写的结果条数 */
function pairPendingToolCalls(messages, note) {
	const answered = new Set()
	for (const m of messages) {
		if (m && m.role === "tool" && m.tool_call_id) answered.add(m.tool_call_id)
	}
	let n = 0
	for (const m of messages) {
		if (!m || m.role !== "assistant" || !Array.isArray(m.tool_calls)) continue
		for (const call of m.tool_calls) {
			const id = call && call.id
			if (!id || answered.has(id)) continue
			messages.push({
				role: "tool",
				tool_call_id: id,
				content: JSON.stringify({ error: note || "工具调用未完成（循环提前退出），结果未知" }),
			})
			answered.add(id)
			n++
		}
	}
	return n
}

// 兼容非模块环境（浏览器 <script> 直接引入）：挂到全局
if (typeof globalThis !== "undefined") {
	globalThis.AgentKernel = { createToolRegistry, runAgentLoop, isRunning }
}

