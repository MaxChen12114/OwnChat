// 40-data.js — 数据门面工具：角色卡 / 世界书 / 预设 / 技能 / 历史归档检索。
// 由宿主 defineTools() 调用；define() 负责档位与多智能体闸门，片段只写 schema 与 run。
function defineDataTools(ctx) {
	const { define, cardTools, skillTools, historyTools } = ctx
		define({
			name: "manage_character_card",
			destructive: (a) => !!a && a.action !== "list" && a.action !== "get", // list/get 只读
			description:
				"管理角色卡(提示词编辑器·角色页，存统一存储 chars 表，与左栏角色卡同一数据源)。" +
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
				if (!cardTools) return { ok: false, error: "数据门面工具未加载（services/tools/agent/cards/index.js）" }
				return cardTools.manageCharacterCard(args)
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
				if (!cardTools) return { ok: false, error: "数据门面工具未加载（services/tools/agent/cards/index.js）" }
				return cardTools.manageLorebook(args)
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
				if (!cardTools) return { ok: false, error: "数据门面工具未加载（services/tools/agent/cards/index.js）" }
				return cardTools.managePreset(args)
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
				if (!skillTools) return { ok: false, error: "技能工具未加载（services/tools/agent/skill/index.js）" }
				return skillTools.run(args)
			},
		})

		// T3-D 历史归档回捞：压缩把早期原文换成摘要 + seq 锚点，模型按锚点/关键词回查原文。
		// 只读、按当前会话隔离；数据面没连上时明确报错，不返回空命中冒充“没有”。
		define({
			name: "history_search",
			description:
				"检索当前会话的归档历史（被压缩替换掉的早期原文）。摘要有「原文 seq X-Y 在归档，可用 history_search 回捞」时，" +
				"按关键词或原句片段回捞；只搜当前会话，不会串到别的对话。返回 { ok, hits:[{seq,role,speaker,ts,text}] }。" +
				"没有命中不是失败（会话可能还没压缩过）。",
			parameters: {
				type: "object",
				properties: {
					query: { type: "string", description: "检索词 / 原句片段（中文子串可命中）" },
					limit: { type: "number", description: "返回条数，默认 5，最多 20" },
				},
				required: ["query"],
				additionalProperties: false,
			},
			async run(args, ctx) {
				if (!historyTools) return { ok: false, error: "历史归档工具未加载（services/tools/agent/history/index.js）" }
				return historyTools.historySearch(args, ctx)
			},
		})
}
