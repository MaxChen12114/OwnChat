(function () {
/**
 * Turn plan: the pure decisions `sendOne` / `sendOneAgent` used to take inline.
 *
 * What lives here is *which* turn runs, what its request needs and when compaction is attempted —
 * never the request itself. The send paths keep the DOM, the bubbles and the streaming; they ask
 * this module first and then execute the returned plan. That split is what makes the old behaviour
 * testable without a page: every input below is a snapshot the caller already has.
 *
 * Deliberate non-decisions:
 *  - Model usability is *echoed*, not gated. The old flow built the user bubble first and refused
 *    after, so a plan that refused up front would change the transcript.
 *  - The compaction watermark (token ratio) is not re-computed; `attempt` only says the cheap gates
 *    passed. The runner owns the watermark and the pairing-safe cutoff.
 *  - Retry budgets are copied from the caller's policy; services/chat/retry.ts remains their home.
 *
 * @module services/chat/turn-plan
 */

/** Why a send was refused before any turn was created. */
                                                           

/** Why compaction is or is not attempted for this turn. */
                                                                                              

/** The retry budget the caller's call-loop uses; echoed so the plan is self-describing. */
                              
              
                 
                         
 

/** What the caller knows about the compaction gate at send time. */
                              
                   
                          
                        
                                                                                                       
                              
 

                            
                         
                                                                        
                  
               
                          
                          
                                         
                    
                                                             
                     
                                                                                           
                       
                       
                         
                                                                                           
                                 
                    
                     
 

                           
              
                      
                         
                                                                                       
                    
               
                  
                                                                                
                        
                                                                            
                      
                                                       
                             
                                                                                
                     
 

                              
                                                                                                    
                          
 

                             
                 
                   
                                                                                             
                       
                              
                            
                                                                                              
                           
 

                             
                      
                                          
                  
                     
 

                                
                 
                      
              
 

function numOr(value         , fallback        )         {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function strOf(value         )         {
  return value === undefined || value === null ? "" : String(value);
}

/** The cheap compaction gates; the watermark and the tool-pair boundary stay in the runner. */
function compactGateOf(gate             )                                              {
  if (!gate || gate.enabled !== true) return { attempt: false, reason: "disabled" };
  if (gate.historyEnabled !== true) return { attempt: false, reason: "history-off" };
  if (numOr(gate.sessionLength, 0) <= 4) return { attempt: false, reason: "too-short" };
  if (gate.endsInToolExchange === true) return { attempt: false, reason: "tool-exchange" };
  return { attempt: true, reason: "ok" };
}

/**
 * The turn plan. `ok:false` means "no turn is created"; the caller returns its old falsy value.
 * A `delegate` plan keeps `ok:true` and the caller forwards to the agent path, which plans again —
 * that is intentional: the agent path has its own refusal reasons (mid-turn model switch).
 */
function planSend(input           )           {
  const kind                   = input && input.kind === "agent" ? "agent" : "chat";
  const text = strOf(input && input.text).trim();
  const isAuto = !!(input && input.isAuto);
  const hasAttachments = !!(input && input.hasAttachments);
  const gateInput              = (input && input.compact) || { enabled: false, historyEnabled: false, sessionLength: 0, endsInToolExchange: false };
  const compact = compactGateOf(gateInput);
  const policy = (input && input.retry) || { max: 0, idleMs: 0, emptyStreakMax: 0 };
  const retry              = {
    max: numOr(policy.max, 0),
    idleMs: numOr(policy.idleMs, 0),
    emptyStreakMax: numOr(policy.emptyStreakMax, 0),
  };
  const agent                    = {
    maxRounds: numOr(input && input.agentMaxRounds, 8),
    toolMode: input && input.toolMode === "directory" ? "directory" : "full",
    vision: !!(input && input.visionOn),
  };
  const base           = {
    ok: false,
    reason: "",
    kind: kind,
    delegate: false,
    text: text,
    isAuto: isAuto,
    buildUserRow: false,
    clearInput: false,
    compact: compact,
    model: { usable: !!(input && input.modelUsable) },
    agent: agent,
    retry: retry,
  };
  if (input && input.convBusy === true) return Object.assign(base, { reason: "conv-busy" });
  if (kind === "chat" && input && input.agentMode === true) {
    // The agent path re-plans; only its own gates can refuse it.
    return Object.assign(base, { ok: true, delegate: true, buildUserRow: true, clearInput: !isAuto });
  }
  if (!text && !(input && input.allowEmptyText === true) && !hasAttachments) {
    return Object.assign(base, { reason: "empty-input" });
  }
  return Object.assign(base, {
    ok: true,
    buildUserRow: !!(text || hasAttachments),
    clearInput: !isAuto,
  });
}

/** The cancellation policy. Retry/delete discard the partial; stop keeps it as a full reply. */
function planCancel(input             )             {
  const discard = !!(input && input.discardPartial);
  return {
    abort: true,
    discard: discard,
    keepPartial: !discard,
    clearPartialStream: discard,
    clearPartialText: discard,
    markDiscardFlag: discard,
  };
}

/** The retry decision the call-loop makes after a failed attempt. */
function planRetry(input            )                {
  const policy              = (input && input.policy) || { max: 0, idleMs: 0, emptyStreakMax: 0 };
  const attempt = Math.max(0, Math.floor(numOr(input && input.attempt, 0)));
  const max = Math.max(0, Math.floor(numOr(policy.max, 0)));
  const retry = !!(input && input.retryable === true) && attempt + 1 < max;
  return { retry: retry, nextAttempt: attempt + 1, max: max };
}

// Browser wiring for services/chat/turn-plan.ts: the pure send/cancel/retry decisions.
//
// The service takes snapshots, never page state, so this wiring is a name binding and nothing else.
// `sendOne` / `sendOneAgent` read the plan once per send and then execute it; the threshold tables
// and the retry budget stay with their owners (context.ts / retry.ts) and are copied in as inputs.
(function () {
  if (window.turnPlanSvc && window.turnPlanSvc.v === 1) return;
  window.turnPlanSvc = {
    v: 1,
    planSend: planSend,
    planCancel: planCancel,
    planRetry: planRetry,
    compactGateOf: compactGateOf,
  };
})();

globalThis.compactGateOf = compactGateOf;
globalThis.planSend = planSend;
globalThis.planCancel = planCancel;
globalThis.planRetry = planRetry;
})();
