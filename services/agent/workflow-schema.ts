/**
 * B7 workflow pack schema validator (v1). The pack is declarative data — no code execution:
 * { name, version:1, inputs:["topic"], steps:[...], outputs:["s3"], timeoutMs? }.
 * Steps are prompt / tool / condition; `{{name}}` may only reference an input or a step id that
 * appears BEFORE the current step (no forward references). Hard bounds: 20 steps, 10 minutes,
 * condition targets must exist. A `condition` op is one of contains/equals/not_equals/exists/
 * not_exists.
 *
 * Zero browser globals: the only value export is a factory. The classic binding in
 * tooling/l0/wiring/workflow-schema.js publishes the frozen `window.__workflowSchema` contract and resolves
 * nothing lazily — every function here is pure over unknown JSON, bridged through recOf/arrOf.
 * @module services/agent/workflow-schema
 */

const MAX_STEPS = 20;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const STEP_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const CONDITION_OPS = ["contains", "equals", "not_equals", "exists", "not_exists"];

/** unknown JSON -> plain-object view; null, arrays and scalars become an empty object. */
function recOf(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const entries = Object.entries(v);
    for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  }
  return out;
}

/** unknown JSON -> array view; anything else is empty. */
function arrOf(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** A field-level verdict. Extra keys carry id/ref/index/target/name context. */
export interface Issue {
  code: string;
  [key: string]: unknown;
}

/** Raw steps are kept as-is: reference/jump checks read them through recOf on the runner side. */
export interface ValidatedWorkflow {
  name: string;
  version: 1;
  inputs: unknown[];
  steps: unknown[];
  outputs: unknown[];
  timeoutMs: number;
}

export interface ValidationResult {
  ok: boolean;
  workflow?: ValidatedWorkflow;
  errors: Issue[];
  warnings: Issue[];
}

export interface WorkflowSchema {
  validateWorkflow(input: unknown, opts?: unknown): ValidationResult;
  interpolate(template: unknown, vars: unknown): { ok: boolean; text: string; missing: string[] };
  interpolateDeep(value: unknown, vars: unknown, missing: string[]): unknown;
  extractRefs(text: unknown): string[];
  evalCondition(left: unknown, op: unknown, right: unknown): boolean;
  _limits: { maxSteps: number; maxTimeoutMs: number };
  _findStep(steps: unknown[], id: string): Record<string, unknown> | null;
}

/** All `{{name}}` references, trimmed and de-duplicated in order of first appearance. */
function extractRefs(text: unknown): string[] {
  const out: string[] = [];
  const seen: Record<string, boolean> = {};
  const re = /\{\{\s*([^{}]+?)\s*\}\}/g;
  const s = String(text == null ? "" : text);
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const name = m[1].trim();
    if (name && !seen[name]) {
      seen[name] = true;
      out.push(name);
    }
  }
  return out;
}

function checkRefs(text: unknown, allowed: Record<string, boolean>, stepId: string, field: string, errors: Issue[]): void {
  const refs = extractRefs(text);
  for (let i = 0; i < refs.length; i++) {
    if (!allowed[refs[i]]) {
      errors.push({
        code: "UNKNOWN_REF",
        id: stepId,
        field: field,
        ref: refs[i],
        message: "引用了未定义或后置的变量: " + refs[i],
      });
    }
  }
}

/** Walk strings inside nested args objects/arrays and check every reference they carry. */
function checkRefsDeep(value: unknown, allowed: Record<string, boolean>, stepId: string, field: string, errors: Issue[]): void {
  if (typeof value === "string") {
    checkRefs(value, allowed, stepId, field, errors);
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) checkRefsDeep(value[i], allowed, stepId, field, errors);
    return;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    for (let i = 0; i < entries.length; i++) checkRefsDeep(entries[i][1], allowed, stepId, field + "." + entries[i][0], errors);
  }
}

/** tools may be an array, a predicate, or a {get(name)} registry; absent means "do not check". */
function toolExists(tools: unknown, name: string): boolean {
  if (!tools) return true;
  if (Array.isArray(tools)) return tools.indexOf(name) >= 0;
  if (typeof tools === "function") return !!Reflect.apply(tools, undefined, [name]);
  if (tools && typeof tools === "object") {
    const get = recOf(tools).get;
    if (typeof get === "function") return !!Reflect.apply(get, tools, [name]);
  }
  return true;
}

/** Last step with the given id, or null. Kept on the frozen namespace for pack authors. */
function findStep(steps: unknown[], id: string): Record<string, unknown> | null {
  for (let i = 0; i < steps.length; i++) {
    const s = recOf(steps[i]);
    if (s.id === id) return s;
  }
  return null;
}

function validateWorkflow(input: unknown, opts?: unknown): ValidationResult {
  const o = recOf(opts);
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: [{ code: "BAD_ROOT", message: "工作流必须是对象" }], warnings };
  }
  const root = recOf(input);

  const name = root.name;
  if (typeof name !== "string" || !name.trim()) {
    errors.push({ code: "BAD_NAME", field: "name", message: "name 必须是非空字符串" });
  } else if (name.length > 100) {
    errors.push({ code: "BAD_NAME", field: "name", message: "name 不能超过 100 字" });
  }

  const version = root.version == null ? 1 : root.version;
  if (version !== 1) {
    errors.push({ code: "UNSUPPORTED_VERSION", field: "version", message: "v1 只支持 version=1" });
  }

  const inputsRaw = root.inputs;
  let inputs: unknown[];
  if (inputsRaw == null) inputs = [];
  else if (!Array.isArray(inputsRaw)) {
    errors.push({ code: "BAD_INPUTS", field: "inputs", message: "inputs 必须是字符串数组" });
    inputs = [];
  } else inputs = inputsRaw;

  const inputSeen: Record<string, boolean> = {};
  for (let ii = 0; ii < inputs.length; ii++) {
    const iv = inputs[ii];
    if (typeof iv !== "string" || !iv.trim()) {
      errors.push({ code: "BAD_INPUTS", field: "inputs", index: ii, message: "inputs 的每一项必须是非空字符串" });
    } else if (inputSeen[iv]) {
      errors.push({ code: "DUPLICATE_INPUT", field: "inputs", name: iv, message: "输入名重复" });
    } else inputSeen[iv] = true;
  }

  const stepsRaw = root.steps;
  if (!Array.isArray(stepsRaw) || !stepsRaw.length) {
    errors.push({ code: "NO_STEPS", field: "steps", message: "steps 必须是非空数组" });
    return { ok: false, errors, warnings };
  }
  const steps: unknown[] = stepsRaw;
  if (steps.length > MAX_STEPS) {
    errors.push({ code: "TOO_MANY_STEPS", field: "steps", message: "步骤数超过 " + MAX_STEPS });
  }

  // Input names are visible from step 0; each step id joins only AFTER its own refs are checked.
  const allowed: Record<string, boolean> = {};
  for (let a = 0; a < inputs.length; a++) {
    const iv = inputs[a];
    if (typeof iv === "string" && iv.trim()) allowed[iv] = true;
  }

  const ids: Record<string, boolean> = {};
  for (let i = 0; i < steps.length; i++) {
    const raw = steps[i];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push({ code: "BAD_STEP", field: "steps", index: i, message: "步骤必须是对象" });
      continue;
    }
    const s = recOf(raw);
    const id = s.id;
    if (typeof id !== "string" || !STEP_ID_RE.test(id)) {
      errors.push({ code: "BAD_STEP_ID", field: "steps", index: i, message: "步骤 id 必须是 1-40 位字母/数字/下划线/短横线" });
      continue;
    }
    if (ids[id]) {
      errors.push({ code: "DUPLICATE_STEP_ID", field: "steps", id: id, message: "步骤 id 重复" });
      continue;
    }
    ids[id] = true;

    const type = s.type;
    if (type === "prompt") {
      const text = s.text;
      if (typeof text !== "string" || !text.trim()) {
        errors.push({ code: "BAD_PROMPT", field: "steps", id: id, message: "prompt 步骤需要非空 text" });
      } else checkRefs(text, allowed, id, "text", errors);
    } else if (type === "tool") {
      const tool = s.tool;
      if (typeof tool !== "string" || !tool.trim()) {
        errors.push({ code: "BAD_TOOL", field: "steps", id: id, message: "tool 步骤需要非空 tool 名" });
      } else if (!toolExists(o.tools, tool)) {
        errors.push({ code: "UNKNOWN_TOOL", field: "steps", id: id, tool: tool, message: "工具不存在: " + tool });
      }
      const args = s.args;
      if (args != null && (typeof args !== "object" || Array.isArray(args))) {
        errors.push({ code: "BAD_TOOL_ARGS", field: "steps", id: id, message: "tool.args 必须是对象" });
      } else if (args) checkRefsDeep(args, allowed, id, "args", errors);
    } else if (type === "condition") {
      const cond = s.if;
      if (typeof cond !== "string" || !cond.trim()) {
        errors.push({ code: "BAD_CONDITION", field: "steps", id: id, message: "condition 步骤需要非空 if" });
      } else checkRefs(cond, allowed, id, "if", errors);
      const op = s.op || "contains";
      if (typeof op !== "string" || CONDITION_OPS.indexOf(op) < 0) {
        errors.push({ code: "BAD_CONDITION_OP", field: "steps", id: id, op: op, message: "不支持的 condition op" });
      }
      if (typeof op === "string" && ["contains", "equals", "not_equals"].indexOf(op) >= 0 && typeof s.value !== "string") {
        errors.push({ code: "BAD_CONDITION_VALUE", field: "steps", id: id, message: "该 op 需要字符串 value" });
      }
      if (typeof s.value === "string") checkRefs(s.value, allowed, id, "value", errors);
    } else {
      errors.push({ code: "BAD_STEP_TYPE", field: "steps", id: id, type: type, message: "步骤类型必须是 prompt / tool / condition" });
    }
    allowed[id] = true; // references only point at inputs or earlier steps
  }

  // Second pass: all ids are known, so jumps can be validated now.
  for (let j = 0; j < steps.length; j++) {
    const c = recOf(steps[j]);
    if (c.type !== "condition") continue;
    const then = c.then;
    if (then != null) {
      if (typeof then !== "string" || !ids[then]) errors.push({ code: "BAD_JUMP", field: "steps", id: c.id, target: then, message: "then 目标不存在" });
      else if (then === c.id) errors.push({ code: "SELF_JUMP", field: "steps", id: c.id, message: "condition 不能跳到自身" });
    }
    const els = c.else;
    if (els != null) {
      if (typeof els !== "string" || !ids[els]) errors.push({ code: "BAD_JUMP", field: "steps", id: c.id, target: els, message: "else 目标不存在" });
      else if (els === c.id) errors.push({ code: "SELF_JUMP", field: "steps", id: c.id, message: "condition 不能跳到自身" });
    }
  }

  const outputsRaw = root.outputs;
  const validIds = Object.keys(ids);
  let outputs: unknown[] | null = null;
  if (outputsRaw != null && !Array.isArray(outputsRaw)) {
    errors.push({ code: "BAD_OUTPUTS", field: "outputs", message: "outputs 必须是步骤 id 数组" });
  } else if (Array.isArray(outputsRaw)) outputs = outputsRaw;

  if (Array.isArray(outputs)) {
    for (let o = 0; o < outputs.length; o++) {
      const ov = outputs[o];
      if (typeof ov !== "string" || !ids[ov]) errors.push({ code: "UNKNOWN_OUTPUT", field: "outputs", index: o, id: ov, message: "输出步骤不存在" });
    }
  } else {
    // Default: the last step that can produce text, else the last valid id.
    outputs = [];
    for (let p = steps.length - 1; p >= 0; p--) {
      const sp = recOf(steps[p]);
      const sid = sp.id;
      if ((sp.type === "prompt" || sp.type === "tool") && typeof sid === "string" && ids[sid]) {
        outputs = [sid];
        break;
      }
    }
    if (!outputs.length && validIds.length) outputs = [validIds[validIds.length - 1]];
  }

  let timeoutMs = root.timeoutMs == null ? MAX_TIMEOUT_MS : Number(root.timeoutMs);
  if (!isFinite(timeoutMs) || timeoutMs <= 0) {
    errors.push({ code: "BAD_TIMEOUT", field: "timeoutMs", message: "timeoutMs 必须是正数" });
    timeoutMs = MAX_TIMEOUT_MS;
  } else if (timeoutMs > MAX_TIMEOUT_MS) {
    warnings.push({ code: "TIMEOUT_CLAMPED", message: "timeoutMs 超过 10 分钟，已按 10 分钟计" });
    timeoutMs = MAX_TIMEOUT_MS;
  }

  return {
    ok: errors.length === 0,
    workflow: {
      name: String(name || "").trim(),
      version: 1,
      inputs: inputs.slice(),
      steps: steps,
      outputs: outputs || [],
      timeoutMs: timeoutMs,
    },
    errors: errors,
    warnings: warnings,
  };
}

/** Replace `{{key}}` with vars[key]; absent keys are reported and replaced by an empty string. */
function interpolate(template: unknown, vars: unknown): { ok: boolean; text: string; missing: string[] } {
  const missing: string[] = [];
  const v = recOf(vars);
  const text = String(template == null ? "" : template).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, function (_, name: string) {
    const key = name.trim();
    if (Object.prototype.hasOwnProperty.call(v, key)) {
      const value = v[key];
      if (value == null) return "";
      return typeof value === "string" ? value : String(JSON.stringify(value));
    }
    missing.push(key);
    return "";
  });
  return { ok: missing.length === 0, text: text, missing: missing };
}

/** String-in-object/array interpolation, accumulating every missing reference. */
function interpolateDeep(value: unknown, vars: unknown, missing: string[]): unknown {
  if (typeof value === "string") {
    const r = interpolate(value, vars);
    for (let i = 0; i < r.missing.length; i++) missing.push(r.missing[i]);
    return r.text;
  }
  if (Array.isArray(value)) {
    const arr: unknown[] = [];
    for (let i = 0; i < value.length; i++) arr.push(interpolateDeep(value[i], vars, missing));
    return arr;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value);
    for (let i = 0; i < entries.length; i++) out[entries[i][0]] = interpolateDeep(entries[i][1], vars, missing);
    return out;
  }
  return value;
}

function evalCondition(left: unknown, op: unknown, right: unknown): boolean {
  const l = String(left == null ? "" : left);
  const r = String(right == null ? "" : right);
  if (op === "equals") return l === r;
  if (op === "not_equals") return l !== r;
  if (op === "exists") return l.length > 0;
  if (op === "not_exists") return l.length === 0;
  return l.indexOf(r) >= 0;
}

/** The single value export: the frozen namespace the classic binding publishes. */
export function createWorkflowSchema(): WorkflowSchema {
  return {
    validateWorkflow: validateWorkflow,
    interpolate: interpolate,
    interpolateDeep: interpolateDeep,
    extractRefs: extractRefs,
    evalCondition: evalCondition,
    _limits: { maxSteps: MAX_STEPS, maxTimeoutMs: MAX_TIMEOUT_MS },
    _findStep: findStep,
  };
}
