/**
 * agent-llm-adapter.js — 模型适配层（provider-agnostic callModel）
 * 针对 DeepSeek V4（2026-04 发布）重写：
 *   - 模型名：deepseek-v4-flash / deepseek-v4-pro（base_url 不变）
 *   - deepseek-chat / deepseek-reasoner 为弃用别名（2026-07-24 15:59 UTC 下线），调用时告警
 *   - 思考模式：thinking:{type:enabled/disabled} + reasoning_effort:high/max
 *   - V4 思考模式【支持 function calling】（V3 reasoner 不支持的限制已取消）
 *
 * §G 收口：
 *   §G-1 reasoning_content 卫生（V4 正确语义）：
 *        带 tool_calls 的 assistant 轮次【必须】回传 reasoning_content，否则 400；
 *        不带 tool_calls 的 assistant 轮次则剔除（传了也被忽略，剔掉省 token）。
 *   §G-2 空 assistant 400：带 tool_calls 的 assistant 强制 content=""；既无 content 又无 tool_calls 丢弃。
 *   §G-3 流式 tool_calls 按 index 重组拼接。
 *
 * 用法：
 *   import { createLLMClient } from "./agent-llm-adapter.js"
 *   const callModel = createLLMClient({ provider: "deepseek-v4-flash", endpoint: "/api/chat" })
 *   await runAgentLoop({ messages, registry, callModel })
 */

// ---- provider 注册表（未来扩展点）----
const PROVIDERS = {
	// ✅ 当前推荐：V4 Flash / Pro——思考 + 非思考双模，两种模式都支持 tool calls
	"deepseek-v4-flash": { model: "deepseek-v4-flash", supportsTools: true, supportsThinking: true },
	"deepseek-v4-pro": { model: "deepseek-v4-pro", supportsTools: true, supportsThinking: true },
	// ⚠️ 弃用别名（2026-07-24 15:59 UTC 下线），映射到 v4-flash 的非思考/思考模式
	"deepseek-chat": { model: "deepseek-chat", supportsTools: true, supportsThinking: false, deprecated: true, deprecatedOn: "2026-07-24", successor: "deepseek-v4-flash" },
	"deepseek-reasoner": { model: "deepseek-reasoner", supportsTools: true, supportsThinking: true, deprecated: true, deprecatedOn: "2026-07-24", successor: "deepseek-v4-flash" },
	// 通用 OpenAI 兼容兜底（GPT / Qwen / Kimi 等），model 由调用方指定
	"openai-compatible": { model: null, supportsTools: true, supportsThinking: false },
}

export function registerProvider(key, def) {
	PROVIDERS[key] = { supportsTools: true, supportsThinking: false, ...def }
	return PROVIDERS[key]
}
export function listProviders() {
	return Object.keys(PROVIDERS)
}
export function getProvider(key) {
	return PROVIDERS[key] || null
}

/**
 * §G-1 / §G-2 回灌前消息清洗（DeepSeek V4 正确语义）。
 */
export function sanitizeMessages(messages) {
	const out = []
	for (const m of messages || []) {
		if (!m || !m.role) continue
		const c = { ...m }
		if (c.role === "assistant") {
			if (c.content == null) c.content = "" // §G-2
			const hasToolCalls = !!(c.tool_calls && c.tool_calls.length)
			if (!String(c.content).trim() && !hasToolCalls) continue // §G-2 丢弃空 assistant
			if (!hasToolCalls) delete c.reasoning_content // §G-1：无 tool_calls 才剔除
		} else {
			delete c.reasoning_content // 非 assistant 上不应携带
		}
		out.push(c)
	}
	return out
}

/**
 * §G-3 流式 tool_calls 重组：仅首片带 id/name，arguments 被切碎，按 index 累加拼接。
 */
export function reassembleStreamedToolCalls(deltas) {
	const byIndex = new Map()
	for (const d of deltas || []) {
		if (!d || d.index == null) continue
		let cur = byIndex.get(d.index)
		if (!cur) {
			cur = { index: d.index, id: d.id, type: d.type || "function", function: { name: (d.function && d.function.name) || "", arguments: "" } }
			byIndex.set(d.index, cur)
		}
		if (d.id) cur.id = d.id
		if (d.type) cur.type = d.type
		if (d.function) {
			if (d.function.name) cur.function.name = d.function.name
			if (d.function.arguments) cur.function.arguments += d.function.arguments
		}
	}
	return [...byIndex.values()].sort((a, b) => a.index - b.index).map(({ index, ...t }) => t)
}

/** strict 模式（beta）：function.strict=true + additionalProperties:false + 所有字段 required。 */
function withStrict(schema) {
	if (!schema || schema.type !== "function" || !schema.function) return schema
	const fn = { ...schema.function, strict: true }
	const p = fn.parameters
	if (p && p.type === "object" && p.properties) {
		fn.parameters = { ...p, additionalProperties: false, required: Object.keys(p.properties) }
	}
	return { ...schema, function: fn }
}

async function parseStream(resp) {
	const reader = resp.body.getReader()
	const dec = new TextDecoder()
	let buf = "", content = "", reasoning = ""
	const toolDeltas = []
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		buf += dec.decode(value, { stream: true })
		let nl
		while ((nl = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, nl).trim()
			buf = buf.slice(nl + 1)
			if (!line.startsWith("data:")) continue
			const payload = line.slice(5).trim()
			if (payload === "[DONE]") continue
			let json
			try { json = JSON.parse(payload) } catch { continue }
			const delta = json.choices && json.choices[0] && json.choices[0].delta
			if (!delta) continue
			if (delta.content) content += delta.content
			if (delta.reasoning_content) reasoning += delta.reasoning_content
			if (Array.isArray(delta.tool_calls)) for (const tc of delta.tool_calls) toolDeltas.push(tc)
		}
	}
	const msg = { role: "assistant", content }
	if (reasoning) msg.reasoning_content = reasoning
	const tcs = reassembleStreamedToolCalls(toolDeltas)
	if (tcs.length) msg.tool_calls = tcs
	return msg
}

/**
 * 构造 callModel(messages, schemas) —— 传给 runAgentLoop。
 * options:
 *   provider          默认 "deepseek-v4-flash"
 *   endpoint          默认 "/api/chat"（worker 代理）
 *   model             覆盖 provider 默认模型名
 *   stream            默认 false
 *   strict            默认 false（需配 base_url=/beta）
 *   toolChoice        默认 "auto"
 *   thinking          "enabled"|"disabled"|"off"；不传则按 provider.supportsThinking 决定
 *   reasoningEffort   "high"|"max"，默认 "high"
 *   maxTokens, fetchImpl
 */
export function createLLMClient(opts = {}) {
	const {
		provider = "deepseek-v4-flash",
		endpoint = "/api/chat",
		model,
		stream = false,
		strict = false,
		toolChoice = "auto",
		thinking,
		reasoningEffort = "high",
		maxTokens,
		fetchImpl,
		timeoutMs = 60000, // 4.79 #11: callModel fetch 硬超时(ms);<=0 关闭
	} = opts
	const warned = {}
	return async function callModel(messages, schemas) {
		const prov = PROVIDERS[provider] || PROVIDERS["openai-compatible"]
		const usingTools = Array.isArray(schemas) && schemas.length > 0
		if (usingTools && !prov.supportsTools) {
			throw new Error(`provider「${provider}」不支持 function calling（无法传 tools）`)
		}
		if (prov.deprecated && !warned[provider]) {
			warned[provider] = true
			console.warn(`[adapter] 模型「${provider}」将于 ${prov.deprecatedOn || "2026-07-24"} 弃用，请迁移到 ${prov.successor || "deepseek-v4-flash"}`)
		}
		const useModel = model || prov.model
		if (!useModel) throw new Error(`provider「${provider}」未指定 model`)
		const body = { model: useModel, messages: sanitizeMessages(messages), stream }
		if (usingTools) {
			body.tools = strict ? schemas.map(withStrict) : schemas
			body.tool_choice = toolChoice
		}
		const wantThinking = thinking || (prov.supportsThinking ? "enabled" : null)
		if (prov.supportsThinking && wantThinking && wantThinking !== "off") {
			body.thinking = { type: wantThinking === "disabled" ? "disabled" : "enabled" }
			if (body.thinking.type === "enabled") body.reasoning_effort = reasoningEffort
		}
		if (maxTokens) body.max_tokens = maxTokens
		const f = fetchImpl || (typeof fetch !== "undefined" ? fetch : null)
		if (!f) throw new Error("no fetch available")
		// 4.79 #11: 裸 fetch 无超时,外呼无响应(网络挂起/worker 卡住)时 agent 轮次会无限挂死。
		// 用 AbortController + 定时器加硬超时(默认 60s),超时中断并抛错,交上层 runAgentLoop 兜底(重试/如实告知)。
		const _ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null
		let _timer = null
		if (_ctrl && timeoutMs > 0) _timer = setTimeout(function () { try { _ctrl.abort() } catch (e) {} }, timeoutMs)
		let resp
		try {
			resp = await f(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: _ctrl ? _ctrl.signal : undefined })
		} catch (e) {
			if (_ctrl && _ctrl.signal && _ctrl.signal.aborted) throw new Error("LLM 请求超时(>" + Math.round(timeoutMs / 1000) + "s),已中断")
			throw e
		} finally {
			if (_timer) clearTimeout(_timer)
		}
		if (resp && resp.ok === false) throw new Error("LLM HTTP " + (resp.status || "error"))
		if (stream) return await parseStream(resp)
		const data = await resp.json()
		return (data.choices && data.choices[0] && data.choices[0].message) || { role: "assistant", content: "" }
	}
}