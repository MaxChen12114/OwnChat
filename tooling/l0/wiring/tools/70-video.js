// 70-video.js — 视频故事工具：generate_video_story（分镜/尾帧/轮询在服务层）。
// 由宿主 defineTools() 调用；define() 负责档位与多智能体闸门，片段只写 schema 与 run。
function defineVideoTools(ctx) {
	const { define, videoTools } = ctx
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
				if (!videoTools) return { ok: false, error: "视频接力工具未加载（services/tools/agent/video/index.js）" }
				return videoTools.run(args, ctx)
			},
		})
}
