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
