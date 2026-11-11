// test/provider-models.mjs — 前端模型注册表契约（2026-11-11 免费档优化 A/B/C）
// 手法：node:vm 里加载 public/shared/providers.js（IIFE），用假 window/localStorage/fetch 跑，
//       零浏览器、零真实网络。钉死四件事：
//   ① 首次拉取：只勾 recommended 家族，其余不勾
//   ② 再次拉取：老模型的勾选状态不被改写，新模型按推荐策略
//   ③ 旧候选池迁移：只补勾，绝不批量关人
//   ④ 清单保质期：3 天过期 + 旧格式清单（无 recEra）视为过期
// 运行：node test/provider-models.mjs
import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'

const SRC = fs.readFileSync(new URL('../public/shared/providers.js', import.meta.url), 'utf8')

let passed = 0
const pass = (s) => { passed++; console.log('  ✓ ' + s) }

const DAY = 24 * 60 * 60 * 1000

function boot({ ls = {}, now = Date.now(), models = [] } = {}) {
  const store = new Map(Object.entries(ls))
  const timers = []
  const win = {
    listeners: {},
    __providers: null,
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn) },
    dispatchEvent() { return true },
  }
  const ctx = {
    window: win,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    fetch: async (url) => {
      const u = String(url)
      if (u.indexOf('/api/providers') >= 0) {
        return { ok: true, status: 200, json: async () => ({ ok: true, presets: [] }) }
      }
      if (u.indexOf('/api/models') >= 0) {
        return { ok: true, status: 200, json: async () => ({ ok: true, models: models.slice(), sourceTitle: 'NVIDIA 免费档' }) }
      }
      return { ok: false, status: 404, json: async () => null }
    },
    CustomEvent: function (t, o) { this.type = t; this.detail = (o || {}).detail },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimeout: () => {},
    console,
    Date: Object.assign(function () { return new Date(now) }, { now: () => now }),
    JSON, Math,
  }
  ctx.globalThis = ctx
  vm.createContext(ctx)
  vm.runInContext(SRC, ctx)
  return { P: win.__providers, store, timers, now }
}

const m = (id, recommended) => (recommended ? { id, label: id, recommended: true } : { id, label: id })

// ── ① 首次拉取：只勾推荐家族 ──────────────────────────────────────────
{
  const { P } = boot({
    models: [
      m('deepseek-ai/deepseek-v4.1-flash', true),
      m('nvidia/nemotron-3-super-120b-a12b', true),
      m('google/gemma-4-31b-it', false),
      m('z-ai/glm-5.3-flash', false),
    ],
  })
  await P.fetchModels('preset:nvidia')
  const all = P.modelsAll('preset:nvidia')
  assert.equal(all.length, 4)
  const on = all.filter((x) => x.enabled).map((x) => x.id).sort()
  assert.deepEqual(on, ['deepseek-ai/deepseek-v4.1-flash', 'nvidia/nemotron-3-super-120b-a12b'])
  pass('首次拉取 → 只默认勾 DeepSeek / Nemotron，其余留着手动勾')
}

// ── ② 再次拉取：老勾选不动，新模型按推荐策略 ────────────────────────
{
  const old = { v: 3, activeId: null, custom: [], presetsMeta: {}, updatedAt: 1, presets: {
    nvidia: {
      models: [m('google/gemma-4-31b-it'), m('z-ai/glm-5.3-flash')],
      disabled: { 'z-ai/glm-5.3-flash': 1 }, // 用户手动取消了 GLM
      fetchedAt: Date.now(), recEra: 1, legacyMigrated: true, defaultsV: 2,
    },
  } }
  const { P } = boot({
    ls: { cfw_providers_v3: JSON.stringify(old) },
    models: [
      m('google/gemma-4-31b-it', false),          // 老模型：用户勾着 → 保持勾
      m('z-ai/glm-5.3-flash', false),             // 老模型：用户取消 → 保持取消
      m('deepseek-ai/deepseek-v4.1-flash', true), // 新面孔+推荐 → 勾
      m('stepfun-ai/step-5-preview', false),      // 新面孔+不推荐 → 不勾
    ],
  })
  await P.fetchModels('preset:nvidia')
  const by = Object.fromEntries(P.modelsAll('preset:nvidia').map((x) => [x.id, x.enabled]))
  assert.equal(by['google/gemma-4-31b-it'], true, '老勾选被改写了')
  assert.equal(by['z-ai/glm-5.3-flash'], false, '用户手动取消的被勾回来了')
  assert.equal(by['deepseek-ai/deepseek-v4.1-flash'], true, '新推荐模型没勾上')
  assert.equal(by['stepfun-ai/step-5-preview'], false, '新非推荐模型不该默认勾')
  pass('再次拉取 → 老勾选不动 / 新模型按推荐策略 / 不覆盖用户手动取消')
}

// ── ③ 旧候选池迁移：只补勾，绝不批量关人 ────────────────────────────
{
  const { P } = boot({
    ls: { cfw_models_free_v1: JSON.stringify([{ id: 'z-ai/glm-5.3-flash' }]) },
    models: [
      m('deepseek-ai/deepseek-v4.1-flash', true),
      m('z-ai/glm-5.3-flash', false),
      m('google/gemma-4-31b-it', false),
    ],
  })
  await P.fetchModels('preset:nvidia')
  const by = Object.fromEntries(P.modelsAll('preset:nvidia').map((x) => [x.id, x.enabled]))
  assert.equal(by['z-ai/glm-5.3-flash'], true, '旧池里的模型应被补勾')
  assert.equal(by['deepseek-ai/deepseek-v4.1-flash'], true, '推荐家族应保持勾选')
  assert.equal(by['google/gemma-4-31b-it'], false)
  pass('旧候选池迁移 → 只补勾旧池模型，不把其它模型批量关掉')
}

// ── ④ 清单保质期 ────────────────────────────────────────────────────
{
  const now = Date.now()
  const base = { v: 3, activeId: null, custom: [], presetsMeta: {}, updatedAt: 1, presets: {
    nvidia: { models: [m('deepseek-ai/deepseek-v4.1-flash', true)], disabled: {}, fetchedAt: now - 1 * DAY, recEra: 1, legacyMigrated: true, defaultsV: 2 },
  } }
  const fresh = boot({ ls: { cfw_providers_v3: JSON.stringify(base) }, now })
  assert.equal(fresh.P.modelsStale('preset:nvidia'), false, '1 天前拉的不该算过期')

  const staleLs = JSON.parse(JSON.stringify(base))
  staleLs.presets.nvidia.fetchedAt = now - 4 * DAY
  const stale = boot({ ls: { cfw_providers_v3: JSON.stringify(staleLs) }, now })
  assert.equal(stale.P.modelsStale('preset:nvidia'), true, '4 天前拉的必须算过期')

  const legacyLs = JSON.parse(JSON.stringify(base))
  delete legacyLs.presets.nvidia.recEra // 旧版清单：没有推荐标记
  const legacy = boot({ ls: { cfw_providers_v3: JSON.stringify(legacyLs) }, now })
  assert.equal(legacy.P.modelsStale('preset:nvidia'), true, '旧格式清单应触发一次重拉')
  pass('清单保质期 → 3 天内不重拉 / 超期重拉 / 旧格式补拉一次')
}

// ── ⑤ 上游删掉的模型，本地下标跟着清 ────────────────────────────────
{
  const old = { v: 3, activeId: null, custom: [], presetsMeta: {}, updatedAt: 1, presets: {
    nvidia: {
      models: [m('z-ai/glm-5.3-flash'), m('gone/model-x')],
      disabled: { 'gone/model-x': 1, 'z-ai/glm-5.3-flash': 1 },
      fetchedAt: Date.now(), recEra: 1, legacyMigrated: true, defaultsV: 2,
    },
  } }
  const { P, store } = boot({ ls: { cfw_providers_v3: JSON.stringify(old) }, models: [m('z-ai/glm-5.3-flash', false)] })
  await P.fetchModels('preset:nvidia')
  const st = JSON.parse(store.get('cfw_providers_v3'))
  assert.ok(!('gone/model-x' in st.presets.nvidia.disabled), '已下线模型的残留下标应被清掉')
  pass('模型下线 → 本地 disabled 下标随之清理（不会越滚越大）')
}

console.log(`\n前端模型注册表契约全部通过：${passed} 组断言`)
