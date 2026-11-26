/**
 * l0/wiring/agent-console.js — browser wiring for services/ui/agent-console.ts
 *
 * The console is a dev-only panel: a status header, a tool timeline and inline permission cards.
 * Event-to-status decisions, formatting, the compat permission signature and the write_file card
 * shape live in the service; this file owns the elements, styles, timers and permission promises.
 *
 * Uses the agent kernel's runAgentLoop onEvent contract. The frozen entry is globalThis.mountAgentConsole.
 */

const SVG = {
	spin:   `<svg class="ac-spin" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 1.5 A5.5 5.5 0 1 1 1.5 7" stroke-linecap="round"/></svg>`,
	check:  `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="2.5,7.5 5.5,10.5 11.5,4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
	cross:  `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="3.5" y1="3.5" x2="10.5" y2="10.5" stroke-linecap="round"/><line x1="10.5" y1="3.5" x2="3.5" y2="10.5" stroke-linecap="round"/></svg>`,
	denied: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="7" cy="7" r="5"/><line x1="3.5" y1="3.5" x2="10.5" y2="10.5"/></svg>`,
	caret:  `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6"><polyline points="3,2 7,5 3,8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
	sub:    `<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="4,3 4,11 12,11"/><polyline points="9,8 12,11 9,14"/></svg>`,
}

function el(tag, cls) {
	const e = document.createElement(tag)
	if (cls) e.className = cls
	return e
}

function mountAgentConsole(container, opts = {}) {
	const { autoApprove = false, onStop } = opts
	const root = typeof container === "string" ? document.querySelector(container) : container
	if (!root) throw new Error("[agent-console] 容器不存在")
	injectStylesOnce()
	root.classList.add("agent-console")
	root.innerHTML = ""

	// ① 顶部状态头
	const header = el("div", "ac-header")
	const dot = el("span", "ac-dot")
	const statusLabel = el("span", "ac-status-label")
	const time = el("span", "ac-time")
	header.append(dot, statusLabel, time)
	if (typeof onStop === "function") {
		const stopBtn = el("button", "ac-stop")
		stopBtn.type = "button"
		stopBtn.textContent = "停止"
		stopBtn.onclick = () => {
			// 2026-10-08: 停止必须先解掉未决的「等待放行」卡 —— 否则内核循环挂在那个 Promise 上，
			// 怎么 abort 都收不了尾（这就是"停止后输入框发不出消息"的锁）。
			cancelPending("已中断")
			try { onStop() } catch {}
			stopBtn.disabled = true
			setStatus("warn", "已请求停止")
			stopClock()
		}
		header.append(stopBtn)
	}
	root.append(header)

	// ② 步骤时间线
	const timeline = el("div", "ac-timeline")
	root.append(timeline)


	let depth = 0
	let round = 0
	let startTs = 0
	let clockTimer = null
	const pending = new Map() // name -> rec[]（同名工具按调用先后配对 done/error）
	// 2026-10-08: 未决的「等待放行」卡集合 —— 每张卡的 resolve 都必须可被外部解掉
	// （停止/重试/删除/清空），否则 agent 循环会永远等在那里。见 cancelPending。
	const pendingPerms = new Set()

	setStatus("idle", "待命")

	function setStatus(kind, label) {
		dot.className = "ac-dot ac-dot--" + kind
		statusLabel.textContent = label
	}
	function startClock() {
		if (startTs) return
		startTs = Date.now()
		updateClock()
		clockTimer = setInterval(updateClock, 1000)
	}
	function stopClock() {
		if (clockTimer) { clearInterval(clockTimer); clockTimer = null }
	}
	function updateClock() {
		if (!startTs) return
		const s = Math.floor((Date.now() - startTs) / 1000)
		time.textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0")
	}
	function scrollIntoView() {
		const last = timeline.lastElementChild
		if (last && last.scrollIntoView) last.scrollIntoView({ block: "nearest" })
	}

	function addRound(n) {
		const r = el("div", "ac-round")
		r.textContent = roundLabel(n)
		timeline.append(r)
		scrollIntoView()
	}

	function addToolStep(name, args) {
		const step = el("div", "ac-step ac-step--running")
		const head = el("div", "ac-step__head")
		const icon = el("span", "ac-step__icon"); icon.innerHTML = SVG.spin
		const nm = el("span", "ac-step__name"); nm.textContent = name || "工具"
		const dur = el("span", "ac-step__dur"); dur.textContent = "运行中"
		head.append(icon, nm, dur)

		// write_file：专用文件卡（文件名显眼 + 内容可展开）
		if (name === "write_file" && args) {
			const info = writeFileInfo(args)
			const fp = info.path
			const content = info.content
			nm.textContent = fp  // 文件名替代工具名
			const caret = el("span", "ac-step__caret"); caret.innerHTML = SVG.caret
			head.append(caret)
			step.classList.add("ac-step--has-body")
			const body = el("div", "ac-step__body")
			const pre = document.createElement("pre")
			pre.style.cssText = "max-height:320px;overflow:auto;"
			pre.textContent = content || "（无内容）"
			body.append(pre)
			step.append(head, body)
			head.onclick = () => step.classList.toggle("is-open")
		} else {
			const hasBody = args && Object.keys(args).length > 0
			if (hasBody) {
				const caret = el("span", "ac-step__caret"); caret.innerHTML = SVG.caret
				head.append(caret)
				step.classList.add("ac-step--has-body")
				const body = el("div", "ac-step__body")
				const pre = document.createElement("pre"); pre.textContent = pretty(args)
				body.append(pre)
				step.append(head, body)
				head.onclick = () => step.classList.toggle("is-open")
			} else {
				step.append(head)
			}
		}
		timeline.append(step)
		scrollIntoView()
		const rec = { step, head, icon, dur, start: Date.now() }
		if (!pending.has(name)) pending.set(name, [])
		pending.get(name).push(rec)
		return rec
	}

	function finishToolStep(name, status, errMsg) {
		const arr = pending.get(name)
		const rec = arr && arr.shift()
		if (!rec) return
		const ms = Date.now() - rec.start
		rec.step.classList.remove("ac-step--running")
		rec.step.classList.add("ac-step--" + status)
		rec.icon.innerHTML = status === "done" ? SVG.check : status === "error" ? SVG.cross : SVG.denied
		rec.dur.textContent = status === "denied" ? "已拒绝" : fmtMs(ms)
		if (status === "error" && errMsg) {
			let body = rec.step.querySelector(".ac-step__body")
			if (!body) {
				rec.step.classList.add("ac-step--has-body")
				if (!rec.head.querySelector(".ac-step__caret")) {
					const caret = el("span", "ac-step__caret"); caret.innerHTML = SVG.caret
					rec.head.append(caret)
				}
				body = el("div", "ac-step__body")
				rec.step.append(body)
				rec.head.onclick = () => rec.step.classList.toggle("is-open")
			}
			const pre = document.createElement("pre"); pre.className = "ac-step__err"; pre.textContent = String(errMsg)
			body.append(pre)
			rec.step.classList.add("is-open")
		}
		scrollIntoView()
	}

	function addSubagent(label) {
		const s = el("div", "ac-sub")
		s.style.marginLeft = depth * 12 + "px"
		const ic = el("span", "ac-sub__icon"); ic.innerHTML = SVG.sub
		const t = el("span"); t.textContent = " " + label
		s.append(ic, t)
		timeline.append(s)
		scrollIntoView()
	}


	function onEvent(ev) {
		if (!ev || !ev.type) return
		const plan = eventPlan(ev)
		if (!plan) return
		if (plan.startClock) startClock()
		if (plan.round) { round = plan.round; addRound(round) }
		if (plan.status) setStatus(plan.status.kind, plan.status.label)
		if (plan.tool) {
			if (plan.tool.phase === "run") addToolStep(plan.tool.name, plan.tool.args)
			else finishToolStep(plan.tool.name, plan.tool.phase, plan.tool.message)
		}
		if (plan.subagent) {
			if (plan.subagent.starting) depth++
			addSubagent(plan.subagent.label)
			if (!plan.subagent.starting) depth = Math.max(0, depth - 1)
		}
		if (plan.stopClock) stopClock()
	}

	// 2026-11-15 修（手机端「放行弹窗选完不消失」）：
	//   放行卡以前是「决策后把按钮换成一行灰字、卡片永久留在时间线」，手机端又为了让人
	//   看见卡片会自动顶起 Agent 面板（壳下是控制台抽屉），却没有任何收起逻辑 —— 于是
	//   点完「放行/拒绝」后那个「弹窗」还杵在屏幕上。现在两件事一起收：
	//     ① 卡片给出短暂结果反馈后淡出移除（审计痕迹仍在状态条 + agent-steps 的步骤块）；
	//     ② 只对「由待放行请求自动顶起」的面板/抽屉自动收起，用户自己打开的不动。
	//   ③ 手机壳不直接读壳的全局对象（会引入类型逃逸）：改用两个自定义事件，
	//      「谁顶起面板谁收起」由壳自己记账，跨模块只走显式契约。
	let autoSurface = null // { kind:'mobile'|'desktop', tab?, prev? } | null

	function inShell() {
		try { return document.documentElement.classList.contains('shell-mobile') } catch (e) { return false }
	}

	// 2026-11-10: 权限卡只进右栏「活动」/手机底部 Agent 面板。手机端 Agent 模式默认不激活面板，
	// 用户只看到聊天一直转圈，以为 agent "有眼没手"。有待放行请求时把面板顶上来。
	function surfacePending() {
		try {
			if (inShell()) { window.dispatchEvent(new CustomEvent('cfw:perm-pending')); return }
			const isMobile = window.matchMedia && window.matchMedia('(max-width: 1023px)').matches
			if (isMobile) {
				// ?shell=off / 旧四 tab：面板本来由 mobile-tabs.js 的 .active 控制
				const tab = document.getElementById('mobileAgentTab')
				const panel = document.getElementById('mobileTabPanel-agent')
				if (tab && !tab.disabled) {
					if (!autoSurface && panel && !panel.classList.contains('active')) autoSurface = { kind: 'mobile', tab }
					if (!tab.classList.contains('active')) tab.click()
					return
				}
			} else {
				const act = document.querySelector('#rightSidebar .rs-tab.active')
				const rsFound = document.querySelector('#rightSidebar .rs-tab[data-rs-tab="fishbowl"]')
				const rsTab = rsFound instanceof HTMLElement ? rsFound : null
				if (rsTab && !rsTab.classList.contains('active')) {
					if (!autoSurface) autoSurface = { kind: 'desktop', prev: act }
					rsTab.click()
				}
			}
		} catch (e) {}
	}

	/** 决策完毕、且没有其它待决卡时，收起这次自动顶起的视图 */
	function dismissSurface() {
		if (pendingPerms.size > 0) return   // 还有卡等人点，别把面板抽走
		try { window.dispatchEvent(new CustomEvent('cfw:perm-resolved')) } catch (e) {}
		const s = autoSurface
		autoSurface = null
		if (!s) return
		try {
			if (s.kind === 'mobile') {
				if (s.tab) s.tab.classList.remove('active')
				const panel = document.getElementById('mobileTabPanel-agent')
				if (panel) panel.classList.remove('active')
			} else if (s.kind === 'desktop') {
				const act = document.querySelector('#rightSidebar .rs-tab.active')
				// 只在我们仍停在「活动」栏时还原；用户中途手动切走就不打扰
				if (s.prev && s.prev.isConnected && act && act.getAttribute('data-rs-tab') === 'fishbowl' && act !== s.prev) s.prev.click()
			}
		} catch (e) {}
	}

	/** 卡片给一瞬结果反馈后淡出移除；不写业务状态，审计由状态条/步骤块负责 */
	function retireCard(card, holdMs) {
		setTimeout(function () {
			if (!card.isConnected) return
			card.classList.add('is-leaving')
			setTimeout(function () { if (card.isConnected) card.remove() }, 180)
		}, holdMs)
	}

	// 修复：kernel 以 (name, args) 两个位置参数调用；兼容旧的 ({name,args}) 单对象签名
	async function ensurePermission(a, b) {
		const perm = normalizePermissionArgs(a, b)
		const name = perm.name
		const args = perm.args
		setStatus("perm", "等待放行 · " + name)
		if (autoApprove) { addPermCard(name, args, null, true); return true }
		return await new Promise((resolve) => {
			// 2026-10-08: 登记这张卡的出口 —— 旧版这个 Promise 只能靠用户点「放行/拒绝」，
			// 没有任何取消路径；加上内核的取消竞速（agent-kernel.js raceWithAbort）后，
			// 停止/重试/删除会先 cancelPending 把它解成"拒绝"，循环才能收尾。
			const rec = { name, resolve: null, done: null }
			rec.resolve = (ok) => { pendingPerms.delete(rec); resolve(ok) }
			pendingPerms.add(rec)
			addPermCard(name, args, rec.resolve, false, rec)
		})
	}

	/** 解掉所有未决的「等待放行」卡（resolve(false) = 按拒绝处理，内核据此继续收尾）。
	 *  @returns {number} 解掉的卡片数 */
	function cancelPending(reason) {
		if (!pendingPerms.size) return 0
		const n = pendingPerms.size
		for (const rec of [...pendingPerms]) {
			try { if (rec.done) rec.done(false, reason || "已中断") } catch (e) {}
			try { if (pendingPerms.has(rec)) rec.resolve(false) } catch (e) {}
		}
		pendingPerms.clear()
		return n
	}

	function addPermCard(name, args, resolve, auto, rec) {
		const card = el("div", "ac-perm")
		const title = el("div", "ac-perm__title"); title.textContent = "请求放行：" + name
		card.append(title)
		if (args && Object.keys(args).length > 0) {
			const pre = document.createElement("pre"); pre.className = "ac-perm__args"; pre.textContent = pretty(args)
			card.append(pre)
		}
		if (auto) {
			const note = el("div", "ac-perm__note"); note.textContent = "已自动放行"
			card.append(note); card.classList.add("is-resolved")
			timeline.append(card); scrollIntoView()
			retireCard(card, 900)
			return
		}
		const btns = el("div", "ac-perm__btns")
		const no = el("button", "ac-perm__no"); no.type = "button"; no.textContent = "拒绝"
		const yes = el("button", "ac-perm__yes"); yes.type = "button"; yes.textContent = "放行"
		btns.append(no, yes)
		card.append(btns)
		timeline.append(card); scrollIntoView()
		let resolved = false
		const done = (ok, noteText) => {
			if (resolved) return   // 连点两下 / cancelPending 与点击竞速，只结算一次
			resolved = true
			card.classList.add("is-resolved")
			btns.remove()
			const note = el("div", "ac-perm__note"); note.textContent = noteText || (ok ? "已放行" : "已拒绝")
			card.append(note)
			setStatus(ok ? "thinking" : "warn", ok ? "已放行，继续…" : (noteText || "已拒绝该操作"))
			resolve(ok)
			// 选完即走：结果只留一瞬，卡片与自动顶起的面板一起收掉（手机端不再有「弹窗赖着不走」）
			retireCard(card, 420)
			dismissSurface()
		}
		yes.onclick = () => done(true)
		no.onclick = () => done(false)
		if (rec) rec.done = done // 供 cancelPending 解卡（文案走 noteText）
		// 把面板顶到用户眼前，再滚到这张卡（面板刚展开时布局还没稳，延一帧再滚）
		surfacePending()
		setTimeout(() => { try { card.scrollIntoView({ block: "nearest" }) } catch (e) {} }, 150)
	}

	function clear() {
		// 清空面板前先解掉未决卡：否则循环还挂在那张卡的 Promise 上，而卡已经从 DOM 里消失
		cancelPending("已中断（面板清空）")
		autoSurface = null
		timeline.innerHTML = ""
		pending.clear()
		depth = 0; round = 0
		stopClock(); startTs = 0; time.textContent = ""
		setStatus("idle", "待命")
	}

	// 2026-11-11: 时间线备注（用户插话/停手等非内核事件的可视标记）
	function note(text) {
		try {
			const card = el("div", "ac-note")
			card.textContent = String(text || "")
			timeline.append(card)
			scrollIntoView()
		} catch (e) {}
	}

	return { onEvent, ensurePermission, cancelPending, clear, root, note }
}

let _styled = false
function injectStylesOnce() {
	if (_styled) return
	_styled = true
	const css = `
.agent-console{font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;color:inherit;display:flex;flex-direction:column;gap:8px;padding:2px;flex:1 1 auto;min-height:0;max-height:100%}
.ac-header{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:9px;background:var(--bg,#1b1b1f);border-bottom:1px solid var(--border,rgba(127,127,127,.22))}
.ac-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:currentColor;opacity:.45}
.ac-dot--thinking{background:#4d8dff;opacity:1;animation:acPulse 1.1s ease-in-out infinite}
.ac-dot--tool{background:#f59f00;opacity:1;animation:acPulse 1.1s ease-in-out infinite}
.ac-dot--perm{background:#ffd43b;opacity:1;animation:acPulse 1.1s ease-in-out infinite}
.ac-dot--done{background:#51cf66;opacity:1}
.ac-dot--error{background:#ff6b6b;opacity:1}
.ac-dot--warn{background:#ffa94d;opacity:1}
@keyframes acPulse{0%,100%{opacity:1}50%{opacity:.25}}
.ac-status-label{flex:1 1 auto;min-width:0;font-weight:600;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ac-time{flex:0 0 auto;font-variant-numeric:tabular-nums;opacity:.55;font-size:12px}
.ac-stop{flex:0 0 auto;font-size:11.5px;padding:3px 10px;border-radius:7px;border:1px solid var(--ag-border,rgba(127,127,127,.35));background:transparent;color:inherit;cursor:pointer}
.ac-stop:hover{background:rgba(255,107,107,.15);border-color:#ff6b6b}
.ac-stop:disabled{opacity:.4;cursor:default}
.ac-timeline{display:flex;flex-direction:column;gap:5px;flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch}
.ac-timeline > *{flex:0 0 auto}/* 2026-11-10: 时间线定高后子项默认会被 flex-shrink 压扁（步骤卡片 40px→3px，只剩 round 行）；禁止收缩，改成时间线内部滚动 */
.ac-round{font-size:11px;opacity:.45;text-align:center;letter-spacing:.04em;margin:2px 0}
.ac-step{border:1px solid rgba(127,127,127,.20);border-radius:9px;overflow:hidden}
.ac-step__head{display:flex;align-items:center;gap:8px;padding:7px 10px}
.ac-step--has-body>.ac-step__head{cursor:pointer}
.ac-step--has-body>.ac-step__head:hover{background:var(--ag-hover,rgba(127,127,127,.07))}
.ac-step__icon{display:inline-flex;align-items:center;flex:0 0 auto}
.ac-step--running .ac-step__icon{color:#f59f00}
.ac-step--done .ac-step__icon{color:#51cf66}
.ac-step--error .ac-step__icon{color:#ff6b6b}
.ac-step--denied .ac-step__icon{color:#adb5bd}
.ac-step__name{flex:1 1 auto;min-width:0;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ac-step__dur{flex:0 0 auto;font-size:11px;opacity:.55;font-variant-numeric:tabular-nums}
.ac-step__caret{flex:0 0 auto;display:inline-flex;opacity:.5;transition:transform .15s}
.ac-step.is-open .ac-step__caret{transform:rotate(90deg)}
.ac-step__body{display:none;padding:0 10px 10px}
.ac-step.is-open .ac-step__body{display:block}
.ac-step__body pre{margin:0;white-space:pre-wrap;word-break:break-word;font:11.5px/1.5 ui-monospace,Menlo,Consolas,monospace;background:var(--ag-surface,rgba(127,127,127,.10));padding:8px;border-radius:7px;max-height:180px;overflow:auto}
.ac-step__err{color:#ff8787}
.ac-sub{font-size:12px;opacity:.7;display:flex;align-items:center;gap:6px;padding:2px 4px}
.ac-sub__icon{display:inline-flex;flex:0 0 auto;opacity:.7}
.ac-perm{border:1px solid #ffd43b;background:rgba(255,212,59,.12);border-radius:9px;padding:9px 10px;transition:opacity .18s ease,transform .18s ease}
.ac-perm__title{font-weight:600;font-size:12.5px}
.ac-perm__args{margin:7px 0 0;white-space:pre-wrap;word-break:break-word;font:11.5px/1.5 ui-monospace,Menlo,Consolas,monospace;background:var(--ag-surface,rgba(127,127,127,.12));padding:8px;border-radius:7px;max-height:140px;overflow:auto}
.ac-perm__btns{display:flex;gap:8px;margin-top:9px}
.ac-perm__btns button{flex:1 1 0;padding:6px 0;border-radius:8px;border:0;cursor:pointer;font-weight:600;font-size:12.5px}
.ac-perm__yes{background:#ffd43b;color:#1a1d23}
.ac-perm__no{background:rgba(127,127,127,.22);color:inherit}
.ac-perm__note{margin-top:7px;font-size:11.5px;opacity:.65}
.ac-note{font-size:11.5px;opacity:.6;border-left:2px solid var(--border,rgba(127,127,127,.35));padding:2px 8px;margin:0 0 0 4px;white-space:pre-wrap;word-break:break-word;}
.ac-perm.is-resolved{opacity:.7}
.ac-perm.is-resolved.is-leaving{opacity:0;transform:translateY(-4px);pointer-events:none}
.ac-final{border-top:1px solid rgba(127,127,127,.20);padding:9px 4px 2px}
.ac-final__label{font-size:11px;opacity:.5;letter-spacing:.04em;margin-bottom:4px}
.ac-final__text{font-size:12.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
.ac-spin{animation:acSpin .9s linear infinite}
@keyframes acSpin{to{transform:rotate(360deg)}}
`
	const styleEl = document.createElement("style")
	styleEl.textContent = css
	document.head.appendChild(styleEl)
}

// 挂到全局，供 index.html 内联脚本的 window.mountAgentConsole 调用
globalThis.mountAgentConsole = mountAgentConsole