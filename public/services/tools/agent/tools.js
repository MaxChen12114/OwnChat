(function () {
/**
 * Tool-catalogue policy: which tool families are visible per profile and which orchestration tools
 * need the multi-agent gate.
 *
 * The tools bundle used to carry these lists inline. Three separate consumers depend on them — the
 * settings dropdown (`cfw_agent_tools_v1`), `buildRegistry({ profile })`, and the kernel's sub-agent
 * fork — so a single source is what keeps "what this profile can see" from drifting between them.
 * The bundle still owns every schema and forward; this module owns only the lists and the predicate.
 *
 * @module services/tools/agent/tools
 */

/** Storage keys read by the bundle; the literals are shared with the settings card. */
const AGENT_TOOLS_KEY = "cfw_agent_tools_v1";
const MULTI_AGENT_MODE_KEY = "tavern_multi_agent_mode_v1";

/** Default profile: the tools used every day. */
const CORE_TOOLS                    = [
  "offer_choices", "load_skill",
  "manage_character_card", "send_image", "adjust_affinity", "speak",
  // T3-D: compaction replaces early text with a summary + seq anchor; this is the way back.
  "history_search",
  // Orchestration tools are in core, but still need the multi-agent gate below.
  "delegate_to_agent", "convene_meeting", "invite_character",
];

/** Sub-agents reuse the parent registry; only the orchestration tools are filtered, never this list. */
const SUB_TOOLS                    = ["load_skill"];

/** Character agents on stage: read-only tools, canvas and whisper; no writes, no orchestration. */
const CHAR_TOOLS                    = [
  "load_skill",
  "read_file", "search_file", "list_files", "list_source", "read_source", "search_source",
  "local_list_dir", "local_read_file",
  "stage_list", "stage_view", "stage_call",
  "whisper", "send_image",
];

/** Orchestration tool -> its settings switch. Absence of the key means ON. */
const MA_GATED                                   = {
  delegate_to_agent: "cfw_ma_delegate_v1",
  convene_meeting: "cfw_ma_meeting_v1",
  invite_character: "cfw_ma_invite_v1",
};

/**
 * Decide the effective profile. An explicit `opts.profile` wins; otherwise the stored dropdown
 * value; otherwise `core`. Unknown stored values fall back to `core` at the allow-list step.
 *
 * @param requested - `opts.profile` from the caller, if any.
 * @param stored - `cfw_agent_tools_v1`, already read by the bundle.
 * @returns The profile name.
 */
function resolveProfile(requested         , stored         )         {
  if (typeof requested === "string" && requested) return requested;
  if (typeof stored === "string" && stored) return stored;
  return "core";
}

/**
 * @param profile - Resolved profile.
 * @param name - Tool name from the definition.
 * @returns Whether the profile's allow-list includes it; `full` and `sub` allow everything.
 */
function allowedFor(profile        , name         )          {
  if (profile === "full" || profile === "sub") return true;
  const list = profile === "char" ? CHAR_TOOLS : CORE_TOOLS;
  return typeof name === "string" && list.indexOf(name) >= 0;
}

/** @returns The settings key gating this tool, or null when it is not orchestration. */
function maGateKey(name         )                {
  if (typeof name !== "string") return null;
  return Object.prototype.hasOwnProperty.call(MA_GATED, name) ? MA_GATED[name] : null;
}

/** @returns True when the sidebar mode is the literal `multi`. */
function maModeOn(raw         )          {
  return raw === "multi";
}

/** @returns The per-tool switch; a missing value means ON. */
function maFlagOn(raw         )          {
  return raw == null ? true : raw === "1";
}

/**
 * @param profile - Resolved profile; `sub` never gets orchestration tools (recursion guard).
 * @param modeRaw - Stored sidebar mode.
 * @param flagRaw - Stored per-tool switch.
 * @returns Whether the orchestration tool may be registered.
 */
function maEnabled(profile        , modeRaw         , flagRaw         )          {
  return profile !== "sub" && maModeOn(modeRaw) && maFlagOn(flagRaw);
}

/* l0-wiring-part: opens the shared IIFE; parsed as part of public/services/tools/agent/tools.js */
/**
 * l0/wiring/tools/00-core.js — tools 产品的外壳：IIFE、DOM 元素收窄助手。
 *
 * 2026-11-26 拆件：原 682 行 tools.js 按工具域拆成 7 个 schema 片段 + 本外壳 + 宿主。
 * 所有片段仍由 l0/emit.mjs 按顺序拼进同一个产物，闭包共享，不新增任何全局。
 */
(function (global) {
	"use strict"

	// @ts-check: getElementById 只返回 HTMLElement，而下面三处要读 <select>/<button>/<input> 的
	// 专属属性。这里按真实标签类型收窄（运行时校验，不是类型断言）：元素缺失或标签不符时按
	// 「元素不存在」走已有的分支，不再静默读到 undefined / 抛 TypeError。
	function asSelect(el) { return el instanceof HTMLSelectElement ? el : null }
	function asButton(el) { return el instanceof HTMLButtonElement ? el : null }
	function asCheckbox(el) { return el instanceof HTMLInputElement ? el : null }

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
				"用 stage_open 打开 /tools/council/ 即可，讨论进行中会实时推进去）。",
			parameters: {
				type: "object",
				properties: {
					topic: { type: "string", description: "议题 / 要问的问题（写清背景与期望产出）" },
					participants: { type: "array", items: { type: "string" }, description: "参与者名字（已保存的角色卡名）。省略 = 场景成员；一个角色都没有时退回通用视角" },
					agenda: { type: "array", items: { type: "object", properties: { who: { type: "string", description: "参与者名字（可省，按顺序对应）" }, aspect: { type: "string", description: "该参与者负责的方面，如 架构 / 成本 / 风险" } }, required: ["aspect"] }, description: "可选：多方多主题 —— 给每位参与者指定负责的方面" },
					rounds: { type: "number", description: "1（默认，各答各的、彼此不可见）或 2（第二轮能看到彼此答案、互相补充或反驳）" },
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

// 50-settings.js — 设置与模型工具：主题、模型、设置、编辑器。
// 由宿主 defineTools() 调用；define() 负责档位与多智能体闸门，片段只写 schema 与 run。
function defineSettingsTools(ctx) {
	const { define, themeTools } = ctx
		define({
			name: "set_theme",
			destructive: true, // 改全局外观
			description:
				"切换界面主题外观(设置·外观风格)。style: minimal(极简) / glass(玻璃) / candle(烛夜私语) / ;scheme: dark(暗) / light(亮)。两者都可选,只传需要改的项。(2026-10-06: 主题与 NSFW 等级无联动；cfw_nsfw_mode_v1 只服务图像侧与主题伪装联动。)",
			parameters: {
				type: "object",
				properties: {
					style: { type: "string", enum: ["minimal", "glass", "candle"], description: "主题风格,可选" },
					scheme: { type: "string", enum: ["dark", "light"], description: "明暗,可选" },
				},
			},
			async run(args) {
				if (!themeTools) return { ok: false, error: "主题工具未加载（services/tools/agent/theme/index.js）" }
				return themeTools.setTheme(args)
			},
		})

		// D3 decision (2026-11-25): stays in this bundle — the tool's real logic is DOM timing
		// (#modeToggle click → one tick → #modelSel options), not a portable rule.

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
				const sel = asSelect(doc.getElementById("modelSel"))
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

		// D3 decision (2026-11-25): stays in this bundle — five keys read/written through `devSvc`,
		// two DOM clicks and a checkbox change are the operation itself; there is no rule to lift.

		define({
			name: "manage_settings",
			destructive: (a) => !!a && a.action !== "get" && a.action !== "list",
			description:
				"读写常用对话设置开关。action=get 读当前全部;action=set 改一项(需 key + value)。" +
				// 2026-09-10: 删掉 strictRoleplay / nsfwLevel 两个 key —— 尺度已改为私人模式锁态派生(见 unlock.js / worker.js),
				// 再让 agent 写 cfw_nsfw_mode_v1 只会与锁态打架(写了也不生效,而且下次刷新就被覆写)。
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
				const dev = global.devSvc
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
							const tt = doc && asButton(doc.getElementById("thinkToggle"))
							const cur = lsGet("cfw_thinking", "0") === "1"
							if (tt && !tt.disabled && cur !== want) tt.click() // 内存态 thinkingOn 仅由 #thinkToggle 翻转;仅快速档可用
							else lsSet("cfw_thinking", want ? "1" : "0")
							break
						}
						case "syncChat": {
							const want = asBool(val)
							lsSet("cfw_sync_include_chat_v1", want ? "1" : "0")
							const sc = doc && asCheckbox(doc.getElementById("syncIncludeChatToggle"))
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

		// D3 decision (2026-11-25): stays in this bundle — one facade call plus error wrapping.

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

}

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

/* l0-wiring-part: closes the shared IIFE; parsed as part of public/services/tools/agent/tools.js */
/**
 * l0/wiring/tools.js — browser wiring host for services/tools/agent/tools.ts
 *
 * 2026-11-26 拆件：schema 按域在 l0/wiring/tools/*.js（10-image / 20-character / 30-agent /
 * 40-data / 50-settings / 60-misc / 70-video）；本文件只保留实例装配、档位闸门、define()
 * 与调用顺序。所有片段由 l0/emit.mjs 按 WIRING_PARTS 顺序拼进同一产物，闭包共享，零新全局。
 */
	function defineTools(registry, opts) {
		opts = opts || {}
		const onImage = opts.onImage // (url, meta) => void：把图渲染进对话气泡

		// Image generation lives in services/agent/tools/image: the facade lookup, the 150s ceiling and
		// the result shape. This bundle owns both inputs, so it builds the instance once and the tool
		// body only forwards.
		const imageTools = typeof global.createImageTools === "function"
			? global.createImageTools({
				chatImage: function () { return global.chatImageSvc || null },
				onImage: onImage,
			})
			: null

		// Cost and speech: the answer shapes (which book, and whether silence is a failure) live in
		// services/tools/agent/{cost,speak}. Both inputs are owned here.
		const costTools = typeof global.createCostTools === "function"
			? global.createCostTools({
				cost: function () { return global.costSvc || null },
				mode: function () {
					try { return (typeof localStorage !== "undefined" && localStorage.getItem("cfw_mode")) || "" } catch (e) { return "" }
				},
			})
			: null
		const speakTools = typeof global.createSpeakTools === "function"
			? global.createSpeakTools({ tts: function () { return global.omniTtsSvc || null } })
			: null
		const skillTools = typeof global.createSkillTools === "function"
			? global.createSkillTools({ skills: function () { return global.skillsSvc || null } })
			: null
		const choicesTools = typeof global.createChoicesTools === "function"
			? global.createChoicesTools({ choices: function () { return global.choicesSvc || null } })
			: null
		const characterTools = typeof global.createCharacterTools === "function"
			? global.createCharacterTools({ character: function () { return global.characterSvc || null } })
			: null
		// Data-facade tools (2026-11-25): character-card / lorebook / preset CRUD, merges and error
		// strings live in services/tools/agent/cards. The stores and the active-id read are owned here.
		const cardTools = typeof global.createCardTools === "function"
			? global.createCardTools({
				character: function () { return global.characterSvc || null },
				lorebook: function () { return global.lorebookSvc || null },
				presetStore: function () { return global.presetStore || null },
				readActiveCardId: function () {
					try { return (typeof localStorage !== "undefined" && localStorage.getItem("tavern_active_char_id")) || "" } catch (e) { return "" }
				},
			})
			: null
		// Theme tool (2026-11-25): the style whitelist, scheme literals and empty-patch rejection live
		// in services/tools/agent/theme; this bundle owns the facade lookup.
		const themeTools = typeof global.createThemeTools === "function"
			? global.createThemeTools({ theme: function () { return global.themeSvc || null } })
			: null
		// History archive search (T3-D, 2026-11-28): `history_search` reads the `messages` projection
		// through the same DbPort search the data plane exposes; the active conversation is the
		// fallback when a tool call has no kernel `__convId`.
		const historyTools = typeof global.createHistoryTools === "function"
			? global.createHistoryTools({
				search: function (convId, q, limit) {
					const db = global.dbSvc
					if (!db || typeof db.search !== "function") return Promise.reject(new Error("dbSvc 未加载"))
					return db.search("messages", { conv: convId }, q, limit)
				},
				activeConvId: function () {
					try { return (global.appSvc && global.appSvc.getActiveConvId) ? global.appSvc.getActiveConvId() : "" } catch (e) { return "" }
				},
			})
			: null
		// Video story relay (2026-11-25): the 1-5 segment cap, tail-frame relay, Gitee key fallback,
		// per-segment fetch/poll and error wording live in services/tools/agent/video. This bundle owns
		// every host input (document, storage, channels, fetch, the event renderer and the DOM
		// factories), so the instance is built once and the tool body only forwards.
		const videoTools = typeof global.createVideoStoryTools === "function"
			? global.createVideoStoryTools({
				document: function () { return global.document || null },
				storage: function () {
					try { return typeof localStorage !== "undefined" ? localStorage : null } catch (e) { return null }
				},
				channels: function () { return global.imageChannelsSvc || null },
				fetch: function (url, init) { return fetch(url, init) },
				onEvent: function (ev, ctx) {
					const c = ctx || {}
					if (typeof c.onEvent === "function") c.onEvent(ev)
				},
				formData: function () { return new FormData() },
				objectUrl: {
					create: function (b) { return URL.createObjectURL(b) },
					revoke: function (u) { URL.revokeObjectURL(u) },
				},
			})
			: null
		// Presets: the one data store (services/data/presets.ts) owns load/save/uid/order and the sync
		// nudge on save. `cardTools` looks the facade up per call, so a late mount still works.

		// ── 工具集分档与多智能体闸门 ──────────────────────────────
		// 2026-11-25 D5：core/full/char/sub 四档名单、多智能体键与判定归
		// services/tools/agent/tools.ts（与本接线同一产物）。这里只读 localStorage 并调用 gate；
		// 名单的单一来源使设置下拉、buildRegistry({profile}) 与内核 fork 三处不再各写一遍。
		function readStored(key) { try { return localStorage.getItem(key) } catch (e) { return null } }
		let _profile = resolveProfile(opts.profile, readStored(AGENT_TOOLS_KEY))
		const _realDefine = registry.define.bind(registry)
		// 多智能体编排的分层开关：① 侧栏模式非 multi → 不注册；② 再按各功能设置开关；
		// 子 agent 档（sub）永不注册编排工具 —— 防递归的第一道闸。
		function _maEnabled(k) { return maEnabled(_profile, readStored(MULTI_AGENT_MODE_KEY), readStored(k)) }
		function define(def) {
			const name = def && def.name
			if (!allowedFor(_profile, name)) return registry
			const gate = maGateKey(name)
			if (gate && !_maEnabled(gate)) return registry
			return _realDefine(def)
		}
		// 工具组按原注册顺序调用；每组只拿到自己需要的实例，闸门仍由上面的 define() 统一裁。
		const ctx = { define, global, imageTools, costTools, speakTools, skillTools, choicesTools, characterTools, cardTools, themeTools, videoTools, historyTools }
		defineImageTools(ctx)
		defineCharacterTools(ctx)
		defineAgentTools(ctx)
		defineDataTools(ctx)
		defineSettingsTools(ctx)
		defineMiscTools(ctx)
		defineVideoTools(ctx)

		return registry
	}

	function buildRegistry(opts) {
		const kernel = global.AgentKernel
		if (!kernel || typeof kernel.createToolRegistry !== "function") {
			throw new Error("AgentKernel 未加载：请先引入 /shared/agent/agent-kernel.js")
		}
		return defineTools(kernel.createToolRegistry(), opts)
	}

	global.OwnChatTools = { defineTools, buildRegistry }
})(typeof globalThis !== "undefined" ? globalThis : window)

globalThis.AGENT_TOOLS_KEY = AGENT_TOOLS_KEY;
globalThis.MULTI_AGENT_MODE_KEY = MULTI_AGENT_MODE_KEY;
globalThis.CORE_TOOLS = CORE_TOOLS;
globalThis.SUB_TOOLS = SUB_TOOLS;
globalThis.CHAR_TOOLS = CHAR_TOOLS;
globalThis.MA_GATED = MA_GATED;
globalThis.resolveProfile = resolveProfile;
globalThis.allowedFor = allowedFor;
globalThis.maGateKey = maGateKey;
globalThis.maModeOn = maModeOn;
globalThis.maFlagOn = maFlagOn;
globalThis.maEnabled = maEnabled;
})();
