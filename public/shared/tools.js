/**
 * OwnChat 工具集 · 浏览器侧（接 agent-kernel.js）
 * 依赖：public/shared/agent-kernel.js (window.AgentKernel.createToolRegistry)
 *
 * 契约：工具回调键是 run(args, ctx)（不是 execute），与 agent-kernel define() 一致。
 *
 * 直接对接现有全局模块（函数名均读源码核对）：
 *   - 发图: window.__chatImage.sendPhoto({ kind?, characterId?, scenePrompt? }) => { imageUrl, taskId }
 *           kind === "scene" 发场景图（不出现角色）；否则发角色自拍（保持同一人）
 *   - 好感: window.__character.adjustActiveAffection(delta) / setActiveAffection(n)
 *
 * 用法：
 *   const registry = OwnChatTools.buildRegistry({ onImage: (url, meta) => renderImageBubble(url) })
 *   await window.AgentKernel.runAgentLoop({ messages, registry, callModel })
 */
(function (global) {
	"use strict"

	function defineTools(registry, opts) {
		opts = opts || {}
		const onImage = opts.onImage // (url, meta) => void：把图渲染进对话气泡

		// ── 2026-09-10 S0 止血: 工具集分档 ──────────────────────────
		// 原来一次性注册 17 个工具(再叠上 AgentReach 的联网工具),模型每轮都要在十几个 schema 里挑,
		// 结果就是选错工具、参数瞎填、循环里打转 —— 这是 agent「bug 极多、没实用性」的头号原因。
		// 只分两档:
		//   core(默认) —— 真正天天用的那些: 写文件 / 弹选项 / 载技能 / 角色卡 / 发图 / 好感 / 朗读
		//   full     —— 全 17 个,只在自检或确实需要时临时开
		// 切换: 设置·聊天模式卡里的「Agent 工具集」下拉,或 buildRegistry({ profile:'full' })。
		// 代码一行没删,只是不再默认塞给模型;后续 S1-S4(工作目录 / 白名单 run_command / SQLite)在此基础上加。
		// 注: 联网工具(web_search/fetch_page 等)由 agent-reach.js 单独注册,不受本门控管。
		const CORE_TOOLS = [
			// 2026-09-14:去掉 write_file —— 它已由 data/agent-workspace.js 的「真写工作区」版本取代
			// (旧版只弹下载,文件不落地、读不回来;新 write_file 写 IndexedDB 并可 read_file 读回,
			//  要落盘则用 export_file)。同时避免两处同名 define 抛错带崩后续工具注册。
			"offer_choices", "load_skill",
			"manage_character_card", "send_image", "adjust_affinity", "speak",
			// 2026-10-08 多智能体编排：从 full 档放开到默认档（用户口径：让 agent 也能用多智能体 /
			// 主-子路线）。真正是否注册还看"多智能体模式 + 各自设置开关"，见 MA_GATED。
			"delegate_to_agent", "convene_meeting", "invite_character",
		]
		// 2026-10-08: 子 agent（delegate_to_agent 派出的临时工）用「最小权限」档 ——
		// 只留"读与调查"（技能正文 + 联网只读由 AgentReach 另行挂载），不给任何会改动用户数据 /
		// 时间线 / 角色卡的工具。用户口径：子 agent 最小权限、仅本对话、由主 agent 创建、任务完成即回收。
		// 不含任何编排工具 → 天然防递归（深度上限仍在，作为第二道闸）。
		const SUB_TOOLS = ["load_skill"]
		let _profile = opts.profile
		if (!_profile) { try { _profile = localStorage.getItem("cfw_agent_tools_v1") || "core" } catch (e) { _profile = "core" } }
		const _allowed = _profile === "full" ? null : (_profile === "sub" ? SUB_TOOLS : CORE_TOOLS)
		const _realDefine = registry.define.bind(registry)
		// 2026-10-08 多智能体编排的"分层开关"：
		//   ① 多智能体模式（侧栏按钮）关着 → 只有单 agent，不注册任何编排工具；
		//   ② 开着再按各功能的设置开关（设置→多智能体）逐个决定（默认开）。
		// 子 agent 档（sub）永不注册编排工具 —— 防递归的第一道闸。
		const MA_GATED = {
			delegate_to_agent: "cfw_ma_delegate_v1",
			convene_meeting: "cfw_ma_meeting_v1",
			invite_character: "cfw_ma_invite_v1",
		}
		function _maOn() { try { return localStorage.getItem("tavern_multi_agent_mode_v1") === "multi"; } catch (e) { return false; } }
		function _maFlag(k) { try { const v = localStorage.getItem(k); return v == null ? true : v === "1"; } catch (e) { return true; } }
		function _maEnabled(k) { return _profile !== "sub" && _maOn() && _maFlag(k); }
		// 2026-10-13 批 I：精简模式（html.slim）时不注册角色扮演/出图向工具（开关在 设置→高级，见 shared/slim.js）
		const SLIM_HIDDEN = ["send_image"]
		function _slimOn() { try { return document.documentElement.classList.contains("slim") } catch (e) { return false } }
		function define(def) {
			if (_allowed && _allowed.indexOf(def && def.name) < 0) return registry
			if (def && MA_GATED[def.name] && !_maEnabled(MA_GATED[def.name])) return registry
			if (def && _slimOn() && SLIM_HIDDEN.indexOf(def.name) >= 0) return registry
			return _realDefine(def)
		}

		define({
			name: "send_image",
			description:
				"给用户发一张图。type='selfie' 发角色本人自拍（保持同一人）；type='scene' 发场景/物品图（画面不出现角色）。剧情需要展示外观、场景或道具时调用。",
			parameters: {
				type: "object",
				properties: {
					type: { type: "string", enum: ["selfie", "scene"], description: "selfie=角色自拍，scene=场景图" },
					scene_prompt: { type: "string", description: "画面内容描述，例如『在海边的夜晚』『一杯冒热气的咖啡』" },
					character_id: { type: "string", description: "可选，指定角色卡 id，默认当前激活角色" },
				},
				required: ["type", "scene_prompt"],
			},
			async run(args) {
				const ci = global.__chatImage
				if (!ci || typeof ci.sendPhoto !== "function") {
					return { ok: false, error: "发图模块未就绪 (image-chat.js / window.__chatImage)" }
				}
				// 4.81 修(手机端发图卡住截断): 底层出图/改图各自已带超时,这里再加一道 agent 工具级硬上限。
				// 无论网络如何卡顿,发图工具都在有限时间内返回,绝不让 agent 主循环(及对话气泡)无限挂起;
				// 超时按失败回灌,模型下一轮可自行重试或如实告知用户。
				const SEND_IMAGE_TIMEOUT_MS = 150000
				let _timer = null
				const _timeout = new Promise(function (_, reject) {
					_timer = setTimeout(function () { reject(new Error("发图超时(>150s),可能网络不稳或出图服务繁忙")) }, SEND_IMAGE_TIMEOUT_MS)
				})
				let res
				try {
					res = await Promise.race([
						ci.sendPhoto({
							kind: args.type === "scene" ? "scene" : undefined,
							characterId: args.character_id,
							scenePrompt: args.scene_prompt,
						}),
						_timeout,
					])
				} catch (e) {
					return { ok: false, error: "发图失败: " + (e && e.message ? e.message : String(e)) }
				} finally {
					if (_timer) clearTimeout(_timer)
				}
				const url = res && res.imageUrl
				if (url && typeof onImage === "function") onImage(url, { type: args.type, taskId: res && res.taskId })
				return url ? { ok: true, imageUrl: url } : { ok: false, error: "发图无返回" }
			},
		})

		define({
			name: "adjust_affinity",
			destructive: true, // 改好感度(持久状态)
			description:
				"调整当前角色对用户的好感度（相对增减）。仅在剧情中发生明显拉近或破坏关系的事件时调用。",
			parameters: {
				type: "object",
				properties: {
					delta: { type: "number", description: "好感增减值，可为负，建议每次 -10 ~ +10" },
					reason: { type: "string", description: "变化原因（一句话）" },
				},
				required: ["delta"],
			},
			async run(args) {
				const ch = global.__character
				if (!ch || typeof ch.adjustActiveAffection !== "function") {
					return { ok: false, error: "好感模块未就绪 (character.js / window.__character)" }
				}
				const value = await ch.adjustActiveAffection(args.delta)
				return { ok: true, delta: args.delta, value: typeof value === "number" ? value : undefined }
			},
		})

		// 2026-09-14:原 write_file(只弹下载/保存框,文件不落地、模型读不回来)已删除,
		// 由 data/agent-workspace.js 的 write_file(写工作区,可 read_file 读回)+ export_file(落盘)取代。
		define({
			name: "delegate_to_agent",
			// 2026-10-04 补标记:它会派生一个最多 6 轮的子循环(ctx.subMaxIterations || 6),
			// 每轮都真实计费;而 plan 模式(AGENT_PLAN_DIRECTIVE 声明"只做只读调查")原本拦不住它。
			// 同类先例:generate_video_story 也因"成本型操作"标了 destructive。
			// 注意子 agent 继承父级 ensurePermission,所以它的破坏性工具本来受管 —— 漏的是这一次调用。
			destructive: true,
			description:
				"派一个子 agent 独立完成某个子任务并返回结论。适合把可隔离的子任务(资料检索、分步推理、子方案起草)交给专职子 agent,你再汇总。子 agent 用同一套工具,靠深度上限防无限递归。",
			parameters: {
				type: "object",
				properties: {
					role: { type: "string", description: "子 agent 的角色/专长,如『资料检索员』『方案起草人』" },
					task: { type: "string", description: "交给子 agent 的具体子任务(含所需上下文)" },
				},
				required: ["task"],
			},
			async run(args, ctx) {
				ctx = ctx || {}
				const kernel = global.AgentKernel
				if (!kernel || typeof kernel.runAgentLoop !== "function") {
					return { ok: false, error: "AgentKernel 未就绪,无法派生子 agent" }
				}
				if (typeof ctx.callModel !== "function") {
					return { ok: false, error: "缺少 callModel,无法派生子 agent" }
				}
				const depth = (ctx.depth || 0) + 1
				const maxDepth = typeof ctx.maxDepth === "number" ? ctx.maxDepth : 2
				if (depth > maxDepth) {
					return { ok: false, error: "子 agent 嵌套已达上限(" + maxDepth + "),请直接完成该子任务" }
				}
				const role = args.role || "子 agent"
				const onEvent = typeof ctx.onEvent === "function" ? ctx.onEvent : function () {}
				onEvent({ type: "subagent_start", role, task: args.task, depth })
				let subRegistry
				try {
					// 2026-10-08: 子 agent 走「最小权限」档（见 SUB_TOOLS）—— 只给读与调查能力。
					// 旧版 buildRegistry({onImage}) 会按父级的档位把角色卡/发图/好感/朗读全给它。
					subRegistry = buildRegistry({ onImage: opts && opts.onImage, profile: "sub" })
					// 子 agent 也挂上联网技能(Agent-Reach):buildRegistry 只含站内工具,
					// 不补这一步,子 agent 拿不到 fetch_page/web_search 等,"去查资料再汇总"时根本搜不了网。
					if (global.AgentReach && typeof global.AgentReach.defineTools === "function") {
						try { global.AgentReach.defineTools(subRegistry) } catch (e2) { /* 单个工具注册失败不影响子 agent 主流程 */ }
					}
				} catch (e) {
					subRegistry = registry
				}
				const subMessages = [
					{ role: "system", content: "你是名为「" + role + "」的子 agent,只专注完成被指派的单一子任务,完成后用简洁结论作答,不要寒暄。" },
					{ role: "user", content: String(args.task || "") },
				]
				try {
					const sub = await kernel.runAgentLoop({
						messages: subMessages,
						registry: subRegistry,
						callModel: ctx.callModel,
						maxIterations: ctx.subMaxIterations || 6,
						context: Object.assign({}, ctx, { depth }),
						ensurePermission: ctx.ensurePermission,
						onEvent,
					})
					onEvent({ type: "subagent_done", role, depth })
					return { ok: true, role, result: (sub && sub.finalText) || "" }
				} catch (e) {
					onEvent({ type: "subagent_done", role, depth })
					return { ok: false, error: "子 agent 运行失败: " + (e && e.message ? e.message : e) }
				}
			},
		})

		// 2026-10-08 编排工具②「私开小会」：多位角色并行独立作答，结论回主 agent、不进时间线。
		// 参与者用**本人档案 + 自己的独立上下文**（见 app.js runPeerMeeting / selectSpeakerView）。
		define({
			name: "convene_meeting",
			destructive: true, // 每位参与者都是一次真实计费调用 → 走权限卡（成本闸门）
			description:
				"私下开一个小会：就某个议题征询若干角色（或指定视角）的意见，各自独立作答；结果只回给你，不进聊天时间线。" +
				"适合：需要多方视角的复杂问题（方案评审、工程规划、剧情走向），或某个角色擅长的话题 —— 先私下问清，再决定要不要请它上台。",
			parameters: {
				type: "object",
				properties: {
					topic: { type: "string", description: "议题 / 要问的问题（写清背景与期望产出）" },
					participants: { type: "array", items: { type: "string" }, description: "参与者名字（已保存的角色卡名）。省略 = 场景成员；一个角色都没有时退回通用视角" },
					agenda: { type: "array", items: { type: "object", properties: { who: { type: "string", description: "参与者名字（可省，按顺序对应）" }, aspect: { type: "string", description: "该参与者负责的方面，如 架构 / 成本 / 风险" } }, required: ["aspect"] }, description: "可选：多方多主题 —— 给每位参与者指定负责的方面" },
					rounds: { type: "number", description: "1（默认，各答各的）或 2（第二轮能看到彼此答案、互相补充或反驳）" },
				},
				required: ["topic"],
			},
			async run(args, ctx) {
				const app = global.__app
				if (!app || typeof app.runPeerMeeting !== "function") {
					return { ok: false, error: "多智能体未接线（app.js 未提供 runPeerMeeting）" }
				}
				return await app.runPeerMeeting(Object.assign({}, args || {}, { onEvent: (ctx && ctx.onEvent) || function () {} }))
			},
		})

		// 2026-10-08 编排工具③「叫上台」：角色按自己的档案与上下文，直接在时间线里回答。
		// 与私开小会可任意组合（先私下讨论 → 再请上台总结）。可见、可删，不额外开权限卡。
		define({
			name: "invite_character",
			destructive: false,
			description:
				"把某个角色「叫上台」：它按自己的人设与自己的上下文，直接在聊天时间线里回答（用户会看到它的气泡）。" +
				"适合把话题交给擅长它的角色，或先私开小会、再请它上台做总结。调用后你会收到它在时间线上说了什么。",
			parameters: {
				type: "object",
				properties: {
					name: { type: "string", description: "角色名（已保存的角色卡）" },
					brief: { type: "string", description: "可选：给它的简短交代（当前讨论到哪、希望它回答什么；不写则按它自己的上下文接话）" },
				},
				required: ["name"],
			},
			async run(args, ctx) {
				const app = global.__app
				if (!app || typeof app.inviteCharacterToTimeline !== "function") {
					return { ok: false, error: "多智能体未接线（app.js 未提供 inviteCharacterToTimeline）" }
				}
				return await app.inviteCharacterToTimeline(Object.assign({}, args || {}, { onEvent: (ctx && ctx.onEvent) || function () {} }))
			},
		})

		define({
			name: "manage_character_card",
			destructive: (a) => !!a && a.action !== "list" && a.action !== "get", // list/get 只读
			description:
				"管理角色卡(提示词编辑器·角色页，存 tavern_chars_v2，与左栏角色卡同一数据源)。" +
				"action: list 列出全部 / get 取单张 / create 新建 / update 改字段 / delete 删除 / activate 设为当前角色。" +
				"create/update 用 card 对象(create 时 name 必填;update 与现有卡合并);get/update/delete/activate 需要 id。",
			parameters: {
				type: "object",
				properties: {
					action: { type: "string", enum: ["list", "get", "create", "update", "delete", "activate"], description: "操作类型" },
					id: { type: "string", description: "get/update/delete/activate 必填:角色卡 id" },
					card: {
						type: "object",
						description: "create/update 的字段;update 时与现有卡按字段合并",
						properties: {
							name: { type: "string", description: "角色名(create 必填)" },
							gender: { type: "string", description: "female/male/双性/无性别/自定义" },
							age: { type: "string", description: "年龄,影响立绘" },
							identity: { type: "string", description: "身份/背景" },
							icon: { type: "string", description: "头像 emoji" },
							personality: { type: "string", description: "性格关键词" },
							speakingStyle: { type: "string", description: "说话方式" },
							rules: { type: "array", items: { type: "string" }, description: "行为铁则,最多 3 条" },
							openingLine: { type: "string", description: "开场白" },
							exampleQA: { type: "array", items: { type: "object", properties: { user: { type: "string" }, character: { type: "string" } } }, description: "示例对话" },
						},
					},
				},
				required: ["action"],
				additionalProperties: false,
			},
			async run(args) {
				const ch = global.__character
				if (!ch || typeof ch.getAllCards !== "function") return { ok: false, error: "角色卡模块未就绪 (character.js / window.__character)" }
				const action = args && args.action
				try {
					if (action === "list") {
						const cards = (await ch.getAllCards()) || []
						let activeId = ""
						try { activeId = localStorage.getItem("tavern_active_char_id") || "" } catch (e) {}
						return { ok: true, active_id: activeId, count: cards.length, cards: cards.map(c => ({ id: c.id, name: c.name, gender: c.gender, age: c.age, identity: c.identity, icon: c.icon, personality: c.personality, active: c.id === activeId })) }
					}
					if (action === "get") {
						if (!args.id) return { ok: false, error: "get 需要 id" }
						const cards = (await ch.getAllCards()) || []
						const c = cards.find(x => x.id === args.id)
						return c ? { ok: true, card: c } : { ok: false, error: "未找到角色卡: " + args.id }
					}
					if (action === "delete") {
						if (!args.id) return { ok: false, error: "delete 需要 id" }
						if (typeof ch.deleteCard !== "function") return { ok: false, error: "deleteCard 不可用" }
						await ch.deleteCard(args.id)
						return { ok: true, action: "delete", id: args.id }
					}
					if (action === "activate") {
						if (!args.id) return { ok: false, error: "activate 需要 id" }
						if (typeof ch.setActiveId !== "function") return { ok: false, error: "setActiveId 不可用" }
						ch.setActiveId(args.id)
						return { ok: true, action: "activate", id: args.id }
					}
					if (action === "create" || action === "update") {
						if (typeof ch.saveCard !== "function") return { ok: false, error: "saveCard 不可用" }
						const input = (args && args.card) || {}
						let base = {}
						if (action === "update") {
							if (!args.id) return { ok: false, error: "update 需要 id" }
							const cards = (await ch.getAllCards()) || []
							base = cards.find(x => x.id === args.id) || {}
							if (!base.id) return { ok: false, error: "未找到角色卡: " + args.id }
						}
						const merged = Object.assign({}, base, input)
						if (action === "update") merged.id = args.id
						if (!merged.name) return { ok: false, error: "name 不能为空" }
						const saved = await ch.saveCard(merged)
						return { ok: true, action, card: saved || merged }
					}
					return { ok: false, error: "未知 action: " + action }
				} catch (e) {
					return { ok: false, error: "角色卡操作失败: " + (e && e.message ? e.message : String(e)) }
				}
			},
		})

		define({
			name: "manage_lorebook",
			destructive: (a) => !!a && a.action !== "list" && a.action !== "get",
			description:
				"管理世界书条目(Lore Book，存 tavern_lorebook_v1，随云同步)。" +
				"action: list / get / create / update / delete。" +
				"条目字段:name、content、keywords(数组或逗号分隔)、alwaysOn(常驻注入)、priority(越大越靠前)、scope(global|perCard)、boundCardId、enabled。" +
				"create/update 用 entry;get/update/delete 需要 id。",
			parameters: {
				type: "object",
				properties: {
					action: { type: "string", enum: ["list", "get", "create", "update", "delete"], description: "操作类型" },
					id: { type: "string", description: "get/update/delete 必填:条目 id" },
					entry: {
						type: "object",
						description: "create/update 的字段;update 时与现有条目合并",
						properties: {
							name: { type: "string" },
							content: { type: "string", description: "注入【世界设定】的正文" },
							keywords: { type: "array", items: { type: "string" }, description: "触发关键词;留空且非常驻=永不注入" },
							alwaysOn: { type: "boolean", description: "常驻注入,无视关键词" },
							priority: { type: "number", description: "越大越靠前" },
							scope: { type: "string", enum: ["global", "perCard"], description: "生效范围" },
							boundCardId: { type: "string", description: "scope=perCard 时绑定的角色卡 id" },
							enabled: { type: "boolean" },
						},
					},
				},
				required: ["action"],
				additionalProperties: false,
			},
			async run(args) {
				const lb = global.__lorebook
				if (!lb || typeof lb.getAll !== "function") return { ok: false, error: "世界书模块未就绪 (lorebook.js / window.__lorebook)" }
				const action = args && args.action
				try {
					if (action === "list") {
						const all = lb.getAll() || []
						return { ok: true, count: all.length, entries: all.map(e => ({ id: e.id, name: e.name, keywords: e.keywords, alwaysOn: e.alwaysOn, priority: e.priority, scope: e.scope, enabled: e.enabled, preview: (e.content || "").slice(0, 80) })) }
					}
					if (action === "get") {
						if (!args.id) return { ok: false, error: "get 需要 id" }
						const e = lb.getEntry(args.id)
						return e ? { ok: true, entry: e } : { ok: false, error: "未找到条目: " + args.id }
					}
					if (action === "delete") {
						if (!args.id) return { ok: false, error: "delete 需要 id" }
						if (typeof lb.deleteEntry !== "function") return { ok: false, error: "deleteEntry 不可用" }
						lb.deleteEntry(args.id)
						return { ok: true, action: "delete", id: args.id }
					}
					if (action === "create" || action === "update") {
						if (typeof lb.saveEntry !== "function") return { ok: false, error: "saveEntry 不可用" }
						const input = (args && args.entry) || {}
						let base = {}
						if (action === "update") {
							if (!args.id) return { ok: false, error: "update 需要 id" }
							base = lb.getEntry(args.id) || {}
							if (!base.id) return { ok: false, error: "未找到条目: " + args.id }
						}
						const merged = Object.assign({}, base, input)
						if (action === "update") merged.id = args.id
						if (!(merged.name || (merged.content && String(merged.content).trim()))) return { ok: false, error: "name 和 content 不能都为空" }
						const saved = lb.saveEntry(merged)
						return { ok: true, action, entry: saved }
					}
					return { ok: false, error: "未知 action: " + action }
				} catch (e) {
					return { ok: false, error: "世界书操作失败: " + (e && e.message ? e.message : String(e)) }
				}
			},
		})

		define({
			name: "manage_preset",
			destructive: (a) => !!a && a.action !== "list" && a.action !== "get",
			description:
				"管理指令模块(即预设 / Preset，存 cfw_prompt_presets_v1，启用后追加到 system prompt 末层)。" +
				"action: list / get / create / update / delete / toggle(开关启用)。" +
				"create/update 用 preset(name、content、enabled、group);get/update/delete/toggle 需要 id;toggle 可传 enabled,省略则翻转。",
			parameters: {
				type: "object",
				properties: {
					action: { type: "string", enum: ["list", "get", "create", "update", "delete", "toggle"], description: "操作类型" },
					id: { type: "string", description: "get/update/delete/toggle 必填:preset id" },
					enabled: { type: "boolean", description: "toggle 时设置启用状态;省略则翻转" },
					preset: {
						type: "object",
						description: "create/update 的字段",
						properties: {
							name: { type: "string" },
							content: { type: "string", description: "追加到 system prompt 的内容" },
							enabled: { type: "boolean" },
							group: { type: "string", description: "可选分组名" },
						},
					},
				},
				required: ["action"],
				additionalProperties: false,
			},
			async run(args) {
				const KEY = "cfw_prompt_presets_v1"
				function load() { try { const a = JSON.parse(localStorage.getItem(KEY) || "[]"); return Array.isArray(a) ? a : [] } catch (e) { return [] } }
				function save(a) { try { localStorage.setItem(KEY, JSON.stringify(a)) } catch (e) {} }
				function uid() { return "preset-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6) }
				const action = args && args.action
				try {
					const arr = load()
					if (action === "list") {
						return { ok: true, count: arr.length, presets: arr.slice().sort((a, b) => (a.order || 0) - (b.order || 0)).map(p => ({ id: p.id, name: p.name, enabled: !!p.enabled, group: p.group || "", preview: (p.content || "").slice(0, 80) })) }
					}
					if (action === "get") {
						if (!args.id) return { ok: false, error: "get 需要 id" }
						const p = arr.find(x => x.id === args.id)
						return p ? { ok: true, preset: p } : { ok: false, error: "未找到 preset: " + args.id }
					}
					if (action === "delete") {
						if (!args.id) return { ok: false, error: "delete 需要 id" }
						const next = arr.filter(x => x.id !== args.id)
						if (next.length === arr.length) return { ok: false, error: "未找到 preset: " + args.id }
						save(next)
						return { ok: true, action: "delete", id: args.id }
					}
					if (action === "toggle") {
						if (!args.id) return { ok: false, error: "toggle 需要 id" }
						const p = arr.find(x => x.id === args.id)
						if (!p) return { ok: false, error: "未找到 preset: " + args.id }
						p.enabled = (typeof args.enabled === "boolean") ? args.enabled : !p.enabled
						save(arr)
						return { ok: true, action: "toggle", id: args.id, enabled: p.enabled }
					}
					if (action === "create") {
						const input = (args && args.preset) || {}
						if (!input.name) return { ok: false, error: "name 不能为空" }
						const maxOrder = arr.reduce((m, x) => Math.max(m, x.order || 0), -1)
						const p = { id: uid(), name: input.name, content: input.content || "", enabled: !!input.enabled, order: maxOrder + 1, group: input.group || "" }
						arr.push(p); save(arr)
						return { ok: true, action: "create", preset: p }
					}
					if (action === "update") {
						if (!args.id) return { ok: false, error: "update 需要 id" }
						const p = arr.find(x => x.id === args.id)
						if (!p) return { ok: false, error: "未找到 preset: " + args.id }
						const input = (args && args.preset) || {}
						if (typeof input.name === "string") p.name = input.name
						if (typeof input.content === "string") p.content = input.content
						if (typeof input.enabled === "boolean") p.enabled = input.enabled
						if (typeof input.group === "string") p.group = input.group
						save(arr)
						return { ok: true, action: "update", preset: p }
					}
					return { ok: false, error: "未知 action: " + action }
				} catch (e) {
					return { ok: false, error: "preset 操作失败: " + (e && e.message ? e.message : String(e)) }
				}
			},
		})

		define({
			name: "load_skill",
			description:
				"按名加载一条技能的完整正文（Skill 系统 · 三级渐进披露的 level 2）。系统提示里的【可用技能目录】只列了名称与摘要——" +
				"在按某个技能行事之前必须先调本工具取正文，不要凭摘要臆测内容。name 必须与目录里列出的名字完全一致。" +
				"返回 { ok, name, description, content }；名字不存在或技能未列入目录时返回 { ok:false, error, available }（available = 当前可加载的名字）。" +
				"只读，不改变任何启用状态。",
			parameters: {
				type: "object",
				properties: {
					name: { type: "string", description: "技能名（与【可用技能目录】里列出的完全一致）" },
				},
				required: ["name"],
				additionalProperties: false,
			},
			async run(args) {
				const sk = global.__skills
				if (!sk || typeof sk.getByName !== "function") {
					return { ok: false, error: "技能系统未就绪 (skills.js / window.__skills)" }
				}
				try {
					const want = String((args && args.name) || "").trim()
					if (!want) return { ok: false, error: "name 必填：填【可用技能目录】里列出的技能名" }
					const all = (typeof sk.getAll === "function" ? sk.getAll() : []) || []
					const nm = (x) => String((x && x.name) || "").trim()
					const avail = all.filter(x => x && x.enabled).map(nm)
					const hit = typeof sk.getByName === "function" ? sk.getByName(want) : null
					if (!hit) return { ok: false, error: '技能 "' + want + '" 不存在', available: avail }
					const on = (typeof sk.isGlobalEnabled === "function") ? !!sk.isGlobalEnabled() : true
					if (!on || !hit.enabled) {
						return { ok: false, error: '技能 "' + nm(hit) + '" 未列入目录（不可加载）—— 不要按它行事；要让用户去 设置·技能 勾选', available: avail }
					}
					return { ok: true, name: nm(hit), description: hit.description || "", content: String(hit.content || "") }
				} catch (e) {
					return { ok: false, error: "技能加载失败: " + (e && e.message ? e.message : String(e)) }
				}
			},
		})
		define({
			name: "set_theme",
			destructive: true, // 改全局外观
			description:
				"切换界面主题外观(设置·外观风格)。style: minimal(极简) / glass(玻璃) / candle(烛夜私语)；scheme: dark(暗) / light(亮)。两者都可选,只传需要改的项。",
			parameters: {
				type: "object",
				properties: {
					style: { type: "string", enum: ["minimal", "glass", "candle"], description: "主题风格,可选" },
					scheme: { type: "string", enum: ["dark", "light"], description: "明暗,可选" },
				},
			},
			async run(args) {
				const th = global.__theme
				if (!th || typeof th.set !== "function") return { ok: false, error: "主题模块未就绪 (theme.js / window.__theme)" }
				const patch = {}
				if (args && typeof args.style === "string") {
					const allowed = (typeof th.styles === "function" ? th.styles() : ["minimal", "glass", "candle"]) || []
					if (allowed.indexOf(args.style) < 0) return { ok: false, error: "未知 style: " + args.style + ";可选 " + allowed.join("/") }
					patch.style = args.style
				}
				if (args && typeof args.scheme === "string") {
					if (args.scheme !== "dark" && args.scheme !== "light") return { ok: false, error: "scheme 只能是 dark/light" }
					patch.scheme = args.scheme
				}
				if (!Object.keys(patch).length) return { ok: false, error: "至少要传 style 或 scheme" }
				try {
					th.set(patch)
					const cur = typeof th.get === "function" ? th.get() : patch
					return { ok: true, applied: patch, current: cur }
				} catch (e) {
					return { ok: false, error: "切换主题失败: " + (e && e.message ? e.message : String(e)) }
				}
			},
		})

		define({
			name: "set_model",
			destructive: true, // 改当前模型/模式,影响后续全部请求
			description:
				"切换聊天用的模型档位与具体模型。mode: free(免费档,默认 NVIDIA NIM) / fast(快速档,默认 DeepSeek 官方,按量计费;渠道与默认模型在「设置→模型 API」配置)。可选 model=具体模型 id(须属于该档位的模型列表;会先切 mode 再设 model)。不传 model 只切档位、用该档默认模型。",
			parameters: {
				type: "object",
				properties: {
					mode: { type: "string", enum: ["free", "fast"], description: "模型档位" },
					model: { type: "string", description: "可选:具体模型 id(须在该档位列表中)" },
				},
				required: ["mode"],
			},
			async run(args) {
				const doc = global.document
				if (!doc) return { ok: false, error: "无 document,非浏览器环境" }
				const mode = args && args.mode
				if (mode !== "free" && mode !== "fast") return { ok: false, error: "mode 只能是 free/fast" }
				let curMode = "free"
				try { curMode = localStorage.getItem("cfw_mode") === "fast" ? "fast" : "free" } catch (e) {}
				const toggle = doc.getElementById("modeToggle")
				if (curMode !== mode) {
					if (!toggle) return { ok: false, error: "找不到模式切换按钮 (#modeToggle)" }
					toggle.click() // 内部调 applyMode → 同步重建 #modelSel 选项
					// 4.79 #7: applyMode 重建 #modelSel 选项可能跨一个事件循环 tick;让出一拍再读下拉,避免竞态读到旧档位选项(设了却校验/读回旧 model)
					await new Promise(function (r) { setTimeout(r, 0) })
				}
				const sel = doc.getElementById("modelSel")
				let chosen = null
				if (args && typeof args.model === "string" && args.model) {
					if (!sel) return { ok: false, error: "找不到模型下拉 (#modelSel)" }
					const ids = Array.prototype.map.call(sel.options, function (o) { return o.value })
					if (ids.indexOf(args.model) < 0) return { ok: false, error: "模型 " + args.model + " 不在 " + mode + " 档位列表中;可选 " + ids.join(", ") }
					sel.value = args.model
					try { sel.dispatchEvent(new Event("change")) } catch (e) {}
					chosen = args.model
				} else if (sel) {
					chosen = sel.value
				}
				const models = sel ? Array.prototype.map.call(sel.options, function (o) { return { id: o.value, label: o.textContent } }) : []
				return { ok: true, mode: mode, model: chosen, available: models }
			},
		})

		define({
			name: "manage_settings",
			destructive: (a) => !!a && a.action !== "get" && a.action !== "list",
			description:
				"读写常用对话设置开关。action=get 读当前全部;action=set 改一项(需 key + value)。" +
				"可用 key:agentMode(bool,Agent 工具模式)、thinking(bool,深度思考·仅快速档)、replyStyle(default|wechat|verbose,回复风格)、syncChat(bool,同步聊天历史)、devMode(bool,开发者模式)。",
			parameters: {
				type: "object",
				properties: {
					action: { type: "string", enum: ["get", "set"], description: "get 读 / set 改" },
					key: { type: "string", enum: ["agentMode", "thinking", "replyStyle", "syncChat", "devMode"], description: "set 时必填:要改的设置项" },
					value: { description: "set 时必填:布尔(开关)/字符串(replyStyle)" },
				},
				required: ["action"],
			},
			async run(args) {
				const dev = global.__dev
				const doc = global.document
				const lsGet = function (k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v } catch (e) { return d } }
				const lsSet = function (k, v) { try { localStorage.setItem(k, v) } catch (e) {} }
				function snapshot() {
					return {
						agentMode: dev && dev.isAgentMode ? dev.isAgentMode() : (lsGet("cfw_agent_mode_v1", "0") === "1"),
						thinking: lsGet("cfw_thinking", "0") === "1",
						replyStyle: dev && dev.getReplyStyle ? dev.getReplyStyle() : lsGet("cfw_reply_style_v1", "default"),
						syncChat: lsGet("cfw_sync_include_chat_v1", "0") === "1",
						devMode: dev && dev.isDevMode ? dev.isDevMode() : (lsGet("cfw_dev_mode_v1", "0") === "1"),
					}
				}
				const action = args && args.action
				if (action === "get") return { ok: true, settings: snapshot() }
				if (action !== "set") return { ok: false, error: "未知 action: " + action }
				const key = args && args.key
				if (!key) return { ok: false, error: "set 需要 key" }
				const val = args ? args.value : undefined
				const asBool = function (v) { return v === true || v === "true" || v === 1 || v === "1" }
				try {
					switch (key) {
						case "agentMode":
							if (dev && dev.setAgentMode) dev.setAgentMode(asBool(val)); else lsSet("cfw_agent_mode_v1", asBool(val) ? "1" : "0")
							break
						case "devMode":
							if (dev && dev.setDevMode) dev.setDevMode(asBool(val)); else lsSet("cfw_dev_mode_v1", asBool(val) ? "1" : "0")
							break
						case "replyStyle": {
							const rs = (val === "wechat" || val === "verbose") ? val : "default"
							if (dev && dev.setReplyStyle) dev.setReplyStyle(rs); else lsSet("cfw_reply_style_v1", rs)
							break
						}
						case "thinking": {
							const want = asBool(val)
							const tt = doc && doc.getElementById("thinkToggle")
							const cur = lsGet("cfw_thinking", "0") === "1"
							if (tt && !tt.disabled && cur !== want) tt.click() // 内存态 thinkingOn 仅由 #thinkToggle 翻转;仅快速档可用
							else lsSet("cfw_thinking", want ? "1" : "0")
							break
						}
						case "syncChat": {
							const want = asBool(val)
							lsSet("cfw_sync_include_chat_v1", want ? "1" : "0")
							const sc = doc && doc.getElementById("syncIncludeChatToggle")
							if (sc && sc.checked !== want) { sc.checked = want; try { sc.dispatchEvent(new Event("change")) } catch (e) {} }
							break
						}
						default:
							return { ok: false, error: "未知 key: " + key }
					}
				} catch (e) {
					return { ok: false, error: "设置失败: " + (e && e.message ? e.message : String(e)) }
				}
				return { ok: true, key: key, settings: snapshot() }
			},
		})

		define({
			name: "open_editor",
			description:
				"打开提示词编辑器(指令模块 / 角色 / 设定集 的统一编辑中枢)。tab 可选:preset(指令模块) / character(角色) / world(设定集)。不传则打开默认 tab。",
			parameters: {
				type: "object",
				properties: {
					tab: { type: "string", description: "可选:要打开的标签页(preset=指令模块 / character=角色 / world=设定集)" },
				},
			},
			async run(args) {
				const ue = global.__promptEditor
				if (!ue || typeof ue.open !== "function") return { ok: false, error: "提示词编辑器未就绪 (prompt-editor.js / window.__promptEditor)" }
				try {
					ue.open(args && args.tab ? args.tab : undefined)
					return { ok: true, opened: true, tab: (args && args.tab) || "default" }
				} catch (e) {
					return { ok: false, error: "打开编辑器失败: " + (e && e.message ? e.message : String(e)) }
				}
			},
		})

		define({
			name: "query_cost",
			description:
				"查询本应用「对话消耗」统计(仅快速档按量计费;免费档不计费)。" +
				"返回今日/本周/本月/累计的人民币花费。用户问『花了多少钱』『这次烧了多少』『我的消耗』时调用,做决策前也可先查。" +
				"注意:这是模型对话 token 费(主要开销),与联网搜索的 reach_cost(Exa 搜索费)是两本账。",
			parameters: {
				type: "object",
				properties: {
					range: { type: "string", enum: ["today", "week", "month", "total", "all"], description: "要看的区间;all=全都给。默认 all" },
				},
			},
			async run(args) {
				const cost = global.__cost
				if (!cost || typeof cost.getCostStats !== "function") {
					return { ok: false, error: "计费模块未就绪 (app.js / window.__cost)" }
				}
				let mode = "free"
				try { mode = localStorage.getItem("cfw_mode") === "fast" ? "fast" : "free" } catch (e) {}
				let stats
				try { stats = cost.getCostStats() || {} } catch (e) {
					return { ok: false, error: "读取费用统计失败: " + (e && e.message ? e.message : String(e)) }
				}
				const fmt = (n) => "¥" + (Number(n) || 0).toFixed(4)
				const all = { today: fmt(stats.today), week: fmt(stats.week), month: fmt(stats.month), total: fmt(stats.total) }
				const billing = mode === "fast"
				const note = billing
					? "快速档按量计费（默认 DeepSeek 官方）。此为模型对话 token 费,不含联网搜索费(见 reach_cost)。"
					: "当前为免费档,对话不计费;以下为历史快速档累计。"
				const range = (args && args.range) || "all"
				if (range !== "all" && all[range]) {
					return { ok: true, mode, range, cost: all[range], billing, note }
				}
				return { ok: true, mode, billing, today: all.today, week: all.week, month: all.month, total: all.total, note }
			},
		})

		define({
			name: "speak",
			description:
				"用本地语音(TTS·GPT-SoVITS)把文字朗读出来。仅桌面 App 内、且已在「设置·本地语音」配好参考音频时真正发声;" +
				"网页端 / 未配置时为占位空操作(返回 ready:false,不报错、不打断剧情)。剧情需要出声说话或用户要求朗读时调用。",
			parameters: {
				type: "object",
				properties: {
					text: { type: "string", description: "要朗读的文字(括号/星号里的旁白动作会被自动过滤,只念说出来的话)" },
				},
				required: ["text"],
			},
			async run(args) {
				const text = args && typeof args.text === "string" ? args.text.trim() : ""
				if (!text) return { ok: false, error: "text 不能为空" }
				const tts = global.__omniTTS
				// 占位降级:网页端 tts.js 整个空跳过 → __omniTTS 不存在;此时不报错,返回 ready:false 让 agent 知道没出声。
				if (!tts || typeof tts.speak !== "function") {
					return { ok: true, ready: false, spoken: false, note: "TTS 接口未就绪(仅桌面 App 生效),已占位跳过" }
				}
				let c = {}
				try { c = (typeof tts.cfg === "function" ? tts.cfg() : {}) || {} } catch (e) {}
				if (c.enabled === false) return { ok: true, ready: false, spoken: false, note: "本地语音未启用(设置·本地语音里打开)" }
				if (!c.refAudioPath) return { ok: true, ready: false, spoken: false, note: "未设参考音频路径,先在「设置·本地语音」填一下" }
				try {
					tts.speak(text) // 内部按句切分 + 播放队列,逐句排队不阻塞
					return { ok: true, ready: true, spoken: true, port: c.port }
				} catch (e) {
					return { ok: false, error: "朗读失败: " + (e && e.message ? e.message : String(e)) }
				}
			},
		})

		define({
			name: "offer_choices",
			destructive: false,
			description:
				"在输入框上方弹出可点的选项芯片(分支/下拉),让用户点一下就把该选项当作下一条消息发出。" +
				"剧情/对话出现 2-4 个明确走向、需要用户拍板方向时调用,通常作为本轮回复的收尾动作。" +
				"这是 UI 工具提供者层,不抢驱动权,可与普通聊天/agent 共存。",
			parameters: {
				type: "object",
				properties: {
					options: { type: "array", items: { type: "string" }, description: "2-6 个走向选项,每条一句话" },
					include_meta: { type: "boolean", description: "可选:是否附带「继续/换个走向/自己写」元操作芯片,默认 true" },
				},
				required: ["options"],
				additionalProperties: false,
			},
			async run(args) {
				const ch = global.__choices
				if (!ch || typeof ch.renderChoices !== "function") {
					return { ok: false, error: "选项模块未就绪 (choices.js / window.__choices)" }
				}
				const raw = Array.isArray(args && args.options) ? args.options : []
				const options = raw
					.map(function (o) { return typeof o === "string" ? o.trim() : (o && o.label ? String(o.label).trim() : "") })
					.filter(Boolean)
				if (!options.length) return { ok: false, error: "options 至少要有一个非空选项" }
				try {
					// 对齐 choices.js 真实签名 renderChoices(options, { includeMeta, autoSend, ... })
					// autoSend:true → 点击芯片 = sendAsUser(label)(填 #msg + 回车,以普通用户消息发出),由此触发下一轮
					ch.renderChoices(options, {
						includeMeta: args && args.include_meta === false ? false : true,
						autoSend: true,
					})
					return { ok: true, count: options.length, options: options }
				} catch (e) {
					return { ok: false, error: "渲染选项失败: " + (e && e.message ? e.message : String(e)) }
				}
			},
		})

		// 4.x 导演接力:全自动多段 I2V 接力生成连贯长视频(上段尾帧→下段起始图)。
		// 复用图像工坊已验证的 Gitee Wan2_2-I2V-A14B 接口(/img 同源代理)+ 浏览器端 canvas 提尾帧。
		// 串行,单段约20分钟,最多5段;全程标签页不能关。需先给图像渠道的 Gitee 预设填 Key。
		define({
			name: "generate_video_story",
			destructive: true, // 多片段视频,一跑可能数小时且不能关页
			description:
				"【导演模式·全自动接力生成连贯视频】把一个连贯故事拆成 1-5 段 3-5 秒分镜,用『上一段最后一帧』当下一段起始图接力,串成连贯长视频。" +
				"你(模型)当导演写好每段分镜 prompt(务必写明『从上一段最后一帧无缝接续』并锁定同角色/同光线/同机位/同画风等一致性锚点),本工具负责逐段调 Gitee Wan2.2-I2V 生成、提取尾帧、接力。" +
				"串行执行,单段约20分钟,最多5段(封顶防失控),全程标签页不能关。需要:① 已在 设置 → 模型 API → 图像渠道 给 Gitee 预设填过 Key;② 一张首帧起始图 image_url(可先用 send_image 生成)。返回各段 file_url,下载后用剪映/FFmpeg 拼接(建议加轻微溶解转场)。",
			parameters: {
				type: "object",
				properties: {
					segments: {
						type: "array",
						description: "分镜脚本,按播放顺序排列,1-5 段",
						items: {
							type: "object",
							properties: {
								prompt: { type: "string", description: "本段画面+动作描述。强烈建议含『从上一段最后一帧无缝接续』及一致性锚点(同角色/同光线/同机位/同画风)" },
								negative_prompt: { type: "string", description: "可选,本段负面提示词" },
							},
							required: ["prompt"],
						},
					},
					image_url: { type: "string", description: "首帧起始图 URL(第一段的 image 输入)" },
					width: { type: "number", description: "可选,默认 832" },
					height: { type: "number", description: "可选,默认 480" },
					num_frames: { type: "number", description: "可选,默认 120(约 5 秒 @24fps)" },
					seed: { type: "number", description: "可选,固定种子增强跨段一致性" },
				},
				required: ["segments", "image_url"],
				additionalProperties: false,
			},
			async run(args, ctx) {
				ctx = ctx || {}
				const onEvent = typeof ctx.onEvent === "function" ? ctx.onEvent : function () {}
				const doc = global.document
				if (!doc) return { ok: false, error: "无 document,非浏览器环境,无法做视频接力" }
				let apiKey = ""
				try {
					// 视频接力固定走 Gitee Wan2.2：优先取内置 Gitee 渠道，再回落旧 Key（渠道迁移后旧键可能为空）
					const g = global.__imageChannels && global.__imageChannels.get ? global.__imageChannels.get("gitee") : null
					apiKey = ((g && g.key) || localStorage.getItem("cfw_image_key_v1") || localStorage.getItem("moark_api_key") || "").trim()
				} catch (e) {}
				if (!apiKey) return { ok: false, error: "未找到 Gitee API Key：请先到 设置 → 模型 API → 图像渠道 给 Gitee 预设填 Key（只存本机）" }
				// 设了访问密码的部署：/img/* 要求带应用登录态（X-Sync-Token）；Authorization 让给上游 Key
				let syncTok = ""
				try { syncTok = (localStorage.getItem("cfw_auth_token_v1") || "").trim() } catch (e) {}
				function authHdr(extra) {
					const h = Object.assign({ "Authorization": "Bearer " + apiKey }, extra || {})
					if (syncTok) h["X-Sync-Token"] = syncTok
					return h
				}
				const rawSegs = Array.isArray(args && args.segments) ? args.segments : []
				const segs = rawSegs.map(function (s) {
					if (!s || typeof s.prompt !== "string" || !s.prompt.trim()) return null
					return { prompt: s.prompt.trim(), negative_prompt: (s && typeof s.negative_prompt === "string") ? s.negative_prompt.trim() : "" }
				}).filter(Boolean)
				if (!segs.length) return { ok: false, error: "segments 至少要有一段带 prompt 的分镜" }
				if (segs.length > 5) return { ok: false, error: "分镜段数超上限:最多 5 段(单段约20分钟,封顶防失控),当前 " + segs.length + " 段,请合并精简" }
				const initUrl = args && typeof args.image_url === "string" ? args.image_url.trim() : ""
				if (!initUrl) return { ok: false, error: "缺少首帧起始图 image_url:可先用 send_image 生成一张再把其 url 传进来" }
				const width = Math.max(64, Math.min(2048, parseInt(args && args.width, 10) || 832))
				const height = Math.max(64, Math.min(2048, parseInt(args && args.height, 10) || 480))
				const numFrames = Math.max(1, Math.min(300, parseInt(args && args.num_frames, 10) || 120))
				const guidance = 5.0
				const steps = 30
				const seedInt = parseInt(args && args.seed, 10)
				const seed = Number.isFinite(seedInt) && seedInt >= 0 ? seedInt : null

				async function readJson(res) { const t = await res.text(); try { return JSON.parse(t) } catch (e) { return { _text: t } } }
				async function dlBlob(url) {
					const r = await fetch("/img/dl?url=" + encodeURIComponent(url), { headers: authHdr() })
					if (!r.ok) throw new Error("下载失败(" + r.status + ")")
					return await r.blob()
				}
				async function createTask(imageBlob, prompt, negPrompt) {
					function build(useTypo) {
						const fd = new FormData()
						fd.append("prompt", prompt)
						fd.append("model", "Wan2_2-I2V-A14B")
						fd.append("num_frames", String(numFrames))
						fd.append("guidance_scale", String(guidance))
						fd.append("height", String(height))
						fd.append("width", String(width))
						if (negPrompt) fd.append("negative_prompt", negPrompt)
						if (seed !== null) fd.append("seed", String(seed))
						fd.append(useTypo ? "num_inferenece_steps" : "num_inference_steps", String(steps))
						fd.append("image", imageBlob, "frame.png")
						return fd
					}
					const hdr = authHdr()
					let res = await fetch("/img/v1/async/videos/image-to-video", { method: "POST", headers: hdr, body: build(false) })
					let j = await readJson(res)
					if (res.ok && j.task_id) return j.task_id
					res = await fetch("/img/v1/async/videos/image-to-video", { method: "POST", headers: hdr, body: build(true) })
					j = await readJson(res)
					if (res.ok && j.task_id) return j.task_id
					throw new Error("创建任务失败(" + res.status + "): " + JSON.stringify(j).slice(0, 200))
				}
				async function pollTask(taskId) {
					const start = Date.now()
					while (Date.now() - start < 60 * 60 * 1000) {
						const res = await fetch("/img/v1/task/" + encodeURIComponent(taskId), { method: "GET", headers: authHdr() })
						const j = await readJson(res)
						const st = j.status || "unknown"
						if (st === "success" || st === "failed" || st === "cancelled") return { status: st, raw: j }
						await new Promise(function (r) { setTimeout(r, 8000) })
					}
					return { status: "timeout", raw: {} }
				}
				function extractLastFrame(videoBlob) {
					return new Promise(function (resolve, reject) {
						const url = URL.createObjectURL(videoBlob)
						const v = doc.createElement("video")
						v.preload = "auto"; v.muted = true; v.playsInline = true; v.src = url
						let done = false
						const fail = function (msg) { if (done) return; done = true; URL.revokeObjectURL(url); reject(new Error(msg)) }
						v.addEventListener("loadedmetadata", function () {
							const t = isFinite(v.duration) && v.duration > 0.1 ? v.duration - 0.05 : 0
							try { v.currentTime = t } catch (e) { fail("seek 失败: " + e.message) }
						})
						v.addEventListener("seeked", function () {
							if (done) return
							try {
								const c = doc.createElement("canvas")
								c.width = v.videoWidth || width
								c.height = v.videoHeight || height
								c.getContext("2d").drawImage(v, 0, 0, c.width, c.height)
								c.toBlob(function (b) { done = true; URL.revokeObjectURL(url); b ? resolve(b) : reject(new Error("canvas toBlob 返回空")) }, "image/png")
							} catch (e) { fail("尾帧提取失败(可能 canvas 被跨域污染): " + e.message) }
						})
						v.addEventListener("error", function () { fail("视频解码失败,无法提取尾帧") })
						setTimeout(function () { fail("尾帧提取超时(>60s)") }, 60000)
					})
				}

				const clips = []
				let curFrame
				try { onEvent({ type: "video_relay_start", total: segs.length }); curFrame = await dlBlob(initUrl) }
				catch (e) { return { ok: false, error: "首帧图下载失败: " + (e && e.message ? e.message : String(e)) } }
				for (let i = 0; i < segs.length; i++) {
					onEvent({ type: "video_relay_segment", index: i + 1, total: segs.length, phase: "submit" })
					let taskId
					try { taskId = await createTask(curFrame, segs[i].prompt, segs[i].negative_prompt) }
					catch (e) { return { ok: false, error: "第 " + (i + 1) + " 段创建失败: " + (e && e.message ? e.message : String(e)), clips } }
					onEvent({ type: "video_relay_segment", index: i + 1, total: segs.length, phase: "poll", taskId: taskId })
					const result = await pollTask(taskId)
					if (result.status !== "success") return { ok: false, error: "第 " + (i + 1) + " 段任务 " + result.status + "(task=" + taskId + ")", clips }
					const fileUrl = result.raw && result.raw.output && result.raw.output.file_url
					if (!fileUrl) return { ok: false, error: "第 " + (i + 1) + " 段成功但无 file_url", clips }
					clips.push({ index: i + 1, file_url: fileUrl, prompt: segs[i].prompt })
					onEvent({ type: "video_relay_segment", index: i + 1, total: segs.length, phase: "done", fileUrl: fileUrl })
					if (i < segs.length - 1) {
						try { const vblob = await dlBlob(fileUrl); curFrame = await extractLastFrame(vblob) }
						catch (e) { return { ok: false, error: "第 " + (i + 1) + " 段尾帧提取失败,接力中断: " + (e && e.message ? e.message : String(e)), clips } }
					}
				}
				onEvent({ type: "video_relay_done", total: clips.length })
				return { ok: true, count: clips.length, clips: clips, note: "已按尾帧接力串行生成 " + clips.length + " 段。各段 file_url 下载后用剪映/FFmpeg 拼接,建议加轻微溶解转场掩盖接缝。" }
			},
		})

		return registry
	}

	function buildRegistry(opts) {
		const kernel = global.AgentKernel
		if (!kernel || typeof kernel.createToolRegistry !== "function") {
			throw new Error("AgentKernel 未加载：请先引入 /shared/agent-kernel.js")
		}
		return defineTools(kernel.createToolRegistry(), opts)
	}

	global.OwnChatTools = { defineTools, buildRegistry }
})(typeof globalThis !== "undefined" ? globalThis : window)