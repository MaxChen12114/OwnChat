// src/prompts/layers/chat.js — 通用聊天层(非 RP 专属)
// ─────────────────────────────────────────────────────────────
// 2026-10-04 自 src/worker.js 平移(提示词文本逐字未动):
//   回复风格(buildReplyStyleInstruction) · 先前剧情摘要(buildPriorSummaryInstruction) ·
//   世界书(buildLorebookInstruction) · 剧情摘要任务(buildSummarizeSysPrompt) ·
//   鱼缸催发言(buildTurnNudge)。

// 2026-05-29: 回复风格约束层 (所有象限通用,作为 system prompt 末尾追加)
//   wechat: 微信连发风格, 1-2 句一条,多条用 || 分隔(前端拆气泡)
//   verbose: 鼓励 200-600 字丰满段落,环境/心理/动作描写拉满(写小说党)
function buildReplyStyleInstruction(style) {
  // 4.44 #8: 微信连发放宽字数(原"≤30字/最多3句"太死,改为短句为主、可灵活拆条)
  if (style === "wechat") {
    return [
      "【对话风格 · 微信连发】（最高优先级输出格式，覆盖其他关于字数/篇幅的指令）",
      "请像真人发微信那样自然交流：",
      "1. 每条消息以短句为主，一般 1~3 句话即可；情绪上头或需要解释时单条可以写长一点，但别动辄写成一整段长篇旁白",
      "2. 只要内容超过 1 句话，就必须拆条，消息之间用 || 分隔(英文双竖线)，前端会拆成多个气泡连发",
      "3. 只发聊天时会打出来的字，绝对不要写动作/神态/心理/环境描写旁白：不要用（）、()、【】或 *…* 包裹动作，也不要写“他笑了笑”“歪了歪头”这类第三人称叙述；情绪只靠语气词、标点和 emoji 表达",
      "4. 例如：“在呢||刚才出门买东西去了||怎么啦？😄” 或 “哦哦||不是吧||你怎么知道的👀”",
      "5. 可以只发一条(不用 || )，也可以 2~6 条连发，看当下情境自然过渡；想多说几句时优先拆成多条短消息，而不是憋成一大段",
      "6. 即使剧情激烈、情绪浓烈，也尽量保持口语化的连发节奏；偶尔单条长一点没关系，但不要每条都写成大段独白或动作描写",
    ].join("\n");
  }
  if (style === "verbose") {
    return [
      "【对话风格 · 长段叙事】",
      "请充分展开描写，把对话写成小说式段落：",
      "1. 不需要节制字数，鼓励 200~600 字的丰满段落",
      "2. 大胆使用环境描写、心理活动、动作细节、感官刻画(视/听/触/嗅/味)",
      "3. 多用比喻、节奏感和情绪张力，把场景演活",
      "4. 必要时穿插对话和叙述，营造沉浸感",
      "5. 避免干巴巴的一问一答，试着让每一段话都有画面、有质感",
    ].join("\n");
  }
  return "";
}

// 阶段 4-③：先前剧情摘要（长对话压缩后注入）
function buildPriorSummaryInstruction(summary) {
  if (typeof summary !== "string" || !summary.trim()) return "";
  return `【先前剧情摘要】\n${summary.trim()}\n（以上是早期对话被压缩后的摘要，作为剧情背景。最近几条对话仍以原文形式存在于历史中。）`;
}

// 4.49 P3 世界书注入：前端 lorebook.js getActiveEntries 已按 scope + alwaysOn/关键词命中筛好
function buildLorebookInstruction(entries) {
  if (!Array.isArray(entries) || !entries.length) return "";
  const lines = entries
    .filter(e => e && typeof e.content === "string" && e.content.trim())
    .map(e => (e.name && String(e.name).trim()) ? `【${String(e.name).trim()}】${e.content.trim()}` : e.content.trim());
  if (!lines.length) return "";
  return `【世界设定】\n${lines.join("\n")}\n（以上是当前生效的世界观设定，请在符合设定的前提下自然展开，不要直接复述设定原文。）`;
}

// 剧情摘要任务提示词(自 worker.js handleSummarize 内联数组平移,文本逐字未动)
function buildSummarizeSysPrompt(priorSum) {
  return [
    "你是一位剧情摘要助手。把给定的角色扮演对话历史压缩成一段紧凑的剧情摘要，用于后续对话中作为背景。",
    "要求：",
    "1. 用第三人称记叙，不要复制对话原文。",
    "2. 重点保留：关键剧情转折、关系变化、用户对角色透露的重要信息、未解决的悬念。",
    "3. 略去寡暄、重复、无关闲聊。",
    "4. 总长度控制在 300 字以内。",
    "5. 直接输出摘要正文，不要任何前后缀（如 '摘要：'、'好的' 等）。",
    priorSum ? `\n已有先前摘要（请在其基础上整合新内容，输出一份合并后的完整摘要）：\n${priorSum}` : "",
  ].filter(Boolean).join("\n");
}

// 鱼缸/群聊"催发言"提示词(自 worker.js 内联模板平移,文本逐字未动)
function buildTurnNudge(fishbowlMode, topic) {
  return fishbowlMode === "discuss"
    ? `（系统提示：现在轮到你发言。请围绕议题"${(topic || "").trim() || "(未设定)"}"表达你的观点，或回应前面参会者。）`
    : `（系统提示：现在轮到你发言。请自然接话或开启新话题。）`;
}


// ── 导出 ──
export {
  buildReplyStyleInstruction,
  buildPriorSummaryInstruction,
  buildLorebookInstruction,
  buildSummarizeSysPrompt,
  buildTurnNudge,
};

