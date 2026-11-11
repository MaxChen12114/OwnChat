/* sim-kernel/rules.mjs — L2 现象·规则包加载与校验
   规格 §4：规则包 = JSON 组合内核核函数，不含代码。
   校验哲学：一次报全部错误（不抛栈），每条都是人话——哪条 pass、哪个字段、
   为什么、合法值是什么。加载失败的规则包不该让作者猜。
   通过后产出"装载计划"（plan）：核函数绑定 + period + 解析后的参数，
   供 passes.mjs / kernel.mjs 注册执行。 */

import { addKernel, decayKernel, downhillKernel } from './kernels/field.mjs';
import { diffuseKernel, clampKernel, smoothKernel } from './kernels/field2.mjs';

/* 内置核函数注册表（自定义核函数由 registerKernel 追加——唯一允许改内核的入口） */
export const KERNELS = Object.freeze({
  add: addKernel,
  decay: decayKernel,
  downhill: downhillKernel,
  diffuse: diffuseKernel,
  clamp: clampKernel,
  smooth: smoothKernel,
});

const customKernels = new Map();
export function registerKernel(name, fn) {
  if (typeof fn !== 'function') throw new TypeError(`registerKernel("${name}") 需要函数`);
  customKernels.set(name, fn);
}
function kernelOf(name) {
  return KERNELS[name] || customKernels.get(name) || null;
}

const LEGAL_KEYS = ['id', 'schemaVersion', 'kernelVersion', 'fields', 'params', 'passes', 'costs', 'metrics', 'events', 'order'];
const BOUNDS = new Set(['wall', 'wrap', 'absorb']);

/* 解析参数值：数字直接用；"${name}" 从 params 取；其余报错 */
function resolveParam(ruleId, passIdx, key, value, params, errors) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const m = value.match(/^\$\{([A-Za-z0-9_]+)\}$/);
    if (m) {
      const p = params[m[1]];
      if (p === undefined) {
        errors.push(`passes[${passIdx}] ("${ruleId}") 的 ${key}="${value}" 引用了不存在的参数 "${m[1]}"（params 里可用的: ${Object.keys(params).join(', ') || '无'}）`);
        return null;
      }
      if (typeof p !== 'number' || !Number.isFinite(p)) {
        errors.push(`passes[${passIdx}] ("${ruleId}") 的 ${key} 引用的参数 "${m[1]}" 不是有限数字，得到 ${JSON.stringify(p)}`);
        return null;
      }
      return p;
    }
  }
  errors.push(`passes[${passIdx}] ("${ruleId}") 的 ${key}=${JSON.stringify(value)} 非法——必须是数字或 "\${参数名}"`);
  return null;
}

export function validateRulePack(pack, { knownFields = [] } = {}) {
  const errors = [];
  const plan = { id: null, fields: [], passes: [], costs: [], order: 0 };

  if (!pack || typeof pack !== 'object' || Array.isArray(pack)) {
    return { ok: false, errors: ['规则包必须是 JSON 对象'], plan: null };
  }
  // 顶层键（拼写错误是最常见事故——"pass" vs "passes"）
  for (const k of Object.keys(pack)) {
    if (!LEGAL_KEYS.includes(k)) errors.push(`未知顶层键 "${k}"（合法: ${LEGAL_KEYS.join(', ')}）——是拼写错误吗？`);
  }
  // id / schemaVersion
  if (typeof pack.id !== 'string' || !pack.id.trim()) errors.push('缺少 id 或 id 不是非空字符串');
  else plan.id = pack.id;
  if (pack.schemaVersion !== 1) errors.push(`schemaVersion 必须是 1，得到 ${JSON.stringify(pack.schemaVersion)}`);
  if (typeof pack.order === 'number') plan.order = pack.order;

  // fields：声明本包注册/使用的场
  const declared = new Set();
  if (pack.fields && typeof pack.fields === 'object') {
    for (const [name, cfg] of Object.entries(pack.fields)) {
      const bounds = cfg && cfg.bounds ? cfg.bounds : 'wall';
      if (!BOUNDS.has(bounds)) {
        errors.push(`fields."${name}" 的 bounds "${bounds}" 不合法（可用: ${[...BOUNDS].join('/')}）`);
      }
      plan.fields.push({ name, bounds });
      declared.add(name);
    }
  } else if (pack.fields !== undefined) {
    errors.push('fields 必须是对象（场名 → {bounds}）');
  }
  for (const f of knownFields) declared.add(f);   // 其他包已注册的共享场（L3 耦合）

  // params
  const params = (pack.params && typeof pack.params === 'object') ? pack.params : {};

  // passes
  if (!Array.isArray(pack.passes)) {
    errors.push('passes 必须是数组（哪怕只有一个 pass）');
  } else if (pack.passes.length === 0) {
    errors.push('passes 是空数组——一个没有任何现象的规则包没有意义');
  } else {
    pack.passes.forEach((p, idx) => {
      if (!p || typeof p !== 'object') { errors.push(`passes[${idx}] 不是对象`); return; }
      const kn = p.kernel;
      const fn = kernelOf(kn);
      if (!fn) {
        errors.push(`passes[${idx}] 的 kernel "${kn}" 不存在（已知: ${[...Object.keys(KERNELS), ...customKernels.keys()].join(', ')}）`);
        return;
      }
      const target = p.target;
      if (!declared.has(target)) {
        errors.push(`passes[${idx}] 的 target "${target}" 未声明为本包 fields，也不在已注册场里（已声明: ${[...declared].join(', ') || '无'}）`);
        return;
      }
      const period = p.period == null ? 1 : p.period;
      if (!(Number.isInteger(period) && period >= 1)) {
        errors.push(`passes[${idx}] 的 period 必须是正整数，得到 ${JSON.stringify(p.period)}`);
        return;
      }
      // 其余键 → 核函数参数（保留保留字外的全部）
      const reserved = new Set(['kernel', 'target', 'period']);
      const args = {};
      let okPass = true;
      for (const [k, v] of Object.entries(p)) {
        if (reserved.has(k)) continue;
        const resolved = resolveParam(plan.id || '?', idx, k, v, params, errors);
        if (resolved === null) okPass = false;
        else args[k] = resolved;
      }
      if (okPass) plan.passes.push({ kernel: kn, fn, target, period, params: args });
    });
  }

  // costs：场 → 代价规则
  if (pack.costs !== undefined) {
    if (!Array.isArray(pack.costs)) errors.push('costs 必须是数组');
    else {
      pack.costs.forEach((c, idx) => {
        if (!c || typeof c !== 'object') { errors.push(`costs[${idx}] 不是对象`); return; }
        if (!declared.has(c.from)) {
          errors.push(`costs[${idx}] 的 from "${c.from}" 不是已声明的场（已声明: ${[...declared].join(', ') || '无'}）`);
          return;
        }
        const ops = new Set(['>', '<', '>=', '<=', '==', '!=']);
        if (!Array.isArray(c.when) || c.when.length !== 2 || !ops.has(c.when[0])) {
          errors.push(`costs[${idx}] 的 when 必须是 [op, 值]，op ∈ ${[...ops].join(' ')}`);
          return;
        }
        const thr = resolveParam(plan.id || '?', `costs[${idx}]`, 'when[1]', c.when[1], params, errors);
        if (thr === null) return;
        let cost = Infinity;
        if (c.cost !== undefined) {
          cost = (c.cost === 'Infinity') ? Infinity : resolveParam(plan.id || '?', `costs[${idx}]`, 'cost', c.cost, params, errors);
          if (cost === null) return;
        }
        plan.costs.push({ from: c.from, op: c.when[0], at: thr, cost });
      });
    }
  }

  plan.ok = errors.length === 0;
  return { ok: errors.length === 0, errors, plan: errors.length === 0 ? plan : null };
}

/* load：校验失败 → 抛出聚合人话错误（一次报全部），成功 → 返回 plan */
export function loadRulePack(pack, opts = {}) {
  const { ok, errors, plan } = validateRulePack(pack, opts);
  if (!ok) {
    const e = new Error(`规则包 "${pack && pack.id || '?'}" 有 ${errors.length} 处问题：\n  - ` + errors.join('\n  - '));
    e.found = errors;
    throw e;
  }
  return plan;
}
