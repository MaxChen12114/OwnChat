(function () {
/**
 * Conversation lifecycle: switch / create / rename / delete / remote apply, plus the runtime
 * memory-slot cache and the "message array into the chat UI" hand-off shared by every restore
 * path. Extracted from engine/app.js; the engine keeps ownership of the canonical `session`
 * array (read and replaced through two ports) and of the UI mirror of the active turn
 * (syncActiveTurnGlobals) — this file must never mirror those.
 *
 * The load-bearing invariants, preserved verbatim from the host:
 *  - Switching conversations never interrupts a background turn; loadConvIntoUI re-attaches the
 *    partial row (attachTurnUI) when the target conversation is still running.
 *  - memSlots is the page-lifetime cache that decouples "switch role / switch conversation" from
 *    the persistence toggle; the host receives it by reference (session-store and conv-store read
 *    the same object), so deletion here is visible everywhere.
 *  - Deleting a running conversation must discard the turn BEFORE touching storage, otherwise a
 *    late persist from that turn revives the conversation (the discard port does the abort and
 *    marks the turn dead).
 *  - restoreSessionIfEnabled renders the stored array (not the id-bearing copy): the copies go
 *    into memSlots only, so realtime diffs keep comparing against the raw storage shape.
 *
 * The conversation list itself (three-source merge, previews, sorting) stays in conv/store;
 * listConversations here only assembles its input from host state.
 * @module services/conv/lifecycle
 */

/** Message shape is left open: this file only passes through, shallow-copies and keys on ids. */
                                          

/** One row handle as produced by the host's makeRow; only the fields this file touches. */
                        
                             
                              
                                        
 

/** The subset of a background turn this file needs. The host owns the real turn object. */
                             
                   
                    
                    
                       
                          
                        
                             
                     
                    
 

/** Input assembled for conv/store.buildConversationList. */
                                
               
                
              
                   
                                  
                 
                                     
 

                                 
                                                                     
                        
                                  
                            
                     
                                                
                         
                                    
                                
                      
                              
                              
                           
                                                                  
                          
                                          
                                                    
                                             
                                       
                            
                                            
                                      
                                                       
                                                                
                                                                 
                                                          
                          
                                             
                                                                                               
                                               
                                             
                                    
                                         
                                         
                                
                               
                                              
                                    
                      
                                  
                           
                                      
                                         
                                                                                         
                                       
                                                                                                    
                                      
                                                                                         
                                           
                            
                       
                         
                       
                                      
                                                                      
                                 
                                                    
                                                            
                                        
                            
                                               
                               
 

                                        
                                                                          
                                           
                                           
                                                   
                                   
                                       
                                          
                                  
                                 
                                       
                             
                                 
                                           
                                           
                                                         
                                              
 

function createLifecycle(ports                )                        {
  const p = ports;
  const memSlots                        = {};

  // Helpers live INSIDE the factory on purpose: emitted services are classic top-level scripts, so
  // a module-level `function arrOf` here would land on window and get overwritten by later-loaded
  // services that define their own same-named helper (image/embed.js ships a string-filtering
  // arrOf — with it, every list built here came out empty in the real boot). Closure scope is the
  // only scope the classic channel cannot clobber.

  function recOf(value         )      {
    const out      = {};
    if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
    const entries = Object.entries(value);
    for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
    return out;
  }

  function arrOf(value         )            {
    if (!Array.isArray(value)) return [];
    const out            = [];
    for (let i = 0; i < value.length; i++) out.push(value[i]);
    return out;
  }

  /** Shallow copy of one message — the same spread the host used, expressed without `as`. */
  function copyMsg(m         )      {
    return recOf(m);
  }

  function msgArrCopy(value         )        {
    const src = arrOf(value);
    const out        = [];
    for (let i = 0; i < src.length; i++) out.push(copyMsg(src[i]));
    return out;
  }

  function entryConvId(entry         )         {
    const id = recOf(entry)["convId"];
    if (typeof id === "string") return id;
    return id == null ? "" : String(id);
  }

  // Project a message array through the context whitelist, then hand it to the list renderer.
  // Replacing the host's `session` variable is part of the contract: a background turn holds this
  // same array and keeps pushing into it after the switch.
  function renderSessionIntoUI(arr         )       {
    const next = p.toRenderableMessages(arr);
    p.setSession(next);
    p.renderSession(next);
  }

  // Realtime module calls this after applying a remote event: only repaint when the event belongs
  // to the conversation on screen and no turn is streaming into it.
  function applyRemoteChat(convId        )          {
    if (!convId || convId !== p.activeConvId()) return false;
    if (p.hasActiveTurn(convId)) return false;
    try {
      const all = p.loadAllSessions();
      const arr = all[convId];
      if (!Array.isArray(arr)) return false;
      memSlots[convId] = msgArrCopy(arr);
      renderSessionIntoUI(arr);
      return true;
    } catch (e) {
      return false;
    }
  }

  // Another device deleted the conversation on screen: fall to the first remaining one.
  function handleRemoteConvDeleted(convId        )          {
    if (!convId || convId !== p.activeConvId()) return false;
    const rest = listConversations();
    loadConvIntoUI(rest.length ? entryConvId(rest[0]) : p.ensureDefaultConv());
    return true;
  }

  // Everything that must happen after the active conversation id changed: clear the UI, follow the
  // conversation's character and work mode, then restore history from the live turn, the memory
  // slot or storage — in that order of preference. Shared by switch and create.
  function loadConvIntoUI(id        )       {
    const live = p.getTurn(id);
    p.syncActiveTurnGlobals();
    p.clearUIRows();
    p.clearPendingAttachments();
    p.clearChoiceChips();
    p.applyConvChar(id);
    try {
      p.appModeApplyConv(id);
    } catch (e) {}
    if (live && live.running) {
      // Switching back to a conversation that runs in the background: paint what is already
      // persisted, then hang the partial row (attachTurnUI polls it).
      renderSessionIntoUI(live.session);
      p.setSession(live.session); // keep the canonical array reference so background pushes continue
      attachTurnUI(live);
    } else {
      p.setSession([]);
      if (!memRestoreSlot(id) && p.historyEnabled()) restoreSessionIfEnabled();
    }
    p.restoreSummary(id);
    p.renderSummaryChip();
    p.updateSpacer();
    p.scrollToBottom();
    p.navHideReset();
  }

  // Re-attach a background turn's partial AI row after switching back to its conversation. The row
  // was cleared on switch-away, so the agent step panel is replayed from turn.rounds; the poll
  // timer repaints partial text and reasoning until the turn ends, then repaints from the canonical
  // session. DOM writes only happen while this conversation is the active one.
  function attachTurnUI(turn            )       {
    if (!turn || !turn.running) return;
    if (!turn.uiRow || !turn.uiRow.rowEl || !turn.uiRow.rowEl.isConnected) {
      try {
        const r = p.makeRow("assistant");
        turn.uiRow = r;
        if (r && r.rowEl) p.setStreamingUI(r.rowEl, true);
      } catch (e) {
        turn.uiRow = null;
      }
    }
    try {
      if (turn.rounds && turn.rounds.length && p.agentStepsAvailable() && turn.uiRow && turn.uiRow.bubble) {
        turn.stepsUI = p.agentStepsMountLive(turn.uiRow.bubble);
        p.agentStepsReplay(turn.stepsUI, turn.rounds);
        if (turn.uiRow.rowEl) turn.uiRow.rowEl.dataset["agentProcess"] = "1";
      }
    } catch (_sr) {}
    const paint = () => {
      try {
        if (!turn.uiRow || !turn.uiRow.bubble) return;
        const txt = String(turn.partialText || "").trim();
        turn.uiRow.bubble.textContent = txt ? p.cleanPartialText(txt) : "生成中…";
        // Reasoning accumulates in turn.partialReasoning the whole time; without this repaint the
        // user only sees "generating" when they switch back.
        if (turn.partialReasoning && turn.uiRow.reasoning) {
          const rt = turn.uiRow.reasoning.querySelector(".reasoning-text");
          const rtxt = String(turn.partialReasoning);
          if (rt && rt.textContent !== rtxt) rt.textContent = rtxt;
          // Same display policy as during streaming: "hide" never shows it, otherwise keep it open.
          if (p.getThinkDisplay() === "hide") turn.uiRow.reasoning.style.display = "none";
          else {
            turn.uiRow.reasoning.style.display = "";
            turn.uiRow.reasoning.open = true;
          }
        }
      } catch (e) {}
    };
    paint();
    if (turn.uiTimer) {
      try {
        p.clearTimer(turn.uiTimer);
      } catch (e) {}
      turn.uiTimer = null;
    }
    turn.uiTimer = p.setTimer(() => {
      if (p.activeConvId() !== turn.convId) {
        // User switched away; stop polling and drop the row handle.
        try {
          p.clearTimer(turn.uiTimer);
        } catch (e) {}
        turn.uiTimer = null;
        turn.uiRow = null;
        return;
      }
      if (!turn.running) {
        try {
          p.clearTimer(turn.uiTimer);
        } catch (e) {}
        turn.uiTimer = null;
        try {
          p.setSession(turn.session);
          renderSessionIntoUI(turn.session);
          p.setSession(turn.session); // back to the raw canonical array, like the host did
          p.updateSpacer();
          p.scrollToBottom();
        } catch (e) {}
        turn.uiRow = null;
        return;
      }
      paint();
    }, 350);
  }

  function restoreSessionIfEnabled()       {
    if (!p.historyEnabled()) return;
    const all = p.loadAllSessions();
    const key = p.currentSlotKey();
    const arr = all[key];
    if (!Array.isArray(arr)) return;
    // Establish the memSlots baseline (with message ids) so realtime diffs treat only new messages
    // as appends.
    let full          = arr;
    try {
      full = p.ensureMessageIds(arr, key);
    } catch (e) {}
    try {
      memSlots[key] = msgArrCopy(full);
    } catch (e) {}
    try {
      renderSessionIntoUI(arr);
    } catch (e) {}
  }

  // Page-lifetime memory-slot cache, fully decoupled from the persistence toggle: only effective
  // while the page lives. Fixes "switching role / conversation wipes the chat" — the old version
  // only saved when history was enabled, and with it off the wipe was unrecoverable.
  function memSaveSlot(key        )       {
    if (!key) return;
    try {
      const full = p.ensureMessageIds(p.getSession(), key);
      memSlots[key] = msgArrCopy(full);
    } catch (e) {}
  }

  function memRestoreSlot(key        )          {
    const arr = memSlots[key];
    if (!Array.isArray(arr)) return false;
    try {
      renderSessionIntoUI(arr);
      return true;
    } catch (e) {
      return false;
    }
  }

  function saveCurrentSlotNow()       {
    if (!p.historyEnabled()) return;
    try {
      const all = p.loadAllSessions();
      const key = p.currentSlotKey();
      all[key] = msgArrCopy(p.getSession());
      p.writeSessionBlob(JSON.stringify(all));
      p.bumpSlotMeta(key);
      p.touchConv(key, {}); // refresh last-activity so the list sorts by time
    } catch (e) {}
  }

  // List every conversation (role-independent) with participant info for the sidebar. The
  // three-source merge itself lives in conv/store; this only gathers its input from host state.
  function listConversations()            {
    let cards          = [];
    try {
      cards = p.listAllCards();
    } catch (e) {}
    return arrOf(
      p.buildConversationList({
        all: p.loadAllSessions(),
        meta: p.loadConvMeta(),
        cur: p.activeConvId(),
        session: p.getSession(),
        memSlots: memSlots,
        cards: cards,
        isRunning: (id) => p.isConvSending(id),
      }),
    );
  }

  function switchConversation(convId        )       {
    const id = p.isConvId(convId) ? convId : p.ensureDefaultConv();
    if (id === p.activeConvId()) return; // already active; skip the repaint
    memSaveSlot(p.currentSlotKey()); // save the current conversation into the memory slot first
    saveCurrentSlotNow();
    p.setActiveConvId(id);
    loadConvIntoUI(id);
  }

  // "New conversation" really creates a fresh empty conversation and records the current character.
  function createConversation(name        )         {
    memSaveSlot(p.currentSlotKey());
    saveCurrentSlotNow();
    const id = p.newConvId();
    const trimmed = (name || "").trim() || "新对话";
    p.touchConv(id, { name: trimmed, charId: p.activeCardId() });
    try {
      p.recordConv(id, p.loadConvMeta()[id] || { name: trimmed, createdAt: Date.now() }, "create");
    } catch (e) {}
    p.setActiveConvId(id);
    loadConvIntoUI(id);
    return id;
  }

  function renameConversation(convId        , name        )       {
    if (!p.isConvId(convId)) return;
    const trimmed = (name || "").trim() || "新对话";
    p.touchConv(convId, { name: trimmed });
    p.recordConv(convId, { name: trimmed }, "meta");
  }

  function deleteConversation(convId        )          {
    if (!p.isConvId(convId)) return false;
    // Deleting a conversation that runs in the background: discard its turn first, otherwise the
    // late persist revives it.
    p.discardTurn(convId);
    try {
      const all = p.loadAllSessions();
      delete all[convId];
      if (Object.keys(all).length === 0) p.removeSessionBlob();
      else p.writeSessionBlob(JSON.stringify(all));
    } catch (e) {}
    p.writeChatTombstone(convId); // cross-device: without it the other device pulls it back
    p.recordConv(convId, null, "delete");
    p.removeSummary(convId); // the compressed history of a deleted conversation must not linger
    // Cold truth cascade (T3-D): events + messages + the summaries row. Best effort — a data
    // plane that is offline must not block the local delete.
    try { if (p.removeColdSession) p.removeColdSession(convId); } catch (e) {}
    // Also drop the conversation's agent workspace files, or they become unreadable orphans.
    p.agentWorkspaceRemove(convId);
    const meta = p.loadConvMeta();
    if (meta[convId]) {
      delete meta[convId];
      p.saveConvMeta(meta);
    }
    delete memSlots[convId];
    if (p.loadActiveConvRaw() === convId) {
      p.setActiveConvId("");
      const rest = listConversations();
      loadConvIntoUI(rest.length ? entryConvId(rest[0]) : p.ensureDefaultConv()); // last one gone: open a fresh conversation
    }
    return true;
  }

  return {
    memSlots,
    applyRemoteChat,
    handleRemoteConvDeleted,
    loadConvIntoUI,
    attachTurnUI,
    renderSessionIntoUI,
    restoreSessionIfEnabled,
    memSaveSlot,
    memRestoreSlot,
    saveCurrentSlotNow,
    listConversations,
    switchConversation,
    createConversation,
    renameConversation,
    deleteConversation,
  };
}

// Browser wiring (injected by l0/emit.mjs): binds the conversation lifecycle engine to its frozen
// global name. Feature checks for cross-module calls (chat realtime, chat events, character cards,
// agent workspace, agent steps) live here; conversation semantics live in the engine.
(function () {
  if (window.__convLifecycle) return;
  window.__convLifecycle = {
    create: function (ports) { return createLifecycle(ports || {}); },
  };
})();

globalThis.createLifecycle = createLifecycle;
})();
