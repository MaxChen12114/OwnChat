// src/prompts/registry.js — 两套提示词注册表的选择逻辑（唯一白名单入口）
// ─────────────────────────────────────────────────────────────
//   bases/     解限底座       → 解锁态注入
//   neutrals/  基础行为准则   → 锁定态注入
// 两个白名单**严格隔离**：锁定请求永远走 NEUTRALS 分支，BASES 的文本根本不会被读到。
// 所有取用都必须经过这里的函数 —— 别在别处直接索引 BASES/NEUTRALS，白名单会失守。
//
// 2026-10-05: 从 assemble.js 抽出来。原来只有一套底座，选择逻辑混在装配文件里；
// 现在两套注册表 + 锁态分支，独立成模块后「哪套能进哪条路径」一眼可见，也便于测试台断言。

// 2026-10-06: base 目录按锁态分了两层（unlocked/ 解锁态底座、locked/ 锁定态准则）—— 中性准则本身就是 base。
import { BASES, DEFAULT_BASE_ID } from "./bases/unlocked/index.js";
import { NEUTRALS, DEFAULT_NEUTRAL_ID } from "./bases/locked/index.js";
// 2026-10-06: 指令模块库（预设）与技能库，同样是"生成器发现"的注册表；下发走 POST /api/presets（解锁门禁）。
import { PRESETS, LIBRARY_VERSION as PRESET_VERSION } from "./presets/index.js";
import { SKILLS, LIBRARY_VERSION as SKILL_VERSION } from "./skills/index.js";

/** 请求方指定的底座 id 过白名单：乱传/缺省回落默认档（不报错、不空手）。
 *  必须用 Object.hasOwn —— `baseId="__proto__"` / "constructor" 这类原型键会命中原型链上的真值，
 *  过了挡就会把 [object Object] 拼进 system prompt（注册表本身是 null 原型，这层是给"将来换回普通对象"留的防线）。 */
export function resolveBaseId(requested) {
  return (typeof requested === "string" && Object.hasOwn(BASES, requested)) ? requested : DEFAULT_BASE_ID;
}

/** 中性准则同上。id 空间与底座完全独立，两边同名互不影响。 */
export function resolveNeutralId(requested) {
  return (typeof requested === "string" && Object.hasOwn(NEUTRALS, requested)) ? requested : DEFAULT_NEUTRAL_ID;
}

export function baseTextForId(id) { return BASES[resolveBaseId(id)]; }
export function neutralTextForId(id) { return NEUTRALS[resolveNeutralId(id)]; }

/** 候选 id 列表（/config.js 下发给前端下拉用；只下发 id，不下发文本）。 */
/** 指令模块库：按 order 排好的条目数组（每项含 id/name/group/enabled/source/license/text…）。 */
export function presetEntries() {
  return Object.keys(PRESETS).map((k) => PRESETS[k]).sort((a, b) => (a.order || 0) - (b.order || 0));
}
/** 技能库：同上（技能只在 agent 模式挂载，正文由 load_skill 按需取）。 */
export function skillEntries() {
  return Object.keys(SKILLS).map((k) => SKILLS[k]).sort((a, b) => (a.order || 0) - (b.order || 0));
}
/** 两库的内容指纹：客户端据此判断要不要合并新条目（改任何库文件都会变）。 */
export function libraryVersions() { return { presets: PRESET_VERSION, skills: SKILL_VERSION }; }

export function baseIds() { return Object.keys(BASES); }
export function neutralIds() { return Object.keys(NEUTRALS); }
