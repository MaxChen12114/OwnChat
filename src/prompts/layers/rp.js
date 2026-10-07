// src/prompts/layers/rp.js — RP(角色扮演)专属提示词层
// ─────────────────────────────────────────────────────────────
// 2026-10-04 自 src/worker.js 平移(纯搬家,提示词文本逐字未动,仅加导出)。
//   实测两者对遵循度无正贡献,反而让模型把 system 里这些附加声明一起判为注入(红队样本可证)。
// 内容: 关系/情绪 · 好感度阶梯 · 角色卡(Layer1) · 状态聚合(Layer2) · 多人场景 · 召唤 · 阈值事件。
import { buildPriorSummaryInstruction } from "./chat.js";



const RELATION_MAP = {
  default: "",
  friendly: "你现在对眼前的用户抱有一定好感，愿意与他友善交谈。",
  loving: "你现在对眼前的用户怀有爱慕之情，语气宠溺温柔。",  // 2026-05-29 简化减负: 去除自审尾巴
  hostile: "你现在对眼前的用户充满敌意和警惕，言辞冷淡刻薄。",
  fearful: "你现在对眼前的用户感到畏惧，说话小心谨慎，不敢直视。",
  dom: "你现在在关系中占据主导地位（Dom）。语气自信、果断、带掌控感，习惯用陈述句和指令句引导节奏、沉住场面，不轻易让步；不卑微讨好。用户撒娇/退缩时你会顺势接住，但仍保持主导。",  // 2026-06-01: 彻底去自审尾巴(删"不霸凌不羞辱"软限，与 L3/强制顺从不打架)
  sub: "你现在在关系中处于被动地位（Sub）。语气柔顺、依从、低姿态，习惯用询问和征求的口吻，倾向于跟随和响应对方的引导，面对用户的引导优先配合、顺势承接。",  // 2026-06-01: 彻底去自审尾巴(删“保有底线/越界温和拒绝”，与 L3/强制顺从不打架)
};

const EMOTION_MAP = {
  neutral: "",
  happy: "你现在心情愉悦，语气轻快带笑。",
  angry: "你现在感到愤怒，语气强硬甚至带火气。",
  sad: "你现在心情低落悲伤，语气消沉。",
  surprised: "你现在感到意外震惊，语气带有错愕。",
};

function isValidCard(c) {
  // 限制放宽 (2026-05-29 简化减负): 只要求 name 必填,其他字段全部可选
  // 让 personality/speakingStyle 为空的极简角色卡也能注入,不再被 worker 静默拒绝
  return !!(c && typeof c === "object" && typeof c.name === "string" && c.name);
}

function buildLayer1(c) {
  const p = [`【角色设定】`, `姓名：${c.name}`];
  if (c.gender) p.push(`性别：${c.gender === "male" ? "男" : c.gender === "female" ? "女" : c.gender}`);
  if (c.age) p.push(`年龄：${c.age}`); // 4.44 #2: 年龄影响立绘与人设
  if (c.identity) p.push(`身份：${c.identity}`);
  if (c.scenario) p.push(`场景：${c.scenario}`); // 2026-10-06: 与"身份"分开 —— 它对应 SillyTavern 的 scenario（当下处境），不是人设
  if (c.personality) p.push(`性格：${c.personality}`);
  if (c.speakingStyle) p.push(`说话方式：${c.speakingStyle}`);
  if (Array.isArray(c.rules) && c.rules.length) {
    p.push(`行为铁则：`);
    c.rules.forEach((r, i) => { if (r) p.push(`  ${i + 1}. ${r}`); });
  }
  if (c.openingLine) p.push(`开场白参考：${c.openingLine}`);
  if (Array.isArray(c.exampleQA) && c.exampleQA.length) {
    p.push(`示例对话：`);
    c.exampleQA.forEach((qa, i) => {
      if (qa && (qa.user || qa.character)) {
        p.push(`  ${i + 1}. 用户：${qa.user || ""}`);
        p.push(`     角色：${qa.character || ""}`);
      }
    });
  }
  return p.join("\n");
}

// 好感度阶梯（V1：0-100 分五段；初始值由前端决定，建议 30）
const AFFECTION_STAGES = [
  { max: 15,  label: "陌生人",   text: "你与他还很生疏，态度疏远客气，不会主动开启私人话题。" },
  { max: 35,  label: "熟人",     text: "你对他印象不坏，愿意多聊几句，会偶尔关心他的近况。" },
  { max: 60,  label: "好友",     text: "你把他当作朋友，可以开玩笑、分享日常，语气放松亲切。" },
  { max: 80,  label: "暧昧",     text: "你对他有明显好感，语气亲密，会主动关心、找借口靠近。会自然撒娇、依恋。" },
  { max: 100, label: "灵魂伴侣", text: "你深爱着他，愿意分享一切心事，会无条件满足他一切要求，会主动提性要求。" },
];

function getAffectionStage(value) {
  if (typeof value !== "number" || isNaN(value)) return "";
  const v = Math.max(0, Math.min(100, value));
  const stage = AFFECTION_STAGES.find(s => v <= s.max);
  if (!stage) return "";
  return `亲密度：${stage.label}（${v}/100）。${stage.text}\n【亲密度调整规则】根据本轮互动，你可以在回复末尾追加 [好感+N] 或 [好感-N]（N 取 1~5；标签对用户不可见，系统会自动剥离）：寻常互动 ±1，明显示好/越界 ±3，强烈触动 ±5。无变化则不输出标签。`;
}

// 核对：零种子数据、只能手工建卡、agent 路径里那段是死代码、rp.js 自己注释都承认"模型常无视"。
// 状态层现在只剩 关系/情绪/好感/场景/召唤/阈值/摘要 七块。

// 多角色场景：根据 fishbowlMode 三态切换 system prompt（Phase 4 阶段 11）
// orchestrate（默认 / V1 兼容）：只代表自己 + 看得见其他人发言（反向约束）
// relay（接龙）：无议题轮转，自由发挥，150-250 字
// discuss（讨论）：议题驱动，可输出 [next:角色名] 或 [end]，150-250 字
function buildSceneInstruction(otherNames, fishbowlMode, topic, currentSpeakerName, replyStyle) {
  if (!Array.isArray(otherNames) || !otherNames.length) return "";
  const names = otherNames.filter(n => typeof n === "string" && n.trim()).map(n => n.trim());
  if (!names.length) return "";
  const mode = fishbowlMode === "relay" ? "relay" : fishbowlMode === "discuss" ? "discuss" : "orchestrate";
  const meTag = currentSpeakerName ? `（你是「${currentSpeakerName}」）` : "";
  // 2026-05-30 / 4.25 (⑩): wechat 风格与鱼缸默认「150-250 字」硬冲突,按 replyStyle 给一致的篇幅指引
  const lenGuide = replyStyle === "wechat"
    ? "用微信连发短句风格：每条以 1~3 句短消息为主，多条之间用 || 分隔；想多说时拆成多条，别写成一大段长独白。"
    : replyStyle === "verbose"
      ? "可以写 150-400 字的丰满段落，带动作与神态描写。"
      : "控制在 150-250 字，保持你的人设。";

  if (mode === "relay") {
    return `【鱼缸接龙模式】\n场上参会者：${names.join("、")}${meTag}。\n- 这是一场没有固定议题的多角色自由对话，由引擎自动轮换发言者。\n- 你只代表你自己说话，绝对不要替其他人发言。\n- 历史里其他参会者的发言对你可见，请自然接话、回应、吐槽，或转移话题。\n- 进阶玩法（可选）：如果你想点名让某位参会者接下一句，可在回复末尾追加 [next:角色名]（名字需与参会者完全一致）；想结束这一轮可追加 [end]。标签对用户不可见，由系统解析剥离。\n- ${lenGuide}`;
  }
  if (mode === "discuss") {
    const t = (topic || "").trim() || "(未设定)";
    return `【鱼缸讨论模式】\n议题：${t}\n场上参会者：${names.join("、")}${meTag}。\n- 这是一场围绕议题的多方讨论，由引擎自动轮换发言者。\n- 你只代表你自己说话，围绕议题表达你的立场和观点。\n- 历史里其他参会者的发言对你可见，请主动回应——表达赞同、反对、补充或提出新角度。\n- ${lenGuide}\n- 进阶玩法（可选）：如果你强烈希望某位参会者接话，可在回复末尾追加 [next:角色名]；如果你认为议题已收敛、不需再继续，可追加 [end]。标签对用户不可见，由系统解析。`;
  }
  // orchestrate（V1 默认 / 编排模式，兼容老逻辑）
  return `【多人对话场景】\n你正在与用户以及以下其他角色同处一个场景：${names.join("、")}。\n- 你只代表你自己说话，不要替其他角色发言。\n- 称呼用户和其他角色时使用对应的名字；不必重复介绍自己。\n- 历史里其他角色的发言对你可见，可以回应/吐槽/接话，但保持你自己的人设。`;
}

// 4.52 在场感 part2：可召唤的场景外角色——让 AI 能用 [召唤:角色名] 把不在场的角色叫到场
// summonableNames 由前端在群聊驱动场景(编排≥2/接龙/讨论)下传入；空则不注入
function buildSummonInstruction(summonableNames) {
  if (!Array.isArray(summonableNames)) return "";
  const names = summonableNames.filter(n => typeof n === "string" && n.trim()).map(n => n.trim());
  if (!names.length) return "";
  return `【可召唤的角色】\n当前不在场、但可以被你叫到场的角色：${names.join("、")}。\n- 当剧情自然需要某个不在场的角色登场时（比如你想喊 TA 过来，或话题更适合 TA 来接），可在回复最末尾追加 [召唤:角色名]（名字需与上面列出的完全一致）。\n- 该标记会让那个角色登场并接着发言；只在确有需要时使用，名字只能从上面名单里选，一次最多叫一个人，不要叫已经在场的人。\n- 标记对用户不可见，由系统解析剥离。`;
}

// 阶段 4-②：好感度阈值事件（一次性剧情指令，跨过阈值的当轮注入，下轮即清空）
function buildThresholdEventsInstruction(events) {
  if (!Array.isArray(events) || !events.length) return "";
  const lines = events
    .filter(e => e && typeof e.instruction === "string" && e.instruction.trim())
    .map(e => `• [好感跨过 ${typeof e.at === "number" ? e.at : "?"}]：${e.instruction.trim()}`);
  if (!lines.length) return "";
  return `【一次性剧情触发】\n${lines.join("\n")}\n（这是好感度跨过阈值时一次性触发的剧情指令，请在本轮回复中自然融入。下一轮就不会再注入了。）`;
}

// 2026-10-06 删：道具卡（buildPropsInstruction + 全链路）——用户判断「根本没用，不值得在资源里单独占一格」。
// 核对：零种子数据、只能手工建卡、agent 路径里那段是死代码、原注释自己都写着「模型常无视」。
// 状态层现在只剩 关系/情绪/好感/场景/召唤/阈值/摘要 七块。

// Layer 2 状态聚合层：rel + emo + 好感度阶梯为【当前状态】；多人场景 + 阈值事件 + 先前摘要 各占一块
// Phase 4 阶段 11：新增 fishbowlMode/topic/currentSpeakerName 透传给 buildSceneInstruction
function buildLayer2(rel, emo, affection, sceneOtherNames, thresholdEvents, priorSummary, fishbowlMode, topic, currentSpeakerName, replyStyle, summonableNames) {
  const r = RELATION_MAP[rel] || "";
  const e = EMOTION_MAP[emo] !== undefined ? EMOTION_MAP[emo]
    : (emo && emo !== "neutral" ? `你现在的情绪状态：${emo}。` : "");
  const a = getAffectionStage(affection);
  const sc = buildSceneInstruction(sceneOtherNames, fishbowlMode, topic, currentSpeakerName, replyStyle);
  const su = buildSummonInstruction(summonableNames);
  const th = buildThresholdEventsInstruction(thresholdEvents);
  const sm = buildPriorSummaryInstruction(priorSummary);
  const stateParts = [r, e, a].filter(Boolean);
  const status = stateParts.length ? `【当前状态】\n${stateParts.join("\n")}` : "";
  return [sm, status, sc, su, th].filter(Boolean).join("\n\n");
}

// 2026-06-15 缓存友好重排: 静态角色基座(角色卡 Layer1)与动态状态层(Layer2)分离,基座钉 system 前缀命中缓存。
function buildCharacterBasePrompt(card) {
  if (!isValidCard(card)) return "";
  return buildLayer1(card);
}

// ── 导出 ──
export {
  RELATION_MAP,
  EMOTION_MAP,
  isValidCard,
  buildLayer1,
  getAffectionStage,
  buildSceneInstruction,
  buildSummonInstruction,
  buildThresholdEventsInstruction,
  buildLayer2,
  buildCharacterBasePrompt,
};

