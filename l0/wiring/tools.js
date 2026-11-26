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