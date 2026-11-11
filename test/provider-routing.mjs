// test/provider-routing.mjs — 渠道路由矩阵单测（批 E1：不写死 DeepSeek/NVIDIA）
// 手法：mock 全局 fetch，捕获 worker 真正发往上游的 URL/鉴权/请求体；零真实网络。
// 运行：node test/provider-routing.mjs
import worker from '../src/worker.js'
import { PRESET_PROVIDERS } from '../src/model/providers.js'
import assert from 'node:assert/strict'

const calls = []
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url)
  calls.push({
    url: u,
    auth: String((opts.headers && opts.headers.Authorization) || ''),
    body: (() => { try { return JSON.parse(opts.body || '{}') } catch { return {} } })(),
  })
  if (u.endsWith('/models')) {
    return new Response(JSON.stringify({ data: [
      { id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }, { id: 'gpt-4o' }, { id: '__x_placeholder__' },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return new Response(JSON.stringify({
    id: 'x', object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

const env = { DEEPSEEK_API_KEY: 'ds-fake-key', NVIDIA_API_KEY: 'nv-fake-key', CHAT_PASSWORD: '' }
let passed = 0
const pass = (s) => { passed++; console.log('  ✓ ' + s) }

async function api(path, payload) {
  calls.length = 0
  const r = await worker.fetch(new Request('https://x' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  }), env)
  return { status: r.status, body: await r.text() }
}
async function get(path) {
  calls.length = 0
  const r = await worker.fetch(new Request('https://x' + path, { method: 'GET' }), env)
  return { status: r.status, body: await r.text() }
}
async function chat(payload) {
  const r = await api('/api/chat', { messages: [{ role: 'user', content: 'hi' }], stream: false, ...payload })
  return { ...r, last: calls[calls.length - 1] }
}
const DS = 'https://api.deepseek.com/v1/chat/completions'
const NV = 'https://integrate.api.nvidia.com/v1/chat/completions'

// ===== 1. mode 别名（向后兼容路径）=====
{
  const r = await chat({ mode: 'fast', model: 'deepseek-flash' })
  assert.equal(r.status, 200, r.body.slice(0, 200))
  assert.equal(r.last.url, DS); assert.equal(r.last.auth, 'Bearer ds-fake-key'); assert.equal(r.last.body.model, 'deepseek-flash')
  pass('mode=fast + deepseek-flash → DeepSeek 官方 + env 钥匙')
}
{
  const r = await chat({ mode: 'free', model: 'deepseek-ai/deepseek-v4.1-flash' })
  assert.equal(r.status, 200)
  assert.equal(r.last.url, NV); assert.equal(r.last.auth, 'Bearer nv-fake-key'); assert.equal(r.last.body.model, 'deepseek-ai/deepseek-v4.1-flash')
  pass('mode=free + nvidia 模型 → NVIDIA 免费档 + env 钥匙')
}

// ===== 2. providerId 预设路由（压过 mode）=====
{
  const r = await chat({ mode: 'fast', providerId: 'preset:nvidia', model: 'deepseek-ai/deepseek-v4.1-flash' })
  assert.equal(r.status, 200); assert.equal(r.last.url, NV)
  pass('providerId=preset:nvidia 压过 mode=fast → NVIDIA')
}
{
  const r = await chat({ mode: 'free', providerId: 'deepseek', model: 'deepseek-flash' })
  assert.equal(r.status, 200); assert.equal(r.last.url, DS)
  pass('providerId=deepseek 压过 mode=free → DeepSeek')
}

// ===== 3. 空选/占位符 → 渠道默认模型兜底 =====
{
  const r = await chat({ mode: 'free' })
  assert.equal(r.status, 200); assert.equal(r.last.url, NV); assert.equal(r.last.body.model, 'deepseek-ai/deepseek-v4.1-flash')
  pass('空选 + NVIDIA 预设 → 默认模型兜底（新装开箱即用）')
}
{
  const r = await chat({ mode: 'fast', model: '__fast_placeholder__' })
  assert.equal(r.status, 200); assert.equal(r.last.body.model, 'deepseek-flash')
  pass('占位符 → DeepSeek 预设默认模型兜底')
}

// ===== 4. 不对口的模型 id → 400 可操作错误（不静默换模型）=====
{
  const r = await chat({ mode: 'fast', model: 'foo-bar' })
  assert.equal(r.status, 400); assert.ok(r.body.includes('不属于当前渠道'), r.body)
  pass('fast 渠道发非 deepseek-* 模型 → 400 带渠道名提示')
}

// ===== 5. BYO 自定义端点（原能力不变）=====
{
  const r = await chat({ mode: 'fast', customProvider: { endpoint: 'http://127.0.0.1:9/v1/chat/completions', model: 'my-model', apiKey: '' } })
  assert.equal(r.status, 200)
  assert.equal(r.last.url, 'http://127.0.0.1:9/v1/chat/completions'); assert.equal(r.last.body.model, 'my-model')
  pass('customProvider → 直连自带端点（空 key 允许）')
}

// ===== 6. /api/models 按渠道拉取 + 白名单过滤 =====
{
  const r = await get('/api/models?provider=preset:deepseek')
  const d = JSON.parse(r.body)
  assert.equal(d.ok, true); assert.equal(d.provider, 'deepseek')
  assert.deepEqual(d.models.map((m) => m.id), ['deepseek-flash', 'deepseek-v4-pro'])
  pass('/api/models?provider=preset:deepseek → 只回 deepseek-*（gpt-4o/占位符被滤）')
}
{
  const r = await get('/api/models?mode=fast')
  const d = JSON.parse(r.body)
  assert.equal(d.provider, 'deepseek')
  pass('/api/models?mode=fast 兼容口径 → 仍解析为 deepseek 预设')
}

// ===== 6b. /api/providers 注册表元数据（供应商管理页数据源）=====
{
  const r = await get('/api/providers')
  const d = JSON.parse(r.body)
  assert.equal(d.ok, true)
  const ds = d.presets.find((p) => p.id === 'deepseek')
  const nv = d.presets.find((p) => p.id === 'nvidia')
  assert.ok(ds && nv, r.body.slice(0, 300))
  assert.equal(ds.label, 'deepseek-official'); assert.equal(ds.title, 'DeepSeek 官方')
  assert.equal(nv.title, 'NVIDIA 免费档')
  // 外部标识必须 latin-1 安全（会进响应头/URL 参数）—— 中文只能待在 title 里
  for (const p of d.presets) assert.ok(/^[\x20-\x7e]+$/.test(p.label), 'label 非 ASCII: ' + p.label)
  assert.equal(ds.configured, true); assert.equal(ds.defaultModel, 'deepseek-flash')
  pass('/api/providers → 预设元数据（label=ASCII 标识 / title=中文显示名 / configured）')
}

// ===== 7. summarize 路由：无渠道信息仍默认 DeepSeek；带 providerId 则跟随 =====
{
  const r = await api('/api/summarize', { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] })
  assert.equal(r.status, 200)
  assert.equal(calls[0].url, DS)
  assert.equal(calls[0].body.model, 'deepseek-flash')
  pass('summarize 旧调用（无 mode）→ 默认 DeepSeek + 默认模型')
}
{
  const r = await api('/api/summarize', { mode: 'free', messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] })
  assert.equal(r.status, 200)
  assert.equal(calls[0].url, NV)
  pass('summarize 带 mode=free → 跟随频道（NVIDIA）')
}

// ===== 8. 渠道数据字段：首字节预算（E1d 实测钉死——NIM 冷启动 38s，流式路径必须给足） =====
{
  assert.ok((PRESET_PROVIDERS.nvidia.ttfbTimeoutMs || 0) >= 60000, 'NIM 首字节预算须 ≥60s')
  assert.ok((PRESET_PROVIDERS.deepseek.ttfbTimeoutMs || 0) >= 20000, 'DeepSeek 首字节预算须 ≥20s')
  pass('渠道注册表 ttfbTimeoutMs（NIM 90s / DeepSeek 20s）')
}

// ===== 9. 上游「模型已下线」归类（E1d：404 根因钉死 + 前端自愈入口） =====
{
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "Model Not Exist" } }), { status: 404, headers: { "content-type": "application/json" } });
  const r = await chat({ mode: 'fast', model: 'deepseek-ghost-x' }); // 过白名单但上游已删 = 用户遇到的那类 404
  globalThis.fetch = orig;
  assert.equal(r.status, 400, r.body.slice(0, 200));
  const d = JSON.parse(r.body);
  assert.equal(d.code, 'model_not_found');
  assert.ok(/选择新模型/.test(d.error), d.error);
  pass('上游 404「Model Not Exist」→ 400 model_not_found（前端凭此挂自愈按钮）')
}
{
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response("Internal Error", { status: 500 });
  const r = await chat({ mode: 'fast', model: 'deepseek-flash' });
  globalThis.fetch = orig;
  assert.equal(r.status, 502); assert.ok(r.body.includes("Upstream error 500"), r.body);
  pass('上游 500 → 仍只回状态码（不回显原文）')
}

// ===== 10. 免费档模型口径（2026-11-11：全厂商放行 + 非对话黑名单 + 推荐标记）=====
// 用一份"混着新厂商/向量/审核模型"的 NIM 目录，验证三件事都成立：
//   ① 以前被厂商白名单挡住的 google/gemma-4-31b-it 现在能进清单；
//   ② embed/guard/parse 这类不能聊天的仍然被挡；
//   ③ recommended 标记透传（前端靠它决定默认勾选，只认这一份规则）。
{
  const orig = globalThis.fetch
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url)
    if (u.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [
        { id: 'deepseek-ai/deepseek-v4.1-flash' },
        { id: 'nvidia/nemotron-3-super-120b-a12b' },
        { id: 'google/gemma-4-31b-it' },            // 新厂商：旧白名单会整家挡掉
        { id: 'stepfun-ai/step-5-preview' },        // 同上
        { id: 'nvidia/nemotron-3-embed-1b' },       // 向量模型：必须挡
        { id: 'meta/llama-guard-4-12b' },           // 审核模型：必须挡
        { id: 'nvidia/nemotron-parse' },            // 版面解析：必须挡
      ] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({
      id: 'x', object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const r = await get('/api/models?provider=nvidia')
  const d = JSON.parse(r.body)
  globalThis.fetch = orig
  const ids = d.models.map((m) => m.id)
  assert.ok(ids.includes('google/gemma-4-31b-it'), '新厂商应放行: ' + ids.join(','))
  assert.ok(ids.includes('stepfun-ai/step-5-preview'), '新厂商应放行: ' + ids.join(','))
  assert.ok(!ids.includes('nvidia/nemotron-3-embed-1b'), '向量模型不该进清单')
  assert.ok(!ids.includes('meta/llama-guard-4-12b'), '审核模型不该进清单')
  assert.ok(!ids.includes('nvidia/nemotron-parse'), '解析模型不该进清单')
  const by = Object.fromEntries(d.models.map((m) => [m.id, m.recommended]))
  assert.equal(by['deepseek-ai/deepseek-v4.1-flash'], true, 'DeepSeek 应标推荐')
  assert.equal(by['nvidia/nemotron-3-super-120b-a12b'], true, 'Nemotron 应标推荐')
  assert.equal(by['google/gemma-4-31b-it'], false, 'Gemma 不默认勾选')
  pass('/api/models?provider=nvidia → 全厂商放行 / 非对话仍挡 / recommended 透传')
}
{
  // 新放行的模型必须能真正走到网关（旧版会被"不属于当前渠道"拦成 400）
  const r = await chat({ mode: 'free', model: 'nvidia/nemotron-3-super-120b-a12b' })
  assert.equal(r.status, 200, r.body.slice(0, 200))
  assert.equal(r.last.url, NV); assert.equal(r.last.body.model, 'nvidia/nemotron-3-super-120b-a12b')
  pass('放行后的新模型能过网关照常发往 NIM')
}

console.log(`\n路由矩阵全部通过：${passed} 组断言`)
