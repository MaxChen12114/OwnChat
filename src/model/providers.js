// src/model/providers.js
// ═══════════════════════════════════════════════════════════════════════
// 模型「提供方」逻辑 —— 渠道注册表 / 统一解析 / 模型 id 网关 / BYO 归一化
// ═══════════════════════════════════════════════════════════════════════
// 与 ./data.js 的分工:这里放**逻辑**(会随架构变),那里放**表**(会随上游变)。
// worker.js 只负责 HTTP 层(读请求 / 组装响应),模型域的判断都收在这里。
//
// 2026-10-13 (批 E1 渠道体系重构):不再"写死 DeepSeek/NVIDIA 两模式分支"——
//   · 预设 = PRESET_PROVIDERS 数据表(新增渠道=加一条;能力位/白名单/默认模型全字段驱动)
//   · 请求经 resolveProvider() 统一解析: BYO 自带 > payload.providerId 预设 > mode 别名(向后兼容)
//   · 空选/占位符 → 渠道 defaultModel 兜底(新行为;旧版直接报"还没选模型",新装可开箱即用)
//   · mode 字段保留为"预设指针的兼容别名"——旧客户端/历史本地存储无需改动
import { NIM_VENDOR_PREFIXES, isPlaceholderModelId } from "./data.js";

// ────────────────────────────
// 端点常量 + 预设渠道注册表（数据形态）
// ────────────────────────────
// 2026-06-14 (4.69 G2/G4) 原注册表保留形状;2026-10-13 补 id/label 人话名/白名单口径/默认模型。
// label 纪律(2026-10-11 立):label 会透传进响应头 X-Upstream(worker handleChat),
// HTTP 头是 latin-1 —— 中文 label 让 Node/undici 抛 ByteString 异常。所以 label=ASCII 外部标识,
// 给人看的中文放 title(UI/错误提示取 title||label)。
const NVIDIA_ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions";
const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/v1/chat/completions";

export const PRESET_PROVIDERS = {
  deepseek: {
    id: "deepseek",
    label: "deepseek-official", // ASCII：进响应头/接口用
    title: "DeepSeek 官方", // 中文显示名：UI/错误提示用
    endpoint: DEEPSEEK_ENDPOINT,
    keyEnv: "DEEPSEEK_API_KEY",
    supportsThinking: true, // thinking:{type} + reasoning_effort
    thinkingStyle: "deepseek", // 4.82: 思考参数方言 —— DeepSeek 官方形态
    needsReasoningHistory: true, // G1: 推理模型要求 assistant 历史带 reasoning_content(缺省补 "")
    retryOnBusy: true, // G1: 系统繁忙(429/503)自动重试一次
    modelRegex: /^deepseek-[a-z0-9._-]+$/i, // 模型 id 白名单（正则口径）
    // 2026-10 上游实名实测: deepseek-flash(V4.1-Flash, 1M ctx, 支持图像输入) / deepseek-v4-pro
    defaultModel: "deepseek-flash",
    ttfbTimeoutMs: 20000, // 首字节预算：官方直连快（流式路径默认值不变）
  },
  nvidia: {
    id: "nvidia",
    label: "nvidia-nim", // ASCII：进响应头/接口用
    title: "NVIDIA 免费档", // 中文显示名：UI/错误提示用
    endpoint: NVIDIA_ENDPOINT,
    keyEnv: "NVIDIA_API_KEY",
    // 4.82: 免费档改为"支持思考开关" —— NIM 基于 vLLM,对 deepseek 系模型用 chat_template_kwargs
    // 控制模板里的 thinking 分支(NIM 文档对 deepseek-v3.1 等即此用法);旧值 false 会让前端开关永远无效。
    // 上游若不接受该参数,worker 侧有 400 降级重试兜底(思考不生效但不会挂)。
    supportsThinking: true,
    thinkingStyle: "vllm",
    needsReasoningHistory: false,
    retryOnBusy: false,
    modelPrefixes: NIM_VENDOR_PREFIXES, // 厂商前缀白名单(NIM 上百模型,过宽=候选池糊屏)
    defaultModel: "deepseek-ai/deepseek-v4.1-flash", // 本账户 2026-10-13 实测稳定可用
    // 2026-10-13 (E1d 实测钉死): NIM 免费档冷启动首字节可达 38s(直连实测),流式路径的
    // 20s 默认预算会把自己掐成 502 "Upstream error 504"。免费档给 90s 首字节预算
    // (仍低于 CF 边缘 ~100s 阈值;流式体一旦开始就由心跳接管)。
    ttfbTimeoutMs: 90000,
  },
};

// mode → 预设 的兼容映射（"免费/快速"两个 pill = 两个预设的快捷位）
export const MODE_TO_PRESET = { fast: "deepseek", free: "nvidia" };

// 兼容别名：旧引用点(如 summarize)仍可直接取 PROVIDERS.deepseek
export const PROVIDERS = PRESET_PROVIDERS;

export function providerForMode(mode) {
  return PRESET_PROVIDERS[MODE_TO_PRESET[mode] || "deepseek"];
}

// ────────────────────────────
// 统一解析：{ provider, isCustom }
// ────────────────────────────
// 优先级: BYO 自带端点 > payload.providerId(预设 id / "preset:<id>") > payload.mode 别名 > 默认预设。
// 返回的 provider 对象形状与旧 PROVIDERS 条目一致(BYO 多 model/apiKey 字段,旧行为不变)。
export function normalizeProviderId(raw) {
  const s = String(raw || "").trim().replace(/^preset:/, "");
  return /^[a-z][a-z0-9_-]{0,31}$/.test(s) ? s : "";
}

export function resolveProvider(payload) {
  const byo = normalizeByoProvider(payload);
  if (byo) return { provider: byo, isCustom: true };
  const pid = normalizeProviderId(payload && payload.providerId);
  if (pid && PRESET_PROVIDERS[pid]) return { provider: PRESET_PROVIDERS[pid], isCustom: false };
  const mode = payload && payload.mode === "fast" ? "fast" : "free";
  return { provider: providerForMode(mode), isCustom: false };
}

// ────────────────────────────
// 模型 id 网关（按渠道判定）
// ────────────────────────────
// 不用精确白名单 —— 模型迭代太快,写死列表等于每次出新版都要改代码重部署。
export function isAllowedModelIdFor(provider, isCustom, id) {
  const s = String(id || "").trim();
  if (!s || s.length > 120 || /[\s"'`<>]/.test(s)) return false;
  if (isPlaceholderModelId(s)) return false; // 占位符永远不是合法模型
  if (isCustom) return true; // 自定义端点:格式合法即放行(端点在用户手里)
  if (provider && provider.modelRegex) return provider.modelRegex.test(s);
  if (provider && Array.isArray(provider.modelPrefixes)) {
    return provider.modelPrefixes.some((p) => s.toLowerCase().startsWith(p));
  }
  return false;
}

// 兼容旧签名（/api/models 的过滤仍按 mode 调用）
export function isAllowedModelId(mode, id) {
  return isAllowedModelIdFor(providerForMode(mode), false, id);
}

// ────────────────────────────
// 模型解析（cfg = resolveProvider 的返回值）
// ────────────────────────────
// 2026-09-14 立:原来非法 id 会**静默回落到内置占位符**并发到上游 → 用户看到的是上游的费解报错;
// 现在返回可操作的错误提示。
// 2026-10-13 改:空/占位符不再直接报错 —— 有 defaultModel 的预设走兜底(新装直接能用);
// 非空但不对口的 id 仍报错(不静默换模型,避免"我明明选了 A 它却用 B")。
export function resolveRequestedModel(cfg, requestedModel) {
  const provider = cfg && cfg.provider;
  const isCustom = !!(cfg && cfg.isCustom);
  const id = String(requestedModel || "").trim();

  if (isCustom) {
    if (provider && provider.model) return { model: provider.model }; // BYO 自带 model 优先(原行为)
    if (isPlaceholderModelId(id)) {
      return { error: "还没有选择模型:请在设置→模型渠道里为这个自定义渠道选一个模型。" };
    }
    if (isAllowedModelIdFor(provider, true, id)) return { model: id };
    return { error: `模型 id 不合法:「${id || "(空)"}」。` };
  }

  if (id && !isPlaceholderModelId(id)) {
    if (isAllowedModelIdFor(provider, false, id)) return { model: id };
    const name = provider ? (provider.title || provider.label) : "?";
    return {
      error: `模型 id 不属于当前渠道(${name}):「${id}」。请切换渠道或重选模型。`,
    };
  }
  if (provider && provider.defaultModel) return { model: provider.defaultModel, usedDefault: true };
  return { error: "还没有选择模型:请点顶栏设置 →「模型渠道」→ 拉取模型列表并选中一个。" };
}

// ────────────────────────────
// 模型列表端点推导（OpenAI 兼容约定）
// ────────────────────────────
export function modelsEndpointFor(provider) {
  return String(provider.endpoint || "").replace(/\/chat\/completions$/, "/models");
}

// ────────────────────────────
// BYO(自带端点直连)
// ────────────────────────────
// payload.customProvider = { endpoint, model, apiKey[, supportsThinking, needsReasoningHistory] }
// → 跳过预设白名单,直连用户自带的 OpenAI 兼容端点(GPT / Qwen / Kimi / 本地 vLLM 等)。
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
