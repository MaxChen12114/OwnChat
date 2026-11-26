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
