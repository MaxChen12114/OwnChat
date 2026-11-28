// 10-image.js — 图片工具：send_image（自拍/场景图）。
// 由宿主 defineTools() 调用；define() 负责档位与多智能体闸门，片段只写 schema 与 run。
function defineImageTools(ctx) {
	const { define, imageTools } = ctx
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
			async run(args, ctx) {
				if (!imageTools) return { ok: false, error: "发图模块未加载（services/agent/tools/image/index.js）" }
				return imageTools.send(args, ctx)
			},
		})

}
