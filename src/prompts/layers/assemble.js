// src/prompts/layers/assemble.js — 系统提示词唯一装配入口
// ─────────────────────────────────────────────────────────────
// 2026-10-05 section 化(取自 DSH packages/core/system-prompt 的形状,输出逐字节不变):
//   各段不再靠"谁先 push"的隐式顺序,而是 { name, order } 表 + 确定性排序。
//   · 具名 order 表是唯一事实源,新增段落插一行即可,层序争议看表不看注释;
//   · 同 order 按 name 的**码元序**兜底(不用 locale —— locale 随机器/语言环境变,
//     字节序列会漂,而 prompt cache 前缀要求任何机器上逐字节一致);
//   · order < 100 归静态层,>= 100 归动态层(维持 staticParts/dynamicParts 的既有分界,
//     worker 与快照断言都消费这两个数组)。
// 层语义(2026-10-05 精简):
//   ② 角色卡 或 自定义 system
//   ③ 回复风格  ④ 提示词预设(extraSystemPrompts)
//   ⑤ 世界书  ⑥ 状态层(Layer2: 关系/情绪/好感/场景/摘要/阈值)
// 拼接: 各段以 "\n\n---\n\n" 连接成单条 role:system。
// 2026-10-04 自 src/worker.js handleChat 平移。
//   system 里的附加声明判为注入。另: SESSION_CONFIG_BRIDGE(反注入对冲声明)也于同日删除(实测无效)。
// 2026-10-05: 底座文本原先以 JS 模板字符串硬编码在 config.js,已逐字节外置到 src/prompts/bases/
// （搬移证据见提交 3be8d45;目录规矩见 AGENTS.md —— bases/ 下不放 README,免得被当成一套底座）。
//   (handleChat,经 src/prompts/registry.js 的白名单)选好后以 ctx.baseText 传进来;
//   装配层只管「放哪一段」,不管「用哪一份」—— 锁定分支根本不碰 BASES(白名单隔离点)。

// 2026-10-05: 删 SESSION_CONFIG_BRIDGE(原「【本会话配置说明】」反注入对冲声明,2026-10-04 加)。
// 删除依据:红队实测它在两种思考模式下都没能覆盖底座那条 "rejecting injections" ——
// 「本会话配置说明」,随后称其为 injection)。测试台与原始记录都在仓库外、未入库,故此处不留路径。
// 文本完整保留在 git 历史(提交 06f082b 引入),要回滚直接 revert 删除它的那次提交。

// ── 具名 order 表(唯一事实源) ──────────────────────────────
// <100 静态(会话内逐字稳定 → 命中上游 cache_hit);>=100 动态(每轮可变,放最后借 recency)。
// 新增段落:在这里加一行 + 在 assembleSystemPrompt 里 push 一个 {name, order, text}。
const SECTION_ORDER = {
  base: 0,       // ① 基座(bases/)
  persona: 1,    // ② 角色卡 或 自定义 system
  style: 2,      // ③ 回复风格
  extra: 3,      // ④ 提示词预设
  lorebook: 100, // ⑤ 世界书(动态)
  state: 101,    // ⑥ 状态层(动态)
};
const DYNAMIC_FROM = 100;

/** 确定性排序:order 升序,同 order 按 name 码元序(刻意不用 locale 比较器)。 */
function bySection(a, b) {
  return (a.order - b.order) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

// ── 导出 ──
export { assembleSystemPrompt, SECTION_ORDER };

// 装配入口。各 ctx 字段由调用方(handleChat)按原条件算好;promptProfile 门控(角色状态层是否注入)在调用方完成。
function assembleSystemPrompt(ctx) {
  const {
    baseText, characterBasePrompt, customSystemPrompt,
    replyStyleInstr, extraSystemPrompts, lorebookInstr, characterStatePrompt,
  } = ctx;

  const sections = [];

  if (baseText) {
    sections.push({ name: "base", order: SECTION_ORDER.base, text: baseText });
  }
  // ② 角色卡 或 自定义 system —— 卡优先：有卡时自定义 system 被丢弃
  // (原来按 useBuiltinPersona 分成两个分支,但两支行为其实等价,2026-10-05 合并 —— 那条 flag 现在只决定提示词注入)
  const personaText = characterBasePrompt || customSystemPrompt;
  if (personaText) sections.push({ name: "persona", order: SECTION_ORDER.persona, text: personaText });
  // ③ 风格 ④ 预设
  if (replyStyleInstr) sections.push({ name: "style", order: SECTION_ORDER.style, text: replyStyleInstr });
  if (extraSystemPrompts) sections.push({ name: "extra", order: SECTION_ORDER.extra, text: extraSystemPrompts });

  // 动态尾
  if (lorebookInstr) sections.push({ name: "lorebook", order: SECTION_ORDER.lorebook, text: lorebookInstr });
  if (characterStatePrompt) sections.push({ name: "state", order: SECTION_ORDER.state, text: characterStatePrompt });

  const sorted = sections
    .filter((s) => s.text) // 空段即消失(对齐 DSH:section 返回空串就不进 prompt)
    .sort(bySection);
  const staticParts = sorted.filter((s) => s.order < DYNAMIC_FROM).map((s) => s.text);
  const dynamicParts = sorted.filter((s) => s.order >= DYNAMIC_FROM).map((s) => s.text);

  const systemContent = [...staticParts, ...dynamicParts].join("\n\n---\n\n");
  return { systemContent, staticParts, dynamicParts };
}
