// src/model/data.js
// ═══════════════════════════════════════════════════════════════════════
// 模型「数据表」—— 唯一维护入口
// ═══════════════════════════════════════════════════════════════════════
// 只放**纯数据 + 极小的查表函数**,不放路由/HTTP/鉴权逻辑(那些在 ./providers.js)。
//
// 为什么单独一个文件:这几张表的变更频率远高于代码 —— 上游出新模型、调价、改上下文
// 窗口长度都要动它们。以前散在 config.js 里,改一次要跳好几处、还容易漏。
//
// ⚠️ 其中 DEEPSEEK_PRICING / CTX_EXACT / CTX_HINTS 是**要下发给前端的客户端数据**
//    (经 worker 的 /config.js)。客户端不要再抄第二份 —— 抄了就会静默漂移。
// ═══════════════════════════════════════════════════════════════════════

// ────────────────────────────
// 内置模型表(占位符)
// ────────────────────────────
// 2026-09-12:内置模型改为占位符 —— 真正可用模型走 /api/models 实时拉取 + 设置页候选池。
// 注意:占位符只用于「UI 空态展示」,**绝不能被当成模型 id 发到上游**;
//       worker 侧由 ./providers.js 的 resolveRequestedModel 直接报错拦住(不再静默回落占位符)。
export const DEFAULT_MODEL_FREE = "__free_placeholder__";
export const MODELS_FREE = [
  { id: "__free_placeholder__", label: "免费模型 · 请在设置里拉取" },
];

export const DEFAULT_MODEL_FAST = "__fast_placeholder__";
export const MODELS_FAST = [
  { id: "__fast_placeholder__", label: "快速模型 · 请在设置里拉取" },
];

export function isPlaceholderModelId(id) {
  return /^__\w+_placeholder__$/.test(String(id || ""));
}

// ────────────────────────────
// 上下文窗口(前端「状态」面板算占用百分比用)
// ────────────────────────────
// 为什么要手维护:上游 /v1/models 只返回 { id, label },**不含上下文长度**
// (实测 NVIDIA NIM 40 个模型、DeepSeek 官方 2 个模型都没有该字段)。
// 所以只能按厂商/家族映射 —— 与 ZCode 的差别在于它自带模型能力元数据,我们是从上游动态拉清单。
//   · CTX_EXACT  精确 id → tokens,优先级最高(注意用**上游真实 id**,别用别名)
//   · CTX_HINTS  [正则字符串, tokens],按顺序匹配,先命中先用
export const CTX_EXACT = {
  // 2026-10-13 (E1):按上游 /v1/models 元数据校正 —— context_window=1048576(1M)。
  // 旧值 131072(128K) 是 2026 上半年的口径,已过期。
  "deepseek-flash": 1048576,      // DeepSeek-V4.1-Flash（1M ctx、支持图像输入）。若你的上游代理给不同窗口,改这一行
  "deepseek-v4-flash": 1048576,   // 上游/摘要用过的别名 id(与上面那条不是同一个名字,两个都留着)
  "deepseek-v4-pro": 1048576,     // DeepSeek-V4-Pro
  "deepseek-chat": 1048576,       // 旧名(上游现按别名接受),给历史会话兜底
};

export const CTX_HINTS = [
  ["1m|1000k", 1048576],
  ["kimi|moonshot", 262144],
  ["qwen-?max|qwen3-?max", 1048576],
  ["gemini", 1048576],
  ["claude", 200000],
  ["deepseek", 131072],
  ["gpt-oss|gpt-4o|gpt-4\\.1", 131072],
  ["glm-?5", 1048576],            // GLM-5.3(含 Flash)实测 1M(2026-11-08,对齐 ZCode 显示口径)
  ["glm-?[45]", 131072],          // GLM-4 系维持 128K
  ["llama-?3|llama-?4|nemotron", 131072],
  ["mistral|mixtral|ministral", 131072],
  ["qwen", 131072],
];

// ────────────────────────────
// 候选池:厂商放行名单 + 校验 + persona 推断
// ────────────────────────────
// 模型名不再写死:用户在设置页「拉取模型列表」→ 从源站 /v1/models 取全量 → 勾选几个进下拉。
// worker 侧不用「精确白名单」拦截(模型迭代太快),改为「厂商前缀 + 格式」校验,
// 新版本号无需改代码即可用,同时挡住乱填的野端点。

// 免费源(NVIDIA NIM)允许的厂商前缀。NIM 上百来个模型,只放行真会用的这几家,
// 免得候选池抽屉糊一屏用不上的。要加新厂商就往这里补一行。
export const NIM_VENDOR_PREFIXES = [
  "deepseek-ai/",
  "z-ai/",
  "openai/",
  "moonshotai/",
  "nvidia/",
  "minimaxai/",
  "qwen/",
];

// 2026-10-05: persona 机制退役。原先它按模型 id 前缀决定「不选底座时用哪一套」(glm → 2 等),
// 现在底座选择只有一条规则:payload.baseId(白名单) > 默认档(排序第一份)。详见 AGENTS.md。
// (候选池里那个 P1/P2/P3 徽标随之一并删除 —— 它展示的正是这里的映射,留着就是指错路。)

// ────────────────────────────
// 定价(元 / 百万 token)
// ────────────────────────────
// cache_hit = 缓存命中输入价;input = 普通输入价;output = 输出价
// (4.82 已删掉重复定义的 deepseek-flash / deepseek-v4-pro 键 —— 后者会静默覆盖前者)
export const DEEPSEEK_PRICING = {
  "deepseek-flash": { cache_hit: 0.02, input: 1.00, output: 2.00 },
  "deepseek-v4-flash": { cache_hit: 0.02, input: 1.00, output: 2.00 }, // 上游/摘要用的真实 id
  "deepseek-v4-pro": { cache_hit: 0.30, input: 9.00, output: 27.00 },
  // 兼容:2026-07-24 已下线的旧模型名,仅留价格避免历史日志算错
  "deepseek-chat": { cache_hit: 0.02, input: 1.00, output: 2.00 },
  "deepseek-reasoner": { cache_hit: 0.02, input: 1.00, output: 2.00 },
};

// 兜底价:候选池模式下会出现表里没有的新模型名,按 Flash 档估价(宁可略估低也别报错)。
// ⚠️ 官方已预告「近期整体上调 DeepSeek API 定价」,涨价后记得回来改这三个数。
export const DEEPSEEK_PRICING_DEFAULT = { cache_hit: 0.02, input: 1.00, output: 2.00 };
