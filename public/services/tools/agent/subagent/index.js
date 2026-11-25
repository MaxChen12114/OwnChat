(function () {
/**
 * Sub-agent delegation: the throwaway worker the session agent spins up on the spot.
 *
 * Vocabulary, because the three kinds are constantly confused (peer-calls.ts carries the same note):
 *   · a PEER is a configured role card calling its own model, able to message other cards;
 *   · a SUB-AGENT is this — a peer worker forked from the session agent's full registry: same tools
 *     and same permission gate, used once, discarded, reporting only to the session agent (never to
 *     the user, never into the conversation timeline);
 *   · a COUNCIL seat is a fixed three-way board (council-tools.ts), not a child of anything.
 *
 * What lives here is the **orchestration**, not the tool schema: the depth ceiling that stops
 * runaway recursion, the forked full-capability registry (minus the three orchestration tools) that
 * makes the child a peer worker instead of a read-only helper, the reach tools the fallback set
 * needs or "search then summarise" fails outright, the event pair the UI draws, and the
 * normalisation of every failure into `{ok:false}`. The tool definition stays in the tools bundle
 * and only forwards, because a tool body that owns a recursion policy is how that file grew to a
 * thousand lines.
 *
 * Never throws. A thrown tool kills the turn, and a child failure is a normal outcome the parent
 * should be able to read and route around.
 *
 * Dependencies arrive as ports so this file names no global: the child forks `ctx.parentRegistry`
 * (injected by the turn) when it can, falling back to the parent's factory for a full set; the
 * kernel and the reach bundle are looked up per call because boot order is not fixed. Never fall
 * back to the parent registry object itself — that would fail open and re-admit orchestration tools.
 *
 * Lock: `test/subagent-peer-worker.test.mjs`.
 * @module services/tools/agent/subagent
 */

/** The recursion ceiling used when the caller does not pass one. */
const DEFAULT_MAX_DEPTH = 2;

/** How many model rounds a child may run; every round bills. */
const DEFAULT_MAX_ITERATIONS = 6;

/** One registered tool, as handed over by `list()` on a parent registry. */
                                 
               
                       
                                       
                                                                                    
                                                                       
 

/** The registry surface this module needs. Structural on purpose — no kernel import, no casts. */
                                    
                                       
                           
                                               
                                 
 

                                 
                                                                 
                                                                                          
                                           
 

                               
                                                                                            
                                                                                 
                                                                                  
                                  
                                                                                               
                   
 

                                
                                                                                         
                 
                                                   
                 
                                                                         
                  
                     
                             
                                                                                                    
                      
                             
                    
                                                                                                   
                                            
 

                                 
              
                
                  
                 
 

                              
                                                     
                                     
 

/** Copies own enumerable properties; anything that is not a plain object becomes empty. */
function recOf(value         )                          {
  const out                          = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) out[k] = v;
  }
  return out;
}
function text(v         )         {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

function createSubagent(deps              )              {
  async function run(input               )                          {
    const ctx = recOf(input);

    const kernel = deps.kernel();
    if (!kernel || typeof kernel.runAgentLoop !== "function") {
      return { ok: false, error: "AgentKernel 未就绪,无法派生子 agent" };
    }
    if (typeof ctx.callModel !== "function") {
      return { ok: false, error: "缺少 callModel,无法派生子 agent" };
    }

    const depth = (typeof ctx.depth === "number" ? ctx.depth : 0) + 1;
    const maxDepth = typeof ctx.maxDepth === "number" ? ctx.maxDepth : DEFAULT_MAX_DEPTH;
    if (depth > maxDepth) {
      return { ok: false, error: "子 agent 嵌套已达上限(" + maxDepth + "),请直接完成该子任务" };
    }

    const role = text(ctx.role) || "子 agent";
    const onEvent = typeof ctx.onEvent === "function" ? ctx.onEvent : function () {};
    onEvent({ type: "subagent_start", role, task: ctx.task, depth });

    // Peer worker: reuse the session agent's exact registry, minus the orchestration tools. A fork
    // keeps every capability (core tools, capability groups, role memory, reach, dynamic tools) and
    // the same permission posture; excluding the three orchestrators is what stops recursion.
    // Never fall back to `parentRegistry` itself — that would fail open and re-admit them.
    const ORCH_TOOLS = ["delegate_to_agent", "convene_meeting", "invite_character"];
    let subRegistry                   ;
    try {
      const parent = input.parentRegistry;
      if (parent && typeof parent.fork === "function") {
        subRegistry = parent.fork(ORCH_TOOLS);
      } else if (parent && typeof parent.list === "function" && typeof kernel.createToolRegistry === "function") {
        const copy = kernel.createToolRegistry();
        for (const def of parent.list()) {
          if (ORCH_TOOLS.indexOf(def.name) >= 0) continue;
          copy.define(def);
        }
        if (typeof copy.remove === "function") {
          for (const n of ORCH_TOOLS) copy.remove(n);
        }
        subRegistry = copy;
      } else {
        // No parent registry: build the full set here, then shed the orchestration tools. The old
        // read-only `sub` profile is retired.
        subRegistry = deps.buildRegistry({ onImage: ctx.onImage, profile: "full" });
        // Reach tools are registered separately from the built-in set. Without this the child cannot
        // fetch or search at all, which silently breaks every "look it up and summarise" delegation.
        const reach = recOf(deps.reach());
        if (typeof reach.defineTools === "function") {
          try {
            reach.defineTools(subRegistry);
          } catch (e) {
            // One tool failing to register must not abort the delegation.
          }
        }
        if (typeof subRegistry.remove === "function") {
          for (const n of ORCH_TOOLS) subRegistry.remove(n);
        }
      }
    } catch (e) {
      return { ok: false, error: "子 agent 工具集装配失败: " + (e && e.message ? e.message : e) };
    }

    const subMessages = [
      {
        role: "system",
        content:
          "你是名为「" + role + "」的 worker agent,与调用你的会话 agent 能力平级,可使用同一套工具完成被指派的完整子任务（读写文件、检索、改工作区等均可,受同一套权限闸门约束）。" +
          "只允许向会话 agent 汇报:你的最终结论会作为工具结果回传给会话 agent,由它汇总后对用户输出;你自己的回复不会进入对话时间线,也不要假装直接对用户说话。" +
          "完成后给出结构化的结论与关键产物位置,不要寒暄。",
      },
      { role: "user", content: text(ctx.task) },
    ];

    try {
      const sub = recOf(
        await kernel.runAgentLoop({
          messages: subMessages,
          registry: subRegistry,
          callModel: ctx.callModel,
          maxIterations: typeof ctx.subMaxIterations === "number" ? ctx.subMaxIterations : DEFAULT_MAX_ITERATIONS,
          context: Object.assign({}, ctx, { depth }),
          ensurePermission: ctx.ensurePermission,
          onEvent,
        }),
      );
      onEvent({ type: "subagent_done", role, depth });
      return { ok: true, role, result: text(sub.finalText) };
    } catch (e) {
      onEvent({ type: "subagent_done", role, depth });
      const err = recOf(e);
      return { ok: false, error: "子 agent 运行失败: " + text(err.message || e) };
    }
  }

  return { run, DEFAULT_MAX_DEPTH };
}

// ── Sub-agent delegation (2026-11-21): the recursion policy and the child's least-privilege set
// live in services/agent/subagent.ts. There is no IO to inject — the tools bundle constructs the
// instance, because it is the side that owns the registry factory, and injecting the factory the
// other way round would be a cycle. Emit's global bridge publishes createSubagent for that caller.

globalThis.DEFAULT_MAX_DEPTH = DEFAULT_MAX_DEPTH;
globalThis.DEFAULT_MAX_ITERATIONS = DEFAULT_MAX_ITERATIONS;
globalThis.createSubagent = createSubagent;
})();
