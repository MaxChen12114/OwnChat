// 20-character.js — 角色好感工具：adjust_affinity。
// 由宿主 defineTools() 调用；define() 负责档位与多智能体闸门，片段只写 schema 与 run。
function defineCharacterTools(ctx) {
	const { define, characterTools } = ctx
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
				if (!characterTools) return { ok: false, error: "好感工具未加载（services/tools/agent/character/index.js）" }
				return characterTools.adjustAffinity(args)
			},
		})

		// 2026-09-14:原 write_file(只弹下载/保存框,文件不落地、模型读不回来)已删除,
		// 由 data/agent-workspace.js 的 write_file(写工作区,可 read_file 读回)+ export_file(落盘)取代。
}
