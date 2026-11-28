(function () {
/**
 * Agent tool registry: puts the kernel's own tools and every optional tool bundle into one
 * registry, then compiles the work mode into the permission predicate the kernel calls.
 *
 * Order is load-bearing. A later registration wins a name clash, and a module that defines a
 * duplicate throws outright — one such clash once left every bundle after it unregistered. The
 * same history is why a failing bundle is reported and warned about instead of aborting the build,
 * and why the environment snapshot is taken last: it reports the tools that actually made it in.
 *
 * Absence is normal, not an error. A phone has no desktop tools, a canvas that never started has
 * no stage tools, and a build without developer mode has no file tools. Each bundle is "register
 * if present, skip otherwise" — one shape check per name — and the report says `absent` so the dev
 * panel can show what did not load.
 *
 * Bundle names stay here; looking them up on the global object is the wiring's job, which is what
 * keeps this file free of `window`. The kernel's tools are the opposite: no registry means no
 * turn, so that port returns non-null and a missing module is allowed to throw.
 * @module services/agent/registry
 */

                            
                                       
 

                                
                                                    
 

                            
                                                      
 

                                      
               
              
               
 

                                      
                    
                  
                                
 

// Work-mode and round-ceiling rules come from the settings writer's module so the two sides cannot
// drift. Declared, not imported: the emit channel only carries import-free sources, and the bare
// identifiers resolve through the globalThis bridge once settings-agent-tools.js has loaded. The
// calls happen at turn time, long after every boot script is present.
                                                                                       
                                                                                   

                                                            

                                                                             

                              
                                                                                            
                              
                                                           
                        
                                                                                   
                         
                                                   
 

                                   
       
                                                           
                          
                                                                       
                         
                         
                       
 

function isToolShell(v         )                 {
  if (!v) return false;
  if (typeof v !== "object" && typeof v !== "function") return false;
  if (!("defineTools" in v)) return false;
  return typeof v.defineTools === "function";
}

function hasSnapshot(v         )                     {
  if (!v || typeof v !== "object") return false;
  if (!("snapshotText" in v)) return false;
  return typeof v.snapshotText === "function";
}

function errText(e         )         {
  if (e && typeof e === "object" && "message" in e && e.message) return String(e.message);
  return String(e);
}

                                                                  

// Do not reorder: name shadowing and duplicate-define throws both depend on this sequence.
const SHELLS              = [
  { key: "__agentWorkspace", label: "[agent-workspace] defineTools 失败:", part: false },
  { key: "AgentReach", label: "[AgentReach] defineTools 部分失败:", part: true },
  { key: "AgentLocalTools", label: "[AgentLocalTools] defineTools 失败:" },
  { key: "__sourceTools", label: "[SourceTools] defineTools 失败:" },
  { key: "__ioTools", label: "[IoTools] defineTools 失败:" },
  { key: "__stageTools", label: "[StageTools] defineTools 失败:" },
  { key: "__jobTools", label: "[JobTools] defineTools 失败:" },
  { key: "__councilTools", label: "[CouncilTools] defineTools 失败:" },
  { key: "__localExecTools", label: "[LocalExecTools] defineTools 失败:" },
  { key: "__pcTools", label: "[PcTools] defineTools 失败:" },
  { key: "AmbientTools", label: "[AmbientTools] defineTools 失败:" },
];

// Work modes. `confirm` asks before anything with a side effect; `auto` lets file edits through
// and still asks for global changes (settings, model switch); `plan` investigates read-only and
// proposes; `full` stops asking. Only the permission compiler below consumes them.
const AGENT_FILE_TOOLS = ["write_file", "read_file", "edit_file", "list_files", "delete_file"];

// Appended in plan mode: investigate, then propose — do not act.
const PLAN_DIRECTIVE = "\n\n【本次为计划模式】你可以调用只读工具(fetch_page / web_search / read_file / list_files 等)做调查,但**不要执行任何有副作用的操作**(写文件、改角色卡/设定集/指令模块/设置、换主题换模型等)。调查清楚后,输出一份分步计划(要做什么、涉及哪些文件、风险点),等用户确认后再执行。";

const LS_MAX_ROUNDS = "cfw_agent_max_rounds_v1";

function createAgentRegistry(env             )                   {
  function build(opts                        )                      {
    const o = opts || {};
    const report                        = [];
    // Hard dependency: if this throws, the turn is over. Do not swallow it.
    const registry = env.coreTools().buildRegistry({ onImage: o.onImage });

    for (let i = 0; i < SHELLS.length; i++) {
      const s = SHELLS[i];
      const mod = env.shell(s.key);
      if (!isToolShell(mod)) {
        report.push({ name: s.key, ok: false, err: "absent" });
        continue;
      }
      try {
        mod.defineTools(registry);
        report.push({ name: s.key, ok: true });
      } catch (e) {
        // One bundle failing must not take the others down; a single duplicate-define throw once
        // left every later bundle unregistered.
        try { console.warn(s.label, e); } catch (_) {}
        report.push({ name: s.key, ok: false, err: errText(e) });
      }
    }

    // Snapshot last, on purpose: it reports the tools that are actually installed.
    let envSnap = "";
    const envMod = env.envContext();
    if (isToolShell(envMod)) {
      try {
        envMod.defineTools(registry);
        if (hasSnapshot(envMod)) {
          try { envSnap = envMod.snapshotText({ registry: registry }); } catch (_se) {}
        }
        report.push({ name: "__envContext", ok: true });
      } catch (e) {
        try { console.warn("[env-context] defineTools 失败:", e); } catch (_) {}
        report.push({ name: "__envContext", ok: false, err: errText(e) });
      }
    } else {
      report.push({ name: "__envContext", ok: false, err: "absent" });
    }

    return { registry: registry, envSnap: envSnap, report: report };
  }

  function getWorkMode()           {
    try {
      return normalizeMode(env.storage.getItem("cfw_agent_work_mode_v1"));
    } catch (e) { return "confirm"; }
  }

  // Compile the work mode into the predicate the kernel awaits. `askBase` is the page-level
  // prompt; this module never touches the DOM.
  function makePermission(mode          , askBase               )               {
    let pcApproved = false; // Remote control asks once per turn; per-click prompting is unusable.
    return async function (name        , args         )                   {
      // Bound to a boolean first: comparing `mode` again after the early returns makes TS call it
      // an impossible comparison (TS2367). Same semantics, compiler stays quiet.
      const isPlan = mode === "plan";
      if (mode === "full") return true;   // full access
      if (isPlan) return false;           // plan: read-only, no write ever passes
      const isFile = AGENT_FILE_TOOLS.indexOf(String(name)) >= 0;
      if (mode === "auto" && isFile) return true;
      const isPc = String(name || "").indexOf("pc_") === 0;
      if (isPc && pcApproved) return true;
      // The user's own "skip confirmation" switch for remote control. Plan mode is excluded by
      // design — the whole point of plan mode is that nothing runs.
      if (isPc && !isPlan) {
        try { if (env.storage.getItem("cfw_pc_skip_confirm_v1") === "1") return true; } catch (e) {}
      }
      if (typeof askBase === "function") {
        try {
          const ok = await askBase(name, args);
          if (ok && isPc) pcApproved = true;
          return ok;
        } catch (e) { return false; }
      }
      return false; // No prompt available: deny. A side effect must never pass silently.
    };
  }

  function getMaxRounds()         {
    // Unlimited by default: parseRounds maps unset/blank/zero/garbage to null (the writer deletes
    // the key for those); 1000 is the runtime ceiling that stops a runaway loop from burning money.
    try {
      const n = parseRounds(env.storage.getItem(LS_MAX_ROUNDS));
      return n === null ? 1000 : n;
    } catch (e) { return 1000; }
  }

  return {
    v: 1,
    build: build,
    getWorkMode: getWorkMode,
    makePermission: makePermission,
    getMaxRounds: getMaxRounds,
    PLAN_DIRECTIVE: PLAN_DIRECTIVE,
    FILE_TOOLS: AGENT_FILE_TOOLS,
  };
}

// ── Browser wiring (injected by tooling/l0/emit.mjs): binds the service to the frozen window contract name ──
// The implementation moved to services/agent/registry.ts; this file only binds the name and injects
// ports. Eleven optional capabilities are fetched by name (the old code did global[s.key]), hence
// shell(key); coreTools returns the tools bundle directly — when it is missing the service call throws
// a TypeError on purpose, because that dependency is hard and must not degrade silently.
(function () {
  if (window.__agentRegistry && window.__agentRegistry.v === 1) return;
  window.__agentRegistry = createAgentRegistry({
    shell: function (key) { return window[key]; },
    envContext: function () { return window.__envContext; },
    coreTools: function () { return window.OwnChatTools; },
    storage: {
      getItem: function (key) { return window.localStorage.getItem(key); },
    },
  });
})();

globalThis.createAgentRegistry = createAgentRegistry;
})();
