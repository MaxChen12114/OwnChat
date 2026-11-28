(function () {
/**
 * Scoped tool runtime: one turn's compiled tool set, with pre / execute / post around every call.
 *
 * The kernel's registry is the *catalog*; a turn must not mutate it. This module compiles a subset
 * (`profile.allow` / `profile.deny`) into a fork and swaps each tool's `run` for a wrapped one, so
 * the pipeline is the only path a turn can take. `dispose()` removes every compiled name from the
 * scoped registry — the unload path is deliberate even though the fork would be garbage anyway:
 * a runtime that grew tools mid-turn (`tool_search`, a memory domain registering its own) must be
 * able to shrink again, and the removal is what proves it.
 *
 * Ordering inside one call: pre decides (reject / rewrite args / ask for approval) → quota is
 * charged → execute → post shapes the result. A rejection returns the same `{error}` shape the
 * kernel feeds back to the model, so the model can reroute instead of retrying blindly. Quota
 * exhaustion is a rejection, not a throw: a turn that ran out of calls should still answer.
 *
 * Approval is *opt-in* (`approval` + `pre` returning `{approve:true}`), because the kernel already
 * gates destructive tools and a second unconditional prompt would ask the user twice.
 *
 * @module services/agent/tool-runtime
 */

                           
               
                       
                                       
                                                                       
                                                                                
 

/** The subset of services/agent/agent-kernel.ts's ToolRegistry this module needs. */
                                   
                                 
                                          
                     
                                
                                                                                                  
                                              
 

                              
                                                                                 
                              
                   
                  
 

/** A managed effect scope (RuntimeContext satisfies it structurally). */
                               
                                           
 

                          
               
                                
 

                             
                                                                                         
                  
                                                                          
                                 
                                                                                      
                    
 

                             
               
                                       
              
             
                 
                   
                                                                                 
                                                            
 

                                   
                                         
                                                                              
                                                                     
 

                                     
                             
                        
                                                                                       
                       
                           
                                                                                     
                                                  
                 
                                    
 

                                   
                
                 
                 
                                 
 

                              
                                      
                              
                            
                                                                
                      
                       
                                 
 

function isRecord(value         )                                   {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strOf(value         )         {
  return value === undefined || value === null ? "" : String(value);
}

/** Error text from anything thrown: `message` when it has one, `String(e)` otherwise. */
function errOf(value         )         {
  if (value && typeof value === "object") {
    const message = Reflect.get(value, "message");
    if (typeof message === "string" && message) return message;
  }
  return strOf(value);
}

function limitOf(value         )                {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** Pure name selection: `deny` wins, `directory` keeps only `allow`, `full` keeps the rest. */
function compileToolSet(registry                  , profile              )           {
  const all = registry && typeof registry.list === "function" ? registry.list() : [];
  const p = profile || {};
  const deny = new Set((Array.isArray(p.deny) ? p.deny : []).map(strOf));
  const allow = new Set((Array.isArray(p.allow) ? p.allow : []).map(strOf));
  const out           = [];
  for (const tool of all) {
    const name = strOf(tool && tool.name);
    if (!name || deny.has(name)) continue;
    if (p.mode === "directory" && !allow.has(name)) continue;
    out.push(name);
  }
  return out;
}

function rejection(message        , stage                     )                          {
  return { error: message, denied: stage === "quota" || stage === "approval", _toolRejected: stage };
}

function createToolRuntime(options                    )              {
  if (!options || !options.registry) throw new Error("tool-runtime: 缺 registry");
  const base = options.registry;
  const now = typeof options.now === "function" ? options.now : function () { return Date.now(); };
  const hooks = options.hooks || {};
  const maxCalls = limitOf(options.quota && options.quota.maxCalls);
  const perToolLimit = limitOf(options.quota && options.quota.perTool);
  const stats                   = { calls: 0, denied: 0, failed: 0, byTool: {} };
  let disposed = false;
  let reason = "";
  const compiled = compileToolSet(base, options.profile);
  const scoped                   = typeof base.fork === "function" ? base.fork() : base;
  const counts                         = {};

  function record(entry            )       {
    if (entry.ok) stats.calls++;
    else {
      stats.failed++;
      if (entry.denied) stats.denied++;
    }
    if (entry.name) stats.byTool[entry.name] = (stats.byTool[entry.name] || 0) + 1;
    if (typeof options.events === "function") {
      try { options.events(entry); } catch (e) { /* a listener failure must not fail the tool */ }
    }
  }

  async function runTool(tool          , rawArgs                         , context                         )                   {
    const name = tool.name;
    const t0 = now();
    const call          = { name: name, args: rawArgs };
    if (disposed) return rejection("工具运行时已卸载（回合已结束），" + name + " 未执行", "pre");
    let verdict             = {};
    try {
      const out = hooks.pre ? hooks.pre(call) : undefined;
      if (isRecord(out)) verdict = out;
    } catch (e) {
      record({ name: name, args: rawArgs, ok: false, ms: 0, error: errOf(e), stage: "pre" });
      return rejection("工具前置检查异常：" + errOf(e), "pre");
    }
    if (strOf(verdict.reject)) {
      record({ name: name, args: rawArgs, ok: false, ms: now() - t0, error: strOf(verdict.reject), denied: true, stage: "pre" });
      return rejection(strOf(verdict.reject), "pre");
    }
    const args = isRecord(verdict.args) ? verdict.args : rawArgs;
    call.args = args;
    const used = counts[name] || 0;
    const total = stats.calls + stats.failed;
    if ((maxCalls !== null && total >= maxCalls) || (perToolLimit !== null && used >= perToolLimit)) {
      const limit = maxCalls !== null && total >= maxCalls ? maxCalls : perToolLimit;
      const msg = "本回合工具调用已达上限（" + String(limit) + " 次），" + name + " 未执行";
      record({ name: name, args: args, ok: false, ms: now() - t0, error: msg, denied: true, stage: "quota" });
      return rejection(msg, "quota");
    }
    if (verdict.approve === true && typeof options.approval === "function") {
      let ok = false;
      try {
        ok = (await options.approval(name, args)) === true;
      } catch (e) {
        ok = false;
      }
      if (!ok) {
        const msg = "审批未通过：" + name + " 调用未执行";
        record({ name: name, args: args, ok: false, ms: now() - t0, error: msg, denied: true, stage: "approval" });
        return rejection(msg, "approval");
      }
    }
    counts[name] = used + 1;
    let result         ;
    try {
      result = await tool.run(args, context || {});
    } catch (e) {
      const msg = errOf(e);
      record({ name: name, args: args, ok: false, ms: now() - t0, error: msg, stage: "execute" });
      return rejection(msg || ("工具 " + name + " 执行失败"), "execute");
    }
    const entry             = { name: name, args: args, ok: true, ms: now() - t0 };
    if (typeof hooks.post === "function") {
      try {
        result = hooks.post(call, result, entry);
      } catch (e) {
        const msg = errOf(e);
        record({ name: name, args: args, ok: false, ms: now() - t0, error: msg, stage: "post" });
        return rejection(msg || ("工具 " + name + " 结果处理失败"), "post");
      }
    }
    record(entry);
    return result;
  }

  for (const tool of base.list()) {
    if (compiled.indexOf(tool.name) < 0) continue;
    scoped.define({
      name: tool.name,
      description: tool.description || "",
      parameters: tool.parameters || { type: "object", properties: {} },
      destructive: tool.destructive,
      run: function (args                         , context                         ) {
        return runTool(tool, args, context);
      },
    });
  }

  function dispose(why         )       {
    if (disposed) return;
    disposed = true;
    reason = strOf(why) || "turn-end";
    for (const name of compiled) {
      try { scoped.remove(name); } catch (e) { /* the fork is discarded anyway; removal is the contract */ }
    }
  }

  if (options.scope && typeof options.scope.effect === "function") {
    try { options.scope.effect(function () { return function () { dispose("scope-dispose"); }; }); } catch (e) { /* scope gone */ }
  }

  return {
    registry: scoped,
    compiled: compiled,
    stats: function () {
      return { calls: stats.calls, denied: stats.denied, failed: stats.failed, byTool: Object.assign({}, stats.byTool) };
    },
    remaining: function () {
      const total = stats.calls + stats.failed;
      return {
        total: maxCalls === null ? null : Math.max(0, maxCalls - total),
        perTool: perToolLimit,
      };
    },
    disposed: function () { return disposed; },
    lastReason: function () { return reason; },
    dispose: dispose,
  };
}

// Browser wiring for services/agent/tool-runtime.ts: the per-turn compiled tool set and its
// pre/execute/post pipeline. The registry, the scope and the hooks all arrive from the caller
// (services/agent/turn.ts), so this file only publishes the factory and the pure selection rule.
(function () {
  if (window.toolRuntimeSvc && window.toolRuntimeSvc.v === 1) return;
  window.toolRuntimeSvc = {
    v: 1,
    create: createToolRuntime,
    compileToolSet: compileToolSet,
  };
})();

globalThis.compileToolSet = compileToolSet;
globalThis.createToolRuntime = createToolRuntime;
})();
