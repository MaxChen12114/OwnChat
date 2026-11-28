// 30-agent.js — 多智能体编排工具：delegate / whisper / convene / invite（闸门由 define() 统一裁）。
// 由宿主 defineTools() 调用；define() 负责档位与多智能体闸门，片段只写 schema 与 run。
function defineAgentTools(ctx) {
	const { define } = ctx
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
				// The recursion policy lives in services/tools/agent/subagent: the depth ceiling, the
				// child's least-privilege set, the reach registration, the event pair and the error
				// normalisation. This body only declares the schema and forwards.
				const sub = typeof global.createSubagent === "function"
					? global.createSubagent({
						buildRegistry: buildRegistry,
						kernel: function () { return global.AgentKernel || null },
						reach: function () { return global.AgentReach || null },
					})
					: null
				if (!sub) return { ok: false, error: "子 agent 模块未加载（services/agent/subagent.js）" }
				return sub.run(Object.assign({}, ctx || {}, {
					role: args.role,
					task: args.task,
					parentRegistry: registry,
					onImage: opts && opts.onImage,
				}))
			},
		})

		// 2026-11-09：群聊私有耳语。让「每个角色知道的不一样」成为可能。

		define({
			name: "whisper",
			destructive: false,
			description:
				"群聊里的私有耳语：只让**某一个角色**知道某件事，其他角色、其他 agent 都看不到。\n" +
				"用来制造信息差 —— 某人知道自家西墙塌了而别人不知道、某个角色收到密令而别人不知道。\n" +
				"这样各角色后来的发言才会基于不同信息，而不是同一份日志换人设。\n" +
				"什么时候用：多智能体推演里给某一方发私有情报；群里只想让某一个人知道的事。",
			parameters: {
				type: "object",
				properties: {
					to: { type: "string", description: "角色名（已保存的角色卡）" },
					text: { type: "string", description: "只给它看的内容" },
				},
				required: ["to", "text"],
				additionalProperties: false,
			},
			run: async (args) => {
				const app = global.appSvc
				if (!app || typeof app.whisperTo !== "function") return { ok: false, error: "私有通道未接线（app.js 未提供 whisperTo）" }
				try { return app.whisperTo(args || {}) } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
			},
		});

		// 2026-10-08 编排工具②「私开小会」：多位角色并行独立作答，结论回主 agent、不进时间线。
		// 参与者用**本人档案 + 自己的独立上下文**（见 app.js runPeerMeeting / selectSpeakerView）。

		define({
			name: "convene_meeting",
			destructive: true, // 每位参与者都是一次真实计费调用 → 走权限卡（成本闸门）
			description:
				"把若干角色**作为彼此独立的 agent** 叫到一起：每人一张自己的角色卡、各自独立的知识库，" +
				"并行各调用一次模型，就议题各自给出结论/决策；结果回给你（不进聊天时间线）。\n" +
				"默认 context=isolated：每位参与者**只看得到你写的议题/简报 + 自己的角色卡 + 自己知识库命中的段落**，" +
				"看不到聊天记录、也看不到别人说了什么（第二轮才互评）。把议题写全：共用规则、局面、可选项。\n" +
				"context=chat 才会把群聊历史（按本人视角投影）喂进去 —— 那是接着群聊说话，不是开会。\n" +
				"**这是「让角色自己拿主意」的唯一正确通道。** 不要在一个上下文里替多个角色分别思考，" +
				"那不是多智能体，是一个模型分饰多角（自导自演），角色卡等于白建。\n" +
				"过程可见：右栏「多智能体讨论区」逐条显示每位 agent 的发言（stage_list 里能看到它；" +
				"用 stage_open 打开 /tools/council/ 即可，讨论进行中会实时推进去）。\n" +
				"这是**结构化评审**：第 1 轮每人必须给立场（赞成/反对/有条件）+ 关键假设 + 失败路径 + 最优解门槛，" +
				"其中一人被指定为挑剔审查者（以稳定/正确/高效/优质同时最优为门槛质疑，不要求更便宜的替代）；" +
				"rounds=2 时第 2 轮由提案人先逐条回应质疑（可反驳/修改），其他人必须让步或坚持。要拍板的决策建议 rounds=2。",
			parameters: {
				type: "object",
				properties: {
					topic: { type: "string", description: "议题 / 要问的问题（写清背景与期望产出）" },
					participants: { type: "array", items: { type: "string" }, description: "参与者名字（已保存的角色卡名）。省略 = 场景成员；一个角色都没有时退回通用视角" },
					agenda: { type: "array", items: { type: "object", properties: { who: { type: "string", description: "参与者名字（可省，按顺序对应）" }, aspect: { type: "string", description: "该参与者负责的方面，如 架构 / 成本 / 风险" } }, required: ["aspect"] }, description: "可选：多方多主题 —— 给每位参与者指定负责的方面" },
					rounds: { type: "number", description: "1（默认：各答各的，仍有立场与反方）或 2（复核轮：看到彼此答案后必须让步/坚持；要拍板建议传 2）" },
					context: { type: "string", enum: ["isolated", "chat"], description: "默认 isolated：只喂议题+本人角色卡+本人知识库（真独立）。chat：投影群聊历史（接着聊天，不是开会）" },
				},
				required: ["topic"],
			},
			async run(args, ctx) {
				const app = global.appSvc
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
					loop: { type: "boolean", description: "可选：true=让这个角色以 agent 形态上台（能自己调工具查证，最多 3 轮）；false=单次调用。不传则跟随「Agent 模式」开关" },
				},
				required: ["name"],
			},
			async run(args, ctx) {
				const app = global.appSvc
				if (!app || typeof app.inviteCharacterToTimeline !== "function") {
					return { ok: false, error: "多智能体未接线（app.js 未提供 inviteCharacterToTimeline）" }
				}
				return await app.inviteCharacterToTimeline(Object.assign({}, args || {}, { onEvent: (ctx && ctx.onEvent) || function () {} }))
			},
		})

}
