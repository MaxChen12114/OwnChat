// src/prompts/registry.js — 提示词注册表的唯一白名单入口
// ─────────────────────────────────────────────────────────────
//   两套目录，对应顶栏按钮的两个状态：
//     bases/    内置基座（system 提示词的第一段，所有聊天都吃它；随包一份「基础」）
//     custom/   自定义基座（使用者自己放的那份，只有他自己的部署看得见；目录为空时回落内置默认档）
// 目录里放任意 .md / .txt（或一整个子目录 = 多文件基座），构建脚本自动发现：
//   · 文件名 = id（子目录 = 目录名）
//   · 设置里「对话 → 基座」两个下拉直接列出来，不用改代码
// 所有取用都必须经过这里的函数 —— 别在别处直接索引注册表，白名单会失守。
import { BASES, DEFAULT_BASE_ID } from "./bases/index.js";
import { CUSTOMS, DEFAULT_CUSTOM_ID } from "./custom/index.js";
import { PRESETS, LIBRARY_VERSION as PRESET_VERSION } from "./presets/index.js";
import { SKILLS, LIBRARY_VERSION as SKILL_VERSION } from "./skills/index.js";

/** 请求方指定的基座 id 过白名单：乱传/缺省回落默认档（不报错、不空手）。
 *  必须用 Object.hasOwn —— `baseId="__proto__"` / "constructor" 这类原型键会命中原型链上的真值，
 *  过了挡就会把 [object Object] 拼进 system prompt。 */
export function resolveBaseId(requested) {
  return (typeof requested === "string" && Object.hasOwn(BASES, requested)) ? requested : DEFAULT_BASE_ID;
}
/** 自定义目录同上；目录为空时 DEFAULT_CUSTOM_ID 是空串，下面的 textForId 会兜底。 */
export function resolveCustomId(requested) {
  return (typeof requested === "string" && Object.hasOwn(CUSTOMS, requested)) ? requested : DEFAULT_CUSTOM_ID;
}
export function baseTextForId(id) { return BASES[resolveBaseId(id)]; }
/** 自定义基座文本；目录还是空的（使用者没放东西）就回落内置默认档 —— 宁可多发一段也不能空手。 */
export function customTextForId(id) {
  const t = CUSTOMS[resolveCustomId(id)];
  return (typeof t === "string" && t) ? t : baseTextForId(DEFAULT_BASE_ID);
}
export function baseIds() { return Object.keys(BASES); }
export function customIds() { return Object.keys(CUSTOMS); }

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
