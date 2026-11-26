(function () {
/**
 * Auto-compaction runner shared by the ordinary chat path and the agent turn.
 *
 * The trigger, thresholds and slice planner stay in `services/chat/context.ts`; this module owns
 * the one thing the old inline block could not guarantee: a cutoff that never splits a
 * `tool_calls` / `tool` pair. It also refuses to run while the session ends in a tool exchange
 * (an in-flight call or a dangling result), so a live turn is never summarized underneath itself.
 *
 * Since T3-D the flow is three steps, in this order:
 *   1. append the original message events + the `summary` event and project `messages` in one
 *      transaction (the `archive` port; absent means a legacy host and step 1 is skipped);
 *   2. append a seq anchor to the summary text — "原文 seq X-Y 在归档，可用 history_search 回捞";
 *   3. splice the hot window (remove DOM rows, `session.splice`, persist).
 * A failed archive aborts the whole compaction: splicing without a searchable copy is data loss.
 *
 * Side effects are ports: the HTTP call, the summary table, the event archive, the DOM row removal
 * and the session array all belong to the host. The service decides *whether* to compact, *where*
 * the safe boundary is, and *what* to send; the wiring/app applies it.
 *
 * Equivalence: the ordinary-chat transcript and request shape are unchanged for sessions without
 * tool rounds (`safeCutoff` is the identity when no tool result sits on the boundary).
 * @module services/chat/compact
 */

                                    
                   
                  
               
                
 

                                  
                 
                                   
 

/** One finished turn to consider; all state is supplied by the caller. */
                              
                   
                 
                       
                       
                        
                           
               
                
                       
                  
                                  
 

                                      
                 
                                                                 
                                      
                                                                                              
                  
 

/** What the archive answers: the seq range the anchor quotes, plus how many were new. */
                                       
              
                    
                   
                 
                      
                 
 

                               
                              
                            
                                                                 
                                                                
                                               
                                                                            
                                                                                             
                                                           
                                                  
                                   
                     
                                                                   
                          
                                              
     
                                                                                                 
                                                                                             
                                                                              
     
                                                                             
 

                               
                                                    
                  
 

function recOf(value         )                          {
  const out                          = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) out[k] = v;
  }
  return out;
}

/**
 * Move a raw cutoff left until the first kept message is not a `tool` result.
 *
 * A tool result is only meaningful next to its declaring assistant `tool_calls`; if the boundary
 * lands on the result, backing up to the assistant message keeps the whole exchange on one side.
 * Returns the identity when the boundary is already safe, and 0 when the only safe boundary is
 * "compress nothing".
 */
function safeCutoff(session         , cutoff         )         {
  const arr = Array.isArray(session) ? session : [];
  let c = typeof cutoff === "number" && isFinite(cutoff) ? Math.floor(cutoff) : 0;
  if (c <= 0) return 0;
  if (c >= arr.length) return arr.length;
  while (c > 0) {
    const m = recOf(arr[c]);
    if (m.role !== "tool") break;
    c--;
  }
  return c;
}

/** A session whose last message is a call or a result is mid-exchange: never compact it. */
function endsInToolExchange(session         )          {
  const arr = Array.isArray(session) ? session : [];
  if (!arr.length) return false;
  const last = recOf(arr[arr.length - 1]);
  if (last.role === "tool") return true;
  return last.role === "assistant" && Array.isArray(last.tool_calls) && last.tool_calls.length > 0;
}

/**
 * The archive anchor appended to a summary: which event seq range the original text occupies.
 * Invalid ranges return "" so a broken archive never puts a wrong pointer into the prompt.
 */
function summaryAnchor(from         , to         )         {
  const a = Math.floor(Number(from));
  const b = Math.floor(Number(to));
  if (!isFinite(a) || !isFinite(b) || a <= 0 || b < a) return "";
  return "原文 seq " + String(a) + "-" + String(b) + " 在归档，可用 history_search 回捞";
}

function createCompactor(ports              )               {
  let _busy = false;

  async function maybeCompact(call             )                   {
    if (_busy) return false;
    let cfg                   ;
    try {
      cfg = ports.config();
    } catch (e) {
      ports.warn("auto-summarize: 读取压缩配置失败", e);
      return false;
    }
    if (!cfg.enabled) return false;
    let historyOn = false;
    try {
      historyOn = !!ports.historyEnabled();
    } catch (e) {
      return false;
    }
    if (!historyOn) return false;

    const session = Array.isArray(call.session) ? call.session : [];
    if (session.length <= 4) return false;
    if (endsInToolExchange(session)) return false;
    let should = false;
    try {
      should = !!ports.shouldCompact(session.length, cfg.trigger);
    } catch (e) {
      ports.warn("auto-summarize: 水位判定失败", e);
      return false;
    }
    if (!should) return false;

    let raw                        ;
    try {
      raw = ports.plan(session, cfg.keep);
    } catch (e) {
      ports.warn("auto-summarize: 切片计划失败", e);
      return false;
    }
    if (!raw || !Array.isArray(raw.toSum)) return false;
    const cutoff = safeCutoff(session, raw.cutoff);
    if (cutoff <= 0 || cutoff >= session.length) return false;
    const toSum = raw.toSum.slice(0, cutoff);
    if (!toSum.length) return false;

    _busy = true;
    ports.busy(true);
    try {
      const body = ports.summarizeBody({
        messages: toSum,
        priorSummary: call.priorSummary,
        characterName: call.characterName,
        customProvider: call.customProvider,
        mode: call.mode,
        model: call.model,
        providerId: call.providerId,
      });
      const payload = await ports.request(body);
      const text = ports.readSummary(payload);
      if (text === null) return false;
      // Step one (T3-D): archive the originals + the summary event, projecting `messages` in the
      // same transaction. Only when that succeeded may the hot window be spliced — otherwise the
      // text would vanish from the transcript without a searchable copy. Legacy hosts (no archive
      // port) keep the old behaviour and simply get no seq anchor.
      let summaryText = text;
      const archivePort = ports.archive;
      if (typeof archivePort === "function") {
        let archived                              = null;
        try {
          archived = await archivePort({ convId: call.convId, messages: toSum, summary: text });
        } catch (e) {
          ports.warn("auto-summarize: 归档原文失败，保留原文不压缩", e);
          return false;
        }
        // `null` is the wiring's "no archive service in this build" answer: keep the legacy flow
        // (tests and old shells) but do not claim a seq anchor. `{ok:false}` is a real failure.
        if (archived) {
          if (archived.ok !== true) {
            ports.warn("auto-summarize: 归档原文失败，保留原文不压缩", archived.error || null);
            return false;
          }
          const anchor = summaryAnchor(archived.fromSeq, archived.toSeq);
          if (anchor) summaryText = text + "\n\n" + anchor;
        }
      }
      ports.saveSummary(call.convId, summaryText);
      if (call.convId === call.activeConvId) ports.applySummary(summaryText);
      call.removeRows(cutoff);
      session.splice(0, cutoff);
      call.persist();
      ports.renderChip();
      return true;
    } catch (e) {
      ports.warn("auto-summarize failed:", e);
      return false;
    } finally {
      _busy = false;
      ports.busy(false);
    }
  }

  return {
    maybeCompact,
    busy: function () { return _busy; },
  };
}

// Browser wiring for services/chat/compact.ts: the context instance, the summarize-body builder,
// the summary table, the event archive and the HTTP call are injected here; the app owns the DOM
// row removal and the turn-local persist closure through the call snapshot.
//
// The archive port is late-bound: the events service may not have answered a single call yet, but
// it is loaded before this script and resolves its DbPort on first use. When it is absent (an old
// shell build) the compactor falls back to the legacy save/splice path without a seq anchor.
(function () {
  if (window.chatCompactSvc) return;
  function defaultRequest(body) {
    return fetch("/api/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(function (r) {
      if (!r.ok) return null;
      return r.json().catch(function () { return null; });
    });
  }
  function archive(input) {
    var svc = window.sessionEventsSvc;
    if (!svc || typeof svc.archiveCompact !== "function") return Promise.resolve(null);
    return svc.archiveCompact(input.convId, input.messages, input.summary);
  }
  window.chatCompactSvc = {
    create: function (host) {
      var h = host || {};
      var ctx = h.context;
      if (!ctx) throw new Error("chat-compact: 缺少 context 实例（压缩配置/计划会静默丢失，所以必须显式给）");
      return createCompactor({
        config: function () { return ctx.compactConfig(); },
        historyEnabled: function () { return !!h.historyEnabled(); },
        shouldCompact: function (length, trigger) { return ctx.shouldCompact(length, trigger); },
        plan: function (session, keep) { return ctx.planCompact(session, keep); },
        readSummary: function (payload) { return ctx.readSummary(payload); },
        summarizeBody: function (snapshot) { return window.__request.summarizeBody(snapshot); },
        request: h.request || defaultRequest,
        saveSummary: function (convId, text) {
          if (window.convSummarySvc) window.convSummarySvc.save(convId, text);
          try { window.localStorage.removeItem("cfw_summary_chip_hidden_v1"); } catch (e) {}
        },
        applySummary: function (text) { if (h.applySummary) h.applySummary(text); },
        renderChip: function () { if (h.renderChip) h.renderChip(); },
        busy: function (on) { if (h.busy) h.busy(on); },
        warn: h.warn || function (message, error) {
          try { console.warn(message, error); } catch (e) {}
        },
        archive: archive,
      });
    },
  };
})();

globalThis.safeCutoff = safeCutoff;
globalThis.endsInToolExchange = endsInToolExchange;
globalThis.summaryAnchor = summaryAnchor;
globalThis.createCompactor = createCompactor;
})();
