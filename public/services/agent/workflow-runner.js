(function () {
/**
 * B7 workflow executor (v1). Runs a schema-validated declarative pack: prompt / tool / condition.
 * The host injects callModel / callTool / onEvent / signal; this module owns no network, UI or DOM.
 *
 * Hard gates: 20 steps, 10 minutes, 50 condition-loop executions, abortable via AbortSignal.
 * The schema is an injected PORT, not a global: createWorkflowRunner(schemaProvider) is given a
 * function that yields the schema, and the classic binding in tooling/l0/wiring/workflow-runner.js resolves
 * `window.__workflowSchema` at call time (so load order cannot freeze a null snapshot). The frozen
 * `window.__workflowRunner` contract is mounted there too; this file has zero browser globals.
 * @module services/agent/workflow-runner
 */

                                                                 

const MAX_EXECUTIONS = 50;

/** Any host value -> text: strings pass through, {text} objects unwrap, else JSON. */
function normalizeText(v         )         {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const t = recOf(v).text;
    if (typeof t === "string") return t;
  }
  try {
    const s = JSON.stringify(v);
    return typeof s === "string" ? s : String(v);
  } catch (e) {
    return String(v);
  }
}

function recOf(v         )                          {
  const out                          = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const entries = Object.entries(v);
    for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  }
  return out;
}

function short(s         )         {
  const str = String(s == null ? "" : s);
  return str.length > 200 ? str.slice(0, 200) + "…" : str;
}

                                        
                
 

                            
              
                     
                                   
                         
 

                                 
                                                                                    
                                     
 

/**
 * Build the executor around a schema provider. The provider is called per run — never at install
 * time — so a schema that arrives late (or is replaced) is visible to the next run.
 */
function createWorkflowRunner(schemaProvider                             )                 {
  async function runWorkflow(workflow         , host         , opts          )                     {
    const h = recOf(host);
    const o = recOf(opts);
    const schema = schemaProvider();
    if (!schema || typeof schema.validateWorkflow !== "function") {
      return {
        ok: false,
        stopReason: "invalid",
        errors: [{ code: "SCHEMA_MISSING", message: "workflow-schema.js 未加载" }],
        steps: [],
      };
    }

    const v = schema.validateWorkflow(workflow, { tools: h.tools || o.tools });
    if (!v.ok) return { ok: false, stopReason: "invalid", errors: v.errors, warnings: v.warnings, steps: [] };
    const wf = v.workflow;
    if (!wf) return { ok: false, stopReason: "invalid", errors: v.errors, warnings: v.warnings, steps: [] };

    const vars                          = Object.assign({}, recOf(o.inputs));
    const missingInputs            = [];
    for (let mi = 0; mi < wf.inputs.length; mi++) {
      const inputName = wf.inputs[mi];
      const key = typeof inputName === "string" ? inputName : String(inputName);
      if (!Object.prototype.hasOwnProperty.call(vars, key)) missingInputs.push(inputName);
    }
    if (missingInputs.length) {
      return { ok: false, stopReason: "missing_input", errors: [{ code: "MISSING_INPUT", names: missingInputs }], steps: [] };
    }

    const records                            = [];
    const startedAt = Date.now();
    const timeoutRaw = o.timeoutMs;
    let timeoutMs = Number(timeoutRaw) > 0 ? Number(timeoutRaw) : wf.timeoutMs;
    timeoutMs = Math.min(timeoutMs || 10 * 60 * 1000, 10 * 60 * 1000);
    const state = { timeout: false, aborted: false };

    const signalRaw = h.signal;
    // AbortSignal keeps addEventListener/aborted on its prototype, not as own enumerable keys —
    // recOf would erase them, so read the port through Reflect.get instead.
    if (propOf(signalRaw, "aborted")) {
      return { ok: false, stopReason: "aborted", steps: [], elapsedMs: 0 };
    }

    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const onHostAbort = function () {
      state.aborted = true;
      if (controller) controller.abort();
    };
    const addAbort = propOf(signalRaw, "addEventListener");
    const removeAbort = propOf(signalRaw, "removeEventListener");
    if (signalRaw && typeof addAbort === "function") Reflect.apply(addAbort, signalRaw, ["abort", onHostAbort]);
    let timer                                       = null;
    if (controller) {
      timer = setTimeout(function () {
        state.timeout = true;
        controller.abort();
      }, timeoutMs);
    }

    function abortError()                 {
      const e                 = new Error(state.timeout ? "工作流超时" : "工作流已停止");
      e.name = "AbortError";
      e.kind = state.timeout ? "timeout" : "aborted";
      return e;
    }

    function race(p                  )                   {
      if (!controller) return p;
      const sig = controller.signal;
      if (sig.aborted) return Promise.reject(abortError());
      return new Promise(function (resolve, reject) {
        const onAbort = function () { reject(abortError()); };
        sig.addEventListener("abort", onAbort, { once: true });
        p.then(function (val) {
          sig.removeEventListener("abort", onAbort);
          resolve(val);
        }, function (err) {
          sig.removeEventListener("abort", onAbort);
          reject(err);
        });
      });
    }

    const onEvent = h.onEvent;
    function emit(evt                         )       {
      if (typeof onEvent === "function") {
        try { Reflect.apply(onEvent, undefined, [evt]); } catch (e) { /* UI failures never stop a run */ }
      }
    }

    function stop(reason        , extra          )            {
      const out            = { ok: false, stopReason: reason, steps: records, elapsedMs: Date.now() - startedAt };
      if (extra) {
        const e = recOf(extra);
        const keys = Object.keys(e);
        for (let k = 0; k < keys.length; k++) out[keys[k]] = e[keys[k]];
      }
      return out;
    }

    const steps = wf.steps;
    const indexById                         = {};
    for (let z = 0; z < steps.length; z++) {
      const sid = recOf(steps[z]).id;
      if (typeof sid === "string") indexById[sid] = z;
    }

    let i = 0;
    let executions = 0;

    try {
      while (i < steps.length) {
        if (state.aborted) return stop("aborted");
        if (state.timeout || Date.now() - startedAt > timeoutMs) return stop("timeout");
        if (++executions > MAX_EXECUTIONS) return stop("loop_limit");
        const step = recOf(steps[i]);
        const stepId = step.id;
        const idKey = typeof stepId === "string" ? stepId : String(stepId);
        const t0 = Date.now();
        emit({ type: "step_start", id: stepId, index: i, stepType: step.type });

        if (step.type === "prompt") {
          const callModel = h.callModel;
          if (typeof callModel !== "function") return stop("host_missing", { error: "host.callModel 未提供" });
          const pr = schema.interpolate(step.text, vars);
          if (!pr.ok) return stop("missing_var", { stepId: stepId, missing: pr.missing });
          const modelRes = await race(Promise.resolve().then(function () {
            return Reflect.apply(callModel, undefined, [{ prompt: pr.text, stepId: stepId, vars: Object.assign({}, vars) }]);
          }));
          const text = normalizeText(modelRes);
          vars[idKey] = text;
          records.push({ id: stepId, type: "prompt", text: text, ms: Date.now() - t0 });
          emit({ type: "step_done", id: stepId, ms: Date.now() - t0, summary: short(text) });
          i++;
          continue;
        }

        if (step.type === "tool") {
          const callTool = h.callTool;
          if (typeof callTool !== "function") return stop("host_missing", { error: "host.callTool 未提供" });
          const missing           = [];
          const args = schema.interpolateDeep(step.args || {}, vars, missing);
          if (missing.length) return stop("missing_var", { stepId: stepId, missing: missing });
          const toolRes = await race(Promise.resolve().then(function () {
            return Reflect.apply(callTool, undefined, [step.tool, args, { stepId: stepId }]);
          }));
          const toolText = normalizeText(toolRes);
          vars[idKey] = toolText;
          records.push({ id: stepId, type: "tool", tool: step.tool, args: args, result: toolText, ms: Date.now() - t0 });
          emit({ type: "step_done", id: stepId, ms: Date.now() - t0, summary: short(toolText) });
          i++;
          continue;
        }

        if (step.type === "condition") {
          const leftR = schema.interpolate(step.if, vars);
          if (!leftR.ok) return stop("missing_var", { stepId: stepId, missing: leftR.missing });
          const rightR = step.value != null ? schema.interpolate(step.value, vars) : { ok: true, text: "", missing: [] };
          if (!rightR.ok) return stop("missing_var", { stepId: stepId, missing: rightR.missing });
          const result = schema.evalCondition(leftR.text, step.op || "contains", rightR.text);
          vars[idKey] = result ? "true" : "false";
          records.push({ id: stepId, type: "condition", result: result, ms: Date.now() - t0 });
          emit({ type: "condition", id: stepId, result: result });
          emit({ type: "step_done", id: stepId, ms: Date.now() - t0, summary: "condition=" + result });
          const target = result ? step.then : step.else;
          if (target) {
            const idx = indexById[String(target)];
            if (idx == null) return stop("bad_jump", { stepId: stepId, target: target });
            i = idx;
          } else i++;
          continue;
        }

        return stop("bad_step", { stepId: stepId, type: step.type });
      }

      const outputs                          = {};
      const outIds = wf.outputs && wf.outputs.length ? wf.outputs : [];
      for (let oi = 0; oi < outIds.length; oi++) {
        const oid = outIds[oi];
        const key = typeof oid === "string" ? oid : String(oid);
        if (!Object.prototype.hasOwnProperty.call(vars, key)) return stop("missing_output", { name: oid });
        outputs[key] = vars[key];
      }
      emit({ type: "workflow_done", outputs: Object.keys(outputs), elapsedMs: Date.now() - startedAt });
      return { ok: true, stopReason: "completed", outputs: outputs, steps: records, elapsedMs: Date.now() - startedAt };
    } catch (e) {
      if (e && e.name === "AbortError") return stop(e.kind || "aborted", { error: e.message });
      return stop("error", { error: e && e.message ? e.message : String(e) });
    } finally {
      if (timer) clearTimeout(timer);
      if (signalRaw && typeof removeAbort === "function") Reflect.apply(removeAbort, signalRaw, ["abort", onHostAbort]);
    }
  }

  /** Read a property off an unknown port, including prototype members (AbortSignal lives there). */
  function propOf(v         , key        )          {
    if (!v || (typeof v !== "object" && typeof v !== "function")) return undefined;
    return Reflect.get(v, key);
  }

  return { runWorkflow: runWorkflow, _limits: { maxExecutions: MAX_EXECUTIONS } };
}

// Classic binding for services/agent/workflow-runner.ts. The executor reads no global: the schema
// port resolves window.__workflowSchema on every call, so a schema loaded after this product is still
// visible to the next run. This file only publishes the frozen window.__workflowRunner namespace.
(function () {
  "use strict";
  if (window.__workflowRunner) return;
  window.__workflowRunner = createWorkflowRunner(function () {
    return window.__workflowSchema || null;
  });
})();

globalThis.createWorkflowRunner = createWorkflowRunner;
})();
