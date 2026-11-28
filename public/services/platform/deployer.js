(function () {
/**
 * Deploy executor: one declarative pack in, one ordered, resumable, reversible run out.
 *
 * Why this is not the B7 workflow runner: a workflow step calls a model or a tool and produces
 * text; a deploy step provisions remote resources whose undo is a DELETE on the thing it just
 * created. Hence the three properties this file exists for:
 *   · verify is a step with a hard stop — a failed health check ends the run, later steps never
 *     see the light, and the state is left resumable;
 *   · every mutating step may carry an `inverse`, and rollback walks the COMPLETED steps backwards
 *     (the only order that can undo nested resources: a namespace after its keys, a database
 *     after the script that used it);
 *   · the journal records completed steps plus their captures, so a dropped connection resumes at
 *     the first incomplete step instead of creating a second KV namespace.
 *
 * Dry run is the same code path with every port replaced by a preview: it resolves the pack,
 * interpolates variables, and renders each action with secret values masked. It never calls a
 * port, never touches the journal and never writes anything.
 *
 * Boundary: no fetch, no DOM, no localStorage, no process. HTTP, commands, the journal and the
 * host hand-off arrive as per-call ports. Credentials are inputs marked `kind: "secret"`; they are
 * interpolated for execution but masked in every preview and never written to the journal (only
 * captures are). A missing reference is a validation error before any step runs — a typo must not
 * produce a half-provisioned host.
 * @module services/platform/deployer
 */

/** Step kinds the executor understands. `verify` is an HTTP step whose failure stops the run. */
                                                                       

/** Runtime list of the kinds; the validator and the tests iterate this, not a second copy. */
const DEPLOY_STEP_KINDS                            = ["http", "command", "verify", "profile"];

/** Input field kinds. `secret` is about masking and journal exclusion, not storage policy. */
                                                                 

/** Action kinds shared by steps and their inverses. */
                                                              

                                  
                      
                         
                                  
                              
                            
                         
                                
 

                               
                                  
                           
                        
                                                      
                          
                                      
                                
                            
                                    
                                                  
                          
                        
                              
                            
                            
 

                             
                      
                         
                                
                                                                        
                         
                                
                                                                                                      
                                                      
                            
                                  
                                  
                         
 

                             
                      
                        
                      
                          
                                                                                                
                                 
                                
                                              
                                        
                                     
 

                              
                        
                           
                           
                          
 

                                       
                       
                                   
                                          
                                            
 

                                        
                       
                                                    
                                          
                                            
 

                                 
                          
                       
                                                     
                               
                             
 

                                   
                          
                        
 

                                    
                           
                                   
                                                 
                         
                       
                             
 

                                      
                        
                           
                           
 

                                    
                          
                           
                           
 

                                     
                          
                      
                             
                             
                                                  
                               
                                  
                            
 

                                   
                          
                      
                                                      
 

                             
               
                
              
               
                
                 
                   
                    
                  
                   
              

                              
                                 
                          
                           
                          
                          
                          
                            
                      
 

/** Ports are per call: the same pack can run in a browser, a Node test or the desktop shell. */
                              
                                                                                
                                                                                            
                                                              
             
                                                          
                                                               
                                                     
    
                     
                                         
 

                              
          
             
                   
                 
             
              

                                  
                          
                         
                                
                           
                            
                            
                           
                         
 

                                   
                       
                          
                                               
                                          
                                            
 

                                  
                       
                          
                                        
                                     
                                                
                                          
                                            
                               
 

                                      
                          
                           
 

                                     
                          
                          
 

                                       
                       
                          
                                                              
                                               
                                                  
                                          
 

                                
                            
                            
                            
 

                           
                
                                                     
                                                                        
                                                         
                                                                                                
                                                                                                                          
 

const STEP_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const REF_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_EXPECT                    = [200];

/** Runtime gate for the two literal unions; keeps the validator free of type assertions. */
function isStepKind(value         )                          {
  return value === "http" || value === "command" || value === "verify" || value === "profile";
}

function isActionKind(value         )                            {
  return value === "http" || value === "command" || value === "profile";
}

/** unknown JSON → plain-object view; null, arrays and scalars become an empty object. */
function recOf(value         )                          {
  const out                          = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value);
    for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  }
  return out;
}

/** unknown JSON → array view; anything else is empty. */
function arrOf(value         )            {
  return Array.isArray(value) ? value : [];
}

function strOf(value         )         {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function isPlainObject(value         )                                   {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** A string-to-string record; non-string values are stringified only for env/stdin-shaped fields. */
function stringRecord(value         )                         {
  const out                         = {};
  const source = recOf(value);
  const keys = Object.keys(source);
  for (let i = 0; i < keys.length; i++) {
    if (source[keys[i]] == null) continue;
    out[keys[i]] = strOf(source[keys[i]]);
  }
  return out;
}

function messageOf(error         )         {
  if (error && typeof error === "object") {
    const message = recOf(error).message;
    if (typeof message === "string" && message) return message;
  }
  return String(error);
}

function timeoutOf(value         )         {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.floor(n));
}

function methodOf(value         )         {
  const method = strOf(value).trim().toUpperCase();
  return method || "GET";
}

/** All `{{name}}` references in a string, trimmed and de-duplicated. */
function refsIn(text        )           {
  const out           = [];
  const seen                          = {};
  let match                        ;
  REF_RE.lastIndex = 0;
  while ((match = REF_RE.exec(text))) {
    const name = match[1].trim();
    if (name && !seen[name]) {
      seen[name] = true;
      out.push(name);
    }
  }
  return out;
}

/** Walk every string inside a JSON value and collect its references. */
function refsDeep(value         , out          )       {
  if (typeof value === "string") {
    const refs = refsIn(value);
    for (let i = 0; i < refs.length; i++) if (out.indexOf(refs[i]) < 0) out.push(refs[i]);
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) refsDeep(value[i], out);
    return;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i++) refsDeep(value[keys[i]], out);
  }
}

/** Action strings that may carry references, with the field name for the error message. */
function actionRefs(action              )                                   {
  const pairs                                   = [];
  const seen                          = {};
  function add(field        , value         )       {
    const refs           = [];
    refsDeep(value, refs);
    for (let i = 0; i < refs.length; i++) {
      if (seen[refs[i]]) continue;
      seen[refs[i]] = true;
      pairs.push({ field: field, ref: refs[i] });
    }
  }
  if (action.url) add("url", action.url);
  if (action.headers) add("headers", action.headers);
  if (action.body !== undefined) add("body", action.body);
  if (action.command) add("command", action.command);
  if (action.args) add("args", action.args);
  if (action.env) add("env", action.env);
  if (action.stdin) add("stdin", action.stdin);
  if (action.cwd) add("cwd", action.cwd);
  if (action.baseUrl) add("baseUrl", action.baseUrl);
  return pairs;
}

/** `result.id` / `data[0].uuid` reader over unknown JSON. Missing paths answer undefined. */
function readPath(value         , path        )          {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let current          = value;
  for (let i = 0; i < parts.length; i++) {
    if (current == null) return undefined;
    if (Array.isArray(current)) {
      const index = Number(parts[i]);
      if (!Number.isFinite(index)) return undefined;
      current = current[index];
      continue;
    }
    if (isPlainObject(current)) {
      current = current[parts[i]];
      continue;
    }
    return undefined;
  }
  return current;
}

/** Expected JSON is a subset: every named key must match; arrays must match length and order. */
function jsonSubset(actual         , expected         )          {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    for (let i = 0; i < expected.length; i++) if (!jsonSubset(actual[i], expected[i])) return false;
    return true;
  }
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return false;
    const keys = Object.keys(expected);
    for (let i = 0; i < keys.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(actual, keys[i])) return false;
      if (!jsonSubset(actual[keys[i]], expected[keys[i]])) return false;
    }
    return true;
  }
  return actual === expected;
}

function hasOwn(record                         , key        )          {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function strArray(value         )                  {
  if (value == null) return [];
  if (!Array.isArray(value)) return null;
  const out           = [];
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== "string") return null;
    out.push(value[i]);
  }
  return out;
}

function expectOf(value         )                  {
  if (value == null) return DEFAULT_EXPECT.slice();
  if (!Array.isArray(value) || !value.length) return null;
  const out           = [];
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== "number" || !Number.isFinite(value[i])) return null;
    out.push(value[i]);
  }
  return out;
}

/** Validate one action's shape and references. `allowed` is the ref set visible to it. */
function validateAction(
  raw         ,
  kind                  ,
  allowed                         ,
  label        ,
  stepId        ,
  errors               ,
)                      {
  if (!isPlainObject(raw)) {
    errors.push({ code: "BAD_ACTION", stepId: stepId, field: label, message: label + " 必须是对象" });
    return null;
  }
  const action = raw;
  const actionKind = action.kind;
  if (actionKind !== kind) {
    errors.push({ code: "BAD_ACTION_KIND", stepId: stepId, field: label + ".kind", message: label + ".kind 必须是 " + kind });
    return null;
  }
  const built               = {
    kind: kind,
    method: action.method === undefined ? undefined : methodOf(action.method),
    url: action.url === undefined ? undefined : strOf(action.url),
    headers: action.headers === undefined ? undefined : stringRecord(action.headers),
    body: action.body,
    expect: action.expect === undefined ? undefined : (expectOf(action.expect) || []),
    expectJson: action.expectJson,
    command: action.command === undefined ? undefined : strOf(action.command),
    args: action.args === undefined ? undefined : (strArray(action.args) || []),
    env: action.env === undefined ? undefined : stringRecord(action.env),
    stdin: action.stdin === undefined ? undefined : strOf(action.stdin),
    cwd: action.cwd === undefined ? undefined : strOf(action.cwd),
    timeoutMs: action.timeoutMs === undefined ? undefined : timeoutOf(action.timeoutMs),
    profile: action.profile === undefined ? undefined : strOf(action.profile),
    baseUrl: action.baseUrl === undefined ? undefined : strOf(action.baseUrl),
  };
  if (kind === "http") {
    if (!built.url) errors.push({ code: "BAD_URL", stepId: stepId, field: label + ".url", message: label + ".url 不能为空" });
    if (action.expect !== undefined && expectOf(action.expect) === null) {
      errors.push({ code: "BAD_EXPECT", stepId: stepId, field: label + ".expect", message: label + ".expect 必须是状态码数组" });
    }
    if (action.expectJson !== undefined && !isPlainObject(action.expectJson) && !Array.isArray(action.expectJson)) {
      errors.push({ code: "BAD_EXPECT_JSON", stepId: stepId, field: label + ".expectJson", message: label + ".expectJson 必须是对象或数组" });
    }
  } else if (kind === "command") {
    if (!built.command) errors.push({ code: "BAD_COMMAND", stepId: stepId, field: label + ".command", message: label + ".command 不能为空" });
    if (action.args !== undefined && strArray(action.args) === null) {
      errors.push({ code: "BAD_ARGS", stepId: stepId, field: label + ".args", message: label + ".args 必须是字符串数组" });
    }
    if (action.env !== undefined && !isPlainObject(action.env)) {
      errors.push({ code: "BAD_ENV", stepId: stepId, field: label + ".env", message: label + ".env 必须是对象" });
    }
  } else if (kind === "profile") {
    if (!built.profile) errors.push({ code: "BAD_PROFILE", stepId: stepId, field: label + ".profile", message: label + ".profile 不能为空" });
  }
  const refs = actionRefs(built);
  for (let i = 0; i < refs.length; i++) {
    if (!allowed[refs[i].ref]) {
      errors.push({
        code: "UNKNOWN_REF",
        stepId: stepId,
        field: label + "." + refs[i].field,
        message: "引用了未定义或后置的变量: " + refs[i].ref,
      });
    }
  }
  return built;
}

/** Validate a whole pack. Forward references, duplicate ids and secret-less steps all fail here. */
function validateDeployPack(input         )                       {
  const errors                = [];
  const warnings                = [];
  if (!isPlainObject(input)) {
    return { ok: false, pack: null, errors: [{ code: "BAD_ROOT", message: "部署包必须是对象" }], warnings };
  }
  const root = input;
  const id = strOf(root.id).trim();
  const name = strOf(root.name).trim();
  const target = strOf(root.target).trim();
  const resultProfile = strOf(root.resultProfile).trim();
  if (!id) errors.push({ code: "BAD_ID", message: "部署包缺少 id" });
  if (!name) errors.push({ code: "BAD_NAME", message: "部署包缺少 name" });
  if (root.version !== 1) errors.push({ code: "BAD_VERSION", message: "version 必须是 1" });
  if (!target) errors.push({ code: "BAD_TARGET", message: "部署包缺少 target" });
  if (!resultProfile) errors.push({ code: "BAD_RESULT_PROFILE", message: "部署包缺少 resultProfile" });

  const inputsRaw = arrOf(root.inputs);
  const inputs                    = [];
  const inputIds                          = {};
  for (let i = 0; i < inputsRaw.length; i++) {
    const spec = recOf(inputsRaw[i]);
    const inputId = strOf(spec.id).trim();
    if (!STEP_ID_RE.test(inputId)) {
      errors.push({ code: "BAD_INPUT_ID", field: "inputs", message: "inputs[" + i + "].id 必须是 1-40 位字母/数字/下划线/短横线" });
      continue;
    }
    if (inputIds[inputId]) {
      errors.push({ code: "DUPLICATE_INPUT", field: "inputs", message: "输入 id 重复: " + inputId });
      continue;
    }
    inputIds[inputId] = true;
    const kindRaw = strOf(spec.kind || "text");
    const kind                  = kindRaw === "secret" ? "secret" : kindRaw === "url" ? "url" : kindRaw === "path" ? "path" : "text";
    if (kindRaw !== kind) errors.push({ code: "BAD_INPUT_KIND", field: "inputs." + inputId, message: "未知输入类型: " + kindRaw });
    inputs.push({
      id: inputId,
      label: strOf(spec.label).trim() || inputId,
      kind: kind,
      required: spec.required === true,
      default: strOf(spec.default),
      hint: strOf(spec.hint),
      placeholder: strOf(spec.placeholder),
    });
  }
  if (!inputs.length) warnings.push({ code: "NO_INPUTS", field: "inputs", message: "部署包没有输入项" });

  const stepsRaw = arrOf(root.steps);
  if (!stepsRaw.length) errors.push({ code: "NO_STEPS", field: "steps", message: "steps 必须是非空数组" });
  const steps               = [];
  const stepIds                          = {};
  const allowed                          = {};
  for (let i = 0; i < inputs.length; i++) allowed[inputs[i].id] = true;

  for (let i = 0; i < stepsRaw.length; i++) {
    const raw = recOf(stepsRaw[i]);
    const stepId = strOf(raw.id).trim();
    if (!STEP_ID_RE.test(stepId)) {
      errors.push({ code: "BAD_STEP_ID", field: "steps", message: "steps[" + i + "].id 必须是 1-40 位字母/数字/下划线/短横线" });
      continue;
    }
    if (stepIds[stepId]) {
      errors.push({ code: "DUPLICATE_STEP_ID", stepId: stepId, message: "步骤 id 重复: " + stepId });
      continue;
    }
    stepIds[stepId] = true;
    const kindRaw = strOf(raw.kind);
    if (!isStepKind(kindRaw)) {
      errors.push({ code: "BAD_STEP_KIND", stepId: stepId, message: "未知步骤类型: " + kindRaw });
      continue;
    }
    const kind = kindRaw;
    const when = raw.when === undefined ? "" : strOf(raw.when).trim();
    if (when && !inputIds[when]) {
      errors.push({ code: "BAD_WHEN", stepId: stepId, field: "when", message: "when 引用了不存在的输入: " + when });
    }
    const actionKind                   = kind === "command" ? "command" : kind === "profile" ? "profile" : "http";
    const action = validateAction(raw.action, actionKind, allowed, "action", stepId, errors);
    const captureRaw = recOf(raw.capture);
    const capture                         = {};
    const captureKeys = Object.keys(captureRaw);
    for (let c = 0; c < captureKeys.length; c++) {
      const key = captureKeys[c];
      if (!STEP_ID_RE.test(key)) {
        errors.push({ code: "BAD_CAPTURE_KEY", stepId: stepId, field: "capture", message: "capture 键非法: " + key });
        continue;
      }
      capture[key] = strOf(captureRaw[key]).trim();
      if (!capture[key]) errors.push({ code: "BAD_CAPTURE_PATH", stepId: stepId, field: "capture." + key, message: "capture 路径不能为空" });
    }
    const inverseRaw = recOf(raw.inverse);
    const captureKeysForInverse = Object.keys(capture);
    const allowedForInverse                          = {};
    const allowedKeys = Object.keys(allowed);
    for (let k = 0; k < allowedKeys.length; k++) allowedForInverse[allowedKeys[k]] = true;
    for (let k = 0; k < captureKeysForInverse.length; k++) allowedForInverse[captureKeysForInverse[k]] = true;
    let inverse                      = null;
    if (raw.inverse !== undefined) {
      if (isActionKind(inverseRaw.kind)) inverse = validateAction(raw.inverse, inverseRaw.kind, allowedForInverse, "inverse", stepId, errors);
      else errors.push({ code: "BAD_INVERSE_KIND", stepId: stepId, field: "inverse.kind", message: "inverse 类型必须是 http / command / profile" });
    }
    steps.push({
      id: stepId,
      title: strOf(raw.title).trim() || stepId,
      kind: kind,
      when: when || undefined,
      action: action || { kind: actionKind },
      capture: Object.keys(capture).length ? capture : undefined,
      secret: raw.secret === true,
      irreversible: raw.irreversible === true,
      inverse: inverse || undefined,
      note: raw.note === undefined ? undefined : strOf(raw.note),
    });
    for (let c = 0; c < captureKeys.length; c++) if (capture[captureKeys[c]]) allowed[captureKeys[c]] = true;
  }

  const notes = arrOf(root.notes).map((n) => strOf(n)).filter((n) => !!n);
  const pack             = {
    id: id,
    name: name,
    version: 1,
    target: target,
    resultProfile: resultProfile,
    description: strOf(root.description),
    inputs: inputs,
    steps: steps,
    notes: notes,
  };
  return { ok: errors.length === 0, pack: errors.length === 0 ? pack : null, errors: errors, warnings: warnings };
}

/** Resolve declared inputs: trims, applies defaults, enforces required and URL syntax. */
function validateDeployInputs(pack         , values         )                        {
  const errors                = [];
  const warnings                = [];
  const validation = validateDeployPack(pack);
  if (!validation.ok || !validation.pack) {
    return { ok: false, values: {}, errors: validation.errors, warnings: validation.warnings };
  }
  const inputPack = validation.pack;
  const raw = recOf(values);
  const known                          = {};
  const out                         = {};
  for (let i = 0; i < inputPack.inputs.length; i++) {
    const spec = inputPack.inputs[i];
    known[spec.id] = true;
    const value = hasOwn(raw, spec.id) ? strOf(raw[spec.id]).trim() : strOf(spec.default).trim();
    if (spec.required && !value) {
      errors.push({ code: "MISSING_INPUT", field: spec.id, message: "缺少必填项: " + spec.label });
      continue;
    }
    if (spec.kind === "url" && value && !/^https?:\/\/[^\s]+$/i.test(value)) {
      errors.push({ code: "BAD_URL_INPUT", field: spec.id, message: spec.label + " 必须以 http(s):// 开头" });
      continue;
    }
    out[spec.id] = value;
  }
  const keys = Object.keys(raw);
  for (let i = 0; i < keys.length; i++) {
    if (!known[keys[i]]) warnings.push({ code: "UNUSED_INPUT", field: keys[i], message: "未声明的输入已忽略: " + keys[i] });
  }
  return { ok: errors.length === 0, values: out, errors: errors, warnings: warnings };
}

function secretIdsOf(pack            )                          {
  const out                          = {};
  for (let i = 0; i < pack.inputs.length; i++) if (pack.inputs[i].kind === "secret") out[pack.inputs[i].id] = true;
  return out;
}

/**
 * Replace `{{name}}` from vars. `mask` makes secret refs render as `***`; `allowMissing` leaves
 * unknown refs untouched (used by the pre-run preview, where captures do not exist yet).
 */
function interpolate(text        , vars                        , mask                         , allowMissing         )         {
  return text.replace(REF_RE, function (whole        , name        ) {
    const key = name.trim();
    if (!hasOwn(vars, key)) return allowMissing ? whole : "";
    if (mask[key]) return "***";
    return vars[key];
  });
}

/** Deep interpolation for bodies/arg arrays; keeps numbers and booleans untouched. */
function interpolateDeep(value         , vars                        , mask                         , allowMissing         )          {
  if (typeof value === "string") return interpolate(value, vars, mask, allowMissing);
  if (Array.isArray(value)) {
    const out            = [];
    for (let i = 0; i < value.length; i++) out.push(interpolateDeep(value[i], vars, mask, allowMissing));
    return out;
  }
  if (isPlainObject(value)) {
    const out                          = {};
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i++) out[keys[i]] = interpolateDeep(value[keys[i]], vars, mask, allowMissing);
    return out;
  }
  return value;
}

function interpolateRecord(source                                              , vars                        , mask                         , allowMissing         )                         {
  const out                         = {};
  if (!source) return out;
  const keys = Object.keys(source);
  for (let i = 0; i < keys.length; i++) out[keys[i]] = interpolate(source[keys[i]], vars, mask, allowMissing);
  return out;
}

function previewOf(action              , vars                        , mask                         )         {
  if (action.kind === "http") {
    const method = methodOf(action.method);
    const url = interpolate(strOf(action.url), vars, mask, true);
    const body = action.body === undefined ? "" : " body=" + JSON.stringify(interpolateDeep(action.body, vars, mask, true));
    return method + " " + url + (body.length > 220 ? body.slice(0, 220) + "…" : body);
  }
  if (action.kind === "command") {
    const args = arrOf(action.args).map((a) => interpolate(strOf(a), vars, mask, true)).join(" ");
    const envKeys = Object.keys(stringRecord(action.env));
    const env = envKeys.length ? " env={" + envKeys.join(",") + "}" : "";
    const stdin = strOf(action.stdin) ? " stdin=<secret>" : "";
    return strOf(action.command) + (args ? " " + args : "") + env + stdin;
  }
  return "profile → " + strOf(action.profile) + (action.baseUrl ? " (" + interpolate(strOf(action.baseUrl), vars, mask, true) + ")" : "");
}

function planEntries(pack            , values                        )                    {
  const mask = secretIdsOf(pack);
  const entries                    = [];
  for (let i = 0; i < pack.steps.length; i++) {
    const step = pack.steps[i];
    if (step.when && !strOf(values[step.when]).trim()) {
      entries.push({
        stepId: step.id,
        title: step.title,
        kind: step.kind,
        preview: "",
        skipped: "when:" + step.when + " 为空",
        secret: !!step.secret,
        note: step.note,
      });
      continue;
    }
    entries.push({
      stepId: step.id,
      title: step.title,
      kind: step.kind,
      preview: previewOf(step.action, values, mask),
      inverse: step.inverse ? previewOf(step.inverse, values, mask) : (step.irreversible ? "(不可回滚)" : undefined),
      secret: !!step.secret,
      note: step.note,
    });
  }
  return entries;
}

function emptyState(packId        , at        )                     {
  return { packId: packId, version: 1, startedAt: at, updatedAt: at, completed: [] };
}

function stateFrom(raw         , packId        )                            {
  const o = recOf(raw);
  if (strOf(o.packId) !== packId) return null;
  if (o.version !== 1) return null;
  const completedRaw = arrOf(o.completed);
  const completed                     = [];
  for (let i = 0; i < completedRaw.length; i++) {
    const record = recOf(completedRaw[i]);
    const stepId = strOf(record.stepId).trim();
    if (!stepId) return null;
    const captures = stringRecord(record.captures);
    completed.push({ stepId: stepId, at: Number(record.at) || 0, captures: captures });
  }
  return {
    packId: packId,
    version: 1,
    startedAt: Number(o.startedAt) || 0,
    updatedAt: Number(o.updatedAt) || 0,
    completed: completed,
    failedStep: strOf(o.failedStep) || undefined,
    resultProfile: strOf(o.resultProfile) || undefined,
    baseUrl: strOf(o.baseUrl) || undefined,
  };
}

/** A resumed journal must carry every capture its completed steps declared; a missing one would
 * interpolate as an empty string and could hit the wrong remote resource (e.g. DELETE .../).
 * Refusing the run is the loud answer. */
function validateStateCaptures(pack            , state                    )                {
  const errors                = [];
  const byId                             = {};
  for (let i = 0; i < pack.steps.length; i++) byId[pack.steps[i].id] = pack.steps[i];
  for (let i = 0; i < state.completed.length; i++) {
    const record = state.completed[i];
    const step = byId[record.stepId];
    if (!step || !step.capture) continue;
    const keys = Object.keys(step.capture);
    for (let k = 0; k < keys.length; k++) {
      if (!hasOwn(record.captures, keys[k])) {
        errors.push({ code: "BAD_RESUME_CAPTURE", stepId: record.stepId, message: "续跑日志缺少 capture: " + keys[k] });
      }
    }
  }
  return errors;
}

function capturesUpTo(state                    )                         {
  const out                         = {};
  for (let i = 0; i < state.completed.length; i++) {
    const captures = state.completed[i].captures;
    const keys = Object.keys(captures);
    for (let k = 0; k < keys.length; k++) out[keys[k]] = captures[keys[k]];
  }
  return out;
}

function eventOf(type                 , packId        , at        , extra                      )              {
  return {
    type: type,
    packId: packId,
    stepId: extra.stepId,
    index: extra.index,
    total: extra.total,
    title: extra.title,
    message: extra.message,
    at: at,
  };
}

function nowOf(ports                         )         {
  const fn = ports.now;
  if (typeof fn === "function") {
    try {
      const value = Number(Reflect.apply(fn, ports, []));
      if (Number.isFinite(value)) return value;
    } catch (e) {
      // Fall through to wall clock; a broken clock port must not stop a deploy.
    }
  }
  return Date.now();
}

function emit(ports                         , event             )       {
  const fn = ports.onEvent;
  if (typeof fn !== "function") return;
  try { Reflect.apply(fn, ports, [event]); } catch (e) { /* an observer failure must not stop the run */ }
}

function callPort(ports                         , key        , arg         )                          {
  const fn = ports[key];
  if (typeof fn !== "function") return null;
  try {
    return Promise.resolve(Reflect.apply(fn, ports, [arg]));
  } catch (e) {
    return Promise.reject(e);
  }
}

function journalPort(ports                         )                          {
  return recOf(ports.journal);
}

async function journalSave(ports                         , state                    )                   {
  const journal = journalPort(ports);
  const fn = journal.save;
  if (typeof fn !== "function") return true;
  try {
    await Reflect.apply(fn, journal, [state]);
    return true;
  } catch (e) {
    return false;
  }
}

function aborted(signal         )          {
  if (!signal || typeof signal !== "object") return false;
  try {
    return Reflect.get(signal, "aborted") === true;
  } catch (e) {
    return false;
  }
}

                       
                                            
                          
                                  
                            
 

/** Execute one step. Everything it returns is data; events are emitted by the caller. */
async function executeStep(
  pack            ,
  step            ,
  vars                        ,
  ports                         ,
)                       {
  const action = step.action;
  if (action.kind === "profile") {
    const baseUrl = interpolate(strOf(action.baseUrl), vars, {}, false);
    const call                    = {
      packId: pack.id,
      profile: strOf(action.profile),
      baseUrl: baseUrl,
    };
    const promise = callPort(ports, "handoff", call);
    if (promise === null) return { captures: {}, error: "handoff 通道未接线" };
    try { await promise; } catch (e) { return { captures: {}, error: "回填 profile 失败：" + messageOf(e) }; }
    return { captures: {}, baseUrl: baseUrl };
  }
  if (action.kind === "command") {
    const call                    = {
      command: interpolate(strOf(action.command), vars, {}, false),
      args: arrOf(action.args).map((a) => interpolate(strOf(a), vars, {}, false)),
      env: interpolateRecord(action.env, vars, {}, false),
      stdin: interpolate(strOf(action.stdin), vars, {}, false),
      cwd: interpolate(strOf(action.cwd), vars, {}, false),
      timeoutMs: timeoutOf(action.timeoutMs),
    };
    const promise = callPort(ports, "command", call);
    if (promise === null) return { captures: {}, error: "命令通道未接线（桌面端命令端口尚未提供）" };
    let rawResult         ;
    try { rawResult = await promise; } catch (e) { return { captures: {}, error: "命令执行失败：" + messageOf(e) }; }
    const result = recOf(rawResult);
    const code = Number(result.code);
    if (!Number.isFinite(code) || code !== 0) {
      return { captures: {}, error: "命令退出码 " + String(result.code) + (result.stderr ? "：" + strOf(result.stderr) : "") };
    }
    const captures                         = {};
    const capture = recOf(step.capture);
    const keys = Object.keys(capture);
    for (let i = 0; i < keys.length; i++) {
      const path = strOf(capture[keys[i]]);
      const value = path === "stdout" ? result.stdout : readPath(result, path);
      if (value === undefined) return { captures: {}, error: "capture " + keys[i] + " 未命中路径 " + path };
      captures[keys[i]] = strOf(value);
    }
    return { captures: captures };
  }

  // http / verify
  const method = methodOf(action.method);
  const url = interpolate(strOf(action.url), vars, {}, false);
  const headers = interpolateRecord(action.headers, vars, {}, false);
  const bodyValue = action.body === undefined ? null : interpolateDeep(action.body, vars, {}, false);
  const body = bodyValue === null ? null : JSON.stringify(bodyValue);
  const call                 = {
    method: method,
    url: url,
    headers: headers,
    body: body,
    timeoutMs: timeoutOf(action.timeoutMs),
  };
  const promise = callPort(ports, "http", call);
  if (promise === null) return { captures: {}, error: "HTTP 通道未接线" };
  let rawResponse         ;
  try { rawResponse = await promise; } catch (e) { return { captures: {}, error: "HTTP 请求失败：" + messageOf(e) }; }
  const response = recOf(rawResponse);
  const status = Number(response.status);
  const expect = expectOf(action.expect) || DEFAULT_EXPECT.slice();
  if (!Number.isFinite(status) || expect.indexOf(status) < 0) {
    return { captures: {}, error: method + " " + url + " 返回 " + String(response.status) + "（期望 " + expect.join("/") + "）" };
  }
  const text = strOf(response.body);
  let parsedBody          = undefined;
  if (text) {
    try { parsedBody = JSON.parse(text); } catch (e) {
      if (step.kind === "verify" || action.expectJson !== undefined) return { captures: {}, error: "响应不是 JSON", verifyFailed: step.kind === "verify" };
    }
  }
  if (step.kind === "verify" && action.expectJson !== undefined) {
    if (!jsonSubset(parsedBody, action.expectJson)) {
      return { captures: {}, error: "verify 响应不匹配期望 JSON", verifyFailed: true };
    }
  }
  const captures                         = {};
  const capture = recOf(step.capture);
  const keys = Object.keys(capture);
  for (let i = 0; i < keys.length; i++) {
    const path = strOf(capture[keys[i]]);
    const value = readPath(parsedBody, path);
    if (value === undefined) return { captures: {}, error: "capture " + keys[i] + " 未命中路径 " + path };
    captures[keys[i]] = strOf(value);
  }
  return { captures: captures };
}

/** Execute one inverse action during rollback (no captures; its vars were snapshotted). */
async function executeInverse(
  packId        ,
  action              ,
  vars                        ,
  ports                         ,
)                  {
  if (action.kind === "profile") {
    const call                    = {
      packId: packId,
      profile: strOf(action.profile),
      baseUrl: interpolate(strOf(action.baseUrl), vars, {}, false),
    };
    const promise = callPort(ports, "handoff", call);
    if (promise === null) return "handoff 通道未接线";
    try { await promise; } catch (e) { return "回填 profile 失败：" + messageOf(e); }
    return "";
  }
  if (action.kind === "command") {
    const call                    = {
      command: interpolate(strOf(action.command), vars, {}, false),
      args: arrOf(action.args).map((a) => interpolate(strOf(a), vars, {}, false)),
      env: interpolateRecord(action.env, vars, {}, false),
      stdin: interpolate(strOf(action.stdin), vars, {}, false),
      cwd: interpolate(strOf(action.cwd), vars, {}, false),
      timeoutMs: timeoutOf(action.timeoutMs),
    };
    const promise = callPort(ports, "command", call);
    if (promise === null) return "命令通道未接线";
    let rawResult         ;
    try { rawResult = await promise; } catch (e) { return messageOf(e); }
    const code = Number(recOf(rawResult).code);
    return code === 0 ? "" : "命令退出码 " + String(code);
  }
  const call                 = {
    method: methodOf(action.method),
    url: interpolate(strOf(action.url), vars, {}, false),
    headers: interpolateRecord(action.headers, vars, {}, false),
    body: action.body === undefined ? null : JSON.stringify(interpolateDeep(action.body, vars, {}, false)),
    timeoutMs: timeoutOf(action.timeoutMs),
  };
  const promise = callPort(ports, "http", call);
  if (promise === null) return "HTTP 通道未接线";
  let rawResponse         ;
  try { rawResponse = await promise; } catch (e) { return messageOf(e); }
  const status = Number(recOf(rawResponse).status);
  const expect = expectOf(action.expect) || DEFAULT_EXPECT.slice();
  return Number.isFinite(status) && expect.indexOf(status) >= 0 ? "" : "HTTP " + String(status) + "（期望 " + expect.join("/") + "）";
}

/** Build the deployer. One instance per page; calls are independent and carry their own ports. */
function createDeployer()           {
  function plan(packInput         , inputs         )                   {
    const validation = validateDeployPack(packInput);
    if (!validation.ok || !validation.pack) {
      return { ok: false, packId: strOf(recOf(packInput).id), entries: [], errors: validation.errors, warnings: validation.warnings };
    }
    const inputValidation = validateDeployInputs(validation.pack, inputs);
    if (!inputValidation.ok) {
      return { ok: false, packId: validation.pack.id, entries: [], errors: inputValidation.errors, warnings: inputValidation.warnings };
    }
    return {
      ok: true,
      packId: validation.pack.id,
      entries: planEntries(validation.pack, inputValidation.values),
      errors: [],
      warnings: inputValidation.warnings,
    };
  }

  async function run(packInput         , inputs         , portsInput         , optsInput          )                           {
    const ports = recOf(portsInput);
    const opts = recOf(optsInput);
    const now = nowOf(ports);
    const validation = validateDeployPack(packInput);
    if (!validation.ok || !validation.pack) {
      return {
        ok: false,
        packId: strOf(recOf(packInput).id),
        stopReason: "invalid",
        state: emptyState(strOf(recOf(packInput).id), now),
        errors: validation.errors,
        warnings: validation.warnings,
      };
    }
    const pack = validation.pack;
    const inputValidation = validateDeployInputs(pack, inputs);
    if (!inputValidation.ok) {
      return {
        ok: false,
        packId: pack.id,
        stopReason: "invalid",
        state: emptyState(pack.id, now),
        errors: inputValidation.errors,
        warnings: inputValidation.warnings,
      };
    }
    const values = inputValidation.values;
    const warnings                = inputValidation.warnings.slice();

    if (opts.dryRun === true) {
      return {
        ok: true,
        packId: pack.id,
        stopReason: "dry_run",
        state: emptyState(pack.id, now),
        planned: planEntries(pack, values),
        errors: [],
        warnings: warnings,
      };
    }

    // Resume: explicit state wins; otherwise the journal may hold a previous run.
    let state = emptyState(pack.id, now);
    const explicit = opts.resume === undefined ? null : stateFrom(opts.resume, pack.id);
    if (explicit) {
      state = explicit;
    } else if (opts.resume !== undefined) {
      warnings.push({ code: "BAD_RESUME", message: "恢复状态与部署包不匹配，已从头开始" });
    } else {
      const journal = journalPort(ports);
      if (typeof journal.load === "function") {
        let loaded         ;
        try { loaded = await Reflect.apply(journal.load, journal, [pack.id]); } catch (e) {
          warnings.push({ code: "JOURNAL_LOAD_FAILED", message: "读取部署日志失败：" + messageOf(e) });
        }
        const fromJournal = loaded === undefined || loaded === null ? null : stateFrom(loaded, pack.id);
        if (fromJournal) state = fromJournal;
        else if (loaded != null) warnings.push({ code: "BAD_JOURNAL", message: "部署日志与当前包不匹配，已从头开始" });
      }
    }

    const resumeErrors = validateStateCaptures(pack, state);
    if (resumeErrors.length) {
      return { ok: false, packId: pack.id, stopReason: "invalid", state: state, errors: resumeErrors, warnings: warnings };
    }
    const completed                          = {};
    for (let i = 0; i < state.completed.length; i++) completed[state.completed[i].stepId] = true;
    const vars = Object.assign({}, values, capturesUpTo(state));

    emit(ports, eventOf("run/start", pack.id, now, { message: state.completed.length ? "从第 " + (state.completed.length + 1) + " 步继续" : "" }));

    for (let i = 0; i < pack.steps.length; i++) {
      const step = pack.steps[i];
      if (aborted(opts.signal)) {
        emit(ports, eventOf("run/end", pack.id, now, { message: "已取消" }));
        return { ok: false, packId: pack.id, stopReason: "aborted", state: state, errors: [], warnings: warnings };
      }
      if (completed[step.id]) {
        emit(ports, eventOf("step/skip", pack.id, now, { stepId: step.id, index: i, total: pack.steps.length, title: step.title, message: "已完成" }));
        continue;
      }
      if (step.when) {
        const gate = strOf(vars[step.when]).trim();
        if (!gate) {
          emit(ports, eventOf("step/skip", pack.id, now, { stepId: step.id, index: i, total: pack.steps.length, title: step.title, message: "when:" + step.when + " 为空" }));
          continue;
        }
      }
      emit(ports, eventOf("step/start", pack.id, now, { stepId: step.id, index: i, total: pack.steps.length, title: step.title }));
      let outcome             ;
      try {
        outcome = await executeStep(pack, step, vars, ports);
      } catch (e) {
        outcome = { captures: {}, error: messageOf(e) };
      }
      if (outcome.error) {
        const failed                     = {
          packId: pack.id,
          version: 1,
          startedAt: state.startedAt || now,
          updatedAt: now,
          completed: state.completed,
          failedStep: step.id,
          resultProfile: pack.resultProfile,
          baseUrl: strOf(vars.baseUrl),
        };
        state = failed;
        if (!(await journalSave(ports, state))) {
          warnings.push({ code: "JOURNAL_SAVE_FAILED", message: "部署日志写入失败（续跑将不可用）" });
          emit(ports, eventOf("journal/error", pack.id, now, { stepId: step.id, message: "部署日志写入失败" }));
        }
        emit(ports, eventOf(outcome.verifyFailed ? "verify/fail" : "step/error", pack.id, now, {
          stepId: step.id,
          index: i,
          total: pack.steps.length,
          title: step.title,
          message: outcome.error,
        }));
        emit(ports, eventOf("run/end", pack.id, now, { message: outcome.error }));
        return {
          ok: false,
          packId: pack.id,
          stopReason: outcome.verifyFailed ? "verify_failed" : "step_failed",
          state: state,
          errors: [{ code: outcome.verifyFailed ? "VERIFY_FAILED" : "STEP_FAILED", stepId: step.id, message: outcome.error }],
          warnings: warnings,
          failedStep: step.id,
        };
      }
      const record                   = { stepId: step.id, at: now, captures: outcome.captures };
      state = {
        packId: pack.id,
        version: 1,
        startedAt: state.startedAt || now,
        updatedAt: now,
        completed: state.completed.concat([record]),
        failedStep: undefined,
        resultProfile: pack.resultProfile,
        baseUrl: outcome.baseUrl || state.baseUrl || strOf(vars.baseUrl),
      };
      const keys = Object.keys(outcome.captures);
      for (let k = 0; k < keys.length; k++) vars[keys[k]] = outcome.captures[keys[k]];
      if (!(await journalSave(ports, state))) {
        warnings.push({ code: "JOURNAL_SAVE_FAILED", message: "部署日志写入失败（续跑将不可用）" });
        emit(ports, eventOf("journal/error", pack.id, now, { stepId: step.id, message: "部署日志写入失败" }));
      }
      emit(ports, eventOf("step/end", pack.id, now, {
        stepId: step.id,
        index: i,
        total: pack.steps.length,
        title: step.title,
        message: keys.length ? "captured " + keys.join(",") : "",
      }));
    }

    emit(ports, eventOf("run/end", pack.id, now, { message: "部署完成" }));
    return { ok: true, packId: pack.id, stopReason: "done", state: state, errors: [], warnings: warnings };
  }

  async function rollback(packInput         , stateInput         , inputs         , portsInput         , optsInput          )                                {
    const ports = recOf(portsInput);
    const opts = recOf(optsInput);
    const now = nowOf(ports);
    const validation = validateDeployPack(packInput);
    if (!validation.ok || !validation.pack) {
      return { ok: false, packId: strOf(recOf(packInput).id), stopReason: "invalid", ran: [], skipped: [], errors: validation.errors };
    }
    const pack = validation.pack;
    const state = stateFrom(stateInput, pack.id);
    if (!state) {
      return {
        ok: false,
        packId: pack.id,
        stopReason: "invalid",
        ran: [],
        skipped: [],
        errors: [{ code: "BAD_STATE", message: "回滚状态与部署包不匹配" }],
      };
    }
    const inputValidation = validateDeployInputs(pack, inputs);
    if (!inputValidation.ok) {
      return { ok: false, packId: pack.id, stopReason: "invalid", ran: [], skipped: [], errors: inputValidation.errors };
    }
    const stateErrors = validateStateCaptures(pack, state);
    if (stateErrors.length) {
      return { ok: false, packId: pack.id, stopReason: "invalid", ran: [], skipped: [], errors: stateErrors };
    }
    const byId                             = {};
    for (let i = 0; i < pack.steps.length; i++) byId[pack.steps[i].id] = pack.steps[i];

    // Snapshot the variables visible to each completed step, in completion order.
    const varsAt                           = [];
    let running                         = Object.assign({}, inputValidation.values);
    for (let i = 0; i < state.completed.length; i++) {
      varsAt.push(Object.assign({}, running));
      const captures = state.completed[i].captures;
      const keys = Object.keys(captures);
      for (let k = 0; k < keys.length; k++) running[keys[k]] = captures[keys[k]];
    }

    const ran                        = [];
    const skipped                       = [];
    const mask = secretIdsOf(pack);
    emit(ports, eventOf("rollback/start", pack.id, now, { total: state.completed.length }));
    for (let i = state.completed.length - 1; i >= 0; i--) {
      if (aborted(opts.signal)) {
        return { ok: false, packId: pack.id, stopReason: "rollback_failed", ran: ran, skipped: skipped, errors: [{ code: "ABORTED", message: "回滚已取消" }] };
      }
      const record = state.completed[i];
      const step = byId[record.stepId];
      if (!step) {
        skipped.push({ stepId: record.stepId, reason: "步骤已从部署包移除" });
        emit(ports, eventOf("rollback/skip", pack.id, now, { stepId: record.stepId, message: "步骤已从部署包移除" }));
        continue;
      }
      if (!step.inverse) {
        skipped.push({ stepId: step.id, reason: step.irreversible ? "标记为不可回滚" : "没有 inverse" });
        emit(ports, eventOf("rollback/skip", pack.id, now, { stepId: step.id, message: "不可回滚" }));
        continue;
      }
      const vars = Object.assign({}, varsAt[i], record.captures);
      const preview = previewOf(step.inverse, vars, mask);
      emit(ports, eventOf("step/start", pack.id, now, { stepId: step.id, index: i, total: state.completed.length, title: "回滚：" + step.title, message: preview }));
      let error = "";
      try {
        error = await executeInverse(pack.id, step.inverse, vars, ports);
      } catch (e) {
        error = messageOf(e);
      }
      if (error) {
        emit(ports, eventOf("step/error", pack.id, now, { stepId: step.id, message: error }));
        emit(ports, eventOf("rollback/end", pack.id, now, { message: "回滚中断：" + error }));
        return {
          ok: false,
          packId: pack.id,
          stopReason: "rollback_failed",
          ran: ran,
          skipped: skipped,
          errors: [{ code: "ROLLBACK_FAILED", stepId: step.id, message: error }],
        };
      }
      ran.push({ stepId: step.id, inverse: preview });
      emit(ports, eventOf("step/end", pack.id, now, { stepId: step.id, title: "回滚：" + step.title }));
    }
    const journal = journalPort(ports);
    if (typeof journal.clear === "function") {
      try { await Reflect.apply(journal.clear, journal, [pack.id]); } catch (e) { /* the rollback itself succeeded */ }
    }
    emit(ports, eventOf("rollback/end", pack.id, now, { message: "回滚完成" }));
    return { ok: true, packId: pack.id, stopReason: "done", ran: ran, skipped: skipped, errors: [] };
  }

  function validatePack(input         )                       {
    return validateDeployPack(input);
  }

  function validateInputs(pack         , values         )                        {
    return validateDeployInputs(pack, values);
  }

  return { v: 1, validatePack: validatePack, validateInputs: validateInputs, plan: plan, run: run, rollback: rollback };
}

// Browser wiring for services/platform/deployer.ts: publish the executor under a non-`__` name.
// The executor is stateless per call; ports (HTTP / command / journal / handoff) arrive from the
// settings card, so nothing here touches the network or storage.
(function (g) {
  "use strict";
  if (g.deployerSvc) return;
  g.deployerSvc = createDeployer();
})(window);

globalThis.DEPLOY_STEP_KINDS = DEPLOY_STEP_KINDS;
globalThis.validateDeployPack = validateDeployPack;
globalThis.validateDeployInputs = validateDeployInputs;
globalThis.createDeployer = createDeployer;
})();
