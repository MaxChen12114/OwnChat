(function () {
/**
 * Kernel events into the process panel and the console. Two jobs, deliberately separated:
 *
 *  - `note` records the tool events into the turn regardless of which conversation is on screen.
 *    Skipping it is what once made a background run come back as a bare "generating" — the events
 *    were dropped while the user was elsewhere. That invariant lives here and only here; nothing
 *    else may decide whether a conversation is "current" before recording.
 *  - `dispatch` draws only for the current conversation of the current turn, so a background run's
 *    tool calls never appear in someone else's panel.
 *
 * The event-to-panel mapping mirrors the panel's own handler one-for-one. Meeting and peer events
 * share that panel on purpose: a council session and a tool call read as one timeline.
 *
 * No environment: all nine capabilities come in through `create(host)`, which is what makes a fake
 * handle enough to test the whole module.
 * @module services/agent/events
 */

                             
                
                
                 
               
              
                    
                    
                  
                         
 

                               
               
                 
               
              
                    
                  
                   
 

                              
                
                        
                        
 

                             
                  
                         
 

                              
                     
                                              
                                                                                       
                                                                        
                                                 
                                      
                                        
                                    
 

                                  
                                
                             
                                        
                                  
                                   
                        
                           
                          
 

                                 
                             
                                 
 

                                     
       
                                                 
 

const MEETING                         = { meeting_start: 1, meeting_speaker: 1, peer_invite: 1 };

function createAgentEvents()                     {
  function create(host                  )                 {
    const h = host || {};
    const getTurn = typeof h.getTurn === "function" ? h.getTurn : function () { return null; };
    const getActiveConvId = typeof h.getActiveConvId === "function" ? h.getActiveConvId : function () { return ""; };
    const isCurrent = typeof h.isCurrent === "function" ? h.isCurrent : function () { return true; };
    const getSteps = typeof h.getSteps === "function" ? h.getSteps : function () { return null; };
    const onConsole = typeof h.onConsole === "function" ? h.onConsole : function () {};
    const onRoundStart = typeof h.onRoundStart === "function" ? h.onRoundStart : function () {};
    const isNearBottom = typeof h.isNearBottom === "function" ? h.isNearBottom : function () { return false; };
    const scrollToBottom = typeof h.scrollToBottom === "function" ? h.scrollToBottom : function () {};

    // Concurrent tools can share a name, so the card to finish is the most recent one still open.
    function lastOpenCall(round             , name        )                      {
      for (let i = round.calls.length - 1; i >= 0; i--) {
        const c = round.calls[i];
        if (c.name === name && c.ok === undefined && !c.denied) return c;
      }
      return null;
    }

    // Record only: no conversation check, no DOM. Switching back replays from this record.
    function note(ev            )       {
      try {
        const turn = getTurn();
        const type = ev && ev.type;
        const rounds = turn && turn.rounds;
        if (!type || !Array.isArray(rounds)) return;
        if (type === "model_call") { rounds.push({ round: rounds.length + 1, calls: [] }); return; }
        let r = rounds[rounds.length - 1];
        if (!r) { r = { round: 1, calls: [] }; rounds.push(r); }
        if (type === "tool_run" && ev.name) {
          r.calls.push({ name: ev.name, args: ev.args || {} });
        } else if (type === "tool_done" && ev.name) {
          const c1 = lastOpenCall(r, ev.name);
          if (c1) { c1.ok = ev.ok !== false; c1.ms = ev.ms; c1.summary = ev.summary; }
        } else if (type === "tool_error" && ev.name) {
          const c2 = lastOpenCall(r, ev.name);
          if (c2) { c2.ok = false; c2.ms = ev.ms; c2.error = ev.message || ev.error || "调用失败"; }
        } else if (type === "tool_denied" && ev.name) {
          const c3 = lastOpenCall(r, ev.name);
          if (c3) { c3.denied = true; c3.ok = false; }
        } else if (MEETING[type]) {
          (r.events || (r.events = [])).push(ev);
        }
      } catch (_) {}
    }

    // Note first — a background run still needs its trace — then decide whether to draw.
    function dispatch(ev            )       {
      note(ev);
      const turn = getTurn();
      // A background conversation's events stay out of the current console and step block.
      if (!turn || getActiveConvId() !== turn.convId || !isCurrent(turn)) return;
      try { onConsole(ev); } catch (e) {}
      try {
        const S = getSteps();
        if (!S) return;
        if (ev.type === "model_call") { onRoundStart(); S.model_call(); }
        else if (ev.type === "tool_run" && ev.name) S.tool_run(ev.name, ev.args || {});
        else if (ev.type === "tool_done" && ev.name) S.tool_done(ev.name, { ok: ev.ok !== false, ms: ev.ms, summary: ev.summary });
        else if (ev.type === "tool_error" && ev.name) S.tool_error(ev.name, { error: ev.message || ev.error || "调用失败", ms: ev.ms });
        else if (ev.type === "tool_denied" && ev.name) S.tool_denied(ev.name, ev.args || {});
        else if (ev.type === "meeting_start") S.meeting_start(ev);
        else if (ev.type === "meeting_speaker") S.meeting_speaker(ev);
        else if (ev.type === "peer_invite") S.peer_invite(ev);
        if (isNearBottom()) scrollToBottom();
      } catch (_) {}
    }

    return { note: note, dispatch: dispatch };
  }

  return { v: 1, create: create };
}

// ── Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name ──
// The implementation moved to services/agent/events.ts. That module has no environment of its own (all
// nine capabilities come in through create(host)), so here we only bind the frozen name and guard
// against a double install — no ports to inject.
(function () {
  if (window.__agentEvents && window.__agentEvents.v === 1) return;
  window.__agentEvents = createAgentEvents();
})();

globalThis.createAgentEvents = createAgentEvents;
})();
