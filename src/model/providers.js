// src/model/providers.js
// ═══════════════════════════════════════════════════════════════════════
// 模型「提供方」逻辑 —— 上游端点注册表 / 模式路由 / 模型 id 网关 / BYO 归一化
// ═══════════════════════════════════════════════════════════════════════
// 与 ./data.js 的分工:这里放**逻辑**(会随架构变),那里放**表**(会随上游变)。
// worker.js 只负责 HTTP 层(读请求 / 组装响应),模型域的判断都收在这里。
// ═══════════════════════════════════════════════════════════════════════
import { NIM_VENDOR_PREFIXES, isPlaceholderModelId } from "./data.js";

// ────────────────────────────
// 上游端点注册表
// ────────────────────────────
// 2026-06-14 (4.69 G2/G4):OpenAI 兼容 provider 注册表 —— 新增厂商 = 加一条配置,
// 不再散落 if(mode)。DeepSeek=fast 官方;NVIDIA NIM=free 默认。
const NVIDIA_ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions";
const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/v1/chat/completions";

export const PROVIDERS = {
  deepseek: {
    label: "deepseek-official",
    endpoint: DEEPSEEK_ENDPOINT,
    keyEnv: "DEEPSEEK_API_KEY",
    supportsThinking: true, // thinking:{type} + reasoning_effort
    thinkingStyle: "deepseek", // 4.82: 思考参数方言 —— DeepSeek 官方形态
    needsReasoningHistory: true, // G1: 推理模型要求 assistant 历史带 reasoning_content(缺省补 "")
    retryOnBusy: true, // G1: 系统繁忙(429/503)自动重试一次
  },
  nvidia: {
    label: "nvidia-nim",
    endpoint: NVIDIA_ENDPOINT,
    keyEnv: "NVIDIA_API_KEY",
    // 4.82: 免费档改为"支持思考开关" —— NIM 基于 vLLM,对 deepseek 系模型用 chat_template_kwargs
    // 控制模板里的 thinking 分支(NIM 文档对 deepseek-v3.1 等即此用法);旧值 false 会让前端开关永远无效。
    // 上游若不接受该参数,worker 侧有 400 降级重试兜底(思考不生效但不会挂)。
    supportsThinking: true,
    thinkingStyle: "vllm",
    needsReasoningHistory: false,
    retryOnBusy: false,
  },
};

export function providerForMode(mode) {
  return mode === "fast" ? PROVIDERS.deepseek : PROVIDERS.nvidia;
}

// 模型列表端点由 chat 端点推导(OpenAI 兼容约定)
export function modelsEndpointFor(provider) {
  return String(provider.endpoint || "").replace(/\/chat\/completions$/, "/models");
}

// ────────────────────────────
// 模型 id 网关
// ────────────────────────────
// 格式校验:free 必须是 "厂商/模型" 且厂商在放行名单里;fast 必须是 deepseek 官方模型名。
// 不用精确白名单 —— 模型迭代太快,写死列表等于每次出新版都要改代码重部署。
export function isAllowedModelId(mode, id) {
  const s = String(id || "").trim();
  if (!s || s.length > 120 || /[\s"'`<>]/.test(s)) return false;
  if (isPlaceholderModelId(s)) return false; // 占位符永远不是合法模型
  if (mode === "fast") return /^deepseek-[a-z0-9._-]+$/i.test(s);
  return NIM_VENDOR_PREFIXES.some((p) => s.toLowerCase().startsWith(p));
}

// 2026-09-14 修:原来模型非法时**静默回落到内置占位符**并把它发到上游
// (`model: "__free_placeholder__"` → 上游返回难以理解的报错),而 data.js 的注释明确写着
// 占位符不应被发送。现在直接返回可操作的错误,不发上游。
export function resolveRequestedModel(mode, requestedModel, byo) {
  if (byo && byo.model) return { model: byo.model };
  const id = String(requestedModel || "").trim();
  if (id && isAllowedModelId(mode, id)) return { model: id };
  if (isPlaceholderModelId(id)) {
    return { error: "还没有选择模型:请点顶栏设置 →「模型 API」→ 拉取模型列表并选中一个(内置占位符不会发给上游)。" };
  }
  return { error: `模型 id 不合法或不属于当前模式(${mode}):「${id || "(空)"}」。请重新选择模型。` };
}

// ────────────────────────────
// BYO(自带端点直连)
// ────────────────────────────
// payload.customProvider = { endpoint, model, apiKey[, supportsThinking, needsReasoningHistory] }
// → 跳过 free/fast 白名单,直连用户自带的 OpenAI 兼容端点(GPT / Qwen / Kimi / 本地 vLLM 等)。
export function normalizeByoProvider(payload) {
  const c = payload && payload.customProvider;
  if (!c || typeof c !== "object") return null;
  const ep = typeof c.endpoint === "string" ? c.endpoint.trim() : "";
  const mdl = typeof c.model === "string" ? c.model.trim() : "";
  if (!ep || !mdl) return null; // endpoint + model 必填,缺一则回落内置 provider
  return {
    label: "byo-custom",
    endpoint: ep,
    model: mdl,
    apiKey: typeof c.apiKey === "string" ? c.apiKey.trim() : "", // 本地 vLLM/ollama 可留空
    keyEnv: null,
    supportsThinking: c.supportsThinking === true,
    thinkingStyle: "deepseek", // 4.82: BYO 保持 DeepSeek 形态(原行为不变);接本地 vLLM 若需 chat_template_kwargs 再扩展
    needsReasoningHistory: c.needsReasoningHistory === true,
    retryOnBusy: false,
  };
}

// ────────────────────────────
// 拉取上游模型列表(候选池用)
// ────────────────────────────
// 返回 { ok, models:[{id,label}], error? }(persona 不在这里产出 —— worker 拿到列表后按 id 现算补上)。
// 只做取数与过滤,不碰 HTTP 响应组装。
export async function fetchUpstreamModels(provider, apiKey, { timeoutMs = 20000, filter } = {}) {
  if (!apiKey) return { ok: false, error: "缺少 API Key" };
  const url = modelsEndpointFor(provider);
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return { ok: false, error: `上游返回 ${r.status}` };
    const j = await r.json().catch(() => null);
    const arr = (j && Array.isArray(j.data)) ? j.data : [];
    const models = arr
      .map((m) => ({ id: m && m.id, label: (m && m.id) || "" }))
      .filter((m) => m.id && (typeof filter === "function" ? filter(m.id) : true));
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
