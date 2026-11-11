// public/shared/model-think.js — 模型思考档位表（唯一维护入口）
// ─────────────────────────────────────────────────────────────────────────────
// 为什么单独一个文件：模型能力会随上游更新（新模型、新档位、某些模型从
// "可关" 变成 "固定开"），这张表是纯数据，改它不该动 app.js 的 UI/请求逻辑。
//
// 数据源：ZCode 的 resources/config/provider/zcode-builtin.json
//         → modelConfigRules.modelRules[].config.optionSpecs.reasoningLevel.values
// 更新方式：
//   · 只改下面的 RULES；顺序敏感（先具体后宽泛，先命中先用）。
//   · levels 取值：disabled / none / enabled / minimal / low / medium / high / xhigh / max
//     - disabled、none = 可以关
//     - enabled       = 只有开（无强度）
//     - 其余          = 具体强度；没有 disabled/none 的就是"固定开"
//   · 未知模型回退在 levelsFor() 末尾；改这里要同步想清楚 vLLM / DeepSeek 两种方言的默认。
//   · 新增家族时优先用"去掉 vendor/ 前缀后的模型名"去匹配（levelsFor 已做 split("/").pop()）。
//
// 这张表只决定「UI 显示哪些档位」；请求怎么装配（thinking:{type} / chat_template_kwargs /
// reasoning_effort / output_config.effort …）由 app.js 的渠道方言决定，不要混进来。
// ─────────────────────────────────────────────────────────────────────────────
(function (global) {
  "use strict";
  if (global.__modelThink) return;

  var LEVELS = [
    { v: "minimal", label: "极低" },
    { v: "low", label: "低" },
    { v: "medium", label: "中" },
    { v: "high", label: "高" },
    { v: "xhigh", label: "更高" },
    { v: "max", label: "最高" },
  ];

  // 顺序敏感：先具体后宽泛。
  var RULES = [
    // 明确不能/不适合思考的模型（向量、审核、代码补全、指令微调基座等）
    { re: /(embed|guard|safety|detector|retriever|chatqa)/i, levels: [] },
    { re: /(^|[-_/])(coder|coding)([-_/.]|$)/i, levels: [] },
    { re: /(^|[-_/])instruct([-_/.]|$)/i, levels: [] },
    { re: /^deepseek-chat/i, levels: [] },

    // DeepSeek
    { re: /^deepseek-reasoner/i, levels: ["disabled", "low", "high", "max"] },
    { re: /^deepseek-(v4([.-]\d+)?-)?(flash|pro)/i, levels: ["disabled", "low", "high", "max"] },

    // GLM
    { re: /^glm-5\.3/i, levels: ["low", "high", "max"] },
    { re: /^glm-5\.2/i, levels: ["high", "max"] },
    { re: /^glm-(5|4\.[5-7])/i, levels: ["disabled", "enabled"] },

    // Qwen
    { re: /^qwen3\.8-omni-flash/i, levels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] },
    { re: /^qwen3\.8-(max|flash)/i, levels: ["low", "medium", "xhigh"] },
    { re: /^qwen3\.(5|6|7)/i, levels: ["disabled", "enabled"] },
    { re: /^qwen(3-vl)?-(plus|flash)/i, levels: ["disabled", "enabled"] },

    // Kimi
    { re: /^(kimi-)?k3/i, levels: ["low", "high", "max"] },
    { re: /^kimi-k2\.7-code/i, levels: ["enabled"] },
    { re: /^kimi-k2\.[56]/i, levels: ["disabled", "enabled"] },

    // MiniMax / MiMo
    { re: /^minimax-m3/i, levels: ["disabled", "enabled"] },
    { re: /^minimax-m2\.[57]/i, levels: ["enabled"] },
    { re: /^mimo-v2\.[56]/i, levels: ["disabled", "enabled"] },

    // OpenAI / GPT
    { re: /^gpt-5\.6/i, levels: ["none", "low", "medium", "high", "xhigh", "max"] },
    { re: /^gpt-5\.3-codex/i, levels: ["low", "medium", "high", "xhigh"] },
    { re: /^gpt-6-astra/i, levels: ["low", "medium", "high", "xhigh", "max"] },
    { re: /^gpt-5\.4-pro/i, levels: ["medium", "high", "xhigh"] },
    { re: /^gpt-5\.4/i, levels: ["none", "low", "medium", "high", "xhigh"] },

    // Anthropic / 其他
    { re: /^claude-.*-5/i, levels: ["low", "medium", "high", "xhigh", "max"] },
    { re: /^grok-4\.6/i, levels: ["low", "medium", "high", "xhigh"] },
    { re: /^hy3/i, levels: ["none", "low", "high"] },
    { re: /^hy4-preview/i, levels: ["none", "high"] },
  ];

  var LABEL = {};
  for (var i = 0; i < LEVELS.length; i++) LABEL[LEVELS[i].v] = LEVELS[i].label;
  LABEL.enabled = "开启";

  function label(v) {
    return LABEL[v] || "中";
  }

  // 当前模型支持的档位；未知模型按渠道方言回退。
  // 注意：这里只返回"值"，offAllowed / mustOn 的 UI 语义在 app.js 里算。
  function levelsFor(model, style) {
    var id = String(model || "").split("/").pop().toLowerCase();
    for (var i = 0; i < RULES.length; i++) {
      if (RULES[i].re.test(id)) return RULES[i].levels.slice();
    }
    return style === "vllm"
      ? ["disabled", "enabled"]
      : ["disabled", "low", "medium", "high", "max"];
  }

  global.__modelThink = {
    version: 1,
    levels: LEVELS,
    values: LEVELS.map(function (l) { return l.v; }),
    rules: RULES,
    label: label,
    levelsFor: levelsFor,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
