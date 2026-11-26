(function () {
/**
 * Agent story: OwnChat `agent-trace` records reshaped for the Work/History views.
 *
 * Adapted from Ephemeral-AI-Lab/dsh-layerfs (MIT):
 *   packages/model/src/attribution.js
 *   packages/model/src/where.js
 *   packages/model/src/pose.js
 *
 * The original turns LayerFS SDK calls into agent places, poses and terminal
 * lines. This module keeps the same view state but takes OwnChat's trace shape:
 * `{ id, convId, startedAt, events: [{ type, name, args, ok, ms, t }] }`.
 * A place is a run (one trace record); there are no Branch/Workspace/Sandbox
 * concepts here, so the model stays host-free and testable.
 *
 * Thresholds are the original's: a call keeps its agent at the place it ran for
 * 12 s, a recently-idle agent stays "here" for 90 s, an idle lane fades at 30 s
 * and retires at 120 s. The first two drive presence now; the last two are for
 * the Work board when it lands.
 * @module services/agent/story
 */

/** Seconds a call keeps its agent at the place it ran (dsh-layerfs where.js). */
const CALL_S = 12;
/** Seconds an idle agent stays "recently here". */
const RECENT_S = 90;
/** Seconds after which an idle agent is asleep rather than merely idle. */
const IDLE_S = 40;
/** Seconds before an idle lane fades; kept for the future Work board. */
const FADE_S = 30;
/** Seconds before an unused lane retires; kept for the future Work board. */
const RETIRE_S = 120;

const BRIEF_KEYS = [
  "path", "file", "file_path", "filename", "url", "query", "q",
  "keyword", "name", "pattern", "id", "topic", "text", "content",
];

                             
                
                
                 
               
              
             
                  
                    
                         
 

                              
              
                  
                 
                     
                     
                        
                         
 

                            
             
                
                
                 
                         
                
              
             
               
               
                                
                  
               
 

                             
               
                 
 

                             
             
               
                  
                 
                
                      
                 
                             
                                
 

                            
             
                
                    
                  
                    
 

                        
                                     
                    
                     
                    
                  
 

                                
                           
               
                  
                
                 
 

                    
               
                                
            
 

/** Object guard for values that came from storage or from the model. */
function recOf(value         )                          {
  const out                          = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value)) out[k] = v;
  return out;
}

function strOf(value         )         {
  return value == null ? "" : String(value);
}

function numOf(value         )         {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** One-line argument brief, the same priority order the step cards use. */
function briefArgs(args         )         {
  const a = recOf(args);
  for (const key of BRIEF_KEYS) {
    const v = a[key];
    if (typeof v === "string" && v) return v.length > 90 ? v.slice(0, 90) + "…" : v;
  }
  const rest = Object.keys(a)
    .filter((k) => BRIEF_KEYS.indexOf(k) < 0 && a[k] != null && a[k] !== "")
    .map((k) => k + "=" + strOf(a[k]).slice(0, 40));
  return rest.length ? rest.join(" ") : "";
}

/** The name the views show for a trace's agent. */
function agentOf(trace                         )         {
  return strOf(trace["agent"]) || strOf(trace["agentName"]) || strOf(trace["convId"]) || "main";
}

function lineId(trace                         , kind        , n        )         {
  return strOf(trace["id"]) + ":" + kind + n;
}

/**
 * One trace record -> end lines plus any still-running starts.
 *
 * `start`/`end` are epoch ms. `tool_run` and `tool_done` pairs on the same name
 * are matched in order, which is how the kernel emits concurrent calls; an
 * unmatched `tool_run` becomes a `phase: "start"` line so a view can show it as
 * running without inventing an end.
 */
function traceToLines(trace                         )              {
  const started = numOf(trace["startedAt"]);
  const events = Array.isArray(trace["events"]) ? trace["events"] : [];
  const agent = agentOf(trace);
  const open = new Map                    ();
  const lines              = [];

  for (const raw of events) {
    const ev = recOf(raw);
    const t = numOf(ev["t"]);
    const type = strOf(ev["type"]);
    if (type === "model_call") {
      lines.push({
        id: lineId(trace, "m", lines.length),
        runId: strOf(trace["id"]),
        agent,
        method: "model_call",
        phase: "end",
        start: started + t,
        end: started + t,
        ms: 0,
        ok: true,
        code: "ModelCall",
        args: {},
        summary: "",
        text: "model",
      });
      continue;
    }
    if (type === "tool_run" && ev["name"]) {
      const name = strOf(ev["name"]);
      const q = open.get(name) || [];
      q.push({ name, args: recOf(ev["args"]), t });
      open.set(name, q);
      continue;
    }
    if (type === "tool_done" || type === "tool_error" || type === "tool_denied") {
      const name = strOf(ev["name"]);
      const q = open.get(name) || [];
      const run = q.shift() || null;
      if (q.length) open.set(name, q);
      else open.delete(name);
      const ms = Math.max(0, numOf(ev["ms"]));
      const end = started + t;
      const ok = type === "tool_done" ? ev["ok"] !== false : false;
      const code = type === "tool_denied" ? "Denied" : ok ? "Ok" : ev["error"] ? "Error" : "Failed";
      const args = run ? run.args : {};
      const method = strOf(ev["name"]) || (run ? run.name : "tool");
      const brief = briefArgs(args);
      lines.push({
        id: lineId(trace, "t", lines.length),
        runId: strOf(trace["id"]),
        agent,
        method,
        phase: "end",
        start: Math.max(0, end - ms),
        end,
        ms,
        ok,
        code,
        args,
        summary: ev["summary"] == null ? (ev["error"] == null ? "" : strOf(ev["error"])) : strOf(ev["summary"]),
        text: method + (brief ? " " + brief : ""),
      });
    }
  }

  // A call with a start and no end is still running; keep it for the running set.
  for (const [name, q] of open) {
    for (const run of q) {
      lines.push({
        id: lineId(trace, "s", lines.length),
        runId: strOf(trace["id"]),
        agent,
        method: name,
        phase: "start",
        start: started + run.t,
        end: started + run.t,
        ms: 0,
        code: "Running",
        args: run.args,
        summary: "",
        text: name + " …",
      });
    }
  }
  return lines.sort((a, b) => a.start - b.start || (a.phase === "start" ? -1 : 1));
}

/** End lines only: what playback feeds. */
function endLines(lines             )              {
  return lines.filter((line) => line && line.phase !== "start");
}

/** Lines a view should mark as running: starts with no matching end. */
function runningLines(lines             )              {
  return lines.filter((line) => line && line.phase === "start");
}

/**
 * Traces -> one story: agents, runs, lines, presence at the last event.
 * Traces sort by `startedAt`, so a parallel session reads as two lanes from
 * the beginning rather than depending on input order.
 */
function storyFromTraces(traces         )        {
  const records = (Array.isArray(traces) ? traces : [])
    .filter((t) => t && typeof t === "object")
    .map(recOf)
    .sort((a, b) => numOf(a["startedAt"]) - numOf(b["startedAt"]));

  const agents                             = {};
  const runs              = [];
  const lines              = [];

  for (const trace of records) {
    const id = strOf(trace["id"]);
    const agentId = agentOf(trace);
    const runLines = traceToLines(trace);
    const ended = runLines.filter((l) => l.phase === "end");
    const startedAt = numOf(trace["startedAt"]);
    const endedAt = ended.length ? Math.max(...ended.map((l) => l.end)) : startedAt;
    runs.push({ id, agent: agentId, startedAt, endedAt, lineCount: ended.length });
    let agent = agents[agentId];
    if (!agent) {
      agent = {
        id: agentId,
        name: agentId,
        lines: [],
        runs: [],
        lastT: -Infinity,
        lastLoc: { kind: "bench" },
        status: "idle",
        lastLine: null,
        runningLine: null,
      };
      agents[agentId] = agent;
    }
    agent.runs.push(id);
    for (const line of runLines) {
      lines.push(line);
      agent.lines.push(line.id);
      if (line.phase === "start") {
        agent.runningLine = line;
        continue;
      }
      if (agent.runningLine && agent.runningLine.method === line.method) agent.runningLine = null;
      if (line.end >= agent.lastT) {
        agent.lastT = line.end;
        agent.lastLine = line;
        agent.lastLoc = { kind: "run", runId: id };
        agent.status = line.ok === false ? line.code : "Ok";
      }
    }
  }

  lines.sort((a, b) => a.start - b.start || (a.phase === "start" ? -1 : 1));
  const ends = lines.map((l) => l.end).filter(Number.isFinite);
  const startedAt = records.length ? numOf(records[0]["startedAt"]) : 0;
  const endedAt = ends.length ? Math.max(...ends) : startedAt;
  return { agents, runs, lines, startedAt, endedAt };
}

/** One trace's story, the common case for a single run. */
function storyOf(trace         )        {
  return storyFromTraces([trace]);
}

/**
 * Where an agent stands, from its own calls only: the place of a call that
 * ended within CALL_S, else the bench. The original's mounted-Workspace
 * fallback has no OwnChat equivalent yet, so the bench is the only fallback.
 */
function where(story       , agentId        , now         )                    {
  const agent = story.agents[agentId];
  if (!agent) return null;
  const at = typeof now === "number" ? now : story.endedAt;
  if (at - agent.lastT <= CALL_S * 1000) return agent.lastLoc;
  return { kind: "bench" };
}

/**
 * What an agent is doing, as a pose name. A still-running call owns the pose;
 * after CALL_S the outcome pose falls back to idle/sleep, as the original's
 * per-step `out.tick` rule does.
 */
function poseOf(story       , agentId        , now         )         {
  const agent = story.agents[agentId];
  if (!agent || !agent.lastLine) return "idle";
  const at = typeof now === "number" ? now : story.endedAt;
  if (agent.runningLine) return "laptop";
  if (at - agent.lastT > CALL_S * 1000) {
    return at - agent.lastT > IDLE_S * 1000 ? "sleep" : "idle";
  }
  const line = agent.lastLine;
  if (line.ok === false) return line.code === "Denied" ? "refused" : "failed";
  if (line.method === "model_call") return "laptop";
  if (line.ok === true) return "cheer";
  return "idle";
}

/** Every agent's place and pose at `now`; the Work board's input. */
function presence(story       , now         )                                {
  const out                                = {};
  const at = typeof now === "number" ? now : story.endedAt;
  for (const id of Object.keys(story.agents)) {
    const agent = story.agents[id];
    out[id] = {
      where: where(story, id, at),
      pose: poseOf(story, id, at),
      active: at - agent.lastT <= CALL_S * 1000,
      lastT: agent.lastT,
      status: agent.status,
    };
  }
  return out;
}

// Browser wiring (injected by l0/emit.mjs): none yet.
//
// services/agent/story.ts is the pure Work/History model: trace records ->
// agents, places and terminal lines. It is loaded from the boot manifest since
// 2026-11-17 but publishes no window.__* contract; the Work/History panel will
// define the one frozen contract when it lands (a single --update-contracts
// run), so this file stays a comment instead of inventing a name now.

globalThis.CALL_S = CALL_S;
globalThis.RECENT_S = RECENT_S;
globalThis.IDLE_S = IDLE_S;
globalThis.FADE_S = FADE_S;
globalThis.RETIRE_S = RETIRE_S;
globalThis.traceToLines = traceToLines;
globalThis.endLines = endLines;
globalThis.runningLines = runningLines;
globalThis.storyFromTraces = storyFromTraces;
globalThis.storyOf = storyOf;
globalThis.poseOf = poseOf;
globalThis.presence = presence;
})();
