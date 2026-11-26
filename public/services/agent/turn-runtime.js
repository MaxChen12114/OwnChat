(function () {
/**
 * Per-conversation turn registry and lifecycle. One turn per conversation holds its own session
 * reference, abort controller, partial text and steer queue, so switching conversations only changes
 * the view — a background turn keeps running instead of dying with the switch.
 *
 * This registry exists because of the most expensive bug this codebase has had: the old singleton
 * `session` / `isSending` / `controller` let a stale request write its reply into whichever
 * conversation the user had switched to, and clearing the old AI row looked like "every message is
 * gone". Three invariants carry that lesson; every one of them is a rule about who may write:
 *  - `turn.session` is the canonical array for that conversation. View code only reads it; wiping it
 *    in place while a background turn holds the same reference is silent amnesia.
 *  - `turn.alive` turns false only when the turn ends or is replaced. A user-initiated stop goes
 *    through `discard`/`stopped`, and the partial text already received must still be persisted —
 *    the two states must not be conflated.
 *  - Every late write-back must ask `isCurrent(turn)` first. A closure replaced by a newer send, or
 *    whose conversation was deleted, may not write again.
 *
 * What this is not: the global mirrors (isSending, steer queues, partial-stream rows, the send-button
 * shape) are DOM and UI state and stay with the host, synced through `onChange`.
 * @module services/agent-host/turn-runtime
 */

                                   
                                 
                               
                                                                
                        
                        
                                        
                     
                                                                                                
                                        
 

                       
                 
               
                                                                                 
                     
                              
              
                 
                   
                   
                   
                   
                      
                           
                        
                        
                         
                 
                                                 
                                                                                          
                    
                   
                    
                                                                                                        
                      
 

                                 
                            
                                     
                           
                                        
                                   
                               
                                     
                                   
                               
                                   
                
                 
 

function createTurnRuntime(host                              )                 {
  const h = host || {};
  const getActiveConvId = typeof h.getActiveConvId === "function" ? h.getActiveConvId : () => "";
  const getSession = typeof h.getSession === "function" ? h.getSession : () => [];
  const persistSession = typeof h.persistSession === "function" ? h.persistSession : () => {};
  const onChange = typeof h.onChange === "function" ? h.onChange : () => {};
  const afterEnd = typeof h.afterEnd === "function" ? h.afterEnd : () => {};
  const newController = typeof h.newController === "function" ? h.newController : () => new AbortController();
  const now = typeof h.now === "function" ? h.now : () => Date.now();
  const defer = typeof h.setTimeout === "function" ? h.setTimeout : (fn            ) => { setTimeout(fn, 0); };

  const turns = new Map              ();
  let seq = 0;

  function get(convId        )              {
    return turns.get(convId) || null;
  }

  function activeTurn()              {
    try {
      return get(getActiveConvId()) || null;
    } catch (e) {
      return null;
    }
  }

  function isSending(convId        )          {
    const t = turns.get(convId);
    return !!(t && t.running);
  }

  function hasAnyRunning()          {
    for (const t of turns.values()) if (t && t.running) return true;
    return false;
  }

  /**
   * Whether this turn is still the current one for its conversation — a replaced or removed turn's
   * closures may not write back. Absent from the map counts as current: that is the original
   * semantic, and it lets a historical closure put in its final write.
   */
  function isCurrent(turn             )          {
    if (!turn) return false;
    const cur = turns.get(turn.convId);
    return !cur || cur === turn;
  }

  function begin(kind        )              {
    const convId = getActiveConvId();
    if (isSending(convId)) return null;
    const turn       = {
      convId: convId,
      kind: kind,
      session: getSession(),
      controller: newController(),
      gen: ++seq,
      alive: true,
      running: true,
      discard: false,
      stopped: false,
      deleted: false,
      partialText: "",
      partialReasoning: "",
      steerQueue: [],
      imageQueue: [],
      partialStream: null,
      uiRow: null,
      uiTimer: null,
      rounds: [],
      stepsUI: null,
      startedAt: now(),
      persist: function () {
        if (turn.deleted) return;
        try {
          persistSession(turn.convId, turn.session);
        } catch (e) {}
      },
    };
    turns.set(convId, turn);
    onChange();
    return turn;
  }

  function end(turn             )       {
    if (!turn) return;
    turn.running = false;
    // `alive` deliberately stays true: the caller still reads it after its finally block to decide
    // whether to render the final text. The turn object is a one-shot closure and is garbage after.
    if (turn.uiTimer) {
      // A background conversation keeps its partial-row poller alive — it still has a row to draw
      // into when the user switches back.
      const keepTimer = !!(turn.uiRow && getActiveConvId() === turn.convId);
      if (!keepTimer) {
        try {
          clearInterval(turn.uiTimer);
        } catch (e) {}
        turn.uiTimer = null;
      }
    }
    if (turns.get(turn.convId) === turn) turns.delete(turn.convId);
    try {
      turn.persist();
    } catch (e) {}
    onChange();
    // Realtime events are held while a turn is active; applying them after it ends keeps the stream
    // from being interrupted mid-flight.
    try {
      defer(() => {
        afterEnd();
      });
    } catch (e) {}
  }

  function hasActive(convId        )          {
    const t = turns.get(convId);
    return !!(t && t.running);
  }

  function remove(convId        )       {
    turns.delete(convId);
  }

  function values()                         {
    return turns.values();
  }

  function clear()       {
    turns.clear();
  }

  function size()         {
    return turns.size;
  }

  return {
    activeTurn: activeTurn,
    isSending: isSending,
    hasAnyRunning: hasAnyRunning,
    isCurrent: isCurrent,
    begin: begin,
    end: end,
    hasActive: hasActive,
    get: get,
    remove: remove,
    values: values,
    clear: clear,
    size: size,
  };
}

// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/agent/turn-runtime.ts; this file is
// the frozen global name and nothing else.
//
// The name and the `v === 1` guard are load-bearing: app.js calls create() at the top of its file, and
// host-api.compat exposes this same name to the sandboxed kernel.
(function (global) {
  "use strict";
  if (global.turnRuntimeSvc && global.turnRuntimeSvc.v === 1) return;

  global.turnRuntimeSvc = {
    v: 1,
    create(host) {
      return createTurnRuntime(host || {});
    },
  };
})(typeof globalThis !== "undefined" ? globalThis : this);

globalThis.createTurnRuntime = createTurnRuntime;
})();
