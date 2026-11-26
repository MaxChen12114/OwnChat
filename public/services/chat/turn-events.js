(function () {
/**
 * Turn trace: the five formal turn events, their validation, and the recorder that writes the
 * persisted subset into the T3-D event log.
 *
 * Two layers, on purpose:
 *  - `turn/start`, `step/start`, `tool/call`, `step/end`, `turn/end` are the *trace* — what the turn
 *    did, in order. They feed the recorder's journal and are what a future step panel replays. The
 *    agent kernel's raw events are mapped onto them by {@link traceEventOf}; the mapping is pure so
 *    the UI keeps its own event stream unchanged.
 *  - Only `turn/start` and `turn/end` have session-event projections (the table's six message-ish
 *    types plus `session/truncate` are the persisted truth). The message rows themselves stay the
 *    message write path's job — tool rounds reach the log through the session store's archive queue,
 *    and duplicating them here would double-project them.
 *
 * The recorder is fail-soft by contract: a broken/absent event log must never break a turn, so every
 * append is wrapped and every failure is reported through the journal, not thrown.
 *
 * @module services/chat/turn-events
 */

/** The five trace types. Step and tool events are transient; the two turn events persist. */
                                                                                            

const TRACE_TYPES                       = ["turn/start", "step/start", "tool/call", "step/end", "turn/end"];

/** How a turn ended; the vocabulary the kernel's stop reasons already use, plus abort. */
                                                                                                     

                             
                  
                 
                 
             
                                                         
                
                  
                
                 
                
                 
               
                      
                  
                 
              
 

                               
              
                 
 

/** The session-log append this module consumes (services/session/events.ts answers it). */
                                
         
                   
                 
                                      
                                   
                                                                                                            
 

                                  
                                                                          
                                
                 
 

                             
                 
                  
                
                 
                  
 

                            
                          
                          
                                                                         
                             
                                                       
                                                 
                                                                                         
                          
                                                                                  
                           
 

                               
                                      
 

function strOf(value         )         {
  return value === undefined || value === null ? "" : String(value);
}

function numOf(value         )         {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function isRecord(value         )                                   {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function statusOf(value         )             {
  const s = strOf(value);
  if (s === "aborted" || s === "error" || s === "max_iterations" || s === "blocked" || s === "model_error") return s;
  return "done";
}

/**
 * Validate one trace event. A malformed event is a caller bug that must be loud at the boundary —
 * the recorder reports it in the journal instead of letting a half-shaped row reach the log.
 */
function validateTraceEvent(event         )               {
  if (!isRecord(event)) return { ok: false, error: "turn-events: 事件必须是对象" };
  const type = strOf(event["type"]);
  if (type !== "turn/start" && type !== "step/start" && type !== "tool/call"
    && type !== "step/end" && type !== "turn/end") {
    return { ok: false, error: "turn-events: 未知事件类型 " + type };
  }
  if (!strOf(event["turnId"])) return { ok: false, error: "turn-events: 缺 turnId" };
  if (!strOf(event["convId"])) return { ok: false, error: "turn-events: 缺 convId" };
  if (!numOf(event["ts"])) return { ok: false, error: "turn-events: 缺 ts" };
  if ((type === "step/start" || type === "tool/call" || type === "step/end") && numOf(event["step"]) <= 0) {
    return { ok: false, error: "turn-events: " + type + " 缺 step" };
  }
  if (type === "tool/call" && !strOf(event["name"])) return { ok: false, error: "turn-events: tool/call 缺 name" };
  if (type === "step/end" && !strOf(event["status"])) return { ok: false, error: "turn-events: step/end 缺 status" };
  if (type === "turn/end" && !strOf(event["status"])) return { ok: false, error: "turn-events: turn/end 缺 status" };
  return { ok: true };
}

/**
 * Map one agent-kernel event onto the trace vocabulary. `state.step` is the caller's last known
 * step; the mapper returns the event plus the step the caller should remember (kernel events carry
 * `iteration`, tool events do not).
 */
function traceEventOf(
  event         ,
  state                                                              ,
)                                             {
  const e = isRecord(event) ? event : {};
  const type = strOf(e["type"]);
  // Kernel iterations are 0-based; the trace's step is 1-based. Events without an iteration (tool
  // results) inherit the step the caller is in.
  const hasIteration = Object.prototype.hasOwnProperty.call(e, "iteration");
  const iteration = Math.floor(numOf(e["iteration"]));
  const step = hasIteration ? iteration + 1 : state.step;
  function make(kind           , extra                     )             {
    return Object.assign({
      type: kind,
      turnId: state.turnId,
      convId: state.convId,
      ts: state.ts,
      step: step,
    }, extra);
  }
  if (type === "model_call") return { event: make("step/start", {}), step: step };
  // `tool_run` is the start of a call; the single `tool/call` record is written when it settles, so
  // the journal has one row per call (the UI's live event stream already shows "running").
  if (type === "tool_run") return { event: null, step: step };
  if (type === "tool_done" || type === "tool_error" || type === "tool_denied") {
    return {
      event: make("tool/call", {
        name: strOf(e["name"]),
        args: e["args"],
        ok: type === "tool_done",
        error: type === "tool_error" ? strOf(e["message"] || e["error"]) : "",
        reason: type === "tool_denied" ? strOf(e["reason"]) : "",
        ms: Math.floor(numOf(e["ms"])),
      }),
      step: step,
    };
  }
  if (type === "final" || type === "model_error" || type === "aborted" || type === "max_iterations" || type === "blocked") {
    return {
      event: make("step/end", {
        status: statusOf(type === "final" ? "done" : type),
        reason: strOf(e["reason"]),
        error: type === "model_error" ? strOf(e["error"]) : "",
      }),
      step: step,
    };
  }
  return { event: null, step: step };
}

/** The persisted half of a trace event; null for the transient step/tool events. */
function sessionInputOf(event            )                                                                               {
  if (!event || typeof event !== "object") return null;
  if (event.type === "turn/start") {
    return {
      type: "turn/start",
      payload: { turnId: event.turnId, source: event.source || "", mode: event.mode || "", model: event.model || "" },
    };
  }
  if (event.type === "turn/end") {
    return {
      type: "turn/end",
      payload: {
        turnId: event.turnId,
        status: event.status || "done",
        reason: event.reason || "",
        repair: false,
      },
    };
  }
  return null;
}

function createTurnRecorder(ports                 )               {
  const now = typeof ports.now === "function" ? ports.now : function () { return Date.now(); };
  let serial = 0;

  function sink()                       {
    try {
      const s = typeof ports.sink === "function" ? ports.sink() : null;
      return s && typeof s.append === "function" ? s : null;
    } catch (e) {
      return null;
    }
  }

  function begin(input            )            {
    const convId = strOf(input && input.convId);
    const startedAt = now();
    const turnId = strOf(input && input.turnId) || ("t_" + startedAt.toString(36) + "_" + String(++serial));
    const journal               = [];
    let step = 0;
    let closed = false;
    let startSeq = 0;
    let ended = false;
    let settle                = Promise.resolve();
    const startEvent             = {
      type: "turn/start",
      turnId: turnId,
      convId: convId,
      ts: startedAt,
      source: strOf(input && input.source),
      mode: strOf(input && input.mode),
      model: strOf(input && input.model),
    };
    const startCheck = validateTraceEvent(startEvent);
    if (startCheck.ok) journal.push(startEvent);
    const startPromise                = (function () {
      const s = sink();
      if (!s || !convId || !startCheck.ok) return Promise.resolve();
      try {
        const out = s.append(convId, "turn/start", {
          turnId: turnId,
          source: startEvent.source,
          mode: startEvent.mode,
          model: startEvent.model,
        });
        return Promise.resolve(out).then(function (res) {
          if (res && res.ok && typeof res.seq === "number" && res.seq > 0) startSeq = res.seq;
        }, function () { /* fail-soft: a turn must not break because the log is down */ });
      } catch (e) {
        return Promise.resolve();
      }
    })();

    function push(event                   )       {
      if (!event || closed) return;
      const check = validateTraceEvent(event);
      if (!check.ok) return;
      journal.push(event);
    }

    function feed(raw         )       {
      if (closed) return;
      const mapped = traceEventOf(raw, { turnId: turnId, convId: convId, step: step, ts: now() });
      step = mapped.step;
      push(mapped.event);
    }

    function end(status            , reason         )       {
      if (ended) return;
      ended = true;
      closed = true;
      const endEvent             = {
        type: "turn/end",
        turnId: turnId,
        convId: convId,
        ts: now(),
        status: statusOf(status),
        reason: strOf(reason),
      };
      const check = validateTraceEvent(endEvent);
      if (check.ok) journal.push(endEvent);
      settle = startPromise.then(function () {
        const s = sink();
        if (!s || !convId || !check.ok) return;
        const payload                          = {
          turnId: turnId,
          status: endEvent.status,
          reason: endEvent.reason,
          repair: false,
        };
        if (startSeq > 0) payload["turnSeq"] = startSeq;
        try {
          return Promise.resolve(s.append(convId, "turn/end", payload)).then(function () {}, function () {});
        } catch (e) {
          /* same fail-soft rule as turn/start */
        }
      });
    }

    return {
      turnId: turnId,
      convId: convId,
      feed: feed,
      end: end,
      journal: function () { return journal.slice(); },
      settled: function () { return settle; },
    };
  }

  return { begin: begin };
}

// Browser wiring for services/chat/turn-events.ts: the five formal turn events and the recorder.
//
// `create({sink})` builds a recorder; the sink is the T3-D event service, resolved per call so a
// page whose DB port is not ready yet still records the trace locally. `feed`/`end` are fail-soft by
// contract — a broken log must never break a turn — so this wiring has no error policy of its own.
(function () {
  if (window.turnEventsSvc && window.turnEventsSvc.v === 1) return;
  window.turnEventsSvc = {
    v: 1,
    create: createTurnRecorder,
    validateTraceEvent: validateTraceEvent,
    traceEventOf: traceEventOf,
    sessionInputOf: sessionInputOf,
    TRACE_TYPES: TRACE_TYPES,
  };
})();

globalThis.TRACE_TYPES = TRACE_TYPES;
globalThis.validateTraceEvent = validateTraceEvent;
globalThis.traceEventOf = traceEventOf;
globalThis.sessionInputOf = sessionInputOf;
globalThis.createTurnRecorder = createTurnRecorder;
})();
