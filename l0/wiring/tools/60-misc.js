// 60-misc.js — 杂项工具：费用 / 朗读 / 选项。
// 由宿主 defineTools() 调用；define() 负责档位与多智能体闸门，片段只写 schema 与 run。
function defineMiscTools(ctx) {
	const { define, costTools, speakTools, choicesTools } = ctx
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
				if (!costTools) return { ok: false, error: "计费模块未加载（services/tools/agent/cost/index.js）" }
				return costTools.query(args)
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
				if (!speakTools) return { ok: false, error: "朗读模块未加载（services/tools/agent/speak/index.js）" }
				return speakTools.run(args)
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
				if (!choicesTools) return { ok: false, error: "选项工具未加载（services/tools/agent/choices/index.js）" }
				return choicesTools.run(args)
			},
		})

		// 4.x 导演接力:全自动多段 I2V 接力生成连贯长视频(上段尾帧→下段起始图)。
		// 复用图像工坊已验证的 Gitee Wan2_2-I2V-A14B 接口(/img 同源代理)+ 浏览器端 canvas 提尾帧。
		// 串行,单段约20分钟,最多5段;全程标签页不能关。需先给图像渠道的 Gitee 预设填 Key。
}
